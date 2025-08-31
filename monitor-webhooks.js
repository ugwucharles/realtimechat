// Real-time webhook monitoring for debugging
const express = require('express');
const app = express();

console.log('🔍 Starting webhook monitor...');
console.log('This will show you EXACTLY what SendPulse is sending (or not sending)');
console.log('');

// Middleware to log ALL incoming requests
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.url;
  const headers = JSON.stringify(req.headers, null, 2);
  
  console.log(`\n📥 [${timestamp}] ${method} ${url}`);
  console.log(`Headers:`, headers);
  
  // Capture body
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  
  req.on('end', () => {
    if (body) {
      console.log(`Body:`, body);
      try {
        const parsed = JSON.parse(body);
        console.log(`Parsed JSON:`, JSON.stringify(parsed, null, 2));
      } catch (e) {
        console.log(`Body is not JSON:`, body);
      }
    }
    console.log('─'.repeat(80));
  });
  
  next();
});

// Parse JSON
app.use(express.json());

// SendPulse Instagram webhook endpoint with detailed logging
app.post('/webhooks/sendpulse/instagram', (req, res) => {
  console.log('🎯 SendPulse Instagram webhook called!');
  console.log('Payload received:', JSON.stringify(req.body, null, 2));
  
  const payload = req.body || {};
  const contactId = payload.contact?.id || payload.contact_id || '';
  const chatId = payload.contact?.variables?.instagram_id || payload.instagram_id || contactId;
  const senderName = payload.contact?.name || payload.contact?.variables?.first_name || 'Instagram User';
  const messageText = payload.message?.text || payload.text || payload.message || '';
  
  console.log('Extracted data:');
  console.log(`  Contact ID: ${contactId}`);
  console.log(`  Chat ID: ${chatId}`);
  console.log(`  Sender Name: ${senderName}`);
  console.log(`  Message Text: ${messageText}`);
  
  if (chatId && messageText) {
    console.log('✅ Valid SendPulse webhook - would create conversation');
  } else {
    console.log('❌ Invalid SendPulse webhook - missing required fields');
  }
  
  res.send('OK');
});

// Catch all other webhooks
app.all('*', (req, res) => {
  console.log(`📨 Other request: ${req.method} ${req.url}`);
  res.send('OK');
});

const PORT = 3001; // Different port so it doesn't conflict
app.listen(PORT, () => {
  console.log(`🔍 Webhook monitor running on http://localhost:${PORT}`);
  console.log('');
  console.log('TO TEST:');
  console.log('1. Update SendPulse webhook URL temporarily to:');
  console.log(`   http://your-ngrok-url/webhooks/sendpulse/instagram`);
  console.log('2. Send an Instagram DM to your bot');  
  console.log('3. Watch this console for incoming webhook calls');
  console.log('4. Switch back to port 3000 when done testing');
  console.log('');
  console.log('Press Ctrl+C to stop monitoring');
});
