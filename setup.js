// ============================================================
// Create the tables and add demo data
// ============================================================
//   npm run db:setup
//
// Runs schema.sql (which drops and recreates everything), then
// fills in subjects and one account per role.
// ============================================================

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query, one, pool } from './db.js';
import { MIGRATION_FILES } from './lib/migrations.js';
import { endOfMonth, todayPK } from './subscription.js';
import 'dotenv/config';

// ------------------------------------------------------------
// Placeholder CNIC images
// ------------------------------------------------------------
// The approval check refuses a tutor with no CNIC, and rightly so.
// But the demo tutors have never uploaded anything, so the admin
// screen would have nothing to look at and nothing to approve.
//
// This writes a small solid-colour PNG for each of them, using the
// same random filenames a real upload would produce. It is enough
// to see the whole flow work end to end.
// ------------------------------------------------------------
function writePlaceholderPng(colour) {
  const width = 320;
  const height = 200;

  // Raw pixels: each row starts with a filter byte, then RGB triples.
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.concat(Array(width).fill(Buffer.from(colour))),
  ]);
  const raw = Buffer.concat(Array(height).fill(row));

  function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);

    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);

    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);

    return Buffer.concat([length, body, crc]);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;    // bits per channel
  header[9] = 2;    // colour type 2 = RGB
  // bytes 10-12 stay zero: default compression, filter and interlace

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  const name = `${crypto.randomBytes(16).toString('hex')}.png`;
  const dir = path.resolve('uploads', 'docs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), png);

  return name;
}

// PNG needs a CRC on every chunk. Small enough to write out.
function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return crc ^ 0xffffffff;
}

const SUBJECT_NAMES = [
  'Mathematics', 'Physics', 'Chemistry', 'Biology', 'English',
  'Urdu', 'Computer Science', 'Islamiat', 'Pakistan Studies', 'Economics',
];

async function main() {
  console.log('Creating tables...');
  // Wipe EVERY table, not just the ones schema.sql knows about.
  // Tables added by later migrations would otherwise survive with
  // stale rows and lose their foreign keys when `users` is dropped.
  await pool.query(`
    DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;`);

  await pool.query(fs.readFileSync('./schema.sql', 'utf8'));

  // schema.sql is the original base. The migration files bring it
  // up to the current shape, so a fresh install and an upgraded
  // database end up identical.
  for (const file of MIGRATION_FILES) {
    await pool.query(fs.readFileSync(`./${file}`, 'utf8'));
  }

  console.log('Adding subjects...');
  for (const name of SUBJECT_NAMES) {
    await query('INSERT INTO subjects (subject_name) VALUES ($1)', [name]);
  }

  const subjects = await query('SELECT id, subject_name FROM subjects');
  const subjectId = (name) => subjects.find((s) => s.subject_name === name).id;

  const password = await bcrypt.hash('password123', 10);

  function addUser(role, name, email, phone, classLevel = null, modes = []) {
    return one(
      `INSERT INTO users (role, full_name, email, phone, password, class_level,
                          learning_modes, terms_accepted_at, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now() - interval '2 hours')
       RETURNING *`,
      [role, name, email, phone, password, classLevel, modes]
    );
  }

  // ---- admin ----
  await addUser('admin', 'Platform Admin', 'admin@stf.pk', '03001000000');

  // ---- students ----
  // Fatima learns online, so videos reach her. Bilal does not, so
  // his Videos tab explains how to turn it on — both halves of the
  // rule are visible without changing anything.
  await addUser('student', 'Fatima Kazmi', 'student@stf.pk', '03002000000', 10,
                ['centre', 'online']);
  await addUser('student', 'Bilal Hussain', 'student2@stf.pk', '03002000001', 9,
                ['centre']);

  // ------------------------------------------------------------
  // Three tutors, one in each state, so every screen has something
  // real to show the moment you sign in.
  // ------------------------------------------------------------
  async function addTutor(details, subjectRows, days) {
    const user = await addUser('tutor', details.name, details.email, details.phone);

    const tutor = await one(
      `INSERT INTO tutors
         (user_id, centre_name, qualification, experience_years, gender, bio,
          teaching_modes, address, latitude, longitude, verification_status,
          reject_reason, reviewed_at,
          cnic_front, cnic_back, qualification_doc, qualification_verified,
          terms_accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::varchar,$12,
               CASE WHEN $11::varchar = 'pending' THEN NULL ELSE now() END,
               $13, $14, $15, $16, now())
       RETURNING id`,
      [
        user.id, details.centre, details.qualification, details.years,
        details.gender, details.bio, details.modes, details.address,
        details.lat, details.lng, details.status, details.rejectReason || null,
        // Placeholder filenames. Real uploads land in server/uploads;
        // these just make the admin screen show the "not uploaded"
        // state honestly rather than pretending a file exists.
        writePlaceholderPng([0x0c, 0x6b, 0x65]),   // teal  = CNIC front
        writePlaceholderPng([0x0b, 0x1f, 0x2a]),   // navy  = CNIC back
        details.withDegree ? writePlaceholderPng([0x24, 0xa7, 0x9b]) : null,
        Boolean(details.degreeVerified)
      ]
    );

    for (const row of subjectRows) {
      await query(
        `INSERT INTO tutor_subjects (tutor_id, subject_id, class_from, class_to, monthly_fee)
         VALUES ($1, $2, $3, $4, $5)`,
        [tutor.id, subjectId(row.subject), row.from, row.to, row.fee]
      );
    }

    for (const day of days) {
      await query(
        `INSERT INTO tutor_availability (tutor_id, day_of_week, start_time, end_time)
         VALUES ($1, $2, $3, $4)`,
        [tutor.id, day.day, day.start, day.end]
      );
    }

    return { user, tutor };
  }

  // Approved — appears in student search straight away.
  const approved = await addTutor(
    {
      name: 'Ali Hussain', email: 'tutor@stf.pk', phone: '03003000000',
      centre: 'Al-Noor Tuition Centre', qualification: 'MSc Mathematics',
      years: 8, gender: 'male', modes: ['centre', 'online'],
      bio: 'Teaching in Skardu since 2018. Focused on board exam preparation and building strong fundamentals.',
      address: 'Alamdar Chowk, Skardu', lat: 35.2971, lng: 75.6333,
      status: 'verified',
      withDegree: true, degreeVerified: true,
    },
    [
      { subject: 'Mathematics',      from: 9,  to: 10, fee: 3000 },
      { subject: 'Physics',          from: 11, to: 12, fee: 4500 },
      { subject: 'Computer Science', from: 9,  to: 12, fee: 4000 },
    ],
    [
      { day: 1, start: '16:00', end: '19:00' },
      { day: 2, start: '16:00', end: '19:00' },
      { day: 3, start: '16:00', end: '19:00' },
      { day: 6, start: '10:00', end: '13:00' },
    ]
  );

  await query(
    `INSERT INTO notifications (user_id, type, title, message, is_read)
     VALUES ($1, 'approved', 'Your profile has been approved',
             'You are now live. Students searching for your subjects will be able to find you and see your full profile.',
             false)`,
    [approved.user.id]
  );

  // Waiting — sits in the admin queue.
  await addTutor(
    {
      name: 'Zahra Kazmi', email: 'tutor2@stf.pk', phone: '03003000001',
      centre: null, qualification: 'MSc Chemistry',
      years: 5, gender: 'female', modes: ['student_home'],
      bio: 'Home tuition for girls, Class 6 to 10. Patient with students who find science difficult.',
      address: 'Hussainabad, Skardu', lat: 35.3050, lng: 75.6410,
      status: 'pending',
      // Uploaded a degree but nobody has checked it yet, so the
      // admin has one waiting in the qualifications queue.
      withDegree: true, degreeVerified: false,
    },
    [
      { subject: 'Chemistry', from: 6, to: 10, fee: 2500 },
      { subject: 'Biology',   from: 6, to: 10, fee: 2500 },
    ],
    [
      { day: 0, start: '15:00', end: '18:00' },
      { day: 2, start: '15:00', end: '18:00' },
      { day: 4, start: '15:00', end: '18:00' },
    ]
  );

  // Rejected — can read the reason and send it back.
  const rejected = await addTutor(
    {
      name: 'Yasir Abbas', email: 'tutor3@stf.pk', phone: '03003000002',
      centre: 'Concept Study Point', qualification: 'BA',
      years: 1, gender: 'male', modes: ['online'],
      bio: 'Online classes.',
      address: 'Yadgar Chowk, Skardu', lat: 35.2895, lng: 75.6220,
      status: 'rejected',
      rejectReason: 'Your qualification does not cover the subjects you listed. Please enter the qualification that matches what you teach.',
    },
    [{ subject: 'Physics', from: 9, to: 12, fee: 3000 }],
    [{ day: 5, start: '18:00', end: '20:00' }]
  );

  await query(
    `INSERT INTO notifications (user_id, type, title, message)
     VALUES ($1, 'rejected', 'Your profile was not approved',
             'Your qualification does not cover the subjects you listed. Please enter the qualification that matches what you teach. — correct this on your profile, then send it back for review.')`,
    [rejected.user.id]
  );


  // ---- some enrollments, one in each state ----
  const studentRows = await query(
    `SELECT id, full_name FROM users WHERE role = 'student' ORDER BY created_at`
  );

  const mathsId = subjectId('Mathematics');
  const physicsId = subjectId('Physics');

  // One request can cover several subjects, so the seed shows that
  // rather than one subject per request.
  async function addEnrollment(studentId, tutorId, subjectIds, fields = {}) {
    const row = await one(
      `INSERT INTO enrollments (student_id, tutor_id, message, status, tutor_note,
                                responded_at, created_at, learning_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        studentId, tutorId,
        fields.message || null,
        fields.status || 'pending',
        fields.note || null,
        fields.respondedAt || null,
        fields.createdAt || new Date(),
        fields.mode || 'centre',
      ]
    );

    for (const subjectId of subjectIds) {
      const fee = await one(
        'SELECT monthly_fee FROM tutor_subjects WHERE tutor_id = $1 AND subject_id = $2',
        [tutorId, subjectId]
      );

      await query(
        `INSERT INTO enrollment_subjects (enrollment_id, subject_id, monthly_fee)
         VALUES ($1, $2, $3)`,
        [row.id, subjectId, fee?.monthly_fee || 0]
      );
    }

    return row;
  }

  // Accepted, and covering TWO subjects on one request — which is
  // the case the single-subject model could not express.
  const acceptedEnrollment = await addEnrollment(
    studentRows[0].id, approved.tutor.id, [mathsId, physicsId],
    {
      message: 'I am in Class 10 and struggling with trigonometry, and Physics is not much better. Free most evenings after 5.',
      status: 'accepted',
      note: 'Come Monday and Wednesday at 5. The centre is beside Alamdar Chowk.',
      respondedAt: new Date(Date.now() - 4 * 86400000),
      createdAt: new Date(Date.now() - 5 * 86400000),
      mode: 'online',          // so this student really does get videos, as the summary says
    }
  );

  // Waiting: this is what the tutor sees on their Requests tab.
  await addEnrollment(
    studentRows[1].id, approved.tutor.id, [subjectId('Computer Science')],
    {
      message: 'Class 9 Computer Science. I can come to the centre on weekends.',
      createdAt: new Date(Date.now() - 6 * 3600000),
    }
  );

  await query(
    `INSERT INTO notifications (user_id, type, title, message)
     VALUES ($1, 'enrollment_request', 'New enrollment request', $2)`,
    [approved.user.id,
     `${studentRows[1].full_name} would like to enroll for Physics. Open your requests to accept or decline.`]
  );

  // ---- a finished enrollment, so reviewing is possible ----
  // Reviews need a COMPLETED enrollment, so the seeded reviews
  // would be impossible without this.
  // Reviews open once a tutor ACCEPTS, so the accepted request
  // above is already enough. This just shows the finished state.
  const finished = acceptedEnrollment;

  // ---- a couple of reviews on the approved tutor ----
  const students = await query(`SELECT id FROM users WHERE role = 'student' ORDER BY created_at`);

  await query(
    `INSERT INTO reviews (tutor_id, student_id, enrollment_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5)`,
    [approved.tutor.id, students[0].id, finished?.id || null, 5,
     'Explained every step clearly and never made me feel slow for asking twice. My marks went up within two months.']
  );

  await query(
    `INSERT INTO reviews (tutor_id, student_id, enrollment_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5)`,
    [approved.tutor.id, students[1].id, null, 4,
     'Very good with the difficult topics. Sometimes reschedules on short notice.']
  );

  // ---- an open report, so the admin queue is not empty ----
  // A report has to hang off a real enrollment now — you cannot
  // complain about somebody you never dealt with. So the seed
  // creates the dealing first.
  // A report has to hang off a real dealing, and a student can
  // only have one live request per tutor — so this one is with the
  // rejected tutor, who they dealt with earlier.
  const reportedEnrollment = await addEnrollment(
    studentRows[1].id, rejected.tutor.id, [subjectId('Physics')],
    {
      status: 'completed',
      note: 'Saturdays at 6.',
      respondedAt: new Date(Date.now() - 9 * 86400000),
      createdAt: new Date(Date.now() - 10 * 86400000),
    }
  );

  await query(
    `INSERT INTO reports (reporter_id, tutor_id, enrollment_id, reason, details, created_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '8 hours')`,
    [studentRows[1].id, rejected.tutor.id, reportedEnrollment.id,
     'Did not turn up',
     'We agreed Saturday mornings but nobody was at the centre two weeks running.']
  );

  // ---- a little history, so the activity screen is not empty ----
  const everyone = await query('SELECT id, full_name, role FROM users ORDER BY created_at');

  for (const person of everyone) {
    await query(
      `INSERT INTO activity_log (user_id, user_name, user_role, action, detail, created_at)
       VALUES ($1, $2, $3, 'register', $4, now() - interval '3 days')`,
      [person.id, person.full_name, person.role,
       person.role === 'tutor' ? 'Registered as a tutor, awaiting approval' :
       person.role === 'student' ? 'Registered as a student' : 'Administrator account created']
    );

    await query(
      `INSERT INTO activity_log (user_id, user_name, user_role, action, detail, created_at)
       VALUES ($1, $2, $3, 'login', 'Signed in', now() - interval '2 hours')`,
      [person.id, person.full_name, person.role]
    );
  }

  const admin = everyone.find((p) => p.role === 'admin');

  await query(
    `INSERT INTO activity_log (user_id, user_name, user_role, action, detail, created_at)
     VALUES ($1, $2, 'admin', 'approve', $3, now() - interval '2 days')`,
    [admin.id, admin.full_name, 'Approved Ali Hussain, who is now visible to students']
  );

  await query(
    `INSERT INTO activity_log (user_id, user_name, user_role, action, detail, created_at)
     VALUES ($1, $2, 'admin', 'reject', $3, now() - interval '1 day')`,
    [admin.id, admin.full_name,
     'Rejected Yasir Abbas — Your qualification does not cover the subjects you listed.']
  );

  await query(
    `INSERT INTO activity_log (user_id, user_name, user_role, action, detail, created_at)
     VALUES ($1, $2, 'student', 'enroll_request', $3, now() - interval '5 days')`,
    [studentRows[0].id, studentRows[0].full_name, 'Asked Ali Hussain to enroll for Mathematics']
  );

  await query(
    `INSERT INTO activity_log (user_id, user_name, user_role, action, detail, created_at)
     VALUES ($1, $2, 'tutor', 'enroll_accept', $3, now() - interval '4 days')`,
    [approved.user.id, 'Ali Hussain',
     `Accepted ${studentRows[0].full_name} for Mathematics`]
  );

  // ---- a conversation, so the chat screen is not empty ----
  async function addMessage(sender, body, minutesAgo) {
    await query(
      `INSERT INTO messages (tutor_id, student_id, sender, body, read_at, created_at)
       VALUES ($1, $2, $3, $4, $5, now() - ($6 || ' minutes')::interval)`,
      [
        approved.tutor.id, studentRows[0].id, sender, body,
        // The tutor's last message is left unread, so the badge on
        // the student's Messages tab shows something.
        sender === 'tutor' && minutesAgo < 60 ? null : new Date(),
        String(minutesAgo),
      ]
    );
  }

  await addMessage('student', 'Assalam o alaikum sir. Is the Monday class at 5 or 5:30?', 2880);
  await addMessage('tutor',   'Wa alaikum assalam. 5 sharp. Bring your logarithm notes.', 2820);
  await addMessage('student', 'Ok sir, jazakAllah.', 2800);
  await addMessage('tutor',   'Also revise chapter 4 before Wednesday.', 30);

  // ---- an announcement ----
  const announcement = await one(
    `INSERT INTO announcements (tutor_id, body, created_at)
     VALUES ($1, $2, now() - interval '3 hours')
     RETURNING id`,
    [approved.tutor.id,
     'No class this Friday — it is a public holiday. We resume Monday at the usual time. Please finish the exercises on page 84 before then.']
  );

  await query(
    `INSERT INTO notifications (user_id, type, title, message)
     VALUES ($1, 'announcement', 'Announcement from Ali Hussain', $2)`,
    [studentRows[0].id, 'No class this Friday — it is a public holiday. We resume Monday...']
  );

  // ---- videos, released over three days ----
  // Shows the drip: one already out, one today, one tomorrow.
  async function addVideo(subject, title, url, description, mins, releaseOffset) {
    const video = await one(
      `INSERT INTO videos (tutor_id, subject_id, title, description, url,
                           class_from, class_to, duration_mins)
       VALUES ($1, $2, $3, $4, $5, 9, 10, $6)
       RETURNING id`,
      [approved.tutor.id, subjectId(subject), title, description, url, mins]
    );

    await query(
      `INSERT INTO video_releases (video_id, student_id, release_on, watched_at)
       VALUES ($1, $2, CURRENT_DATE + $3::int, $4)`,
      [
        video.id, studentRows[0].id, releaseOffset,
        // The oldest one is already watched, so the schedule screen
        // shows both states.
        releaseOffset < -1 ? new Date() : null,
      ]
    );

    return video;
  }

  await addVideo('Mathematics', 'Trigonometry — introduction',
    'https://www.youtube.com/watch?v=example1',
    'Sine, cosine and tangent, with the unit circle. Watch before Monday.', 24, -2);

  await addVideo('Mathematics', 'Trigonometry — solving triangles',
    'https://www.youtube.com/watch?v=example2',
    'Worked examples from the exercise on page 84.', 31, 0);

  await addVideo('Physics', 'Newton\u2019s second law',
    'https://www.youtube.com/watch?v=example3',
    'F = ma, with the trolley experiment.', 18, 1);

  // ---- subscriptions ----
  // The approved tutor is paid up to the end of this month. To see
  // the reminder and automatic-suspension screens, set
  // subscription_paid_until to last month's end in the database.
  await query(
    `UPDATE tutors SET subscription_paid_until = $2 WHERE id = $1`,
    [approved.tutor.id, endOfMonth(todayPK())]
  );

  console.log(`
Done. The password for every account is password123.

  Admin     admin@stf.pk       1 tutor waiting for approval
  Student   student@stf.pk     learns online — has videos and a chat
  Student   student2@stf.pk    not online — sees why the Videos tab is empty
  Tutor     tutor@stf.pk       approved, 3 subjects at different fees
  Tutor     tutor2@stf.pk      waiting for approval
  Tutor     tutor3@stf.pk      rejected, with a reason

  tutor@stf.pk has 1 enrollment waiting and 1 already accepted,
  a conversation with Fatima, and one announcement sent.
`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
