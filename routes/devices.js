// ============================================================
// Push devices, notification preferences, sign-out
// ============================================================
import { Router } from 'express';
import { query, one } from '../db.js';
import { requireLogin, handle, logActivity } from '../helpers.js';

export const router = Router();

const CATEGORIES = ['messages', 'classes', 'assignments', 'exams', 'announcements'];

// The phone registers its FCM token after sign-in. A token belongs to
// ONE person: if somebody else signs in on the same phone, the token
// moves to them, so the previous user stops getting this phone's pushes.
router.post('/api/devices', requireLogin, handle(async (req, res) => {
  const token = String(req.body.token || '').trim();
  const platform = ['android', 'ios', 'web'].includes(req.body.platform) ? req.body.platform : 'android';
  if (token.length < 20 || token.length > 4096) return res.status(400).json({ error: 'That device token is not valid.' });

  await query(
    `INSERT INTO device_tokens (user_id, token, platform) VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id,
       platform = EXCLUDED.platform, last_seen_at = now()`,
    [req.user.id, token, platform]
  );
  res.json({ ok: true });
}));

router.delete('/api/devices', requireLogin, handle(async (req, res) => {
  const token = String(req.body?.token || '');
  await query('DELETE FROM device_tokens WHERE token = $1 AND user_id = $2', [token, req.user.id]);
  res.json({ ok: true });
}));

// Sign out: forget this phone's token (so a signed-out phone is not
// buzzed) and put it in the audit trail.
router.post('/api/auth/logout', requireLogin, handle(async (req, res) => {
  const token = String(req.body?.token || '');
  if (token) await query('DELETE FROM device_tokens WHERE token = $1 AND user_id = $2', [token, req.user.id]);
  await logActivity(req.user, 'logout', 'Signed out', req.ip);
  res.json({ ok: true });
}));

router.get('/api/notification-prefs', requireLogin, handle(async (req, res) => {
  const row = await one('SELECT * FROM notification_prefs WHERE user_id = $1', [req.user.id]);
  const out = {};
  for (const c of CATEGORIES) out[c] = row ? row[c] : true;
  res.json(out);
}));

router.put('/api/notification-prefs', requireLogin, handle(async (req, res) => {
  const current = await one('SELECT * FROM notification_prefs WHERE user_id = $1', [req.user.id]);
  const next = {};
  for (const c of CATEGORIES) {
    next[c] = typeof req.body[c] === 'boolean' ? req.body[c] : (current ? current[c] : true);
  }
  await query(
    `INSERT INTO notification_prefs (user_id, ${CATEGORIES.join(', ')}, updated_at)
     VALUES ($1, ${CATEGORIES.map((_, i) => `$${i + 2}`).join(', ')}, now())
     ON CONFLICT (user_id) DO UPDATE SET
       ${CATEGORIES.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()`,
    [req.user.id, ...CATEGORIES.map((c) => next[c])]
  );
  await logActivity(req.user, 'settings_changed', 'Changed notification preferences', req.ip);
  res.json(next);
}));
