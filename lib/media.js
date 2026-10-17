// ============================================================
// Files people attach: chat pictures, assignment files
// ============================================================
// Saved with a random 32-character name and an extension taken
// from the CHECKED mime type — never from what the phone called
// the file — so a ".html" renamed to ".png" cannot be served as a
// web page. Served from /api/media/:name; the unguessable name is
// the access control, the same way profile pictures work.
//
// Receipts and CNIC scans do NOT use this. Those stay in the
// admin-only documents folder.
// ============================================================
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

const ROOT = path.resolve('uploads');
export const MEDIA_DIR = path.join(ROOT, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
};
const IMAGE_ONLY = ['image/jpeg', 'image/png', 'image/webp'];

function build(allowed, maxMb, message) {
  return multer({
    storage: multer.diskStorage({
      destination: MEDIA_DIR,
      filename(req, file, done) {
        done(null, `${crypto.randomBytes(16).toString('hex')}.${TYPES[file.mimetype]}`);
      },
    }),
    limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
    fileFilter(req, file, done) {
      if (allowed.includes(file.mimetype)) done(null, true);
      else done(new Error(message));
    },
  });
}

export const uploadChatImage = build(IMAGE_ONLY, 5, 'Send a JPG, PNG or WebP picture under 5 MB.');
export const uploadAssignmentFile = build(
  Object.keys(TYPES), 8,
  'Attach a picture, PDF, Word or text file under 8 MB.'
);

export const mediaLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads. Try again in a few minutes.' },
});

export function mediaUrlFor(file) {
  return `/api/media/${file.filename}`;
}

export function safeMediaPath(name) {
  if (!/^[a-f0-9]{32}\.(jpg|png|webp|pdf|doc|docx|txt)$/.test(name || '')) return null;
  const full = path.join(MEDIA_DIR, name);
  if (!full.startsWith(MEDIA_DIR) || !fs.existsSync(full)) return null;
  return full;
}

// Removes a file we stored, ignoring anything that is not ours.
export function deleteMediaByUrl(url) {
  const name = String(url || '').split('/').pop();
  const full = safeMediaPath(name);
  if (full) fs.promises.unlink(full).catch(() => {});
}
