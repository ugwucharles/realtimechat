/*
  Fix Instagram Outbound Messaging
  This script tests and fixes the Instagram outbound messaging issue

  Usage:
    node scripts/fix_instagram_outbound.js
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

async function testInstagramMessageSend(token, contactId) {
  console.log(`\n🧪 Testing Instagram Message Send`);
  console.log(`   Contact ID: ${contactId}`);
  
  const testMessage = `Instagram test message ${new Date().toISOString()}`;
  
  // Method 1: Standard Instagram API
  console.log(`\n📤 Method 1: Standard Instagram API`);
  const payload1 = {
    chat_id: contactId,
    contact_id: contactId,
    text: testMessage
  };
  
  try {
    const r1 = await fetch('https://api.sendpulse.com/instagram/chats/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload1)
    });
    
    const responseText1 = await r1.text();
    let json1 = null; try { json1 = JSON.parse(responseText1); } catch {}
    
    console.log(`   Status: ${r1.status}`);
    console.log(`   Response: ${responseText1.substring(0, 300)}...`);
    
    if (r1.ok && json1 && json1.success !== false) {
      console.log(`   ✅ Method 1 SUCCESS`);
      console.log(`   Message ID: ${json1.data?.[0]?.id || 'Unknown'}`);
      return { success: true, method: 'instagram_api', messageId: json1.data?.[0]?.id };
    } else {
      console.log(`   ❌ Method 1 FAILED`);
      return { success: false, method: 'instagram_api', error: responseText1 };
    }
  } catch (e) {
    console.log(`   ❌ Method 1 ERROR: ${e.message}`);
    return { success: false, method: 'instagram_api', error: e.message };
  }
}

async function testChatbotsMessageSend(token, contactId) {
  console.log(`\n📤 Method 2: Chatbots API (Alternative)`);
  
  const testMessage = `Chatbots test message ${new Date().toISOString()}`;
  const payload2 = {
    bot_id: process.env.SENDPULSE_BOT_ID_INSTAGRAM,
    contact_id: contactId,
    text: testMessage
  };
  
  try {
    const r2 = await fetch('https://api.sendpulse.com/chatbots/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload2)
    });
    
    const responseText2 = await r2.text();
    let json2 = null; try { json2 = JSON.parse(responseText2); } catch {}
    
    console.log(`   Status: ${r2.status}`);
    console.log(`   Response: ${responseText2.substring(0, 300)}...`);
    
    if (r2.ok && json2 && json2.success !== false) {
      console.log(`   ✅ Method 2 SUCCESS`);
      console.log(`   Message ID: ${json2.data?.[0]?.id || 'Unknown'}`);
      return { success: true, method: 'chatbots_api', messageId: json2.data?.[0]?.id };
    } else {
      console.log(`   ❌ Method 2 FAILED`);
      return { success: false, method: 'chatbots_api', error: responseText2 };
    }
  } catch (e) {
    console.log(`   ❌ Method 2 ERROR: ${e.message}`);
    return { success: false, method: 'chatbots_api', error: e.message };
  }
}

async function testWithBotIdInPayload(token, contactId) {
  console.log(`\n📤 Method 3: Instagram API with Bot ID in Payload`);
  
  const testMessage = `Bot ID test message ${new Date().toISOString()}`;
  const payload3 = {
    chat_id: contactId,
    contact_id: contactId,
    bot_id: process.env.SENDPULSE_BOT_ID_INSTAGRAM,
    text: testMessage
  };
  
  try {
    const r3 = await fetch('https://api.sendpulse.com/instagram/chats/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload3)
    });
    
    const responseText3 = await r3.text();
    let json3 = null; try { json3 = JSON.parse(responseText3); } catch {}
    
    console.log(`   Status: ${r3.status}`);
    console.log(`   Response: ${responseText3.substring(0, 300)}...`);
    
    if (r3.ok && json3 && json3.success !== false) {
      console.log(`   ✅ Method 3 SUCCESS`);
      console.log(`   Message ID: ${json3.data?.[0]?.id || 'Unknown'}`);
      return { success: true, method: 'instagram_with_bot_id', messageId: json3.data?.[0]?.id };
    } else {
      console.log(`   ❌ Method 3 FAILED`);
      return { success: false, method: 'instagram_with_bot_id', error: responseText3 };
    }
  } catch (e) {
    console.log(`   ❌ Method 3 ERROR: ${e.message}`);
    return { success: false, method: 'instagram_with_bot_id', error: e.message };
  }
}

async function checkMessageDelivery(token, messageId, method) {
  console.log(`\n🔍 Checking Message Delivery (${method})`);
  console.log(`   Message ID: ${messageId}`);
  
  if (!messageId) {
    console.log(`   ❌ No message ID to check`);
    return false;
  }
  
  // Wait a moment for delivery
  console.log(`   ⏳ Waiting 5 seconds for delivery...`);
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  try {
    // Try to retrieve the message
    const r = await fetch(`https://api.sendpulse.com/instagram/chats/messages/${messageId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    if (r.ok) {
      console.log(`   ✅ Message is retrievable from API`);
      return true;
    } else {
      console.log(`   ❌ Message not retrievable (${r.status})`);
      return false;
    }
  } catch (e) {
    console.log(`   ❌ Error checking message: ${e.message}`);
    return false;
  }
}

async function checkContactStatus(token, contactId) {
  console.log(`\n🔍 Checking Contact Status`);
  
  try {
    // Check if contact exists in chats
    const r = await fetch(`https://api.sendpulse.com/instagram/chats?contact_id=${contactId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    if (r.ok) {
      const responseText = await r.text();
      let json = null; try { json = JSON.parse(responseText); } catch {}
      
      if (json && json.data && json.data.length > 0) {
        console.log(`   ✅ Contact has active chat`);
        console.log(`   Chat messages: ${json.data.length}`);
        return true;
      } else {
        console.log(`   ❌ Contact has no active chat`);
        return false;
      }
    } else {
      console.log(`   ❌ Could not check contact status (${r.status})`);
      return false;
    }
  } catch (e) {
    console.log(`   ❌ Error checking contact: ${e.message}`);
    return false;
  }
}

async function provideFixRecommendations(results) {
  console.log(`\n🔧 FIX RECOMMENDATIONS`);
  console.log(`=======================`);
  
  const successfulMethods = results.filter(r => r.success);
  const failedMethods = results.filter(r => !r.success);
  
  if (successfulMethods.length > 0) {
    console.log(`\n✅ WORKING METHODS:`);
    successfulMethods.forEach(result => {
      console.log(`   - ${result.method}: ${result.messageId}`);
    });
    
    console.log(`\n💡 RECOMMENDED FIX:`);
    console.log(`   Use the working method in your server.js`);
    
    if (successfulMethods.some(r => r.method === 'instagram_api')) {
      console.log(`\n📝 UPDATE YOUR sendPulseSendInstagram FUNCTION:`);
      console.log(`   Use Method 1 (Standard Instagram API)`);
      console.log(`   This is the most reliable approach`);
    }
  } else {
    console.log(`\n❌ ALL METHODS FAILED`);
    console.log(`   This indicates a deeper platform issue`);
    
    console.log(`\n🔍 TROUBLESHOOTING STEPS:`);
    console.log(`   1. Check SendPulse dashboard for bot status`);
    console.log(`   2. Verify Instagram Business account permissions`);
    console.log(`   3. Check if Instagram is blocking business messages`);
    console.log(`   4. Contact SendPulse support`);
  }
  
  console.log(`\n📱 INSTAGRAM DELIVERY CHECK:`);
  console.log(`   Even if API returns success, check Instagram app`);
  console.log(`   Messages may be blocked by Instagram policies`);
  console.log(`   Business accounts have strict messaging rules`);
}

(async function main() {
  console.log('🔧 Fix Instagram Outbound Messaging');
  console.log('===================================');
  
  try {
    const token = await getToken();
    console.log('✅ Got authentication token');
    
    const contactId = '68ab4050ac7632ce7d0d0250';
    console.log(`\n📋 Testing with contact: ${contactId}`);
    
    // Check contact status first
    await checkContactStatus(token, contactId);
    
    // Test different messaging methods
    const results = [];
    
    // Method 1: Standard Instagram API
    const result1 = await testInstagramMessageSend(token, contactId);
    results.push(result1);
    
    // Method 2: Chatbots API
    const result2 = await testChatbotsMessageSend(token, contactId);
    results.push(result2);
    
    // Method 3: Instagram API with Bot ID
    const result3 = await testWithBotIdInPayload(token, contactId);
    results.push(result3);
    
    // Check delivery for successful methods
    console.log(`\n🔍 Checking Message Delivery...`);
    for (const result of results) {
      if (result.success && result.messageId) {
        await checkMessageDelivery(token, result.messageId, result.method);
      }
    }
    
    // Provide fix recommendations
    await provideFixRecommendations(results);
    
    console.log(`\n🎯 SUMMARY:`);
    console.log(`   Total Methods Tested: ${results.length}`);
    console.log(`   Successful: ${results.filter(r => r.success).length}`);
    console.log(`   Failed: ${results.filter(r => !r.success).length}`);
    
  } catch (e) {
    console.log(`❌ ERROR: ${e.message}`);
  }
})();
