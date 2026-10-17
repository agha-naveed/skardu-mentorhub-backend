// ============================================================
// Firebase Cloud Messaging — push when the app is closed
// ============================================================
// Credentials, either way:
//   FIREBASE_SERVICE_ACCOUNT   the service-account JSON, as one line
//   firebase-key.json          the same file next to server.js
//                              (already in .gitignore)
// Without credentials push is simply off — the in-app Socket.IO
// updates and the Alerts list keep working.
//
// A token Firebase says is dead is deleted here, so one reinstalled
// phone does not leave a dead token that is tried forever.
// ============================================================
import fs from 'fs';
import { query } from '../db.js';

let messaging = null;
let tried = false;

async function getMessaging() {
  if (messaging || tried) return messaging;
  tried = true;

  try {
    let credentials = null;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else if (fs.existsSync('./firebase-key.json')) {
      credentials = JSON.parse(fs.readFileSync('./firebase-key.json', 'utf8'));
    }
    if (!credentials) return null;

    const { initializeApp, cert, getApps } = await import('firebase-admin/app');
    const { getMessaging: gm } = await import('firebase-admin/messaging');
    const app = getApps()[0] || initializeApp({ credential: cert(credentials) });
    messaging = gm(app);
  } catch (err) {
    console.error('[push] Firebase failed to start:', err.message);
  }
  return messaging;
}

// Tests swap in a fake so no real Firebase is needed.
export function setMessagingForTests(fake) {
  messaging = fake;
  tried = true;
}

export function pushReady() { return Boolean(messaging); }

const DEAD = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

// FCM data values must all be strings.
function stringify(data = {}) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v != null) out[k] = String(v);
  }
  return out;
}

export async function sendPush(userId, { title, body, data }) {
  const m = await getMessaging();
  if (!m) return { sent: 0, skipped: 'not-configured' };

  const rows = await query('SELECT token FROM device_tokens WHERE user_id = $1', [userId]);
  if (rows.length === 0) return { sent: 0 };

  const tokens = rows.map((r) => r.token);
  const response = await m.sendEachForMulticast({
    tokens,
    notification: { title: String(title).slice(0, 120), body: String(body || '').slice(0, 240) },
    data: stringify(data),
    // What makes it ring like any other app:
    //   priority high   wakes a sleeping phone (Doze) and delivers at once
    //   channelId       the loud channel the app creates (sound,
    //                   vibration, heads-up banner) — see push.js in the app
    //   sound/vibrate   use the phone's own notification sound
    //   visibility      shown on the lock screen
    //   ttl             if the phone is off, still deliver for a day
    android: {
      priority: 'high',
      ttl: 24 * 3600 * 1000,
      notification: {
        channelId: 'default',
        sound: 'default',
        defaultSound: true,
        defaultVibrateTimings: true,
        defaultLightSettings: true,
        visibility: 'public',
      },
    },
  });

  const dead = [];
  response.responses.forEach((r, i) => {
    if (!r.success && DEAD.has(r.error?.code)) dead.push(tokens[i]);
  });
  if (dead.length) {
    await query('DELETE FROM device_tokens WHERE token = ANY($1::text[])', [dead]);
  }

  return { sent: response.successCount, removed: dead.length };
}
