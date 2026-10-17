// ============================================================
// Coverage areas
// ============================================================
// The administrator draws a boundary on a map and names it ("Skardu
// city", "Satpara road"). A student can then search only inside it:
// a tutor is "in" an area when their pinned location falls within the
// boundary (the maths is point_in_polygon in the database).
//
// A switch ('features' -> coverage_areas) turns the student-facing
// filter off without deleting anything, so the whole thing can be
// hidden and brought back.
// ============================================================
import { Router } from 'express';
import { query, one } from '../db.js';
import { requireLogin, requireRole, handle, logActivity } from '../helpers.js';
import { isUuid } from '../lib/common.js';

export const router = Router();

export async function areasEnabled() {
  const row = await one(`SELECT value FROM app_settings WHERE key = 'features'`);
  return row?.value?.coverage_areas !== false;
}

const round = (n) => Math.round(n * 1e6) / 1e6;

// [[lat, lng], ...] -> checked, rounded, with its centre
function checkPolygon(input) {
  if (!Array.isArray(input) || input.length < 3) return { error: 'An area needs at least 3 corners. Tap the map to add them.' };
  if (input.length > 500) return { error: 'That boundary has too many points (500 at most).' };

  const points = [];
  for (const p of input) {
    if (!Array.isArray(p) || p.length !== 2) return { error: 'The boundary is not valid. Draw it again.' };
    const lat = Number(p[0]); const lng = Number(p[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { error: 'A corner is not a real place on the map. Draw it again.' };
    }
    points.push([round(lat), round(lng)]);
  }

  // Shoelace: a boundary with no inside (all corners in a line) is useless.
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const [y1, x1] = points[i]; const [y2, x2] = points[(i + 1) % points.length];
    twice += x1 * y2 - x2 * y1;
  }
  if (Math.abs(twice) < 1e-9) return { error: 'The corners are in a straight line, so there is no area inside. Move one.' };

  return {
    points,
    center_lat: round(points.reduce((n, p) => n + p[0], 0) / points.length),
    center_lng: round(points.reduce((n, p) => n + p[1], 0) / points.length),
  };
}

function checkName(value) {
  const name = String(value || '').trim();
  if (name.length < 2) return { error: 'Give the area a name.' };
  if (name.length > 80) return { error: 'That name is too long.' };
  return { name };
}

// ---- students (and everyone signed in): the list for the filter ----
router.get('/api/areas', requireLogin, handle(async (req, res) => {
  if (!(await areasEnabled())) return res.json({ enabled: false, areas: [] });
  const areas = await query('SELECT id, name, polygon, center_lat, center_lng FROM coverage_areas ORDER BY name');
  res.json({ enabled: true, areas });
}));

// ---- administrator ----
router.get('/api/admin/areas', requireLogin, requireRole('admin'), handle(async (req, res) => {
  res.json({
    enabled: await areasEnabled(),
    areas: await query(
      `SELECT a.id, a.name, a.polygon, a.center_lat, a.center_lng, a.updated_at,
              (SELECT COUNT(*)::int FROM tutors t
                WHERE t.verification_status = 'verified'
                  AND point_in_polygon(t.latitude::float8, t.longitude::float8, a.polygon)) AS tutors
         FROM coverage_areas a ORDER BY a.name`),
  });
}));

router.post('/api/admin/areas', requireLogin, requireRole('admin'), handle(async (req, res) => {
  const n = checkName(req.body.name); if (n.error) return res.status(400).json({ error: n.error });
  const p = checkPolygon(req.body.polygon); if (p.error) return res.status(400).json({ error: p.error });

  if (await one('SELECT 1 AS x FROM coverage_areas WHERE lower(name) = lower($1)', [n.name])) {
    return res.status(409).json({ error: 'There is already an area with that name.' });
  }
  const area = await one(
    `INSERT INTO coverage_areas (name, polygon, center_lat, center_lng, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, name`,
    [n.name, JSON.stringify(p.points), p.center_lat, p.center_lng, req.user.id]);
  await logActivity(req.user, 'area_created', `Drew the area "${n.name}" (${p.points.length} corners)`, req.ip);
  res.status(201).json(area);
}));

router.put('/api/admin/areas/:id', requireLogin, requireRole('admin'), handle(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'That area does not exist.' });
  const n = checkName(req.body.name); if (n.error) return res.status(400).json({ error: n.error });
  const p = checkPolygon(req.body.polygon); if (p.error) return res.status(400).json({ error: p.error });

  if (await one('SELECT 1 AS x FROM coverage_areas WHERE lower(name) = lower($1) AND id <> $2', [n.name, req.params.id])) {
    return res.status(409).json({ error: 'There is already an area with that name.' });
  }
  const area = await one(
    `UPDATE coverage_areas SET name = $2, polygon = $3, center_lat = $4, center_lng = $5, updated_at = now()
      WHERE id = $1 RETURNING id, name`,
    [req.params.id, n.name, JSON.stringify(p.points), p.center_lat, p.center_lng]);
  if (!area) return res.status(404).json({ error: 'That area does not exist.' });
  await logActivity(req.user, 'area_changed', `Changed the area "${n.name}"`, req.ip);
  res.json(area);
}));

router.delete('/api/admin/areas/:id', requireLogin, requireRole('admin'), handle(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'That area does not exist.' });
  const gone = await one('DELETE FROM coverage_areas WHERE id = $1 RETURNING name', [req.params.id]);
  if (!gone) return res.status(404).json({ error: 'That area does not exist.' });
  await logActivity(req.user, 'area_deleted', `Deleted the area "${gone.name}"`, req.ip);
  res.json({ ok: true });
}));

// ---- the switch ----
router.put('/api/admin/features', requireLogin, requireRole('admin'), handle(async (req, res) => {
  if (typeof req.body.coverage_areas !== 'boolean') return res.status(400).json({ error: 'Send true or false.' });
  await query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES ('features', $1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify({ coverage_areas: req.body.coverage_areas }), req.user.id]);
  await logActivity(req.user, 'settings_changed', `${req.body.coverage_areas ? 'Showed' : 'Hid'} the area filter for students`, req.ip);
  res.json({ coverage_areas: req.body.coverage_areas });
}));
