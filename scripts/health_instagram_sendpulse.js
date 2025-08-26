/*
  Health check: Instagram via SendPulse
  - Loads .env and .env.local (if present)
  - Verifies required env vars exist
  - Attempts client_credentials OAuth against SendPulse API base(s)
  - Prints a concise JSON report (no secrets)
*/

const path = require('path');
// Load env from project root first (.env and .env.local), then allow process-level to override if needed
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true }); } catch {}
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true }); } catch {}
try { require('dotenv').config({ override: true }); } catch {}

function sanitizeBase(b) {
  return String(b || '').trim().replace(/\/+$/, '');
}

async function getTokenFrom(base, clientId, clientSecret) {
  const url = `${base}/oauth/access_token`;
  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  body.set('client_id', clientId);
  body.set('client_secret', clientSecret);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const text = await r.text().catch(() => '');
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: r.ok && !!(json && json.access_token), status: r.status, json: json ? Object.keys(json) : null, base };
}

(async function main(){
  const startedAt = new Date().toISOString();
  const clientId = process.env.SENDPULSE_CLIENT_ID || '';
  const clientSecret = process.env.SENDPULSE_CLIENT_SECRET || '';
  const botIdIG = process.env.SENDPULSE_BOT_ID_INSTAGRAM || '';
  const envBase = sanitizeBase(process.env.SENDPULSE_API_BASE || 'https://api.sendpulse.com');

  const configured = !!(clientId && clientSecret);
  const bases = Array.from(new Set([envBase, 'https://api.eu.sendpulse.com', 'https://api.sendpulse.com'].map(sanitizeBase).filter(Boolean)));

  const result = {
    target: 'instagram-sendpulse',
    startedAt,
    node: process.version,
    configured,
    hasInstagramBotId: !!botIdIG,
    baseCandidates: bases,
    steps: []
  };

  if (!configured) {
    result.ok = false;
    result.error = 'Missing SENDPULSE_CLIENT_ID or SENDPULSE_CLIENT_SECRET';
    console.log(JSON.stringify(result));
    return process.exit(0);
  }

  let tokenOk = false;
  for (const base of bases) {
    try {
      const r = await getTokenFrom(base, clientId, clientSecret);
      result.steps.push({ step: 'oauth', base: r.base, status: r.status, ok: r.ok });
      if (r.ok) { tokenOk = true; result.baseUsed = base; break; }
    } catch (e) {
      result.steps.push({ step: 'oauth', base, ok: false, error: e.message });
    }
  }

  result.ok = tokenOk;
  result.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(result));
  process.exit(0);
})();

