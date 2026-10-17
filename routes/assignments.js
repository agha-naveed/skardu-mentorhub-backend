// ============================================================
// Assignments
// ============================================================
//   Tutor creates (description, attachment, deadline) -> students
//   submit online before the deadline -> tutor marks and writes
//   feedback -> student sees marks and feedback.
//
// Late work: each assignment says whether late submissions are
// BLOCKED (default) or accepted and FLAGGED late.
// ============================================================
import { Router } from 'express';
import { query, one } from '../db.js';
import { requireLogin, requireRole, handle, logActivity, notify } from '../helpers.js';
import { isUuid, tutorOf, onlyMyStudents, enrolledStudentIds, teachesSubject, parseDate } from '../lib/common.js';
import { uploadAssignmentFile, uploadChatImage, mediaLimit, mediaUrlFor, safeMediaPath } from '../lib/media.js';

export const router = Router();
export const DEADLINE_REMINDER_HOURS = 24;

const MEDIA_URL = /^\/api\/media\/[a-f0-9]{32}\.(jpg|png|webp|pdf|doc|docx|txt)$/;
const fmt = (d) => new Date(d).toLocaleString('en-PK', {
  weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Karachi',
});

// ------------------------------------------------------------
// Files: upload (any signed-in person) and read back
// ------------------------------------------------------------
router.post('/api/media/upload', requireLogin, mediaLimit, (req, res, next) => {
  uploadAssignmentFile.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too big (8 MB at most).' : err.message });
    if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
    res.status(201).json({ url: mediaUrlFor(req.file), name: String(req.file.originalname || 'file').slice(0, 160) });
  });
});

router.get('/api/media/:name', (req, res) => {
  const full = safeMediaPath(req.params.name);
  if (!full) return res.status(404).json({ error: 'No such file.' });
  res.set('Cache-Control', 'private, max-age=86400');
  res.set('Content-Disposition', 'inline');
  res.sendFile(full);
});

// ------------------------------------------------------------
// Tutor
// ------------------------------------------------------------
router.post('/api/tutor/assignments', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await tutorOf(req.user.id);
  if (!tutor) return res.status(404).json({ error: 'Profile not found.' });

  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Give the assignment a title.' });
  if (title.length > 160) return res.status(400).json({ error: 'That title is too long.' });
  const description = String(req.body.description || '').trim().slice(0, 5000) || null;

  const due = parseDate(req.body.due_at);
  if (!due) return res.status(400).json({ error: 'Choose a deadline.' });
  if (due <= new Date()) return res.status(400).json({ error: 'The deadline must be in the future.' });

  const maxMarks = req.body.max_marks == null || req.body.max_marks === '' ? 100 : Number(req.body.max_marks);
  if (!Number.isInteger(maxMarks) || maxMarks < 1 || maxMarks > 1000) return res.status(400).json({ error: 'Total marks must be a whole number from 1 to 1000.' });

  if (!(await teachesSubject(tutor.id, req.body.subject_id))) return res.status(400).json({ error: 'Choose a subject you teach.' });

  let attachmentUrl = null, attachmentName = null;
  if (req.body.attachment_url) {
    if (!MEDIA_URL.test(req.body.attachment_url)) return res.status(400).json({ error: 'That attachment is not valid. Upload it again.' });
    attachmentUrl = req.body.attachment_url;
    attachmentName = String(req.body.attachment_name || 'Attachment').slice(0, 160);
  }

  const wanted = Array.isArray(req.body.student_ids) && req.body.student_ids.length
    ? await onlyMyStudents(tutor.id, req.body.student_ids)
    : await enrolledStudentIds(tutor.id);
  if (wanted.length === 0) return res.status(400).json({ error: 'You have no enrolled students to give this to yet.' });

  const row = await one(
    `INSERT INTO assignments (tutor_id, subject_id, title, description, attachment_url, attachment_name, due_at, max_marks, allow_late)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [tutor.id, Number(req.body.subject_id), title, description, attachmentUrl, attachmentName, due, maxMarks, Boolean(req.body.allow_late)]);

  for (const sid of wanted) {
    await query('INSERT INTO assignment_students (assignment_id, student_id) VALUES ($1,$2)', [row.id, sid]);
    await notify(sid, 'assignment_new', 'New assignment',
      `${title} — due ${fmt(due)}`, { assignment_id: row.id });
  }
  await logActivity(req.user, 'assignment_created', `Created the assignment "${title}"`, req.ip);
  res.status(201).json({ id: row.id, assigned: wanted.length });
}));

router.get('/api/tutor/assignments', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await tutorOf(req.user.id);
  if (!tutor) return res.json([]);
  res.json(await query(
    `SELECT a.id, a.title, a.due_at, a.max_marks, a.allow_late, s.subject_name,
            (SELECT COUNT(*)::int FROM assignment_students x WHERE x.assignment_id = a.id) AS assigned,
            (SELECT COUNT(*)::int FROM assignment_submissions b WHERE b.assignment_id = a.id) AS submitted,
            (SELECT COUNT(*)::int FROM assignment_submissions b WHERE b.assignment_id = a.id AND b.marks IS NOT NULL) AS marked
       FROM assignments a JOIN subjects s ON s.id = a.subject_id
      WHERE a.tutor_id = $1 ORDER BY a.due_at DESC LIMIT 100`, [tutor.id]));
}));

router.get('/api/tutor/assignments/:id', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await tutorOf(req.user.id);
  if (!tutor || !isUuid(req.params.id)) return res.status(404).json({ error: 'That assignment does not exist.' });
  const a = await one(
    `SELECT a.*, s.subject_name FROM assignments a JOIN subjects s ON s.id = a.subject_id
      WHERE a.id = $1 AND a.tutor_id = $2`, [req.params.id, tutor.id]);
  if (!a) return res.status(404).json({ error: 'That assignment does not exist.' });

  const students = await query(
    `SELECT u.id AS student_id, u.full_name, u.avatar,
            b.id AS submission_id, b.answer_text, b.file_url, b.file_name, b.submitted_at, b.is_late,
            b.marks, b.feedback, b.marked_at
       FROM assignment_students x
       JOIN users u ON u.id = x.student_id
       LEFT JOIN assignment_submissions b ON b.assignment_id = x.assignment_id AND b.student_id = x.student_id
      WHERE x.assignment_id = $1 ORDER BY b.submitted_at NULLS LAST, u.full_name`, [a.id]);
  res.json({ assignment: a, students });
}));

router.post('/api/tutor/assignments/:id/mark', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await tutorOf(req.user.id);
  if (!tutor || !isUuid(req.params.id)) return res.status(404).json({ error: 'That assignment does not exist.' });
  const a = await one('SELECT id, title, max_marks FROM assignments WHERE id = $1 AND tutor_id = $2', [req.params.id, tutor.id]);
  if (!a) return res.status(404).json({ error: 'That assignment does not exist.' });

  const marks = Number(req.body.marks);
  if (req.body.marks === '' || req.body.marks == null || !Number.isInteger(marks) || marks < 0 || marks > a.max_marks) {
    return res.status(400).json({ error: `Marks must be a whole number from 0 to ${a.max_marks}.` });
  }
  const feedback = String(req.body.feedback || '').trim().slice(0, 3000) || null;

  const row = await one(
    `UPDATE assignment_submissions SET marks = $3, feedback = $4, marked_at = now()
      WHERE assignment_id = $1 AND student_id = $2 RETURNING student_id`,
    [a.id, req.body.student_id, marks, feedback]);
  if (!row) return res.status(404).json({ error: 'That student has not submitted yet.' });

  await notify(row.student_id, 'assignment_marked', 'Your assignment was marked',
    `${a.title}: ${marks}/${a.max_marks}${feedback ? ' — feedback added' : ''}`, { assignment_id: a.id });
  await logActivity(req.user, 'assignment_marked', `Marked "${a.title}" (${marks}/${a.max_marks})`, req.ip);
  res.json({ ok: true });
}));

// ------------------------------------------------------------
// Student
// ------------------------------------------------------------
router.get('/api/assignments', requireLogin, requireRole('student'), handle(async (req, res) => {
  res.json(await query(
    `SELECT a.id, a.title, a.due_at, a.max_marks, a.allow_late, s.subject_name, u.full_name AS tutor_name,
            b.submitted_at, b.is_late, b.marks, b.feedback, b.marked_at,
            CASE WHEN b.id IS NOT NULL THEN CASE WHEN b.marks IS NOT NULL THEN 'marked' ELSE 'submitted' END
                 WHEN a.due_at < now() THEN CASE WHEN a.allow_late THEN 'late_open' ELSE 'missed' END
                 ELSE 'open' END AS status
       FROM assignment_students x
       JOIN assignments a ON a.id = x.assignment_id
       JOIN subjects s ON s.id = a.subject_id
       JOIN tutors t ON t.id = a.tutor_id
       JOIN users u ON u.id = t.user_id
       LEFT JOIN assignment_submissions b ON b.assignment_id = a.id AND b.student_id = x.student_id
      WHERE x.student_id = $1 ORDER BY a.due_at DESC LIMIT 100`, [req.user.id]));
}));

router.get('/api/assignments/:id', requireLogin, requireRole('student'), handle(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'That assignment is not yours.' });
  const a = await one(
    `SELECT a.id, a.title, a.description, a.attachment_url, a.attachment_name, a.due_at, a.max_marks, a.allow_late,
            s.subject_name, u.full_name AS tutor_name
       FROM assignment_students x JOIN assignments a ON a.id = x.assignment_id
       JOIN subjects s ON s.id = a.subject_id JOIN tutors t ON t.id = a.tutor_id JOIN users u ON u.id = t.user_id
      WHERE x.assignment_id = $1 AND x.student_id = $2`, [req.params.id, req.user.id]);
  if (!a) return res.status(404).json({ error: 'That assignment is not yours.' });
  const mine = await one(
    `SELECT answer_text, file_url, file_name, submitted_at, is_late, marks, feedback, marked_at
       FROM assignment_submissions WHERE assignment_id = $1 AND student_id = $2`, [a.id, req.user.id]);
  res.json({ ...a, submission: mine });
}));

router.post('/api/assignments/:id/submit', requireLogin, requireRole('student'), handle(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'That assignment is not yours.' });
  const a = await one(
    `SELECT a.id, a.title, a.due_at, a.allow_late, t.user_id AS tutor_user_id
       FROM assignment_students x JOIN assignments a ON a.id = x.assignment_id JOIN tutors t ON t.id = a.tutor_id
      WHERE x.assignment_id = $1 AND x.student_id = $2`, [req.params.id, req.user.id]);
  if (!a) return res.status(404).json({ error: 'That assignment is not yours.' });

  const text = String(req.body.answer_text || '').trim().slice(0, 10000) || null;
  let fileUrl = null, fileName = null;
  if (req.body.file_url) {
    if (!MEDIA_URL.test(req.body.file_url)) return res.status(400).json({ error: 'That file is not valid. Upload it again.' });
    fileUrl = req.body.file_url;
    fileName = String(req.body.file_name || 'File').slice(0, 160);
  }
  if (!text && !fileUrl) return res.status(400).json({ error: 'Write your answer or attach a file.' });

  // The deadline is checked by the SERVER clock, not the phone's.
  const late = Date.now() > new Date(a.due_at).getTime();
  if (late && !a.allow_late) {
    return res.status(403).json({ error: 'The deadline has passed, so this assignment can no longer be submitted.' });
  }

  // Resubmitting is fine until the tutor has marked it.
  const row = await one(
    `INSERT INTO assignment_submissions (assignment_id, student_id, answer_text, file_url, file_name, is_late)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (assignment_id, student_id) DO UPDATE
       SET answer_text = EXCLUDED.answer_text, file_url = EXCLUDED.file_url, file_name = EXCLUDED.file_name,
           submitted_at = now(), is_late = EXCLUDED.is_late
       WHERE assignment_submissions.marks IS NULL
     RETURNING id, is_late, submitted_at`,
    [a.id, req.user.id, text, fileUrl, fileName, late]);
  if (!row) return res.status(409).json({ error: 'This has already been marked, so it cannot be changed.' });

  await notify(a.tutor_user_id, 'assignment_submitted', 'Assignment submitted',
    `${req.user.full_name} submitted "${a.title}"${late ? ' (late)' : ''}.`, { assignment_id: a.id });
  await logActivity(req.user, 'assignment_submitted', `Submitted "${a.title}"${late ? ' (late)' : ''}`, req.ip);
  res.status(201).json({ ok: true, is_late: row.is_late });
}));

// ------------------------------------------------------------
// Scheduler: deadline reminders for students who have not submitted
// ------------------------------------------------------------
export async function sendAssignmentReminders() {
  const due = await query(
    `UPDATE assignments SET reminder_sent_at = now()
      WHERE reminder_sent_at IS NULL AND due_at > now()
        AND due_at <= now() + make_interval(hours => $1)
      RETURNING id, title, due_at`, [DEADLINE_REMINDER_HOURS]);
  let sent = 0;
  for (const a of due) {
    const todo = await query(
      `SELECT x.student_id FROM assignment_students x
        WHERE x.assignment_id = $1
          AND NOT EXISTS (SELECT 1 FROM assignment_submissions b WHERE b.assignment_id = x.assignment_id AND b.student_id = x.student_id)`, [a.id]);
    for (const r of todo) {
      await notify(r.student_id, 'assignment_reminder', 'Assignment due soon',
        `${a.title} is due ${fmt(a.due_at)}.`, { assignment_id: a.id });
      sent += 1;
    }
  }
  return sent;
}
