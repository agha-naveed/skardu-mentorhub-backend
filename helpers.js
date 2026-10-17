// ============================================================
// Small helpers used by the server
// ============================================================
import jwt from 'jsonwebtoken';
import { one, query } from './db.js';
import { JWT_SECRET as SECRET } from './lib/env.js';

// A token is stale if it was issued before the password last
// changed. Millisecond precision (the `t` claim) because the standard
// `iat` is whole seconds, which let a token issued in the same second
// as the change slip through.
export function tokenPredatesPasswordChange(data, changedAt) {
  if (!changedAt) return false;
  const issued = typeof data.t === 'number' ? data.t : (data.iat || 0) * 1000;
  return issued < new Date(changedAt).getTime();
}

// Builds the login token. The role is inside it so the app knows
// which dashboard to open straight away.
export function makeToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, t: Date.now() },
    SECRET,
    { expiresIn: '7d' }
  );
}

// Runs before any route that needs someone signed in. Reads the
// token, looks the user up, and attaches them as req.user.
export async function requireLogin(req, res, next) {
  const header = req.headers.authorization || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!raw) {
    return res.status(401).json({ error: 'Sign in to continue.' });
  }

  let data;
  try {
    data = jwt.verify(raw, SECRET);
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }

  const user = await one(
    `SELECT id, role, full_name, email, phone, class_level,
            learning_modes, avatar, account_status, academic_field, password_changed_at
       FROM users WHERE id = $1`,
    [data.id]
  );

  if (!user) {
    return res.status(401).json({ error: 'Account not found.' });
  }
  if (user.account_status === 'suspended') {
    return res.status(403).json({ error: 'This account has been suspended.' });
  }
  // A password change signs out every older session.
  if (tokenPredatesPasswordChange(data, user.password_changed_at)) {
    return res.status(401).json({ error: 'Your password was changed. Sign in again.' });
  }

  delete user.password_changed_at;
  req.user = user;
  next();
}

// Restricts a route to certain roles. Example: requireRole('admin')
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have access to this.' });
    }
    next();
  };
}

// Wraps a route so we do not need try/catch inside every one.
export function handle(fn) {
  return (req, res) => {
    fn(req, res).catch((err) => {
      console.error(err);
      if (res.headersSent) return;

      // 23505 is Postgres saying a UNIQUE rule was broken.
      if (err.code === '23505') {
        return res.status(409).json({ error: 'That record already exists.' });
      }
      res.status(500).json({ error: 'Something went wrong on our end.' });
    });
  };
}

// ------------------------------------------------------------
// Activity log
// ------------------------------------------------------------
// Records what somebody did, so an admin can see the history of
// the platform rather than only its current state.
//
// The name and role are copied in alongside the id. If the account
// is ever deleted the entry still reads sensibly instead of
// becoming "somebody did something".
//
// Logging must never break the thing being logged, so a failure
// here is written to the console and swallowed.
export async function logActivity(user, action, detail, ip = null) {
  try {
    await query(
      `INSERT INTO activity_log (user_id, user_name, user_role, action, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user?.id || null, user?.full_name || null, user?.role || null, action, detail || null, ip]
    );
  } catch (err) {
    console.error('[activity log]', err.message);
  }
}

// ------------------------------------------------------------
// Notifications
// ------------------------------------------------------------
// ONE function does all three jobs, so no caller can forget one:
//   1. saves it, for the in-app Alerts list
//   2. pushes it over the socket, for an app that is open
//   3. sends an FCM push, for an app that is closed
//
// Preferences: a person can turn off whole categories. Payment and
// account notices are never switchable — missing "you will be
// suspended" because of a setting would be a cruel bug.
// The notification is always SAVED; a preference only controls
// whether the phone is buzzed.
// ------------------------------------------------------------
const CATEGORY = {
  message: 'messages',
  class_reminder: 'classes', class_scheduled: 'classes',
  class_cancelled: 'classes', class_rescheduled: 'classes',
  assignment_new: 'assignments', assignment_marked: 'assignments',
  assignment_reminder: 'assignments', assignment_submitted: 'assignments',
  quiz_shared: 'exams', exam_cheating: 'exams',
  announcement: 'announcements',
};

// Where a tap should land, by notification type and the role that
// received it. `data.route` from the caller always wins.
const ROUTES = {
  student: {
    message: '/chats', class_reminder: '/schedule', class_scheduled: '/schedule',
    class_cancelled: '/schedule', class_rescheduled: '/schedule',
    assignment_new: '/assignments', assignment_marked: '/assignments',
    assignment_reminder: '/assignments', quiz_shared: '/quizzes',
    announcement: '/announcements', video_shared: '/videos',
    enrollment_accepted: '/enrollments', enrollment_rejected: '/enrollments',
    enrollment_completed: '/enrollments',
  },
  tutor: {
    message: '/chats', enrollment_request: '/tutor/requests',
    assignment_submitted: '/tutor/assignments', exam_cheating: '/tutor/quizzes',
    payment_confirmed: '/tutor/payment', payment_rejected: '/tutor/payment',
    payment_reminder: '/tutor/payment', payment_suspended: '/tutor/payment',
    suspended_no_payment: '/tutor/payment', subscription_paid: '/tutor/payment',
    student_left: '/tutor/requests',
  },
  admin: {
    payment_claim: '/admin/payments', registered: '/admin/tutors',
    changes_submitted: '/admin/changes',
  },
};

import { sendPush } from './lib/push.js';
import { emitToUser } from './socket.js';

export function routeFor(role, type, data) {
  return data?.route || ROUTES[role]?.[type] || '/alerts';
}

export async function notify(userId, type, title, message, data = null) {
  const owner = await one('SELECT role FROM users WHERE id = $1', [userId]);
  const payload = { ...(data || {}), type, route: routeFor(owner?.role, type, data) };

  const row = await one(
    `INSERT INTO notifications (user_id, type, title, message, data)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [userId, type, title, message, JSON.stringify(payload)]
  );

  // The live layer and push must never make a saved notification
  // "fail", so both are best-effort and their errors only logged.
  try {
    emitToUser(userId, 'notification:new', {
      id: row.id, type, title, message, data: payload, created_at: row.created_at,
    });
  } catch (err) { console.error('[notify socket]', err.message); }

  try {
    const category = CATEGORY[type];
    let allowed = true;
    if (category) {
      const prefs = await one(`SELECT ${category} AS on FROM notification_prefs WHERE user_id = $1`, [userId]);
      allowed = prefs ? prefs.on : true;
    }
    if (allowed) {
      await sendPush(userId, { title, body: message, data: { ...payload, id: row.id } });
    }
  } catch (err) { console.error('[notify push]', err.message); }

  return row;
}
