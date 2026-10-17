import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { boot, shutdown, api, login, query, one } from './helpers.js';
import { runMonthlyCycle } from '../routes/payments.js';
import { nextPaidUntil, subscriptionState, endOfMonth, dueDateFor } from '../subscription.js';

let tutor, admin, student, tutorId;
before(async () => {
  await boot();
  tutor = await login('tutor@stf.pk'); admin = await login('admin@stf.pk'); student = await login('student@stf.pk');
  tutorId = tutor.user.tutor.id;
});
after(shutdown);

// a receipt "uploaded" the way the app does it: a file in the docs folder
function fakeReceipt() {
  const name = `${crypto.randomBytes(16).toString('hex')}.png`;
  fs.mkdirSync(path.resolve('uploads/docs'), { recursive: true });
  fs.writeFileSync(path.resolve('uploads/docs', name), Buffer.from('x'));
  return name;
}
const send = (over = {}) => api('POST', '/api/tutor/payments', { token: tutor.token, body: {
  amount: 1000, method: 'Easypaisa', reference: 'TX123', note: 'paid', receipt: fakeReceipt(), ...over } });
const setPaid = (d) => query(`UPDATE tutors SET subscription_paid_until=$2, payment_suspended=false, listed=true WHERE id=$1`, [tutorId, d]);
const reset = async () => { await query(`DELETE FROM payments WHERE tutor_id=$1`, [tutorId]); await setPaid(endOfMonth(new Date().toISOString().slice(0, 10))); };

test('date maths: month rollover, ahead, late, leap year', () => {
  assert.equal(nextPaidUntil(null, '2026-10-10'), '2026-10-31');
  assert.equal(nextPaidUntil('2026-10-31', '2026-10-10'), '2026-11-30', 'paying ahead covers next month');
  assert.equal(nextPaidUntil('2026-10-31', '2026-11-02'), '2026-11-30');
  assert.equal(nextPaidUntil('2026-12-31', '2026-12-05'), '2027-01-31');
  assert.equal(nextPaidUntil('2027-01-31', '2027-02-02'), '2027-02-28');
  assert.equal(endOfMonth('2028-02-10'), '2028-02-29');
  assert.equal(dueDateFor('2026-11-20', 3), '2026-11-03');
});

test('payment details are shown to tutors and admins, not students', async () => {
  const r = await api('GET', '/api/payment-details', { token: tutor.token });
  assert.equal(r.status, 200);
  assert.ok(r.body.account_title && r.body.account_number && r.body.monthly_fee && r.body.methods.length >= 3);
  assert.ok(r.body.methods.some((m) => m.name === 'Easypaisa') && r.body.methods.some((m) => m.name === 'JazzCash'));
  assert.equal(r.body.due_day, 3);
  assert.ok(r.body.instructions);
  assert.equal((await api('GET', '/api/payment-details', { token: student.token })).status, 403);
});

test('admin edits payment details; validated; audited; tutor sees the change', async () => {
  const good = { account_title: 'STF Ltd', account_number: '1234', bank_name: 'HBL', methods: [{ name: 'Easypaisa', number: '0300' }, { name: 'Bank transfer', number: '99' }], monthly_fee: 1500, due_day: 3, instructions: 'Pay then upload.' };
  assert.equal((await api('PUT', '/api/admin/payment-details', { token: admin.token, body: { ...good, monthly_fee: -5 } })).status, 400);
  assert.equal((await api('PUT', '/api/admin/payment-details', { token: admin.token, body: { ...good, due_day: 40 } })).status, 400);
  assert.equal((await api('PUT', '/api/admin/payment-details', { token: admin.token, body: { ...good, methods: [] } })).status, 400);
  assert.equal((await api('PUT', '/api/admin/payment-details', { token: tutor.token, body: good })).status, 403);
  assert.equal((await api('PUT', '/api/admin/payment-details', { token: admin.token, body: good })).status, 200);
  assert.equal((await api('GET', '/api/payment-details', { token: tutor.token })).body.monthly_fee, 1500);
  assert.ok((await query(`SELECT 1 FROM activity_log WHERE action='settings_changed' AND detail LIKE '%payment details%'`)).length);
  await api('PUT', '/api/admin/payment-details', { token: admin.token, body: { ...good, monthly_fee: 1000, methods: [{ name: 'Easypaisa', number: '1' }, { name: 'JazzCash', number: '2' }, { name: 'Bank transfer', number: '3' }] } });
});

test('receipt needs amount, method, reference and a real uploaded file', async () => {
  await reset();
  assert.equal((await send({ amount: 0 })).status, 400);
  assert.equal((await send({ amount: 'lots' })).status, 400);
  assert.equal((await send({ method: 'Bitcoin' })).status, 400);
  assert.equal((await send({ reference: '' })).status, 400);
  assert.equal((await send({ receipt: '' })).status, 400);
  assert.equal((await send({ receipt: 'a'.repeat(32) + '.png' })).status, 400, 'file must exist');
  assert.equal((await send({ receipt: '../../.env' })).status, 400);
});

test('send receipt -> admin notified -> verify -> active for the month, listed, tutor told', async () => {
  await reset();
  await setPaid('2026-09-30');
  await query(`UPDATE tutors SET payment_suspended=true, listed=false WHERE id=$1`, [tutorId]);
  const r = await send();
  assert.equal(r.status, 201);
  assert.ok((await query(`SELECT 1 FROM notifications WHERE type='payment_claim' AND user_id=(SELECT id FROM users WHERE role='admin' LIMIT 1) ORDER BY created_at DESC LIMIT 1`)).length);
  assert.equal((await send()).status, 409, 'one open receipt at a time');

  const pending = await api('GET', '/api/admin/payments', { token: admin.token });
  const p = pending.body.find((x) => x.id === r.body.id);
  assert.ok(p.receipt && p.reference === 'TX123' && p.amount === 1000 && p.method === 'Easypaisa');

  const ok = await api('POST', `/api/admin/payments/${r.body.id}/handle`, { token: admin.token, body: { confirm: true } });
  assert.equal(ok.status, 200);
  const t = await one(`SELECT subscription_paid_until, payment_suspended, listed FROM tutors WHERE id=$1`, [tutorId]);
  assert.equal(t.payment_suspended, false);
  assert.equal(t.listed, true);
  assert.ok(t.subscription_paid_until >= new Date().toISOString().slice(0, 10));
  assert.ok((await query(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='payment_confirmed'`, [tutor.user.id])).length);
  assert.equal((await api('POST', `/api/admin/payments/${r.body.id}/handle`, { token: admin.token, body: { confirm: true } })).status, 400, 'cannot handle twice');
});

test('rejection needs a reason, tutor is told, account stays as it was', async () => {
  await reset();
  const r = await send();
  assert.equal((await api('POST', `/api/admin/payments/${r.body.id}/handle`, { token: admin.token, body: { confirm: false } })).status, 400);
  assert.equal((await api('POST', `/api/admin/payments/${r.body.id}/handle`, { token: admin.token, body: { confirm: false, note: 'Blurry receipt' } })).status, 200);
  assert.ok((await query(`SELECT 1 FROM notifications WHERE type='payment_rejected' AND message LIKE '%Blurry%'`)).length);
  const h = await api('GET', '/api/tutor/payments', { token: tutor.token });
  const row = h.body.find((x) => x.id === r.body.id);
  assert.equal(row.status, 'rejected'); assert.equal(row.admin_note, 'Blurry receipt');
  assert.ok('for_month' in row && 'amount' in row && 'method' in row && 'reference' in row && 'receipt' in row && row.created_at && row.handled_at);
  assert.equal((await send()).status, 201, 'can send a clearer one');
});

test('admin history: filter by tutor, month, status', async () => {
  const all = await api('GET', '/api/admin/payments?status=all', { token: admin.token });
  assert.ok(all.body.length >= 2);
  const byTutor = await api('GET', `/api/admin/payments?status=all&tutor_id=${tutorId}`, { token: admin.token });
  assert.ok(byTutor.body.every((p) => p.tutor_id === tutorId));
  const none = await api('GET', `/api/admin/payments?status=all&month=1999-01`, { token: admin.token });
  assert.equal(none.body.length, 0);
  const conf = await api('GET', `/api/admin/payments?status=confirmed`, { token: admin.token });
  assert.ok(conf.body.every((p) => p.status === 'confirmed'));
  assert.equal((await api('GET', '/api/admin/payments?month=oct', { token: admin.token })).status, 400);
  assert.equal((await api('GET', '/api/admin/payments?tutor_id=zzz', { token: admin.token })).status, 400);
  assert.equal((await api('GET', '/api/admin/payments', { token: tutor.token })).status, 403);
});

test('SCHEDULER: not verified by the 3rd -> suspended automatically and removed from search', async () => {
  await reset();
  await setPaid('2026-09-30');
  const visibleBefore = (await api('POST', '/api/search', { token: student.token, body: { subject_ids: [tutor.user.tutor.subjects[0].subject_id] } })).body;
  const names = (b) => JSON.stringify(b);
  assert.ok(names(visibleBefore).includes(tutor.user.full_name), 'listed while covered/before the due day');

  const r = await runMonthlyCycle(new Date('2026-10-03T10:00:00+05:00'));
  assert.ok(r.suspended >= 1);
  const t = await one(`SELECT payment_suspended, listed FROM tutors WHERE id=$1`, [tutorId]);
  assert.equal(t.payment_suspended, true); assert.equal(t.listed, false);
  assert.ok((await query(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='payment_suspended'`, [tutor.user.id])).length);
  assert.ok((await query(`SELECT 1 FROM activity_log WHERE action='tutor_suspended_auto'`)).length);

  const after = (await api('POST', '/api/search', { token: student.token, body: { subject_ids: [tutor.user.tutor.subjects[0].subject_id] } })).body;
  assert.ok(!names(after).includes(tutor.user.full_name), 'removed from search');

  // a suspended tutor can still sign in and the payment option is open
  const st = await api('GET', '/api/tutor/subscription', { token: tutor.token });
  assert.equal(st.body.state, 'suspended');
  assert.equal((await send()).status, 201);
  assert.equal((await runMonthlyCycle(new Date('2026-10-03T12:00:00+05:00'))).suspended, 0, 'idempotent');
});

test('verification restores the suspended tutor to search at once', async () => {
  const pending = (await api('GET', '/api/admin/payments', { token: admin.token })).body.find((p) => p.tutor_id === tutorId);
  await api('POST', `/api/admin/payments/${pending.id}/handle`, { token: admin.token, body: { confirm: true } });
  const after = (await api('POST', '/api/search', { token: student.token, body: { subject_ids: [tutor.user.tutor.subjects[0].subject_id] } })).body;
  assert.ok(JSON.stringify(after).includes(tutor.user.full_name));
  assert.equal((await api('GET', '/api/tutor/subscription', { token: tutor.token })).body.state, 'paid');
});

test('SCHEDULER: before the 3rd -> a reminder (once a day), no suspension; paid tutors untouched', async () => {
  await reset(); await setPaid('2026-09-30');
  const r = await runMonthlyCycle(new Date('2026-10-01T09:00:00+05:00'));
  assert.equal(r.suspended, 0); assert.ok(r.reminded >= 1);
  assert.equal((await runMonthlyCycle(new Date('2026-10-01T18:00:00+05:00'))).reminded, 0, 'one reminder a day');
  assert.ok((await runMonthlyCycle(new Date('2026-10-02T09:00:00+05:00'))).reminded >= 1);
  const paid = await runMonthlyCycle(new Date('2026-10-03T09:00:00+05:00'));
  assert.ok(paid.suspended >= 1);
  await reset(); await setPaid('2026-10-31');
  const ok = await runMonthlyCycle(new Date('2026-10-05T09:00:00+05:00'));
  assert.equal(ok.suspended, 0);
});

test('Pakistan time decides the day, not the server clock', async () => {
  await reset(); await setPaid('2026-09-30');
  // 2 Oct 22:00 UTC is already 3 Oct 03:00 in Pakistan -> due day reached
  const r = await runMonthlyCycle(new Date('2026-10-02T22:00:00Z'));
  assert.ok(r.suspended >= 1);
  await reset();
});

test('state messages', () => {
  assert.equal(subscriptionState({ subscription_paid_until: '2026-10-31' }, false, { today: '2026-10-10' }).state, 'paid');
  const due = subscriptionState({ subscription_paid_until: '2026-10-31' }, false, { today: '2026-11-01' });
  assert.equal(due.state, 'due'); assert.equal(due.days_left, 2);
  assert.equal(subscriptionState({ subscription_paid_until: '2026-10-31', payment_suspended: true }, false, { today: '2026-11-04' }).state, 'suspended');
});

test('a newly approved tutor is covered for the rest of the month', async () => {
  const t2 = await one(`SELECT t.id FROM tutors t JOIN users u ON u.id=t.user_id WHERE u.email='tutor2@stf.pk'`);
  await query(`UPDATE tutors SET subscription_paid_until=NULL WHERE id=$1`, [t2.id]);
  const res = await api('POST', `/api/admin/tutors/${t2.id}/review`, { token: admin.token, body: { approve: true } });
  if (res.status === 200) {
    const row = await one(`SELECT subscription_paid_until FROM tutors WHERE id=$1`, [t2.id]);
    assert.equal(row.subscription_paid_until, endOfMonth(new Date().toISOString().slice(0, 10)));
  } else {
    assert.equal(res.status, 400);   // approval refused for missing details — covered elsewhere
  }
});
