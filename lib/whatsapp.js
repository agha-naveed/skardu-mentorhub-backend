// ============================================================
// WhatsApp — sending the reset code, through Baileys
// ============================================================
// Baileys is an UNOFFICIAL WhatsApp Web client. The server links to
// one WhatsApp account as a "linked device" (like WhatsApp Web) and
// sends the code from that number.
//
// Turn it on:        WHATSAPP_ENABLED=1
// Link the account (once):
//   · scan the QR printed in the server log with
//     WhatsApp > Settings > Linked devices > Link a device, or
//   · set WHATSAPP_PAIRING_NUMBER=923001234567 (the number that will
//     SEND the codes, with country code, no +). The log then prints
//     an 8-character code to type under
//     Linked devices > Link with phone number instead.
// The login is saved in WHATSAPP_AUTH_DIR (default ./wa-auth), so a
// restart reconnects by itself. LOSE that folder and you must link
// again — on a host with a wiped disk, put it on a persistent disk.
//
// Rules of the road:
//   · Use a DEDICATED number, not anyone's personal one. WhatsApp can
//     restrict unofficial clients, and a restricted number is gone.
//   · Run ONE server instance. Two instances sharing a session knock
//     each other off.
//   · Messages are sent one at a time with a short random pause, and
//     the reset routes already limit how many codes anyone can ask for.
//
// Without WHATSAPP_ENABLED (development), nothing is sent: the code is
// printed in the server console and kept in `devOutbox` for the tests.
// In production a missing or disconnected WhatsApp is an ERROR that is
// logged, never a silent success.
// ============================================================
import fs from 'fs';
import path from 'path';
import { IS_PROD } from './env.js';

export const devOutbox = [];

const AUTH_DIR = () => path.resolve(process.env.WHATSAPP_AUTH_DIR || 'wa-auth');

// 'off' | 'connecting' | 'waiting_for_link' | 'connected' | 'logged_out'
let status = 'off';
let sock = null;
let stopped = false;
let attempt = 0;
let timer = null;
let pairingAsked = false;

export const whatsappEnabled = () => process.env.WHATSAPP_ENABLED === '1';
export const whatsappStatus = () => status;
export const whatsappReady = () => status === 'connected' && Boolean(sock);

// 0300 1234567  ->  923001234567
export function toInternational(localPhone) {
  const digits = String(localPhone || '').replace(/\D/g, '');
  if (digits.startsWith('92') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 11) return `92${digits.slice(1)}`;
  return digits;
}

export function otpText(code, minutes = 5) {
  return `Smart Tutor Finder: your password reset code is *${code}*. ` +
    `It expires in ${minutes} minutes. Never share this code with anyone.`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// Connecting
// ------------------------------------------------------------
export async function startWhatsApp() {
  if (sock || stopped) return;
  status = 'connecting';

  // Loaded only when WhatsApp is switched on, so a server that does
  // not use it never pays for the library.
  const baileys = await import('@whiskeysockets/baileys');
  const makeWASocket = baileys.default;
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;
  const pino = (await import('pino')).default;

  fs.mkdirSync(AUTH_DIR(), { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR());
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const s = makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Smart Tutor Finder'),
    markOnlineOnConnect: false,     // do not make the number look "online" all day
    syncFullHistory: false,
  });
  sock = s;

  s.ev.on('creds.update', saveCreds);

  s.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // A QR is offered while the account is not linked yet.
    if (qr) {
      const number = String(process.env.WHATSAPP_PAIRING_NUMBER || '').replace(/\D/g, '');
      status = 'waiting_for_link';

      if (number && !pairingAsked && !state.creds.registered) {
        pairingAsked = true;
        try {
          const code = await s.requestPairingCode(number);
          console.log(`\n[whatsapp] Link code: ${String(code).replace(/(.{4})/, '$1-')}\n` +
            '  On the phone: WhatsApp > Settings > Linked devices > Link a device >\n' +
            '  "Link with phone number instead", then type the code.\n');
        } catch (err) {
          pairingAsked = false;
          console.error('[whatsapp] Could not get a link code:', err.message);
        }
      } else if (!number) {
        const qrt = (await import('qrcode-terminal')).default;
        console.log('\n[whatsapp] Scan this with WhatsApp > Settings > Linked devices > Link a device:\n');
        qrt.generate(qr, { small: true });
      }
    }

    if (connection === 'open') {
      status = 'connected';
      attempt = 0;
      pairingAsked = false;
      console.log('[whatsapp] Connected');
    }

    if (connection === 'close') {
      sock = null;
      if (stopped) { status = 'off'; return; }

      const code = lastDisconnect?.error?.output?.statusCode;

      // Unlinked from the phone (or banned): the saved login is dead.
      // Wipe it so a fresh QR / link code is offered.
      if (code === DisconnectReason.loggedOut) {
        status = 'logged_out';
        console.error('[whatsapp] This device was logged out. Link it again.');
        fs.rmSync(AUTH_DIR(), { recursive: true, force: true });
        pairingAsked = false;
        timer = setTimeout(() => { timer = null; startWhatsApp().catch(logStartError); }, 3000);
        return;
      }

      // Anything else (network drop, "restart required" right after
      // linking, WhatsApp restarting): try again, backing off up to 30 s.
      status = 'connecting';
      const wait = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      attempt += 1;
      console.warn(`[whatsapp] Disconnected (${code ?? 'unknown'}). Reconnecting in ${Math.round(wait / 1000)} s`);
      timer = setTimeout(() => { timer = null; startWhatsApp().catch(logStartError); }, wait);
    }
  });
}

const logStartError = (err) => console.error('[whatsapp] Could not start:', err.message);

export function initWhatsApp() {
  if (!whatsappEnabled()) return;
  stopped = false;
  startWhatsApp().catch(logStartError);
}

export async function stopWhatsApp() {
  stopped = true;
  clearTimeout(timer);
  timer = null;
  const s = sock;
  sock = null;
  status = 'off';
  try { s?.end?.(undefined); } catch { /* already closed */ }
}

// Tests (and only tests) hand in a fake connection.
export function setSocketForTests(fake) {
  sock = fake;
  status = fake ? 'connected' : 'off';
  stopped = false;
}

// ------------------------------------------------------------
// Sending — one at a time, with a short random pause
// ------------------------------------------------------------
let chain = Promise.resolve();

function enqueue(job) {
  const run = chain.then(job);
  chain = run.catch(() => {}).then(() => (process.env.NODE_ENV === 'test' ? null : sleep(1500 + Math.random() * 1500)));
  return run;
}

export async function sendWhatsAppOtp(localPhone, code) {
  if (!whatsappEnabled() && !sock) {
    if (IS_PROD) throw new Error('WhatsApp is not enabled (set WHATSAPP_ENABLED=1 and link an account).');
    devOutbox.push({ phone: localPhone, code, at: Date.now() });
    if (devOutbox.length > 50) devOutbox.shift();
    if (process.env.NODE_ENV !== 'test') console.log(`[dev] WhatsApp OTP for ${localPhone}: ${code}`);
    return { sent: true, dev: true };
  }

  if (!whatsappReady()) throw new Error(`WhatsApp is not connected (${status}).`);

  return enqueue(async () => {
    if (!whatsappReady()) throw new Error(`WhatsApp is not connected (${status}).`);

    const jid = `${toInternational(localPhone)}@s.whatsapp.net`;

    // Is this number on WhatsApp at all? Sending to one that is not is
    // a quick way to get a number flagged.
    const found = await sock.onWhatsApp(jid);
    const hit = Array.isArray(found) ? found[0] : null;
    if (!hit?.exists) throw new Error('That number is not on WhatsApp.');

    await sock.sendMessage(hit.jid || jid, { text: otpText(code) });
    return { sent: true };
  });
}
