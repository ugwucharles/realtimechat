/*
  SendPulse Instagram: check contact visibility and optionally send a one-line test
  Usage (PowerShell):
    $env:SP_CONTACT_ID = "<contact_or_chat_id>"
    $env:SP_TEST_TEXT = "Hello from support"
    $env:SP_DO_SEND = "true"   # omit or set to false to skip send
    node scripts/sp_check_and_send.js
*/

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true }); } catch {}
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true }); } catch {}

function sanitizeBase(b) { return String(b || '').trim().replace(/\/+$/, ''); }

async function getToken(bases) {
  const id = process.env.SENDPULSE_CLIENT_ID;
  const secret = process.env.SENDPULSE_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Missing SENDPULSE_CLIENT_ID/SECRET');
  const form = new URLSearchParams();
  form.set('grant_type', 'client_credentials');
  form.set('client_id', id);
  form.set('client_secret', secret);
  let err = null;
  for (const base of bases) {
    try {
      const r = await fetch(`${base}/oauth/access_token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString()
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.access_token) return { token: j.access_token, base };
      err = new Error(`token failed ${r.status}`);
    } catch (e) { err = e; }
  }
  throw err || new Error('token error');
}

async function getJson(token, url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const t = await r.text().catch(() => '');
  let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { ok: r.ok, status: r.status, data: j ?? t };
}

(async function main(){
  const contactId = process.env.SP_CONTACT_ID || '';
  const text = process.env.SP_TEST_TEXT || 'Hello from support';
  const doSend = (process.env.SP_DO_SEND || 'false') === 'true';
  if (!contactId) { console.log(JSON.stringify({ ok:false, error:'Missing SP_CONTACT_ID' })); return; }

  const envBase = sanitizeBase(process.env.SENDPULSE_API_BASE || 'https://api.sendpulse.com');
  const bases = Array.from(new Set([envBase, 'https://api.sendpulse.com', 'https://api.eu.sendpulse.com']));

  const result = { contactId, steps: [] };
  try {
    const auth = await getToken(bases);
    result.base = auth.base;

    const paths = [
      (b) => `${b}/chatbots/contacts/${encodeURIComponent(contactId)}/messages?limit=1`,
      (b) => `${b}/instagram/chats/${encodeURIComponent(contactId)}/messages?limit=1`,
      (b) => `${b}/instagram/chats/messages?chat_id=${encodeURIComponent(contactId)}&limit=1`,
    ];

    let visible = false;
    for (const build of paths) {
      const url = build(auth.base);
      try {
        const r = await getJson(auth.token, url);
        result.steps.push({ url, status: r.status, ok: r.ok });
        if (r.ok) { visible = true; break; }
      } catch (e) {
        result.steps.push({ url, ok:false, error: e.message });
      }
    }

    result.visible = visible;

    if (doSend) {
      // attempt one-line send regardless of visibility (some endpoints do not expose GET for messages)
      const payload = { chat_id: String(contactId), contact_id: String(contactId), text: String(text) };
      const sendUrl = `${auth.base}/instagram/chats/messages`;
      const r = await fetch(sendUrl, { method:'POST', headers: { Authorization:`Bearer ${auth.token}`, 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
      const t = await r.text().catch(()=> '');
      let j=null; try { j = t ? JSON.parse(t) : null; } catch {}
      result.send = { url: sendUrl, status: r.status, ok: r.ok, data: j ?? t };
    }

    result.ok = true;
    console.log(JSON.stringify(result));
  } catch (e) {
    console.log(JSON.stringify({ ok:false, error:e.message, ...result }));
  }
})();

