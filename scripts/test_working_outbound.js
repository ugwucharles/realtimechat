/*
  Test Working SendPulse Outbound Messaging
  This script tests the confirmed working Instagram API approach
  
  Usage:
    node scripts/test_working_outbound.js
*/

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true }); } catch {}
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true }); } catch {}

async function getToken() {
  const clientId = process.env.SENDPULSE_API_USER_ID;
  const clientSecret = process.env.SENDPULSE_API_SECRET;
  
  const form = new URLSearchParams();
  form.set('grant_type', 'client_credentials');
  form.set('client_id', clientId);
  form.set('client_secret', clientSecret);
  
  const r = await fetch('https://api.sendpulse.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  
  const j = await r.json();
  return j.access_token;
}

async function sendMessage(token, contactId, text) {
  const payload = {
    chat_id: contactId,
    contact_id: contactId,
    text: text
  };
  
  console.log(`\n📤 Sending message:`);
  console.log(`   Contact ID: ${contactId}`);
  console.log(`   Text: ${text}`);
  console.log(`   Payload: ${JSON.stringify(payload, null, 2)}`);
  
  try {
    const r = await fetch('https://api.sendpulse.com/instagram/chats/messages', {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${token}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify(payload)
    });
    
    const responseText = await r.text();
    let json = null; try { json = JSON.parse(responseText); } catch {}
    
    console.log(`   Status: ${r.status}`);
    console.log(`   Response: ${responseText.substring(0, 200)}...`);
    
    if (r.ok && json && json.success !== false) {
      console.log('   ✅ SUCCESS: Message sent!');
      return true;
    } else {
      console.log('   ❌ FAILED: Message not sent');
      return false;
    }
  } catch (e) {
    console.log(`   ❌ ERROR: ${e.message}`);
    return false;
  }
}

(async function main() {
  console.log('🚀 Test Working SendPulse Outbound Messaging');
  console.log('============================================');
  
  try {
    const token = await getToken();
    console.log('✅ Got authentication token');
    
    // Test with the known working contact ID
    const contactId = '68ab4050ac7632ce7d0d0250';
    const testMessage = 'Test message from working outbound script - ' + new Date().toISOString();
    
    const success = await sendMessage(token, contactId, testMessage);
    
    if (success) {
      console.log('\n🎉 SUCCESS! Your outbound messaging is working!');
      console.log('\n🔧 TO FIX YOUR SERVER:');
      console.log('   1. Use ONLY the Instagram API endpoint: /instagram/chats/messages');
      console.log('   2. Use the contact_id from your database');
      console.log('   3. Remove any fallback to Chatbots API');
      console.log('   4. Ensure you\'re using the correct bot ID: 68ab38663bef0841770e2282');
      
      console.log('\n📝 CORRECT PAYLOAD FORMAT:');
      console.log('   {');
      console.log('     "chat_id": "YOUR_CONTACT_ID",');
      console.log('     "contact_id": "YOUR_CONTACT_ID",');
      console.log('     "text": "Your message text"');
      console.log('   }');
    } else {
      console.log('\n❌ Still having issues');
      console.log('   Check your SendPulse configuration');
    }
    
  } catch (e) {
    console.log(`❌ ERROR: ${e.message}`);
  }
})();
