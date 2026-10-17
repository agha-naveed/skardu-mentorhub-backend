// ============================================================
// Chat pictures
// ============================================================
// Text chat lives in server.js. This adds sending a picture. The
// same rule applies: only an enrolled student and their tutor.
// Ticks: sent (saved) -> delivered (their app received it) ->
// seen (they opened the conversation).
// ============================================================
import { Router } from 'express';
import { one, query } from '../db.js';
import { requireLogin, handle, notify } from '../helpers.js';
import { emitMessage, emitToUser } from '../socket.js';
import { uploadChatImage, mediaLimit, mediaUrlFor, deleteMediaByUrl } from '../lib/media.js';
import { isUuid } from '../lib/common.js';

export const router = Router();

export async function chatPair(user, otherId) {
  if (!isUuid(otherId)) return null;
  if (user.role === 'student') {
    const r = await one(
      `SELECT t.id AS tutor_id, t.user_id AS tutor_user_id FROM enrollments e JOIN tutors t ON t.id = e.tutor_id
        WHERE e.student_id = $1 AND e.tutor_id = $2 AND e.status IN ('accepted','completed') LIMIT 1`, [user.id, otherId]);
    return r && { tutorId: r.tutor_id, studentId: user.id, recipient: r.tutor_user_id };
  }
  if (user.role === 'tutor') {
    const r = await one(
      `SELECT t.id AS tutor_id, e.student_id FROM enrollments e JOIN tutors t ON t.id = e.tutor_id
        WHERE t.user_id = $1 AND e.student_id = $2 AND e.status IN ('accepted','completed') LIMIT 1`, [user.id, otherId]);
    return r && { tutorId: r.tutor_id, studentId: r.student_id, recipient: r.student_id };
  }
  return null;
}

router.post('/api/chats/:id/image', requireLogin, mediaLimit, handle(async (req, res) => {
  const pair = await chatPair(req.user, req.params.id);
  if (!pair) return res.status(403).json({ error: 'You cannot message this person.' });

  // multer's callback style, wrapped so errors become clean 400s
  await new Promise((resolve) => uploadChatImage.single('image')(req, res, (err) => {
    if (err) {
      res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That picture is too big (5 MB at most).' : err.message });
      return resolve(false);
    }
    resolve(true);
  })).then(async (ok) => {
    if (!ok) return;
    if (!req.file) return res.status(400).json({ error: 'Choose a picture to send.' });

    const caption = String(req.body.body || '').trim().slice(0, 500);
    let message;
    try {
      message = await one(
        `INSERT INTO messages (tutor_id, student_id, sender, body, image_url)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, sender, body, image_url, read_at, delivered_at, created_at`,
        [pair.tutorId, pair.studentId, req.user.role, caption, mediaUrlFor(req.file)]);
    } catch (err) {
      deleteMediaByUrl(mediaUrlFor(req.file));
      throw err;
    }

    emitMessage(pair.tutorId, pair.studentId, message);
    emitToUser(pair.recipient, 'chat:unread', { from: req.user.id, name: req.user.full_name, preview: '📷 Photo' });
    await notify(pair.recipient, 'message', `Message from ${req.user.full_name}`, caption || '📷 Photo');
    res.status(201).json(message);
  });
}));
