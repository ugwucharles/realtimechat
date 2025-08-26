#!/usr/bin/env node
// Debug Microsoft Graph personal token and inbox
const https = require('https');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

(async () => {
  try {
    const tokenPath = process.env.MSA_TOKEN_FILE || path.join(__dirname, '..', 'tokens', 'outlook_msa.json');
    if (!fs.existsSync(tokenPath)) {
      console.log('NO_TOKEN_FILE', tokenPath);
      process.exit(1);
    }
    const tok = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    const access = tok.access_token;
    if (!access) throw new Error('No access_token in token file');

    function get(pathname) {
      return new Promise((resolve, reject) => {
        const u = new URL(`https://graph.microsoft.com/v1.0${pathname}`);
        const req = https.request({ method: 'GET', hostname: u.hostname, path: u.pathname + u.search, headers: { Authorization: `Bearer ${access}` } }, (res) => {
          let buf = '';
          res.on('data', (d) => (buf += d));
          res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        });
        req.on('error', reject);
        req.end();
      });
    }

    const me = await get('/me');
    console.log('ME_STATUS', me.status);
    console.log('ME_BODY', me.body.substring(0, 200) + '...');

    const inbox = await get("/me/mailFolders('Inbox')/messages?$filter=isRead%20eq%20false&$select=id,from,subject,bodyPreview,isRead&$top=5");
    console.log('INBOX_STATUS', inbox.status);
    console.log('INBOX_BODY', inbox.body.substring(0, 300) + '...');

    const latest = await get("/me/messages?$orderby=receivedDateTime%20desc&$select=id,from,subject,isRead,receivedDateTime&$top=5");
    console.log('LATEST_STATUS', latest.status);
    console.log('LATEST_BODY', latest.body.substring(0, 500) + '...');
  } catch (e) {
    console.error('DEBUG_ERROR', e.message);
    process.exit(1);
  }
})();

