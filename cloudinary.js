// ============================================================
// Cloudinary
// ============================================================
// For video files, which are far too large to keep here. A lesson
// recording is hundreds of megabytes; serving those off a laptop
// in Skardu would fall over on the first class that watched one.
//
// The upload does NOT pass through this server. That would mean
// holding the whole file in memory here, doubling the bandwidth
// and timing out on a slow connection. Instead:
//
//   1. the app asks this server to SIGN an upload
//   2. the app sends the file straight to Cloudinary
//   3. the app tells this server the resulting url
//
// The API secret never leaves the server — only a signature that
// is valid for one upload, for a few minutes.
//
// If Cloudinary is not configured, everything still works: the
// tutor pastes a YouTube or Drive link instead, which is what the
// app falls back to.
// ============================================================

import crypto from 'crypto';
import 'dotenv/config';

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const API_KEY = process.env.CLOUDINARY_API_KEY || '';
const API_SECRET = process.env.CLOUDINARY_API_SECRET || '';

// Everything the app uploads lands in one folder, so the account
// stays tidy and a stray file is obvious.
const FOLDER = 'smart-tutor-finder/videos';

export function cloudinaryReady() {
  return Boolean(CLOUD_NAME && API_KEY && API_SECRET);
}

export function cloudinaryConfig() {
  return {
    ready: cloudinaryReady(),
    cloud_name: CLOUD_NAME,
    // A video upload goes to the 'video' endpoint, not 'image' —
    // sending it to the wrong one fails with a confusing message
    // about unsupported formats.
    upload_url: CLOUD_NAME
      ? `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/video/upload`
      : null,
    folder: FOLDER,
    // Cloudinary refuses a single upload request over 100 MB (a 413),
    // and the free plan caps a video file at 100 MB whichever way it
    // is sent. Advertising more than that just moves the failure to
    // the end of a long upload. Anything bigger goes up as a YouTube
    // or Drive link instead.
    max_bytes: 100 * 1024 * 1024,
  };
}

// ------------------------------------------------------------
// Signing one upload
// ------------------------------------------------------------
// Cloudinary wants the parameters sorted by name, joined as
// key=value pairs, with the secret on the end, then SHA-1'd. Any
// parameter the app sends must be included here or the signature
// is rejected — that is the usual cause of a mystifying 401.
// ------------------------------------------------------------
export function signUpload(extra = {}) {
  if (!cloudinaryReady()) return null;

  const params = {
    folder: FOLDER,
    timestamp: Math.floor(Date.now() / 1000),
    ...extra,
  };

  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');

  const signature = crypto
    .createHash('sha1')
    .update(toSign + API_SECRET)
    .digest('hex');

  return {
    ...params,
    signature,
    api_key: API_KEY,
    cloud_name: CLOUD_NAME,
    upload_url: `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/video/upload`,
  };
}

// ------------------------------------------------------------
// Removing a file
// ------------------------------------------------------------
// Called when a video row is deleted, so the file does not sit in
// the Cloudinary account forever running up storage on something
// nobody can reach.
//
// A failure here is logged and swallowed: the row should still go
// even if the file could not be removed, and an orphaned file is a
// smaller problem than a video the tutor cannot delete.
// ------------------------------------------------------------
export async function deleteFromCloudinary(publicId) {
  if (!cloudinaryReady() || !publicId) return false;

  const timestamp = Math.floor(Date.now() / 1000);

  const signature = crypto
    .createHash('sha1')
    .update(`public_id=${publicId}&timestamp=${timestamp}${API_SECRET}`)
    .digest('hex');

  const body = new URLSearchParams({
    public_id: publicId,
    timestamp: String(timestamp),
    api_key: API_KEY,
    signature,
  });

  try {
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/video/destroy`,
      { method: 'POST', body }
    );

    const data = await res.json();
    return data.result === 'ok';
  } catch (err) {
    console.error('[cloudinary] could not delete', publicId, err.message);
    return false;
  }
}

// Cloudinary can generate a still from a video by asking for the
// same public id as a jpg. Saves storing a separate thumbnail.
export function thumbnailFor(publicId) {
  if (!cloudinaryReady() || !publicId) return null;

  return `https://res.cloudinary.com/${CLOUD_NAME}/video/upload/so_2,w_640,h_360,c_fill/${publicId}.jpg`;
}