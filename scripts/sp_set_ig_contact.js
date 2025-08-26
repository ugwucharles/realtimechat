/*
  Set Instagram customer_contact_id for a conversation in Postgres
  Usage (PowerShell examples):
    $env:IG_CONTACT_ID = "68ac2a01a18372d6cd0b2638"   # required
    $env:IG_MATCH_NAME = "Favour-Moses"                 # optional, fuzzy match by name
    # OR
    # $env:IG_MATCH_CHAT_ID = "<existing customer_external_id>"
    node scripts/sp_set_ig_contact.js

  Behavior:
    - Finds Instagram channel id
    - Locates a conversation by (chat_id) OR (name ILIKE) OR most recent IG conversation
    - Updates customer_contact_id to IG_CONTACT_ID if not already set
    - Prints JSON summary
*/

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true }); } catch {}
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true }); } catch {}

const { Pool } = require('pg');

(async function main(){
  const IG_CONTACT_ID = process.env.IG_CONTACT_ID || '';
  const IG_MATCH_NAME = process.env.IG_MATCH_NAME || '';
  const IG_MATCH_CHAT_ID = process.env.IG_MATCH_CHAT_ID || '';
  if (!IG_CONTACT_ID) {
    console.log(JSON.stringify({ ok:false, error:'Missing IG_CONTACT_ID' }));
    return;
  }
  const pool = new Pool({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'chatapp',
    password: process.env.PGPASSWORD || 'chatpass',
    database: process.env.PGDATABASE || 'chatapp'
  });

  const out = { contact_id: IG_CONTACT_ID };
  try {
    const ch = await pool.query("SELECT id FROM channels WHERE name = 'instagram' LIMIT 1");
    if (!ch.rowCount) {
      console.log(JSON.stringify({ ok:false, error:'instagram channel not found' }));
      return;
    }
    const channelId = ch.rows[0].id;

    let conv = null;
    if (IG_MATCH_CHAT_ID) {
      const r = await pool.query(
        `SELECT id, customer_name, customer_external_id, customer_contact_id, last_activity_at
         FROM conversations
         WHERE channel_id = $1 AND customer_external_id = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [channelId, IG_MATCH_CHAT_ID]
      );
      conv = r.rows[0] || null;
      out.match = { type:'chat_id', value: IG_MATCH_CHAT_ID };
    } else if (IG_MATCH_NAME) {
      const r = await pool.query(
        `SELECT id, customer_name, customer_external_id, customer_contact_id, last_activity_at
         FROM conversations
         WHERE channel_id = $1 AND customer_name ILIKE $2
         ORDER BY last_activity_at DESC
         LIMIT 1`,
        [channelId, `%${IG_MATCH_NAME}%`]
      );
      conv = r.rows[0] || null;
      out.match = { type:'name', value: IG_MATCH_NAME };
    } else {
      const r = await pool.query(
        `SELECT id, customer_name, customer_external_id, customer_contact_id, last_activity_at
         FROM conversations
         WHERE channel_id = $1
         ORDER BY last_activity_at DESC
         LIMIT 1`,
        [channelId]
      );
      conv = r.rows[0] || null;
      out.match = { type:'recent' };
    }

    if (!conv) {
      console.log(JSON.stringify({ ok:false, error:'conversation not found', ...out }));
      return;
    }

    out.conversation_before = conv;

    if (conv.customer_contact_id === IG_CONTACT_ID) {
      out.skipped = true;
      console.log(JSON.stringify({ ok:true, updated:false, ...out }));
      return;
    }

    const upd = await pool.query(
      `UPDATE conversations SET customer_contact_id = $2 WHERE id = $1
       RETURNING id, customer_name, customer_external_id, customer_contact_id, last_activity_at`,
      [conv.id, IG_CONTACT_ID]
    );
    out.conversation_after = upd.rows[0] || null;
    console.log(JSON.stringify({ ok:true, updated:true, ...out }));
  } catch (e) {
    console.log(JSON.stringify({ ok:false, error:e.message, ...out }));
  } finally {
    try { await pool.end(); } catch {}
  }
})();

