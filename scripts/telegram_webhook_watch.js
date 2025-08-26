#!/usr/bin/env node
// Watcher: poll ngrok API periodically; when https URL changes, re-set Telegram webhook
const https = require('https');
const http = require('http');
require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN in env');
  process.exit(1);
}

function getNgrokUrl() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const httpsTunnel = (json.tunnels || []).find(t => (t.public_url || '').startsWith('https://'));
          resolve(httpsTunnel ? httpsTunnel.public_url : '');
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function setWebhook(publicUrl) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(publicUrl + '/webhooks/telegram')}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

let lastUrl = '';
async function tick() {
  try {
    const url = await getNgrokUrl();
    if (url && url !== lastUrl) {
      const resp = await setWebhook(url);
      console.log(new Date().toISOString(), 'Webhook set:', { ok: resp.ok, url: url + '/webhooks/telegram' });
      lastUrl = url;
    }
  } catch (e) {
    console.error(new Date().toISOString(), 'watch error:', e.message);
  }
}

console.log('Watching ngrok for Telegram webhook updates...');
setInterval(tick, 5000);
// Run immediately as well
void tick();

