// ============================================================
// Sharing videos, and knowing how long they were watched
// ============================================================
// SHARING. A video already carries its subject, its class range and
// (optionally) its field, so the Share screen does NOT ask for them
// again — asking twice is how they ended up contradicting each other.
// Instead the server works out, from the video itself, who may
// receive it, and says WHY anybody left out is left out:
//
//   · not enrolled with this tutor for that subject
//   · attends in person (videos are for online learners)
//   · in a class outside the video's range
//   · in a different field (Engineering / Medical / Computer Science)
//
// WATCHING. The lesson plays inside the app, which reports real
// playing time every few seconds. Each sitting is its own row, so the
// tutor sees a history — when, how long, how far — and not one total.
// ============================================================
import { Router } from 'express';
import { query, one } from '../db.js';
import { requireLogin, requireRole, handle, logActivity, notify } from '../helpers.js';
import { isUuid } from '../lib/common.js';
import { FIELDS, cleanField } from '../lib/fields.js';

export const router = Router();

const ONLINE = 'online';
const NOT_ONLINE = { error: 'Videos are for online teaching. Tick "online" on your profile to use them.' };
const MAX_PING_SECONDS = 30;       // one report can never credit more than this

const onlineTutor = (userId) =>
  one('SELECT id FROM tutors WHERE user_id = $1 AND $2 = ANY(teaching_modes)', [userId, ONLINE]);

const idsFrom = (value) =>
  (Array.isArray(value) ? value : String(value || '').split(',')).map((v) => String(v).trim()).filter(Boolean);

// ------------------------------------------------------------
// Who may receive these videos?
// ------------------------------------------------------------
export async function shareCandidates(tutorId, videoIds, opts = {}) {
  const videos = await query(
    `SELECT v.id, v.title, v.subject_id, s.subject_name, v.class_from, v.class_to, v.academic_field
       FROM videos v JOIN subjects s ON s.id = v.subject_id
      WHERE v.tutor_id = $1 AND v.id = ANY($2::uuid[])`,
    [tutorId, videoIds]
  );
  if (videos.length === 0) return { error: 'Those videos do not exist.' };

  if (new Set(videos.map((v) => v.subject_id)).size > 1) {
    return { error: 'Share videos of one subject at a time, so each student only gets what is meant for them.' };
  }
  const fields = [...new Set(videos.map((v) => v.academic_field).filter(Boolean))];
  if (fields.length > 1) {
    return { error: 'Those videos are for different fields. Share them one field at a time.' };
  }

  const subject = videos[0];
  const classFrom = Math.max(...videos.map((v) => v.class_from));
  const classTo = Math.min(...videos.map((v) => v.class_to));
  const videoField = fields[0] || null;

  const values = [tutorId, subject.subject_id];
  const where = [`e.tutor_id = $1`, `e.status IN ('accepted', 'completed')`];

  // "Who joined" filters the tutor already had: a month, or two dates.
  if (opts.month) {
    values.push(`${opts.month}-01`);
    where.push(`e.created_at >= $${values.length}::date AND e.created_at < ($${values.length}::date + interval '1 month')`);
  }
  if (opts.enrolled_from) { values.push(opts.enrolled_from); where.push(`e.created_at >= $${values.length}::date`); }
  if (opts.enrolled_to)   { values.push(opts.enrolled_to);   where.push(`e.created_at < ($${values.length}::date + 1)`); }

  const rows = await query(
    `SELECT DISTINCT ON (u.id)
            u.id, u.full_name, u.avatar, u.class_level, u.academic_field,
            e.learning_mode, e.created_at AS enrolled_at,
            EXISTS (SELECT 1 FROM enrollment_subjects es
                     WHERE es.enrollment_id = e.id AND es.subject_id = $2) AS in_subject,
            (SELECT string_agg(sj.subject_name, ', ' ORDER BY sj.subject_name)
               FROM enrollment_subjects es JOIN subjects sj ON sj.id = es.subject_id
              WHERE es.enrollment_id = e.id) AS subjects
       FROM enrollments e JOIN users u ON u.id = e.student_id
      WHERE ${where.join(' AND ')}
      ORDER BY u.id, e.created_at DESC`,
    values
  );

  const eligible = [];
  const excluded = [];

  for (const r of rows) {
    const person = {
      id: r.id, full_name: r.full_name, avatar: r.avatar, class_level: r.class_level,
      academic_field: r.academic_field, field_label: FIELDS[r.academic_field] || null, subjects: r.subjects,
    };

    let reason = null;
    if (r.learning_mode !== ONLINE) reason = 'Attends in person, so does not use videos';
    else if (!r.in_subject) reason = `Not enrolled in ${subject.subject_name}`;
    else if (r.class_level != null && (r.class_level < classFrom || r.class_level > classTo)) {
      reason = `In Class ${r.class_level}; this video is for Class ${classFrom}–${classTo}`;
    } else if (videoField && r.academic_field !== videoField) {
      reason = r.academic_field ? `Follows ${FIELDS[r.academic_field]}, not ${FIELDS[videoField]}` : 'Has not set a field yet';
    }

    if (reason) { excluded.push({ ...person, reason }); continue; }

    // The tutor's own narrowing by field (a filter, not an exclusion).
    if (opts.field && r.academic_field !== opts.field) continue;
    eligible.push(person);
  }

  eligible.sort((a, b) => a.full_name.localeCompare(b.full_name));
  excluded.sort((a, b) => a.full_name.localeCompare(b.full_name));

  return {
    videos,
    rule: {
      subject_id: subject.subject_id, subject_name: subject.subject_name,
      class_from: classFrom, class_to: classTo,
      field: videoField, field_label: FIELDS[videoField] || null,
    },
    eligible,
    excluded,
  };
}

router.get('/api/tutor/share-students', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await onlineTutor(req.user.id);
  if (!tutor) return res.status(403).json(NOT_ONLINE);

  const ids = idsFrom(req.query.video_ids);
  if (ids.length === 0 || !ids.every(isUuid)) return res.status(400).json({ error: 'Choose a video first.' });

  let field = null;
  if (req.query.field) {
    const fc = cleanField(req.query.field);
    if (fc.error) return res.status(400).json({ error: fc.error });
    field = fc.value;
  }
  if (req.query.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month)) {
    return res.status(400).json({ error: 'Month must look like 2026-10.' });
  }

  const result = await shareCandidates(tutor.id, ids, {
    field, month: req.query.month, enrolled_from: req.query.enrolled_from, enrolled_to: req.query.enrolled_to,
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

// ------------------------------------------------------------
// Share (the server re-checks eligibility; the screen is not trusted)
// ------------------------------------------------------------
router.post('/api/tutor/videos/release', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const { video_ids: videoIds = [], student_ids: studentIds = [], release_on: releaseOn } = req.body || {};

  if (!Array.isArray(videoIds) || videoIds.length === 0 || !Array.isArray(studentIds) || studentIds.length === 0) {
    return res.status(400).json({ error: 'Choose at least one video and one student.' });
  }
  if (!videoIds.every(isUuid) || !studentIds.every(isUuid)) {
    return res.status(400).json({ error: 'Those videos or students do not exist.' });
  }
  if (releaseOn && !/^\d{4}-\d{2}-\d{2}$/.test(releaseOn)) {
    return res.status(400).json({ error: 'Choose a date.' });
  }

  const tutor = await onlineTutor(req.user.id);
  if (!tutor) return res.status(403).json(NOT_ONLINE);

  const result = await shareCandidates(tutor.id, videoIds);
  if (result.error) return res.status(400).json({ error: result.error });

  const wanted = new Set(studentIds);
  const students = result.eligible.filter((s) => wanted.has(s.id));
  // Anybody the tutor ticked who is not allowed to receive this video, and why.
  const skipped = result.excluded.filter((s) => wanted.has(s.id));

  if (students.length === 0) {
    return res.status(400).json({
      error: skipped.length
        ? `None of those students can receive this video. ${skipped[0].full_name}: ${skipped[0].reason}.`
        : 'None of those students can receive this video.',
      skipped: skipped.map((s) => ({ id: s.id, full_name: s.full_name, reason: s.reason })),
    });
  }

  const date = releaseOn || new Date().toISOString().slice(0, 10);

  for (const video of result.videos) {
    for (const student of students) {
      await query(
        `INSERT INTO video_releases (video_id, student_id, release_on) VALUES ($1, $2, $3)
         ON CONFLICT (video_id, student_id) DO UPDATE SET release_on = EXCLUDED.release_on`,
        [video.id, student.id, date]
      );
    }
  }

  // Only tell them about something they can watch NOW.
  const today = new Date().toISOString().slice(0, 10);
  if (date <= today) {
    for (const student of students) {
      await notify(student.id, 'video_shared',
        result.videos.length === 1 ? 'A new video from your tutor' : `${result.videos.length} new videos from your tutor`,
        `${req.user.full_name} shared ${result.videos.length === 1 ? `"${result.videos[0].title}"` : `${result.videos.length} videos`} with you.`,
        { route: '/videos' });
    }
  }

  await logActivity(req.user, 'videos_released',
    `Shared ${result.videos.length} video${result.videos.length === 1 ? '' : 's'} (${result.rule.subject_name}) with ${students.length} student${students.length === 1 ? '' : 's'} from ${date}`, req.ip);

  res.json({
    ok: true, videos: result.videos.length, students: students.length,
    release_on: date, scheduled: date > today,
    skipped: skipped.map((s) => ({ id: s.id, full_name: s.full_name, reason: s.reason })),
  });
}));

// ------------------------------------------------------------
// The player reports in (every ~10 s while the video plays)
// ------------------------------------------------------------
//   first report          -> no session_id: a new sitting starts
//   following reports     -> session_id: seconds are added to it
// `seconds` is playing time since the previous report. It is capped,
// AND limited to the real time that has passed on the server's clock,
// so a modified app cannot credit an hour of watching in a minute.
// ------------------------------------------------------------
router.post('/api/videos/:id/watch', requireLogin, requireRole('student'), handle(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'That video was not shared with you.' });

  const body = req.body || {};
  const claimed = Math.max(0, Math.min(Number(body.seconds) || 0, MAX_PING_SECONDS));
  const position = Math.max(0, Math.min(Math.round(Number(body.position) || 0), 86400));
  const method = body.method === 'open' ? 'open' : 'playing';

  const release = await one(
    `SELECT r.video_id FROM video_releases r
      WHERE r.video_id = $1 AND r.student_id = $2 AND r.release_on <= CURRENT_DATE
        AND EXISTS (SELECT 1 FROM videos v JOIN enrollments e ON e.tutor_id = v.tutor_id
                     WHERE v.id = r.video_id AND e.student_id = r.student_id
                       AND e.status IN ('accepted', 'completed'))`,
    [req.params.id, req.user.id]
  );
  if (!release) return res.status(404).json({ error: 'That video was not shared with you.' });

  let session;
  let isNew = false;

  if (body.session_id) {
    if (!isUuid(body.session_id)) return res.status(404).json({ error: 'Unknown viewing session.' });
    session = await one(
      'SELECT id, last_seen_at FROM video_watch_sessions WHERE id = $1 AND video_id = $2 AND student_id = $3',
      [body.session_id, req.params.id, req.user.id]
    );
    if (!session) return res.status(404).json({ error: 'Unknown viewing session.' });
  } else {
    session = await one(
      'INSERT INTO video_watch_sessions (video_id, student_id, method) VALUES ($1, $2, $3) RETURNING id, last_seen_at',
      [req.params.id, req.user.id, method]
    );
    isNew = true;
  }

  const elapsed = Math.max(0, (Date.now() - new Date(session.last_seen_at).getTime()) / 1000);
  const credit = isNew ? 0 : Math.round(Math.min(claimed, elapsed + 1.5));

  await query(
    `UPDATE video_watch_sessions
        SET seconds = seconds + $2, last_seen_at = now(),
            max_position_seconds = GREATEST(max_position_seconds, $3),
            completed = completed OR $4
      WHERE id = $1`,
    [session.id, credit, position, Boolean(body.completed)]
  );

  const total = await one(
    `UPDATE video_releases
        SET watched_seconds = watched_seconds + $3,
            watched_at      = COALESCE(watched_at, now()),
            last_watched_at = now(),
            watch_count     = watch_count + CASE WHEN $4 THEN 1 ELSE 0 END
      WHERE video_id = $1 AND student_id = $2
      RETURNING watched_seconds, watch_count`,
    [req.params.id, req.user.id, credit, isNew]
  );

  // The player knows the real length; trust it over the tutor's guess.
  const duration = Math.round(Number(body.duration) || 0);
  if (duration >= 1 && duration <= 86400) {
    await query('UPDATE videos SET duration_seconds = $2 WHERE id = $1 AND duration_seconds IS NULL', [req.params.id, duration]);
  }

  res.json({ ok: true, session_id: session.id, watched_seconds: total.watched_seconds, watch_count: total.watch_count });
}));

// ------------------------------------------------------------
// History: tutor sees every student, then every sitting
// ------------------------------------------------------------
router.get('/api/tutor/videos/:id/watchers', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await onlineTutor(req.user.id);
  if (!tutor) return res.status(403).json(NOT_ONLINE);
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'That video does not exist.' });

  const video = await one(
    `SELECT id, title, duration_mins, duration_seconds,
            COALESCE(duration_seconds, duration_mins * 60) AS length_seconds
       FROM videos WHERE id = $1 AND tutor_id = $2`, [req.params.id, tutor.id]);
  if (!video) return res.status(404).json({ error: 'That video does not exist.' });

  const watchers = await query(
    `SELECT u.id AS student_id, u.full_name, u.avatar, u.class_level, u.academic_field,
            r.release_on, r.watched_at, r.last_watched_at, r.watch_count, r.watched_seconds,
            ROUND(r.watched_seconds / 60.0, 1)::float AS watched_minutes,
            COALESCE((SELECT MAX(w.max_position_seconds) FROM video_watch_sessions w
                       WHERE w.video_id = r.video_id AND w.student_id = r.student_id), 0) AS furthest_seconds,
            COALESCE((SELECT bool_or(w.completed) FROM video_watch_sessions w
                       WHERE w.video_id = r.video_id AND w.student_id = r.student_id), false) AS completed
       FROM video_releases r JOIN users u ON u.id = r.student_id
      WHERE r.video_id = $1
      ORDER BY r.last_watched_at DESC NULLS LAST, u.full_name`,
    [video.id]
  );

  const length = Number(video.length_seconds) || 0;
  res.json({
    video,
    watchers: watchers.map((w) => ({
      ...w,
      furthest_percent: length ? Math.min(100, Math.round((w.furthest_seconds / length) * 100)) : null,
      field_label: FIELDS[w.academic_field] || null,
    })),
  });
}));

async function sessionsFor(videoId, studentId) {
  return query(
    `SELECT id, started_at, last_seen_at AS ended_at, seconds, max_position_seconds, completed, method
       FROM video_watch_sessions WHERE video_id = $1 AND student_id = $2
      ORDER BY started_at DESC LIMIT 100`, [videoId, studentId]);
}

router.get('/api/tutor/videos/:id/history/:studentId', requireLogin, requireRole('tutor'), handle(async (req, res) => {
  const tutor = await onlineTutor(req.user.id);
  if (!tutor) return res.status(403).json(NOT_ONLINE);
  if (!isUuid(req.params.id) || !isUuid(req.params.studentId)) return res.status(404).json({ error: 'No such history.' });

  const row = await one(
    `SELECT v.id, v.title, COALESCE(v.duration_seconds, v.duration_mins * 60) AS length_seconds,
            u.id AS student_id, u.full_name, r.watched_seconds
       FROM videos v
       JOIN video_releases r ON r.video_id = v.id AND r.student_id = $3
       JOIN users u ON u.id = r.student_id
      WHERE v.id = $1 AND v.tutor_id = $2`, [req.params.id, tutor.id, req.params.studentId]);
  if (!row) return res.status(404).json({ error: 'No such history.' });

  res.json({
    video: { id: row.id, title: row.title, length_seconds: row.length_seconds },
    student: { id: row.student_id, full_name: row.full_name },
    total_seconds: row.watched_seconds,
    sessions: await sessionsFor(row.id, row.student_id),
  });
}));

// A student's own history for a lesson.
router.get('/api/videos/:id/history', requireLogin, requireRole('student'), handle(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'That video was not shared with you.' });
  const r = await one('SELECT watched_seconds FROM video_releases WHERE video_id = $1 AND student_id = $2', [req.params.id, req.user.id]);
  if (!r) return res.status(404).json({ error: 'That video was not shared with you.' });
  res.json({ total_seconds: r.watched_seconds, sessions: await sessionsFor(req.params.id, req.user.id) });
}));
