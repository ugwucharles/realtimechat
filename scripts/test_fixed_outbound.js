/*
  Test Fixed SendPulse Outbound Messaging
  This script tests the correct approach using Chatbots API instead of Instagram API
  
  Usage:
    node scripts/test_fixed_outbound.js
*/

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true }); } catch {}
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true }); } catch {}

async function getToken() {
  const clientId = process.env.SENDPULSE_CLIENT_ID;
  const clientSecret = process.env.SENDPULSE_CLIENT_SECRET;
  
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

async function getInstagramChats(token) {
  const r = await fetch('https://api.sendpulse.com/instagram/chats?limit=5', {
    headers: { Authorization: `Bearer ${token}` }
  });
  
  const j = await r.json();
  return j.data || [];
}

async function testOutboundViaChatbots(token, botId, contactId, text) {
  console.log(`\n🧪 Testing outbound via Chatbots API:`);
  console.log(`   Bot ID: ${botId}`);
  console.log(`   Contact ID: ${contactId}`);
  console.log(`   Text: ${text}`);
  
  const payload = {
    bot_id: botId,
    chat_id: contactId,
    contact_id: contactId,
    message: { type: 'text', text: text }
  };
  
  try {
    const r = await fetch('https://api.sendpulse.com/chatbots/messages/send', {
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
    console.log(`   Response: ${responseText}`);
    
    if (r.ok && json && json.success !== false) {
      console.log('   ✅ SUCCESS: Message sent via Chatbots API!');
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

async function testOutboundViaInstagram(token, contactId, text) {
  console.log(`\n🧪 Testing outbound via Instagram API (for comparison):`);
  console.log(`   Contact ID: ${contactId}`);
  console.log(`   Text: ${text}`);
  
  const payload = {
    chat_id: contactId,
    contact_id: contactId,
    text: text
  };
  
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
    console.log(`   Response: ${responseText}`);
    
    if (r.ok && json && json.success !== false) {
      console.log('   ✅ SUCCESS: Message sent via Instagram API!');
      return true;
    } else {
      console.log('   ❌ FAILED: Message not sent via Instagram API');
      return false;
    }
  } catch (e) {
    console.log(`   ❌ ERROR: ${e.message}`);
    return false;
  }
}

(async function main() {
  console.log('🚀 Test Fixed SendPulse Outbound Messaging');
  console.log('==========================================');
  
  try {
    const token = await getToken();
    console.log('✅ Got authentication token');
    
    // Get Instagram chats to find a contact to test with
    const chats = await getInstagramChats(token);
    console.log(`\n📱 Found ${chats.length} Instagram chats`);
    
    if (chats.length === 0) {
      console.log('❌ No chats found to test with');
      return;
    }
    
    // Use the first chat for testing
    const testChat = chats[0];
    const contactId = testChat.contact?.id || testChat.inbox_last_message?.contact_id;
    
    if (!contactId) {
      console.log('❌ No contact ID found in chat data');
      console.log('Chat data keys:', Object.keys(testChat));
      return;
    }
    
    console.log(`\n🎯 Testing with contact: ${contactId}`);
    console.log(`   Chat data keys: ${Object.keys(testChat)}`);
    
    // Get bot ID from environment
    const botId = process.env.SENDPULSE_BOT_ID_INSTAGRAM;
    if (!botId) {
      console.log('❌ SENDPULSE_BOT_ID_INSTAGRAM not set');
      return;
    }
    
    const testMessage = 'Test message from fixed outbound script - ' + new Date().toISOString();
    
    // Test both methods
    const chatbotsSuccess = await testOutboundViaChatbots(token, botId, contactId, testMessage);
    const instagramSuccess = await testOutboundViaInstagram(token, contactId, testMessage);
    
    // Summary
    console.log('\n📊 TEST RESULTS:');
    console.log(`   Chatbots API: ${chatbotsSuccess ? '✅ SUCCESS' : '❌ FAILED'}`);
    console.log(`   Instagram API: ${instagramSuccess ? '✅ SUCCESS' : '❌ FAILED'}`);
    
    if (chatbotsSuccess) {
      console.log('\n🎉 SOLUTION FOUND!');
      console.log('   Use the Chatbots API for outbound messaging:');
      console.log('   POST /chatbots/messages/send');
      console.log('   With bot_id, chat_id, contact_id, and message object');
    } else if (instagramSuccess) {
      console.log('\n🎉 Instagram API works!');
      console.log('   Use the Instagram API for outbound messaging:');
      console.log('   POST /instagram/chats/messages');
      console.log('   With chat_id, contact_id, and text');
    } else {
      console.log('\n❌ Both methods failed');
      console.log('   This suggests a deeper SendPulse configuration issue');
    }
    
  } catch (e) {
    console.log(`❌ ERROR: ${e.message}`);
  }
})();
