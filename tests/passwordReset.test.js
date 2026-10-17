import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, api, login, query, one } from './helpers.js';
import { devOutbox } from '../lib/whatsapp.js';

const PHONE = '03002000001';           // student2 (Bilal)
const NEW_PW = 'brandnew-pw-1';

before(boot);
after(shutdown);

const lastCode = (phone) => [...devOutbox].reverse().find((m) => m.phone === phone)?.code;
const clearLimits = () => query(`DELETE FROM password_resets`);

async function request(phone = PHONE) {
  const r = await api('POST', '/api/auth/forgot-password', { body: { phone } });
  await new Promise((res) => setTimeout(res, 30));   // the send is not awaited
  return r;
}

test('a code is sent, 6 digits, stored hashed, expires in 5 minutes', async () => {
  await clearLimits();
  const r = await request();
  assert.equal(r.status, 200);
  assert.equal(r.body.expires_in, 300);

  const code = lastCode(PHONE);
  assert.match(code, /^\d{6}$/);

  const row = await one(`SELECT code_hash, expires_at, created_at FROM password_resets WHERE phone=$1 ORDER BY created_at DESC LIMIT 1`, [PHONE]);
  assert.notEqual(row.code_hash, code, 'code must not be stored in plain text');
  assert.ok(row.code_hash.startsWith('$2'), 'stored as a bcrypt hash');
  const mins = (new Date(row.expires_at) - new Date(row.created_at)) / 60000;
  assert.ok(mins > 4.9 && mins < 5.1, `expires in 5 min, got ${mins}`);
});

test('same response for a registered and an unregistered number', async () => {
  await clearLimits();
  const reg = await request(PHONE);
  const unreg = await request('03111111111');
  assert.equal(reg.status, unreg.status);
  assert.deepEqual(reg.body, unreg.body);
  assert.equal(lastCode('03111111111'), undefined, 'nothing is sent to an unregistered number');
});

test('a wrong code looks the same for registered and unregistered numbers', async () => {
  await clearLimits();
  await request(PHONE);
  await request('03111111111');
  const a = await api('POST', '/api/auth/verify-otp', { body: { phone: PHONE, code: '000000' } });
  const b = await api('POST', '/api/auth/verify-otp', { body: { phone: '03111111111', code: '000000' } });
  assert.equal(a.status, 400);
  assert.equal(b.status, 400);
  assert.equal(a.body.error, b.body.error);
});

test('full flow: verify -> change password -> old password stops working', async () => {
  await clearLimits();
  await request();
  const code = lastCode(PHONE);

  const v = await api('POST', '/api/auth/verify-otp', { body: { phone: PHONE, code } });
  assert.equal(v.status, 200);
  assert.match(v.body.reset_token, /^[a-f0-9]{64}$/);

  // the change-password step is useless without the token
  const noToken = await api('POST', '/api/auth/reset-password', { body: { phone: PHONE, reset_token: 'a'.repeat(64), password: NEW_PW } });
  assert.equal(noToken.status, 400);

  const before = await login('student2@stf.pk');           // an older session
  const r = await api('POST', '/api/auth/reset-password', { body: { phone: PHONE, reset_token: v.body.reset_token, password: NEW_PW } });
  assert.equal(r.status, 200);
  assert.match(r.body.message, /changed/i);

  const old = await api('POST', '/api/auth/login', { body: { email: 'student2@stf.pk', password: 'password123' } });
  assert.equal(old.status, 401);
  const fresh = await api('POST', '/api/auth/login', { body: { email: 'student2@stf.pk', password: NEW_PW } });
  assert.equal(fresh.status, 200);

  // password change signs out the older session
  const stale = await api('GET', '/api/auth/me', { token: before.token });
  assert.equal(stale.status, 401);
  const live = await api('GET', '/api/auth/me', { token: fresh.body.token });
  assert.equal(live.status, 200);

  // the reset token works once
  const again = await api('POST', '/api/auth/reset-password', { body: { phone: PHONE, reset_token: v.body.reset_token, password: 'another-pw-22' } });
  assert.equal(again.status, 400);

  // put it back for the other tests
  await query(`UPDATE users SET password = (SELECT password FROM users WHERE email='student@stf.pk'), password_changed_at=NULL WHERE email='student2@stf.pk'`);
});

test('a code works only once', async () => {
  await clearLimits();
  await request();
  const code = lastCode(PHONE);
  const first = await api('POST', '/api/auth/verify-otp', { body: { phone: PHONE, code } });
  assert.equal(first.status, 200);
  const second = await api('POST', '/api/auth/verify-otp', { body: { phone: PHONE, code } });
  assert.equal(second.status, 400);
});

test('5 wrong attempts lock the code, even the right one afterwards', async () => {
  await clearLimits();
  await request();
  const code = lastCode(PHONE);
  const wrong = code === '123456' ? '654321' : '123456';
  let last;
  for (let i = 0; i < 5; i++) last = await api('POST', '/api/auth/verify-otp', { body: { phone: PHONE, code: wrong } });
  assert.equal(last.status, 429);
  const right = await api('POST', '/api/auth/verify-otp', { body: { phone: PHONE, code } });
  assert.notEqual(right.status, 200, 'locked code must not verify');
});

test('parallel guesses cannot beat the 5-attempt limit', async () => {
  await clearLimits();
  await request();
  const code = lastCode(PHONE);
  const wrong = code === '123456' ? '654321' : '123456';
  const rs = await Promise.all(Array.from({ length: 12 }, () =>
    api('POST', '/api/auth/verify-otp', { body: { phone: PHONE, code: wrong } })));
  const row = await one(`SELECT attempts FROM password_resets WHERE phone=$1 ORDER BY created_at DESC LIMIT 1`, [PHONE]);
  assert.ok(row.attempts <= 5, `attempts must stop at 5, got ${row.attempts}`);
  assert.equal(rs.filter((r) => r.status === 200).length, 0, 'no wrong guess may succeed');
  const right = await api('POST', '/api/auth/verify-otp', { body: { phone: PHONE, code } });
  assert.notEqual(right.status, 200, 'the code is dead after the lock');
});

test('an expired code is refused', async () => {
  await clearLimits();
  await request();
  const code = lastCode(PHONE);
  await query(`UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE phone=$1`, [PHONE]);
  const r = await api('POST', '/api/auth/verify-otp', { body: { phone: PHONE, code } });
  assert.equal(r.status, 400);
});

test('resend cooldown: a second request within 60s is refused', async () => {
  await clearLimits();
  assert.equal((await request()).status, 200);
  const r = await request();
  assert.equal(r.status, 429);
  assert.ok(r.body.retry_after > 0 && r.body.retry_after <= 60);
});

test('cooldown applies to unregistered numbers too (no way to tell them apart)', async () => {
  await clearLimits();
  await request('03111111111');
  const r = await request('03111111111');
  assert.equal(r.status, 429);
});

test('a new code cancels the previous one', async () => {
  await clearLimits();
  await request();
  const oldCode = lastCode(PHONE);
  await query(`UPDATE password_resets SET created_at = now() - interval '2 minutes'`);
  await request();
  const newCode = lastCode(PHONE);
  if (oldCode !== newCode) {
    const r = await api('POST', '/api/auth/verify-otp', { body: { phone: PHONE, code: oldCode } });
    assert.equal(r.status, 400);
  }
  const ok = await api('POST', '/api/auth/verify-otp', { body: { phone: PHONE, code: newCode } });
  assert.equal(ok.status, 200);
});

test('max 5 codes per phone per hour', async () => {
  await clearLimits();
  let status;
  for (let i = 0; i < 6; i++) {
    await query(`UPDATE password_resets SET created_at = created_at - interval '2 minutes'`);
    status = (await request()).status;
  }
  assert.equal(status, 429);
});

test('audit log records request, verification and password change', async () => {
  await clearLimits();
  await request();
  const code = lastCode(PHONE);
  const v = await api('POST', '/api/auth/verify-otp', { body: { phone: PHONE, code } });
  await api('POST', '/api/auth/reset-password', { body: { phone: PHONE, reset_token: v.body.reset_token, password: 'audit-pw-123' } });
  const actions = (await query(`SELECT action FROM activity_log WHERE action IN ('password_reset_requested','otp_verified','password_changed')`)).map((r) => r.action);
  for (const a of ['password_reset_requested', 'otp_verified', 'password_changed']) assert.ok(actions.includes(a), `missing ${a}`);
  await query(`UPDATE users SET password = (SELECT password FROM users WHERE email='student@stf.pk'), password_changed_at=NULL WHERE email='student2@stf.pk'`);
});

test('bad input is rejected', async () => {
  assert.equal((await api('POST', '/api/auth/forgot-password', { body: { phone: 'abc' } })).status, 400);
  assert.equal((await api('POST', '/api/auth/verify-otp', { body: { phone: PHONE, code: '12' } })).status, 400);
  assert.equal((await api('POST', '/api/auth/reset-password', { body: { phone: PHONE, reset_token: 'x', password: '123' } })).status, 400);
});
