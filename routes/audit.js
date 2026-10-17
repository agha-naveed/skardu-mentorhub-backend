// ============================================================
// The audit log — read only
// ============================================================
// There is no route here that changes an entry, and the database
// refuses UPDATE and DELETE on the table anyway.
// ============================================================
import { Router } from 'express';
import { query, one } from '../db.js';
import { requireLogin, requireRole, handle } from '../helpers.js';

export const router = Router();

router.get('/api/admin/audit', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };

  const { user, role, action, from, to, q } = req.query;
  if (user) add('(user_name ILIKE ? OR user_id::text = ?)', `%${String(user).trim().slice(0, 80)}%`);
  if (role) add('user_role = ?', String(role).slice(0, 20));
  if (action) add('action = ?', String(action).slice(0, 60));
  if (q) add('detail ILIKE ?', `%${String(q).trim().slice(0, 100)}%`);

  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (from) { if (!day.test(from)) return res.status(400).json({ error: 'Dates look like 2026-10-31.' }); add(`created_at >= (?::date)::timestamp AT TIME ZONE 'Asia/Karachi'`, from); }
  if (to)   { if (!day.test(to))   return res.status(400).json({ error: 'Dates look like 2026-10-31.' }); add(`created_at < ((?::date) + 1)::timestamp AT TIME ZONE 'Asia/Karachi'`, to); }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = await one(`SELECT COUNT(*)::int AS n FROM activity_log ${clause}`, params);
  const entries = await query(
    `SELECT id, user_id, user_name, user_role, action, detail, ip, created_at
       FROM activity_log ${clause} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, params);
  res.json({ total: total.n, limit, offset, entries });
}));

router.get('/api/admin/audit/actions', requireLogin, requireRole('admin'), handle(async (req, res) => {
  res.json((await query('SELECT DISTINCT action FROM activity_log ORDER BY action')).map((r) => r.action));
}));
