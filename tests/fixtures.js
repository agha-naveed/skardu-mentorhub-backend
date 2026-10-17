// Builds specific students and videos straight in the database, so a
// test can create exactly the situation it is about.
import { query, one } from './helpers.js';

let n = 0;
export async function mkStudent({ name, classLevel = 10, field = null, mode = 'online', tutorId, subjectIds = [], status = 'accepted' }) {
  n += 1;
  const hash = (await one(`SELECT password FROM users WHERE email = 'student@stf.pk'`)).password;
  const user = await one(
    `INSERT INTO users (role, full_name, email, phone, password, class_level, academic_field, learning_modes, terms_accepted_at)
     VALUES ('student', $1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
    [name, `fx${n}-${Date.now()}@test.pk`, `0399${String(n).padStart(7, '0')}`, hash, classLevel, field, [mode]]);
  const enr = await one(
    `INSERT INTO enrollments (student_id, tutor_id, message, status, learning_mode, responded_at)
     VALUES ($1, $2, 'hi', $3, $4, now()) RETURNING id`, [user.id, tutorId, status, mode]);
  for (const sid of subjectIds) await query('INSERT INTO enrollment_subjects (enrollment_id, subject_id) VALUES ($1, $2)', [enr.id, sid]);
  return { id: user.id, enrollmentId: enr.id };
}

export async function mkVideo({ tutorId, subjectId, from = 9, to = 10, field = null, title = `Video ${Math.random()}`, mins = 20 }) {
  return (await one(
    `INSERT INTO videos (tutor_id, subject_id, title, url, class_from, class_to, duration_mins, academic_field)
     VALUES ($1, $2, $3, 'https://example.com/v.mp4', $4, $5, $6, $7) RETURNING id, title`,
    [tutorId, subjectId, title, from, to, mins, field]));
}

export const release = (videoId, studentId, offset = 0) =>
  query(`INSERT INTO video_releases (video_id, student_id, release_on) VALUES ($1, $2, CURRENT_DATE + $3::int)
         ON CONFLICT (video_id, student_id) DO NOTHING`, [videoId, studentId, offset]);
