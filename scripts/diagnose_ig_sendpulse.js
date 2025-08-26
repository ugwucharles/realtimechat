/*
  Diagnose Instagram reply issues via SendPulse
  - Queries DB for recent instagram conversations
  - Checks if customer_contact_id is present
  - Validates chat/contact via SendPulse (no outbound send)
  - Prints a summary JSON per conversation
*/

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });

const { Pool } = require('pg');

function sanitizeBase(b){ return String(b||'').trim().replace(/\/+$/, ''); }

async function getSendpulseToken(baseCandidates){
  const clientId = process.env.SENDPULSE_CLIENT_ID;
  const clientSecret = process.env.SENDPULSE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing SENDPULSE_CLIENT_ID/SECRET');
  const form = new URLSearchParams();
  form.set('grant_type','client_credentials');
  form.set('client_id', clientId);
  form.set('client_secret', clientSecret);
  for (const base of baseCandidates){
    try {
      const r = await fetch(`${base}/oauth/access_token`, { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body: form.toString() });
      const j = await r.json().catch(()=>({}));
      if (r.ok && j.access_token) return { token:j.access_token, base };
    } catch {}
  }
  throw new Error('Failed to obtain SendPulse token');
}

async function spGetJson(token, url){
  const r = await fetch(url, { headers:{ Authorization:`Bearer ${token}` }});
  const t = await r.text().catch(()=> '');
  let j=null; try{ j = t ? JSON.parse(t) : null; } catch {}
  return { ok: r.ok, status: r.status, data: j ?? t };
}

(async function main(){
  const base = sanitizeBase(process.env.SENDPULSE_API_BASE || 'https://api.sendpulse.com');
  const bases = Array.from(new Set([base, 'https://api.eu.sendpulse.com', 'https://api.sendpulse.com']));
  const pool = new Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || '5432'),
    user: process.env.PGUSER || 'chatapp',
    password: process.env.PGPASSWORD || 'chatpass',
    database: process.env.PGDATABASE || 'chatapp'
  });

  const out = { startedAt: new Date().toISOString(), issues: [], scanned: 0 };
  try {
    const ch = await pool.query("SELECT id FROM channels WHERE name = 'instagram' LIMIT 1").then(r => r.rows[0] || null);
    if (!ch) { console.log(JSON.stringify({ ok:true, message:'No instagram channel found', ...out })); return process.exit(0); }

    const rows = await pool.query(`
      SELECT id, customer_external_id, customer_contact_id,
             last_activity_at, status
      FROM conversations
      WHERE channel_id = $1
      ORDER BY last_activity_at DESC
      LIMIT 20`, [ch.id]).then(r => r.rows);

    const auth = await getSendpulseToken(bases);

    for (const conv of rows){
      out.scanned++;
      const chatId = (conv.customer_external_id || '').toString();
      const contactId = (conv.customer_contact_id || '').toString();
      const recentHours = Math.round((Date.now() - new Date(conv.last_activity_at).getTime())/3600000);
      const item = {
        conversation_id: conv.id,
        status: conv.status,
        chat_id: chatId,
        contact_id: contactId || null,
        last_activity_hours: recentHours
      };

      // Check IG chat presence
      const check1 = await spGetJson(auth.token, `${auth.base}/instagram/chats/${encodeURIComponent(chatId)}`);
      item.sp_chat_ok = check1.ok;
      item.sp_chat_status = check1.status;

      // If we have contact_id, check contact messages endpoint as a secondary validation
      if (contactId) {
        const check2 = await spGetJson(auth.token, `${auth.base}/instagram/chats/${encodeURIComponent(chatId)}/messages?limit=1`);
        item.sp_messages_ok = check2.ok;
        item.sp_messages_status = check2.status;
      }

      // Quick heuristics
      const hints = [];
      if (!contactId) hints.push('missing_contact_id: will resolve on next inbound or via admin backfill');
      if (!check1.ok && check1.status === 404) hints.push('sendpulse_unknown_chat: chat_id not found');
      if (recentHours > 24) hints.push('24h_window: IG policy may restrict replies if no recent customer message');

      item.hints = hints;
      out.issues.push(item);
    }

    console.log(JSON.stringify({ ok:true, ...out }));
  } catch (e) {
    console.log(JSON.stringify({ ok:false, error:e.message, ...out }));
  } finally {
    try { await pool.end(); } catch {}
  }
})();

