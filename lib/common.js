// Small helpers shared by the route files.
import { one, query } from '../db.js';

export const isUuid = (v) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));

export const tutorOf = (userId) => one('SELECT id FROM tutors WHERE user_id = $1', [userId]);

// Students currently taught by this tutor (accepted or completed).
export async function enrolledStudentIds(tutorId) {
  const rows = await query(
    `SELECT DISTINCT student_id FROM enrollments
      WHERE tutor_id = $1 AND status IN ('accepted', 'completed')`, [tutorId]);
  return rows.map((r) => r.student_id);
}

// Keeps only ids that really are this tutor's students. A tutor can
// never address a class, assignment or message to somebody else's.
export async function onlyMyStudents(tutorId, ids) {
  const mine = new Set(await enrolledStudentIds(tutorId));
  return [...new Set((ids || []).filter(isUuid))].filter((id) => mine.has(id));
}

export async function teachesSubject(tutorId, subjectId) {
  return one('SELECT 1 AS ok FROM tutor_subjects WHERE tutor_id = $1 AND subject_id = $2',
    [tutorId, Number(subjectId)]);
}

export function parseDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
