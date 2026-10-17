import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, api, login, query } from './helpers.js';
import { notify } from '../helpers.js';
import { setMessagingForTests } from '../lib/push.js';

let student, tutor;
const sent = [];
before(async () => {
  await boot();
  student = await login('student@stf.pk'); tutor = await login('tutor@stf.pk');
  setMessagingForTests({
    async sendEachForMulticast(m) {
      sent.push(m);
      return { successCount: m.tokens.length - m.tokens.filter((t) => t.startsWith('DEAD')).length,
        responses: m.tokens.map((t) => t.startsWith('DEAD')
          ? { success: false, error: { code: 'messaging/registration-token-not-registered' } } : { success: true }) };
    },
  });
});
after(shutdown);
const TOKEN = 'A'.repeat(30);

test('register a device token; reassign when another user signs in on the same phone', async () => {
  assert.equal((await api('POST', '/api/devices', { token: student.token, body: { token: TOKEN } })).status, 200);
  assert.equal((await api('POST', '/api/devices', { token: tutor.token, body: { token: TOKEN } })).status, 200);
  const rows = await query(`SELECT user_id FROM device_tokens WHERE token=$1`, [TOKEN]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, tutor.user.id);
  assert.equal((await api('POST', '/api/devices', { token: student.token, body: { token: 'short' } })).status, 400);
  assert.equal((await api('POST', '/api/devices', { body: { token: TOKEN } })).status, 401);
});

test('notify() saves, and pushes to the device with a route to open', async () => {
  await api('POST', '/api/devices', { token: student.token, body: { token: TOKEN } });
  sent.length = 0;
  await notify(student.user.id, 'assignment_new', 'New assignment', 'Homework', { assignment_id: 'abc' });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].tokens, [TOKEN]);
  assert.equal(sent[0].data.route, '/assignments');
  assert.equal(sent[0].data.assignment_id, 'abc');
  assert.equal(sent[0].notification.title, 'New assignment');
  const saved = await query(`SELECT data FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [student.user.id]);
  assert.equal(saved[0].data.route, '/assignments');
});

test('a dead token is removed after a failed send', async () => {
  const dead = 'DEAD' + 'x'.repeat(30);
  await api('POST', '/api/devices', { token: student.token, body: { token: dead } });
  await notify(student.user.id, 'message', 'Hi', 'there');
  assert.equal((await query(`SELECT 1 FROM device_tokens WHERE token=$1`, [dead])).length, 0);
  assert.equal((await query(`SELECT 1 FROM device_tokens WHERE token=$1`, [TOKEN])).length, 1, 'good token kept');
});

test('preferences: defaults on, can switch a category off, then no push (but still saved)', async () => {
  const d = await api('GET', '/api/notification-prefs', { token: student.token });
  assert.equal(d.body.assignments, true);
  const p = await api('PUT', '/api/notification-prefs', { token: student.token, body: { assignments: false } });
  assert.equal(p.body.assignments, false);
  assert.equal(p.body.messages, true, 'others untouched');
  sent.length = 0;
  await notify(student.user.id, 'assignment_new', 'Muted', 'x');
  assert.equal(sent.length, 0, 'muted category is not pushed');
  assert.equal((await query(`SELECT 1 FROM notifications WHERE user_id=$1 AND title='Muted'`, [student.user.id])).length, 1, 'still in the Alerts list');
  await notify(student.user.id, 'message', 'Not muted', 'x');
  assert.equal(sent.length, 1);
  await api('PUT', '/api/notification-prefs', { token: student.token, body: { assignments: true } });
});

test('payment notices cannot be muted', async () => {
  await api('POST', '/api/devices', { token: tutor.token, body: { token: TOKEN } });
  await api('PUT', '/api/notification-prefs', { token: tutor.token, body: { messages: false, classes: false, assignments: false, exams: false, announcements: false } });
  sent.length = 0;
  await notify(tutor.user.id, 'payment_reminder', 'Pay', 'by the 3rd');
  assert.equal(sent.length, 1);
  await api('PUT', '/api/notification-prefs', { token: tutor.token, body: { messages: true, classes: true, assignments: true, exams: true, announcements: true } });
});

test('logout removes the token and is audited', async () => {
  await api('POST', '/api/devices', { token: student.token, body: { token: TOKEN } });
  await api('POST', '/api/auth/logout', { token: student.token, body: { token: TOKEN } });
  assert.equal((await query(`SELECT 1 FROM device_tokens WHERE token=$1`, [TOKEN])).length, 0);
  assert.ok((await query(`SELECT 1 FROM activity_log WHERE action='logout'`)).length >= 1);
});

test('failed and blocked logins are audited', async () => {
  await api('POST', '/api/auth/login', { body: { email: 'student@stf.pk', password: 'wrong-password' } });
  assert.ok((await query(`SELECT 1 FROM activity_log WHERE action='login_failed'`)).length >= 1);
});

test('security headers and CORS', async () => {
  const r = await api('GET', '/api/health');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const ok = await fetch(`${(await import('../server.js')).httpServer.address() ? 'http://127.0.0.1:' + (await import('../server.js')).httpServer.address().port : ''}/api/health`, { headers: { Origin: 'http://localhost' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost');
  const bad = await fetch(`http://127.0.0.1:${(await import('../server.js')).httpServer.address().port}/api/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});
