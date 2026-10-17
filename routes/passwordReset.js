// ============================================================
// Forgot password — by WhatsApp code
// ============================================================
//   1. POST /api/auth/forgot-password   {phone}
//   2. POST /api/auth/verify-otp        {phone, code}   -> reset_token
//   3. POST /api/auth/reset-password    {phone, reset_token, password}
//
// The rules, all enforced here:
//   · code is 6 digits, stored hashed, valid 5 minutes
//   · it works ONCE, and allows 5 wrong guesses
//   · a resend needs a 60 second wait; 5 codes an hour per phone,
//     10 an hour per IP
//   · the answer is identical whether or not the number is
//     registered — nobody can use this to find out who has an
//     account
//   · the change-password step needs the token that only a correct
//     code produces
// ============================================================
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { query, one } from '../db.js';
import { handle, logActivity, notify } from '../helpers.js';
import { tidyPhone, checkPhone, checkPassword } from '../validate.js';
import { sendWhatsAppOtp } from '../lib/whatsapp.js';

export const router = Router();

export const OTP_TTL_MIN = 5;
export const RESEND_COOLDOWN_SEC = 60;
export const MAX_PER_PHONE_HOUR = 5;
export const MAX_PER_IP_HOUR = 10;
export const MAX_ATTEMPTS = 5;
const RESET_TOKEN_TTL_MIN = 10;

const GENERIC_SENT = 'If that number is registered, a 6-digit code has been sent to its WhatsApp.';
const BAD_CODE = 'That code is not right or has expired.';
const LOCKED = 'Too many wrong tries. Ask for a new code.';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const maskPhone = (p) => `${p.slice(0, 4)}***${p.slice(-3)}`;

// A blunt per-IP brake in front of the precise per-phone rules.
// Skipped under test so the suite can hammer the endpoints.
const skipInTest = () => process.env.NODE_ENV === 'test' && process.env.TEST_RATE_LIMITS !== '1';
const mk = (max, message) => rateLimit({
  windowMs: 15 * 60 * 1000, max, skip: skipInTest,
  standardHeaders: true, legacyHeaders: false,
  message: { error: message },
});
const forgotBrake = mk(20, 'Too many requests. Try again in a few minutes.');
const verifyBrake = mk(40, 'Too many attempts. Try again in a few minutes.');
const resetBrake  = mk(20, 'Too many attempts. Try again in a few minutes.');

// ------------------------------------------------------------
// 1. Ask for a code
// ------------------------------------------------------------
router.post('/api/auth/forgot-password', forgotBrake, handle(async (req, res) => {
  const phone = tidyPhone(req.body.phone);
  const problem = checkPhone(req.body.phone);
  if (problem) return res.status(400).json({ error: problem });

  const ip = req.ip || null;

  // Cooldown and hourly limits count EVERY request, registered or
  // not, so the answer cannot reveal which numbers exist.
  const last = await one(
    `SELECT EXTRACT(EPOCH FROM (now() - created_at))::int AS age
       FROM password_resets WHERE phone = $1 ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  if (last && last.age < RESEND_COOLDOWN_SEC) {
    const wait = RESEND_COOLDOWN_SEC - last.age;
    res.set('Retry-After', String(wait));
    return res.status(429).json({
      error: `Please wait ${wait} second${wait === 1 ? '' : 's'} before asking for another code.`,
      retry_after: wait,
    });
  }

  const byPhone = await one(
    `SELECT COUNT(*)::int AS n FROM password_resets
      WHERE phone = $1 AND created_at > now() - interval '1 hour'`, [phone]);
  const byIp = ip ? await one(
    `SELECT COUNT(*)::int AS n FROM password_resets
      WHERE ip = $1 AND created_at > now() - interval '1 hour'`, [ip]) : { n: 0 };

  if (byPhone.n >= MAX_PER_PHONE_HOUR || byIp.n >= MAX_PER_IP_HOUR) {
    return res.status(429).json({ error: 'Too many codes requested. Try again in an hour.' });
  }

  const user = await one(
    `SELECT id, role, full_name, account_status FROM users WHERE phone = $1`, [phone]);

  // Always make a code and a hash, registered or not, so the two
  // paths cost about the same and nothing leaks through timing.
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const codeHash = await bcrypt.hash(code, 8);
  const eligible = Boolean(user) && user.account_status !== 'suspended';

  // Only the newest code may work.
  await query(
    `UPDATE password_resets SET used_at = now()
      WHERE phone = $1 AND used_at IS NULL`, [phone]);

  await query(
    `INSERT INTO password_resets (user_id, phone, code_hash, expires_at, ip)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval, $5)`,
    [eligible ? user.id : null, phone, codeHash, String(OTP_TTL_MIN), ip]
  );

  if (eligible) {
    // Not awaited: the reply must not wait on (or reveal a failure
    // of) WhatsApp. A failed send is logged for the operator.
    sendWhatsAppOtp(phone, code).catch((err) =>
      console.error('[otp] WhatsApp send failed:', err.message));
  }

  await logActivity(
    eligible ? user : null,
    'password_reset_requested',
    `Password reset requested for ${maskPhone(phone)}`,
    ip
  );

  res.json({
    ok: true,
    message: GENERIC_SENT,
    resend_after: RESEND_COOLDOWN_SEC,
    expires_in: OTP_TTL_MIN * 60,
  });
}));

// ------------------------------------------------------------
// 2. Check the code
// ------------------------------------------------------------
router.post('/api/auth/verify-otp', verifyBrake, handle(async (req, res) => {
  const phone = tidyPhone(req.body.phone);
  const code = String(req.body.code || '').trim();

  if (!/^\d{6}$/.test(code) || checkPhone(req.body.phone)) {
    return res.status(400).json({ error: BAD_CODE });
  }

  const row = await one(
    `SELECT id, user_id, code_hash FROM password_resets
      WHERE phone = $1 AND used_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  if (!row) return res.status(400).json({ error: BAD_CODE });

  // Count the guess BEFORE checking it, in one atomic statement.
  // Checking first and counting after would let a burst of parallel
  // requests all get "attempt 1".
  const counted = await one(
    `UPDATE password_resets SET attempts = attempts + 1
      WHERE id = $1 AND used_at IS NULL AND attempts < $2
      RETURNING attempts`,
    [row.id, MAX_ATTEMPTS]
  );
  if (!counted) {
    await query(`UPDATE password_resets SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [row.id]);
    return res.status(429).json({ error: LOCKED });
  }

  const match = await bcrypt.compare(code, row.code_hash);

  if (!match || !row.user_id) {
    const user = row.user_id ? { id: row.user_id } : null;
    await logActivity(user, 'otp_failed', `Wrong reset code for ${maskPhone(phone)}`, req.ip);

    if (counted.attempts >= MAX_ATTEMPTS) {
      await query(`UPDATE password_resets SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [row.id]);
      return res.status(429).json({ error: LOCKED });
    }
    return res.status(400).json({ error: BAD_CODE, attempts_left: MAX_ATTEMPTS - counted.attempts });
  }

  // Correct. Burn the code so it can never be used again, and hand
  // back a one-time token for the change-password step.
  const token = crypto.randomBytes(32).toString('hex');
  const burned = await one(
    `UPDATE password_resets
        SET used_at = now(), reset_hash = $2,
            reset_expires_at = now() + ($3 || ' minutes')::interval
      WHERE id = $1 AND used_at IS NULL
      RETURNING user_id`,
    [row.id, sha256(token), String(RESET_TOKEN_TTL_MIN)]
  );
  // Two requests with the same right code: only one wins.
  if (!burned) return res.status(400).json({ error: BAD_CODE });

  const user = await one('SELECT id, role, full_name FROM users WHERE id = $1', [burned.user_id]);
  await logActivity(user, 'otp_verified', 'Reset code accepted', req.ip);

  res.json({ ok: true, reset_token: token, expires_in: RESET_TOKEN_TTL_MIN * 60 });
}));

// ------------------------------------------------------------
// 3. Choose the new password
// ------------------------------------------------------------
router.post('/api/auth/reset-password', resetBrake, handle(async (req, res) => {
  const phone = tidyPhone(req.body.phone);
  const token = String(req.body.reset_token || '');
  const password = req.body.password;

  const problem = checkPassword(password);
  if (problem) return res.status(400).json({ error: problem });

  if (!/^[a-f0-9]{64}$/.test(token) || checkPhone(req.body.phone)) {
    return res.status(400).json({ error: 'This reset link has expired. Start again.' });
  }

  // Claim the token atomically — one use only.
  const claimed = await one(
    `UPDATE password_resets SET reset_used_at = now()
      WHERE phone = $1 AND reset_hash = $2
        AND reset_used_at IS NULL AND reset_expires_at > now()
        AND user_id IS NOT NULL
      RETURNING user_id`,
    [phone, sha256(token)]
  );
  if (!claimed) {
    return res.status(400).json({ error: 'This reset link has expired. Start again.' });
  }

  const hash = await bcrypt.hash(String(password), 10);
  const user = await one(
    `UPDATE users SET password = $1, password_changed_at = now()
      WHERE id = $2 RETURNING id, role, full_name`,
    [hash, claimed.user_id]
  );

  await logActivity(user, 'password_changed', 'Password changed with a WhatsApp code', req.ip);
  await notify(user.id, 'password_changed', 'Your password was changed',
    'If this was not you, contact the administrator straight away.');

  res.json({
    ok: true,
    message: 'Your password has been changed. Sign in with your new password.',
  });
}));
