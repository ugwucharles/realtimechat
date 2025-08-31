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
const META_APP_ID = process.env.META_APP_ID || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || '';
const IG_PAGE_ACCESS_TOKEN = process.env.IG_PAGE_ACCESS_TOKEN || '';
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
const META_WEBHOOK_STRICT = (process.env.META_WEBHOOK_STRICT || 'false') === 'true';


// ---- Outbound via Chatbot (custom relay) ----
const CHATBOT_OUTBOUND_URL = process.env.CHATBOT_OUTBOUND_URL || '';
const CHATBOT_OUTBOUND_INSTAGRAM_URL = process.env.CHATBOT_OUTBOUND_INSTAGRAM_URL || '';
const CHATBOT_OUTBOUND_KEY = process.env.CHATBOT_OUTBOUND_KEY || '';
const CHATBOT_OUTBOUND_STRICT = (process.env.CHATBOT_OUTBOUND_STRICT || 'false') === 'true';

// ---- SendPulse Configuration ----
const SENDPULSE_API_USER_ID = process.env.SENDPULSE_API_USER_ID || '';
const SENDPULSE_API_SECRET = process.env.SENDPULSE_API_SECRET || '';
const SENDPULSE_WEBHOOK_SECRET = process.env.SENDPULSE_WEBHOOK_SECRET || '';

// ---- Internal notifications ----
const INTERNAL_NOTIFY_SLACK_WEBHOOK = process.env.INTERNAL_NOTIFY_SLACK_WEBHOOK || '';
const INTERNAL_NOTIFY_DISCORD_WEBHOOK = process.env.INTERNAL_NOTIFY_DISCORD_WEBHOOK || '';
const INTERNAL_NOTIFY_EMAIL_TO = process.env.INTERNAL_NOTIFY_EMAIL_TO || '';
const INTERNAL_NOTIFY_ENABLED = (process.env.INTERNAL_NOTIFY_ENABLED || 'true') === 'true';



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

// SendPulse API helper to get access token
async function getSendPulseToken() {
  const clientId = process.env.SENDPULSE_CLIENT_ID || process.env.SENDPULSE_API_USER_ID;
  const clientSecret = process.env.SENDPULSE_CLIENT_SECRET || process.env.SENDPULSE_API_SECRET;
  if (!clientId || !clientSecret) return null;
  try {
    const url = 'https://api.sendpulse.com/oauth/access_token';
    const form = new URLSearchParams();
    form.set('grant_type', 'client_credentials');
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const json = await r.json();
    return r.ok ? json.access_token : null;
  } catch (e) {
    console.error('SendPulse token error', e.message);
    return null;
  }
}

// Send message via SendPulse Instagram API using chatbot trigger
async function sendPulseMessage(contactId, text) {
  try {
    if (!contactId || !text) return false;
    const token = await getSendPulseToken();
    if (!token) return false;

    // Try chatbot trigger first - this may work better for Instagram business accounts
    const chatbotUrl = 'https://api.sendpulse.com/messengers/flow/run';
    const chatbotPayload = {
      contact_id: String(contactId),
      bot_id: "68ab38663bef0841770e2282",
      trigger: "agent_message", // Try the original trigger name first
      variables: {
        agent_message: String(text),
        message: String(text),
        text: String(text), // Try multiple variable names
        content: String(text)
      }
    };

    console.log('   - Trying SendPulse Chatbot API (agent_message):', JSON.stringify(chatbotPayload, null, 2));
    
    const chatbotResponse = await fetch(chatbotUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(chatbotPayload)
    });
    
    if (chatbotResponse.ok) {
      console.log('   ✅ SendPulse Chatbot (agent_message) successful');
      return true;
    } else {
      const chatbotError = await chatbotResponse.text().catch(() => '');
      console.log('   ❌ Chatbot (agent_message) failed:', chatbotResponse.status, chatbotError);
      
      // Try alternative trigger names that might exist
      const alternativeTriggers = ['start', 'welcome', 'default', 'Standard reply', 'api_message'];
      
      for (const triggerName of alternativeTriggers) {
        console.log(`   - Trying alternative trigger: "${triggerName}"`);
        const altPayload = { ...chatbotPayload, trigger: triggerName };
        
        const altResponse = await fetch(chatbotUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(altPayload)
        });
        
        if (altResponse.ok) {
          console.log(`   ✅ SendPulse Chatbot (${triggerName}) successful!`);
          return true;
        } else {
          const altError = await altResponse.text().catch(() => '');
          console.log(`   ❌ Trigger "${triggerName}" failed:`, altResponse.status);
        }
      }
    }

    // Last resort: direct message API
    console.log('   - Falling back to direct message API');
    const directUrl = 'https://api.sendpulse.com/instagram/chats/messages';
    const directPayload = {
      chat_id: String(contactId),
      contact_id: String(contactId),
      text: String(text)
    };

    const directResponse = await fetch(directUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(directPayload)
    });
    
    if (!directResponse.ok) {
      const t = await directResponse.text().catch(() => '');
      console.warn('   ❌ SendPulse direct send failed', directResponse.status, t);
      return false;
    }
    
    console.log('   ✅ SendPulse direct message sent (may be blocked by Instagram)');
    return true;
  } catch (e) {
    console.error('SendPulse send error', e.message);
    return false;
  }
}

async function metaSendMessage(platform, recipientId, text) {
  try {
    if (!recipientId || !text) return false;
    // Prefer IG token for instagram; fallback to FB page token if IG not present
    const token = platform === 'instagram'
      ? (IG_PAGE_ACCESS_TOKEN || FB_PAGE_ACCESS_TOKEN)
      : FB_PAGE_ACCESS_TOKEN;
    if (!token) return false;

    const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/me/messages?access_token=${encodeURIComponent(token)}`;
    const payload = {
      recipient: { id: String(recipientId) },
      message: { text: String(text) },
      messaging_type: 'RESPONSE',
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

// Postgres connection: supports DATABASE_URL or individual vars. Use PGSSLMODE=require to enable TLS.
const DB_URL = process.env.DATABASE_URL || '';
const PGSSLMODE = (process.env.PGSSLMODE || 'disable').toLowerCase();
const ssl = PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined;

const pool = DB_URL
  ? new Pool({ connectionString: DB_URL, ssl })
  : new Pool({
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      user: process.env.PGUSER || 'chatapp',
      password: process.env.PGPASSWORD || 'chatpass',
      database: process.env.PGDATABASE || 'chatapp',
      ...(ssl ? { ssl } : {})
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
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token && token === META_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  } catch (e) {
    return res.sendStatus(500);
  }
});

// SendPulse webhook for Instagram messages
app.post('/webhooks/sendpulse/instagram', express.json(), async (req, res) => {
  try {
    console.log('=== SendPulse Instagram Webhook Received ===');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Raw Body:', JSON.stringify(req.body, null, 2));
    
    // SendPulse webhook verification (optional)
    const authKey = req.headers['x-sendpulse-key'] || req.headers['authorization'] || '';
    console.log('Auth Key:', authKey);
    
    const payload = req.body || {};
    console.log('SendPulse Instagram webhook payload:', JSON.stringify(payload, null, 2));
    
    // SendPulse Instagram webhook format - handle both array and object formats
    let contactId = '';
    let chatId = '';
    let senderName = 'Instagram User';
    let messageText = '';
    let messageId = '';
    
    // Check if payload is an array (as seen in real webhook calls)
    if (Array.isArray(payload) && payload.length > 0) {
      const firstItem = payload[0];
      
      // Extract message data from the nested structure
      contactId = firstItem.contact?.id || '';
      // Use the contact username as the chat ID for Instagram, fallback to contact ID
      chatId = firstItem.contact?.username || firstItem.contact?.id || '';
      senderName = firstItem.contact?.name || 'Instagram User';
      messageText = firstItem.info?.message?.channel_data?.message?.text || '';
      messageId = firstItem.info?.message?.channel_data?.message?.mid || firstItem.info?.message?.message_id || '';
      
      console.log('SendPulse parsed data:', {
        contactId,
        chatId, 
        senderName,
        messageText,
        originalContact: JSON.stringify(firstItem.contact)
      });
    } else {
      // Handle simple object format (for test messages)
      contactId = payload.contact?.id || payload.contact_id || '';
      chatId = payload.contact?.variables?.instagram_id || payload.instagram_id || contactId;
      senderName = payload.contact?.name || payload.contact?.variables?.first_name || 'Instagram User';
      messageText = payload.message?.text || payload.text || payload.message || '';
      messageId = payload.message?.id || payload.message_id || '';
    }
    
    if (!chatId || !messageText) {
      console.warn('SendPulse webhook missing required fields:', { chatId, messageText });
      return res.status(200).send('OK'); // Always return 200 for webhook
    }
    
    const platform = 'instagram';
    const channel = await getOrCreateChannel(platform, platform);
    
    // Find or create conversation for this Instagram user
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
        [senderName, picked ? picked.id : null, channel.id, chatId, contactId]
      );
      conversation = convRes.rows[0];
      
      if (picked?.socket_id) {
        io.to(picked.socket_id).emit('conversation:assigned', conversation);
      }
    } else {
      conversation = convRes.rows[0];
    }
    
    // Check for duplicates and save message
    if (!(await isRecentDuplicate(conversation.id, 'customer', messageText))) {
      const insertSQL = `
        INSERT INTO messages (username, content, conversation_id, sender)
        VALUES ($1, $2, $3, 'customer')
        RETURNING id, username, content, created_at, sender, conversation_id`;
      const saved = await pool.query(insertSQL, [senderName, messageText, conversation.id]).then(r => r.rows[0]);
      
      await pool.query(
        `UPDATE conversations SET last_activity_at = NOW(), last_sender = 'customer' WHERE id = $1`,
        [conversation.id]
      );
      
      const room = `conv:${conversation.id}`;
      io.to(room).emit('conversation:message', saved);
      io.emit('inbox:update', { conversationId: conversation.id, last_sender: 'customer' });
      
      // Internal notifications
      notifyInternalNewMessage({
        platform,
        chatId,
        name: senderName,
        text: messageText,
        conversationId: conversation.id,
        baseUrl: baseUrlFromReq(req)
      }).catch((e) => console.error('notify error', e));
    }
    
    return res.status(200).send('OK');
  } catch (e) {
    console.error('SendPulse Instagram webhook error', e);
    return res.status(200).send('ERROR'); // Always return 200 for webhooks
  }
});

// Instagram-specific webhook verification (Meta direct - keeping as backup)
app.get('/webhooks/instagram', (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token && token === META_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  } catch (e) {
    return res.sendStatus(500);
  }
});

// Instagram-specific webhook handler
app.post('/webhooks/instagram', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // Verify signature (optional strict mode)
    const signature =
      req.get('X-Hub-Signature-256') ||
      req.get('X-Hub-Signature') ||
      req.headers['x-hub-signature-256'] ||
      req.headers['x-hub-signature'] ||
      '';
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const sigOk = verifyMetaSignature(signature, raw);
    if (META_WEBHOOK_STRICT && !sigOk) {
      return res.sendStatus(401);
    }

    // Parse payload for logging/diagnostics
    let payload = null;
    try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch {}
    try { console.log('Instagram webhook event:', JSON.stringify(payload).slice(0, 1500)); } catch {}

    // Process Instagram messaging events (force platform to instagram)
    try {
      const entries = Array.isArray(payload?.entry) ? payload.entry : [];
      for (const entry of entries) {
        // Handle both "messaging" and "changes" array shapes
        const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
        const changes = Array.isArray(entry.changes) ? entry.changes : [];
        
        // Process messaging events
        for (const m of messaging) {
          try {
            const platform = 'instagram'; // Force Instagram platform
            if (m.message?.is_echo) continue; // ignore echoes
            const senderId = (m.sender?.id || m.from?.id || '').toString();
            let text = (m.message?.text || m.message?.caption || '').toString().trim();
            if (!text) text = '[non-text message]';
            if (!senderId) continue;

            const channel = await getOrCreateChannel(platform, platform);

            // Find or create conversation for this chat/user id
            let convRes = await pool.query(
              `SELECT * FROM conversations WHERE channel_id = $1 AND customer_external_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
              [channel.id, senderId]
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
                ['Instagram User', picked ? picked.id : null, channel.id, senderId]
              );
              conversation = convRes.rows[0];
              if (picked?.socket_id) io.to(picked.socket_id).emit('conversation:assigned', conversation);
            } else {
              conversation = convRes.rows[0];
            }

            if (!(await isRecentDuplicate(conversation.id, 'customer', text))) {
              const insertSQL = `
                INSERT INTO messages (username, content, conversation_id, sender)
                VALUES ($1, $2, $3, 'customer')
                RETURNING id, username, content, created_at, sender, conversation_id`;
              const saved = await pool.query(insertSQL, ['Instagram User', text, conversation.id]).then(r => r.rows[0]);

              await pool.query(
                `UPDATE conversations SET last_activity_at = NOW(), last_sender = 'customer' WHERE id = $1`,
                [conversation.id]
              );

              const room = `conv:${conversation.id}`;
              io.to(room).emit('conversation:message', saved);
              io.emit('inbox:update', { conversationId: conversation.id, last_sender: 'customer' });
              notifyInternalNewMessage({ platform, chatId: senderId, name: 'Instagram User', text, conversationId: conversation.id, baseUrl: baseUrlFromReq(req) })
                .catch((e) => console.error('notify error', e));
            }
          } catch (e) {
            console.error('Instagram webhook messaging event process error', e);
          }
        }
        
        // Process changes events (Instagram-specific)
        for (const ch of changes) {
          try {
            const v = ch.value || {};
            const senderId = (v.from?.id || v.sender_id || '').toString();
            let text = (v.message?.text || v.text || v.message?.caption || '').toString().trim();
            if (!text) text = '[non-text message]';
            if (!senderId) continue;

            const platform = 'instagram';
            const channel = await getOrCreateChannel(platform, platform);

            let convRes = await pool.query(
              `SELECT * FROM conversations WHERE channel_id = $1 AND customer_external_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
              [channel.id, senderId]
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
                ['Instagram User', picked ? picked.id : null, channel.id, senderId]
              );
              conversation = convRes.rows[0];
              if (picked?.socket_id) io.to(picked.socket_id).emit('conversation:assigned', conversation);
            } else {
              conversation = convRes.rows[0];
            }

            if (!(await isRecentDuplicate(conversation.id, 'customer', text))) {
              const insertSQL = `
                INSERT INTO messages (username, content, conversation_id, sender)
                VALUES ($1, $2, $3, 'customer')
                RETURNING id, username, content, created_at, sender, conversation_id`;
              const saved = await pool.query(insertSQL, ['Instagram User', text, conversation.id]).then(r => r.rows[0]);

              await pool.query(
                `UPDATE conversations SET last_activity_at = NOW(), last_sender = 'customer' WHERE id = $1`,
                [conversation.id]
              );

              const room = `conv:${conversation.id}`;
              io.to(room).emit('conversation:message', saved);
              io.emit('inbox:update', { conversationId: conversation.id, last_sender: 'customer' });
              notifyInternalNewMessage({ platform, chatId: senderId, name: 'Instagram User', text, conversationId: conversation.id, baseUrl: baseUrlFromReq(req) })
                .catch((e) => console.error('notify error', e));
            }
          } catch (e) {
            console.error('Instagram webhook changes event process error', e);
          }
        }
      }
    } catch (procErr) {
      console.error('Instagram webhook processing error', procErr);
    }

    // Respond per Meta requirements
    return res.status(200).send('EVENT_RECEIVED');
  } catch (e) {
    console.error('Instagram webhook error', e);
    return res.sendStatus(200);
  }
});

app.post('/webhooks/meta', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // Verify signature (optional strict mode)
    const signature =
      req.get('X-Hub-Signature-256') ||
      req.get('X-Hub-Signature') ||
      req.headers['x-hub-signature-256'] ||
      req.headers['x-hub-signature'] ||
      '';
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const sigOk = verifyMetaSignature(signature, raw);
    if (META_WEBHOOK_STRICT && !sigOk) {
      return res.sendStatus(401);
    }

    // Parse payload for logging/diagnostics
    let payload = null;
    try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch {}
    try { console.log('Meta webhook event:', JSON.stringify(payload).slice(0, 1500)); } catch {}

    // Process Instagram/Messenger messaging events
    try {
      const entries = Array.isArray(payload?.entry) ? payload.entry : [];
      for (const entry of entries) {
        // 1) Handle classic "messaging" array shape
        const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
        for (const m of messaging) {
          try {
            const product = (m.messaging_product || payload.object || '').toString().toLowerCase();
            const platform = (product === 'instagram' || payload.object === 'instagram') ? 'instagram' : 'facebook';
            if (m.message?.is_echo) continue; // ignore echoes
            const senderId = (m.sender?.id || m.from?.id || '').toString();
            let text = (m.message?.text || m.message?.caption || '').toString().trim();
            if (!text) text = '[non-text message]';
            if (!senderId) continue;

            const channel = await getOrCreateChannel(platform, platform);

            // Find or create conversation for this chat/user id
            let convRes = await pool.query(
              `SELECT * FROM conversations WHERE channel_id = $1 AND customer_external_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
              [channel.id, senderId]
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
                [platform === 'instagram' ? 'Instagram User' : 'Facebook User', picked ? picked.id : null, channel.id, senderId]
              );
              conversation = convRes.rows[0];
              if (picked?.socket_id) io.to(picked.socket_id).emit('conversation:assigned', conversation);
            } else {
              conversation = convRes.rows[0];
            }

            if (!(await isRecentDuplicate(conversation.id, 'customer', text))) {
              const insertSQL = `
                INSERT INTO messages (username, content, conversation_id, sender)
                VALUES ($1, $2, $3, 'customer')
                RETURNING id, username, content, created_at, sender, conversation_id`;
              const saved = await pool.query(insertSQL, [platform === 'instagram' ? 'Instagram User' : 'Facebook User', text, conversation.id]).then(r => r.rows[0]);

              await pool.query(
                `UPDATE conversations SET last_activity_at = NOW(), last_sender = 'customer' WHERE id = $1`,
                [conversation.id]
              );

              const room = `conv:${conversation.id}`;
              io.to(room).emit('conversation:message', saved);
              io.emit('inbox:update', { conversationId: conversation.id, last_sender: 'customer' });
              notifyInternalNewMessage({ platform, chatId: senderId, name: platform === 'instagram' ? 'Instagram User' : 'Facebook User', text, conversationId: conversation.id, baseUrl: baseUrlFromReq(req) })
                .catch((e) => console.error('notify error', e));
            }
          } catch (e) {
            console.error('Meta webhook messaging event process error', e);
          }
        }

        // 2) Handle "changes" shape sometimes seen with Instagram webhooks
        const changes = Array.isArray(entry.changes) ? entry.changes : [];
        for (const ch of changes) {
          try {
            const v = ch.value || {};
            const product = (v.messaging_product || '').toString().toLowerCase();
            if (product !== 'instagram') continue;
            const senderId = (v.from?.id || v.sender_id || '').toString();
            let text = (v.message?.text || v.text || v.message?.caption || '').toString().trim();
            if (!text) text = '[non-text message]';
            if (!senderId) continue;

            const platform = 'instagram';
            const channel = await getOrCreateChannel(platform, platform);

            let convRes = await pool.query(
              `SELECT * FROM conversations WHERE channel_id = $1 AND customer_external_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
              [channel.id, senderId]
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
                ['Instagram User', picked ? picked.id : null, channel.id, senderId]
              );
              conversation = convRes.rows[0];
              if (picked?.socket_id) io.to(picked.socket_id).emit('conversation:assigned', conversation);
            } else {
              conversation = convRes.rows[0];
            }

            if (!(await isRecentDuplicate(conversation.id, 'customer', text))) {
              const insertSQL = `
                INSERT INTO messages (username, content, conversation_id, sender)
                VALUES ($1, $2, $3, 'customer')
                RETURNING id, username, content, created_at, sender, conversation_id`;
              const saved = await pool.query(insertSQL, ['Instagram User', text, conversation.id]).then(r => r.rows[0]);

              await pool.query(
                `UPDATE conversations SET last_activity_at = NOW(), last_sender = 'customer' WHERE id = $1`,
                [conversation.id]
              );

              const room = `conv:${conversation.id}`;
              io.to(room).emit('conversation:message', saved);
              io.emit('inbox:update', { conversationId: conversation.id, last_sender: 'customer' });
              notifyInternalNewMessage({ platform, chatId: senderId, name: 'Instagram User', text, conversationId: conversation.id, baseUrl: baseUrlFromReq(req) })
                .catch((e) => console.error('notify error', e));
            }
          } catch (e) {
            console.error('Meta webhook changes event process error', e);
          }
        }
      }
    } catch (procErr) {
      console.error('Meta webhook processing error', procErr);
    }

    // Respond per Meta requirements
    return res.status(200).send('EVENT_RECEIVED');
  } catch (e) {
    console.error('Meta webhook error', e);
    return res.sendStatus(200);
  }
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

// Health check endpoint for Render (always 200 OK)
app.get('/healthz', (req, res) => res.status(200).send('ok'));

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

// Manual Instagram responses page
app.get('/manual-instagram', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manual_instagram.html'));
});

// Meta OAuth: start login
app.get('/auth/meta/login', (req, res) => {
  try {
    const APP_ID = process.env.META_APP_ID || META_APP_ID;
    const APP_SECRET = process.env.META_APP_SECRET || META_APP_SECRET;
    if (!APP_ID || !APP_SECRET) {
      return res.status(500).send('Missing META_APP_ID or META_APP_SECRET');
    }
    const redirectUri = `${baseUrlFromReq(req)}/auth/meta/callback`;
    const scopes = [
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_metadata',
      'pages_messaging',
      'instagram_basic',
      'instagram_manage_messages'
    ].join(',');
    const state = crypto.randomBytes(8).toString('hex');
    const authUrl = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth?client_id=${encodeURIComponent(APP_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(state)}`;
    return res.redirect(authUrl);
  } catch (e) {
    console.error('meta login error', e);
    return res.status(500).send('Failed to start Meta login');
  }
});

// Meta OAuth: callback to exchange code and fetch Page + IG info
app.get('/auth/meta/callback', async (req, res) => {
  try {
    const APP_ID = process.env.META_APP_ID || META_APP_ID;
    const APP_SECRET = process.env.META_APP_SECRET || META_APP_SECRET;
    if (!APP_ID || !APP_SECRET) return res.status(500).send('Missing META_APP_ID or META_APP_SECRET');

    const code = (req.query.code || '').toString();
    if (!code) return res.status(400).send('Missing code');

    const redirectUri = `${baseUrlFromReq(req)}/auth/meta/callback`;

    // 1) Exchange code -> short-lived user token
    const tokUrl = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`);
    tokUrl.search = new URLSearchParams({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      redirect_uri: redirectUri,
      code
    }).toString();
    const tokResp = await fetch(tokUrl, { method: 'GET' });
    const tokJson = await tokResp.json();
    if (!tokResp.ok || !tokJson.access_token) {
      return res.status(500).send('Token exchange failed: ' + JSON.stringify(tokJson));
    }
    const shortUserToken = tokJson.access_token;

    // 2) Optionally exchange to long-lived user token
    let userToken = shortUserToken;
    try {
      const llUrl = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`);
      llUrl.search = new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: APP_ID,
        client_secret: APP_SECRET,
        fb_exchange_token: shortUserToken
      }).toString();
      const llResp = await fetch(llUrl);
      const llJson = await llResp.json().catch(() => ({}));
      if (llResp.ok && llJson.access_token) userToken = llJson.access_token;
    } catch {}

    // 3) Find a Page that has an Instagram Professional account and its Page token
    // Some setups expose connected_instagram_account instead of instagram_business_account.
    const pagesUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/me/accounts?fields=name,access_token,instagram_business_account{id,username},connected_instagram_account{id,username},tasks&access_token=${encodeURIComponent(userToken)}`;
    const pagesResp = await fetch(pagesUrl);
    const pages = await pagesResp.json();
    if (!pagesResp.ok) {
      return res.status(500).send('List pages failed: ' + JSON.stringify(pages));
    }
    const page = Array.isArray(pages.data)
      ? pages.data.find(p => (p.instagram_business_account || p.connected_instagram_account) && p.access_token)
      : null;

    if (!page) {
      const list = Array.isArray(pages.data) ? pages.data.map(p => ({
        name: p.name,
        has_ig_business: !!p.instagram_business_account,
        has_connected_ig: !!p.connected_instagram_account,
        tasks: p.tasks || []
      })) : [];
      return res.status(200).type('html').send(`<!doctype html><html><body>
<h2>Login successful</h2>
<p>No Facebook Page with a linked Instagram Professional account was found for this user.</p>
<ol>
<li>On Instagram, switch to Professional and link your Facebook Page in Accounts Center.</li>
<li>In the Facebook login dialog, click <b>Edit settings</b> and select the Page you want to connect.</li>
</ol>
<p>Debug summary of your Pages (sanitized):</p>
<pre>${(() => { try { return JSON.stringify(list, null, 2); } catch (_) { return ''; } })()}</pre>
</body></html>`);
    }

    const ig = page.instagram_business_account || page.connected_instagram_account || {};
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Instagram login complete</title>
<style>body{font-family:system-ui,Segoe UI,Arial;margin:2rem;max-width:900px}code{background:#f2f2f2;padding:.2rem .35rem;border-radius:4px;word-break:break-all}pre{white-space:pre-wrap;word-break:break-all;background:#f8f8f8;padding:12px;border-radius:6px}</style>
</head><body>
<h2>Instagram business login successful</h2>
<p>Page: <b>${page.name || ''}</b></p>
<p>Instagram account ID: <code>${ig.id || ''}</code> ${ig.username ? `(username: ${ig.username})` : ''}</p>
<p>Copy this Page access token and set it as <code>IG_PAGE_ACCESS_TOKEN</code> in your Render environment, then redeploy:</p>
<pre>${page.access_token}</pre>
<p>After deploying you can use webhooks to ingest DMs and enable reply sending from your dashboard.</p>
</body></html>`;

    return res.status(200).type('html').send(html);
  } catch (e) {
    console.error('Meta OAuth callback error', e);
    return res.status(500).send('OAuth error: ' + e.message);
  }
});

// Public invite acceptance page
app.get('/invite', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'invite.html'));
});

// Meta: deauthorize callback (called when a user removes the app)
// Meta sends a POST form with signed_request which we verify with app secret.
app.post('/auth/meta/deauthorize', express.urlencoded({ extended: false }), (req, res) => {
  try {
    const sr = (req.body?.signed_request || '').toString();
    if (!sr || !META_APP_SECRET) return res.sendStatus(200);
    const [sigB64, payloadB64] = sr.split('.', 2);
    if (!sigB64 || !payloadB64) return res.sendStatus(200);
    const base64urlToBuf = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const expected = crypto.createHmac('sha256', META_APP_SECRET).update(payloadB64).digest();
    const provided = base64urlToBuf(sigB64);
    if (expected.length === provided.length && crypto.timingSafeEqual(expected, provided)) {
      let payload = {}; try { payload = JSON.parse(base64urlToBuf(payloadB64).toString('utf8')); } catch {}
      console.log('Meta deauthorize payload', payload);
    }
  } catch (e) {
    console.warn('Meta deauthorize error', e.message);
  }
  return res.sendStatus(200);
});

// Meta: data deletion request endpoint
// Respond with a confirmation_code and a status URL as per Meta policy
app.post('/auth/meta/data-deletion', express.urlencoded({ extended: false }), (req, res) => {
  try {
    const code = crypto.randomBytes(8).toString('hex');
    const base = process.env.PUBLIC_BASE_URL || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;
    const url = `${base}/auth/meta/data-deletion-status?code=${encodeURIComponent(code)}`;
    return res.json({ url, confirmation_code: code });
  } catch (e) {
    return res.json({ status: 'received' });
  }
});

// Simple data deletion status endpoint
app.get('/auth/meta/data-deletion-status', (req, res) => {
  const code = (req.query.code || '').toString();
  return res.json({ code, status: 'pending' });
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

// Manual response API endpoint
app.post('/api/send-manual-response', express.json(), async (req, res) => {
  try {
    const { conversationId, message, sender = 'agent', username = 'Manual Agent' } = req.body;
    
    if (!conversationId || !message) {
      return res.status(400).json({ success: false, error: 'Missing conversationId or message' });
    }
    
    const convId = parseInt(conversationId, 10);
    if (isNaN(convId)) {
      return res.status(400).json({ success: false, error: 'Invalid conversationId' });
    }
    
    const content = String(message).slice(0, 2000).trim();
    if (!content) {
      return res.status(400).json({ success: false, error: 'Empty message content' });
    }
    
    // Insert the message into database
    const insertSQL = `
      INSERT INTO messages (username, content, conversation_id, sender)
      VALUES ($1, $2, $3, $4)
      RETURNING id, username, content, created_at, sender, conversation_id`;
    
    const { rows } = await pool.query(insertSQL, [username, content, convId, sender]);
    const saved = rows[0];
    
    // Update conversation activity
    await pool.query(
      `UPDATE conversations
       SET last_activity_at = NOW(), last_sender = $2
       WHERE id = $1`,
      [convId, sender]
    );
    
    // Emit to socket rooms (if any agents are connected)
    const room = `conv:${convId}`;
    io.to(room).emit('conversation:message', saved);
    io.emit('inbox:update', { conversationId: convId, last_sender: sender });
    
    // Try to send outbound to Instagram (only for agent messages)
    if (sender === 'agent') {
      try {
        const q = await pool.query(
          `SELECT conv.customer_external_id, conv.customer_contact_id, ch.name AS channel_name
           FROM conversations conv LEFT JOIN channels ch ON ch.id = conv.channel_id
           WHERE conv.id = $1`,
          [convId]
        );
        
        if (q.rowCount) {
          const { customer_external_id: extId, customer_contact_id: contactId, channel_name } = q.rows[0];
          
          let sent = false;
          let sendMethod = 'none';
          
          if (channel_name === 'instagram' && contactId) {
            console.log('📱 Manual response: Sending to Instagram via SendPulse');
            console.log('   - Contact ID:', contactId);
            console.log('   - Message:', content.substring(0, 50) + '...');
            
            const spOk = await sendPulseMessage(contactId, content);
            if (spOk) {
              sent = true;
              sendMethod = 'sendpulse';
              console.log('   ✅ SendPulse Instagram message sent');
            } else {
              console.warn('   ❌ SendPulse failed, trying Meta API fallback');
              
              // Try Meta API fallback if available
              const metaOk = await metaSendMessage('instagram', extId, content);
              if (metaOk) {
                sent = true;
                sendMethod = 'meta';
                console.log('   ✅ Meta API Instagram message sent');
              }
            }
          }
          
          return res.json({ 
            success: true, 
            messageId: saved.id,
            outbound: {
              sent,
              method: sendMethod,
              channel: channel_name,
              contactId,
              externalId: extId
            }
          });
        }
      } catch (outboundError) {
        console.error('Manual response outbound error:', outboundError);
        // Don't fail the whole request if outbound fails
        return res.json({ 
          success: true, 
          messageId: saved.id,
          warning: 'Message saved but outbound delivery failed: ' + outboundError.message
        });
      }
    }
    
    res.json({ success: true, messageId: saved.id });
  } catch (err) {
    console.error('Manual response error:', err);
    res.status(500).json({ success: false, error: 'Failed to send response: ' + err.message });
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
                console.log('🔧 Instagram/Facebook outbound message triggered');
                console.log('   - Channel:', channel_name);
                console.log('   - External ID:', extId);
                console.log('   - Stored Contact ID:', storedContactId);
                console.log('   - Content:', content.substring(0, 50) + '...');
                
                // Prefer routing via custom chatbot relay if configured
                let sent = false;
                const cbRes = await sendViaChatbot({ platform: channel_name, chatId: storedContactId || extId, contactId: storedContactId || null, text: content, conversationId });
                if (cbRes) {
                  sent = !!cbRes.ok;
                  console.log('   - Chatbot relay result:', cbRes.ok ? 'SUCCESS' : 'FAILED', cbRes);
                  if (!cbRes.ok) console.warn('Chatbot outbound failed', cbRes);
                } else {
                  console.log('   - Chatbot relay: Not configured or returned null');
                }
                
                if (!sent && CHATBOT_OUTBOUND_STRICT) {
                  console.log('   - CHATBOT_OUTBOUND_STRICT mode: Skipping fallbacks');
                  // In strict mode, do not fall back to Meta
                  sent = true; // treat as handled to avoid fallback
                }
                
                if (!sent && channel_name === 'instagram' && storedContactId) {
                  console.log('   - Trying SendPulse Instagram API with contact_id:', storedContactId);
                  // Try SendPulse Instagram messaging if we have a contact_id
                  const spOk = await sendPulseMessage(storedContactId, content);
                  if (spOk) {
                    sent = true;
                    console.log('   ✅ SendPulse Instagram message sent successfully');
                  } else {
                    console.warn('   ❌ SendPulse Instagram send failed for contact_id', storedContactId);
                  }
                } else if (!sent && channel_name === 'instagram') {
                  console.log('   - Skipping SendPulse: No stored contact_id available');
                }
                
                if (!sent) {
                  console.log('   - Trying Meta Graph API fallback with extId:', extId);
                  // Use Meta Graph API for Facebook and Instagram messaging
                  const ok = await metaSendMessage(channel_name, extId, content);
                  if (ok) {
                    sent = true;
                    console.log('   ✅ Meta Graph API message sent successfully');
                  } else {
                    console.warn(`   ❌ Meta ${channel_name} send failed for chat_id`, extId);
                  }
                }
                
                console.log('   - Final result:', sent ? 'MESSAGE SENT' : 'ALL METHODS FAILED');
              } catch (e) {
                console.error('Meta/Chatbot/SendPulse send error', e);
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
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
})();
