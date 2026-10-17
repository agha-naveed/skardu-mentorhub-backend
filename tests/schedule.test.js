import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, api, login, query, one } from './helpers.js';
import { sendClassReminders } from '../routes/schedule.js';

let tutor, student, student2, subjectId;
before(async () => {
  await boot();
  tutor = await login('tutor@stf.pk'); student = await login('student@stf.pk'); student2 = await login('student2@stf.pk');
  subjectId = tutor.user.tutor.subjects[0].subject_id;
});
after(shutdown);

const inMin = (m) => new Date(Date.now() + m * 60000).toISOString();
const mk = (over = {}) => api('POST', '/api/tutor/classes', { token: tutor.token, body: {
  subject_id: subjectId, title: 'Algebra', starts_at: inMin(120), ends_at: inMin(180), mode: 'centre', ...over } });
const notes = (uid, type) => query(`SELECT * FROM notifications WHERE user_id=$1 AND type=$2`, [uid, type]);

test('tutor creates a class; enrolled students are notified', async () => {
  const before = (await notes(student.user.id, 'class_scheduled')).length;
  const r = await mk({ title: 'Trig revision' });
  assert.equal(r.status, 201);
  assert.ok(r.body.invited >= 1);
  assert.equal((await notes(student.user.id, 'class_scheduled')).length, before + 1);
  const mine = await api('GET', '/api/classes', { token: student.token });
  assert.ok(mine.body.some((c) => c.title === 'Trig revision'));
});

test('a student who is not enrolled never sees it', async () => {
  await mk({ title: 'Private class' });
  const r = await api('GET', '/api/classes', { token: student2.token });
  assert.ok(!r.body.some((c) => c.title === 'Private class'));
});

test('validation: end before start, past time, foreign subject, bad mode', async () => {
  assert.equal((await mk({ ends_at: inMin(60) })).status, 400);
  assert.equal((await mk({ starts_at: inMin(-300), ends_at: inMin(-240) })).status, 400);
  assert.equal((await mk({ subject_id: 999999 })).status, 400);
  assert.equal((await mk({ mode: 'teleport' })).status, 400);
  assert.equal((await mk({ title: '  ' })).status, 400);
  assert.equal((await mk({ mode: 'online', meeting_link: 'javascript:alert(1)' })).status, 400);
});

test('only the tutor role can create; students and anonymous cannot', async () => {
  assert.equal((await api('POST', '/api/tutor/classes', { token: student.token, body: {} })).status, 403);
  assert.equal((await api('POST', '/api/tutor/classes', { body: {} })).status, 401);
});

test('reschedule notifies students and re-arms the reminder', async () => {
  const c = await mk({ title: 'Move me' });
  await query(`UPDATE class_sessions SET reminder_sent_at = now() WHERE id=$1`, [c.body.id]);
  const r = await api('PATCH', `/api/tutor/classes/${c.body.id}`, { token: tutor.token, body: { starts_at: inMin(300), ends_at: inMin(360) } });
  assert.equal(r.body.rescheduled, true);
  assert.equal((await one(`SELECT reminder_sent_at FROM class_sessions WHERE id=$1`, [c.body.id])).reminder_sent_at, null);
  assert.ok((await notes(student.user.id, 'class_rescheduled')).some((n) => n.message.includes('Move me')));
});

test('cancel notifies with the reason, and cannot be edited afterwards', async () => {
  const c = await mk({ title: 'Cancel me' });
  assert.equal((await api('POST', `/api/tutor/classes/${c.body.id}/cancel`, { token: tutor.token, body: { reason: 'Power cut' } })).status, 200);
  assert.ok((await notes(student.user.id, 'class_cancelled')).some((n) => n.message.includes('Power cut')));
  assert.equal((await api('PATCH', `/api/tutor/classes/${c.body.id}`, { token: tutor.token, body: { title: 'x' } })).status, 400);
  assert.equal((await api('POST', `/api/classes/${c.body.id}/check-in`, { token: student.token })).status, 400);
});

test('reminder goes out once, about 30 minutes before', async () => {
  const c = await mk({ title: 'Soon', starts_at: inMin(20), ends_at: inMin(80) });
  const far = await mk({ title: 'Far away', starts_at: inMin(200), ends_at: inMin(260) });
  await sendClassReminders();
  const got = (await notes(student.user.id, 'class_reminder')).filter((n) => n.message.includes('Soon'));
  assert.equal(got.length, 1);
  assert.equal((await notes(student.user.id, 'class_reminder')).filter((n) => n.message.includes('Far away')).length, 0);
  await sendClassReminders();
  assert.equal((await notes(student.user.id, 'class_reminder')).filter((n) => n.message.includes('Soon')).length, 1, 'not sent twice');
  assert.ok(c.body.id && far.body.id);
});

test('attendance: too early, check in, double check-in, check out, time attended', async () => {
  const early = await mk({ title: 'Too early', starts_at: inMin(120), ends_at: inMin(180) });
  assert.equal((await api('POST', `/api/classes/${early.body.id}/check-in`, { token: student.token })).status, 400);

  const c = await mk({ title: 'Live class', starts_at: inMin(5), ends_at: inMin(65) });
  assert.equal((await api('POST', `/api/classes/${c.body.id}/check-out`, { token: student.token })).status, 400, 'check in first');
  assert.equal((await api('POST', `/api/classes/${c.body.id}/check-in`, { token: student.token })).status, 200);
  assert.equal((await api('POST', `/api/classes/${c.body.id}/check-in`, { token: student.token })).status, 409);
  await query(`UPDATE attendance SET check_in_at = now() - interval '30 minutes' WHERE session_id=$1`, [c.body.id]);
  assert.equal((await api('POST', `/api/classes/${c.body.id}/check-out`, { token: student.token })).status, 200);
  assert.equal((await api('POST', `/api/classes/${c.body.id}/check-out`, { token: student.token })).status, 409);

  const a = await api('GET', `/api/tutor/classes/${c.body.id}/attendance`, { token: tutor.token });
  const row = a.body.students.find((s) => s.student_id === student.user.id);
  assert.ok(row.check_in_at && row.check_out_at);
  assert.ok(row.minutes >= 29 && row.minutes <= 31, `minutes ${row.minutes}`);
});

test('a student not invited cannot check in', async () => {
  const c = await mk({ title: 'Not for you', starts_at: inMin(5), ends_at: inMin(65) });
  assert.equal((await api('POST', `/api/classes/${c.body.id}/check-in`, { token: student2.token })).status, 404);
});

test('tutor can mark a student present; another tutor cannot touch the class', async () => {
  const c = await mk({ title: 'Mark me', starts_at: inMin(1), ends_at: inMin(60) });
  const r = await api('POST', `/api/tutor/classes/${c.body.id}/attendance`, { token: tutor.token, body: { student_id: student.user.id } });
  assert.equal(r.status, 200);
  assert.equal((await one(`SELECT marked_by FROM attendance WHERE session_id=$1`, [c.body.id])).marked_by, 'tutor');
  const other = await login('tutor2@stf.pk').catch(() => null);
  if (other) assert.equal((await api('GET', `/api/tutor/classes/${c.body.id}/attendance`, { token: other.token })).status, 404);
});

test('audit log covers schedule and attendance', async () => {
  const acts = (await query(`SELECT DISTINCT action FROM activity_log`)).map((r) => r.action);
  for (const a of ['class_scheduled', 'class_rescheduled', 'class_cancelled', 'attendance_check_in', 'attendance_check_out']) assert.ok(acts.includes(a), a);
});
