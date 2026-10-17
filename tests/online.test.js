import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, api, login, query, one } from './helpers.js';
import { setMessagingForTests } from '../lib/push.js';
import { notify } from '../helpers.js';

let tutor, student, student2, subjectId;
before(async () => {
  await boot();
  tutor = await login('tutor@stf.pk'); student = await login('student@stf.pk'); student2 = await login('student2@stf.pk');
  subjectId = tutor.user.tutor.subjects[0].subject_id;
});
after(shutdown);

const inMin = (m) => new Date(Date.now() + m * 60000).toISOString();
const mk = (over = {}) => api('POST', '/api/tutor/classes', { token: tutor.token, body: {
  subject_id: subjectId, title: 'Online class', starts_at: inMin(120), ends_at: inMin(180), mode: 'online', ...over } });

test('an online class with no link gets a free, unguessable video room', async () => {
  const r = await mk();
  assert.equal(r.status, 201);
  const row = await one('SELECT meeting_link FROM class_sessions WHERE id=$1', [r.body.id]);
  assert.match(row.meeting_link, /^https:\/\/meet\.jit\.si\/STF-[0-9a-f]{18}$/);
  const r2 = await mk({ title: 'Second' });
  assert.notEqual((await one('SELECT meeting_link FROM class_sessions WHERE id=$1', [r2.body.id])).meeting_link, row.meeting_link, 'every class has its own room');
});

test('a link the tutor pastes is kept; in-person classes get none', async () => {
  const z = await mk({ meeting_link: 'https://zoom.us/j/123456' });
  assert.equal((await one('SELECT meeting_link FROM class_sessions WHERE id=$1', [z.body.id])).meeting_link, 'https://zoom.us/j/123456');
  const c = await mk({ mode: 'centre' });
  assert.equal((await one('SELECT meeting_link FROM class_sessions WHERE id=$1', [c.body.id])).meeting_link, null);
});

test('changing a class to online creates the room', async () => {
  const c = await mk({ mode: 'centre', title: 'Becomes online' });
  await api('PATCH', `/api/tutor/classes/${c.body.id}`, { token: tutor.token, body: { mode: 'online' } });
  assert.match((await one('SELECT meeting_link FROM class_sessions WHERE id=$1', [c.body.id])).meeting_link, /meet\.jit\.si/);
});

test('JOIN: one tap checks the student in AND returns the room', async () => {
  const c = await mk({ title: 'Join me', starts_at: inMin(5), ends_at: inMin(65) });
  const r = await api('POST', `/api/classes/${c.body.id}/join`, { token: student.token });
  assert.equal(r.status, 200);
  assert.match(r.body.meeting_link, /meet\.jit\.si/);
  assert.equal(r.body.checked_in, true);
  assert.equal((await query('SELECT 1 FROM attendance WHERE session_id=$1 AND student_id=$2', [c.body.id, student.user.id])).length, 1);

  const again = await api('POST', `/api/classes/${c.body.id}/join`, { token: student.token });
  assert.equal(again.status, 200);
  assert.equal(again.body.checked_in, false, 'joining again does not double-count');
  assert.equal((await query('SELECT 1 FROM attendance WHERE session_id=$1', [c.body.id])).length, 1);
});

test('JOIN is refused: too early, in-person, cancelled, not invited, over', async () => {
  const early = await mk({ title: 'Early', starts_at: inMin(120), ends_at: inMin(180) });
  assert.match((await api('POST', `/api/classes/${early.body.id}/join`, { token: student.token })).body.error, /opens 15 minutes/);

  const centre = await mk({ mode: 'centre', starts_at: inMin(5), ends_at: inMin(65) });
  assert.match((await api('POST', `/api/classes/${centre.body.id}/join`, { token: student.token })).body.error, /not online/);

  const gone = await mk({ title: 'Gone', starts_at: inMin(5), ends_at: inMin(65) });
  await api('POST', `/api/tutor/classes/${gone.body.id}/cancel`, { token: tutor.token, body: {} });
  assert.match((await api('POST', `/api/classes/${gone.body.id}/join`, { token: student.token })).body.error, /cancelled/);

  const mine = await mk({ title: 'Private', starts_at: inMin(5), ends_at: inMin(65) });
  assert.equal((await api('POST', `/api/classes/${mine.body.id}/join`, { token: student2.token })).status, 404);

  const over = await mk({ title: 'Over', starts_at: inMin(5), ends_at: inMin(65) });
  await query(`UPDATE class_sessions SET starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours' WHERE id=$1`, [over.body.id]);
  assert.match((await api('POST', `/api/classes/${over.body.id}/join`, { token: student.token })).body.error, /over/);

  assert.equal((await api('POST', `/api/classes/${mine.body.id}/join`)).status, 401);
  assert.equal((await api('POST', `/api/classes/${mine.body.id}/join`, { token: tutor.token })).status, 403);
});

test('the student only receives the link for online classes', async () => {
  const list = await api('GET', '/api/classes', { token: student.token });
  for (const c of list.body) if (c.mode !== 'online') assert.equal(c.meeting_link, null);
  assert.ok(list.body.some((c) => c.mode === 'online' && /jit\.si/.test(c.meeting_link)));
});

test('PUSH RINGS: high priority, the loud channel, sound, vibration, lock-screen, and a day of retries', async () => {
  const sent = [];
  setMessagingForTests({ async sendEachForMulticast(m) { sent.push(m); return { successCount: m.tokens.length, responses: m.tokens.map(() => ({ success: true })) }; } });
  await api('POST', '/api/devices', { token: student.token, body: { token: 'R'.repeat(40) } });
  await notify(student.user.id, 'class_reminder', 'Class starting soon', 'Algebra at 4:00 pm', { class_id: 'x' });

  const a = sent[0].android;
  assert.equal(a.priority, 'high', 'wakes a sleeping phone');
  assert.equal(a.notification.channelId, 'default', 'the loud channel the app creates');
  assert.equal(a.notification.sound, 'default');
  assert.equal(a.notification.defaultSound, true);
  assert.equal(a.notification.defaultVibrateTimings, true);
  assert.equal(a.notification.visibility, 'public');
  assert.ok(a.ttl >= 3600 * 1000, 'delivered even if the phone was off for a while');
  assert.equal(sent[0].notification.title, 'Class starting soon');
  assert.equal(sent[0].data.route, '/schedule', 'tapping opens the right screen');
  setMessagingForTests(null);
});
