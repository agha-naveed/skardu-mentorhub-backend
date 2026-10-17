import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as client } from 'socket.io-client';
import { boot, shutdown, api, login, query } from './helpers.js';
import { httpServer } from '../server.js';

let tutor, student, student2, base;
before(async () => {
  base = await boot();
  tutor = await login('tutor@stf.pk'); student = await login('student@stf.pk'); student2 = await login('student2@stf.pk');
});
after(shutdown);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const sendImage = (token, to, type = 'image/png', caption = '') => {
  const fd = new FormData(); fd.append('image', new Blob([PNG], { type }), 'p.png'); if (caption) fd.append('body', caption);
  return api('POST', `/api/chats/${to}/image`, { token, body: fd });
};
const connect = (token) => new Promise((resolve, reject) => {
  const s = client(base, { auth: { token }, transports: ['websocket'] });
  s.on('connect', () => resolve(s)); s.on('connect_error', reject);
});
const once = (s, ev) => new Promise((r) => s.once(ev, r));

test('student sends a picture; it is stored with an inline URL and shows in history', async () => {
  const r = await sendImage(student.token, tutor.user.tutor.id, 'image/png', 'my working');
  assert.equal(r.status, 201);
  assert.match(r.body.image_url, /^\/api\/media\/[a-f0-9]{32}\.png$/);
  assert.equal(r.body.body, 'my working');
  const img = await fetch(`${base}${r.body.image_url}`);
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  const hist = await api('GET', `/api/chats/${tutor.user.tutor.id}/messages`, { token: student.token });
  assert.ok(hist.body.messages.some((m) => m.image_url === r.body.image_url));
});

test('pictures: only enrolled pairs, only images', async () => {
  assert.equal((await sendImage(student2.token, tutor.user.tutor.id)).status, 403, 'not enrolled');
  assert.equal((await sendImage(student.token, tutor.user.tutor.id, 'application/pdf')).status, 400);
  assert.equal((await sendImage(student.token, tutor.user.tutor.id, 'text/html')).status, 400);
  assert.equal((await api('POST', `/api/chats/${tutor.user.tutor.id}/image`, { body: new FormData() })).status, 401);
  const noFile = await api('POST', `/api/chats/${tutor.user.tutor.id}/image`, { token: student.token, body: new FormData() });
  assert.equal(noFile.status, 400);
  const big = new FormData(); big.append('image', new Blob([Buffer.alloc(6 * 1024 * 1024)], { type: 'image/png' }), 'big.png');
  assert.equal((await api('POST', `/api/chats/${tutor.user.tutor.id}/image`, { token: student.token, body: big })).status, 400);
});

test('tutor can send a picture to a student; student is notified', async () => {
  const r = await sendImage(tutor.token, student.user.id, 'image/jpeg');
  assert.equal(r.status, 201);
  assert.ok((await query(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='message'`, [student.user.id])).length);
});

test('receipts: delivered when the app acknowledges, SEEN when the conversation is opened (live)', async () => {
  const tSock = await connect(tutor.token);
  const sSock = await connect(student.token);
  await new Promise((r) => tSock.emit('chat:join', student.user.id, r));
  await new Promise((r) => sSock.emit('chat:join', tutor.user.tutor.id, r));

  const sent = await api('POST', `/api/chats/${tutor.user.tutor.id}/messages`, { token: student.token, body: { body: 'sir, a question' } });
  assert.equal(sent.body.read_at, null); assert.equal(sent.body.delivered_at, null);

  const delivered = once(tSock, 'chat:delivered');
  await new Promise((r) => tSock.emit('chat:ack', student.user.id, r));
  assert.ok((await delivered).ids.includes(sent.body.id));

  const seen = once(sSock, 'chat:seen');                 // the SENDER's app hears it
  const open = await api('GET', `/api/chats/${student.user.id}/messages`, { token: tutor.token });
  assert.equal(open.status, 200);
  assert.ok((await seen).ids.includes(sent.body.id));

  const row = (await query(`SELECT read_at, delivered_at FROM messages WHERE id=$1`, [sent.body.id]))[0];
  assert.ok(row.read_at && row.delivered_at);
  tSock.close(); sSock.close();
});

test('socket refuses someone not enrolled, and a bad token', async () => {
  const s2 = await connect(student2.token);
  const reply = await new Promise((r) => s2.emit('chat:join', tutor.user.tutor.id, r));
  assert.equal(reply.ok, false);
  const ack = await new Promise((r) => s2.emit('chat:read', tutor.user.tutor.id, r));
  assert.equal(ack.ok, false);
  s2.close();
  await assert.rejects(connect('garbage'));
});

test('a notification arrives live over the socket', async () => {
  const s = await connect(student.token);
  const got = once(s, 'notification:new');
  await api('POST', '/api/tutor/classes', { token: tutor.token, body: { subject_id: tutor.user.tutor.subjects[0].subject_id, title: 'Live ping', starts_at: new Date(Date.now() + 7200000).toISOString(), ends_at: new Date(Date.now() + 10800000).toISOString(), mode: 'centre' } });
  const n = await got;
  assert.equal(n.type, 'class_scheduled'); assert.equal(n.data.route, '/schedule');
  s.close();
});

test('delivered tick: a student\'s app acknowledges using the tutor\'s USER id (what chat:unread carries)', async () => {
  const tSock = await connect(tutor.token);
  const sSock = await connect(student.token);
  await new Promise((r) => tSock.emit('chat:join', student.user.id, r));

  const sent = await api('POST', `/api/chats/${student.user.id}/messages`, { token: tutor.token, body: { body: 'homework tonight' } });
  const delivered = once(tSock, 'chat:delivered');
  const reply = await new Promise((r) => sSock.emit('chat:ack', tutor.user.id, r));   // user id, not tutors.id
  assert.equal(reply.ok, true);
  assert.ok((await delivered).ids.includes(sent.body.id));

  const stranger = await connect(student2.token);
  const no = await new Promise((r) => stranger.emit('chat:ack', tutor.user.id, r));
  assert.equal(no.ok, false, 'a student who is not enrolled cannot ack');
  tSock.close(); sSock.close(); stranger.close();
});
