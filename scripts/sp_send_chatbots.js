/*
  SendPulse Chatbots generic sender (try for Instagram too)
  Usage:
    $env:SP_CONTACT_ID = "<contact_or_chat_id>"
    $env:SP_TEST_TEXT = "<text>"
    node scripts/sp_send_chatbots.js
*/

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true }); } catch {}
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true }); } catch {}

function sanitizeBase(b){ return String(b||'').trim().replace(/\/+$/, ''); }

async function getToken(bases){
  const id = process.env.SENDPULSE_CLIENT_ID;
  const secret = process.env.SENDPULSE_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Missing SENDPULSE_CLIENT_ID/SECRET');
  const form = new URLSearchParams();
  form.set('grant_type','client_credentials');
  form.set('client_id', id);
  form.set('client_secret', secret);
  for (const base of bases){
    try {
      const r = await fetch(`${base}/oauth/access_token`, { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body: form.toString() });
      const j = await r.json().catch(()=>({}));
      if (r.ok && j.access_token) return { token:j.access_token, base };
    } catch {}
  }
  throw new Error('Failed to obtain token');
}

(async function main(){
  const contactId = process.env.SP_CONTACT_ID || '';
  const text = process.env.SP_TEST_TEXT || 'Hello from support';
  if (!contactId) { console.log(JSON.stringify({ ok:false, error:'Missing SP_CONTACT_ID' })); return; }
  const envBase = sanitizeBase(process.env.SENDPULSE_API_BASE || 'https://api.sendpulse.com');
  const bases = Array.from(new Set([envBase, 'https://api.sendpulse.com', 'https://api.eu.sendpulse.com']));

  const botId = process.env.SENDPULSE_BOT_ID_INSTAGRAM || process.env.SENDPULSE_BOT_ID_FACEBOOK || '';
  if (!botId) { console.log(JSON.stringify({ ok:false, error:'Missing SENDPULSE_BOT_ID_INSTAGRAM' })); return; }

  try {
    const auth = await getToken(bases);
    const url = `${auth.base}/chatbots/messages/send`;
    const payload = {
      bot_id: botId,
      chat_id: String(contactId),
      contact_id: String(contactId),
      message: { type: 'text', text: String(text) }
    };
    const r = await fetch(url, { method:'POST', headers:{ Authorization: `Bearer ${auth.token}`, 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
    const t = await r.text().catch(()=> '');
    let j=null; try { j = t ? JSON.parse(t) : null; } catch {}
    console.log(JSON.stringify({ ok: r.ok, status: r.status, data: j ?? t }));
  } catch (e) {
    console.log(JSON.stringify({ ok:false, error:e.message }));
  }
})();

