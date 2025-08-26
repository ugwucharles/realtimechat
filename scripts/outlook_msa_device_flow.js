#!/usr/bin/env node
// Outlook MSA Device Code flow to obtain delegated tokens and store them in a file
// Env required: MS_CLIENT_ID, MSA_TOKEN_FILE
const https = require('https');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const CLIENT_ID = process.env.MS_CLIENT_ID;
const TOKEN_FILE = process.env.MSA_TOKEN_FILE || path.join(__dirname, '..', 'tokens', 'outlook_msa.json');

if (!CLIENT_ID) {
  console.error('Missing MS_CLIENT_ID in env');
  process.exit(1);
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

(async () => {
  try {
    // 1) Request a device code
    const scope = 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access';
    const dc = await postForm('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', { client_id: CLIENT_ID, scope });
    const dcj = JSON.parse(dc.body);
    if (!dcj.device_code) throw new Error('Device code error: ' + dc.body);
    console.log('To authorize, visit:', dcj.verification_uri);
    console.log('Enter code:', dcj.user_code);

    // 2) Poll for token
    const interval = (dcj.interval || 5) * 1000;
    while (true) {
      await new Promise(r => setTimeout(r, interval));
      const tr = await postForm('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: CLIENT_ID,
        device_code: dcj.device_code
      });
      const tj = JSON.parse(tr.body);
      if (tj.access_token) {
        const now = Math.floor(Date.now() / 1000);
        const out = { access_token: tj.access_token, refresh_token: tj.refresh_token, expires_at: now + (tj.expires_in || 3600) };
        await fs.promises.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
        await fs.promises.writeFile(TOKEN_FILE, JSON.stringify(out, null, 2));
        console.log('Saved tokens to', TOKEN_FILE);
        break;
      }
      if (tj.error && tj.error !== 'authorization_pending') {
        throw new Error('Token error: ' + tr.body);
      }
      console.log('Waiting for authorization...');
    }
  } catch (e) {
    console.error('MSA device flow error:', e.message);
    process.exit(1);
  }
})();

