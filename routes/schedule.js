// ============================================================
// Class schedule, reminders and attendance
// ============================================================
//   Tutor: create / reschedule / cancel a class, see attendance,
//          mark a student present.
//   Student: see classes, check in, check out.
//   Scheduler: a reminder 30 minutes before each class.
//
// Attendance is check-in and check-out TIMES, so "time attended"
// is real. A student can check in from 15 minutes before the start
// until the class ends, and check out until an hour after.
// ============================================================
import { Router } from 'express';
import crypto from 'crypto';
import { query, one } from '../db.js';
import { requireLogin, requireRole, handle, logActivity, notify } from '../helpers.js';
import { isUuid, tutorOf, onlyMyStudents, enrolledStudentIds, teachesSubject, parseDate } from '../lib/common.js';

export const router = Router();

const MODES = ['centre', 'student_home', 'online'];

// An online class needs somewhere to meet. When the tutor does not paste
// a Zoom / Meet link, a free Jitsi room is created: no account, no app
// to install for the student (it opens in the browser), and the random
// name makes it unguessable, so only people given the link can join.
export const jitsiLink = () => `https://meet.jit.si/STF-${crypto.randomBytes(9).toString('hex')}`;
export const CHECKIN_EARLY_MS = 15 * 60 * 1000;
export const CHECKOUT_LATE_MS = 60 * 60 * 1000;
export const REMINDER_MINUTES = 30;

const when = (d) => new Date(d).toLocaleString('en-PK', {
  weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  timeZone: 'Asia/Karachi',
});

function checkClass(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.title !== undefined) {
    const title = String(body.title || '').trim();
    if (!title) return { error: 'Give the class a title.' };
    if (title.length > 160) return { error: 'That title is too long.' };
    out.title = title;
  }
  if (!partial || body.starts_at !== undefined || body.ends_at !== undefined) {
    const s = parseDate(body.starts_at), e = parseDate(body.ends_at);
    if (!s || !e) return { error: 'Choose the date, start time and end time.' };
    if (e <= s) return { error: 'The class must end after it starts.' };
    if ((e - s) > 12 * 3600 * 1000) return { error: 'A class cannot be longer than 12 hours.' };
    out.starts_at = s; out.ends_at = e;
  }
  if (!partial || body.mode !== undefined) {
    if (!MODES.includes(body.mode)) return { error: 'Choose where the class is held.' };
    out.mode = body.mode;
    if (body.mode === 'online' && body.meeting_link) {
      if (!/^https?:\/\/\S+$/i.test(String(body.meeting_link).trim())) return { error: 'The meeting link must start with http:// or https://' };
    }
  }
  out.location = String(body.location || '').trim().slice(0, 300) || null;
  out.meeting_link = String(body.meeting_link || '').trim().slice(0, 500) || null;
  return { value: out };
}

async function myClass(userId, classId) {
  if (!isUuid(classId)) return null;
  const tutor = await tutorOf(userId);
  if (!tutor) return null;
  return one(
    `SELECT c.*, s.subject_name FROM class_sessions c JOIN subjects s ON s.id = c.subject_id
      WHERE c.id = $1 AND c.tutor_id = $2`, [classId, tutor.id]);
}

async function invited(classId) {
  return (await query('SELECT student_id FROM class_session_students WHERE session_id = $1', [classId])).map((r) => r.student_id);
}

// ------------------------------------------------------------
// Tutor
// ------------------------------------------------------------
router.post('/api/tutor/classes', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await tutorOf(req.user.id);
  if (!tutor) return res.status(404).json({ error: 'Profile not found.' });

  const checked = checkClass(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const c = checked.value;

  if (c.starts_at < new Date(Date.now() - 60000)) return res.status(400).json({ error: 'Choose a time that has not passed yet.' });
  if (c.mode === 'online' && !c.meeting_link) c.meeting_link = jitsiLink();
  if (!(await teachesSubject(tutor.id, req.body.subject_id))) return res.status(400).json({ error: 'Choose a subject you teach.' });

  // No student list means "everybody I teach".
  const wanted = Array.isArray(req.body.student_ids) && req.body.student_ids.length
    ? await onlyMyStudents(tutor.id, req.body.student_ids)
    : await enrolledStudentIds(tutor.id);
  if (wanted.length === 0) return res.status(400).json({ error: 'You have no enrolled students to invite yet.' });

  const row = await one(
    `INSERT INTO class_sessions (tutor_id, subject_id, title, starts_at, ends_at, mode, location, meeting_link)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [tutor.id, Number(req.body.subject_id), c.title, c.starts_at, c.ends_at, c.mode, c.location, c.meeting_link]);

  for (const sid of wanted) {
    await query('INSERT INTO class_session_students (session_id, student_id) VALUES ($1,$2)', [row.id, sid]);
    await notify(sid, 'class_scheduled', 'New class scheduled',
      `${c.title} — ${when(c.starts_at)} (${req.user.full_name})`, { class_id: row.id });
  }
  await logActivity(req.user, 'class_scheduled', `Scheduled "${c.title}" for ${when(c.starts_at)}`, req.ip);
  res.status(201).json({ id: row.id, invited: wanted.length });
}));

router.get('/api/tutor/classes', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await tutorOf(req.user.id);
  if (!tutor) return res.json([]);
  const past = req.query.when === 'past';
  res.json(await query(
    `SELECT c.id, c.title, c.starts_at, c.ends_at, c.mode, c.location, c.meeting_link, c.status,
            c.cancel_reason, s.subject_name,
            (SELECT COUNT(*)::int FROM class_session_students x WHERE x.session_id = c.id) AS invited,
            (SELECT COUNT(*)::int FROM attendance a WHERE a.session_id = c.id) AS present
       FROM class_sessions c JOIN subjects s ON s.id = c.subject_id
      WHERE c.tutor_id = $1 AND ${past ? 'c.ends_at < now()' : 'c.ends_at >= now()'}
      ORDER BY c.starts_at ${past ? 'DESC' : 'ASC'} LIMIT 100`, [tutor.id]));
}));

router.patch('/api/tutor/classes/:id', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const cls = await myClass(req.user.id, req.params.id);
  if (!cls) return res.status(404).json({ error: 'That class does not exist.' });
  if (cls.status === 'cancelled') return res.status(400).json({ error: 'A cancelled class cannot be changed.' });
  if (new Date(cls.ends_at) < new Date()) return res.status(400).json({ error: 'That class is already over.' });

  const merged = { title: cls.title, starts_at: cls.starts_at, ends_at: cls.ends_at, mode: cls.mode,
    location: cls.location, meeting_link: cls.meeting_link, ...req.body };
  const checked = checkClass(merged);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const c = checked.value;
  if (c.starts_at < new Date(Date.now() - 60000)) return res.status(400).json({ error: 'Choose a time that has not passed yet.' });
  if (c.mode === 'online' && !c.meeting_link) c.meeting_link = jitsiLink();

  const moved = c.starts_at.getTime() !== new Date(cls.starts_at).getTime() || c.ends_at.getTime() !== new Date(cls.ends_at).getTime();

  await query(
    `UPDATE class_sessions SET title=$2, starts_at=$3, ends_at=$4, mode=$5, location=$6, meeting_link=$7,
            updated_at = now(), reminder_sent_at = CASE WHEN $8 THEN NULL ELSE reminder_sent_at END
      WHERE id = $1`,
    [cls.id, c.title, c.starts_at, c.ends_at, c.mode, c.location, c.meeting_link, moved]);

  if (moved) {
    for (const sid of await invited(cls.id)) {
      await notify(sid, 'class_rescheduled', 'Class rescheduled',
        `${c.title} is now ${when(c.starts_at)}.`, { class_id: cls.id });
    }
    await logActivity(req.user, 'class_rescheduled', `Rescheduled "${c.title}" to ${when(c.starts_at)}`, req.ip);
  }
  res.json({ ok: true, rescheduled: moved });
}));

router.post('/api/tutor/classes/:id/cancel', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const cls = await myClass(req.user.id, req.params.id);
  if (!cls) return res.status(404).json({ error: 'That class does not exist.' });
  if (cls.status === 'cancelled') return res.status(400).json({ error: 'That class is already cancelled.' });
  const reason = String(req.body.reason || '').trim().slice(0, 300) || null;

  await query(`UPDATE class_sessions SET status='cancelled', cancel_reason=$2, updated_at=now() WHERE id=$1`, [cls.id, reason]);
  for (const sid of await invited(cls.id)) {
    await notify(sid, 'class_cancelled', 'Class cancelled',
      `${cls.title} on ${when(cls.starts_at)} is cancelled.${reason ? ` Reason: ${reason}` : ''}`, { class_id: cls.id });
  }
  await logActivity(req.user, 'class_cancelled', `Cancelled "${cls.title}"`, req.ip);
  res.json({ ok: true });
}));

router.get('/api/tutor/classes/:id/attendance', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const cls = await myClass(req.user.id, req.params.id);
  if (!cls) return res.status(404).json({ error: 'That class does not exist.' });
  const students = await query(
    `SELECT u.id AS student_id, u.full_name, u.avatar, a.check_in_at, a.check_out_at, a.marked_by,
            CASE WHEN a.check_in_at IS NULL THEN NULL
                 ELSE ROUND(EXTRACT(EPOCH FROM (COALESCE(a.check_out_at, LEAST(now(), $2)) - a.check_in_at)) / 60)::int
            END AS minutes
       FROM class_session_students x
       JOIN users u ON u.id = x.student_id
       LEFT JOIN attendance a ON a.session_id = x.session_id AND a.student_id = x.student_id
      WHERE x.session_id = $1 ORDER BY u.full_name`, [cls.id, cls.ends_at]);
  res.json({ class: cls, students });
}));

// The tutor can mark somebody present (phone dead, forgot to tap).
router.post('/api/tutor/classes/:id/attendance', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const cls = await myClass(req.user.id, req.params.id);
  if (!cls) return res.status(404).json({ error: 'That class does not exist.' });
  if (cls.status === 'cancelled') return res.status(400).json({ error: 'That class was cancelled.' });
  if (new Date(cls.starts_at) > new Date(Date.now() + CHECKIN_EARLY_MS)) return res.status(400).json({ error: 'The class has not started yet.' });
  if (!(await invited(cls.id)).includes(req.body.student_id)) return res.status(400).json({ error: 'That student is not in this class.' });

  const start = new Date(Math.max(new Date(cls.starts_at), Date.now() < new Date(cls.starts_at) ? new Date(cls.starts_at) : 0));
  const end = new Date(Math.min(new Date(cls.ends_at), Date.now()));
  await query(
    `INSERT INTO attendance (session_id, student_id, check_in_at, check_out_at, marked_by)
     VALUES ($1,$2,$3,$4,'tutor')
     ON CONFLICT (session_id, student_id) DO NOTHING`,
    [cls.id, req.body.student_id, start, end >= start ? end : start]);
  await logActivity(req.user, 'attendance_marked', `Marked a student present in "${cls.title}"`, req.ip);
  res.json({ ok: true });
}));

// ------------------------------------------------------------
// Student
// ------------------------------------------------------------
router.get('/api/classes', requireLogin, requireRole('student'), handle(async (req, res) => {
  const past = req.query.when === 'past';
  res.json(await query(
    `SELECT c.id, c.title, c.starts_at, c.ends_at, c.mode, c.location, c.status, c.cancel_reason,
            CASE WHEN c.mode = 'online' THEN c.meeting_link END AS meeting_link,
            s.subject_name, u.full_name AS tutor_name,
            a.check_in_at, a.check_out_at
       FROM class_session_students x
       JOIN class_sessions c ON c.id = x.session_id
       JOIN subjects s ON s.id = c.subject_id
       JOIN tutors t ON t.id = c.tutor_id
       JOIN users u ON u.id = t.user_id
       LEFT JOIN attendance a ON a.session_id = c.id AND a.student_id = x.student_id
      WHERE x.student_id = $1 AND ${past ? 'c.ends_at < now()' : 'c.ends_at >= now()'}
      ORDER BY c.starts_at ${past ? 'DESC' : 'ASC'} LIMIT 100`, [req.user.id]));
}));

async function myInvite(studentId, classId) {
  if (!isUuid(classId)) return null;
  return one(
    `SELECT c.* FROM class_session_students x JOIN class_sessions c ON c.id = x.session_id
      WHERE x.session_id = $1 AND x.student_id = $2`, [classId, studentId]);
}

// ONE tap for an online class: opens the room AND records attendance.
// (Check-in opens 15 minutes before the start, like the in-person one.)
router.post('/api/classes/:id/join', requireLogin, requireRole('student'), handle(async (req, res) => {
  const cls = await myInvite(req.user.id, req.params.id);
  if (!cls) return res.status(404).json({ error: 'That class is not in your schedule.' });
  if (cls.status === 'cancelled') return res.status(400).json({ error: 'That class was cancelled.' });
  if (cls.mode !== 'online' || !cls.meeting_link) return res.status(400).json({ error: 'This class is not online.' });

  const now = Date.now();
  if (now < new Date(cls.starts_at).getTime() - CHECKIN_EARLY_MS) return res.status(400).json({ error: 'The class room opens 15 minutes before it starts.' });
  if (now > new Date(cls.ends_at).getTime()) return res.status(400).json({ error: 'This class is over.' });

  const row = await one(
    `INSERT INTO attendance (session_id, student_id, check_in_at) VALUES ($1,$2,now())
     ON CONFLICT (session_id, student_id) DO NOTHING RETURNING check_in_at`, [cls.id, req.user.id]);
  if (row) await logActivity(req.user, 'attendance_check_in', `Joined "${cls.title}" online`, req.ip);

  res.json({ ok: true, meeting_link: cls.meeting_link, checked_in: Boolean(row) });
}));

router.post('/api/classes/:id/check-in', requireLogin, requireRole('student'), handle(async (req, res) => {
  const cls = await myInvite(req.user.id, req.params.id);
  if (!cls) return res.status(404).json({ error: 'That class is not in your schedule.' });
  if (cls.status === 'cancelled') return res.status(400).json({ error: 'That class was cancelled.' });

  const now = Date.now();
  if (now < new Date(cls.starts_at).getTime() - CHECKIN_EARLY_MS) return res.status(400).json({ error: 'Check-in opens 15 minutes before the class.' });
  if (now > new Date(cls.ends_at).getTime()) return res.status(400).json({ error: 'This class is over.' });

  const row = await one(
    `INSERT INTO attendance (session_id, student_id, check_in_at) VALUES ($1,$2,now())
     ON CONFLICT (session_id, student_id) DO NOTHING RETURNING check_in_at`, [cls.id, req.user.id]);
  if (!row) return res.status(409).json({ error: 'You have already checked in.' });
  await logActivity(req.user, 'attendance_check_in', `Checked in to "${cls.title}"`, req.ip);
  res.json({ ok: true, check_in_at: row.check_in_at });
}));

router.post('/api/classes/:id/check-out', requireLogin, requireRole('student'), handle(async (req, res) => {
  const cls = await myInvite(req.user.id, req.params.id);
  if (!cls) return res.status(404).json({ error: 'That class is not in your schedule.' });

  const row = await one(
    `UPDATE attendance SET check_out_at = now()
      WHERE session_id = $1 AND student_id = $2 AND check_out_at IS NULL
        AND now() <= $3
      RETURNING check_in_at, check_out_at`,
    [cls.id, req.user.id, new Date(new Date(cls.ends_at).getTime() + CHECKOUT_LATE_MS)]);
  if (!row) {
    const has = await one('SELECT check_out_at FROM attendance WHERE session_id=$1 AND student_id=$2', [cls.id, req.user.id]);
    if (!has) return res.status(400).json({ error: 'Check in first.' });
    if (has.check_out_at) return res.status(409).json({ error: 'You have already checked out.' });
    return res.status(400).json({ error: 'Check-out time has passed. Ask your tutor to correct it.' });
  }
  await logActivity(req.user, 'attendance_check_out', `Checked out of "${cls.title}"`, req.ip);
  res.json({ ok: true, ...row });
}));

// ------------------------------------------------------------
// Scheduler: "your class starts in 30 minutes"
// ------------------------------------------------------------
// The claim (UPDATE ... RETURNING) happens first, so two server
// instances running at once cannot both send the same reminder.
// ------------------------------------------------------------
export async function sendClassReminders() {
  const due = await query(
    `UPDATE class_sessions SET reminder_sent_at = now()
      WHERE status = 'scheduled' AND reminder_sent_at IS NULL
        AND starts_at > now() AND starts_at <= now() + make_interval(mins => $1)
      RETURNING id, title, starts_at`, [REMINDER_MINUTES]);
  let sent = 0;
  for (const c of due) {
    for (const sid of await invited(c.id)) {
      await notify(sid, 'class_reminder', 'Class starting soon',
        `${c.title} starts at ${new Date(c.starts_at).toLocaleTimeString('en-PK', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Karachi' })}.`,
        { class_id: c.id });
      sent += 1;
    }
  }
  return sent;
}
