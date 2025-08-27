/*
  Deep Diagnose Instagram Outbound Issues
  This script investigates why messages aren't appearing in Instagram despite API success

  Usage:
    node scripts/deep_diagnose_instagram.js
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

async function checkBotStatus(token, botId) {
  console.log(`\n🔍 Checking Bot Status (ID: ${botId})`);
  
  try {
    // Check Instagram bot details
    const r = await fetch(`https://api.sendpulse.com/instagram/bots/${botId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    const responseText = await r.text();
    let json = null; try { json = JSON.parse(responseText); } catch {}
    
    console.log(`   Instagram Bot Status: ${r.status}`);
    console.log(`   Response: ${responseText.substring(0, 500)}...`);
    
    if (r.ok && json) {
      console.log(`   ✅ Bot found: ${json.name || 'Unknown'}`);
      console.log(`   Channel: ${json.channel || 'Unknown'}`);
      console.log(`   URL: ${json.url || 'Unknown'}`);
      console.log(`   External ID: ${json.external_id || 'Unknown'}`);
      return json;
    } else {
      console.log(`   ❌ Bot not found or error`);
      return null;
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return null;
  }
}

async function checkContactDetails(token, contactId) {
  console.log(`\n🔍 Checking Contact Details (ID: ${contactId})`);
  
  try {
    // Check Instagram contact details
    const r = await fetch(`https://api.sendpulse.com/instagram/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    const responseText = await r.text();
    let json = null; try { json = JSON.parse(responseText); } catch {}
    
    console.log(`   Instagram Contact Status: ${r.status}`);
    console.log(`   Response: ${responseText.substring(0, 500)}...`);
    
    if (r.ok && json) {
      console.log(`   ✅ Contact found: ${json.name || 'Unknown'}`);
      console.log(`   Username: ${json.username || 'Unknown'}`);
      console.log(`   Last Message: ${json.last_message || 'None'}`);
      return json;
    } else {
      console.log(`   ❌ Contact not found or error`);
      return null;
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return null;
  }
}

async function checkChatStatus(token, chatId) {
  console.log(`\n🔍 Checking Chat Status (ID: ${chatId})`);
  
  try {
    // Check Instagram chat details
    const r = await fetch(`https://api.sendpulse.com/instagram/chats/${chatId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    const responseText = await r.text();
    let json = null; try { json = JSON.parse(responseText); } catch {}
    
    console.log(`   Instagram Chat Status: ${r.status}`);
    console.log(`   Response: ${responseText.substring(0, 500)}...`);
    
    if (r.ok && json) {
      console.log(`   ✅ Chat found`);
      console.log(`   Contact ID: ${json.contact_id || 'Unknown'}`);
      console.log(`   Bot ID: ${json.bot_id || 'Unknown'}`);
      console.log(`   Status: ${json.status || 'Unknown'}`);
      return json;
    } else {
      console.log(`   ❌ Chat not found or error`);
      return null;
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return null;
  }
}

async function listRecentMessages(token, chatId) {
  console.log(`\n🔍 Listing Recent Messages for Chat (ID: ${chatId})`);
  
  try {
    // List recent messages in the chat
    const r = await fetch(`https://api.sendpulse.com/instagram/chats/${chatId}/messages?limit=10`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    const responseText = await r.text();
    let json = null; try { json = JSON.parse(responseText); } catch {}
    
    console.log(`   Messages Status: ${r.status}`);
    console.log(`   Response: ${responseText.substring(0, 500)}...`);
    
    if (r.ok && json && json.data) {
      console.log(`   ✅ Found ${json.data.length} messages`);
      json.data.forEach((msg, i) => {
        console.log(`   Message ${i + 1}: ${msg.text || '[No text]'} (${msg.created_at || 'Unknown time'})`);
      });
      return json;
    } else {
      console.log(`   ❌ No messages found or error`);
      return null;
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return null;
  }
}

async function testMessageDelivery(token, contactId) {
  console.log(`\n🧪 Testing Message Delivery`);
  
  const testMessage = `Test delivery ${new Date().toISOString()}`;
  const payload = {
    chat_id: contactId,
    contact_id: contactId,
    text: testMessage
  };
  
  console.log(`   Sending: "${testMessage}"`);
  console.log(`   To: ${contactId}`);
  
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
    
    console.log(`   API Response: ${r.status}`);
    console.log(`   Response Body: ${responseText.substring(0, 300)}...`);
    
    if (r.ok && json && json.success !== false) {
      console.log(`   ✅ API reports SUCCESS`);
      
      // Wait a moment and check if message appears in chat
      console.log(`   ⏳ Waiting 5 seconds to check if message appears...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Try to get the message ID from the response
      if (json.id) {
        console.log(`   📝 Message ID: ${json.id}`);
        console.log(`   🔍 Checking if message is visible in chat...`);
        
        // Check if we can retrieve the sent message
        const checkR = await fetch(`https://api.sendpulse.com/instagram/chats/messages/${json.id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (checkR.ok) {
          console.log(`   ✅ Message is retrievable from API`);
        } else {
          console.log(`   ❌ Message not retrievable (${checkR.status})`);
        }
      }
      
      return true;
    } else {
      console.log(`   ❌ API reports failure`);
      return false;
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return false;
  }
}

async function checkSendPulseStatus() {
  console.log(`\n🔍 Checking SendPulse Service Status`);
  
  try {
    const r = await fetch('https://api.sendpulse.com/status');
    const responseText = await r.text();
    
    console.log(`   Status Endpoint: ${r.status}`);
    console.log(`   Response: ${responseText.substring(0, 200)}...`);
    
    return r.ok;
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return false;
  }
}

(async function main() {
  console.log('🔍 Deep Diagnose Instagram Outbound Issues');
  console.log('==========================================');
  
  try {
    const token = await getToken();
    console.log('✅ Got authentication token');
    
    const botId = process.env.SENDPULSE_BOT_ID_INSTAGRAM;
    const contactId = '68ab4050ac7632ce7d0d0250'; // Known working contact ID
    
    console.log(`\n📋 Configuration:`);
    console.log(`   Bot ID: ${botId}`);
    console.log(`   Contact ID: ${contactId}`);
    
    // Check SendPulse service status
    await checkSendPulseStatus();
    
    // Check bot configuration
    const botDetails = await checkBotStatus(token, botId);
    
    // Check contact details
    const contactDetails = await checkContactDetails(token, contactId);
    
    // Check chat status
    const chatDetails = await checkChatStatus(token, contactId);
    
    // List recent messages
    await listRecentMessages(token, contactId);
    
    // Test message delivery
    await testMessageDelivery(token, contactId);
    
    console.log(`\n📊 Summary:`);
    if (botDetails) {
      console.log(`   ✅ Bot is properly configured`);
    } else {
      console.log(`   ❌ Bot configuration issue detected`);
    }
    
    if (contactDetails) {
      console.log(`   ✅ Contact is valid`);
    } else {
      console.log(`   ❌ Contact validation issue detected`);
    }
    
    if (chatDetails) {
      console.log(`   ✅ Chat is active`);
    } else {
      console.log(`   ❌ Chat status issue detected`);
    }
    
    console.log(`\n💡 Next Steps:`);
    console.log(`   1. Check if the bot is properly connected to Instagram`);
    console.log(`   2. Verify the contact is in an active conversation state`);
    console.log(`   3. Check SendPulse dashboard for any error messages`);
    console.log(`   4. Verify Instagram business account permissions`);
    
  } catch (e) {
    console.log(`❌ ERROR: ${e.message}`);
  }
})();
