import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, api, login, query, one } from './helpers.js';

let tutor, student, student2, admin;
before(async () => {
  await boot();
  tutor = await login('tutor@stf.pk'); student = await login('student@stf.pk'); student2 = await login('student2@stf.pk'); admin = await login('admin@stf.pk');
  const sid = tutor.user.tutor.subjects[0].subject_id, tid = tutor.user.tutor.id, uid = student.user.id;

  // one finished exam (4/6 with a cheating flag), two assignments (one marked), one held class
  const q = await one(`INSERT INTO quizzes(tutor_id,subject_id,title,is_published) VALUES($1,$2,'AnalyticsExam',true) RETURNING id`, [tid, sid]);
  await query(`INSERT INTO quiz_attempts(quiz_id,student_id,submitted_at,score,max_score,cheat_count,question_started_at) VALUES($1,$2,now(),4,6,1,now())`, [q.id, uid]);
  const a1 = await one(`INSERT INTO assignments(tutor_id,subject_id,title,due_at,max_marks) VALUES($1,$2,'A1',now()-interval '2 days',10) RETURNING id`, [tid, sid]);
  const a2 = await one(`INSERT INTO assignments(tutor_id,subject_id,title,due_at,max_marks) VALUES($1,$2,'A2',now()-interval '1 day',10) RETURNING id`, [tid, sid]);
  const a3 = await one(`INSERT INTO assignments(tutor_id,subject_id,title,due_at,max_marks) VALUES($1,$2,'A3-future',now()+interval '5 days',10) RETURNING id`, [tid, sid]);
  for (const a of [a1, a2, a3]) await query(`INSERT INTO assignment_students VALUES($1,$2)`, [a.id, uid]);
  await query(`INSERT INTO assignment_submissions(assignment_id,student_id,marks,is_late) VALUES($1,$2,8,false)`, [a1.id, uid]);
  const c = await one(`INSERT INTO class_sessions(tutor_id,subject_id,title,starts_at,ends_at,mode) VALUES($1,$2,'Held',now()-interval '3 hours',now()-interval '2 hours','centre') RETURNING id`, [tid, sid]);
  const c2 = await one(`INSERT INTO class_sessions(tutor_id,subject_id,title,starts_at,ends_at,mode) VALUES($1,$2,'Missed',now()-interval '5 hours',now()-interval '4 hours','centre') RETURNING id`, [tid, sid]);
  for (const x of [c, c2]) await query(`INSERT INTO class_session_students VALUES($1,$2)`, [x.id, uid]);
  await query(`INSERT INTO attendance(session_id,student_id,check_in_at,check_out_at) VALUES($1,$2,now()-interval '3 hours',now()-interval '2 hours 15 minutes')`, [c.id, uid]);
});
after(shutdown);

test('student sees their own progress, correctly calculated', async () => {
  const r = await api('GET', '/api/analytics/me', { token: student.token });
  assert.equal(r.status, 200);
  const m = r.body;
  assert.ok(m.exams.taken >= 1);
  assert.ok(m.exams.trend.some((e) => e.title === 'AnalyticsExam' && e.percent === 66.7 && e.cheat_count === 1));
  assert.equal(m.assignments.assigned, 3);
  assert.equal(m.assignments.submitted, 1);
  assert.equal(m.assignments.submission_rate, 50, '1 of the 2 that were due — the future one is not counted against them');
  assert.equal(m.assignments.average_percent, 80);
  assert.equal(m.attendance.classes, 2);
  assert.equal(m.attendance.attended, 1);
  assert.equal(m.attendance.rate, 50);
  assert.equal(m.attendance.minutes_attended, 45);
  assert.ok(m.cheating.flags >= 1);
  assert.ok('seen_rate' in m.messages && 'watch_rate' in m.videos && 'read_rate' in m.announcements);
});

test('no data gives null rates, not misleading zeros', async () => {
  const r = await api('GET', '/api/analytics/me', { token: student2.token });
  assert.equal(r.body.exams.average_percent, null);
  assert.equal(r.body.assignments.submission_rate, null);
  assert.equal(r.body.attendance.rate, null);
});

test('tutor: per class overview and per student detail', async () => {
  const o = await api('GET', '/api/analytics/tutor', { token: tutor.token });
  assert.equal(o.status, 200);
  const row = o.body.students.find((s) => s.student_id === student.user.id);
  assert.equal(row.attendance_rate, 50);
  assert.ok(o.body.by_class.length >= 1 && o.body.by_class.every((g) => 'exam_average' in g && 'attendance_rate' in g));
  const d = await api('GET', `/api/analytics/tutor?student_id=${student.user.id}`, { token: tutor.token });
  assert.equal(d.body.student.full_name, 'Fatima Kazmi');
  assert.equal(d.body.assignments.submitted, 1);
});

test('tutor cannot look at a student they do not teach, or at bad ids', async () => {
  assert.equal((await api('GET', `/api/analytics/tutor?student_id=${student2.user.id}`, { token: tutor.token })).status, 404);
  assert.equal((await api('GET', '/api/analytics/tutor?student_id=nope', { token: tutor.token })).status, 404);
  assert.equal((await api('GET', '/api/analytics/tutor', { token: student.token })).status, 403);
  assert.equal((await api('GET', '/api/analytics/me', { token: tutor.token })).status, 403);
  assert.equal((await api('GET', '/api/analytics/me')).status, 401);
});

test('admin sees everything: platform, one tutor, one student', async () => {
  const all = await api('GET', '/api/analytics/admin', { token: admin.token });
  assert.ok(all.body.totals.exams_taken >= 1 && all.body.tutors.length >= 1);
  const t = await api('GET', `/api/analytics/admin?tutor_id=${tutor.user.tutor.id}`, { token: admin.token });
  assert.ok(t.body.students.length >= 1);
  const s = await api('GET', `/api/analytics/admin?student_id=${student.user.id}`, { token: admin.token });
  assert.equal(s.body.attendance.minutes_attended, 45);
  assert.equal((await api('GET', '/api/analytics/admin', { token: tutor.token })).status, 403);
  assert.equal((await api('GET', `/api/analytics/admin?student_id=${tutor.user.id}`, { token: admin.token })).status, 404, 'a tutor id is not a student');
});
