/*
  Try multiple payload variants for SendPulse Instagram send
  Usage:
    $env:SP_CONTACT_ID = "<id>"
    node scripts/sp_try_variants.js
*/

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true }); } catch {}
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true }); } catch {}

function sanitizeBase(b){ return String(b||'').trim().replace(/\/+$/, ''); }

async function token(bases){
  const id = process.env.SENDPULSE_CLIENT_ID;
  const secret = process.env.SENDPULSE_CLIENT_SECRET;
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
  throw new Error('token failed');
}

(async function main(){
  const id = process.env.SP_CONTACT_ID || '';
  if (!id) { console.log(JSON.stringify({ ok:false, error:'Missing SP_CONTACT_ID' })); return; }
  const envBase = sanitizeBase(process.env.SENDPULSE_API_BASE || 'https://api.sendpulse.com');
  const bases = Array.from(new Set([envBase, 'https://api.sendpulse.com', 'https://api.eu.sendpulse.com']));
  const auth = await token(bases);
  const url = `${auth.base}/instagram/chats/messages`;
  const texts = [
    'VariantA: chat_id only',
    'VariantB: contact_id only',
    'VariantC: both chat_id and contact_id'
  ];
  const payloads = [
    { chat_id: id, text: texts[0] },
    { contact_id: id, text: texts[1] },
    { chat_id: id, contact_id: id, text: texts[2] },
  ];
  const results = [];
  for (const p of payloads){
    const r = await fetch(url, { method:'POST', headers:{ Authorization:`Bearer ${auth.token}`, 'Content-Type':'application/json' }, body: JSON.stringify(p) });
    const t = await r.text().catch(()=> '');
    let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
    results.push({ payload: Object.keys(p), status: r.status, ok: r.ok, data: j ?? t });
  }
  console.log(JSON.stringify({ ok:true, url, results }));
})();

