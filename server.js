// ============================================================
// Smart Tutor Finder — API server
// ============================================================
// All routes are in this one file, grouped by who uses them:
//
//   AUTH      register, login, who am I
//   SUBJECTS  the subject list
//   TUTOR     a tutor's own profile and notifications
//   SEARCH    students find tutors BY SUBJECT
//   ADMIN     approvals, tutors, students, accounts, subjects
//
// Plain functions throughout — there are no classes anywhere.
// Every SQL value is passed as $1, $2 and so on, never glued
// into the query string.
// ============================================================

import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

import { corsOrigin, ENFORCE_HTTPS } from './lib/env.js';
import { cleanField, cleanFieldList, hasFields } from './lib/fields.js';
import { mountRoutes } from './routes/index.js';
import { startJobs } from './jobs/cron.js';
import { initWhatsApp, stopWhatsApp } from './lib/whatsapp.js';
import { query, one } from './db.js';
import {
  makeToken, requireLogin, requireRole, handle, notify, logActivity,
} from './helpers.js';
import {
  upload, uploadLimit, safeDocPath,
  uploadAvatar, avatarLimit, safeAvatarPath,
} from './uploads.js';
import {
  checkEmail, tidyEmail, checkPhone, tidyPhone, checkExperience,
  checkFee, checkClassRange, checkPassword, checkName, firstProblem,
} from './validate.js';
import { subscriptionState, nextPaidUntil, endOfMonth, todayPK } from './subscription.js';
import { setupSockets, emitMessage, emitToUser, markRead, closeSockets } from './socket.js';
import {
  cloudinaryConfig, signUpload, deleteFromCloudinary, thumbnailFor,
} from './cloudinary.js';

const app = express();

// Behind Render / Railway the TLS is terminated by their proxy, so
// the app sees plain http. Trusting ONE proxy hop makes req.ip and
// req.protocol reflect the real client and the real scheme.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Helmet's secure defaults. One override: profile pictures and chat
// images are loaded by the app from a different origin, and helmet's
// default Cross-Origin-Resource-Policy would block exactly that.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// Plain http is refused in production (health check excepted, so
// the host's own probe still works).
app.use((req, res, next) => {
  if (ENFORCE_HTTPS && req.path !== '/api/health' && req.protocol !== 'https') {
    return res.status(426).json({ error: 'Use https.' });
  }
  next();
});

// Only the app's own origins may call the API from a browser.
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

// ============================================================
// Shared readers
// ============================================================
// Used by several routes, so they live here rather than being
// copied about.
// ============================================================

// Everything about one tutor: their profile, their login details,
// their subjects and their days.
//
// `viewer` decides whether the phone number comes back. A student
// only gets it once the tutor has ACCEPTED their enrollment — that
// is the whole point of asking. Admins always see it, because
// checking identity is their job.
async function readTutor(tutorId, viewer = null) {
  const tutor = await one(
    `SELECT t.*, u.full_name, u.email, u.phone, u.avatar,
            u.account_status, u.created_at AS joined_at
       FROM tutors t
       JOIN users u ON u.id = t.user_id
      WHERE t.id = $1`,
    [tutorId]
  );
  if (!tutor) return null;

  tutor.subjects = await query(
    `SELECT ts.id, ts.subject_id, s.subject_name, ts.class_from, ts.class_to, ts.monthly_fee, ts.fields
       FROM tutor_subjects ts
       JOIN subjects s ON s.id = ts.subject_id
      WHERE ts.tutor_id = $1
      ORDER BY s.subject_name`,
    [tutorId]
  );

  tutor.availability = await query(
    `SELECT day_of_week,
            to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time,   'HH24:MI') AS end_time
       FROM tutor_availability
      WHERE tutor_id = $1
      ORDER BY day_of_week`,
    [tutorId]
  );

  tutor.reviews = await query(
    `SELECT r.id, r.rating, r.comment, r.created_at,
            u.full_name AS student_name, u.avatar AS student_avatar
       FROM reviews r
       JOIN users u ON u.id = r.student_id
      WHERE r.tutor_id = $1
      ORDER BY r.created_at DESC
      LIMIT 50`,
    [tutorId]
  );

  const summary = await one(
    `SELECT COUNT(*)::int AS count, ROUND(AVG(rating)::numeric, 1) AS average
       FROM reviews WHERE tutor_id = $1`,
    [tutorId]
  );
  tutor.review_count = summary.count;
  tutor.average_rating = summary.average ? Number(summary.average) : null;

  // The badge. Earned by uploading a degree AND having an admin
  // approve it — uploading alone is not enough, or it would mean
  // nothing.
  tutor.qualification_badge = Boolean(
    tutor.qualification_doc && tutor.qualification_verified
  );

  // Whether the video section applies to them at all. The app uses
  // this to decide whether to show the tab, rather than showing it
  // and then explaining that it does nothing.
  tutor.teaches_online = (tutor.teaching_modes || []).includes('online');

  // A payment sitting with the administrator changes the answer,
  // so it has to be looked up rather than assumed.
  const claim = await one(
    `SELECT id FROM payments WHERE tutor_id = $1 AND status = 'pending' LIMIT 1`,
    [tutorId]
  );

  tutor.subscription = subscriptionState(tutor, Boolean(claim));

  // ---- who may see the phone number ----
  if (viewer && viewer.role === 'student') {
    const accepted = await one(
      `SELECT id FROM enrollments
        WHERE student_id = $1 AND tutor_id = $2 AND status = 'accepted'
        LIMIT 1`,
      [viewer.id, tutorId]
    );

    tutor.contact_unlocked = Boolean(accepted);

    // Any live request, so the profile can say "already asked"
    // instead of offering the button again.
    tutor.my_enrollment = await one(
      `SELECT e.id, e.status, e.tutor_note, e.created_at,
              (SELECT string_agg(s.subject_name, ', ' ORDER BY s.subject_name)
                 FROM enrollment_subjects es
                 JOIN subjects s ON s.id = es.subject_id
                WHERE es.enrollment_id = e.id) AS subject_names
         FROM enrollments e
        WHERE e.student_id = $1 AND e.tutor_id = $2
        ORDER BY e.created_at DESC
        LIMIT 1`,
      [viewer.id, tutorId]
    );

    if (!tutor.contact_unlocked) {
      delete tutor.phone;

      // Before enrolling, a student sees roughly WHERE a tutor is
      // but not exactly. The map shows a circle rather than a pin,
      // and the address is cut back to the area.
      //
      // Enough to judge "is this near me?", not enough to turn up
      // at somebody's door uninvited.
      tutor.exact_location = false;

      // Two decimal places is about a kilometre — the street is
      // gone, the neighbourhood is not.
      if (tutor.latitude != null) {
        tutor.latitude = Math.round(Number(tutor.latitude) * 100) / 100;
        tutor.longitude = Math.round(Number(tutor.longitude) * 100) / 100;
      }

      // "Alamdar Chowk, Skardu" survives; a house number does not.
      if (tutor.address) {
        const parts = tutor.address.split(',').map((part) => part.trim());
        tutor.address = parts.slice(-2).join(', ');
      }
    } else {
      tutor.exact_location = true;
    }
  } else {
    // Tutors viewing themselves, and admins, see everything.
    tutor.contact_unlocked = true;
    tutor.exact_location = true;
  }

  return tutor;
}

// The same, but looked up by the login rather than the profile id.
async function readTutorByUser(userId) {
  const row = await one('SELECT id FROM tutors WHERE user_id = $1', [userId]);
  return row ? readTutor(row.id) : null;
}

// The ways a student is willing to be taught. Kept to the known
// set, so a stray value cannot quietly exclude somebody from every
// filter that checks it.
// The same three for both sides: a student says how they are
// willing to learn, a tutor how they are willing to teach, and a
// search matches one against the other.
const MODES = ['centre', 'student_home', 'online'];

function cleanModes(modes) {
  if (!Array.isArray(modes)) return [];
  return [...new Set(modes.filter((m) => MODES.includes(m)))];
}

// ============================================================
// AUTH
// ============================================================

// Slows down anyone trying passwords in bulk.
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

// A student needs only an account.
//
// A tutor sends their whole profile at once — details, subjects
// with a fee each, days, and their map pin. It arrives as one
// request, so a tutor either exists completely or not at all.
//
// New tutors start as 'pending'. They cannot be found by students
// until an admin approves them.
app.post('/api/auth/register', handle(async (req, res) => {
  const {
    role, full_name, email, phone, password, class_level, academic_field,
    centre_name, qualification, experience_years,
    gender, bio, teaching_modes = [], address, latitude, longitude,
    cnic_front, cnic_back, qualification_doc, accepted_terms,
    learning_modes = [],
    subjects = [], availability = [],
  } = req.body;

  // ---- check what arrived ----
  if (!['student', 'tutor'].includes(role)) {
    return res.status(400).json({ error: 'Choose whether you are a student or a tutor.' });
  }

  // One message at a time, so the person fixes one thing and tries
  // again rather than facing a wall of complaints.
  const problem = firstProblem(
    checkName(full_name),
    checkEmail(email),
    checkPhone(phone),
    checkPassword(password),
    role === 'tutor' ? checkExperience(experience_years) : null
  );

  if (problem) return res.status(400).json({ error: problem });
  // Everybody accepts terms, students included. Checked on the
  // server as well as in the form, so it cannot be skipped by
  // calling the API directly.
  if (!accepted_terms) {
    return res.status(400).json({ error: 'You must accept the terms to register.' });
  }
  if (role === 'tutor') {
    if (!qualification) {
      return res.status(400).json({ error: 'Enter your qualification.' });
    }
    if (subjects.length === 0) {
      return res.status(400).json({ error: 'Add at least one subject you teach.' });
    }
    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: 'Pin where you teach on the map before finishing.' });
    }
    // CNIC is required; the degree is not. A tutor with no
    // paperwork to hand can still register — they simply do not
    // get the badge.
    if (!cnic_front || !cnic_back) {
      return res.status(400).json({ error: 'Upload both sides of your CNIC.' });
    }
  }

  // Stored in one shape, so +92 300..., 0300 123 4567 and
  // 03001234567 all end up identical and the UNIQUE rule on the
  // column actually catches duplicates.
  const cleanEmail = tidyEmail(email);
  const cleanPhone = tidyPhone(phone);

  const taken = await one(
    'SELECT id FROM users WHERE email = $1 OR phone = $2',
    [cleanEmail, cleanPhone]
  );
  if (taken) {
    return res.status(409).json({ error: 'That email or phone number is already registered.' });
  }

  // Field (Engineering / Medical / Computer Science) — students in
  // Class 9 to 12 only; for anybody else it is quietly empty.
  const fieldCheck = role === 'student' ? cleanField(academic_field, class_level) : { value: null };
  if (fieldCheck.error) return res.status(400).json({ error: fieldCheck.error });

  // The password is hashed before storing, so even somebody with
  // the database cannot read it back.
  const user = await one(
    `INSERT INTO users (role, full_name, email, phone, password, class_level,
                        terms_accepted_at, learning_modes, academic_field)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8)
     RETURNING id, role, full_name, email, phone, class_level, academic_field,
               learning_modes, account_status`,
    [
      role,
      full_name.trim(),
      cleanEmail,
      cleanPhone,
      await bcrypt.hash(password, 10),
      role === 'student' && class_level ? Number(class_level) : null,
      // Only students have these. A tutor sets how they teach on
      // their own profile instead.
      role === 'student' ? cleanModes(learning_modes) : [],
      fieldCheck.value,
    ]
  );

  let tutor = null;

  if (role === 'tutor') {
    const created = await one(
      `INSERT INTO tutors
         (user_id, centre_name, qualification, experience_years, gender, bio,
          teaching_modes, address, latitude, longitude,
          cnic_front, cnic_back, qualification_doc,
          terms_accepted_at, verification_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), 'pending')
       RETURNING id`,
      [
        user.id,
        centre_name?.trim() || null,
        qualification.trim(),
        Number(experience_years) || 0,
        gender || null,
        bio || null,
        // At least one, or they could never be matched to anybody.
        cleanModes(teaching_modes).length ? cleanModes(teaching_modes) : ['centre'],
        address || null,
        Number(latitude),
        Number(longitude),
        cnic_front,
        cnic_back,
        qualification_doc || null,
      ]
    );

    // ---- subjects ----
    // A tutor either picks from the list or types something we do
    // not have. Anything typed is added to the subjects table, so
    // the next tutor finds it already there and the list grows on
    // its own instead of needing an admin to maintain it.
    for (const item of subjects) {
      let subjectId = item.subject_id;

      if (!subjectId && item.subject_name) {
        const name = item.subject_name.trim();
        if (!name) continue;

        // ON CONFLICT keeps this safe if two tutors add the same
        // new subject at the same moment.
        const subject = await one(
          `INSERT INTO subjects (subject_name) VALUES ($1)
           ON CONFLICT (subject_name) DO UPDATE SET subject_name = EXCLUDED.subject_name
           RETURNING id`,
          [name]
        );
        subjectId = subject.id;
      }

      if (!subjectId) continue;

      const subjectProblem = firstProblem(
        checkClassRange(item.class_from, item.class_to, item.subject_name || 'a subject'),
        checkFee(item.monthly_fee, item.subject_name || 'a subject')
      );

      if (subjectProblem) {
        return res.status(400).json({ error: subjectProblem });
      }

      const fl = cleanFieldList(item.fields, item.class_from, item.class_to);
      if (fl.error) return res.status(400).json({ error: fl.error });

      await query(
        `INSERT INTO tutor_subjects (tutor_id, subject_id, class_from, class_to, monthly_fee, fields)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tutor_id, subject_id) DO NOTHING`,
        [
          created.id,
          subjectId,
          Number(item.class_from) || 1,
          Number(item.class_to) || 12,
          Number(item.monthly_fee) || 0,
          fl.value,
        ]
      );
    }

    // ---- days ----
    for (const slot of availability) {
      if (!(slot.start_time < slot.end_time)) continue;
      await query(
        `INSERT INTO tutor_availability (tutor_id, day_of_week, start_time, end_time)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tutor_id, day_of_week) DO NOTHING`,
        [created.id, Number(slot.day_of_week), slot.start_time, slot.end_time]
      );
    }

    tutor = await readTutor(created.id);

    // Tell them what happens next, so the waiting is not a mystery.
    await notify(
      user.id,
      'registered',
      'Your profile is being reviewed',
      'An admin is checking your details. You will get a message here as soon as it is approved, and only then will students be able to find you.'
    );
  }

  await logActivity(
    user,
    'register',
    role === 'tutor'
      ? `Registered as a tutor with ${subjects.length} subject${subjects.length === 1 ? '' : 's'}, awaiting approval`
      : 'Registered as a student'
  );

  res.status(201).json({
    token: makeToken(user),
    user: { ...user, tutor },
  });
}));

app.post('/api/auth/login', loginLimit, handle(async (req, res) => {
  const email = tidyEmail(req.body.email);
  const password = req.body.password || '';

  const user = await one('SELECT * FROM users WHERE email = $1', [email]);

  // The same message whether the email is unknown or the password
  // is wrong. Two different messages would let somebody work out
  // which email addresses are registered.
  const correct = user && await bcrypt.compare(password, user.password);
  if (!correct) {
    // Recorded for the admin's audit trail. Only the email that was
    // tried goes in — never the password.
    await logActivity(user || null, 'login_failed', `Failed sign-in for ${email || 'an empty email'}`, req.ip);
    return res.status(401).json({ error: 'That email and password do not match.' });
  }
  if (user.account_status === 'suspended') {
    await logActivity(user, 'login_blocked', 'Sign-in refused: account suspended', req.ip);
    return res.status(403).json({ error: 'This account has been suspended.' });
  }

  delete user.password;

  // So an admin can see who has been active and who has gone quiet.
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await logActivity(user, 'login', 'Signed in', req.ip);

  const tutor = user.role === 'tutor' ? await readTutorByUser(user.id) : null;

  res.json({ token: makeToken(user), user: { ...user, tutor } });
}));

// Called when the app opens, to check the saved token still works
// and to find out which dashboard to show.
app.get('/api/auth/me', requireLogin, handle(async (req, res) => {
  const tutor = req.user.role === 'tutor' ? await readTutorByUser(req.user.id) : null;

  // How many unread messages, for the dot on the tab bar.
  const unread = await one(
    'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND is_read = false',
    [req.user.id]
  );

  // Suspension for non-payment is done by the scheduler on the due
  // day (jobs/cron.js), not here.

  // How many enrollment requests are waiting on this tutor, for the
  // count on their Requests tab.
  let pendingEnrollments = 0;

  if (req.user.role === 'tutor' && tutor) {
    const waiting = await one(
      `SELECT COUNT(*)::int AS count FROM enrollments
        WHERE tutor_id = $1 AND status = 'pending'`,
      [tutor.id]
    );
    pendingEnrollments = waiting.count;
  }

  // Unread chat, counted for whichever side is asking.
  let unreadMessages = 0;

  if (req.user.role === 'student') {
    const row = await one(
      `SELECT COUNT(*)::int AS count FROM messages
        WHERE student_id = $1 AND sender = 'tutor' AND read_at IS NULL`,
      [req.user.id]
    );
    unreadMessages = row.count;
  } else if (req.user.role === 'tutor' && tutor) {
    const row = await one(
      `SELECT COUNT(*)::int AS count FROM messages
        WHERE tutor_id = $1 AND sender = 'student' AND read_at IS NULL`,
      [tutor.id]
    );
    unreadMessages = row.count;
  }

  // Whether the Videos tab applies: at least one live online
  // enrollment. Checked here so the tab bar can decide without an
  // extra request on every screen.
  let hasOnline = false;

  if (req.user.role === 'student') {
    const row = await one(
      `SELECT COUNT(*)::int AS count FROM enrollments
        WHERE student_id = $1 AND learning_mode = 'online'
          AND status IN ('accepted', 'completed')`,
      [req.user.id]
    );
    hasOnline = row.count > 0;
  }

  // Announcements a student has not opened yet. "Unread" is the
  // absence of a read row, so this counts what is missing.
  let unreadAnnouncements = 0;

  if (req.user.role === 'student') {
    const row = await one(
      `SELECT COUNT(DISTINCT a.id)::int AS count
         FROM announcements a
         JOIN enrollments e
           ON e.tutor_id = a.tutor_id
          AND e.student_id = $1
          AND e.status IN ('accepted', 'completed')
         LEFT JOIN announcement_reads r
           ON r.announcement_id = a.id AND r.student_id = $1
        WHERE r.student_id IS NULL AND a.created_at >= e.created_at`,
      [req.user.id]
    );
    unreadAnnouncements = row.count;
  }

  res.json({
    ...req.user,
    tutor,
    unread: unread.count,
    pending_enrollments: pendingEnrollments,
    unread_messages: unreadMessages,
    unread_announcements: unreadAnnouncements,
    has_online_enrollment: hasOnline,
  });
}));

// ============================================================
// SUBJECTS
// ============================================================
// Open to everyone, because the registration form needs the list
// before anybody has an account.
// ============================================================

app.get('/api/subjects', handle(async (req, res) => {
  res.json(await query('SELECT id, subject_name FROM subjects ORDER BY subject_name'));
}));

// ============================================================
// TUTOR
// ============================================================

// A rejected tutor fixes what was wrong and asks to be looked at
// again. This is the only way back from 'rejected'.
app.post('/api/tutor/resubmit', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const updated = await one(
    `UPDATE tutors
        SET verification_status = 'pending', reject_reason = NULL
      WHERE user_id = $1 AND verification_status = 'rejected'
      RETURNING id`,
    [req.user.id]
  );

  if (!updated) {
    return res.status(400).json({ error: 'Only a rejected profile can be sent back for review.' });
  }

  await logActivity(req.user, 'resubmit', 'Sent their profile back for review after a rejection');

  res.json(await readTutor(updated.id));
}));

// ============================================================
// UPDATING A PROFILE
// ============================================================

// ---- a student's own details ----
app.put('/api/student/profile', requireLogin, requireRole('student'), handle(async (req, res) => {
  const { full_name, phone, class_level, learning_modes, academic_field } = req.body;

  const problem = firstProblem(
    full_name !== undefined ? checkName(full_name) : null,
    phone !== undefined ? checkPhone(phone) : null
  );

  if (problem) return res.status(400).json({ error: problem });

  const cleanPhone = phone !== undefined ? tidyPhone(phone) : null;

  // Somebody else may already have that number.
  if (cleanPhone) {
    const taken = await one(
      'SELECT id FROM users WHERE phone = $1 AND id <> $2',
      [cleanPhone, req.user.id]
    );
    if (taken) {
      return res.status(409).json({ error: 'That phone number is already registered.' });
    }
  }

  // The field follows the class: leave Class 9-12 and it is cleared;
  // send a new one and it is checked against the (new) class.
  const currentRow = await one('SELECT class_level, academic_field FROM users WHERE id = $1', [req.user.id]);
  const newClass = class_level ? Number(class_level) : currentRow.class_level;
  let newField = academic_field !== undefined ? academic_field : currentRow.academic_field;

  const fieldCheck = cleanField(newField, newClass);
  if (fieldCheck.error) return res.status(400).json({ error: fieldCheck.error });
  newField = hasFields(newClass) ? fieldCheck.value : null;

  const updated = await one(
    `UPDATE users
        SET full_name      = COALESCE($1, full_name),
            phone          = COALESCE($2, phone),
            class_level    = COALESCE($3, class_level),
            learning_modes = COALESCE($4, learning_modes),
            academic_field = $6
      WHERE id = $5
      RETURNING id, role, full_name, email, phone, class_level, academic_field,
                learning_modes, avatar, account_status`,
    [
      full_name?.trim() || null,
      cleanPhone,
      class_level ? Number(class_level) : null,
      learning_modes !== undefined ? cleanModes(learning_modes) : null,
      req.user.id,
      newField,
    ]
  );

  await logActivity(req.user, 'profile_update', 'Updated their details');

  res.json(updated);
}));

// ---- a tutor's details ----
// Changing these does NOT send the profile back for approval. A
// tutor correcting their fee or their bio is not something an
// admin needs to see again. Changing SUBJECTS is different — see
// the route below.
app.put('/api/tutor/profile', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const {
    full_name, phone, centre_name, qualification, experience_years,
    gender, bio, teaching_modes, address, latitude, longitude,
  } = req.body;

  const problem = firstProblem(
    full_name !== undefined ? checkName(full_name) : null,
    phone !== undefined ? checkPhone(phone) : null,
    checkExperience(experience_years)
  );

  if (problem) return res.status(400).json({ error: problem });

  if (teaching_modes !== undefined && cleanModes(teaching_modes).length === 0) {
    return res.status(400).json({ error: 'Choose at least one way you are willing to teach.' });
  }

  const cleanPhone = phone !== undefined ? tidyPhone(phone) : null;

  if (cleanPhone) {
    const taken = await one(
      'SELECT id FROM users WHERE phone = $1 AND id <> $2',
      [cleanPhone, req.user.id]
    );
    if (taken) {
      return res.status(409).json({ error: 'That phone number is already registered.' });
    }
  }

  if (full_name !== undefined || cleanPhone) {
    await query(
      `UPDATE users
          SET full_name = COALESCE($1, full_name),
              phone     = COALESCE($2, phone)
        WHERE id = $3`,
      [full_name?.trim() || null, cleanPhone, req.user.id]
    );
  }

  const tutor = await one(
    `UPDATE tutors SET
        centre_name      = COALESCE($1, centre_name),
        qualification    = COALESCE($2, qualification),
        experience_years = COALESCE($3, experience_years),
        gender           = COALESCE($4, gender),
        bio              = COALESCE($5, bio),
        teaching_modes   = COALESCE($6, teaching_modes),
        address          = COALESCE($7, address),
        latitude         = COALESCE($8, latitude),
        longitude        = COALESCE($9, longitude)
      WHERE user_id = $10
      RETURNING id`,
    [
      centre_name !== undefined ? centre_name : null,
      qualification || null,
      experience_years !== undefined && experience_years !== '' ? Number(experience_years) : null,
      gender || null,
      bio !== undefined ? bio : null,
      teaching_modes !== undefined ? cleanModes(teaching_modes) : null,
      address !== undefined ? address : null,
      latitude != null ? Number(latitude) : null,
      longitude != null ? Number(longitude) : null,
      req.user.id,
    ]
  );

  if (!tutor) return res.status(404).json({ error: 'Profile not found.' });

  await logActivity(req.user, 'profile_update', 'Updated their teaching profile');

  res.json(await readTutor(tutor.id, req.user));
}));

// ---- a tutor's subjects and fees ----
// A tutor who has been APPROVED does not get to change what they
// teach on their own. The change is held here and an admin accepts
// or rejects it — the whole point of approval is that a person
// looked at what somebody claims to teach, and letting them edit
// it afterwards would make that meaningless.
//
// The live profile keeps working throughout. A tutor is not taken
// offline for keeping their listing accurate.
//
// A tutor still waiting for approval edits freely; there is
// nothing approved yet to protect.
app.put('/api/tutor/subjects', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const list = req.body.subjects || [];

  if (list.length === 0) {
    return res.status(400).json({ error: 'You must teach at least one subject.' });
  }

  const tutor = await one(
    'SELECT id, verification_status FROM tutors WHERE user_id = $1',
    [req.user.id]
  );

  if (!tutor) return res.status(404).json({ error: 'Profile not found.' });

  // Validate everything first, so a bad entry never leaves a tutor
  // with half their subjects gone.
  const rows = [];

  for (const item of list) {
    let subjectId = item.subject_id;
    let subjectName = item.subject_name;

    if (!subjectId && subjectName) {
      const name = String(subjectName).trim();
      if (!name) continue;

      const subject = await one(
        `INSERT INTO subjects (subject_name) VALUES ($1)
         ON CONFLICT (subject_name) DO UPDATE SET subject_name = EXCLUDED.subject_name
         RETURNING id, subject_name`,
        [name]
      );
      subjectId = subject.id;
      subjectName = subject.subject_name;
    } else if (subjectId) {
      const subject = await one('SELECT subject_name FROM subjects WHERE id = $1', [subjectId]);
      if (!subject) continue;
      subjectName = subject.subject_name;
    } else {
      continue;
    }

    const problem = firstProblem(
      checkClassRange(item.class_from, item.class_to, subjectName),
      checkFee(item.monthly_fee, subjectName)
    );

    if (problem) return res.status(400).json({ error: problem });

    const fl = cleanFieldList(item.fields, item.class_from, item.class_to);
    if (fl.error) return res.status(400).json({ error: fl.error });

    rows.push({
      subject_id: subjectId,
      subject_name: subjectName,
      class_from: Number(item.class_from) || 1,
      class_to: Number(item.class_to) || 12,
      monthly_fee: Number(item.monthly_fee) || 0,
      fields: fl.value,
    });
  }

  if (rows.length === 0) {
    return res.status(400).json({ error: 'You must teach at least one subject.' });
  }

  // ---- not approved yet: apply it now ----
  if (tutor.verification_status !== 'verified') {
    await applySubjects(tutor.id, rows);
    await logActivity(req.user, 'subjects_changed', 'Changed their subjects');

    return res.json({ ok: true, applied: true, count: rows.length });
  }

  // ---- approved: hold it for an admin ----
  const current = await query(
    `SELECT ts.subject_id, s.subject_name, ts.class_from, ts.class_to, ts.monthly_fee, ts.fields
       FROM tutor_subjects ts
       JOIN subjects s ON s.id = ts.subject_id
      WHERE ts.tutor_id = $1
      ORDER BY s.subject_name`,
    [tutor.id]
  );

  const summary = describeSubjectChange(current, rows);

  if (!summary.changed) {
    return res.json({ ok: true, applied: true, count: rows.length, change: null });
  }

  await query(
    `UPDATE tutors SET pending_changes = $1, pending_changes_at = now()
      WHERE id = $2`,
    [JSON.stringify({ kind: 'subjects', before: current, after: rows, summary }), tutor.id]
  );

  await logActivity(
    req.user,
    'subjects_change_requested',
    `Asked to change their subjects — ${summary.lines.join('; ')}`
  );

  res.json({
    ok: true,
    applied: false,
    pending: true,
    change: summary,
  });
}));

// Writes a subject list, replacing whatever was there.
async function applySubjects(tutorId, rows) {
  await query('DELETE FROM tutor_subjects WHERE tutor_id = $1', [tutorId]);

  for (const row of rows) {
    await query(
      `INSERT INTO tutor_subjects (tutor_id, subject_id, class_from, class_to, monthly_fee, fields)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tutor_id, subject_id) DO NOTHING`,
      [tutorId, row.subject_id, row.class_from, row.class_to, row.monthly_fee, row.fields ?? null]
    );
  }
}

// Works out what actually changed, in words an admin can read
// without comparing two lists by hand.
function describeSubjectChange(before, after) {
  const beforeByName = new Map(before.map((row) => [row.subject_name, row]));
  const afterByName = new Map(after.map((row) => [row.subject_name, row]));

  const added = [];
  const removed = [];
  const edited = [];

  for (const [name, row] of afterByName) {
    const old = beforeByName.get(name);

    if (!old) {
      added.push(`${name} (Class ${row.class_from}–${row.class_to}, Rs ${row.monthly_fee})`);
      continue;
    }

    const bits = [];
    if (old.monthly_fee !== row.monthly_fee) {
      bits.push(`fee Rs ${old.monthly_fee} to Rs ${row.monthly_fee}`);
    }
    if (old.class_from !== row.class_from || old.class_to !== row.class_to) {
      bits.push(`classes ${old.class_from}–${old.class_to} to ${row.class_from}–${row.class_to}`);
    }
    if (JSON.stringify(old.fields ?? null) !== JSON.stringify(row.fields ?? null)) {
      bits.push(`fields ${(old.fields || ['all']).join('/')} to ${(row.fields || ['all']).join('/')}`);
    }
    if (bits.length) edited.push(`${name}: ${bits.join(', ')}`);
  }

  for (const name of beforeByName.keys()) {
    if (!afterByName.has(name)) removed.push(name);
  }

  const lines = [];
  if (added.length) lines.push(`added ${added.join(', ')}`);
  if (removed.length) lines.push(`removed ${removed.join(', ')}`);
  if (edited.length) lines.push(edited.join('; '));

  return {
    changed: lines.length > 0,
    added,
    removed,
    edited,
    lines,
  };
}

// ---- a tutor's days and times ----
app.put('/api/tutor/availability', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const slots = req.body.slots || [];

  const tutor = await one('SELECT id FROM tutors WHERE user_id = $1', [req.user.id]);
  if (!tutor) return res.status(404).json({ error: 'Profile not found.' });

  // Each day keeps its own hours — Monday evenings and Saturday
  // mornings are not assumed to match.
  const clean = [];

  for (const slot of slots) {
    const day = Number(slot.day_of_week);

    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    if (!slot.start_time || !slot.end_time) continue;

    if (slot.start_time >= slot.end_time) {
      return res.status(400).json({
        error: 'A finishing time has to be after the starting time.',
      });
    }

    clean.push({ day, start: slot.start_time, end: slot.end_time });
  }

  await query('DELETE FROM tutor_availability WHERE tutor_id = $1', [tutor.id]);

  for (const slot of clean) {
    await query(
      `INSERT INTO tutor_availability (tutor_id, day_of_week, start_time, end_time)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tutor_id, day_of_week) DO NOTHING`,
      [tutor.id, slot.day, slot.start, slot.end]
    );
  }

  await logActivity(req.user, 'availability_update', `Set ${clean.length} teaching days`);

  res.json({ ok: true, count: clean.length });
}));

// ============================================================
// NOTIFICATIONS
// ============================================================

app.get('/api/notifications', requireLogin, handle(async (req, res) => {
  res.json(await query(
    `SELECT id, type, title, message, data, is_read, created_at
       FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    [req.user.id]
  ));
}));

// Marking one as read, rather than all of them. Somebody who
// opens Alerts to check a single message should not silently lose
// the markers on everything else.
app.post('/api/notifications/:id/read', requireLogin, handle(async (req, res) => {
  const updated = await one(
    `UPDATE notifications SET is_read = true
      WHERE id = $1 AND user_id = $2
      RETURNING id, is_read`,
    [req.params.id, req.user.id]
  );

  if (!updated) return res.status(404).json({ error: 'That message does not exist.' });

  res.json(updated);
}));

app.post('/api/notifications/read', requireLogin, handle(async (req, res) => {
  await query(
    'UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false',
    [req.user.id]
  );
  res.json({ ok: true });
}));

// ============================================================
// SEARCH
// ============================================================
// Students find tutors BY SUBJECT. Distance plays no part — a
// tutor teaching the subject you need is shown whether they are
// down the road or across town, and the student decides from the
// full profile.
//
// Class level and budget narrow it further, but both are optional.
// ============================================================

app.post('/api/search', requireLogin, handle(async (req, res) => {
  const {
    subject_ids = [], class_level, budget, teaching_mode, learning_modes, gender,
    latitude, longitude, max_distance_km, academic_field, area_id,
    min_rating, min_days, max_days,
    verified_only, sort = 'recommended',
  } = req.body;

  const chosen = (Array.isArray(subject_ids) ? subject_ids : [subject_ids])
    .map(Number)
    .filter(Boolean);

  if (chosen.length === 0) {
    return res.status(400).json({ error: 'Choose at least one subject to search.' });
  }

  // Distance is OPTIONAL. It only applies when the student has
  // shared where they are AND set a limit. Without both, every
  // tutor who teaches the subject is shown, wherever they are.
  const hasOrigin = latitude != null && longitude != null;
  const limitKm = hasOrigin && max_distance_km ? Number(max_distance_km) : null;

  const values = [chosen];
  const where = [
    `t.verification_status = 'verified'`,
    `u.account_status = 'active'`,
    `ts.subject_id = ANY($1::int[])`,

    // Out of search once the grace period runs out, and while
    // suspended. Checked here rather than on a schedule, so it is
    // always right even if no background job has run.
    `t.payment_suspended = false`,
    `(t.suspended_until IS NULL OR t.suspended_until <= CURRENT_DATE)`,
  ];

  if (class_level) {
    values.push(Number(class_level));
    where.push(`$${values.length} BETWEEN ts.class_from AND ts.class_to`);
  }
  if (budget) {
    values.push(Number(budget));
    where.push(`ts.monthly_fee <= $${values.length}`);
  }

  // Field (Engineering / Medical / Computer Science). A tutor who has
  // not narrowed a subject to particular fields (NULL) teaches all of
  // them, so is always shown.
  if (academic_field) {
    const fc = cleanField(academic_field);
    if (fc.error) return res.status(400).json({ error: fc.error });
    values.push(fc.value);
    where.push(`(ts.fields IS NULL OR $${values.length}::text = ANY(ts.fields))`);
  }

  // Coverage area: only tutors whose pinned location is inside the
  // boundary somebody drew on the map.
  if (area_id) {
    const area = await one('SELECT polygon FROM coverage_areas WHERE id = $1', [String(area_id)]).catch(() => null);
    if (!area) return res.status(400).json({ error: 'That area does not exist any more.' });
    values.push(JSON.stringify(area.polygon));
    where.push(`point_in_polygon(t.latitude::float8, t.longitude::float8, $${values.length}::jsonb)`);
  }
  // A tutor is shown when there is ANY overlap between how they
  // teach and how this student is willing to learn. Postgres has
  // an operator for exactly that: && on two arrays.
  //
  // Without the overlap there is no arrangement either of them
  // would agree to, so showing the tutor at all would waste
  // everybody's time.
  const wantedModes = Array.isArray(learning_modes) && learning_modes.length
    ? cleanModes(learning_modes)
    : (teaching_mode ? [teaching_mode] : []);

  if (wantedModes.length > 0) {
    values.push(wantedModes);
    where.push(`t.teaching_modes && $${values.length}::text[]`);
  }
  if (gender) {
    values.push(gender);
    where.push(`t.gender = $${values.length}`);
  }

  // Only tutors whose degree an admin has actually checked.
  if (verified_only) {
    where.push(`t.qualification_verified = true`);
  }

  // ---- distance ----
  // Worked out in SQL with the haversine formula. PostGIS would be
  // neater, but it is an extra extension to install and this is
  // accurate to well within a few metres over these distances.
  let distanceSelect = 'NULL::numeric AS distance_km';

  if (hasOrigin) {
    values.push(Number(latitude));
    const latParam = values.length;
    values.push(Number(longitude));
    const lngParam = values.length;

    distanceSelect = `
      ROUND((
        6371 * acos(
          LEAST(1, GREATEST(-1,
            cos(radians($${latParam})) * cos(radians(t.latitude))
            * cos(radians(t.longitude) - radians($${lngParam}))
            + sin(radians($${latParam})) * sin(radians(t.latitude))
          ))
        )
      )::numeric, 1) AS distance_km`;

    // Only cut the list when a limit was actually given.
    if (limitKm) {
      values.push(limitKm);
      where.push(`
        6371 * acos(
          LEAST(1, GREATEST(-1,
            cos(radians($${latParam})) * cos(radians(t.latitude))
            * cos(radians(t.longitude) - radians($${lngParam}))
            + sin(radians($${latParam})) * sin(radians(t.latitude))
          ))
        ) <= $${values.length}`);
    }
  }

  // ---- how many days a week they teach ----
  // A student needing help twice a week is not served by somebody
  // who only opens on Saturdays, and somebody who wants one
  // session does not need a tutor running seven days.
  if (min_days) {
    values.push(Number(min_days));
    where.push(`(
      SELECT COUNT(*) FROM tutor_availability a WHERE a.tutor_id = t.id
    ) >= $${values.length}`);
  }

  if (max_days) {
    values.push(Number(max_days));
    where.push(`(
      SELECT COUNT(*) FROM tutor_availability a WHERE a.tutor_id = t.id
    ) <= $${values.length}`);
  }

  // ---- minimum rating ----
  if (min_rating) {
    values.push(Number(min_rating));
    where.push(`COALESCE(
      (SELECT AVG(r.rating) FROM reviews r WHERE r.tutor_id = t.id), 0
    ) >= $${values.length}`);
  }

  const rows = await query(
    `SELECT t.id, t.centre_name, t.qualification, t.experience_years,
            t.gender, t.teaching_modes, t.address,
            t.qualification_doc, t.qualification_verified,
            t.latitude, t.longitude,
            u.full_name, u.avatar,
            s.subject_name, ts.subject_id, ts.class_from, ts.class_to, ts.monthly_fee, ts.fields,
            ${distanceSelect},
            (SELECT COUNT(*)::int FROM tutor_availability a WHERE a.tutor_id = t.id) AS days_per_week,
            (SELECT COUNT(*)::int FROM reviews r WHERE r.tutor_id = t.id)            AS review_count,
            (SELECT ROUND(AVG(r.rating)::numeric, 1) FROM reviews r WHERE r.tutor_id = t.id) AS average_rating
       FROM tutor_subjects ts
       JOIN tutors   t ON t.id = ts.tutor_id
       JOIN users    u ON u.id = t.user_id
       JOIN subjects s ON s.id = ts.subject_id
      WHERE ${where.join(' AND ')}`,
    values
  );

  // A tutor teaching two of the chosen subjects comes back twice,
  // so group the rows into one entry per tutor with their matching
  // subjects listed inside.
  const byTutor = new Map();

  for (const row of rows) {
    if (!byTutor.has(row.id)) {
      byTutor.set(row.id, {
        id: row.id,
        full_name: row.full_name,
        avatar: row.avatar,
        centre_name: row.centre_name,
        qualification: row.qualification,
        experience_years: row.experience_years,
        gender: row.gender,
        teaching_modes: row.teaching_modes,
        address: row.address,
        days_per_week: row.days_per_week,
        review_count: row.review_count,
        average_rating: row.average_rating ? Number(row.average_rating) : null,
        distance_km: row.distance_km != null ? Number(row.distance_km) : null,
        qualification_badge: Boolean(row.qualification_doc && row.qualification_verified),
        matches: [],
      });
    }

    byTutor.get(row.id).matches.push({
      subject_id: row.subject_id,
      subject_name: row.subject_name,
      class_from: row.class_from,
      class_to: row.class_to,
      monthly_fee: row.monthly_fee,
      fields: row.fields,
    });
  }

  const results = [...byTutor.values()];

  // How much of what the student asked for each tutor covers.
  for (const tutor of results) {
    tutor.match_percent = Math.round((tutor.matches.length / chosen.length) * 100);
    tutor.lowest_fee = Math.min(...tutor.matches.map((m) => m.monthly_fee));
  }

  // ---- ordering ----
  // recommended  coverage first, then rating, then price
  // rating       best reviewed first
  // distance     nearest first (only if a position was shared)
  // fee          cheapest first
  const orderings = {
    recommended: (a, b) =>
      b.match_percent - a.match_percent
      || (b.average_rating || 0) - (a.average_rating || 0)
      || a.lowest_fee - b.lowest_fee,

    rating: (a, b) =>
      (b.average_rating || 0) - (a.average_rating || 0)
      || b.review_count - a.review_count,

    distance: (a, b) =>
      (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity),

    fee: (a, b) => a.lowest_fee - b.lowest_fee,
  };

  results.sort(orderings[sort] || orderings.recommended);

  res.json({
    results: results.slice(0, 100),
    count: results.length,
    sort,
    distance_used: hasOrigin,
    subjects_asked: chosen.length,
  });
}));

// ------------------------------------------------------------
// The public homepage feed
// ------------------------------------------------------------
// No login needed, and deliberately thin: name, centre, subjects,
// rating. NO phone number, NO address, NO map position.
//
// That is the whole point of the split — a visitor can see the
// platform is real and worth joining, without the contact details
// tutors registered to share with students rather than with the
// open internet.
// ------------------------------------------------------------
app.get('/api/public/tutors', handle(async (req, res) => {
  const rows = await query(
    `SELECT t.id, t.centre_name, t.qualification, t.experience_years,
            t.qualification_doc, t.qualification_verified,
            u.full_name, u.avatar,
            (SELECT COUNT(*)::int FROM reviews r WHERE r.tutor_id = t.id) AS review_count,
            (SELECT ROUND(AVG(r.rating)::numeric, 1) FROM reviews r WHERE r.tutor_id = t.id) AS average_rating,
            (SELECT json_agg(json_build_object(
                      'subject_name', s.subject_name,
                      'class_from', ts.class_from,
                      'class_to', ts.class_to,
                      'fields', ts.fields))
               FROM tutor_subjects ts
               JOIN subjects s ON s.id = ts.subject_id
              WHERE ts.tutor_id = t.id) AS subjects
       FROM tutors t
       JOIN users u ON u.id = t.user_id
      WHERE t.verification_status = 'verified'
        AND u.account_status = 'active'
        AND t.payment_suspended = false
        AND (t.suspended_until IS NULL OR t.suspended_until <= CURRENT_DATE)
      ORDER BY
        (SELECT COUNT(*) FROM reviews r WHERE r.tutor_id = t.id) DESC,
        t.experience_years DESC
      LIMIT 24`
  );

  res.json(rows.map((row) => ({
    id: row.id,
    full_name: row.full_name,
    avatar: row.avatar,
    centre_name: row.centre_name,
    qualification: row.qualification,
    experience_years: row.experience_years,
    qualification_badge: Boolean(row.qualification_doc && row.qualification_verified),
    subjects: row.subjects || [],
    review_count: row.review_count,
    average_rating: row.average_rating ? Number(row.average_rating) : null,
  })));
}));

// One tutor's full profile, for a student who tapped a result.
app.get('/api/tutors/:id', requireLogin, handle(async (req, res) => {
  const tutor = await readTutor(req.params.id, req.user);

  if (!tutor) {
    return res.status(404).json({ error: 'That tutor profile no longer exists.' });
  }

  // "About 3 km away" is the useful part, and it can be worked out
  // without handing over the exact position.
  const { lat, lng } = req.query;

  if (lat && lng && tutor.latitude != null) {
    const distance = await one(
      `SELECT ROUND((
         6371 * acos(
           LEAST(1, GREATEST(-1,
             cos(radians($1)) * cos(radians($3))
             * cos(radians($4) - radians($2))
             + sin(radians($1)) * sin(radians($3))
           ))
         )
       )::numeric, 1) AS km`,
      [Number(lat), Number(lng), Number(tutor.latitude), Number(tutor.longitude)]
    );

    tutor.distance_km = distance.km != null ? Number(distance.km) : null;
  }

  // Students only ever see approved tutors. Admins see everyone,
  // which is how they review a profile before approving it.
  if (req.user.role === 'student' && tutor.verification_status !== 'verified') {
    return res.status(404).json({ error: 'That tutor is not available.' });
  }

  res.json(tutor);
}));

// ============================================================
// CNIC UPLOAD
// ============================================================
// Called during registration, before the account exists, so it
// cannot require a login. It is rate limited instead, and an
// uploaded file does nothing on its own — it only matters once a
// registration refers to it.
//
// The reply is just a random filename. The image itself can only
// be read back through the admin route further down.
// ============================================================

app.post('/api/upload', uploadLimit, upload.single('file'), handle(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Choose a file to upload.' });
  }
  res.json({ filename: req.file.filename });
}));

// ============================================================
// REVIEWS
// ============================================================
// Only students, and only one review per tutor each. Without that
// limit one person could post the same opinion twenty times.
// ============================================================

app.post('/api/tutors/:id/reviews', requireLogin, requireRole('student'), handle(async (req, res) => {
  const rating = Number(req.body.rating);
  const comment = String(req.body.comment || '').trim();

  if (!(rating >= 1 && rating <= 5)) {
    return res.status(400).json({ error: 'Give a rating between 1 and 5 stars.' });
  }

  // The gate: you may only review a tutor who actually took you
  // on. Accepted is enough — a student a month into lessons has
  // plenty to say, and making them wait until the arrangement ends
  // means most reviews never get written at all.
  //
  // What it still rules out is the thing that matters: somebody
  // rating a tutor they never dealt with.
  // 'left' counts here on purpose. Somebody who studied with this
  // tutor and then walked away often has the most worth saying,
  // and silencing them would make every rating less honest.
  const dealing = await one(
    `SELECT id FROM enrollments
      WHERE student_id = $1 AND tutor_id = $2
        AND status IN ('accepted', 'completed', 'left')
      ORDER BY created_at DESC
      LIMIT 1`,
    [req.user.id, req.params.id]
  );

  if (!dealing) {
    return res.status(403).json({
      error: 'You can only review a tutor who has accepted your enrollment.',
    });
  }

  // ON CONFLICT lets a student change their mind and update the
  // review they already left, rather than being told off for
  // trying to review twice.
  const review = await one(
    `INSERT INTO reviews (tutor_id, student_id, enrollment_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tutor_id, student_id)
     DO UPDATE SET rating = EXCLUDED.rating,
                   comment = EXCLUDED.comment,
                   created_at = now()
     RETURNING id, rating, comment, created_at`,
    [req.params.id, req.user.id, dealing.id, rating, comment || null]
  );

  await logActivity(req.user, 'review', `Left a ${rating}-star review on a tutor profile`);

  res.status(201).json(review);
}));

app.delete('/api/tutors/:id/reviews', requireLogin, requireRole('student'), handle(async (req, res) => {
  await query(
    'DELETE FROM reviews WHERE tutor_id = $1 AND student_id = $2',
    [req.params.id, req.user.id]
  );
  res.json({ ok: true });
}));

// ============================================================
// ENROLLMENTS
// ============================================================
// A student asks a tutor to take them on for one subject. The
// tutor accepts or rejects, with a note either way, and only an
// acceptance unlocks their phone number.
//
// Both sides are told what happened through notifications, so
// neither has to keep checking.
// ============================================================

// Reads the subjects one request covers.
async function enrollmentSubjects(enrollmentId) {
  return query(
    `SELECT s.subject_name, es.monthly_fee, es.subject_id
       FROM enrollment_subjects es
       JOIN subjects s ON s.id = es.subject_id
      WHERE es.enrollment_id = $1
      ORDER BY s.subject_name`,
    [enrollmentId]
  );
}

// Shapes one enrollment for whichever side is looking at it.
function shapeEnrollment(row, forRole) {
  const shared = {
    id: row.id,
    status: row.status,
    learning_mode: row.learning_mode,
    left_at: row.left_at,
    left_reason: row.left_reason,
    subjects: row.subjects || [],
    monthly_total: (row.subjects || []).reduce(
      (sum, s) => sum + Number(s.monthly_fee || 0), 0
    ),
    message: row.message,
    tutor_note: row.tutor_note,
    created_at: row.created_at,
    responded_at: row.responded_at,
  };

  if (forRole === 'student') {
    return {
      ...shared,
      tutor_id: row.tutor_id,
      tutor_name: row.tutor_name,
      tutor_avatar: row.tutor_avatar,
      centre_name: row.centre_name,
      qualification: row.qualification,
      address: row.address,
      monthly_fee: row.monthly_fee,
      // The number arrives only with an acceptance.
      tutor_phone: row.status === 'accepted' ? row.tutor_phone : null,
    };
  }

  return {
    ...shared,
    student_id: row.student_id,
    student_name: row.student_name,
    student_avatar: row.student_avatar,
    class_level: row.class_level,
    // Likewise: the tutor gets the student's number once they say yes.
    student_phone: row.status === 'accepted' ? row.student_phone : null,
  };
}

// ---- a student asks ----
// ONE request covering every subject the student wants, not one
// per subject. A student asking about Maths, Physics and
// Chemistry sends one message the tutor answers once — three
// separate notifications about the same person would be noise.
app.post('/api/enrollments', requireLogin, requireRole('student'), handle(async (req, res) => {
  const { tutor_id, message, learning_mode } = req.body;

  const tutor = await one(
    `SELECT t.id, t.user_id, t.teaching_modes, u.full_name
       FROM tutors t JOIN users u ON u.id = t.user_id
      WHERE t.id = $1
        AND t.verification_status = 'verified'
        AND u.account_status = 'active'`,
    [tutor_id]
  );

  if (!tutor) {
    return res.status(404).json({ error: 'That tutor is not available.' });
  }

  // How this particular tuition will happen. It must be something
  // the tutor offers AND the student accepts — anything else is an
  // arrangement neither of them agreed to.
  const student = await one('SELECT learning_modes FROM users WHERE id = $1', [req.user.id]);

  const shared = (tutor.teaching_modes || []).filter(
    (mode) => (student?.learning_modes || []).includes(mode)
  );

  if (shared.length === 0) {
    return res.status(400).json({
      error: 'You and this tutor have no way of working in common. Change your learning modes, or choose another tutor.',
    });
  }

  const mode = shared.includes(learning_mode) ? learning_mode : shared[0];

  // Which subjects to include. If the caller names some, use
  // those; otherwise the request covers everything this tutor
  // teaches, which is what "enroll with this tutor" means.
  const asked = (req.body.subject_ids || []).map(Number).filter(Boolean);

  const subjects = asked.length > 0
    ? await query(
        `SELECT ts.subject_id, s.subject_name, ts.monthly_fee
           FROM tutor_subjects ts
           JOIN subjects s ON s.id = ts.subject_id
          WHERE ts.tutor_id = $1 AND ts.subject_id = ANY($2::int[])
          ORDER BY s.subject_name`,
        [tutor.id, asked]
      )
    : await query(
        `SELECT ts.subject_id, s.subject_name, ts.monthly_fee
           FROM tutor_subjects ts
           JOIN subjects s ON s.id = ts.subject_id
          WHERE ts.tutor_id = $1
          ORDER BY s.subject_name`,
        [tutor.id]
      );

  if (subjects.length === 0) {
    return res.status(400).json({ error: 'That tutor has no subjects listed.' });
  }

  // One live request per pair. Asking again while one is open is
  // just the same question twice.
  const open = await one(
    `SELECT id, status FROM enrollments
      WHERE student_id = $1 AND tutor_id = $2
        AND status IN ('pending', 'accepted')`,
    [req.user.id, tutor.id]
  );

  if (open) {
    return res.status(409).json({
      error: open.status === 'pending'
        ? 'You have already asked this tutor. They have not answered yet.'
        : 'You are already enrolled with this tutor.',
    });
  }

  const enrollment = await one(
    `INSERT INTO enrollments (student_id, tutor_id, message, learning_mode)
     VALUES ($1, $2, $3, $4)
     RETURNING id, status, learning_mode, created_at`,
    [req.user.id, tutor.id, String(message || '').trim() || null, mode]
  );

  // The fee is copied in, so a later price change does not
  // silently rewrite what was agreed.
  for (const subject of subjects) {
    await query(
      `INSERT INTO enrollment_subjects (enrollment_id, subject_id, monthly_fee)
       VALUES ($1, $2, $3)`,
      [enrollment.id, subject.subject_id, subject.monthly_fee]
    );
  }

  const names = subjects.map((row) => row.subject_name);
  const total = subjects.reduce((sum, row) => sum + Number(row.monthly_fee || 0), 0);

  // ONE notification, whatever the number of subjects.
  await notify(
    tutor.user_id,
    'enrollment_request',
    'New enrollment request',
    `${req.user.full_name} would like to enroll for ${names.join(', ')}`
      + ` — Rs ${total.toLocaleString('en-PK')} a month in total.`
      + ' Open your requests to accept or decline.'
  );

  await logActivity(
    req.user,
    'enroll_request',
    `Asked ${tutor.full_name} to enroll for ${names.join(', ')}`
  );

  res.status(201).json({
    id: enrollment.id,
    subjects: names,
    monthly_total: total,
  });
}));

// ---- the student's own requests ----
app.get('/api/enrollments/mine', requireLogin, requireRole('student'), handle(async (req, res) => {
  const rows = await query(
    `SELECT e.*,
            t.id AS tutor_id, t.centre_name, t.qualification, t.address,
            u.full_name AS tutor_name, u.phone AS tutor_phone,
            u.avatar AS tutor_avatar
       FROM enrollments e
       JOIN tutors t ON t.id = e.tutor_id
       JOIN users  u ON u.id = t.user_id
      WHERE e.student_id = $1
      ORDER BY e.created_at DESC`,
    [req.user.id]
  );

  for (const row of rows) {
    row.subjects = await enrollmentSubjects(row.id);
  }

  res.json(rows.map((row) => shapeEnrollment(row, 'student')));
}));

// ---- the requests waiting on a tutor ----
app.get('/api/enrollments/received', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const rows = await query(
    `SELECT e.*,
            u.id AS student_id, u.full_name AS student_name,
            u.phone AS student_phone, u.class_level, u.avatar AS student_avatar
       FROM enrollments e
       JOIN tutors t ON t.id = e.tutor_id
       JOIN users  u ON u.id = e.student_id
      WHERE t.user_id = $1
      ORDER BY
        CASE WHEN e.status = 'pending' THEN 0 ELSE 1 END,
        e.created_at DESC`,
    [req.user.id]
  );

  for (const row of rows) {
    row.subjects = await enrollmentSubjects(row.id);
  }

  res.json(rows.map((row) => shapeEnrollment(row, 'tutor')));
}));

// ---- the tutor answers ----
app.post('/api/enrollments/:id/respond', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const accept = req.body.accept === true;
  const note = String(req.body.note || '').trim();

  // Joined through tutors so a tutor can only answer their own.
  const enrollment = await one(
    `SELECT e.*, u.full_name AS student_name, tu.full_name AS tutor_name,
            (SELECT string_agg(s.subject_name, ', ' ORDER BY s.subject_name)
               FROM enrollment_subjects es
               JOIN subjects s ON s.id = es.subject_id
              WHERE es.enrollment_id = e.id) AS subject_names
       FROM enrollments e
       JOIN tutors t  ON t.id = e.tutor_id
       JOIN users  tu ON tu.id = t.user_id
       JOIN users  u  ON u.id = e.student_id
      WHERE e.id = $1 AND t.user_id = $2`,
    [req.params.id, req.user.id]
  );

  if (!enrollment) {
    return res.status(404).json({ error: 'That request does not exist.' });
  }
  if (enrollment.status !== 'pending') {
    return res.status(400).json({ error: 'You have already answered this request.' });
  }

  // Turning somebody down without saying why leaves them nothing
  // to act on, so a note is required on a rejection.
  if (!accept && !note) {
    return res.status(400).json({ error: 'Add a note, so the student knows why.' });
  }

  const updated = await one(
    `UPDATE enrollments
        SET status = $1, tutor_note = $2, responded_at = now()
      WHERE id = $3
      RETURNING id, status, tutor_note, responded_at`,
    [accept ? 'accepted' : 'rejected', note || null, enrollment.id]
  );

  await notify(
    enrollment.student_id,
    accept ? 'enrollment_accepted' : 'enrollment_rejected',
    accept
      ? `${enrollment.tutor_name} accepted your enrollment`
      : `${enrollment.tutor_name} could not take you on`,
    accept
      ? `You are enrolled for ${enrollment.subject_names}. Their phone number is now on the request — call to agree timings.${note ? ` They added: "${note}"` : ''}`
      : `For ${enrollment.subject_names}. They said: "${note}"`
  );

  await logActivity(
    req.user,
    accept ? 'enroll_accept' : 'enroll_reject',
    `${accept ? 'Accepted' : 'Declined'} ${enrollment.student_name} for ${enrollment.subject_names}`
  );

  res.json(updated);
}));

// ---- either side marks the tuition finished ----
// This is what unlocks reviewing. Either the student or the tutor
// can do it, because either might be the one who decides the
// arrangement has run its course.
app.post('/api/enrollments/:id/complete', requireLogin, handle(async (req, res) => {
  // A student owns their enrollment directly; a tutor owns it
  // through their profile. One query covers both.
  const enrollment = await one(
    `SELECT e.*, t.user_id AS tutor_user_id,
            u.full_name AS student_name, tu.full_name AS tutor_name,
            (SELECT string_agg(s.subject_name, ', ' ORDER BY s.subject_name)
               FROM enrollment_subjects es
               JOIN subjects s ON s.id = es.subject_id
              WHERE es.enrollment_id = e.id) AS subject_names
       FROM enrollments e
       JOIN tutors t  ON t.id = e.tutor_id
       JOIN users  tu ON tu.id = t.user_id
       JOIN users  u  ON u.id = e.student_id
      WHERE e.id = $1 AND (e.student_id = $2 OR t.user_id = $2)`,
    [req.params.id, req.user.id]
  );

  if (!enrollment) {
    return res.status(404).json({ error: 'That enrollment does not exist.' });
  }
  if (enrollment.status !== 'accepted') {
    return res.status(400).json({ error: 'Only an accepted enrollment can be marked finished.' });
  }

  const updated = await one(
    `UPDATE enrollments SET status = 'completed', completed_at = now()
      WHERE id = $1 RETURNING id, status, completed_at`,
    [enrollment.id]
  );

  // Tell the other side, and nudge the student to review.
  const isStudent = req.user.role === 'student';

  await notify(
    isStudent ? enrollment.tutor_user_id : enrollment.student_id,
    'enrollment_completed',
    'Tuition marked as finished',
    isStudent
      ? `${enrollment.student_name} marked ${enrollment.subject_names} as finished. They can now leave a review.`
      : `${enrollment.tutor_name} marked ${enrollment.subject_names} as finished. You can now leave a review.`
  );

  await logActivity(
    req.user,
    'enroll_complete',
    `Marked ${enrollment.subject_names} tuition as finished`
  );

  res.json(updated);
}));

// ---- the student ends the tuition ----
// Different from withdrawing a request, which only applies before
// a tutor has answered. This ends a live arrangement, and it cuts
// EVERYTHING: no more messages, no more announcements, no more
// videos.
//
// Their reviews stay. They did study with this tutor, and deleting
// what they said because they left would make every rating on the
// platform less honest.
app.post('/api/enrollments/:id/leave', requireLogin, requireRole('student'), handle(async (req, res) => {
  const reason = String(req.body.reason || '').trim();

  const enrollment = await one(
    `SELECT e.*, t.user_id AS tutor_user_id, tu.full_name AS tutor_name
       FROM enrollments e
       JOIN tutors t  ON t.id = e.tutor_id
       JOIN users  tu ON tu.id = t.user_id
      WHERE e.id = $1 AND e.student_id = $2`,
    [req.params.id, req.user.id]
  );

  if (!enrollment) {
    return res.status(404).json({ error: 'That enrollment does not exist.' });
  }

  if (!['accepted', 'completed'].includes(enrollment.status)) {
    return res.status(400).json({
      error: 'Only tuition that is running can be left.',
    });
  }

  await query(
    `UPDATE enrollments SET status = 'left', left_at = now(), left_reason = $1
      WHERE id = $2`,
    [reason || null, enrollment.id]
  );

  // Take back any videos that had not been watched. A student who
  // has left should not keep receiving a course, and one they
  // already watched is theirs to have watched.
  await query(
    `DELETE FROM video_releases r
      USING videos v
      WHERE r.video_id = v.id
        AND v.tutor_id = $1
        AND r.student_id = $2
        AND r.watched_at IS NULL`,
    [enrollment.tutor_id, req.user.id]
  );

  await notify(
    enrollment.tutor_user_id,
    'student_left',
    `${req.user.full_name} has left`,
    reason
      ? `They said: "${reason}"`
      : 'They ended the tuition. You can no longer message each other.'
  );

  await logActivity(
    req.user,
    'enroll_left',
    `Left the tuition with ${enrollment.tutor_name}`
  );

  res.json({ ok: true });
}));

// ---- the student withdraws before an answer ----
app.post('/api/enrollments/:id/cancel', requireLogin, requireRole('student'), handle(async (req, res) => {
  const updated = await one(
    `UPDATE enrollments
        SET status = 'cancelled'
      WHERE id = $1 AND student_id = $2 AND status = 'pending'
      RETURNING id, status`,
    [req.params.id, req.user.id]
  );

  if (!updated) {
    return res.status(400).json({ error: 'Only a request that is still waiting can be withdrawn.' });
  }

  res.json(updated);
}));

// ============================================================
// COMPARISON
// ============================================================
// Side by side, for up to three tutors at once. Three because it
// is the most a phone can show without shrinking the text past
// readable — a comparison nobody can read is not a comparison.
// ============================================================

app.post('/api/tutors/compare', requireLogin, handle(async (req, res) => {
  const ids = (req.body.tutor_ids || []).slice(0, 3);
  const subjectIds = (req.body.subject_ids || []).map(Number).filter(Boolean);

  if (ids.length < 2) {
    return res.status(400).json({ error: 'Choose at least two tutors to compare.' });
  }

  const tutors = [];

  for (const id of ids) {
    const tutor = await readTutor(id, req.user);
    if (!tutor) continue;
    if (tutor.verification_status !== 'verified') continue;

    // How much of what the student searched for this tutor covers.
    if (subjectIds.length > 0) {
      const covered = tutor.subjects.filter((subject) =>
        subjectIds.includes(Number(subject.subject_id))
      );

      tutor.matched_subjects = covered;
      tutor.match_percent = Math.round((covered.length / subjectIds.length) * 100);

      tutor.missing_subjects = subjectIds.filter((wanted) =>
        !tutor.subjects.some((subject) => Number(subject.subject_id) === wanted)
      );
    } else {
      tutor.matched_subjects = tutor.subjects;
      tutor.match_percent = null;
      tutor.missing_subjects = [];
    }

    const fees = tutor.subjects.map((subject) => subject.monthly_fee).filter(Boolean);
    tutor.lowest_fee = fees.length ? Math.min(...fees) : 0;
    tutor.highest_fee = fees.length ? Math.max(...fees) : 0;
    tutor.days_per_week = tutor.availability.length;

    tutors.push(tutor);
  }

  if (tutors.length < 2) {
    return res.status(400).json({ error: 'Those tutors are no longer available.' });
  }

  res.json({ tutors });
}));

// ============================================================
// REPORTS
// ============================================================
// Flagging a tutor's conduct to the administrator. Private, unlike
// a review — it goes to one person rather than onto a profile.
// ============================================================

const REPORT_REASONS = [
  'Details are not true',
  'Did not turn up',
  'Behaved inappropriately',
  'Asked for money outside the agreed fee',
  'Not the person in the profile',
  'Something else',
];

app.get('/api/report-reasons', handle(async (req, res) => {
  res.json(REPORT_REASONS);
}));

app.post('/api/tutors/:id/report', requireLogin, handle(async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  const details = String(req.body.details || '').trim();

  if (!reason) {
    return res.status(400).json({ error: 'Choose a reason.' });
  }

  const tutor = await one(
    `SELECT t.id, u.full_name FROM tutors t
       JOIN users u ON u.id = t.user_id
      WHERE t.id = $1`,
    [req.params.id]
  );

  if (!tutor) {
    return res.status(404).json({ error: 'That tutor no longer exists.' });
  }

  // You may only report somebody you have actually dealt with.
  // Otherwise a complaint can come from anyone who merely looked
  // at a profile, and the admin queue fills with grudges.
  // Also survives leaving. Bad conduct is often exactly WHY
  // somebody left, so cutting off reporting at that moment would
  // lose the reports that matter most.
  const dealing = await one(
    `SELECT id FROM enrollments
      WHERE student_id = $1 AND tutor_id = $2
        AND status IN ('accepted', 'completed', 'left')
      ORDER BY created_at DESC
      LIMIT 1`,
    [req.user.id, tutor.id]
  );

  if (!dealing) {
    return res.status(403).json({
      error: 'You can only report a tutor you have enrolled with.',
    });
  }

  // One open report per person per tutor, so a grudge cannot be
  // turned into twenty entries in the admin's queue.
  const existing = await one(
    `SELECT id FROM reports
      WHERE reporter_id = $1 AND tutor_id = $2 AND status = 'open'`,
    [req.user.id, tutor.id]
  );

  if (existing) {
    return res.status(409).json({
      error: 'You have already reported this tutor. An administrator is looking at it.',
    });
  }

  const report = await one(
    `INSERT INTO reports (reporter_id, tutor_id, enrollment_id, reason, details)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, status, created_at`,
    [req.user.id, tutor.id, dealing.id, reason, details || null]
  );

  await logActivity(req.user, 'report', `Reported ${tutor.full_name} — ${reason}`);

  res.status(201).json(report);
}));

// ============================================================
// AVATARS
// ============================================================
// Optional for everybody. Served publicly, because a profile
// picture is meant to be looked at — but from their OWN folder,
// never the one holding CNIC scans.
// ============================================================

app.post('/api/upload/avatar', requireLogin, avatarLimit, uploadAvatar.single('file'), handle(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Choose an image.' });
  }

  // Set straight away rather than making the app send it back in a
  // separate profile update — one tap, one result.
  await query('UPDATE users SET avatar = $1 WHERE id = $2', [req.file.filename, req.user.id]);

  res.json({ avatar: req.file.filename });
}));

app.delete('/api/upload/avatar', requireLogin, handle(async (req, res) => {
  await query('UPDATE users SET avatar = NULL WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
}));

// No login needed: these appear on the public homepage, and an
// avatar gives away nothing a name does not.
app.get('/api/avatars/:name', handle(async (req, res) => {
  const full = safeAvatarPath(req.params.name);

  if (!full) return res.status(404).json({ error: 'No such image.' });

  // Safe to cache hard — the filename changes whenever the picture
  // does, so a stale one can never be served.
  res.set('Cache-Control', 'public, max-age=604800');
  res.sendFile(full);
}));

// ============================================================
// PAYMENTS
// ============================================================
// The money moves outside the app. What happens here is a tutor
// SAYING they paid, with a photo of the receipt, and an
// administrator confirming it.
//
// Sending a receipt is also what stops the three-day suspension —
// that rule exists to catch silence, not lateness.
// ============================================================

// The payment routes (receipt, history, admin verification, settings)
// live in routes/payments.js.

// ============================================================
// VIDEOS
// ============================================================
// Recorded lessons, for students learning ONLINE.
//
// Two rules shape all of this:
//
//   1. The video file is not stored here. A lesson recording is
//      hundreds of megabytes; serving those off a laptop would
//      fall over on the first class that watched one. What is
//      stored is a link — either to a file the tutor uploaded
//      straight to Cloudinary, or to YouTube / Drive.
//
//   2. A video is visible to NOBODY until it is explicitly
//      released to named students, from a named date. That is what
//      lets a tutor drip a course out day by day, and it means a
//      mistake is invisible rather than public.
// ============================================================

// Only students who said they want to learn online. A student
// coming to the centre in person has not asked for videos, and
// filling their screen with them is noise.
const ONLINE_MODE = 'online';

// Everything in this section needs the tutor to actually teach
// online. Somebody running a centre in person has no use for it,
// and letting them share videos with students who never asked for
// them would be noise on both sides.
async function onlineTutor(userId) {
  return one(
    `SELECT id FROM tutors WHERE user_id = $1 AND $2 = ANY(teaching_modes)`,
    [userId, ONLINE_MODE]
  );
}

const NOT_ONLINE = {
  error: 'Videos are for online teaching. Tick "online" on your profile to use them.',
};

// What the app needs to upload straight to Cloudinary. Returns
// ready:false when it is not configured, and the app falls back to
// pasting a link — which is a real option, not a broken state.
app.get('/api/tutor/videos/upload-config', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await onlineTutor(req.user.id);
  if (!tutor) return res.status(403).json(NOT_ONLINE);

  res.json(cloudinaryConfig());
}));

// Signs ONE upload. The file itself never passes through this
// server — holding a 300 MB video in memory here would double the
// bandwidth and time out on a slow connection.
app.post('/api/tutor/videos/sign-upload', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await onlineTutor(req.user.id);
  if (!tutor) return res.status(403).json(NOT_ONLINE);

  const signed = signUpload();

  if (!signed) {
    return res.status(503).json({
      error: 'Video uploads are not set up on this server. Paste a YouTube or Drive link instead.',
    });
  }

  res.json(signed);
}));

app.post('/api/tutor/videos', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const {
    subject_id, title, description, url, duration_mins,
    source, cloud_id, size_bytes, academic_field,
  } = req.body;

  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Give the video a title.' });
  }
  if (!url || !/^https?:\/\//i.test(String(url).trim())) {
    return res.status(400).json({ error: 'Paste the full link, starting http:// or https://' });
  }

  // A video marked as uploaded must really be one of OURS. Deleting
  // it later asks Cloudinary to destroy whatever cloud_id is stored
  // here, so without this check a tutor could send any public id in
  // the account and have it destroyed by deleting their "video".
  if (source === 'cloudinary') {
    const cloud = cloudinaryConfig();

    const ours =
      cloud.ready &&
      typeof cloud_id === 'string' &&
      cloud_id.startsWith(`${cloud.folder}/`) &&
      !cloud_id.includes('..') &&
      String(url).trim().startsWith(`https://res.cloudinary.com/${cloud.cloud_name}/`);

    if (!ours) {
      return res.status(400).json({
        error: 'That upload could not be verified. Try uploading it again.',
      });
    }
  }

  const tutor = await onlineTutor(req.user.id);
  if (!tutor) return res.status(403).json(NOT_ONLINE);

  // It must be a subject they actually teach, or it could never be
  // useful to anybody enrolled with them.
  const teaches = await one(
    `SELECT ts.subject_id, ts.class_from, ts.class_to, ts.fields, s.subject_name
       FROM tutor_subjects ts
       JOIN subjects s ON s.id = ts.subject_id
      WHERE ts.tutor_id = $1 AND ts.subject_id = $2`,
    [tutor.id, Number(subject_id)]
  );

  if (!teaches) {
    return res.status(400).json({ error: 'Choose a subject you teach.' });
  }

  // ---- the class range is NOT chosen here ----
  // It comes from the subject on their profile. A tutor approved
  // to teach Maths for Class 9-10 should not be able to attach a
  // Class 12 video to it, because nobody checked them for Class 12
  // — and an admin approving "Maths 9-10" would mean nothing if
  // the range could be sidestepped per video.
  //
  // Changing it is a profile change, which goes to an admin.
  const fromClass = teaches.class_from;
  const toClass = teaches.class_to;

  // A video may be aimed at ONE field (Engineering / Medical / Computer
  // Science). It has to be a field the tutor teaches this subject for.
  const fieldCheck = cleanField(academic_field);
  if (fieldCheck.error) return res.status(400).json({ error: fieldCheck.error });
  if (fieldCheck.value && teaches.fields && !teaches.fields.includes(fieldCheck.value)) {
    return res.status(400).json({ error: 'You do not teach this subject for that field.' });
  }
  const videoField = hasFields(fromClass) || hasFields(toClass) ? fieldCheck.value : null;

  const isCloud = source === 'cloudinary' && cloud_id;

  const video = await one(
    `INSERT INTO videos (tutor_id, subject_id, title, description, url,
                         class_from, class_to, duration_mins,
                         source, cloud_id, thumbnail, size_bytes, academic_field)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, title, url, class_from, class_to, academic_field, created_at`,
    [
      tutor.id, Number(subject_id),
      String(title).trim(),
      String(description || '').trim() || null,
      String(url).trim(),
      fromClass,
      toClass,
      duration_mins ? Number(duration_mins) : null,
      isCloud ? 'cloudinary' : 'link',
      isCloud ? cloud_id : null,
      isCloud ? thumbnailFor(cloud_id) : null,
      size_bytes ? Number(size_bytes) : null,
      videoField,
    ]
  );

  await logActivity(req.user, 'video_added', `Added the video "${String(title).trim()}"`);

  res.status(201).json(video);
}));

app.get('/api/tutor/videos', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await onlineTutor(req.user.id);
  if (!tutor) return res.json([]);

  res.json(await query(
    `SELECT v.*, s.subject_name,
            (SELECT COUNT(*)::int FROM video_releases r WHERE r.video_id = v.id) AS shared_with,
            (SELECT COUNT(*)::int FROM video_releases r
              WHERE r.video_id = v.id AND r.release_on > CURRENT_DATE)           AS scheduled,
            (SELECT COUNT(*)::int FROM video_releases r
              WHERE r.video_id = v.id AND r.watched_at IS NOT NULL)              AS watched,
            (SELECT MIN(r.release_on) FROM video_releases r WHERE r.video_id = v.id) AS first_release,
            -- Minutes actually spent, added across every student it
            -- went to — a quick sense of whether a lesson is being
            -- watched properly or just clicked open.
            (SELECT COALESCE(ROUND(SUM(r.watched_seconds) / 60.0), 0)::int
               FROM video_releases r WHERE r.video_id = v.id)                    AS watched_minutes,
            (SELECT MAX(r.last_watched_at) FROM video_releases r WHERE r.video_id = v.id) AS last_watched_at
       FROM videos v
       JOIN subjects s ON s.id = v.subject_id
      WHERE v.tutor_id = $1
      ORDER BY v.created_at DESC`,
    [tutor.id]
  ));
}));

// Who watched a video, and the per-sitting history, are in routes/videos.js.

app.delete('/api/tutor/videos/:id', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await onlineTutor(req.user.id);
  if (!tutor) return res.status(403).json(NOT_ONLINE);

  const removed = await one(
    `DELETE FROM videos WHERE id = $1 AND tutor_id = $2
     RETURNING id, source, cloud_id`,
    [req.params.id, tutor.id]
  );

  if (!removed) return res.status(404).json({ error: 'That video does not exist.' });

  // Take the file with it, so it does not sit in the Cloudinary
  // account forever costing storage on something nobody can reach.
  // A failure here is logged and swallowed — the row should still
  // go, and an orphaned file is a smaller problem than a video the
  // tutor cannot delete.
  if (removed.source === 'cloudinary' && removed.cloud_id) {
    deleteFromCloudinary(removed.cloud_id);
  }

  res.json({ ok: true });
}));

// ------------------------------------------------------------
// Who a tutor can send videos to
// ------------------------------------------------------------
// Only students learning ONLINE, filterable so a tutor can pick a
// group rather than ticking forty boxes: by subject, by class, and
// by when they enrolled.
// ------------------------------------------------------------
app.get('/api/tutor/online-students', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await onlineTutor(req.user.id);
  if (!tutor) return res.json([]);

  const { subject_id, class_level, enrolled_from, enrolled_to, month } = req.query;

  const values = [tutor.id, ONLINE_MODE];
  const where = [
    'e.tutor_id = $1',
    `e.status IN ('accepted', 'completed')`,
    // The mode agreed for THIS tuition, not the student's general
    // preference. The same person can sit in the centre for Maths
    // and take Physics online, and only the second should get
    // videos.
    'e.learning_mode = $2',
  ];

  if (subject_id) {
    values.push(Number(subject_id));
    where.push(`EXISTS (
      SELECT 1 FROM enrollment_subjects es
       WHERE es.enrollment_id = e.id AND es.subject_id = $${values.length}
    )`);
  }

  if (class_level) {
    values.push(Number(class_level));
    where.push(`u.class_level = $${values.length}`);
  }

  // Enrolled between two dates.
  if (enrolled_from) {
    values.push(enrolled_from);
    where.push(`e.created_at >= $${values.length}::date`);
  }
  if (enrolled_to) {
    values.push(enrolled_to);
    where.push(`e.created_at < ($${values.length}::date + 1)`);
  }

  // Or simply "everybody who joined in a given month" — the common
  // case, and far quicker than picking two dates.
  if (month) {
    values.push(month);
    where.push(`to_char(e.created_at, 'YYYY-MM') = $${values.length}`);
  }

  const students = await query(
    `SELECT DISTINCT u.id, u.full_name, u.avatar, u.class_level,
            u.learning_modes,
            e.created_at AS enrolled_at,
            (SELECT string_agg(s.subject_name, ', ' ORDER BY s.subject_name)
               FROM enrollment_subjects es
               JOIN subjects s ON s.id = es.subject_id
              WHERE es.enrollment_id = e.id) AS subjects
       FROM enrollments e
       JOIN users u ON u.id = e.student_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.created_at DESC`,
    values
  );

  res.json(students);
}));

// ------------------------------------------------------------
// Releasing videos
// ------------------------------------------------------------
// Several videos, to several students, from one date. Doing them
// one at a time would mean forty taps to share a week's lessons
// with a class.
//
// Sending the same pair twice updates the date rather than failing
// — changing your mind about a schedule is normal.
// ------------------------------------------------------------
// Sharing videos (with the rules about who is eligible) is in routes/videos.js.


// What a tutor has scheduled, grouped by the day it appears.
app.get('/api/tutor/videos/schedule', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await onlineTutor(req.user.id);
  if (!tutor) return res.json([]);

  const rows = await query(
    `SELECT r.release_on, v.id AS video_id, v.title, u.full_name AS student_name,
            r.watched_at, r.last_watched_at, r.watched_seconds
       FROM video_releases r
       JOIN videos v ON v.id = r.video_id
       JOIN users  u ON u.id = r.student_id
      WHERE v.tutor_id = $1
      ORDER BY r.release_on DESC, v.title`,
    [tutor.id]
  );

  // Grouped by date here rather than in the app, so every screen
  // that wants this gets the same shape.
  const byDate = new Map();

  for (const row of rows) {
    const key = row.release_on.toISOString
      ? row.release_on.toISOString().slice(0, 10)
      : String(row.release_on).slice(0, 10);

    if (!byDate.has(key)) byDate.set(key, { release_on: key, items: [] });

    byDate.get(key).items.push({
      video_id: row.video_id,
      title: row.title,
      student_name: row.student_name,
      watched: Boolean(row.watched_at),
      watched_minutes: Math.round((row.watched_seconds || 0) / 60),
      last_watched_at: row.last_watched_at,
    });
  }

  res.json([...byDate.values()]);
}));

// ------------------------------------------------------------
// What a student can watch
// ------------------------------------------------------------
// Released to them, and the release date has arrived. A student
// not learning online has no videos at all, which is why the
// section is hidden for them rather than shown empty.
// ------------------------------------------------------------
app.get('/api/videos', requireLogin, requireRole('student'), handle(async (req, res) => {
  // The tab exists only if they have at least one LIVE online
  // enrollment. Having ticked 'online' on a profile but never
  // enrolled online means there is nothing to show.
  const online = await one(
    `SELECT COUNT(*)::int AS count
       FROM enrollments
      WHERE student_id = $1
        AND learning_mode = $2
        AND status IN ('accepted', 'completed')`,
    [req.user.id, ONLINE_MODE]
  );

  if (online.count === 0) {
    const me = await one('SELECT learning_modes FROM users WHERE id = $1', [req.user.id]);

    return res.json({
      online: false,
      // Told apart, because the fix is different: tick the box, or
      // enrol with somebody online.
      wants_online: Boolean(me?.learning_modes?.includes(ONLINE_MODE)),
      videos: [],
    });
  }

  const videos = await query(
    `SELECT v.id, v.title, v.description, v.url, v.duration_mins, v.duration_seconds,
            v.class_from, v.class_to, v.source, v.academic_field,
            s.subject_name,
            u.full_name AS tutor_name, u.avatar AS tutor_avatar,
            t.id AS tutor_id,
            r.release_on, r.watched_at, r.watched_seconds, r.watch_count,
            r.last_watched_at
       FROM video_releases r
       JOIN videos   v ON v.id = r.video_id
       JOIN tutors   t ON t.id = v.tutor_id
       JOIN users    u ON u.id = t.user_id
       JOIN subjects s ON s.id = v.subject_id
      WHERE r.student_id = $1
        AND r.release_on <= CURRENT_DATE
        -- Nothing from a tutor they have left.
        AND EXISTS (
          SELECT 1 FROM enrollments e
           WHERE e.student_id = r.student_id
             AND e.tutor_id = v.tutor_id
             AND e.status IN ('accepted', 'completed')
        )
      ORDER BY r.release_on DESC, v.created_at DESC`,
    [req.user.id]
  );

  // How many are still to come, so the screen can say "3 more on
  // Monday" rather than looking finished.
  const upcoming = await one(
    `SELECT COUNT(*)::int AS count, MIN(release_on) AS next_on
       FROM video_releases
      WHERE student_id = $1 AND release_on > CURRENT_DATE`,
    [req.user.id]
  );

  res.json({
    online: true,
    videos,
    upcoming: upcoming.count,
    next_on: upcoming.next_on,
  });
}));

app.post('/api/videos/:id/watched', requireLogin, requireRole('student'), handle(async (req, res) => {
  await query(
    `UPDATE video_releases SET watched_at = now()
      WHERE video_id = $1 AND student_id = $2 AND watched_at IS NULL`,
    [req.params.id, req.user.id]
  );

  res.json({ ok: true });
}));

// Recording how long a student really watches is in routes/videos.js.


// ============================================================
// QUIZZES
// ============================================================
// An online quiz a tutor sets for their students — class-wise, or
// for any other group they pick. It works exactly like videos:
//
//   1. Built in a library, question by question, with one correct
//      option per question. Nothing is visible while it is a
//      draft.
//
//   2. Released to named students from a named date — the same
//      explicit act as sharing a video, and for the same reason: a
//      mistake stays invisible instead of becoming public.
//
// Unlike videos, a quiz is not limited to students learning
// online — a tutor teaching at a centre can quiz their class just
// as easily.
// ============================================================

// A quiz built question by question needs everything checked
// together, so one bad question does not leave half a quiz saved.
function quizProblem(title, questions) {
  if (!title || !String(title).trim()) {
    return 'Give the quiz a title.';
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    return 'Add at least one question.';
  }

  for (const [i, q] of questions.entries()) {
    const n = i + 1;
    if (!q.question_text || !String(q.question_text).trim()) {
      return `Question ${n} needs its text.`;
    }
    if (!Array.isArray(q.options) || q.options.length < 2) {
      return `Question ${n} needs at least two options.`;
    }
    if (q.options.some((o) => !o.option_text || !String(o.option_text).trim())) {
      return `Question ${n} has an empty option.`;
    }
    if (q.options.filter((o) => o.is_correct).length !== 1) {
      return `Question ${n} needs exactly one correct option.`;
    }
  }

  return null;
}

app.post('/api/tutor/quizzes', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const { subject_id, title, description, time_limit_mins, publish, questions = [] } = req.body;

  const problem = quizProblem(title, questions);
  if (problem) return res.status(400).json({ error: problem });

  const tutor = await one('SELECT id FROM tutors WHERE user_id = $1', [req.user.id]);
  if (!tutor) return res.status(404).json({ error: 'Profile not found.' });

  // A subject they actually teach — the class range comes from
  // there, exactly as it does for videos, so a quiz can never
  // silently target a class nobody approved them for.
  const teaches = await one(
    `SELECT ts.class_from, ts.class_to
       FROM tutor_subjects ts
      WHERE ts.tutor_id = $1 AND ts.subject_id = $2`,
    [tutor.id, Number(subject_id)]
  );
  if (!teaches) return res.status(400).json({ error: 'Choose a subject you teach.' });

  const quiz = await one(
    `INSERT INTO quizzes (tutor_id, subject_id, title, description,
                          class_from, class_to, time_limit_mins, is_published)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, title, is_published, created_at`,
    [
      tutor.id, Number(subject_id),
      String(title).trim(),
      String(description || '').trim() || null,
      teaches.class_from, teaches.class_to,
      time_limit_mins ? Number(time_limit_mins) : null,
      Boolean(publish),
    ]
  );

  for (const [qi, q] of questions.entries()) {
    const question = await one(
      `INSERT INTO quiz_questions (quiz_id, question_text, order_index, points)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [quiz.id, String(q.question_text).trim(), qi, Number(q.points) || 1]
    );

    for (const [oi, o] of q.options.entries()) {
      await query(
        `INSERT INTO quiz_options (question_id, option_text, is_correct, order_index)
         VALUES ($1, $2, $3, $4)`,
        [question.id, String(o.option_text).trim(), Boolean(o.is_correct), oi]
      );
    }
  }

  await logActivity(req.user, 'quiz_added', `Added the quiz "${String(title).trim()}"`);

  res.status(201).json(quiz);
}));

app.get('/api/tutor/quizzes', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await one('SELECT id FROM tutors WHERE user_id = $1', [req.user.id]);
  if (!tutor) return res.json([]);

  res.json(await query(
    `SELECT q.id, q.title, q.description, q.class_from, q.class_to,
            q.time_limit_mins, q.is_published, q.created_at, s.subject_name,
            (SELECT COUNT(*)::int FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS question_count,
            (SELECT COUNT(*)::int FROM quiz_releases r WHERE r.quiz_id = q.id) AS shared_with,
            (SELECT COUNT(*)::int FROM quiz_releases r
              WHERE r.quiz_id = q.id AND r.release_on > CURRENT_DATE)          AS scheduled,
            (SELECT COUNT(*)::int FROM quiz_attempts a
              WHERE a.quiz_id = q.id AND a.submitted_at IS NOT NULL)           AS attempts,
            (SELECT ROUND(AVG(a.score::numeric / NULLIF(a.max_score, 0)) * 100)::int
               FROM quiz_attempts a
              WHERE a.quiz_id = q.id AND a.submitted_at IS NOT NULL)           AS avg_percent
       FROM quizzes q
       JOIN subjects s ON s.id = q.subject_id
      WHERE q.tutor_id = $1
      ORDER BY q.created_at DESC`,
    [tutor.id]
  ));
}));

// Only a real id: otherwise "schedule" (the route below) is captured
// here as if it were a quiz id and the database rejects it with a 500.
app.get('/api/tutor/quizzes/:id([0-9a-fA-F-]{36})', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await one('SELECT id FROM tutors WHERE user_id = $1', [req.user.id]);
  if (!tutor) return res.status(404).json({ error: 'Profile not found.' });

  const quiz = await one(
    `SELECT q.*, s.subject_name FROM quizzes q
       JOIN subjects s ON s.id = q.subject_id
      WHERE q.id = $1 AND q.tutor_id = $2`,
    [req.params.id, tutor.id]
  );
  if (!quiz) return res.status(404).json({ error: 'That quiz does not exist.' });

  const questions = await query(
    `SELECT id, question_text, order_index, points
       FROM quiz_questions WHERE quiz_id = $1 ORDER BY order_index`,
    [quiz.id]
  );

  const options = await query(
    `SELECT o.id, o.question_id, o.option_text, o.is_correct, o.order_index
       FROM quiz_options o
       JOIN quiz_questions qq ON qq.id = o.question_id
      WHERE qq.quiz_id = $1 ORDER BY o.order_index`,
    [quiz.id]
  );

  for (const q of questions) {
    q.options = options.filter((o) => o.question_id === q.id);
  }

  res.json({ ...quiz, questions });
}));

app.delete('/api/tutor/quizzes/:id', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await one('SELECT id FROM tutors WHERE user_id = $1', [req.user.id]);
  if (!tutor) return res.status(404).json({ error: 'Profile not found.' });

  const removed = await one(
    'DELETE FROM quizzes WHERE id = $1 AND tutor_id = $2 RETURNING id',
    [req.params.id, tutor.id]
  );
  if (!removed) return res.status(404).json({ error: 'That quiz does not exist.' });

  res.json({ ok: true });
}));

app.patch('/api/tutor/quizzes/:id/publish', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await one('SELECT id FROM tutors WHERE user_id = $1', [req.user.id]);
  if (!tutor) return res.status(404).json({ error: 'Profile not found.' });

  const quiz = await one(
    `UPDATE quizzes SET is_published = $3
      WHERE id = $1 AND tutor_id = $2
      RETURNING id, is_published`,
    [req.params.id, tutor.id, Boolean(req.body?.publish)]
  );
  if (!quiz) return res.status(404).json({ error: 'That quiz does not exist.' });

  res.json(quiz);
}));

// ------------------------------------------------------------
// Who a tutor can send a quiz to
// ------------------------------------------------------------
// Unlike videos, a quiz is not restricted to online learners — a
// student coming to the centre in person can be quizzed just the
// same. So this is every currently-enrolled student, filterable
// the same way: by subject, by class, by when they enrolled.
// ------------------------------------------------------------
app.get('/api/tutor/students', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await one('SELECT id FROM tutors WHERE user_id = $1', [req.user.id]);
  if (!tutor) return res.json([]);

  const { subject_id, class_level, enrolled_from, enrolled_to, month } = req.query;

  const values = [tutor.id];
  const where = ['e.tutor_id = $1', `e.status IN ('accepted', 'completed')`];

  if (subject_id) {
    values.push(Number(subject_id));
    where.push(`EXISTS (
      SELECT 1 FROM enrollment_subjects es
       WHERE es.enrollment_id = e.id AND es.subject_id = $${values.length}
    )`);
  }
  if (class_level) {
    values.push(Number(class_level));
    where.push(`u.class_level = $${values.length}`);
  }
  if (enrolled_from) {
    values.push(enrolled_from);
    where.push(`e.created_at >= $${values.length}::date`);
  }
  if (enrolled_to) {
    values.push(enrolled_to);
    where.push(`e.created_at < ($${values.length}::date + 1)`);
  }
  if (month) {
    values.push(month);
    where.push(`to_char(e.created_at, 'YYYY-MM') = $${values.length}`);
  }

  const students = await query(
    `SELECT DISTINCT u.id, u.full_name, u.avatar, u.class_level,
            e.created_at AS enrolled_at,
            (SELECT string_agg(s.subject_name, ', ' ORDER BY s.subject_name)
               FROM enrollment_subjects es
               JOIN subjects s ON s.id = es.subject_id
              WHERE es.enrollment_id = e.id) AS subjects
       FROM enrollments e
       JOIN users u ON u.id = e.student_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.created_at DESC`,
    values
  );

  res.json(students);
}));

// ------------------------------------------------------------
// Releasing quizzes — same shape as releasing videos
// ------------------------------------------------------------
app.post('/api/tutor/quizzes/release', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const { quiz_ids = [], student_ids = [], release_on } = req.body;

  if (quiz_ids.length === 0 || student_ids.length === 0) {
    return res.status(400).json({ error: 'Choose at least one quiz and one student.' });
  }

  const tutor = await one('SELECT id FROM tutors WHERE user_id = $1', [req.user.id]);
  if (!tutor) return res.status(404).json({ error: 'Profile not found.' });

  // Only this tutor's own PUBLISHED quizzes — a draft is not ready
  // for a student to see, whatever release date is picked.
  const quizzes = await query(
    `SELECT id, title FROM quizzes
      WHERE tutor_id = $1 AND id = ANY($2::uuid[]) AND is_published = true`,
    [tutor.id, quiz_ids]
  );
  if (quizzes.length === 0) {
    return res.status(400).json({
      error: 'None of those quizzes are published yet. Publish a quiz before sharing it.',
    });
  }

  const students = await query(
    `SELECT DISTINCT u.id, u.full_name
       FROM enrollments e
       JOIN users u ON u.id = e.student_id
      WHERE e.tutor_id = $1
        AND e.status IN ('accepted', 'completed')
        AND u.id = ANY($2::uuid[])`,
    [tutor.id, student_ids]
  );
  if (students.length === 0) {
    return res.status(400).json({ error: 'None of those students are enrolled with you.' });
  }

  const date = release_on || new Date().toISOString().slice(0, 10);

  for (const quiz of quizzes) {
    for (const student of students) {
      await query(
        `INSERT INTO quiz_releases (quiz_id, student_id, release_on)
         VALUES ($1, $2, $3)
         ON CONFLICT (quiz_id, student_id) DO UPDATE SET release_on = EXCLUDED.release_on`,
        [quiz.id, student.id, date]
      );
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  if (date <= today) {
    for (const student of students) {
      await notify(
        student.id,
        'quiz_shared',
        quizzes.length === 1 ? 'A new quiz from your tutor' : `${quizzes.length} new quizzes from your tutor`,
        `${req.user.full_name} shared ${quizzes.length === 1 ? `"${quizzes[0].title}"` : `${quizzes.length} quizzes`} with you.`
      );
    }
  }

  await logActivity(
    req.user,
    'quizzes_released',
    `Shared ${quizzes.length} quiz${quizzes.length === 1 ? '' : 'zes'} with ${students.length} student${students.length === 1 ? '' : 's'} from ${date}`
  );

  res.json({
    ok: true,
    quizzes: quizzes.length,
    students: students.length,
    release_on: date,
    scheduled: date > today,
  });
}));

// What a tutor has scheduled, grouped by the day it appears.
app.get('/api/tutor/quizzes/schedule', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await one('SELECT id FROM tutors WHERE user_id = $1', [req.user.id]);
  if (!tutor) return res.json([]);

  const rows = await query(
    `SELECT r.release_on, q.id AS quiz_id, q.title, u.full_name AS student_name,
            a.submitted_at, a.score, a.max_score
       FROM quiz_releases r
       JOIN quizzes q ON q.id = r.quiz_id
       JOIN users   u ON u.id = r.student_id
       LEFT JOIN quiz_attempts a ON a.quiz_id = q.id AND a.student_id = r.student_id
      WHERE q.tutor_id = $1
      ORDER BY r.release_on DESC, q.title`,
    [tutor.id]
  );

  const byDate = new Map();
  for (const row of rows) {
    const key = row.release_on.toISOString
      ? row.release_on.toISOString().slice(0, 10)
      : String(row.release_on).slice(0, 10);

    if (!byDate.has(key)) byDate.set(key, { release_on: key, items: [] });

    byDate.get(key).items.push({
      quiz_id: row.quiz_id,
      title: row.title,
      student_name: row.student_name,
      submitted: Boolean(row.submitted_at),
      score: row.score,
      max_score: row.max_score,
    });
  }

  res.json([...byDate.values()]);
}));

// Every attempt for one quiz — the mark sheet.
app.get('/api/tutor/quizzes/:id/results', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await one('SELECT id FROM tutors WHERE user_id = $1', [req.user.id]);
  if (!tutor) return res.status(404).json({ error: 'Profile not found.' });

  const quiz = await one(
    'SELECT id, title FROM quizzes WHERE id = $1 AND tutor_id = $2',
    [req.params.id, tutor.id]
  );
  if (!quiz) return res.status(404).json({ error: 'That quiz does not exist.' });

  const results = await query(
    `SELECT u.id AS student_id, u.full_name, u.avatar, u.class_level,
            r.release_on, a.started_at, a.submitted_at, a.score, a.max_score, a.cheat_count
       FROM quiz_releases r
       JOIN users u ON u.id = r.student_id
       LEFT JOIN quiz_attempts a ON a.quiz_id = r.quiz_id AND a.student_id = r.student_id
      WHERE r.quiz_id = $1
      ORDER BY a.submitted_at DESC NULLS LAST, u.full_name`,
    [quiz.id]
  );

  res.json({ quiz, results });
}));

// ------------------------------------------------------------
// Taking a quiz, as a student
// ------------------------------------------------------------
app.get('/api/quizzes', requireLogin, requireRole('student'), handle(async (req, res) => {
  const quizzes = await query(
    `SELECT q.id, q.title, q.description, q.time_limit_mins,
            s.subject_name, u.full_name AS tutor_name, u.avatar AS tutor_avatar,
            t.id AS tutor_id,
            r.release_on,
            (SELECT COUNT(*)::int FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS question_count,
            a.submitted_at, a.score, a.max_score
       FROM quiz_releases r
       JOIN quizzes  q ON q.id = r.quiz_id
       JOIN tutors   t ON t.id = q.tutor_id
       JOIN users    u ON u.id = t.user_id
       JOIN subjects s ON s.id = q.subject_id
       LEFT JOIN quiz_attempts a ON a.quiz_id = q.id AND a.student_id = r.student_id
      WHERE r.student_id = $1
        AND r.release_on <= CURRENT_DATE
        AND q.is_published = true
        AND EXISTS (
          SELECT 1 FROM enrollments e
           WHERE e.student_id = r.student_id AND e.tutor_id = q.tutor_id
             AND e.status IN ('accepted', 'completed')
        )
      ORDER BY r.release_on DESC, q.created_at DESC`,
    [req.user.id]
  );

  const upcoming = await one(
    `SELECT COUNT(*)::int AS count, MIN(release_on) AS next_on
       FROM quiz_releases
      WHERE student_id = $1 AND release_on > CURRENT_DATE`,
    [req.user.id]
  );

  res.json({ quizzes, upcoming: upcoming.count, next_on: upcoming.next_on });
}));

// Taking an exam — start, answer, cheat events, state — lives in
// routes/exams.js. The old take/submit pair was removed on purpose:
// it let the phone grade the whole quiz in one request with no
// clock, which makes a per-question time limit impossible to enforce.

// The reviewed result — every question, what they picked, and what
// was actually right. Only once it has been submitted; before that
// showing answers would just be the answer key.
app.get('/api/quizzes/:id/result', requireLogin, requireRole('student'), handle(async (req, res) => {
  const attempt = await one(
    `SELECT id, started_at, submitted_at, score, max_score, cheat_count
       FROM quiz_attempts WHERE quiz_id = $1 AND student_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!attempt || !attempt.submitted_at) {
    return res.status(400).json({ error: 'This quiz has not been submitted yet.' });
  }

  const quiz = await one(
    `SELECT q.title, q.description, s.subject_name
       FROM quizzes q JOIN subjects s ON s.id = q.subject_id
      WHERE q.id = $1`,
    [req.params.id]
  );

  const questions = await query(
    `SELECT id, question_text, order_index, points FROM quiz_questions
      WHERE quiz_id = $1 ORDER BY order_index`,
    [req.params.id]
  );

  const options = await query(
    `SELECT o.id, o.question_id, o.option_text, o.is_correct, o.order_index
       FROM quiz_options o JOIN quiz_questions qq ON qq.id = o.question_id
      WHERE qq.quiz_id = $1 ORDER BY o.order_index`,
    [req.params.id]
  );

  const picks = await query(
    `SELECT question_id, option_id, is_correct, cheated, timed_out
       FROM quiz_answers WHERE attempt_id = $1`,
    [attempt.id]
  );
  const pickedByQuestion = new Map(picks.map((p) => [p.question_id, p]));

  for (const q of questions) {
    q.options = options.filter((o) => o.question_id === q.id);
    q.picked_option_id = pickedByQuestion.get(q.id)?.option_id || null;
    q.correct = Boolean(pickedByQuestion.get(q.id)?.is_correct);
    q.cheated = Boolean(pickedByQuestion.get(q.id)?.cheated);
    q.timed_out = Boolean(pickedByQuestion.get(q.id)?.timed_out);
  }

  res.json({
    ...quiz,
    score: attempt.score,
    max_score: attempt.max_score,
    submitted_at: attempt.submitted_at,
    cheat_count: attempt.cheat_count,
    questions,
  });
}));

// ============================================================
// CHAT
// ============================================================
// Only between a tutor and a student who have an accepted
// enrollment. Without that check, anybody could message any tutor
// on the platform, which is the thing enrollment exists to gate.
// ============================================================

// Confirms these two are allowed to talk, and returns the pair.
// Used by every chat route, so the rule lives in one place.
async function chatPair(user, otherId) {
  if (user.role === 'student') {
    const row = await one(
      `SELECT t.id AS tutor_id, t.user_id AS tutor_user_id, u.full_name AS tutor_name
         FROM enrollments e
         JOIN tutors t ON t.id = e.tutor_id
         JOIN users  u ON u.id = t.user_id
        WHERE e.student_id = $1 AND e.tutor_id = $2
          AND e.status IN ('accepted', 'completed')
        LIMIT 1`,
      [user.id, otherId]
    );

    if (!row) return null;

    return {
      tutorId: row.tutor_id,
      studentId: user.id,
      tutorUserId: row.tutor_user_id,
      otherName: row.tutor_name,
    };
  }

  if (user.role === 'tutor') {
    const row = await one(
      `SELECT t.id AS tutor_id, u.id AS student_id, u.full_name AS student_name
         FROM enrollments e
         JOIN tutors t ON t.id = e.tutor_id
         JOIN users  u ON u.id = e.student_id
        WHERE t.user_id = $1 AND e.student_id = $2
          AND e.status IN ('accepted', 'completed')
        LIMIT 1`,
      [user.id, otherId]
    );

    if (!row) return null;

    return {
      tutorId: row.tutor_id,
      studentId: row.student_id,
      tutorUserId: user.id,
      otherName: row.student_name,
    };
  }

  return null;
}

// ---- who you can talk to ----
app.get('/api/chats', requireLogin, handle(async (req, res) => {
  if (req.user.role === 'student') {
    const rows = await query(
      `SELECT DISTINCT ON (t.id)
              t.id AS id, u.full_name AS name, u.avatar,
              t.centre_name,
              (SELECT body FROM messages m
                WHERE m.tutor_id = t.id AND m.student_id = $1
                ORDER BY m.created_at DESC LIMIT 1) AS last_body,
              (SELECT created_at FROM messages m
                WHERE m.tutor_id = t.id AND m.student_id = $1
                ORDER BY m.created_at DESC LIMIT 1) AS last_at,
              (SELECT COUNT(*)::int FROM messages m
                WHERE m.tutor_id = t.id AND m.student_id = $1
                  AND m.sender = 'tutor' AND m.read_at IS NULL) AS unread
         FROM enrollments e
         JOIN tutors t ON t.id = e.tutor_id
         JOIN users  u ON u.id = t.user_id
        WHERE e.student_id = $1 AND e.status IN ('accepted', 'completed')
        ORDER BY t.id`,
      [req.user.id]
    );

    // Newest conversation first, but anybody never written to still
    // shows — you have to be able to start one.
    rows.sort((a, b) => new Date(b.last_at || 0) - new Date(a.last_at || 0));
    return res.json(rows);
  }

  if (req.user.role === 'tutor') {
    const tutor = await one('SELECT id FROM tutors WHERE user_id = $1', [req.user.id]);
    if (!tutor) return res.json([]);

    const rows = await query(
      `SELECT DISTINCT ON (u.id)
              u.id AS id, u.full_name AS name, u.avatar, u.class_level,
              (SELECT body FROM messages m
                WHERE m.tutor_id = $1 AND m.student_id = u.id
                ORDER BY m.created_at DESC LIMIT 1) AS last_body,
              (SELECT created_at FROM messages m
                WHERE m.tutor_id = $1 AND m.student_id = u.id
                ORDER BY m.created_at DESC LIMIT 1) AS last_at,
              (SELECT COUNT(*)::int FROM messages m
                WHERE m.tutor_id = $1 AND m.student_id = u.id
                  AND m.sender = 'student' AND m.read_at IS NULL) AS unread
         FROM enrollments e
         JOIN users u ON u.id = e.student_id
        WHERE e.tutor_id = $1 AND e.status IN ('accepted', 'completed')
        ORDER BY u.id`,
      [tutor.id]
    );

    rows.sort((a, b) => new Date(b.last_at || 0) - new Date(a.last_at || 0));
    return res.json(rows);
  }

  res.json([]);
}));

// ---- one conversation ----
app.get('/api/chats/:id/messages', requireLogin, handle(async (req, res) => {
  const pair = await chatPair(req.user, req.params.id);

  if (!pair) {
    return res.status(403).json({
      error: req.user.role === 'student'
        ? 'You can only message a tutor who has accepted your enrollment.'
        : 'You can only message a student you have taken on.',
    });
  }

  const messages = await query(
    `SELECT id, sender, body, image_url, read_at, delivered_at, created_at
       FROM (SELECT * FROM messages WHERE tutor_id = $1 AND student_id = $2
              ORDER BY created_at DESC LIMIT 300) recent
      ORDER BY created_at ASC`,
    [pair.tutorId, pair.studentId]
  );

  // Opening a conversation marks the OTHER side's messages seen, and
  // the sender's ticks turn blue live.
  await markRead(pair, req.user.role);

  res.json({ messages, name: pair.otherName });
}));

// ---- sending ----
app.post('/api/chats/:id/messages', requireLogin, handle(async (req, res) => {
  const body = String(req.body.body || '').trim();

  if (!body) return res.status(400).json({ error: 'Write something first.' });
  if (body.length > 2000) return res.status(400).json({ error: 'That message is too long.' });

  const pair = await chatPair(req.user, req.params.id);

  if (!pair) {
    return res.status(403).json({ error: 'You cannot message this person.' });
  }

  const message = await one(
    `INSERT INTO messages (tutor_id, student_id, sender, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, sender, body, image_url, read_at, delivered_at, created_at`,
    [pair.tutorId, pair.studentId, req.user.role, body]
  );

  // Straight to anybody with that conversation open. Saved first,
  // so what is broadcast is what is actually stored — sending the
  // draft and then failing to save it would show a message that
  // vanishes on the next refresh.
  emitMessage(pair.tutorId, pair.studentId, message);

  const recipient = req.user.role === 'student' ? pair.tutorUserId : pair.studentId;

  // And to the other person wherever they are, so the badge moves
  // even if they are on another screen.
  emitToUser(recipient, 'chat:unread', {
    from: req.user.id,
    name: req.user.full_name,
    preview: body.length > 80 ? `${body.slice(0, 77)}...` : body,
  });

  await notify(
    recipient,
    'message',
    `Message from ${req.user.full_name}`,
    body.length > 120 ? `${body.slice(0, 117)}...` : body
  );

  res.status(201).json(message);
}));

// ============================================================
// ANNOUNCEMENTS
// ============================================================
// A tutor writing once to everybody enrolled with them. Students
// can read them; there is deliberately no way to reply. Anyone
// wanting to respond opens the normal chat, where the tutor can
// answer one person rather than thirty.
// ============================================================

app.post('/api/announcements', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const body = String(req.body.body || '').trim();

  if (!body) return res.status(400).json({ error: 'Write the announcement first.' });
  if (body.length > 2000) return res.status(400).json({ error: 'That announcement is too long.' });

  const tutor = await one('SELECT id FROM tutors WHERE user_id = $1', [req.user.id]);
  if (!tutor) return res.status(404).json({ error: 'Profile not found.' });

  const announcement = await one(
    `INSERT INTO announcements (tutor_id, body) VALUES ($1, $2)
     RETURNING id, body, created_at`,
    [tutor.id, body]
  );

  // Everybody currently enrolled hears about it.
  const students = await query(
    `SELECT DISTINCT e.student_id
       FROM enrollments e
      WHERE e.tutor_id = $1 AND e.status IN ('accepted', 'completed')`,
    [tutor.id]
  );

  for (const student of students) {
    await notify(
      student.student_id,
      'announcement',
      `Announcement from ${req.user.full_name}`,
      body.length > 120 ? `${body.slice(0, 117)}...` : body
    );
  }

  await logActivity(
    req.user,
    'announcement',
    `Sent an announcement to ${students.length} student${students.length === 1 ? '' : 's'}`
  );

  res.status(201).json({ ...announcement, sent_to: students.length });
}));

app.get('/api/announcements', requireLogin, handle(async (req, res) => {
  if (req.user.role === 'tutor') {
    const tutor = await one('SELECT id FROM tutors WHERE user_id = $1', [req.user.id]);
    if (!tutor) return res.json([]);

    const rows = await query(
      `SELECT a.id, a.body, a.created_at,
              (SELECT COUNT(*)::int FROM announcement_reads r
                WHERE r.announcement_id = a.id) AS read_count
         FROM announcements a
        WHERE a.tutor_id = $1
        ORDER BY a.created_at DESC
        LIMIT 50`,
      [tutor.id]
    );

    return res.json(rows);
  }

  // A student sees announcements from every tutor they are with.
  const rows = await query(
    `SELECT a.id, a.body, a.created_at,
            t.id AS tutor_id, u.full_name AS tutor_name, u.avatar,
            (r.student_id IS NOT NULL) AS is_read
       FROM announcements a
       JOIN tutors t ON t.id = a.tutor_id
       JOIN users  u ON u.id = t.user_id
       JOIN enrollments e
         ON e.tutor_id = a.tutor_id
        AND e.student_id = $1
        AND e.status IN ('accepted', 'completed')
       LEFT JOIN announcement_reads r
         ON r.announcement_id = a.id AND r.student_id = $1
      WHERE a.created_at >= e.created_at
      GROUP BY a.id, t.id, u.full_name, u.avatar, r.student_id
      ORDER BY a.created_at DESC
      LIMIT 50`,
    [req.user.id]
  );

  res.json(rows);
}));

app.post('/api/announcements/:id/read', requireLogin, requireRole('student'), handle(async (req, res) => {
  await query(
    `INSERT INTO announcement_reads (announcement_id, student_id)
     VALUES ($1, $2)
     ON CONFLICT (announcement_id, student_id) DO NOTHING`,
    [req.params.id, req.user.id]
  );

  res.json({ ok: true });
}));

// ============================================================
// ADMIN
// ============================================================
// Approving is the single most important action in the app: it is
// what makes a tutor visible to students. So the admin screens
// show the whole profile, not a summary.
// ============================================================

app.get('/api/admin/stats', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const stats = await one(`
    SELECT
      (SELECT COUNT(*)::int FROM tutors WHERE verification_status = 'pending')   AS pending,
      (SELECT COUNT(*)::int FROM tutors WHERE verification_status = 'verified')  AS verified,
      (SELECT COUNT(*)::int FROM tutors WHERE verification_status = 'rejected')  AS rejected,
      (SELECT COUNT(*)::int FROM users  WHERE role = 'student')                  AS students,
      (SELECT COUNT(*)::int FROM users  WHERE account_status = 'suspended')      AS suspended,
      (SELECT COUNT(*)::int FROM subjects)                                       AS subjects,
      (SELECT COUNT(*)::int FROM reviews)                                        AS reviews,
      (SELECT COUNT(*)::int FROM users
        WHERE last_login_at > now() - interval '24 hours')                       AS active_today,
      (SELECT COUNT(*)::int FROM activity_log
        WHERE created_at > now() - interval '24 hours')                          AS events_today,
      (SELECT COUNT(*)::int FROM enrollments)                                    AS enrollments,
      (SELECT COUNT(*)::int FROM enrollments WHERE status = 'pending')           AS enrollments_pending,
      (SELECT COUNT(*)::int FROM enrollments WHERE status = 'accepted')          AS enrollments_accepted,
      (SELECT COUNT(*)::int FROM enrollments WHERE status = 'completed')         AS enrollments_completed,
      (SELECT COUNT(*)::int FROM reports WHERE status = 'open')                  AS reports_open,
      (SELECT COUNT(*)::int FROM tutors
        WHERE qualification_doc IS NOT NULL AND qualification_verified = false)  AS qualifications_waiting,
      (SELECT COUNT(*)::int FROM tutors WHERE pending_changes IS NOT NULL)       AS changes_waiting,
      (SELECT COUNT(*)::int FROM payments WHERE status = 'pending')              AS payments_waiting,
      (SELECT COUNT(*)::int FROM tutors
        WHERE payment_suspended = true)                                         AS tutors_suspended,
      (SELECT COUNT(*)::int FROM tutors
        WHERE verification_status = 'verified' AND payment_suspended = false
          AND subscription_paid_until IS NOT NULL
          AND subscription_paid_until < CURRENT_DATE)                            AS subscriptions_due
  `);
  res.json(stats);
}));

// The list of tutors, filtered by status. One route covers the
// approval queue and the approved and rejected lists.
app.get('/api/admin/tutors', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const status = ['pending', 'verified', 'rejected'].includes(req.query.status)
    ? req.query.status
    : 'pending';

  const tutors = await query(
    `SELECT t.id, t.centre_name, t.qualification, t.experience_years, t.gender,
            t.teaching_modes, t.address, t.verification_status, t.reject_reason,
            t.reviewed_at, t.created_at, t.cnic_front, t.cnic_back, t.terms_accepted_at,
            t.qualification_doc, t.qualification_verified, t.qualification_note,
            t.pending_changes, t.pending_changes_at,
            t.subscription_paid_until, t.listed,
            u.id AS user_id, u.full_name, u.email, u.phone, u.avatar, u.account_status,
            (SELECT COUNT(*)::int FROM tutor_subjects ts WHERE ts.tutor_id = t.id)      AS subject_count,
            (SELECT COUNT(*)::int FROM tutor_availability a WHERE a.tutor_id = t.id)    AS days_per_week,
            (SELECT MIN(ts.monthly_fee) FROM tutor_subjects ts WHERE ts.tutor_id = t.id) AS lowest_fee,
            (SELECT MAX(ts.monthly_fee) FROM tutor_subjects ts WHERE ts.tutor_id = t.id) AS highest_fee
       FROM tutors t
       JOIN users u ON u.id = t.user_id
      WHERE t.verification_status = $1
      ORDER BY t.created_at DESC`,
    [status]
  );

  res.json(tutors);
}));

// Everything about one tutor, for the review screen.
app.get('/api/admin/tutors/:id', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const tutor = await readTutor(req.params.id);
  if (!tutor) {
    return res.status(404).json({ error: 'That tutor no longer exists.' });
  }
  res.json(tutor);
}));

// Approve or reject. This is what makes a tutor visible, so it
// refuses to approve a profile that is not complete enough to be
// useful to a student.
app.post('/api/admin/tutors/:id/review', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const { approve, reason } = req.body;

  const tutor = await readTutor(req.params.id);
  if (!tutor) {
    return res.status(404).json({ error: 'That tutor no longer exists.' });
  }

  if (approve) {
    if (tutor.subjects.length === 0) {
      return res.status(400).json({
        error: 'This tutor has no subjects. Ask them to add at least one before approving.',
      });
    }
    if (tutor.latitude == null) {
      return res.status(400).json({
        error: 'This tutor has no location pinned. Ask them to set it before approving.',
      });
    }
    if (!tutor.cnic_front || !tutor.cnic_back) {
      return res.status(400).json({
        error: 'Both sides of the CNIC are missing. Approving without checking identity defeats the point.',
      });
    }
  } else if (!reason || !reason.trim()) {
    // A rejection with no reason leaves the tutor with nothing to
    // act on, so it is not allowed.
    return res.status(400).json({ error: 'Write a reason, so the tutor knows what to fix.' });
  }

  await query(
    `UPDATE tutors
        SET verification_status = $1,
            reject_reason = $2,
            reviewed_at = now(),
            reviewed_by = $3,
            -- A newly approved tutor is covered for the rest of this
            -- month; payment starts from next month. Never overwrite
            -- a date that is already further ahead.
            subscription_paid_until = CASE
              WHEN $5::boolean AND (subscription_paid_until IS NULL OR subscription_paid_until < $6::date)
                THEN $6::date ELSE subscription_paid_until END
      WHERE id = $4`,
    [
      approve ? 'verified' : 'rejected',
      approve ? null : reason.trim(),
      req.user.id,
      tutor.id,
      Boolean(approve),
      endOfMonth(todayPK()),
    ]
  );

  // Tell the tutor. This is the whole point of the notifications
  // table — otherwise they would have to keep checking.
  if (approve) {
    await notify(
      tutor.user_id,
      'approved',
      'Your profile has been approved',
      'You are now live. Students searching for your subjects will be able to find you and see your full profile.'
    );
  } else {
    await notify(
      tutor.user_id,
      'rejected',
      'Your profile was not approved',
      `${reason.trim()} — correct this on your profile, then send it back for review.`
    );
  }

  await logActivity(
    req.user,
    approve ? 'approve' : 'reject',
    approve
      ? `Approved ${tutor.full_name}, who is now visible to students`
      : `Rejected ${tutor.full_name} — ${reason.trim()}`
  );

  res.json(await readTutor(tutor.id));
}));

// ------------------------------------------------------------
// Reading a CNIC image
// ------------------------------------------------------------
// Admins only, and never from a public folder. safeUploadPath
// refuses any name that is not one of our random filenames, which
// is what stops a crafted name like "../../.env" walking out of
// the uploads folder.
// ------------------------------------------------------------
app.get('/api/admin/files/:name', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const full = safeDocPath(req.params.name);

  if (!full) {
    return res.status(404).json({ error: 'That file does not exist.' });
  }

  res.sendFile(full);
}));

// The student list.
app.get('/api/admin/students', requireLogin, requireRole('admin'), handle(async (req, res) => {
  res.json(await query(
    `SELECT id, full_name, email, phone, avatar, class_level, account_status, created_at
       FROM users
      WHERE role = 'student'
      ORDER BY created_at DESC
      LIMIT 200`
  ));
}));

// Suspend or restore any account.
app.post('/api/admin/users/:id/status', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const { status } = req.body;

  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'Unknown account status.' });
  }
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot suspend your own account.' });
  }

  const user = await one(
    `UPDATE users SET account_status = $1 WHERE id = $2
     RETURNING id, full_name, account_status`,
    [status, req.params.id]
  );

  if (!user) {
    return res.status(404).json({ error: 'That account no longer exists.' });
  }

  await notify(
    user.id,
    status === 'suspended' ? 'suspended' : 'restored',
    status === 'suspended' ? 'Your account has been suspended' : 'Your account has been restored',
    status === 'suspended'
      ? 'You cannot sign in while your account is suspended. Contact the administrator if you think this is a mistake.'
      : 'You can sign in again as normal.'
  );

  await logActivity(
    req.user,
    status === 'suspended' ? 'suspend' : 'restore',
    `${status === 'suspended' ? 'Suspended' : 'Restored'} the account of ${user.full_name}`
  );

  res.json(user);
}));

// The subject list, with how many tutors teach each one.
app.get('/api/admin/subjects', requireLogin, requireRole('admin'), handle(async (req, res) => {
  res.json(await query(
    `SELECT s.id, s.subject_name,
            (SELECT COUNT(*)::int FROM tutor_subjects ts WHERE ts.subject_id = s.id) AS tutor_count
       FROM subjects s
      ORDER BY s.subject_name`
  ));
}));

app.post('/api/admin/subjects', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const name = String(req.body.subject_name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Enter a subject name.' });
  }

  const subject = await one(
    `INSERT INTO subjects (subject_name) VALUES ($1)
     ON CONFLICT (subject_name) DO UPDATE SET subject_name = EXCLUDED.subject_name
     RETURNING id, subject_name`,
    [name]
  );

  await logActivity(req.user, 'subject_added', `Added the subject "${subject.subject_name}"`);

  res.status(201).json(subject);
}));

// ------------------------------------------------------------
// Approving a qualification document
// ------------------------------------------------------------
// Separate from approving the tutor themselves. A tutor can be
// live on the platform without a verified degree — this only
// decides whether they get the badge.
// ------------------------------------------------------------
app.post('/api/admin/tutors/:id/qualification', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const { approve, note } = req.body;

  const tutor = await one(
    `SELECT t.id, t.user_id, t.qualification_doc, u.full_name
       FROM tutors t JOIN users u ON u.id = t.user_id
      WHERE t.id = $1`,
    [req.params.id]
  );

  if (!tutor) {
    return res.status(404).json({ error: 'That tutor no longer exists.' });
  }
  if (!tutor.qualification_doc) {
    return res.status(400).json({ error: 'This tutor has not uploaded a qualification document.' });
  }

  await query(
    `UPDATE tutors SET qualification_verified = $1, qualification_note = $2 WHERE id = $3`,
    [Boolean(approve), note || null, tutor.id]
  );

  await notify(
    tutor.user_id,
    approve ? 'qualification_verified' : 'qualification_rejected',
    approve ? 'Your qualification has been verified' : 'Your qualification could not be verified',
    approve
      ? 'A verified badge now appears on your profile, so students can see your degree has been checked.'
      : `${note || 'The document could not be confirmed.'} You can upload a clearer copy.`
  );

  await logActivity(
    req.user,
    approve ? 'qualification_approve' : 'qualification_reject',
    `${approve ? 'Verified' : 'Rejected'} the qualification document of ${tutor.full_name}`
  );

  res.json(await readTutor(tutor.id, req.user));
}));

// ------------------------------------------------------------
// Reports
// ------------------------------------------------------------
app.get('/api/admin/reports', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const status = ['open', 'reviewed', 'dismissed'].includes(req.query.status)
    ? req.query.status
    : 'open';

  const rows = await query(
    `SELECT r.id, r.reason, r.details, r.status, r.admin_note,
            r.created_at, r.handled_at,
            reporter.full_name AS reporter_name,
            reporter.role      AS reporter_role,
            t.id               AS tutor_id,
            tutor_user.full_name AS tutor_name,
            tutor_user.id        AS tutor_user_id,
            tutor_user.account_status,
            (SELECT COUNT(*)::int FROM reports other
              WHERE other.tutor_id = t.id) AS reports_against_tutor
       FROM reports r
       JOIN users  reporter   ON reporter.id = r.reporter_id
       JOIN tutors t          ON t.id = r.tutor_id
       JOIN users  tutor_user ON tutor_user.id = t.user_id
      WHERE r.status = $1
      ORDER BY r.created_at DESC`,
    [status]
  );

  res.json(rows);
}));

app.post('/api/admin/reports/:id/handle', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const { status, note } = req.body;

  if (!['reviewed', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Choose whether this was acted on or dismissed.' });
  }

  const report = await one(
    `SELECT r.*, u.full_name AS tutor_name
       FROM reports r
       JOIN tutors t ON t.id = r.tutor_id
       JOIN users  u ON u.id = t.user_id
      WHERE r.id = $1`,
    [req.params.id]
  );

  if (!report) {
    return res.status(404).json({ error: 'That report no longer exists.' });
  }

  await query(
    `UPDATE reports
        SET status = $1, admin_note = $2, handled_by = $3, handled_at = now()
      WHERE id = $4`,
    [status, note || null, req.user.id, report.id]
  );

  // The person who reported it hears back. A report that vanishes
  // into silence teaches people not to bother reporting.
  await notify(
    report.reporter_id,
    'report_handled',
    status === 'reviewed' ? 'Your report was acted on' : 'Your report was looked at',
    status === 'reviewed'
      ? `Thank you. An administrator has looked into what you reported about ${report.tutor_name} and taken action.`
      : `An administrator looked into your report about ${report.tutor_name} and found no action was needed.${note ? ` They noted: "${note}"` : ''}`
  );

  await logActivity(
    req.user,
    'report_handled',
    `${status === 'reviewed' ? 'Acted on' : 'Dismissed'} a report about ${report.tutor_name}`
  );

  res.json({ ok: true, status });
}));

// ------------------------------------------------------------
// Changes a tutor has asked to make
// ------------------------------------------------------------
// The tutor's live profile is untouched while this sits here.
// Accepting applies it; rejecting throws it away and tells them
// why.
// ------------------------------------------------------------
app.get('/api/admin/changes', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const rows = await query(
    `SELECT t.id AS tutor_id, t.pending_changes, t.pending_changes_at,
            t.centre_name, t.qualification,
            u.full_name, u.email
       FROM tutors t
       JOIN users u ON u.id = t.user_id
      WHERE t.pending_changes IS NOT NULL
      ORDER BY t.pending_changes_at ASC`
  );

  res.json(rows);
}));

app.post('/api/admin/tutors/:id/changes', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const { accept, note } = req.body;

  const tutor = await one(
    `SELECT t.id, t.user_id, t.pending_changes, u.full_name
       FROM tutors t JOIN users u ON u.id = t.user_id
      WHERE t.id = $1`,
    [req.params.id]
  );

  if (!tutor) return res.status(404).json({ error: 'That tutor no longer exists.' });

  if (!tutor.pending_changes) {
    return res.status(400).json({ error: 'There is nothing waiting for this tutor.' });
  }

  // Rejecting without saying why leaves the tutor with nothing to
  // act on, so a note is required.
  if (!accept && !String(note || '').trim()) {
    return res.status(400).json({ error: 'Write a reason, so the tutor knows what was wrong.' });
  }

  const change = tutor.pending_changes;
  const summary = change.summary?.lines?.join('; ') || 'their profile';

  if (accept) {
    if (change.kind === 'subjects') {
      await applySubjects(tutor.id, change.after);
    }

    await notify(
      tutor.user_id,
      'changes_accepted',
      'Your changes have been accepted',
      `An administrator approved the change to your subjects — ${summary}. It is live now.`
    );
  } else {
    await notify(
      tutor.user_id,
      'changes_rejected',
      'Your changes were not accepted',
      `${String(note).trim()} Your profile is unchanged — it still shows what it did before.`
    );
  }

  await query(
    `UPDATE tutors SET pending_changes = NULL, pending_changes_at = NULL WHERE id = $1`,
    [tutor.id]
  );

  await logActivity(
    req.user,
    accept ? 'changes_accepted' : 'changes_rejected',
    `${accept ? 'Accepted' : 'Rejected'} the changes from ${tutor.full_name} — ${summary}`
  );

  res.json({ ok: true, accepted: Boolean(accept) });
}));

// ------------------------------------------------------------
// Recording a subscription payment
// ------------------------------------------------------------
// Paid to the administrator by hand — there is no gateway. This
// records it and puts the tutor back in search.
// ------------------------------------------------------------
app.post('/api/admin/tutors/:id/subscription', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const tutor = await one(
    `SELECT t.id, t.user_id, t.subscription_paid_until, u.full_name
       FROM tutors t JOIN users u ON u.id = t.user_id
      WHERE t.id = $1`,
    [req.params.id]
  );

  if (!tutor) return res.status(404).json({ error: 'That tutor no longer exists.' });

  const until = nextPaidUntil(tutor.subscription_paid_until);

  await query(
    `UPDATE tutors SET subscription_paid_until = $1, listed = true, payment_suspended = false,
            payment_suspended_at = NULL, suspended_until = NULL WHERE id = $2`,
    [until, tutor.id]
  );

  await notify(
    tutor.user_id,
    'subscription_paid',
    'Subscription recorded',
    `Your payment has been recorded. You are listed in search until ${until}.`
  );

  await logActivity(
    req.user,
    'subscription_paid',
    `Recorded a subscription payment from ${tutor.full_name}, paid until ${until}`
  );

  res.json({ ok: true, paid_until: until });
}));

// ------------------------------------------------------------
// The activity log
// ------------------------------------------------------------
// What people actually did, newest first. Filterable by role and
// by action, because "show me everything" stops being useful once
// there are a few hundred rows.
// ------------------------------------------------------------
app.get('/api/admin/activity', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const values = [];
  const where = [];

  if (['student', 'tutor', 'admin'].includes(req.query.role)) {
    values.push(req.query.role);
    where.push(`user_role = $${values.length}`);
  }

  if (req.query.action) {
    values.push(req.query.action);
    where.push(`action = $${values.length}`);
  }

  // Capped so one enormous query cannot be used to pull the whole
  // history at once.
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  values.push(limit);

  const rows = await query(
    `SELECT id, user_id, user_name, user_role, action, detail, created_at
       FROM activity_log
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT $${values.length}`,
    values
  );

  res.json(rows);
}));

// ------------------------------------------------------------
// Who has been using the platform
// ------------------------------------------------------------
// There is no server-side session to ask, because the app uses
// stateless tokens. "Signed in right now" is therefore not a thing
// this design can answer honestly.
//
// What it CAN answer is who signed in recently, which is the
// useful question anyway.
// ------------------------------------------------------------
app.get('/api/admin/active', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const summary = await one(`
    SELECT
      (SELECT COUNT(*)::int FROM users
        WHERE last_login_at > now() - interval '15 minutes')          AS last_15_min,
      (SELECT COUNT(*)::int FROM users
        WHERE last_login_at > now() - interval '24 hours')            AS today,
      (SELECT COUNT(*)::int FROM users
        WHERE last_login_at > now() - interval '7 days')              AS this_week,
      (SELECT COUNT(*)::int FROM users WHERE last_login_at IS NULL)   AS never_signed_in
  `);

  const recent = await query(
    `SELECT id, full_name, role, email, class_level, account_status, last_login_at
       FROM users
      WHERE last_login_at IS NOT NULL
      ORDER BY last_login_at DESC
      LIMIT 40`
  );

  res.json({ ...summary, recent });
}));

// ============================================================
// START
// ============================================================

// Open this in the phone's browser to confirm it can reach the
// server before building the app.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date() });
});

// Everything added after the first release.
mountRoutes(app);

app.use((req, res) => {
  res.status(404).json({ error: 'That address does not exist.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  // A body that is not valid JSON, a file that is too big, a type
  // that is not allowed — all the caller's doing, so a 4xx.
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 400;
  res.status(status).json({ error: err.message || 'Request could not be processed.' });
});

const PORT = process.env.PORT || 5000;

// Express alone cannot carry websockets, so the HTTP server is
// created explicitly and both are attached to it.
const httpServer = createServer(app);

export { app, httpServer };

export function start(port = PORT) {
  setupSockets(httpServer);

  // The tests drive the jobs by hand, so they do not run on a timer.
  if (process.env.NODE_ENV !== 'test') {
    startJobs();
    initWhatsApp();      // only does anything when WHATSAPP_ENABLED=1
  }

  return new Promise((resolve) => {
    httpServer.listen(port, '0.0.0.0', () => {
      console.log(`API running on http://localhost:${httpServer.address().port}`);
      resolve(httpServer);
    });
  });
}

// Stops taking connections, hangs up live ones, and returns when done.
export async function stop() {
  await stopWhatsApp();
  await closeSockets();
  if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
}

// `node server.js` starts it; importing it (the tests do) does not.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start();

  // Render and Railway send SIGTERM on every deploy. Finishing
  // in-flight requests and closing cleanly beats being cut off
  // mid-write; the hard exit is only a backstop.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      console.log(`${signal} received, shutting down`);
      setTimeout(() => process.exit(1), 10000).unref();
      await stop();
      process.exit(0);
    });
  }
}
