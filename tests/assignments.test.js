import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, api, login, query, one } from './helpers.js';
import { sendAssignmentReminders } from '../routes/assignments.js';

let tutor, student, student2, subjectId;
before(async () => {
  await boot();
  tutor = await login('tutor@stf.pk'); student = await login('student@stf.pk'); student2 = await login('student2@stf.pk');
  subjectId = tutor.user.tutor.subjects[0].subject_id;
});
after(shutdown);

const inH = (h) => new Date(Date.now() + h * 3600000).toISOString();
const mk = (over = {}) => api('POST', '/api/tutor/assignments', { token: tutor.token, body: {
  subject_id: subjectId, title: 'Homework', description: 'Do it', due_at: inH(48), max_marks: 20, ...over } });
const submit = (id, body = { answer_text: 'my answer' }, tok = student.token) =>
  api('POST', `/api/assignments/${id}/submit`, { token: tok, body });

test('create -> student is notified and sees it, others do not', async () => {
  const r = await mk({ title: 'Chapter 4' });
  assert.equal(r.status, 201);
  assert.ok((await query(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='assignment_new' AND message LIKE '%Chapter 4%'`, [student.user.id])).length === 1);
  assert.ok((await api('GET', '/api/assignments', { token: student.token })).body.some((a) => a.title === 'Chapter 4'));
  assert.ok(!(await api('GET', '/api/assignments', { token: student2.token })).body.some((a) => a.title === 'Chapter 4'));
  assert.equal((await api('GET', `/api/assignments/${r.body.id}`, { token: student2.token })).status, 404);
});

test('validation', async () => {
  assert.equal((await mk({ title: '' })).status, 400);
  assert.equal((await mk({ due_at: inH(-1) })).status, 400);
  assert.equal((await mk({ due_at: 'tomorrow-ish' })).status, 400);
  assert.equal((await mk({ max_marks: 0 })).status, 400);
  assert.equal((await mk({ max_marks: 5000 })).status, 400);
  assert.equal((await mk({ subject_id: 999999 })).status, 400);
  assert.equal((await mk({ attachment_url: 'https://evil.example/x.exe' })).status, 400);
});

test('submit before the deadline; tutor is told; resubmit allowed until marked', async () => {
  const a = (await mk({ title: 'Submit me' })).body;
  assert.equal((await submit(a.id)).status, 201);
  assert.equal((await submit(a.id, { answer_text: 'improved' })).status, 201);
  assert.equal((await one(`SELECT answer_text, is_late FROM assignment_submissions WHERE assignment_id=$1`, [a.id])).answer_text, 'improved');
  assert.ok((await query(`SELECT 1 FROM notifications WHERE type='assignment_submitted' AND message LIKE '%Submit me%'`)).length >= 1);
  assert.equal((await submit(a.id, {})).status, 400, 'empty submission');
});

test('LATE is BLOCKED by default (server clock)', async () => {
  const a = (await mk({ title: 'Late blocked' })).body;
  await query(`UPDATE assignments SET due_at = now() - interval '1 minute' WHERE id=$1`, [a.id]);
  const r = await submit(a.id);
  assert.equal(r.status, 403);
  assert.equal((await query(`SELECT 1 FROM assignment_submissions WHERE assignment_id=$1`, [a.id])).length, 0);
  assert.equal((await api('GET', '/api/assignments', { token: student.token })).body.find((x) => x.id === a.id).status, 'missed');
});

test('LATE is FLAGGED when the tutor allows it', async () => {
  const a = (await mk({ title: 'Late flagged', allow_late: true })).body;
  await query(`UPDATE assignments SET due_at = now() - interval '1 minute' WHERE id=$1`, [a.id]);
  const r = await submit(a.id);
  assert.equal(r.status, 201);
  assert.equal(r.body.is_late, true);
});

test('marking: range checked, feedback saved, student sees it, notified', async () => {
  const a = (await mk({ title: 'Mark me', max_marks: 10 })).body;
  await submit(a.id);
  const bad = (m) => api('POST', `/api/tutor/assignments/${a.id}/mark`, { token: tutor.token, body: { student_id: student.user.id, marks: m } });
  assert.equal((await bad(11)).status, 400);
  assert.equal((await bad(-1)).status, 400);
  assert.equal((await bad('')).status, 400);
  assert.equal((await bad(2.5)).status, 400);
  const ok = await api('POST', `/api/tutor/assignments/${a.id}/mark`, { token: tutor.token, body: { student_id: student.user.id, marks: 8, feedback: 'Good work' } });
  assert.equal(ok.status, 200);
  const mine = await api('GET', `/api/assignments/${a.id}`, { token: student.token });
  assert.equal(mine.body.submission.marks, 8);
  assert.equal(mine.body.submission.feedback, 'Good work');
  assert.ok((await query(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='assignment_marked'`, [student.user.id])).length >= 1);
  assert.equal((await submit(a.id, { answer_text: 'sneaky change' })).status, 409, 'cannot change after marking');
});

test('cannot mark someone who has not submitted, or a stranger\'s assignment', async () => {
  const a = (await mk({ title: 'Nobody yet' })).body;
  assert.equal((await api('POST', `/api/tutor/assignments/${a.id}/mark`, { token: tutor.token, body: { student_id: student.user.id, marks: 1 } })).status, 404);
  assert.equal((await api('POST', `/api/tutor/assignments/${a.id}/mark`, { token: student.token, body: {} })).status, 403);
});

test('tutor sees submission rate', async () => {
  const a = (await mk({ title: 'Rate' })).body;
  await submit(a.id);
  const list = await api('GET', '/api/tutor/assignments', { token: tutor.token });
  const row = list.body.find((x) => x.id === a.id);
  assert.equal(row.submitted, 1);
  assert.ok(row.assigned >= 1);
  const d = await api('GET', `/api/tutor/assignments/${a.id}`, { token: tutor.token });
  assert.ok(d.body.students.some((s) => s.submission_id));
});

test('deadline reminder: only students who have not submitted, only once', async () => {
  const a = (await mk({ title: 'Remind me', due_at: inH(5) })).body;
  await sendAssignmentReminders();
  assert.equal((await query(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='assignment_reminder' AND message LIKE '%Remind me%'`, [student.user.id])).length, 1);
  await sendAssignmentReminders();
  assert.equal((await query(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='assignment_reminder' AND message LIKE '%Remind me%'`, [student.user.id])).length, 1);
  const b = (await mk({ title: 'Already done', due_at: inH(6) })).body;
  await submit(b.id);
  await sendAssignmentReminders();
  assert.equal((await query(`SELECT 1 FROM notifications WHERE type='assignment_reminder' AND message LIKE '%Already done%'`)).length, 0);
  assert.ok(a.id);
});

test('file upload: allowed type works, html disguised as png is rejected, served back', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData(); fd.append('file', new Blob([png], { type: 'image/png' }), 'pic.png');
  const up = await api('POST', '/api/media/upload', { token: student.token, body: fd });
  assert.equal(up.status, 201);
  assert.match(up.body.url, /^\/api\/media\/[a-f0-9]{32}\.png$/);
  const got = await fetch(`${(await import('./helpers.js')).app ? '' : ''}http://127.0.0.1:${(await import('../server.js')).httpServer.address().port}${up.body.url}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');

  const bad = new FormData(); bad.append('file', new Blob(['<script>x</script>'], { type: 'text/html' }), 'x.png');
  assert.equal((await api('POST', '/api/media/upload', { token: student.token, body: bad })).status, 400);
  assert.equal((await api('POST', '/api/media/upload', { body: fd })).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${(await import('../server.js')).httpServer.address().port}/api/media/..%2f..%2f.env`)).status, 404);

  const withFile = (await mk({ title: 'With file', attachment_url: up.body.url, attachment_name: 'pic.png' }));
  assert.equal(withFile.status, 201);
});
