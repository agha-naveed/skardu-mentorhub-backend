// ============================================================
// Payments and the monthly subscription
// ============================================================
// Nothing is paid inside the app. The screen shows the account
// details; the tutor pays by Easypaisa / JazzCash / bank, then sends
// the receipt here; the administrator verifies it.
//
//   tutor   GET  /api/payment-details      where and how much to pay
//           POST /api/tutor/payments       send a receipt
//           GET  /api/tutor/payments       payment history
//   admin   GET  /api/admin/payments       all tutors, filterable
//           POST /api/admin/payments/:id/handle    verify / reject
//           PUT  /api/admin/payment-details        edit the details
//
// Verifying activates the account for the month, restores search
// listing and lifts any automatic suspension. The scheduler (see
// runMonthlyCycle) suspends unverified tutors on the due day.
// ============================================================
import { Router } from 'express';
import { query, one } from '../db.js';
import { requireLogin, requireRole, handle, logActivity, notify } from '../helpers.js';
import { safeDocPath } from '../uploads.js';
import { isUuid, tutorOf } from '../lib/common.js';
import {
  todayPK, nextPaidUntil, firstOfMonth, dueDateFor, DEFAULT_DUE_DAY, subscriptionState,
} from '../subscription.js';

export const router = Router();

// ------------------------------------------------------------
// The details shown on screen (editable by the admin)
// ------------------------------------------------------------
export async function getPaymentDetails() {
  const row = await one(`SELECT value FROM app_settings WHERE key = 'payment_details'`);
  return row?.value || {};
}

router.get('/api/payment-details', requireLogin, requireRole('tutor', 'admin'), handle(async (req, res) => {
  const details = await getPaymentDetails();
  const today = todayPK();
  res.json({ ...details, due_date: dueDateFor(today, details.due_day || DEFAULT_DUE_DAY) });
}));

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

router.put('/api/admin/payment-details', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const b = req.body || {};
  const fee = Number(b.monthly_fee);
  const dueDay = Number(b.due_day);

  if (!clean(b.account_title, 120)) return res.status(400).json({ error: 'Enter the account title.' });
  if (!clean(b.account_number, 60)) return res.status(400).json({ error: 'Enter the account number.' });
  if (!Number.isInteger(fee) || fee < 0 || fee > 1000000) return res.status(400).json({ error: 'The monthly fee must be a whole number of rupees.' });
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28) return res.status(400).json({ error: 'The due day must be between 1 and 28.' });

  const methods = (Array.isArray(b.methods) ? b.methods : [])
    .map((m) => ({ name: clean(m?.name, 40), number: clean(m?.number, 60) }))
    .filter((m) => m.name);
  if (methods.length === 0) return res.status(400).json({ error: 'Add at least one payment method.' });

  const value = {
    account_title: clean(b.account_title, 120),
    account_number: clean(b.account_number, 60),
    bank_name: clean(b.bank_name, 80),
    iban: clean(b.iban, 40),
    methods, monthly_fee: fee, due_day: dueDay,
    instructions: clean(b.instructions, 1000),
  };

  await query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('payment_details', $1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(value), req.user.id]);
  await logActivity(req.user, 'settings_changed',
    `Changed payment details (fee Rs ${fee}, due day ${dueDay})`, req.ip);
  res.json(value);
}));

// ------------------------------------------------------------
// Tutor: send a receipt
// ------------------------------------------------------------
router.post('/api/tutor/payments', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await one(
    `SELECT id, subscription_paid_until, verification_status FROM tutors WHERE user_id = $1`, [req.user.id]);
  if (!tutor) return res.status(404).json({ error: 'Profile not found.' });

  const details = await getPaymentDetails();
  const amount = Number(req.body.amount);
  const method = clean(req.body.method, 40);
  const reference = clean(req.body.reference, 80);
  const message = clean(req.body.note ?? req.body.message, 1000) || null;
  const receipt = clean(req.body.receipt, 120);

  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) return res.status(400).json({ error: 'Enter the amount you paid, in rupees.' });
  const allowed = (details.methods || []).map((m) => m.name);
  if (!method || (allowed.length && !allowed.includes(method))) return res.status(400).json({ error: 'Choose how you paid.' });
  if (!reference) return res.status(400).json({ error: 'Enter the transaction reference from your payment.' });
  if (!receipt || !safeDocPath(receipt)) return res.status(400).json({ error: 'Upload a photo or PDF of your receipt.' });

  const open = await one(`SELECT id FROM payments WHERE tutor_id = $1 AND status = 'pending'`, [tutor.id]);
  if (open) return res.status(409).json({ error: 'You already have a payment waiting to be checked. The administrator will be in touch.' });

  // The month this receipt is for, worked out now and shown to the
  // admin, so there is no doubt what verifying it will cover.
  const until = nextPaidUntil(tutor.subscription_paid_until);

  const payment = await one(
    `INSERT INTO payments (tutor_id, amount, method, reference, note, receipt, for_month)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, status, created_at, for_month`,
    [tutor.id, Math.round(amount), method, reference, message, receipt, firstOfMonth(until)]);

  for (const admin of await query(`SELECT id FROM users WHERE role = 'admin' AND account_status = 'active'`)) {
    await notify(admin.id, 'payment_claim', 'A tutor has sent a payment receipt',
      `${req.user.full_name} paid Rs ${Math.round(amount).toLocaleString('en-PK')} via ${method}. Open Payments to verify it.`,
      { payment_id: payment.id });
  }
  await logActivity(req.user, 'payment_sent', `Sent a payment receipt (Rs ${Math.round(amount)}, ${method})`, req.ip);
  res.status(201).json(payment);
}));

router.get('/api/tutor/payments', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await tutorOf(req.user.id);
  if (!tutor) return res.json([]);
  res.json(await query(
    `SELECT id, for_month, amount, method, reference, receipt, note, status, admin_note, created_at, handled_at
       FROM payments WHERE tutor_id = $1 ORDER BY created_at DESC LIMIT 60`, [tutor.id]));
}));

// The tutor's own standing, for their payment screen.
router.get('/api/tutor/subscription', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await one(
    `SELECT id, subscription_paid_until, payment_suspended FROM tutors WHERE user_id = $1`, [req.user.id]);
  if (!tutor) return res.status(404).json({ error: 'Profile not found.' });
  const claim = await one(`SELECT 1 AS x FROM payments WHERE tutor_id = $1 AND status = 'pending'`, [tutor.id]);
  const details = await getPaymentDetails();
  res.json(subscriptionState(tutor, Boolean(claim), { dueDay: details.due_day || DEFAULT_DUE_DAY }));
}));

// ------------------------------------------------------------
// Admin: history for every tutor, filterable
// ------------------------------------------------------------
router.get('/api/admin/payments', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };

  const status = String(req.query.status || 'pending');
  if (['pending', 'confirmed', 'rejected'].includes(status)) add('p.status = ?', status);
  else if (status !== 'all') add('p.status = ?', 'pending');

  if (req.query.tutor_id) {
    if (!isUuid(req.query.tutor_id)) return res.status(400).json({ error: 'Choose a tutor from the list.' });
    add('p.tutor_id = ?', req.query.tutor_id);
  }
  if (req.query.month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month)) return res.status(400).json({ error: 'Month must look like 2026-10.' });
    add('p.for_month = ?', `${req.query.month}-01`);
  }

  res.json(await query(
    `SELECT p.*, t.centre_name, t.subscription_paid_until, t.payment_suspended,
            u.full_name, u.email, u.phone, u.avatar
       FROM payments p JOIN tutors t ON t.id = p.tutor_id JOIN users u ON u.id = t.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${status === 'pending' ? 'p.created_at ASC' : 'p.created_at DESC'} LIMIT 300`, params));
}));

// ------------------------------------------------------------
// Admin: verify or reject
// ------------------------------------------------------------
router.post('/api/admin/payments/:id/handle', requireLogin, requireRole('admin'), handle(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'That payment no longer exists.' });
  const confirm = req.body.confirm === true || req.body.confirm === 'true';
  const note = clean(req.body.note, 1000);

  if (!confirm && !note) return res.status(400).json({ error: 'Write a reason, so the tutor knows what to do.' });

  // Claim it first, atomically: two admins clicking at once cannot
  // both handle it.
  const payment = await one(
    `UPDATE payments SET status = $2, admin_note = $3, handled_by = $4, handled_at = now()
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    [req.params.id, confirm ? 'confirmed' : 'rejected', note || null, req.user.id]);

  if (!payment) {
    const exists = await one('SELECT status FROM payments WHERE id = $1', [req.params.id]);
    return res.status(exists ? 400 : 404).json({ error: exists ? 'You have already dealt with this one.' : 'That payment no longer exists.' });
  }

  const tutor = await one(
    `SELECT t.id, t.user_id, t.subscription_paid_until, u.full_name
       FROM tutors t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [payment.tutor_id]);

  if (confirm) {
    const until = nextPaidUntil(tutor.subscription_paid_until);
    await query(
      `UPDATE tutors SET subscription_paid_until = $1, payment_suspended = false,
              payment_suspended_at = NULL, listed = true, suspended_until = NULL
        WHERE id = $2`, [until, tutor.id]);
    await query('UPDATE payments SET for_month = $2 WHERE id = $1', [payment.id, firstOfMonth(until)]);

    await notify(tutor.user_id, 'payment_confirmed', 'Your payment has been verified',
      `Your account is active until ${until} and you are listed in search.`);
  } else {
    await notify(tutor.user_id, 'payment_rejected', 'Your payment could not be verified',
      `${note} Send a clearer receipt and it will be checked again.`);
  }

  await logActivity(req.user, confirm ? 'payment_confirmed' : 'payment_rejected',
    `${confirm ? 'Verified' : 'Rejected'} a payment from ${tutor.full_name}`, req.ip);
  res.json({ ok: true, confirmed: confirm });
}));

// ============================================================
// The monthly cycle (run by the scheduler, daily and at start-up)
// ============================================================
//   · On and after the due day, any approved tutor whose month is
//     not covered by a VERIFIED payment is suspended and removed
//     from search.
//   · Before the due day, those same tutors get one reminder a day.
// Running it twice in a day does nothing the second time.
// ============================================================
export async function runMonthlyCycle(now = new Date()) {
  const today = todayPK(now);
  const details = await getPaymentDetails();
  const dueDay = details.due_day || DEFAULT_DUE_DAY;
  const dueDate = dueDateFor(today, dueDay);
  const result = { suspended: 0, reminded: 0 };

  const unpaid = await query(
    `SELECT t.id, t.user_id, u.full_name
       FROM tutors t JOIN users u ON u.id = t.user_id
      WHERE t.verification_status = 'verified'
        AND t.payment_suspended = false
        AND t.subscription_paid_until IS NOT NULL
        AND t.subscription_paid_until < $1::date`, [today]);

  if (today >= dueDate) {
    for (const t of unpaid) {
      const done = await one(
        `UPDATE tutors SET payment_suspended = true, payment_suspended_at = now(), listed = false
          WHERE id = $1 AND payment_suspended = false RETURNING id`, [t.id]);
      if (!done) continue;
      result.suspended += 1;
      await notify(t.user_id, 'payment_suspended', 'Your account has been suspended',
        `Your monthly payment was not verified by the ${dueDay}th, so you are hidden from search. Send your receipt to restore your account.`);
      await logActivity({ id: null, full_name: 'System', role: 'system' }, 'tutor_suspended_auto',
        `Automatically suspended ${t.full_name}: payment not verified by ${dueDate}`);
    }
  } else {
    for (const t of unpaid) {
      // Claim today's reminder atomically: a second run, or a second
      // server, finds it already taken and sends nothing.
      const claimed = await one(
        `UPDATE tutors SET last_reminder_on = $2::date
          WHERE id = $1 AND (last_reminder_on IS NULL OR last_reminder_on < $2::date)
          RETURNING id`, [t.id, today]);
      if (!claimed) continue;
      const left = Math.round((Date.parse(dueDate) - Date.parse(today)) / 86400000);
      await notify(t.user_id, 'payment_reminder', 'Monthly payment due soon',
        `Your payment is due by the ${dueDay}th — ${left} day${left === 1 ? '' : 's'} left. Send your receipt to stay in search.`);
      result.reminded += 1;
    }
  }
  return result;
}
