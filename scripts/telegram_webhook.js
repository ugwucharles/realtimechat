#!/usr/bin/env node
// One-off: set Telegram webhook to the current ngrok https URL
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
          if (!httpsTunnel) return reject(new Error('No https ngrok tunnel found'));
          resolve(httpsTunnel.public_url);
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

(async () => {
  try {
    const publicUrl = await getNgrokUrl();
    const resp = await setWebhook(publicUrl);
    console.log('Webhook set response:', { ok: resp.ok, url: publicUrl + '/webhooks/telegram' });
  } catch (err) {
    console.error('Failed to set webhook:', err.message);
    process.exit(1);
  }
})();

