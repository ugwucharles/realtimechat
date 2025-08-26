#!/usr/bin/env node
// Create a Microsoft Graph subscription for Outlook Inbox messages
// Requires env: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_MAILBOX, PUBLIC_URL
const https = require('https');
require('dotenv').config();

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

function postJson(url, data, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const u = new URL(url);
    const req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname + u.search, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
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
    const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_MAILBOX, PUBLIC_URL, MS_CLIENT_STATE } = process.env;
    if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET || !MS_MAILBOX || !PUBLIC_URL) {
      console.error('Missing env: MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET/MS_MAILBOX/PUBLIC_URL');
      process.exit(1);
    }

    const tokenResp = await postForm(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
      client_id: MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default'
    });
    const tokenJson = JSON.parse(tokenResp.body);
    if (!tokenJson.access_token) throw new Error('Token error: ' + tokenResp.body);

    const expires = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2 hours
    const payload = {
      changeType: 'created',
      notificationUrl: `${PUBLIC_URL}/webhooks/outlook`,
      resource: `/users/${MS_MAILBOX}/mailFolders('Inbox')/messages`,
      expirationDateTime: expires,
      clientState: MS_CLIENT_STATE || undefined
    };

    const subResp = await postJson('https://graph.microsoft.com/v1.0/subscriptions', payload, tokenJson.access_token);
    console.log('Create subscription response:', subResp.status, subResp.body);
  } catch (e) {
    console.error('Subscription create error:', e.message);
    process.exit(1);
  }
})();

