/*
  Health check for chatbot outbound relay
  - Reads CH_OUT_URL, CH_OUT_KEY from env (do not print the key)
  - Sends a test payload to the outbound URL
  - Prints a JSON result
*/

const url = process.env.CH_OUT_URL || '';
const key = process.env.CH_OUT_KEY || '';

if (!url) {
  console.log(JSON.stringify({ ok: false, error: 'Missing CH_OUT_URL' }));
  process.exit(0);
}

(async function run(){
  const payload = {
    platform: 'instagram',
    chat_id: 'TEST_CHAT_123',
    text: 'hello from health-check',
    conversation_id: 9999
  };
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['X-Chatbot-Key'] = key;
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await r.text().catch(() => '');
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    console.log(JSON.stringify({ ok: r.ok, status: r.status, data: json ?? text }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
  }
})();

