/*
  Check Instagram Bot Status
  This script checks if the Instagram bot is properly configured and connected

  Usage:
    node scripts/check_instagram_bot_status.js
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

async function checkBotDetails(token, botId) {
  console.log(`\n🔍 Checking Bot Details (ID: ${botId})`);
  
  try {
    const r = await fetch(`https://api.sendpulse.com/instagram/bots/${botId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    const responseText = await r.text();
    let json = null; try { json = JSON.parse(responseText); } catch {}
    
    console.log(`   Status: ${r.status}`);
    
    if (r.ok && json && json.success !== false) {
      console.log(`   ✅ Bot details retrieved successfully`);
      console.log(`   Name: ${json.data?.name || 'Unknown'}`);
      console.log(`   Status: ${json.data?.status || 'Unknown'}`);
      console.log(`   Login Type: ${json.data?.login_type || 'Unknown'}`);
      console.log(`   Channel: ${json.data?.channel || 'Unknown'}`);
      
      if (json.data?.channel_data) {
        const cd = json.data.channel_data;
        console.log(`   Channel Data:`);
        console.log(`     Scopes: ${cd.scopes?.join(', ') || 'None'}`);
        console.log(`     FB User: ${cd.fb_user || 'None'}`);
        console.log(`     Biography: ${cd.biography?.substring(0, 100) || 'None'}...`);
      }
      
      return json.data;
    } else {
      console.log(`   ❌ Bot details not retrievable`);
      console.log(`   Response: ${responseText.substring(0, 300)}...`);
      return null;
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return null;
  }
}

async function checkBotStatus(token, botId) {
  console.log(`\n🔍 Checking Bot Status Endpoint`);
  
  try {
    const r = await fetch(`https://api.sendpulse.com/instagram/bots/${botId}/status`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    const responseText = await r.text();
    let json = null; try { json = JSON.parse(responseText); } catch {}
    
    console.log(`   Status Endpoint: ${r.status}`);
    
    if (r.ok && json) {
      console.log(`   ✅ Bot status retrieved`);
      console.log(`   Response: ${JSON.stringify(json, null, 2)}`);
      return json;
    } else {
      console.log(`   ❌ Bot status not retrievable`);
      console.log(`   Response: ${responseText.substring(0, 300)}...`);
      return null;
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return null;
  }
}

async function checkWebhookConfiguration(token, botId) {
  console.log(`\n🔍 Checking Webhook Configuration`);
  
  try {
    const r = await fetch(`https://api.sendpulse.com/instagram/bots/${botId}/webhooks`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    const responseText = await r.text();
    let json = null; try { json = JSON.parse(responseText); } catch {}
    
    console.log(`   Webhooks Endpoint: ${r.status}`);
    
    if (r.ok && json) {
      console.log(`   ✅ Webhook configuration retrieved`);
      console.log(`   Response: ${JSON.stringify(json, null, 2)}`);
      return json;
    } else {
      console.log(`   ❌ Webhook configuration not retrievable`);
      console.log(`   Response: ${responseText.substring(0, 300)}...`);
      return null;
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return null;
  }
}

async function checkInstagramPermissions(token, botId) {
  console.log(`\n🔍 Checking Instagram Permissions`);
  
  try {
    const r = await fetch(`https://api.sendpulse.com/instagram/bots/${botId}/permissions`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    const responseText = await r.text();
    let json = null; try { json = JSON.parse(responseText); } catch {}
    
    console.log(`   Permissions Endpoint: ${r.status}`);
    
    if (r.ok && json) {
      console.log(`   ✅ Permissions retrieved`);
      console.log(`   Response: ${JSON.stringify(json, null, 2)}`);
      return json;
    } else {
      console.log(`   ❌ Permissions not retrievable`);
      console.log(`   Response: ${responseText.substring(0, 300)}...`);
      return null;
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return null;
  }
}

async function testMessageDeliveryWithDelay(token, contactId) {
  console.log(`\n🧪 Testing Message Delivery with Extended Delay`);
  
  const testMessage = `Delivery test with delay ${new Date().toISOString()}`;
  const payload = {
    chat_id: contactId,
    contact_id: contactId,
    text: testMessage
  };
  
  console.log(`   📤 Sending: "${testMessage}"`);
  
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
    
    if (r.ok && json && json.success !== false) {
      console.log(`   ✅ Message sent successfully!`);
      console.log(`   Message ID: ${json.data?.[0]?.id || 'Unknown'}`);
      
      // Wait longer to see if message appears
      console.log(`   ⏳ Waiting 10 seconds to check Instagram delivery...`);
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      console.log(`   📱 Check Instagram now to see if the message appeared`);
      console.log(`   💡 If no message appears, this indicates a platform-level issue`);
      
      return true;
    } else {
      console.log(`   ❌ Message sending failed`);
      return false;
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return false;
  }
}

async function checkSendPulseDocumentation() {
  console.log(`\n📚 SendPulse Instagram API Documentation Check`);
  console.log(`   Based on the symptoms, here are potential issues:`);
  console.log(`   `);
  console.log(`   1. **Instagram Business Account Requirements:**`);
  console.log(`      - Account must be a Business or Creator account`);
  console.log(`      - Must have Instagram Basic Display or Graph API access`);
  console.log(`      - Must be connected to a Facebook Page`);
  console.log(`   `);
  console.log(`   2. **SendPulse Bot Configuration:**`);
  console.log(`      - Bot must be fully activated`);
  console.log(`      - Instagram permissions must be granted`);
  console.log(`      - Webhook must be properly configured`);
  console.log(`   `);
  console.log(`   3. **Message Delivery Limitations:**`);
  console.log(`      - Instagram has strict rules about business messaging`);
  console.log(`      - Messages may be blocked if they violate policies`);
  console.log(`      - Rate limiting may apply to business accounts`);
}

(async function main() {
  console.log('🔍 Check Instagram Bot Status');
  console.log('=============================');
  
  try {
    const token = await getToken();
    console.log('✅ Got authentication token');
    
    const botId = process.env.SENDPULSE_BOT_ID_INSTAGRAM;
    console.log(`\n📋 Bot ID: ${botId}`);
    
    // Check various bot endpoints
    const botDetails = await checkBotDetails(token, botId);
    await checkBotStatus(token, botId);
    await checkWebhookConfiguration(token, botId);
    await checkInstagramPermissions(token, botId);
    
    // Test message delivery with longer delay
    const contactId = '68ab4050ac7632ce7d0d0250';
    await testMessageDeliveryWithDelay(token, contactId);
    
    // Provide documentation insights
    await checkSendPulseDocumentation();
    
    console.log(`\n🔧 DIAGNOSIS:`);
    if (botDetails) {
      console.log(`   ✅ Bot is properly configured in SendPulse`);
      console.log(`   Status: ${botDetails.status || 'Unknown'}`);
      console.log(`   Login Type: ${botDetails.login_type || 'Unknown'}`);
    } else {
      console.log(`   ❌ Bot configuration issue detected`);
    }
    
    console.log(`\n💡 NEXT STEPS:`);
    console.log(`   1. Check your Instagram account type (must be Business/Creator)`);
    console.log(`   2. Verify Instagram permissions in SendPulse dashboard`);
    console.log(`   3. Check if Instagram is blocking business messages`);
    console.log(`   4. Contact SendPulse support about message delivery`);
    console.log(`   5. Test with a different Instagram account if possible`);
    
  } catch (e) {
    console.log(`❌ ERROR: ${e.message}`);
  }
})();
