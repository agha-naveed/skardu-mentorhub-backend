// The original routes must still work after the new features were added.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, api, login } from './helpers.js';

let admin, tutor, student;
before(async () => { await boot(); admin = await login('admin@stf.pk'); tutor = await login('tutor@stf.pk'); student = await login('student@stf.pk'); });
after(shutdown);

const ok = async (path, token, label = path) => {
  const r = await api('GET', path, { token });
  assert.equal(r.status, 200, `${label} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
};

test('every role can load /me with the new subscription shape', async () => {
  for (const a of [admin, tutor, student]) await ok('/api/auth/me', a.token);
  const me = await ok('/api/auth/me', tutor.token);
  assert.equal(me.tutor.subscription.state, 'paid');
  assert.ok('message' in me.tutor.subscription && 'paid_until' in me.tutor.subscription);
  assert.match(me.tutor.subscription_paid_until, /^\d{4}-\d{2}-\d{2}$/, 'DATE comes back as a plain string');
});

test('student screens', async () => {
  for (const p of ['/api/subjects', '/api/notifications', '/api/public/tutors', '/api/enrollments/mine', '/api/videos', '/api/quizzes', '/api/chats', '/api/announcements', '/api/report-reasons'])
    await ok(p, student.token);
  await ok(`/api/tutors/${tutor.user.tutor.id}`, student.token);
  const chat = await ok(`/api/chats/${tutor.user.tutor.id}/messages`, student.token);
  assert.ok(chat.messages.length >= 1 && 'image_url' in chat.messages[0] && 'delivered_at' in chat.messages[0]);
});

test('tutor screens', async () => {
  for (const p of ['/api/enrollments/received', '/api/tutor/videos', '/api/tutor/quizzes', '/api/tutor/students', '/api/tutor/online-students', '/api/chats', '/api/announcements', '/api/notifications', '/api/tutor/videos/schedule', '/api/tutor/quizzes/schedule'])
    await ok(p, tutor.token);
});

test('admin screens', async () => {
  for (const p of ['/api/admin/stats', '/api/admin/tutors', '/api/admin/students', '/api/admin/subjects', '/api/admin/reports', '/api/admin/changes', '/api/admin/activity', '/api/admin/active'])
    await ok(p, admin.token);
  const stats = await ok('/api/admin/stats', admin.token);
  assert.ok('tutors_suspended' in stats && 'subscriptions_due' in stats && 'payments_waiting' in stats);
});

test('search finds the approved tutor, and respects filters', async () => {
  const sid = tutor.user.tutor.subjects[0].subject_id;
  const r = await api('POST', '/api/search', { token: student.token, body: { subject_ids: [sid] } });
  assert.equal(r.status, 200);
  assert.ok(JSON.stringify(r.body).includes(tutor.user.full_name));
  assert.equal((await api('POST', '/api/search', { token: student.token, body: { subject_ids: [] } })).status, 400);
});

test('old quiz take/submit endpoints are gone (no untimed grading loophole)', async () => {
  for (const [m, p] of [['GET', '/api/quizzes/00000000-0000-0000-0000-000000000000/take'], ['POST', '/api/quizzes/00000000-0000-0000-0000-000000000000/submit']]) {
    assert.equal((await api(m, p, { token: student.token, body: m === 'POST' ? { answers: [] } : undefined })).status, 404);
  }
});

test('unknown routes return JSON 404, malformed JSON returns 400 not a crash', async () => {
  const r = await api('GET', '/api/nope', { token: student.token });
  assert.equal(r.status, 404); assert.ok(r.body.error);
  const bad = await fetch(`${(await import('../server.js')).httpServer.address() && 'http://127.0.0.1:' + (await import('../server.js')).httpServer.address().port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
});

test('wrong role is refused, no token is refused', async () => {
  assert.equal((await api('GET', '/api/admin/stats', { token: student.token })).status, 403);
  assert.equal((await api('GET', '/api/admin/stats')).status, 401);
  assert.equal((await api('GET', '/api/tutor/students', { token: student.token })).status, 403);
});

test('a placeholder or missing DATABASE_URL gives a clear message, not a wall of network errors', async () => {
  const { spawnSync } = await import('child_process');
  const run = (url) => spawnSync('node', ['-e', "import('./db.js').then(()=>process.exit(0))"], {
    env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8',
  });
  for (const bad of ['postgres://user:password@host:5432/dbname', 'postgres://postgres:YOURPASSWORD@localhost:5432/stf', '']) {
    const r = run(bad);
    assert.notEqual(r.status, 0, `should refuse: ${bad || '(empty)'}`);
    assert.match(r.stderr, /DATABASE_URL/);
    assert.doesNotMatch(r.stderr, /ENOTFOUND/);
  }
  assert.equal(run('postgres://postgres:pw@localhost:5432/stf_test').status, 0, 'a real address is accepted');
});
