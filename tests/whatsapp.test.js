import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { boot, shutdown, api, query } from './helpers.js';
import {
  toInternational, otpText, sendWhatsAppOtp, setSocketForTests, whatsappStatus, whatsappReady, devOutbox,
} from '../lib/whatsapp.js';

before(boot);
after(async () => { setSocketForTests(null); await shutdown(); });

const fake = (over = {}) => {
  const sent = [];
  return {
    sent,
    onWhatsApp: async (jid) => [{ jid, exists: true }],
    sendMessage: async (jid, content) => { sent.push({ jid, content }); return {}; },
    ...over,
  };
};

test('the installed Baileys has every function this server relies on', async () => {
  const b = await import('@whiskeysockets/baileys');
  assert.equal(typeof b.default, 'function', 'makeWASocket');
  assert.equal(typeof b.useMultiFileAuthState, 'function');
  assert.equal(typeof b.fetchLatestBaileysVersion, 'function');
  assert.equal(typeof b.Browsers.ubuntu, 'function');
  assert.equal(typeof b.DisconnectReason.loggedOut, 'number');

  // the auth store really creates and returns what we save
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));
  const { state, saveCreds } = await b.useMultiFileAuthState(dir);
  assert.ok(state.creds && typeof saveCreds === 'function');
  await saveCreds();
  assert.ok(fs.existsSync(path.join(dir, 'creds.json')), 'session is written to disk');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('phone numbers become international, without a +', () => {
  assert.equal(toInternational('03001234567'), '923001234567');
  assert.equal(toInternational('0300-1234567'), '923001234567');
  assert.equal(toInternational('923001234567'), '923001234567');
});

test('the message carries the code, the expiry, and a warning not to share it', () => {
  const t = otpText('482913');
  assert.match(t, /482913/);
  assert.match(t, /5 minutes/);
  assert.match(t, /Never share/i);
});

test('sends to the right WhatsApp address, text only', async () => {
  const f = fake(); setSocketForTests(f);
  assert.equal(whatsappReady(), true);
  await sendWhatsAppOtp('03001234567', '111222');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].jid, '923001234567@s.whatsapp.net');
  assert.match(f.sent[0].content.text, /111222/);
});

test('uses the canonical address WhatsApp reports for the number', async () => {
  const f = fake({ onWhatsApp: async () => [{ jid: '923001234567:5@s.whatsapp.net', exists: true }] });
  setSocketForTests(f);
  await sendWhatsAppOtp('03001234567', '123456');
  assert.equal(f.sent[0].jid, '923001234567:5@s.whatsapp.net');
});

test('a number that is not on WhatsApp is never messaged', async () => {
  const f = fake({ onWhatsApp: async () => [{ jid: 'x', exists: false }] });
  setSocketForTests(f);
  await assert.rejects(sendWhatsAppOtp('03001234567', '123456'), /not on WhatsApp/);
  assert.equal(f.sent.length, 0);
  const empty = fake({ onWhatsApp: async () => [] });
  setSocketForTests(empty);
  await assert.rejects(sendWhatsAppOtp('03001234567', '123456'), /not on WhatsApp/);
});

test('not connected is an error, not a silent success', async () => {
  setSocketForTests(null);
  process.env.WHATSAPP_ENABLED = '1';
  try {
    assert.equal(whatsappReady(), false);
    await assert.rejects(sendWhatsAppOtp('03001234567', '123456'), /not connected/);
  } finally { delete process.env.WHATSAPP_ENABLED; }
});

test('sends go out one at a time, in order', async () => {
  let running = 0, peak = 0;
  const order = [];
  const f = fake({
    sendMessage: async (jid) => { running++; peak = Math.max(peak, running); order.push(jid); await new Promise((r) => setTimeout(r, 30)); running--; return {}; },
  });
  setSocketForTests(f);
  await Promise.all(['03001111111', '03002222222', '03003333333'].map((p) => sendWhatsAppOtp(p, '123456')));
  assert.equal(peak, 1, 'never two at once');
  assert.deepEqual(order, ['921111111111@s.whatsapp.net'.replace('921111111111', '923001111111'), '923002222222@s.whatsapp.net', '923003333333@s.whatsapp.net']);
});

test('one failed send does not block the next', async () => {
  let n = 0;
  const f = fake({ sendMessage: async () => { n++; if (n === 1) throw new Error('boom'); return {}; } });
  setSocketForTests(f);
  await assert.rejects(sendWhatsAppOtp('03001111111', '123456'), /boom/);
  await sendWhatsAppOtp('03002222222', '123456');
  assert.equal(n, 2);
});

test('without WhatsApp switched on, development keeps the code in the outbox', async () => {
  setSocketForTests(null);
  delete process.env.WHATSAPP_ENABLED;
  const before = devOutbox.length;
  const r = await sendWhatsAppOtp('03001234567', '654321');
  assert.equal(r.dev, true);
  assert.equal(devOutbox.length, before + 1);
  assert.equal(whatsappStatus(), 'off');
});

test('FULL FLOW through Baileys: request -> WhatsApp message -> verify the code from it', async () => {
  await query('DELETE FROM password_resets');
  const f = fake(); setSocketForTests(f);

  const r = await api('POST', '/api/auth/forgot-password', { body: { phone: '03002000001' } });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 100));         // the send is not awaited by the route

  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].jid, '923002000001@s.whatsapp.net');
  const code = f.sent[0].content.text.match(/\*(\d{6})\*/)[1];

  const v = await api('POST', '/api/auth/verify-otp', { body: { phone: '03002000001', code } });
  assert.equal(v.status, 200);
  assert.ok(v.body.reset_token);
});

test('a WhatsApp outage does not change what the caller sees (nothing about the number leaks)', async () => {
  await query('DELETE FROM password_resets');
  const down = fake({ sendMessage: async () => { throw new Error('connection closed'); } });
  setSocketForTests(down);
  const registered = await api('POST', '/api/auth/forgot-password', { body: { phone: '03002000001' } });
  const unregistered = await api('POST', '/api/auth/forgot-password', { body: { phone: '03111111111' } });
  assert.equal(registered.status, 200);
  assert.deepEqual(registered.body, unregistered.body);
});

test('an unregistered number is never sent a message', async () => {
  await query('DELETE FROM password_resets');
  const f = fake(); setSocketForTests(f);
  await api('POST', '/api/auth/forgot-password', { body: { phone: '03111111111' } });
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(f.sent.length, 0);
});
