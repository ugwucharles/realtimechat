/*
  Mock Chatbot receiver for outbound relay
  - Listens on /outbound (port from CHATBOT_MOCK_PORT or 4567)
  - Validates X-Chatbot-Key if CHATBOT_OUTBOUND_KEY is set
  - Appends JSON lines to logs/mock_chatbot.log without logging the key value
*/

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = Number(process.env.CHATBOT_MOCK_PORT || 4567);
const EXPECTED_KEY = process.env.CHATBOT_OUTBOUND_KEY || '';
const logDir = path.join(__dirname, '..', 'logs');
const logFile = path.join(logDir, 'mock_chatbot.log');

function ensureLogDir(){ try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
}

app.post('/outbound', (req, res) => {
  const hdrKey = req.get('X-Chatbot-Key') || req.get('x-chatbot-key') || '';
  const authOk = EXPECTED_KEY ? (hdrKey === EXPECTED_KEY) : true;
  const body = req.body || {};
  ensureLogDir();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    authOk,
    platform: body.platform || null,
    chat_id: body.chat_id || null,
    contact_id: body.contact_id || null,
    text: body.text || null,
    conversation_id: body.conversation_id || null
  });
  fs.appendFile(logFile, line + '\n', () => {});
  console.log('mock chatbot received', { authOk, platform: body.platform, chat_id: body.chat_id, text: body.text });
  if (!authOk) return res.status(403).json({ ok: false, error: 'key mismatch' });
  return res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Mock chatbot listening on http://127.0.0.1:${PORT}/outbound`);
});

