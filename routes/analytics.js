// ============================================================
// Analytics
// ============================================================
//   Student  : their own progress          GET /api/analytics/me
//   Tutor    : per student and per class   GET /api/analytics/tutor
//   Admin    : everything                  GET /api/analytics/admin
//
// One function, metricsForStudent, produces the numbers; the three
// views only differ in WHO may ask and WHICH tutor's work is
// counted. Every rate is null (not 0) when there is nothing to
// measure, so a chart can say "no data" instead of "0%".
// ============================================================
import { Router } from 'express';
import { query, one } from '../db.js';
import { requireLogin, requireRole, handle } from '../helpers.js';
import { isUuid, tutorOf } from '../lib/common.js';

export const router = Router();

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const avg = (rows, f) => {
  const v = rows.map(f).filter((x) => x != null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};

export async function metricsForStudent(studentId, tutorId = null) {
  const T = tutorId; // null = all tutors

  const exams = await query(
    `SELECT q.title, a.score, a.max_score, a.cheat_count, a.submitted_at
       FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id
      WHERE a.student_id = $1 AND a.submitted_at IS NOT NULL AND ($2::uuid IS NULL OR q.tutor_id = $2)
      ORDER BY a.submitted_at`, [studentId, T]);
  const examRows = exams.map((e) => ({ ...e, percent: pct(e.score, e.max_score) }));

  const assigned = await query(
    `SELECT a.id, a.title, a.max_marks, a.due_at, b.marks, b.is_late, b.submitted_at
       FROM assignment_students x JOIN assignments a ON a.id = x.assignment_id
       LEFT JOIN assignment_submissions b ON b.assignment_id = a.id AND b.student_id = x.student_id
      WHERE x.student_id = $1 AND ($2::uuid IS NULL OR a.tutor_id = $2)
      ORDER BY a.due_at`, [studentId, T]);
  // A deadline that has not passed is not "missed" yet — it only
  // counts toward the rate once submitted or overdue.
  const dueOrDone = assigned.filter((a) => a.submitted_at || new Date(a.due_at) < new Date());
  const submitted = assigned.filter((a) => a.submitted_at);
  const marked = submitted.filter((a) => a.marks != null);

  const classes = await query(
    `SELECT c.title, c.starts_at, c.ends_at, at.check_in_at, at.check_out_at
       FROM class_session_students x JOIN class_sessions c ON c.id = x.session_id
       LEFT JOIN attendance at ON at.session_id = c.id AND at.student_id = x.student_id
      WHERE x.student_id = $1 AND c.status = 'scheduled' AND c.ends_at < now()
        AND ($2::uuid IS NULL OR c.tutor_id = $2)
      ORDER BY c.starts_at`, [studentId, T]);
  const attended = classes.filter((c) => c.check_in_at);
  const minutes = attended.reduce((n, c) => {
    const end = c.check_out_at ? new Date(c.check_out_at) : new Date(c.ends_at);
    return n + Math.max(0, Math.round((end - new Date(c.check_in_at)) / 60000));
  }, 0);

  const videos = await one(
    `SELECT COUNT(*)::int AS released, COUNT(*) FILTER (WHERE r.watched_at IS NOT NULL)::int AS watched,
            COALESCE(SUM(r.watched_seconds), 0)::int AS seconds
       FROM video_releases r JOIN videos v ON v.id = r.video_id
      WHERE r.student_id = $1 AND r.release_on <= CURRENT_DATE AND ($2::uuid IS NULL OR v.tutor_id = $2)`, [studentId, T]);

  const ann = await one(
    `SELECT COUNT(DISTINCT a.id)::int AS received,
            COUNT(DISTINCT a.id) FILTER (WHERE r.student_id IS NOT NULL)::int AS read
       FROM announcements a
       JOIN enrollments e ON e.tutor_id = a.tutor_id AND e.student_id = $1
            AND e.status IN ('accepted','completed') AND a.created_at >= e.created_at
       LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.student_id = $1
      WHERE ($2::uuid IS NULL OR a.tutor_id = $2)`, [studentId, T]);

  const msgs = await one(
    `SELECT COUNT(*)::int AS sent, COUNT(*) FILTER (WHERE read_at IS NOT NULL)::int AS seen,
            ROUND(AVG(EXTRACT(EPOCH FROM (read_at - created_at))) FILTER (WHERE read_at IS NOT NULL))::int AS avg_seconds_to_see
       FROM messages WHERE student_id = $1 AND sender = 'tutor' AND ($2::uuid IS NULL OR tutor_id = $2)`, [studentId, T]);

  const cheat = examRows.reduce((n, e) => n + (e.cheat_count || 0), 0);

  return {
    exams: {
      taken: examRows.length, average_percent: avg(examRows, (e) => e.percent),
      trend: examRows.map((e) => ({ title: e.title, percent: e.percent, date: e.submitted_at, cheat_count: e.cheat_count })),
    },
    assignments: {
      assigned: assigned.length, submitted: submitted.length,
      submission_rate: pct(submitted.length, dueOrDone.length),
      late: submitted.filter((a) => a.is_late).length,
      average_percent: avg(marked, (a) => pct(a.marks, a.max_marks)),
      marks: marked.map((a) => ({ title: a.title, marks: a.marks, max: a.max_marks, percent: pct(a.marks, a.max_marks) })),
    },
    attendance: {
      classes: classes.length, attended: attended.length, rate: pct(attended.length, classes.length),
      minutes_attended: minutes,
      recent: classes.slice(-10).map((c) => ({ title: c.title, date: c.starts_at, attended: Boolean(c.check_in_at) })),
    },
    videos: { released: videos.released, watched: videos.watched, watch_rate: pct(videos.watched, videos.released), seconds_watched: videos.seconds },
    announcements: { received: ann.received, read: ann.read, read_rate: pct(ann.read, ann.received) },
    messages: { sent_to_student: msgs.sent, seen: msgs.seen, seen_rate: pct(msgs.seen, msgs.sent), avg_seconds_to_see: msgs.avg_seconds_to_see },
    cheating: { flags: cheat },
  };
}

// Per student and per class level, for one tutor.
export async function tutorOverview(tutorId) {
  const students = await query(
    `SELECT DISTINCT u.id, u.full_name, u.class_level
       FROM enrollments e JOIN users u ON u.id = e.student_id
      WHERE e.tutor_id = $1 AND e.status IN ('accepted','completed')
      ORDER BY u.full_name LIMIT 100`, [tutorId]);

  const rows = [];
  for (const s of students) {
    const m = await metricsForStudent(s.id, tutorId);
    rows.push({
      student_id: s.id, full_name: s.full_name, class_level: s.class_level,
      exam_average: m.exams.average_percent, exams_taken: m.exams.taken,
      assignment_average: m.assignments.average_percent, submission_rate: m.assignments.submission_rate,
      attendance_rate: m.attendance.rate, minutes_attended: m.attendance.minutes_attended,
      watch_rate: m.videos.watch_rate, announcement_read_rate: m.announcements.read_rate,
      message_seen_rate: m.messages.seen_rate, cheating_flags: m.cheating.flags,
    });
  }

  const groups = new Map();
  for (const r of rows) {
    const k = r.class_level ?? 0;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const by_class = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([level, list]) => ({
    class_level: level || null, students: list.length,
    exam_average: avg(list, (r) => r.exam_average),
    assignment_average: avg(list, (r) => r.assignment_average),
    submission_rate: avg(list, (r) => r.submission_rate),
    attendance_rate: avg(list, (r) => r.attendance_rate),
    cheating_flags: list.reduce((n, r) => n + r.cheating_flags, 0),
  }));
  return { students: rows, by_class };
}

router.get('/api/analytics/me', requireLogin, requireRole('student'), handle(async (req, res) => {
  res.json(await metricsForStudent(req.user.id));
}));

router.get('/api/analytics/tutor', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await tutorOf(req.user.id);
  if (!tutor) return res.status(404).json({ error: 'Profile not found.' });

  if (req.query.student_id) {
    if (!isUuid(req.query.student_id)) return res.status(404).json({ error: 'That student is not yours.' });
    // Only a student this tutor actually teaches.
    const mine = await one(
      `SELECT u.id, u.full_name, u.class_level FROM enrollments e JOIN users u ON u.id = e.student_id
        WHERE e.tutor_id = $1 AND e.student_id = $2 AND e.status IN ('accepted','completed') LIMIT 1`,
      [tutor.id, req.query.student_id]);
    if (!mine) return res.status(404).json({ error: 'That student is not yours.' });
    return res.json({ student: mine, ...(await metricsForStudent(mine.id, tutor.id)) });
  }
  res.json(await tutorOverview(tutor.id));
}));

router.get('/api/analytics/admin', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const { student_id: studentId, tutor_id: tutorId } = req.query;
  if (studentId && !isUuid(studentId)) return res.status(404).json({ error: 'No such student.' });
  if (tutorId && !isUuid(tutorId)) return res.status(404).json({ error: 'No such tutor.' });

  if (studentId) {
    const s = await one(`SELECT id, full_name, class_level FROM users WHERE id = $1 AND role = 'student'`, [studentId]);
    if (!s) return res.status(404).json({ error: 'No such student.' });
    return res.json({ student: s, ...(await metricsForStudent(s.id, tutorId || null)) });
  }
  if (tutorId) {
    const t = await one(`SELECT t.id, u.full_name FROM tutors t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [tutorId]);
    if (!t) return res.status(404).json({ error: 'No such tutor.' });
    return res.json({ tutor: t, ...(await tutorOverview(t.id)) });
  }

  const totals = await one(
    `SELECT (SELECT COUNT(*)::int FROM users WHERE role='student') AS students,
            (SELECT COUNT(*)::int FROM tutors WHERE verification_status='verified') AS tutors,
            (SELECT COUNT(*)::int FROM quiz_attempts WHERE submitted_at IS NOT NULL) AS exams_taken,
            (SELECT ROUND(AVG(score::numeric / NULLIF(max_score,0) * 100), 1)::float FROM quiz_attempts WHERE submitted_at IS NOT NULL) AS exam_average,
            (SELECT COUNT(*)::int FROM exam_cheat_events) AS cheating_events,
            (SELECT COUNT(*)::int FROM assignment_submissions) AS submissions,
            (SELECT COUNT(*)::int FROM attendance) AS check_ins,
            (SELECT COUNT(*)::int FROM messages WHERE read_at IS NOT NULL) AS messages_seen,
            (SELECT COUNT(*)::int FROM messages) AS messages_total`);
  const tutors = await query(
    `SELECT t.id, u.full_name,
            (SELECT COUNT(DISTINCT e.student_id)::int FROM enrollments e WHERE e.tutor_id = t.id AND e.status IN ('accepted','completed')) AS students,
            (SELECT COUNT(*)::int FROM class_sessions c WHERE c.tutor_id = t.id AND c.status='scheduled' AND c.ends_at < now()) AS classes_held,
            (SELECT COUNT(*)::int FROM assignments a WHERE a.tutor_id = t.id) AS assignments,
            (SELECT COUNT(*)::int FROM quizzes q WHERE q.tutor_id = t.id AND q.is_published) AS exams
       FROM tutors t JOIN users u ON u.id = t.user_id WHERE t.verification_status = 'verified' ORDER BY u.full_name LIMIT 100`);
  res.json({ totals, tutors });
}));
