require('dotenv').config({ override: true });
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.local'), override: true });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const fs = require('fs');
const crypto = require('crypto');
const twilio = require('twilio');
const dns = require('dns');

// Prefer IPv4 to avoid IPv6-only DNS resolutions causing fetch failures on some networks
try { dns.setDefaultResultOrder('ipv4first'); } catch {}
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');

const PORT = parseInt(process.env.PORT || '3000', 10);

// Twilio WhatsApp (optional; used when env vars are set)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || '';
const TWILIO_STATUS_CALLBACK_URL = process.env.TWILIO_STATUS_CALLBACK_URL || '';
const TWILIO_WEBHOOK_STRICT = (process.env.TWILIO_WEBHOOK_STRICT || 'false') === 'true';
const SIMULATOR_ENABLED = (process.env.SIMULATOR_ENABLED || 'false') === 'true';
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  if (TWILIO_ACCOUNT_SID.startsWith('AC')) {
    try {
      twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    } catch (e) {
      console.warn('Twilio init failed:', e.message);
      twilioClient = null;
    }
  } else {
    console.warn('TWILIO_ACCOUNT_SID does not start with "AC". Twilio is disabled until you set a valid Account SID.');
  }
}

// ---- Meta (Messenger & Instagram) ----
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || '';
const IG_PAGE_ACCESS_TOKEN = process.env.IG_PAGE_ACCESS_TOKEN || '';
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v19.0';
const META_WEBHOOK_STRICT = (process.env.META_WEBHOOK_STRICT || 'false') === 'true';

// ---- SendPulse (Facebook/Instagram via Chatbots) ----
const SENDPULSE_CLIENT_ID = process.env.SENDPULSE_CLIENT_ID || '';
const SENDPULSE_CLIENT_SECRET = process.env.SENDPULSE_CLIENT_SECRET || '';
const SENDPULSE_BOT_ID_FACEBOOK = process.env.SENDPULSE_BOT_ID_FACEBOOK || '';
const SENDPULSE_BOT_ID_INSTAGRAM = process.env.SENDPULSE_BOT_ID_INSTAGRAM || '';
const SENDPULSE_WEBHOOK_KEY = process.env.SENDPULSE_WEBHOOK_KEY || '';
const SENDPULSE_API_BASE = process.env.SENDPULSE_API_BASE || 'https://api.sendpulse.com';

// ---- Outbound via Chatbot (custom relay) ----
const CHATBOT_OUTBOUND_URL = process.env.CHATBOT_OUTBOUND_URL || '';
const CHATBOT_OUTBOUND_INSTAGRAM_URL = process.env.CHATBOT_OUTBOUND_INSTAGRAM_URL || '';
const CHATBOT_OUTBOUND_KEY = process.env.CHATBOT_OUTBOUND_KEY || '';
const CHATBOT_OUTBOUND_STRICT = (process.env.CHATBOT_OUTBOUND_STRICT || 'false') === 'true';

// ---- Internal notifications ----
const INTERNAL_NOTIFY_SLACK_WEBHOOK = process.env.INTERNAL_NOTIFY_SLACK_WEBHOOK || '';
const INTERNAL_NOTIFY_DISCORD_WEBHOOK = process.env.INTERNAL_NOTIFY_DISCORD_WEBHOOK || '';
const INTERNAL_NOTIFY_EMAIL_TO = process.env.INTERNAL_NOTIFY_EMAIL_TO || '';
const INTERNAL_NOTIFY_ENABLED = (process.env.INTERNAL_NOTIFY_ENABLED || 'true') === 'true';

let sendpulseToken = { access_token: '', expires_at: 0, base: '' };

// In-memory cache: IG chat_id -> { contact_id, base, expires_at }
const igContactCache = new Map();
function setIgContactCache(chatId, value) {
  try {
    igContactCache.set(String(chatId), value);
  } catch {}
}
function getIgContactCache(chatId) {
  try {
    const v = igContactCache.get(String(chatId));
    if (!v) return null;
    if (v.expires_at && v.expires_at < Date.now()) { igContactCache.delete(String(chatId)); return null; }
    return v;
  } catch { return null; }
}
async function getSendpulseToken(forceNew = false, preferredBase = null) {
  const now = Math.floor(Date.now() / 1000);
  const sanitize = (b) => (b || '').trim().replace(/\/+$/, '');
  const envBase = sanitize(process.env.SENDPULSE_API_BASE || 'https://api.sendpulse.com');
  const candidatesRaw = [preferredBase ? sanitize(preferredBase) : null, envBase, 'https://api.eu.sendpulse.com', 'https://api.sendpulse.com'];
  const candidates = Array.from(new Set(candidatesRaw.filter(Boolean)));

  // Reuse cached token if still valid and matches the preferred base (if any)
  const preferred = preferredBase ? sanitize(preferredBase) : null;
  if (
    !forceNew &&
    sendpulseToken.access_token &&
    sendpulseToken.expires_at - 60 > now &&
    (!preferred || sendpulseToken.base === preferred)
  ) {
    return sendpulseToken.access_token;
  }

  if (!SENDPULSE_CLIENT_ID || !SENDPULSE_CLIENT_SECRET) throw new Error('Missing SendPulse client id/secret');

  const formBody = new URLSearchParams();
  formBody.set('grant_type', 'client_credentials');
  formBody.set('client_id', SENDPULSE_CLIENT_ID);
  formBody.set('client_secret', SENDPULSE_CLIENT_SECRET);

  let lastErr = null;
  for (const base of candidates) {
    try {
      const url = `${base}/oauth/access_token`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody.toString()
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.access_token) {
        sendpulseToken = { access_token: j.access_token, expires_at: now + (j.expires_in || 3600), base };
        return sendpulseToken.access_token;
      }
      console.error('SendPulse token failed', r.status, base, JSON.stringify(j).slice(0, 200));
    } catch (e) {
      lastErr = e;
      console.error('SendPulse token fetch error', base, e.message);
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('SendPulse token error');
}
// Resolve correct contact_id for an Instagram chat_id using SendPulse APIs, with caching and regional fallbacks
async function resolveIgContactId(chatId) {
  const key = String(chatId);
  const cached = getIgContactCache(key);
  if (cached?.contact_id) return cached;

  const sanitize = (b) => (b || '').trim().replace(/\/+$/, '');
  const envBase = sanitize(process.env.SENDPULSE_API_BASE || 'https://api.sendpulse.com');
  const bases = Array.from(new Set([envBase, sendpulseToken.base || null, 'https://api.eu.sendpulse.com', 'https://api.sendpulse.com'].filter(Boolean)));

  const tryPaths = [
    // Preferred IG chat details -> should include contact info
    (base) => ({ url: `${base}/instagram/chats/${encodeURIComponent(key)}`, parse: (j) => j?.contact?.id || j?.contact_id || j?.subscriber?.id }),
    // IG messages endpoint sometimes returns chat metadata in wrapper
    (base) => ({ url: `${base}/instagram/chats/messages?chat_id=${encodeURIComponent(key)}&limit=1`, parse: (j) => j?.chat?.contact_id || j?.contact?.id || j?.subscriber?.id }),
    // Fallback to generic chatbots contact lookup
    (base) => ({ url: `${base}/chatbots/contacts/${encodeURIComponent(key)}`, parse: (j) => j?.id || j?.contact_id }),
  ];

  for (const base of bases) {
    for (const build of tryPaths) {
      try {
        const { url, parse } = build(base);
        const t1 = await getSendpulseToken(false, base);
        let r = await fetch(url, { headers: { Authorization: `Bearer ${t1}` } });
        if (r.status === 401 || r.status === 403) {
          const t2 = await getSendpulseToken(true, base);
          r = await fetch(url, { headers: { Authorization: `Bearer ${t2}` } });
        }
        const text = await r.text().catch(() => '');
        let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
        if (r.ok) {
          const contactId = parse && j ? parse(j) : null;
          if (contactId) {
            const record = { contact_id: String(contactId), base, expires_at: Date.now() + 15 * 60 * 1000 };
            setIgContactCache(key, record);
            return record;
          }
        } else {
          // non-ok: keep trying
        }
      } catch (e) {
        // try next
      }
    }
  }
  return null;
}

// SendPulse Instagram sender: tries configured base first, then falls back across regions
async function sendPulseSendInstagram(chatId, text) {
  try {
    if (!chatId || !text) return false;
    // Resolve correct contact_id first
    let resolved = null;
    try { resolved = await resolveIgContactId(chatId); } catch {}

    const sanitize = (b) => (b || '').trim().replace(/\/+$/, '');
    const envBase = sanitize(process.env.SENDPULSE_API_BASE || 'https://api.sendpulse.com');
    const payload = {
      chat_id: String(chatId),
      contact_id: String(resolved?.contact_id || chatId),
      text: String(text)
    };
    const debugSend = (process.env.DEBUG_SP_SEND || 'true') === 'true';

    // Try the base that resolved contact first (if any), then cached token base, env base, EU, Global
    const baseCandidatesRaw = [envBase, resolved?.base || null, sendpulseToken.base || null, 'https://api.eu.sendpulse.com', 'https://api.sendpulse.com'];
    const baseCandidates = Array.from(new Set(baseCandidatesRaw.filter(Boolean)));

    for (const base of baseCandidates) {
      try {
        const sendOnce = async (forceNewToken = false) => {
          const token = await getSendpulseToken(forceNewToken, base);
          const url = `${base}/instagram/chats/messages`;
          const resp = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          return { resp, url };
        };

        let { resp, url } = await sendOnce(false);
        if (resp.status === 401 || resp.status === 403) {
          ({ resp, url } = await sendOnce(true));
        }

        const textBody = await resp.text().catch(() => '');
        let json;
        try { json = textBody ? JSON.parse(textBody) : null; } catch {}

        if (!resp.ok) {
          console.error('SendPulse IG send failed', resp.status, url, JSON.stringify(payload), textBody.slice(0, 1000));
          continue;
        }
        if (json && typeof json.success === 'boolean' && json.success === false) {
          console.error('SendPulse IG send API error (success=false)', url, JSON.stringify(payload), textBody.slice(0, 1000));
          continue;
        }
        if (debugSend) console.log('SP IG send OK', url, { chat_id: payload.chat_id, usedBase: base, resolved_contact: resolved?.contact_id || null }, json || textBody.slice(0, 200));
        return true;
      } catch (e) {
        console.error('SendPulse IG send error', base, e.message);
      }
    }
    return false;
  } catch (e) {
    console.error('SendPulse IG send error', e.message);
    return false;
  }
}
// SendPulse Chatbots sender (used for Facebook): POST {BASE}/chatbots/messages/send with message object
async function sendPulseSendChatbots(botId, chatId, text) {
  try {
    if (!botId || !chatId || !text) return false;
    const payload = {
      bot_id: botId,
      chat_id: String(chatId),
      contact_id: String(chatId),
      message: { type: 'text', text: String(text) }
    };

    const sanitize = (b) => (b || '').trim().replace(/\/+$/, '');
    const base = sanitize(process.env.SENDPULSE_API_BASE || 'https://api.sendpulse.com');

    const sendOnce = async (forceNewToken = false) => {
      const token = await getSendpulseToken(forceNewToken);
      const url = `${base}/chatbots/messages/send`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { resp, url };
    };

    let { resp, url } = await sendOnce(false);
    if (resp.status === 401 || resp.status === 403) {
      ({ resp, url } = await sendOnce(true));
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('SendPulse Chatbots send failed', resp.status, url, JSON.stringify(payload), body.slice(0, 1000));
      return false;
    }
    return true;
  } catch (e) {
    console.error('SendPulse Chatbots send error', e.message);
    return false;
  }
}

// Send outbound messages via custom chatbot relay (optional)
async function sendViaChatbot({ platform, chatId, contactId, text, conversationId }) {
  try {
    const url = (platform === 'instagram' && CHATBOT_OUTBOUND_INSTAGRAM_URL)
      ? CHATBOT_OUTBOUND_INSTAGRAM_URL
      : CHATBOT_OUTBOUND_URL;
    if (!url) return null; // not configured
    const payload = {
      platform: String(platform || ''),
      chat_id: String(chatId || ''),
      text: String(text || ''),
      conversation_id: conversationId ? Number(conversationId) : undefined,
      ...(contactId ? { contact_id: String(contactId) } : {})
    };
    const headers = { 'Content-Type': 'application/json' };
    if (CHATBOT_OUTBOUND_KEY) headers['X-Chatbot-Key'] = CHATBOT_OUTBOUND_KEY;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const t = await r.text().catch(() => '');
    let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
    return { ok: r.ok, status: r.status, data: j ?? t };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function safeEqual(a, b) {
  try {
    const aBuf = Buffer.from(String(a || ''));
    const bBuf = Buffer.from(String(b || ''));
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch { return false; }
}

function verifyMetaSignature(signatureHeader, rawBody) {
  if (!META_APP_SECRET) return !META_WEBHOOK_STRICT;
  const sig = String(signatureHeader || '');
  const expected256 = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(rawBody).digest('hex');
  const expected1 = 'sha1=' + crypto.createHmac('sha1', META_APP_SECRET).update(rawBody).digest('hex');
  return safeEqual(sig, expected256) || safeEqual(sig, expected1);
}

// Simple short-window deduplication to avoid double-ingesting the same inbound message
async function isRecentDuplicate(conversationId, sender, content) {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM messages
       WHERE conversation_id = $1 AND sender = $2 AND content = $3
         AND created_at >= NOW() - INTERVAL '5 seconds'
       LIMIT 1`,
      [conversationId, sender, content]
    );
    return !!rows.length;
  } catch {
    return false;
  }
}

async function metaSendMessage(platform, recipientId, text) {
  return false; // Meta sending disabled
  try {
    if (!recipientId || !text) return false;
    const token = platform === 'instagram'
      ? (IG_PAGE_ACCESS_TOKEN || FB_PAGE_ACCESS_TOKEN)
      : FB_PAGE_ACCESS_TOKEN;
    if (!token) return false;

    const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/me/messages?access_token=${encodeURIComponent(token)}`;
    const payload = {
      recipient: { id: String(recipientId) },
      message: { text: String(text) },
      messaging_type: 'RESPONSE',
      // If platform is Instagram, most setups accept the same Send API payload.
      // Some deployments include: messaging_product: 'instagram'
      ...(platform === 'instagram' ? { messaging_product: 'instagram' } : {})
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.warn('Meta send failed', r.status, t);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Meta send error', e.message);
    return false;
  }
}

// Internal notification helper for new messages
async function notifyInternalNewMessage({ platform, chatId, name, text, conversationId, baseUrl }) {
  try {
    if (!INTERNAL_NOTIFY_ENABLED) return;
    const preview = String(text || '').slice(0, 400);
    const linkUrl = baseUrl ? `${baseUrl}/dashboard?conv=${conversationId}` : '';
    const title = `New ${platform} message`;

    // Slack
    if (INTERNAL_NOTIFY_SLACK_WEBHOOK) {
      try {
        const payload = {
          text: `${title}\nFrom: ${name}\nPreview: ${preview}${linkUrl ? `\nConversation: ${linkUrl}` : ''}\nChat ID: ${chatId}`,
        };
        await fetch(INTERNAL_NOTIFY_SLACK_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (e) { console.error('Notify Slack failed', e.message); }
    }

    // Discord
    if (INTERNAL_NOTIFY_DISCORD_WEBHOOK) {
      try {
        const payload = {
          content: `📥 ${title}\n**From:** ${name}\n**Preview:** ${preview}${linkUrl ? `\n**Conversation:** ${linkUrl}` : ''}\n**Chat ID:** ${chatId}`
        };
        await fetch(INTERNAL_NOTIFY_DISCORD_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (e) { console.error('Notify Discord failed', e.message); }
    }

    // Email via Outlook (if configured)
    if (INTERNAL_NOTIFY_EMAIL_TO) {
      try {
        const subject = `${title} — ${name}`;
        const body = `${title}\nFrom: ${name}\nPlatform: ${platform}\nChat ID: ${chatId}\nPreview: ${preview}${linkUrl ? `\nConversation: ${linkUrl}` : ''}`;
        if (process.env.OUTLOOK_PERSONAL === 'true') await sendOutlookMailMSA(INTERNAL_NOTIFY_EMAIL_TO, subject, body);
        else await sendOutlookMail(INTERNAL_NOTIFY_EMAIL_TO, subject, body);
      } catch (e) { console.error('Notify Email failed', e.message); }
    }
  } catch (e) {
    console.error('notifyInternalNewMessage error', e);
  }
}

// Default to local dev values if env vars are not set
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'chatapp',
  password: process.env.PGPASSWORD || 'chatpass',
  database: process.env.PGDATABASE || 'chatapp',
});

async function waitForDB(retries = 30, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions (expire);

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    
    CREATE TABLE IF NOT EXISTS agents (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      online BOOLEAN NOT NULL DEFAULT FALSE,
      socket_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS channels (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      assigned_agent_id INTEGER REFERENCES agents(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_sender TEXT DEFAULT 'customer',
      channel_id INTEGER REFERENCES channels(id),
      customer_external_id TEXT,
      customer_contact_id TEXT
    );

    ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_id INTEGER REFERENCES conversations(id);
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender TEXT DEFAULT 'customer';

    -- Ensure columns exist even if conversations table was created earlier
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_sender TEXT DEFAULT 'customer';
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel_id INTEGER REFERENCES channels(id);
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS customer_external_id TEXT;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS customer_contact_id TEXT;

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at ON messages (conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_assigned_status ON conversations (assigned_agent_id, status);
    CREATE INDEX IF NOT EXISTS idx_conversations_inbox ON conversations (status, assigned_agent_id, last_activity_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations (channel_id, customer_external_id);

    -- Organizations and membership
    CREATE TABLE IF NOT EXISTS organizations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS org_users (
      org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'agent',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (org_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_org_users_user ON org_users (user_id);
    CREATE INDEX IF NOT EXISTS idx_org_users_org ON org_users (org_id);

    CREATE TABLE IF NOT EXISTS invites (
      id SERIAL PRIMARY KEY,
      org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent',
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '14 days',
      accepted_by_user_id INTEGER REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_invites_org_status ON invites (org_id, status);
  `);
}

async function getOrCreateChannel(name, type) {
  const { rows } = await pool.query(
    `INSERT INTO channels (name, type)
     VALUES ($1, $2)
     ON CONFLICT (name)
     DO UPDATE SET type = EXCLUDED.type
     RETURNING id, name, type`,
    [name, type]
  );
  return rows[0];
}

// ---- Microsoft Graph helpers (Outlook) ----
async function getGraphToken() {
  const tenant = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!tenant || !clientId || !clientSecret) throw new Error('Missing MS Graph env (MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET)');
  const params = new URLSearchParams();
  params.set('client_id', clientId);
  params.set('client_secret', clientSecret);
  params.set('grant_type', 'client_credentials');
  params.set('scope', 'https://graph.microsoft.com/.default');
  const resp = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
  });
  const json = await resp.json();
  if (!resp.ok || !json.access_token) throw new Error('Graph token error: ' + JSON.stringify(json));
  return json.access_token;
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Helpers for URLs and auth guards
function baseUrlFromReq(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function requireOwner(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'unauthorized' });
  const u = req.session.user;
  if (!u?.org?.id || u.role !== 'owner') return res.status(403).json({ error: 'forbidden' });
  next();
}

// Parse a simple SendPulse email bridge format:
// [SP]\nplatform=instagram\nchat_id=123\nname=John Doe\ntext=Hello there
function parseSendPulseEmailBridge(raw) {
  try {
    const s = String(raw || '');
    const start = s.indexOf('[SP]');
    if (start === -1) return null;
    // Take up to ~1.5k chars to keep within bodyPreview limits
    const block = s.slice(start, start + 1500);
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length || lines[0] !== '[SP]') return null;
    const map = {};
    for (const line of lines.slice(1)) {
      const m = line.match(/^([a-zA-Z0-9_\.\-]+)=(.*)$/);
      if (m) map[m[1].toLowerCase()] = m[2].trim();
    }
    const platform = (map.platform || '').toLowerCase();
    const chatId = map.chat_id || map.contact_id || '';
    const name = map.name || 'User';
    const text = map.text || '';
    if (!platform || !chatId || !text) return null;
    if (platform !== 'facebook' && platform !== 'instagram') return null;
    return { platform, chatId, name, text };
  } catch { return null; }
}

async function sendOutlookMail(to, subject, text) {
  const mailbox = process.env.MS_MAILBOX;
  if (!mailbox) throw new Error('Missing MS_MAILBOX');
  const token = await getGraphToken();
  const body = {
    message: {
      subject: subject || 'Re: Support conversation',
      body: { contentType: 'Text', content: text },
      toRecipients: [{ emailAddress: { address: to } }]
    },
    saveToSentItems: true
  };
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`;
  const r = await fetch(url, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    const t = await r.text();
    console.error('Outlook sendMail failed', r.status, t);
  }
}

// MSA (personal Outlook) delegated token from file with refresh support
async function getMSATokenFromFile() {
  const filePath = process.env.MSA_TOKEN_FILE || path.join(__dirname, 'tokens', 'outlook_msa.json');
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const tok = JSON.parse(raw);
    const now = Math.floor(Date.now() / 1000);
    if (tok.expires_at && tok.expires_at - 60 > now) {
      return tok.access_token;
    }
    // refresh
    const params = new URLSearchParams();
    params.set('client_id', process.env.MS_CLIENT_ID);
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', tok.refresh_token);
    params.set('scope', 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access');
    const resp = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
    });
    const json = await resp.json();
    if (!resp.ok || !json.access_token) throw new Error('MSA token refresh failed: ' + JSON.stringify(json));
    const updated = {
      access_token: json.access_token,
      refresh_token: json.refresh_token || tok.refresh_token,
      expires_at: now + (json.expires_in || 3600)
    };
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(updated, null, 2));
    return updated.access_token;
  } catch (e) {
    console.error('MSA token file error', e.message);
    throw e;
  }
}

async function sendOutlookMailMSA(to, subject, text) {
  const token = await getMSATokenFromFile();
  const body = {
    message: {
      subject: subject || 'Re: Support conversation',
      body: { contentType: 'Text', content: text },
      toRecipients: [{ emailAddress: { address: to } }]
    },
    saveToSentItems: true
  };
  const url = 'https://graph.microsoft.com/v1.0/me/sendMail';
  const r = await fetch(url, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    const t = await r.text();
    console.error('Outlook MSA sendMail failed', r.status, t);
  }
}

const app = express();
// Trust proxy so req.protocol is accurate behind tunnels (ngrok, cloudflared)
app.set('trust proxy', true);
const server = http.createServer(app);
const io = new Server(server);

// Meta Webhooks (Messenger & Instagram)
app.get('/webhooks/meta', (req, res) => {
  return res.sendStatus(410); // Meta webhook disabled
});

app.post('/webhooks/meta', express.raw({ type: 'application/json' }), async (req, res) => {
  return res.sendStatus(410); // Meta webhook disabled
});

// Sessions (stored in Postgres)
app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions' }),
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' }
}));

// In-memory maps for agent connections
const agentSockets = new Map(); // agentId -> socketId
const socketAgent = new Map(); // socketId -> agentId

// Parse JSON bodies globally (for webhooks and APIs)
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

// Avoid 404 noise for browsers requesting /favicon.ico
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Serve the chat UI at /chat as well (alias to index.html)
app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve dedicated UIs
app.get('/customer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'customer.html'));
});

app.get('/agent', (req, res) => {
  if (!req.session || !req.session.user) return res.redirect('/login');
  return res.redirect('/dashboard');
});

// Dashboard alias and additional pages
app.get('/dashboard', (req, res) => {
  if (!req.session || !req.session.user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'agent.html'));
});

app.get('/notifications', (req, res) => {
  if (!req.session || !req.session.user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'notifications.html'));
});

app.get('/settings', (req, res) => {
  if (!req.session || !req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'owner') return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// Public invite acceptance page
app.get('/invite', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'invite.html'));
});

// Analytics summary
app.get('/analytics/summary', async (req, res) => {
  try {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'unauthorized' });
    const q = await pool.query(`
      SELECT 
        (SELECT COUNT(1) FROM conversations WHERE status = 'open') AS total_open,
        (SELECT COUNT(1) FROM conversations WHERE status = 'open' AND assigned_agent_id IS NULL) AS unassigned_open,
        (SELECT COUNT(1) FROM conversations WHERE status = 'pending') AS pending,
        (SELECT COUNT(1) FROM conversations WHERE status = 'closed') AS closed,
        (SELECT COUNT(1) FROM agents WHERE online = TRUE) AS online_agents,
        (SELECT COUNT(1) FROM messages WHERE created_at >= NOW() - INTERVAL '24 hours') AS messages_24h,
        (SELECT COUNT(1) FROM conversations WHERE status = 'open' AND last_sender = 'customer' AND (assigned_agent_id IS NULL)) AS notifications_unread
    `);
    const r = q.rows[0] || {};
    res.json({
      totalOpen: Number(r.total_open || 0),
      unassignedOpen: Number(r.unassigned_open || 0),
      pending: Number(r.pending || 0),
      closed: Number(r.closed || 0),
      onlineAgents: Number(r.online_agents || 0),
      messages24h: Number(r.messages_24h || 0),
      notificationsUnread: Number(r.notifications_unread || 0)
    });
  } catch (e) {
    console.error('analytics summary error', e);
    res.status(500).json({ error: 'failed' });
  }
});

app.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/agent');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  if (req.session?.user) return res.redirect('/agent');
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Mock channel simulator UI (feature-flagged)
if (SIMULATOR_ENABLED) {
  app.get('/simulator', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'simulator.html'));
  });
}

// Outlook webhook validation (Graph GET handshake)
app.get('/webhooks/outlook', (req, res) => {
  const token = req.query.validationToken;
  if (token) return res.status(200).send(token);
  return res.sendStatus(400);
});

// Internal ingest used by MSA poller (secured by header key)
app.post('/ingest/outlook', async (req, res) => {
  try {
    const key = req.headers['x-ingest-key'];
    if (!process.env.INTEGRATION_INGEST_KEY || key !== process.env.INTEGRATION_INGEST_KEY) return res.sendStatus(403);
    const fromEmail = (req.body?.fromEmail || '').toString().trim();
    const text = (req.body?.text || '').toString().trim();
    if (!fromEmail || !text) return res.status(400).json({ error: 'Missing fromEmail or text' });

    // Bridge: detect SendPulse formatted emails and route to FB/IG channel
    const sp = parseSendPulseEmailBridge(text);
    if (sp) {
      const { platform, chatId, name, text: body } = sp;
      const channel = await getOrCreateChannel(platform, platform);
      let conv = await pool.query(
        `SELECT * FROM conversations WHERE channel_id = $1 AND customer_external_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
        [channel.id, chatId]
      ).then(r => r.rows[0] || null);
      if (!conv) {
        const pick = await pool.query(
          `SELECT a.id, a.name, a.socket_id,
                  (SELECT COUNT(1) FROM conversations c WHERE c.assigned_agent_id = a.id AND c.status = 'open') AS open_count
           FROM agents a WHERE a.online = TRUE AND a.socket_id IS NOT NULL
           ORDER BY open_count ASC, a.id ASC LIMIT 1`
        ).then(r => r.rows[0] || null);
        conv = await pool.query(
          `INSERT INTO conversations (customer_name, status, assigned_agent_id, channel_id, customer_external_id)
           VALUES ($1, 'open', $2, $3, $4) RETURNING *`,
          [name, pick ? pick.id : null, channel.id, chatId]
        ).then(r => r.rows[0]);
        if (pick?.socket_id) io.to(pick.socket_id).emit('conversation:assigned', conv);
      }
      const saved = await pool.query(
        `INSERT INTO messages (username, content, conversation_id, sender)
         VALUES ($1, $2, $3, 'customer') RETURNING id, username, content, created_at, sender, conversation_id`,
        [name, body.slice(0, 2000), conv.id]
      ).then(r => r.rows[0]);
      await pool.query(`UPDATE conversations SET last_activity_at = NOW(), last_sender = 'customer' WHERE id = $1`, [conv.id]);
      io.to(`conv:${conv.id}`).emit('conversation:message', saved);
      io.emit('inbox:update', { conversationId: conv.id, last_sender: 'customer' });
      return res.sendStatus(200);
    }

    // Default: route as Outlook email
    const ch = await getOrCreateChannel('outlook', process.env.OUTLOOK_PERSONAL === 'true' ? 'email-msa' : 'email');
    let conv = await pool.query(
      `SELECT * FROM conversations WHERE channel_id = $1 AND customer_external_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
      [ch.id, fromEmail]
    ).then(r => r.rows[0]);
    if (!conv) {
      const pick = await pool.query(
        `SELECT a.id, a.name, a.socket_id,
                (SELECT COUNT(1) FROM conversations c WHERE c.assigned_agent_id = a.id AND c.status = 'open') AS open_count
         FROM agents a WHERE a.online = TRUE AND a.socket_id IS NOT NULL
         ORDER BY open_count ASC, a.id ASC LIMIT 1`
      ).then(r => r.rows[0] || null);
      conv = await pool.query(
        `INSERT INTO conversations (customer_name, status, assigned_agent_id, channel_id, customer_external_id)
         VALUES ($1, 'open', $2, $3, $4) RETURNING *`,
        [fromEmail, pick ? pick.id : null, ch.id, fromEmail]
      ).then(r => r.rows[0]);
      if (pick?.socket_id) io.to(pick.socket_id).emit('conversation:assigned', conv);
    }
    const saved = await pool.query(
      `INSERT INTO messages (username, content, conversation_id, sender)
       VALUES ($1, $2, $3, 'customer') RETURNING id, username, content, created_at, sender, conversation_id`,
      [fromEmail, text.slice(0, 2000), conv.id]
    ).then(r => r.rows[0]);
    await pool.query(`UPDATE conversations SET last_activity_at = NOW(), last_sender = 'customer' WHERE id = $1`, [conv.id]);
    io.to(`conv:${conv.id}`).emit('conversation:message', saved);
    io.emit('inbox:update', { conversationId: conv.id, last_sender: 'customer' });
    res.sendStatus(200);
  } catch (e) {
    console.error('Ingest outlook error', e);
    res.status(500).json({ error: 'Failed to ingest' });
  }
});

// Debug: fetch latest messages for a SendPulse Instagram contact
app.get('/debug/sendpulse/ig/messages', async (req, res) => {
  try {
    const chatId = (req.query.chat_id || req.query.chatId || '').toString().trim();
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    if (!chatId) return res.status(400).json({ error: 'Missing chat_id' });

    const sanitize = (b) => (b || '').trim().replace(/\/+$/, '');
    const envBase = sanitize(process.env.SENDPULSE_API_BASE || 'https://api.sendpulse.com');
    const bases = Array.from(new Set([envBase, sendpulseToken.base || null, 'https://api.eu.sendpulse.com', 'https://api.sendpulse.com'].filter(Boolean)));

    const tryPaths = [
      (base) => ({ method: 'GET', url: `${base}/instagram/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}` }),
      (base) => ({ method: 'GET', url: `${base}/instagram/chats/messages?chat_id=${encodeURIComponent(chatId)}&limit=${limit}` }),
      (base) => ({ method: 'GET', url: `${base}/chatbots/contacts/${encodeURIComponent(chatId)}/messages?limit=${limit}` }),
    ];

    let lastErr = null;
    for (const base of bases) {
      for (const build of tryPaths) {
        try {
          const { method, url } = build(base);
          const token = await getSendpulseToken(false, base);
          const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
          const text = await r.text().catch(() => '');
          let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
          if (r.ok) return res.json({ ok: true, base, url, data: json ?? text });
          // if unauthorized, refresh token once for this base
          if (r.status === 401 || r.status === 403) {
            const t2 = await getSendpulseToken(true, base);
            const r2 = await fetch(url, { method, headers: { Authorization: `Bearer ${t2}` } });
            const text2 = await r2.text().catch(() => '');
            let json2 = null; try { json2 = text2 ? JSON.parse(text2) : null; } catch {}
            if (r2.ok) return res.json({ ok: true, base, url, data: json2 ?? text2 });
            lastErr = { base, url, status: r2.status, body: (text2 || '').slice(0, 1200) };
          } else {
            lastErr = { base, url, status: r.status, body: (text || '').slice(0, 1200) };
          }
        } catch (e) {
          lastErr = { base, error: e.message };
        }
      }
    }
    return res.status(502).json({ ok: false, error: 'Failed to fetch from SendPulse', lastErr });
  } catch (e) {
    console.error('debug sp ig messages error', e);
    return res.status(500).json({ error: 'internal error', details: e.message });
  }
});

// Admin: backfill missing IG contact_id for open conversations
app.post('/admin/backfill/ig-contacts', async (req, res) => {
  try {
    // Authorization: owner session OR header/query key matching INTEGRATION_INGEST_KEY (or SENDPULSE_WEBHOOK_KEY)
    const key = (req.get('X-Backfill-Key') || req.query.key || '').toString();
    const allowKey = process.env.INTEGRATION_INGEST_KEY || process.env.SENDPULSE_WEBHOOK_KEY || '';
    const isOwner = !!(req.session?.user && req.session.user.role === 'owner');
    if (!isOwner && (!allowKey || key !== allowKey)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);

    const ch = await pool.query(`SELECT id FROM channels WHERE name = 'instagram' LIMIT 1`).then(r => r.rows[0] || null);
    if (!ch) return res.json({ ok: true, scanned: 0, updated: 0, skipped: 0, details: [] });

    const rows = await pool.query(
      `SELECT id, customer_external_id, customer_contact_id
       FROM conversations
       WHERE channel_id = $1 AND status = 'open'
         AND (customer_contact_id IS NULL OR customer_contact_id = '')
       ORDER BY last_activity_at DESC
       LIMIT $2`,
      [ch.id, limit]
    ).then(r => r.rows);

    let scanned = 0, updated = 0, skipped = 0;
    const details = [];

    for (const conv of rows) {
      scanned++;
      const chatId = String(conv.customer_external_id || '').trim();
      if (!chatId) { skipped++; details.push({ id: conv.id, reason: 'missing chatId' }); continue; }
      try {
        const rec = await resolveIgContactId(chatId);
        if (rec?.contact_id) {
          await pool.query(
            `UPDATE conversations SET customer_contact_id = $2 WHERE id = $1 AND (customer_contact_id IS NULL OR customer_contact_id = '')`,
            [conv.id, String(rec.contact_id)]
          );
          updated++;
          details.push({ id: conv.id, chat_id: chatId, contact_id: String(rec.contact_id), base: rec.base });
        } else {
          skipped++; details.push({ id: conv.id, chat_id: chatId, reason: 'resolve failed' });
        }
      } catch (e) {
        skipped++; details.push({ id: conv.id, chat_id: chatId, error: e.message });
      }
    }

    return res.json({ ok: true, scanned, updated, skipped, details });
  } catch (e) {
    console.error('backfill ig contacts error', e);
    return res.status(500).json({ error: 'internal error', details: e.message });
  }
});

app.get('/messages', async (req, res) => {
  try {
    const convId = req.query.conversationId ? parseInt(req.query.conversationId, 10) : null;
    if (convId) {
      const { rows } = await pool.query(
        `SELECT id, username, content, created_at, sender, conversation_id
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at ASC
         LIMIT 200`,
        [convId]
      );
      return res.json(rows);
    }
    // Fallback: last 100 across all conversations (for legacy /chat page)
    const { rows } = await pool.query(
      `SELECT id, username, content, created_at, sender, conversation_id
       FROM messages
       ORDER BY created_at ASC
       LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching messages', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// SendPulse webhook (FB/IG inbound)
app.post('/webhooks/sendpulse', express.urlencoded({ extended: true }), express.json(), async (req, res) => {
  try {
    // Debug: log headers and body (truncate body to avoid noise)
    try {
      const hDump = Object.fromEntries(Object.entries(req.headers || {}));
      console.log('SP webhook headers', hDump);
      console.log('SP webhook body', JSON.stringify(req.body || {}).slice(0, 2000));
    } catch {}

    // Verify optional webhook key with a strict flag (default: not strict)
    const strict = (process.env.SENDPULSE_WEBHOOK_STRICT || 'false') === 'true';
    if (SENDPULSE_WEBHOOK_KEY) {
      const key = req.get('X-Webhook-Key') || req.get('x-webhook-key') || '';
      if (strict && key !== SENDPULSE_WEBHOOK_KEY) {
        console.warn('SP webhook key mismatch (strict).');
        return res.sendStatus(403);
      }
      if (!strict && key !== SENDPULSE_WEBHOOK_KEY) {
        console.warn('SP webhook key mismatch (non-strict) — proceeding for dev');
      }
    }

    const b = Array.isArray(req.body) ? (req.body[0] || {}) : (req.body || {});
    const botId = b.bot_id || b.botId || (b?.bot?.id) || '';

    // Debug toggle (default on for now)
    const dbgEnabled = (process.env.DEBUG_SP_WEBHOOK || 'true') === 'true';

    // Platform inference: explicit, by bot id, or alternative fields (including nested event/payload)
    let platform = (
      b.platform || b.source || b.provider || b.channel || b.service || b?.bot?.platform || b?.bot?.provider || b?.bot?.channel ||
      b?.event?.platform || b?.event?.source || b?.event?.provider || ''
    ).toString().toLowerCase();

    const matchedEnv = {
      fbMatch: !!(botId && SENDPULSE_BOT_ID_FACEBOOK && botId === SENDPULSE_BOT_ID_FACEBOOK),
      igMatch: !!(botId && SENDPULSE_BOT_ID_INSTAGRAM && botId === SENDPULSE_BOT_ID_INSTAGRAM)
    };
    if (dbgEnabled) {
      console.log('SP debug: bot/platform', {
        botId,
        envFB: SENDPULSE_BOT_ID_FACEBOOK,
        envIG: SENDPULSE_BOT_ID_INSTAGRAM,
        platformCandidate: platform,
        fbMatch: matchedEnv.fbMatch,
        igMatch: matchedEnv.igMatch,
      });
    }

    if (!platform) {
      if (matchedEnv.fbMatch) platform = 'facebook';
      else if (matchedEnv.igMatch) platform = 'instagram';
    }

    // Ignore non-incoming events (e.g., outgoing_message, delivered, read) to avoid echo/auto-reply loops
    try {
      const title = (b.title || b?.event?.title || '').toString().toLowerCase();
      if (title && title !== 'incoming_message') {
        if (dbgEnabled) console.log('SP debug: skipping non-incoming', { title });
        return res.sendStatus(200);
      }
    } catch {}

    // Chat ID extraction across common shapes (including nested event/payload)
    let chatId = (
      b.chat_id || b.chatId || b.contact_id || b.contactId ||
      b?.contact?.id || b?.contact?.contact_id || b?.contact?.chat_id ||
      b?.subscriber?.id || b?.subscriber?.contact_id || b?.subscriber?.chat_id ||
      b?.user?.id || b?.user?.chat_id || b?.user?.uid ||
      b?.data?.chat_id || b?.payload?.chat_id || b?.payload?.contact_id ||
      b?.event?.chat_id || b?.event?.contact_id || b?.event?.payload?.chat_id || ''
    );
    chatId = (chatId == null ? '' : String(chatId));

    // Text extraction across common shapes (including attachments/captions)
    let text = (
      b.text || b?.message?.text || b?.last_message?.text || b?.contact?.last_message || b?.contact?.last_message_data?.message?.text || b?.info?.message?.channel_data?.message?.text ||
      (Array.isArray(b.messages) && b.messages[0]?.text) ||
      b?.payload?.text || b?.data?.text || b?.event?.text || b?.event?.data?.text ||
      b?.message?.caption || b?.payload?.caption || b?.data?.caption || ''
    );
    text = (text == null ? '' : String(text)).trim();

    // Name extraction across common shapes
    const name = (
      b?.contact?.name || [b?.contact?.first_name, b?.contact?.last_name].filter(Boolean).join(' ') ||
      b?.user?.name || b?.sender_name || b?.subscriber?.name || 'User'
    ).toString();

    if (dbgEnabled) {
      console.log('SP debug: resolved', {
        platform,
        botId,
        fbMatch: matchedEnv.fbMatch,
        igMatch: matchedEnv.igMatch,
        chatIdLen: (chatId || '').length,
        textLen: (text || '').length,
        hasText: !!text,
        name
      });
    }

    // If platform and chatId are present but text is missing (media-only, sticker, etc.), use a placeholder
    if (!text) text = '[non-text message]';

    if (!platform || !chatId) {
      console.warn('SP webhook missing fields', { platform, chatIdLen: chatId?.length || 0, textLen: text?.length || 0 });
      if (dbgEnabled) {
        try { console.log('SP debug: payload keys', Object.keys(b || {})); } catch {}
      }
      return res.sendStatus(200);
    }

    const channel = await getOrCreateChannel(platform, platform);

    // Try to capture contact_id from payload to persist for future sends
    let contactIdFromPayload = (
      b?.contact?.id || b?.contact_id || b?.contactId || b?.subscriber?.id || b?.user?.id ||
      b?.event?.contact_id || b?.payload?.contact_id || b?.data?.contact_id || null
    );
    contactIdFromPayload = contactIdFromPayload ? String(contactIdFromPayload) : null;

    // Find or create conversation for this chat/user id
    let convRes = await pool.query(
      `SELECT * FROM conversations WHERE channel_id = $1 AND customer_external_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
      [channel.id, chatId]
    );
    let conversation;
    let picked = null;
    if (!convRes.rowCount) {
      const pickRes = await pool.query(
        `SELECT a.id, a.name, a.socket_id,
                (SELECT COUNT(1) FROM conversations c WHERE c.assigned_agent_id = a.id AND c.status = 'open') AS open_conversations
         FROM agents a
         WHERE a.online = TRUE AND a.socket_id IS NOT NULL
         ORDER BY open_conversations ASC, a.id ASC
         LIMIT 1`
      );
      picked = pickRes.rows[0] || null;
      convRes = await pool.query(
        `INSERT INTO conversations (customer_name, status, assigned_agent_id, channel_id, customer_external_id, customer_contact_id)
         VALUES ($1, 'open', $2, $3, $4, $5)
         RETURNING *`,
        [name || `${platform} User`, picked ? picked.id : null, channel.id, chatId, contactIdFromPayload]
      );
      conversation = convRes.rows[0];
      if (picked && picked.socket_id) {
        io.to(picked.socket_id).emit('conversation:assigned', conversation);
      }
    } else {
      conversation = convRes.rows[0];
      // Update contact_id if we learned a new one
      if (contactIdFromPayload && !conversation.customer_contact_id) {
        try {
          await pool.query(`UPDATE conversations SET customer_contact_id = $2 WHERE id = $1`, [conversation.id, contactIdFromPayload]);
          conversation.customer_contact_id = contactIdFromPayload;
        } catch {}
      }
    }

    if (!(await isRecentDuplicate(conversation.id, 'customer', text))) {
      const insertSQL = `
        INSERT INTO messages (username, content, conversation_id, sender)
        VALUES ($1, $2, $3, 'customer')
        RETURNING id, username, content, created_at, sender, conversation_id`;
      const saved = await pool.query(insertSQL, [name || `${platform} User`, text, conversation.id]).then(r => r.rows[0]);

      await pool.query(
        `UPDATE conversations SET last_activity_at = NOW(), last_sender = 'customer' WHERE id = $1`,
        [conversation.id]
      );

      const room = `conv:${conversation.id}`;
      io.to(room).emit('conversation:message', saved);
      io.emit('inbox:update', { conversationId: conversation.id, last_sender: 'customer' });
      notifyInternalNewMessage({ platform, chatId, name, text, conversationId: conversation.id, baseUrl: baseUrlFromReq(req) })
        .catch((e) => console.error('notify error', e));
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('SendPulse webhook error', err);
    res.status(200).end();
  }
});

// Telegram webhook (inbound)
app.post('/webhooks/telegram', express.json(), async (req, res) => {
  try {
    const update = req.body || {};
    const msg = update.message;
    if (!msg || typeof msg.text !== 'string') return res.sendStatus(200);
    const chatId = String(msg.chat?.id || '');
    const text = msg.text.trim();
    const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || 'Telegram User';
    if (!chatId || !text) return res.sendStatus(200);

    const channel = await getOrCreateChannel('telegram', 'telegram');

    // Find or create conversation for this chat
    let convRes = await pool.query(
      `SELECT * FROM conversations WHERE channel_id = $1 AND customer_external_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
      [channel.id, chatId]
    );
    let conversation;
    let picked = null;
    if (!convRes.rowCount) {
      const pickRes = await pool.query(
        `SELECT a.id, a.name, a.socket_id,
                (SELECT COUNT(1) FROM conversations c WHERE c.assigned_agent_id = a.id AND c.status = 'open') AS open_conversations
         FROM agents a
         WHERE a.online = TRUE AND a.socket_id IS NOT NULL
         ORDER BY open_conversations ASC, a.id ASC
         LIMIT 1`
      );
      picked = pickRes.rows[0] || null;
      convRes = await pool.query(
        `INSERT INTO conversations (customer_name, status, assigned_agent_id, channel_id, customer_external_id)
         VALUES ($1, 'open', $2, $3, $4)
         RETURNING *`,
        [name, picked ? picked.id : null, channel.id, chatId]
      );
      conversation = convRes.rows[0];
      if (picked && picked.socket_id) {
        io.to(picked.socket_id).emit('conversation:assigned', conversation);
      }
    } else {
      conversation = convRes.rows[0];
    }

    const insertSQL = `
      INSERT INTO messages (username, content, conversation_id, sender)
      VALUES ($1, $2, $3, 'customer')
      RETURNING id, username, content, created_at, sender, conversation_id`;
    const { rows } = await pool.query(insertSQL, [name, text, conversation.id]);
    const saved = rows[0];

    await pool.query(
      `UPDATE conversations SET last_activity_at = NOW(), last_sender = 'customer' WHERE id = $1`,
      [conversation.id]
    );

    const room = `conv:${conversation.id}`;
    io.to(room).emit('conversation:message', saved);
    io.emit('inbox:update', { conversationId: conversation.id, last_sender: 'customer' });
    res.sendStatus(200);
  } catch (err) {
    console.error('Telegram webhook error', err);
    res.status(500).json({ error: 'Failed to process telegram update' });
  }
});

// Twilio WhatsApp webhook (inbound)
app.post('/webhooks/whatsapp', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    // Optional signature verification
    try {
      const signature = req.get('X-Twilio-Signature') || '';
      const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      const valid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, fullUrl, req.body || {});
      if (TWILIO_WEBHOOK_STRICT && !valid) {
        return res.status(403).send('Invalid signature');
      }
    } catch (sigErr) {
      if (TWILIO_WEBHOOK_STRICT) return res.status(403).send('Signature check failed');
    }

    const fromRaw = (req.body?.From || '').toString(); // e.g., "whatsapp:+234..."
    const waId = (req.body?.WaId || '').toString();    // e.g., "234..."
    const text = (req.body?.Body || '').toString().trim();
    const profileName = (req.body?.ProfileName || '').toString().trim();

    if (!fromRaw || !text) return res.sendStatus(200);

    const number = fromRaw.replace(/^whatsapp:/, ''); // +234...
    const customerExternalId = number; // store E.164 number without the whatsapp: prefix
    const customerName = (profileName || `WhatsApp ${waId || number}`).slice(0, 80);

    const channel = await getOrCreateChannel('whatsapp', 'whatsapp');

    // Find or create conversation for this WhatsApp user
    let convRes = await pool.query(
      `SELECT * FROM conversations WHERE channel_id = $1 AND customer_external_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
      [channel.id, customerExternalId]
    );
    let conversation;
    let picked = null;

    if (!convRes.rowCount) {
      const pickRes = await pool.query(
        `SELECT a.id, a.name, a.socket_id,
                (SELECT COUNT(1) FROM conversations c WHERE c.assigned_agent_id = a.id AND c.status = 'open') AS open_conversations
         FROM agents a
         WHERE a.online = TRUE AND a.socket_id IS NOT NULL
         ORDER BY open_conversations ASC, a.id ASC
         LIMIT 1`
      );
      picked = pickRes.rows[0] || null;

      convRes = await pool.query(
        `INSERT INTO conversations (customer_name, status, assigned_agent_id, channel_id, customer_external_id)
         VALUES ($1, 'open', $2, $3, $4)
         RETURNING *`,
        [customerName, picked ? picked.id : null, channel.id, customerExternalId]
      );
      conversation = convRes.rows[0];

      if (picked && picked.socket_id) {
        io.to(picked.socket_id).emit('conversation:assigned', conversation);
      }
    } else {
      conversation = convRes.rows[0];
    }

    const insertSQL = `
      INSERT INTO messages (username, content, conversation_id, sender)
      VALUES ($1, $2, $3, 'customer')
      RETURNING id, username, content, created_at, sender, conversation_id`;
    const { rows } = await pool.query(insertSQL, [customerName, text.slice(0, 2000), conversation.id]);
    const saved = rows[0];

    await pool.query(
      `UPDATE conversations SET last_activity_at = NOW(), last_sender = 'customer' WHERE id = $1`,
      [conversation.id]
    );

    const room = `conv:${conversation.id}`;
    io.to(room).emit('conversation:message', saved);
    io.emit('inbox:update', { conversationId: conversation.id, last_sender: 'customer' });

    // Optional: auto-acknowledge via TwiML (keeps customer engaged)
    try {
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Thanks! An agent will be with you shortly.');
      res.type('text/xml').send(twiml.toString());
    } catch (ackErr) {
      // If TwiML fails for any reason, just 200 OK
      res.sendStatus(200);
    }
  } catch (err) {
    console.error('WhatsApp webhook error', err);
    res.sendStatus(200);
  }
});

// Outlook webhook (POST notifications)
app.post('/webhooks/outlook', async (req, res) => {
  try {
    const mailbox = process.env.MS_MAILBOX;
    if (!mailbox) return res.status(500).json({ error: 'Missing MS_MAILBOX' });
    const clientState = process.env.MS_CLIENT_STATE || '';

    const events = Array.isArray(req.body?.value) ? req.body.value : [];
    if (!events.length) return res.sendStatus(202);

    const token = await getGraphToken();
    for (const n of events) {
      // Optional: verify clientState if set
      if (clientState && n.clientState && n.clientState !== clientState) continue;
      const messageId = n?.resourceData?.id;
      if (!messageId) continue;
      const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}?$select=subject,from,bodyPreview,body,conversationId,receivedDateTime`;
      const msg = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
      const fromEmail = msg?.from?.emailAddress?.address || 'unknown@example.com';
      const text = (msg?.bodyPreview || '').trim() || stripHtml(msg?.body?.content || '');

      // If this is a SendPulse email bridge, route to FB/IG instead of Outlook channel
      const sp = parseSendPulseEmailBridge(text);
      if (sp) {
        const { platform, chatId, name, text: body } = sp;
        const channel = await getOrCreateChannel(platform, platform);
        let conv = await pool.query(
          `SELECT * FROM conversations WHERE channel_id = $1 AND customer_external_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
          [channel.id, chatId]
        ).then(r => r.rows[0] || null);
        if (!conv) {
          const pick = await pool.query(
            `SELECT a.id, a.name, a.socket_id,
                    (SELECT COUNT(1) FROM conversations c WHERE c.assigned_agent_id = a.id AND c.status = 'open') AS open_count
             FROM agents a WHERE a.online = TRUE AND a.socket_id IS NOT NULL
             ORDER BY open_count ASC, a.id ASC LIMIT 1`
          ).then(r => r.rows[0] || null);
          conv = await pool.query(
            `INSERT INTO conversations (customer_name, status, assigned_agent_id, channel_id, customer_external_id)
             VALUES ($1, 'open', $2, $3, $4) RETURNING *`,
            [name, pick ? pick.id : null, channel.id, chatId]
          ).then(r => r.rows[0]);
          if (pick?.socket_id) io.to(pick.socket_id).emit('conversation:assigned', conv);
        }
        const saved = await pool.query(
          `INSERT INTO messages (username, content, conversation_id, sender)
           VALUES ($1, $2, $3, 'customer') RETURNING id, username, content, created_at, sender, conversation_id`,
          [name, body.slice(0, 2000), conv.id]
        ).then(r => r.rows[0]);
        await pool.query(`UPDATE conversations SET last_activity_at = NOW(), last_sender = 'customer' WHERE id = $1`, [conv.id]);
        io.to(`conv:${conv.id}`).emit('conversation:message', saved);
        io.emit('inbox:update', { conversationId: conv.id, last_sender: 'customer' });
        continue; // proceed to next Graph notification
      }

      if (!text) continue;

      const ch = await getOrCreateChannel('outlook', 'email');
      let conv = await pool.query(
        `SELECT * FROM conversations WHERE channel_id = $1 AND customer_external_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
        [ch.id, fromEmail]
      ).then(r => r.rows[0]);
      
      if (!conv) {
        const pick = await pool.query(
          `SELECT a.id, a.name, a.socket_id,
                  (SELECT COUNT(1) FROM conversations c WHERE c.assigned_agent_id = a.id AND c.status = 'open') AS open_count
           FROM agents a WHERE a.online = TRUE AND a.socket_id IS NOT NULL
           ORDER BY open_count ASC, a.id ASC LIMIT 1`
        ).then(r => r.rows[0] || null);

        conv = await pool.query(
          `INSERT INTO conversations (customer_name, status, assigned_agent_id, channel_id, customer_external_id)
           VALUES ($1, 'open', $2, $3, $4) RETURNING *`,
          [fromEmail, pick ? pick.id : null, ch.id, fromEmail]
        ).then(r => r.rows[0]);
        if (pick?.socket_id) io.to(pick.socket_id).emit('conversation:assigned', conv);
      }

      const saved = await pool.query(
        `INSERT INTO messages (username, content, conversation_id, sender)
         VALUES ($1, $2, $3, 'customer') RETURNING id, username, content, created_at, sender, conversation_id`,
        [fromEmail, text.slice(0, 2000), conv.id]
      ).then(r => r.rows[0]);

      await pool.query(`UPDATE conversations SET last_activity_at = NOW(), last_sender = 'customer' WHERE id = $1`, [conv.id]);
      io.to(`conv:${conv.id}`).emit('conversation:message', saved);
      io.emit('inbox:update', { conversationId: conv.id, last_sender: 'customer' });
    }
    res.sendStatus(202);
  } catch (e) {
    console.error('Outlook webhook error', e);
    res.status(500).json({ error: 'Failed to process outlook update' });
  }
});

// Auth API
app.get('/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'unauthorized' });
  const u = req.session.user;
  res.json({ id: u.id, email: u.email, name: u.name, org: u.org || null, role: u.role || 'agent' });
});

app.post('/auth/register', async (req, res) => {
  // Businesses only: use the new endpoint
  return res.status(400).json({ error: 'Business sign-ups only. Use /auth/register-business' });
});

app.post('/auth/register-business', async (req, res) => {
  try {
    const { companyName, name, email, password } = req.body || {};
    const cn = String(companyName || '').trim();
    const nm = String(name || '').trim();
    const em = String(email || '').trim().toLowerCase();
    const pw = String(password || '').trim();
    if (cn.length < 2 || nm.length < 2 || !em.includes('@') || pw.length < 8) {
      return res.status(400).json({ error: 'Invalid input' });
    }
    const hash = await bcrypt.hash(pw, 12);

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, name`,
      [em, hash, nm]
    ).then(r => r.rows[0] || null);
    if (!user) return res.status(409).json({ error: 'Email already registered' });

    const org = await pool.query(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id, name`,
      [cn]
    ).then(r => r.rows[0]);

    await pool.query(`INSERT INTO org_users (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [org.id, user.id]);

    req.session.user = { id: user.id, email: user.email, name: user.name, org: { id: org.id, name: org.name }, role: 'owner' };
    res.json(req.session.user);
  } catch (e) {
    console.error('register-business error', e);
    res.status(500).json({ error: 'Failed to register business' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const em = String(email || '').trim().toLowerCase();
    const pw = String(password || '').trim();
    if (!em || !pw) return res.status(400).json({ error: 'Missing email or password' });
    const { rows } = await pool.query(`SELECT id, email, name, password_hash FROM users WHERE email = $1`, [em]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const u = rows[0];
    const ok = await bcrypt.compare(pw, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const mem = await pool.query(
      `SELECT ou.org_id, ou.role, o.name
       FROM org_users ou LEFT JOIN organizations o ON o.id = ou.org_id
       WHERE ou.user_id = $1
       ORDER BY ou.created_at DESC
       LIMIT 1`,
      [u.id]
    ).then(r => r.rows[0] || null);

    const org = mem ? { id: mem.org_id, name: mem.name } : null;
    const role = mem ? mem.role : null;
    const user = { id: u.id, email: u.email, name: u.name, org, role };
    req.session.user = user;
    res.json(user);
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ error: 'Failed to login' });
  }
});

app.post('/auth/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(() => res.sendStatus(204));
  } else {
    res.sendStatus(204);
  }
});

// Invitations API
app.get('/invites', requireOwner, async (req, res) => {
  try {
    const orgId = req.session.user.org.id;
    const { rows } = await pool.query(
      `SELECT id, email, role, token, status, created_at, expires_at
       FROM invites
       WHERE org_id = $1
       ORDER BY created_at DESC
       LIMIT 200`,
      [orgId]
    );
    const base = baseUrlFromReq(req);
    const list = rows.map(r => ({
      id: r.id,
      email: r.email,
      role: r.role,
      status: r.status,
      created_at: r.created_at,
      expires_at: r.expires_at,
      acceptUrl: `${base}/invite?token=${encodeURIComponent(r.token)}`,
    }));
    res.json(list);
  } catch (e) {
    console.error('list invites error', e);
    res.status(500).json({ error: 'Failed to list invites' });
  }
});

app.post('/invites', requireOwner, async (req, res) => {
  try {
    const orgId = req.session.user.org.id;
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = (req.body?.role || 'agent').toString();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
    const token = crypto.randomBytes(24).toString('hex');
    const { rows } = await pool.query(
      `INSERT INTO invites (org_id, email, role, token)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, role, token, status, created_at, expires_at`,
      [orgId, email, role, token]
    );
    const base = baseUrlFromReq(req);
    const invite = rows[0];
    const acceptUrl = `${base}/invite?token=${encodeURIComponent(invite.token)}`;
    res.json({ id: invite.id, email: invite.email, role: invite.role, status: invite.status, created_at: invite.created_at, expires_at: invite.expires_at, acceptUrl });
  } catch (e) {
    console.error('create invite error', e);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

app.get('/invites/:token', async (req, res) => {
  try {
    const token = (req.params.token || '').toString();
    const { rows } = await pool.query(
      `SELECT i.email, i.role, i.status, i.expires_at, o.name AS org_name
       FROM invites i JOIN organizations o ON o.id = i.org_id
       WHERE i.token = $1`,
      [token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invalid invite' });
    const inv = rows[0];
    const expired = inv.expires_at && new Date(inv.expires_at) < new Date();
    res.json({ email: inv.email, role: inv.role, status: inv.status, orgName: inv.org_name, expired });
  } catch (e) {
    console.error('get invite error', e);
    res.status(500).json({ error: 'Failed to load invite' });
  }
});

app.post('/invites/:token/accept', async (req, res) => {
  try {
    const token = (req.params.token || '').toString();
    const { name, password } = req.body || {};
    const nm = String(name || '').trim();
    const pw = String(password || '').trim();

    const r = await pool.query(`SELECT * FROM invites WHERE token = $1`, [token]);
    if (!r.rowCount) return res.status(404).json({ error: 'Invalid invite' });
    const invite = r.rows[0];
    const expired = invite.expires_at && new Date(invite.expires_at) < new Date();
    if (invite.status !== 'pending' || expired) return res.status(409).json({ error: 'Invite no longer valid' });

    const email = String(invite.email || '').toLowerCase();
    let user = await pool.query(`SELECT id, email, name, password_hash FROM users WHERE email = $1`, [email]).then(x => x.rows[0] || null);

    if (!user) {
      if (nm.length < 2 || pw.length < 8) return res.status(400).json({ error: 'Invalid input' });
      const hash = await bcrypt.hash(pw, 12);
      user = await pool.query(
        `INSERT INTO users (email, password_hash, name)
         VALUES ($1, $2, $3)
         RETURNING id, email, name`,
        [email, hash, nm]
      ).then(x => x.rows[0]);
      await pool.query(`INSERT INTO org_users (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [invite.org_id, user.id, invite.role || 'agent']);
      await pool.query(`UPDATE invites SET status = 'accepted', accepted_by_user_id = $2 WHERE id = $1`, [invite.id, user.id]);
      req.session.user = { id: user.id, email: user.email, name: user.name, org: await pool.query(`SELECT id, name FROM organizations WHERE id = $1`, [invite.org_id]).then(r => r.rows[0]), role: invite.role || 'agent' };
      return res.json({ ok: true });
    }

    // Existing user: if password provided, verify and log them in; in all cases, add membership
    if (pw) {
      const ok = await bcrypt.compare(pw, user.password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
      req.session.user = { id: user.id, email: user.email, name: user.name };
    }

    await pool.query(`INSERT INTO org_users (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [invite.org_id, user.id, invite.role || 'agent']);
    await pool.query(`UPDATE invites SET status = 'accepted', accepted_by_user_id = $2 WHERE id = $1`, [invite.id, user.id]);

    // If we logged them in above, also enrich session with org/role
    if (req.session?.user) {
      const org = await pool.query(`SELECT id, name FROM organizations WHERE id = $1`, [invite.org_id]).then(x => x.rows[0]);
      req.session.user = { ...req.session.user, org, role: invite.role || 'agent' };
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('accept invite error', e);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// Inbox API: list conversations with filters and sorting by last activity
app.get('/conversations', async (req, res) => {
  try {
    const { status, assignedTo, limit } = req.query;
    const params = [];
    const clauses = [];

    if (status) { params.push(status); clauses.push(`conv.status = $${params.length}`); }
    if (assignedTo === 'null') { clauses.push('conv.assigned_agent_id IS NULL'); }
    else if (assignedTo) { params.push(parseInt(assignedTo, 10)); clauses.push(`conv.assigned_agent_id = $${params.length}`); }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const lim = Math.min(parseInt(limit || '50', 10), 200);

    const { rows } = await pool.query(
      `SELECT conv.id, conv.customer_name, conv.status, conv.assigned_agent_id, conv.created_at,
              conv.last_activity_at, conv.last_sender, conv.channel_id, COALESCE(ch.name, 'web') AS channel_name
       FROM conversations conv
       LEFT JOIN channels ch ON ch.id = conv.channel_id
       ${where}
       ORDER BY conv.last_activity_at DESC NULLS LAST, conv.id DESC
       LIMIT ${lim}`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listing conversations', err);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

// Claim a conversation (assign to current agent)
app.post('/conversations/:id/claim', express.json(), async (req, res) => {
  try {
    const { agentName } = req.body || {};
    const id = parseInt(req.params.id, 10);
    if (!id || !agentName) return res.status(400).json({ error: 'Missing id or agentName' });
    const agentRes = await pool.query('SELECT id, name FROM agents WHERE name = $1', [agentName]);
    if (!agentRes.rowCount) return res.status(404).json({ error: 'Agent not found' });
    const agent = agentRes.rows[0];
    const { rows } = await pool.query(
      `UPDATE conversations SET assigned_agent_id = $1 WHERE id = $2 RETURNING *`,
      [agent.id, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Conversation not found' });
    const conv = rows[0];
    const room = `conv:${conv.id}`;
    io.to(room).emit('conversation:agent', { conversationId: conv.id, agent: { id: agent.id, name: agent.name } });
    res.json(conv);
  } catch (err) {
    console.error('Error claiming conversation', err);
    res.status(500).json({ error: 'Failed to claim' });
  }
});

// Update conversation status (open, pending, closed)
app.post('/conversations/:id/status', express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status: newStatus } = req.body || {};
    if (!id || !newStatus) return res.status(400).json({ error: 'Missing id or status' });
    const { rows } = await pool.query(
      `UPDATE conversations SET status = $2 WHERE id = $1 RETURNING *`,
      [id, newStatus]
    );
    if (!rows.length) return res.status(404).json({ error: 'Conversation not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Error updating conversation status', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Mock WhatsApp inbound: simulate a webhook delivering a customer message (feature-flagged)
if (SIMULATOR_ENABLED) app.post('/mock/whatsapp/send', express.json(), async (req, res) => {
  try {
    const { customerExternalId, customerName, content } = req.body || {};
    const extId = (customerExternalId || '').toString().slice(0, 64).trim();
    const name = (customerName || 'WhatsApp User').toString().slice(0, 80).trim();
    const text = (content || '').toString().slice(0, 2000).trim();
    if (!extId || !text) return res.status(400).json({ error: 'Missing customerExternalId or content' });

    const channel = await getOrCreateChannel('whatsapp-mock', 'whatsapp');

    // Find or create an open conversation for this external user on this channel
    let convRes = await pool.query(
      `SELECT * FROM conversations WHERE channel_id = $1 AND customer_external_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
      [channel.id, extId]
    );
    let conversation;
    let picked = null;

    if (!convRes.rowCount) {
      // Pick least-loaded online agent
      const pickRes = await pool.query(
        `SELECT a.id, a.name, a.socket_id,
                (SELECT COUNT(1) FROM conversations c WHERE c.assigned_agent_id = a.id AND c.status = 'open') AS open_conversations
         FROM agents a
         WHERE a.online = TRUE AND a.socket_id IS NOT NULL
         ORDER BY open_conversations ASC, a.id ASC
         LIMIT 1`
      );
      picked = pickRes.rows[0] || null;

      convRes = await pool.query(
        `INSERT INTO conversations (customer_name, status, assigned_agent_id, channel_id, customer_external_id)
         VALUES ($1, 'open', $2, $3, $4)
         RETURNING *`,
        [name, picked ? picked.id : null, channel.id, extId]
      );
      conversation = convRes.rows[0];

      // Notify agent of new assignment
      if (picked && picked.socket_id) {
        io.to(picked.socket_id).emit('conversation:assigned', conversation);
      }
    } else {
      conversation = convRes.rows[0];
    }

    const insertSQL = `
      INSERT INTO messages (username, content, conversation_id, sender)
      VALUES ($1, $2, $3, 'customer')
      RETURNING id, username, content, created_at, sender, conversation_id`;
    const { rows } = await pool.query(insertSQL, [name, text, conversation.id]);
    const saved = rows[0];

    await pool.query(
      `UPDATE conversations SET last_activity_at = NOW(), last_sender = 'customer' WHERE id = $1`,
      [conversation.id]
    );

    const room = `conv:${conversation.id}`;
    io.to(room).emit('conversation:message', saved);
    io.emit('inbox:update', { conversationId: conversation.id, last_sender: 'customer' });

    return res.json({ conversation, message: saved, assignedAgent: picked ? { id: picked.id, name: picked.name } : null });
  } catch (err) {
    console.error('Mock WA send error', err);
    res.status(500).json({ error: 'Failed to process mock message' });
  }
});

// Mock WhatsApp: lookup existing open conversation by external id (feature-flagged)
if (SIMULATOR_ENABLED) app.get('/mock/whatsapp/get', async (req, res) => {
  try {
    const extId = (req.query.customerExternalId || '').toString().slice(0, 64).trim();
    if (!extId) return res.status(400).json({ error: 'Missing customerExternalId' });
    const channel = await getOrCreateChannel('whatsapp-mock', 'whatsapp');
    const convRes = await pool.query(
      `SELECT * FROM conversations WHERE channel_id = $1 AND customer_external_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
      [channel.id, extId]
    );
    if (!convRes.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json(convRes.rows[0]);
  } catch (err) {
    console.error('Mock WA get error', err);
    res.status(500).json({ error: 'Failed to lookup conversation' });
  }
});

// Twilio status callback (delivery events)
app.post('/webhooks/twilio/status', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    // Signature verification
    try {
      const signature = req.get('X-Twilio-Signature') || '';
      const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      const valid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, fullUrl, req.body || {});
      if (TWILIO_WEBHOOK_STRICT && !valid) return res.status(403).send('Invalid signature');
    } catch (e) {
      if (TWILIO_WEBHOOK_STRICT) return res.status(403).send('Signature check failed');
    }

    const messageSid = (req.body?.MessageSid || '').toString();
    const messageStatus = (req.body?.MessageStatus || '').toString(); // queued, sent, delivered, failed, read
    const to = (req.body?.To || '').toString(); // whatsapp:+E164

    // Emit status events to any interested UI (agent/customer rooms)
    // Try to locate conversation by customer_external_id = E.164 (without whatsapp:)
    const e164 = to.replace(/^whatsapp:/, '');
    const conv = await pool.query(
      `SELECT id FROM conversations WHERE channel_id = (
         SELECT id FROM channels WHERE name = 'whatsapp' LIMIT 1
       ) AND customer_external_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [e164]
    ).then(r => r.rows[0] || null);

    if (conv) {
      const room = `conv:${conv.id}`;
      io.to(room).emit('provider:status', {
        provider: 'twilio', channel: 'whatsapp', conversationId: conv.id,
        messageSid, status: messageStatus, to: e164,
      });
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Twilio status webhook error', err);
    return res.sendStatus(200);
  }
});

io.on('connection', (socket) => {
  console.log('Client connected', socket.id);

  socket.on('disconnect', async () => {
    console.log('Client disconnected', socket.id);
    const agentId = socketAgent.get(socket.id);
    if (agentId) {
      try {
        await pool.query('UPDATE agents SET online = FALSE, socket_id = NULL WHERE id = $1 AND socket_id = $2', [agentId, socket.id]);
      } catch (e) {
        console.error('Error marking agent offline', e);
      }
      socketAgent.delete(socket.id);
      agentSockets.delete(agentId);
    }
  });

  // Legacy global chat support (no conversation)
  socket.on('chat:message', async (payload) => {
    try {
      const username = (payload?.username || 'Anonymous').toString().slice(0, 50);
      const content = (payload?.content || '').toString().slice(0, 2000).trim();
      if (!content) return;

      const insertSQL = `
        INSERT INTO messages (username, content)
        VALUES ($1, $2)
        RETURNING id, username, content, created_at, sender, conversation_id
      `;
      const { rows } = await pool.query(insertSQL, [username, content]);
      const saved = rows[0];
      io.emit('chat:message', saved);
    } catch (err) {
      console.error('Error saving message', err);
      socket.emit('chat:error', { error: 'Failed to save message' });
    }
  });

  // Agent goes online / registers
  socket.on('agent:register', async (payload = {}) => {
    const name = (payload.name || 'Agent').toString().slice(0, 50).trim();
    if (!name) return;
    try {
      const { rows } = await pool.query(
        `INSERT INTO agents (name, online, socket_id)
         VALUES ($1, TRUE, $2)
         ON CONFLICT (name)
         DO UPDATE SET online = TRUE, socket_id = EXCLUDED.socket_id
         RETURNING id, name, online`,
        [name, socket.id]
      );
      const agent = rows[0];
      agentSockets.set(agent.id, socket.id);
      socketAgent.set(socket.id, agent.id);

      // Auto-assign oldest unassigned open conversations to this agent (up to a cap)
      const cap = 10;
      const assignedNow = await pool.query(
        `UPDATE conversations SET assigned_agent_id = $1
         WHERE id IN (
           SELECT id FROM conversations
           WHERE status = 'open' AND assigned_agent_id IS NULL
           ORDER BY created_at ASC
           LIMIT $2
         )
         RETURNING id, customer_name, status, assigned_agent_id, created_at`,
        [agent.id, cap]
      );

      // Load existing open assigned conversations for this agent (including newly assigned)
      const convRes = await pool.query(
        `SELECT id, customer_name, status, assigned_agent_id, created_at
         FROM conversations
         WHERE assigned_agent_id = $1 AND status = 'open'
         ORDER BY created_at ASC`,
        [agent.id]
      );

      socket.emit('agent:registered', { agent });
      socket.emit('agent:conversations', convRes.rows);

      // Notify customers in conversations that have just been assigned
      for (const conv of assignedNow.rows) {
        const room = `conv:${conv.id}`;
        io.to(room).emit('conversation:agent', { conversationId: conv.id, agent: { id: agent.id, name: agent.name } });
        // Also notify agent sidebar live
        io.to(socket.id).emit('conversation:assigned', conv);
      }
    } catch (err) {
      console.error('Error registering agent', err);
      socket.emit('agent:error', { error: 'Failed to register agent' });
    }
  });

  // Customer starts a conversation and gets assigned to an available agent
  socket.on('customer:start', async (payload = {}) => {
    const customerName = (payload.name || 'Customer').toString().slice(0, 80).trim();
    if (!customerName) return;
    try {
      // Pick the least-loaded online agent, if any
      const pickRes = await pool.query(
        `SELECT a.id, a.name, a.socket_id,
                (SELECT COUNT(1) FROM conversations c WHERE c.assigned_agent_id = a.id AND c.status = 'open') AS open_conversations
         FROM agents a
         WHERE a.online = TRUE AND a.socket_id IS NOT NULL
         ORDER BY open_conversations ASC, a.id ASC
         LIMIT 1`
      );
      const picked = pickRes.rows[0] || null;

      const webCh = await getOrCreateChannel('web', 'web');

      const convRes = await pool.query(
        `INSERT INTO conversations (customer_name, status, assigned_agent_id, channel_id)
         VALUES ($1, 'open', $2, $3)
         RETURNING id, customer_name, status, assigned_agent_id, created_at, channel_id`,
        [customerName, picked ? picked.id : null, webCh.id]
      );
      const conversation = convRes.rows[0];

      // Join customer to the conversation room
      const room = `conv:${conversation.id}`;
      socket.join(room);

      // Notify customer
      socket.emit('conversation:started', {
        conversation,
        assignedAgent: picked ? { id: picked.id, name: picked.name } : null,
      });

      // Notify the assigned agent if any
      if (picked && picked.socket_id) {
        io.to(picked.socket_id).emit('conversation:assigned', conversation);
        // Notify the customer room about the agent assignment as well
        io.to(room).emit('conversation:agent', { conversationId: conversation.id, agent: { id: picked.id, name: picked.name } });
      }
    } catch (err) {
      console.error('Error starting conversation', err);
      socket.emit('customer:error', { error: 'Failed to start conversation' });
    }
  });

  // Join a conversation room (for both agents and customers)
  socket.on('conversation:join', async (payload = {}) => {
    const conversationId = Number(payload.conversationId);
    if (!conversationId || Number.isNaN(conversationId)) return;
    const room = `conv:${conversationId}`;
    socket.join(room);
    socket.emit('conversation:joined', { conversationId });
  });

  // Send a message within a conversation
  socket.on('conversation:message', async (payload = {}) => {
    try {
      const conversationId = Number(payload.conversationId);
      const sender = (payload.sender === 'agent') ? 'agent' : 'customer';
      const username = (payload.username || (sender === 'agent' ? 'Agent' : 'Customer')).toString().slice(0, 80);
      const content = (payload.content || '').toString().slice(0, 2000).trim();
      if (!conversationId || Number.isNaN(conversationId) || !content) return;

      const insertSQL = `
        INSERT INTO messages (username, content, conversation_id, sender)
        VALUES ($1, $2, $3, $4)
        RETURNING id, username, content, created_at, sender, conversation_id`;
      const { rows } = await pool.query(insertSQL, [username, content, conversationId, sender]);
      const saved = rows[0];

      // Update conversation activity to bubble it in the inbox
      await pool.query(
        `UPDATE conversations
         SET last_activity_at = NOW(), last_sender = $2
         WHERE id = $1`,
        [conversationId, sender]
      );

      const room = `conv:${conversationId}`;
      io.to(room).emit('conversation:message', saved);
      // Also notify assigned agent list to refresh ordering (optional event)
      io.emit('inbox:update', { conversationId, last_sender: sender });

      // Outbound to provider (only when agent sends)
      if (sender === 'agent') {
        try {
          const q = await pool.query(
            `SELECT conv.customer_external_id, ch.name AS channel_name
             FROM conversations conv LEFT JOIN channels ch ON ch.id = conv.channel_id
             WHERE conv.id = $1`,
            [conversationId]
          );
          if (q.rowCount) {
            const { customer_external_id: extId, channel_name } = q.rows[0];
            // If instagram, try to load stored contact_id for accurate send
            let storedContactId = null;
            if (channel_name === 'instagram') {
              try {
                const r2 = await pool.query(`SELECT customer_contact_id FROM conversations WHERE id = $1`, [conversationId]);
                storedContactId = (r2.rows[0]?.customer_contact_id || null) ? String(r2.rows[0].customer_contact_id) : null;
              } catch {}
            }
            if (channel_name === 'telegram' && process.env.TELEGRAM_BOT_TOKEN && extId) {
              await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: extId, text: content })
              });
            } else if (channel_name === 'outlook' && extId) {
              try {
                if (process.env.OUTLOOK_PERSONAL === 'true') {
                  await sendOutlookMailMSA(extId, `Re: Conversation #${conversationId}`, content);
                } else {
                  await sendOutlookMail(extId, `Re: Conversation #${conversationId}`, content);
                }
              } catch (e) { console.error('Outlook send error', e); }
            } else if (channel_name === 'whatsapp' && extId) {
              try {
                if (!twilioClient || !TWILIO_WHATSAPP_FROM) {
                  console.error('Twilio not configured: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM');
                } else {
                  const to = extId.startsWith('whatsapp:') ? extId : `whatsapp:${extId}`;
await twilioClient.messages.create({
                    from: TWILIO_WHATSAPP_FROM, // e.g., 'whatsapp:+14155238886' (Sandbox)
                    to,
                    body: content,
                    statusCallback: TWILIO_STATUS_CALLBACK_URL || undefined,
                  });
                }
              } catch (e) {
                console.error('Twilio WhatsApp send error', e);
              }
            } else if ((channel_name === 'facebook' || channel_name === 'instagram') && extId) {
              try {
                // Prefer routing via custom chatbot relay if configured
                let sent = false;
                const cbRes = await sendViaChatbot({ platform: channel_name, chatId: storedContactId || extId, contactId: storedContactId || null, text: content, conversationId });
                if (cbRes) {
                  sent = !!cbRes.ok;
                  if (!cbRes.ok) console.warn('Chatbot outbound failed', cbRes);
                }
                if (!sent && CHATBOT_OUTBOUND_STRICT) {
                  // In strict mode, do not fall back to Meta/SendPulse
                  sent = true; // treat as handled to avoid fallback
                }
                if (!sent) {
                  const ok = await metaSendMessage(channel_name, extId, content);
                  sent = ok;
                }
                if (!sent) {
                  if (channel_name === 'instagram') {
                    // Use the Instagram-specific SendPulse API which only requires chat_id + text
                    // Prefer stored contact id if available; send helper will still resolve/fallback
                    const igOk = await sendPulseSendInstagram(storedContactId || extId, content);
                    if (!igOk) console.warn('SendPulse IG send failed for chat_id', extId);
                  } else if (channel_name === 'facebook') {
                    const botId = SENDPULSE_BOT_ID_FACEBOOK;
                    if (!botId) {
                      console.warn('Missing SendPulse bot id for facebook');
                    } else {
                      const fbOk = await sendPulseSendChatbots(botId, extId, content);
                      if (!fbOk) console.warn('SendPulse FB fallback failed for chat_id', extId);
                    }
                  }
                }
              } catch (e) {
                console.error('Meta/SendPulse/Chatbot send error', e);
              }
            }
          }
        } catch (sendErr) {
          console.error('Outbound send error', sendErr);
        }
      }
    } catch (err) {
      console.error('Error saving conversation message', err);
      socket.emit('conversation:error', { error: 'Failed to send message' });
    }
  });
});

(async function start() {
  try {
    await waitForDB(30, 1000);
    await initDb();
    server.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
})();
