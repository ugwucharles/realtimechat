#!/usr/bin/env node
// Poll personal Outlook (MSA) inbox for new unread emails and ingest them into the chat app
// Env required: MS_CLIENT_ID, MSA_TOKEN_FILE, INTEGRATION_INGEST_KEY
// Optionally: POLL_INTERVAL_MS (default 10000)
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const CLIENT_ID = process.env.MS_CLIENT_ID;
const TOKEN_FILE = process.env.MSA_TOKEN_FILE || path.join(__dirname, '..', 'tokens', 'outlook_msa.json');
const INGEST_KEY = process.env.INTEGRATION_INGEST_KEY;
const INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);
const STATE_FILE = process.env.MSA_STATE_FILE || path.join(__dirname, '..', 'tokens', 'outlook_msa_state.json');
const BASE = process.env.POLL_BASE_URL || 'http://localhost:3000';

if (!CLIENT_ID) {
  console.error('Missing MS_CLIENT_ID in env');
  process.exit(1);
}
if (!INGEST_KEY) {
  console.error('Missing INTEGRATION_INGEST_KEY in env');
  process.exit(1);
}

async function readToken() {
  const raw = await fs.promises.readFile(TOKEN_FILE, 'utf8').catch(() => null);
  if (!raw) throw new Error(`Token file not found: ${TOKEN_FILE}. Run: npm run outlook:msa:device`);
  return JSON.parse(raw);
}

async function readState() {
  try {
    const raw = await fs.promises.readFile(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeState(obj) {
  await fs.promises.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.promises.writeFile(STATE_FILE, JSON.stringify(obj, null, 2));
}

function rememberId(state, id) {
  state.processedIds = Array.isArray(state.processedIds) ? state.processedIds : [];
  if (!state.processedIds.includes(id)) state.processedIds.unshift(id);
  // cap to last 500 ids
  if (state.processedIds.length > 500) state.processedIds.length = 500;
}

function wasProcessed(state, id) {
  return Array.isArray(state.processedIds) && state.processedIds.includes(id);
}

function postForm(url, data) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const u = new URL(url);
    const req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname + u.search, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const tok = await readToken();
  if (tok.expires_at && tok.expires_at - 60 > now) return tok.access_token;
  const tr = await postForm('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: tok.refresh_token,
    scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access'
  });
  const tj = JSON.parse(tr.body);
  if (!tj.access_token) throw new Error('MSA refresh failed: ' + tr.body);
  const updated = { access_token: tj.access_token, refresh_token: tj.refresh_token || tok.refresh_token, expires_at: now + (tj.expires_in || 3600) };
  await fs.promises.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fs.promises.writeFile(TOKEN_FILE, JSON.stringify(updated, null, 2));
  return updated.access_token;
}

function graphGet(pathname, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(`https://graph.microsoft.com/v1.0${pathname}`);
    const req = https.request({ method: 'GET', hostname: u.hostname, path: u.pathname + u.search, headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.end();
  });
}

function graphPatch(pathname, token, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const u = new URL(`https://graph.microsoft.com/v1.0${pathname}`);
    const req = https.request({ method: 'PATCH', hostname: u.hostname, path: u.pathname + u.search, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function ingest(fromEmail, text) {
  return new Promise((resolve, reject) => {
    try {
      const body = JSON.stringify({ fromEmail, text });
      const u = new URL(BASE);
      const mod = u.protocol === 'https:' ? https : http;
      const options = {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: '/ingest/outlook',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-ingest-key': INGEST_KEY
        }
      };
      const req = mod.request(options, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}

async function tick() {
  try {
    const token = await getAccessToken();
    const state = await readState();

    // Always ingest the latest recent messages (dedup by message id), across all folders
    const latestRes = await graphGet(`/me/messages?$orderby=receivedDateTime%20desc&$select=id,from,subject,bodyPreview,isRead,receivedDateTime&$top=20`, token);
    const latestJson = JSON.parse(latestRes.body || '{}');
    const latestItems = latestJson.value || [];
    console.log(new Date().toISOString(), 'recent count', latestItems.length);
    for (const m of latestItems) {
      if (wasProcessed(state, m.id)) continue;
      const from = m.from?.emailAddress?.address;
      const subj = (m.subject || '').slice(0, 80);
      const text = (m.bodyPreview || '').trim();
      console.log('recent:', from, '-', subj, '| isRead:', m.isRead);
      if (from && text) {
        await ingest(from, text);
      }
      // mark read to avoid re-ingest in other clients
      await graphPatch(`/me/messages/${encodeURIComponent(m.id)}`, token, { isRead: true });
      rememberId(state, m.id);
    }

    await writeState(state);

    // Additionally, fetch unread across all folders (in case new ones arrive between ticks)
    const res = await graphGet(`/me/messages?$filter=isRead%20eq%20false&$select=id,from,subject,bodyPreview&$top=20`, token);
    const json = JSON.parse(res.body || '{}');
    const items = json.value || [];
    console.log(new Date().toISOString(), 'unread count', items.length);
    for (const m of items) {
      if (wasProcessed(state, m.id)) continue;
      const from = m.from?.emailAddress?.address;
      const text = (m.bodyPreview || '').trim();
      console.log('unread:', from, '-', (m.subject || '').slice(0,80));
      if (from && text) {
        await ingest(from, text);
      }
      await graphPatch(`/me/messages/${encodeURIComponent(m.id)}`, token, { isRead: true });
      rememberId(state, m.id);
    }

    await writeState(state);
  } catch (e) {
    console.error(new Date().toISOString(), 'poll error', e.message);
  }
}

console.log('Outlook MSA poller started. Interval', INTERVAL, 'ms');
setInterval(tick, INTERVAL);
void tick();

