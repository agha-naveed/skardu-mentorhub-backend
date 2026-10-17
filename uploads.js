// ============================================================
// Uploaded files
// ============================================================
// TWO folders, deliberately kept apart:
//
//   uploads/docs      CNIC and degree scans. Admin-only, served
//                     through an authenticated route.
//   uploads/avatars   Profile pictures. Meant to be looked at,
//                     served publicly.
//
// They must not share a folder. Both get random 32-character
// names, so if one folder served both, somebody could guess an
// avatar URL and be handed a CNIC instead. A separate directory
// per sensitivity level makes that impossible rather than merely
// unlikely.
// ============================================================

import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

const ROOT = path.resolve('uploads');

export const DOCS_DIR = path.join(ROOT, 'docs');
export const AVATARS_DIR = path.join(ROOT, 'avatars');

fs.mkdirSync(DOCS_DIR, { recursive: true });
fs.mkdirSync(AVATARS_DIR, { recursive: true });

// ------------------------------------------------------------
// Identity documents
// ------------------------------------------------------------
const DOC_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

function storageIn(directory) {
  return multer.diskStorage({
    destination: directory,

    filename(req, file, done) {
      // 32 random hex characters. Not guessable, and it throws away
      // whatever the phone called the file.
      const random = crypto.randomBytes(16).toString('hex');
      const extension = path.extname(file.originalname).toLowerCase();
      done(null, `${random}${extension}`);
    },
  });
}

export const upload = multer({
  storage: storageIn(DOCS_DIR),
  limits: { fileSize: 4 * 1024 * 1024 },   // 4 MB

  fileFilter(req, file, done) {
    if (DOC_TYPES.includes(file.mimetype)) done(null, true);
    else done(new Error('Upload a JPG, PNG or PDF under 4 MB.'));
  },
});

// ------------------------------------------------------------
// Profile pictures
// ------------------------------------------------------------
// Images only — no PDF. A PDF "profile picture" is either a
// mistake or somebody probing, and neither should be stored where
// it will be served publicly.
// ------------------------------------------------------------
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export const uploadAvatar = multer({
  storage: storageIn(AVATARS_DIR),
  limits: { fileSize: 3 * 1024 * 1024 },   // 3 MB is plenty for a face

  fileFilter(req, file, done) {
    if (AVATAR_TYPES.includes(file.mimetype)) done(null, true);
    else done(new Error('Use a JPG, PNG or WebP image under 3 MB.'));
  },
});

// ------------------------------------------------------------
// Rate limits
// ------------------------------------------------------------
export const uploadLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads. Try again in a few minutes.' },
});

export const avatarLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads. Try again in a few minutes.' },
});

// ------------------------------------------------------------
// Reading a file back
// ------------------------------------------------------------
// Checks a stored name really is one of ours before we read it off
// the disk. Without this, a name like "../../.env" would walk out
// of the folder — the classic path traversal bug.
//
// Each function only ever looks in ITS OWN directory, which is
// what keeps a CNIC out of the public avatar route.
// ------------------------------------------------------------
function safePathIn(directory, name, extensions) {
  const pattern = new RegExp(`^[a-f0-9]{32}\\.(${extensions.join('|')})$`, 'i');

  if (!name || !pattern.test(name)) return null;

  const full = path.join(directory, name);

  // Belt and braces: confirm the resolved path is still inside the
  // directory we meant.
  if (!full.startsWith(directory)) return null;
  if (!fs.existsSync(full)) return null;

  return full;
}

export function safeDocPath(name) {
  return safePathIn(DOCS_DIR, name, ['jpg', 'jpeg', 'png', 'webp', 'pdf']);
}

export function safeAvatarPath(name) {
  return safePathIn(AVATARS_DIR, name, ['jpg', 'jpeg', 'png', 'webp']);
}

// Kept under its old name so existing imports keep working.
export const safeUploadPath = safeDocPath;


// ------------------------------------------------------------
// Video Uploads (Temporary Buffer for Cloudinary)
// ------------------------------------------------------------
export const VIDEOS_DIR = path.join(ROOT, 'temp_videos');
fs.mkdirSync(VIDEOS_DIR, { recursive: true });

const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];

export const uploadVideo = multer({
  storage: storageIn(VIDEOS_DIR), // Reusing your existing storageIn function
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB limit (adjust as needed)

  fileFilter(req, file, done) {
    if (VIDEO_TYPES.includes(file.mimetype)) done(null, true);
    else done(new Error('Upload an MP4, WEBM, or MOV video under 50 MB.'));
  },
});