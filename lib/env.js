// ============================================================
// Environment — read once, validated once
// ============================================================
// The server REFUSES TO START without a real JWT secret. A
// fallback like "change-me" would mean anyone who read the code
// could forge an admin token.
// ============================================================
import 'dotenv/config';

export const NODE_ENV = process.env.NODE_ENV || 'development';
export const IS_PROD = NODE_ENV === 'production';

const secret = process.env.JWT_SECRET || '';
if (secret.length < 32 || /change-me|secret123|example/i.test(secret)) {
  throw new Error(
    'JWT_SECRET is missing or too weak. Set a random string of at least 32 ' +
    'characters in server/.env  (generate one: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))")'
  );
}
export const JWT_SECRET = secret;

// Origins allowed to call the API from a browser/webview. The Android
// app runs at http(s)://localhost (Capacitor); add your web origin(s)
// in CORS_ORIGINS, comma separated. Requests with no Origin header
// (curl, server-to-server, native HTTP) are not a CORS matter.
const DEFAULT_ORIGINS = [
  'http://localhost', 'https://localhost', 'capacitor://localhost',
  'http://localhost:5173',
];
export const CORS_ORIGINS = (process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_ORIGINS);

export function corsOrigin(origin, done) {
  if (!origin || CORS_ORIGINS.includes(origin)) return done(null, true);
  return done(null, false);
}

export const TZ_OFFSET_NOTE = 'All timestamps are stored as UTC (timestamptz).';
export const ENFORCE_HTTPS = IS_PROD && process.env.ALLOW_HTTP !== '1';
