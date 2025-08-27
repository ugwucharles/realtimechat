/*
  Find Correct Instagram Bot ID
  This script lists all available bots in SendPulse to find the correct Instagram bot

  Usage:
    node scripts/find_correct_instagram_bot.js
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

async function listAllBots(token) {
  console.log(`\n🔍 Listing All Available Bots`);
  
  try {
    const r = await fetch('https://api.sendpulse.com/instagram/bots', {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    const responseText = await r.text();
    let json = null; try { json = JSON.parse(responseText); } catch {}
    
    console.log(`   Instagram Bots Endpoint: ${r.status}`);
    
    if (r.ok && json && json.success !== false && json.data) {
      console.log(`   ✅ Found ${json.data.length} Instagram bots`);
      
      json.data.forEach((bot, index) => {
        console.log(`\n   📋 Bot ${index + 1}:`);
        console.log(`      ID: ${bot.id}`);
        console.log(`      Name: ${bot.name || 'Unknown'}`);
        console.log(`      Status: ${bot.status || 'Unknown'}`);
        console.log(`      Channel: ${bot.channel || 'Unknown'}`);
        console.log(`      Login Type: ${bot.login_type || 'Unknown'}`);
        
        if (bot.channel_data) {
          const cd = bot.channel_data;
          console.log(`      Channel Data:`);
          console.log(`        Scopes: ${cd.scopes?.join(', ') || 'None'}`);
          console.log(`        FB User: ${cd.fb_user || 'None'}`);
          if (cd.biography) {
            console.log(`        Bio: ${cd.biography.substring(0, 100)}...`);
          }
        }
      });
      
      return json.data;
    } else {
      console.log(`   ❌ No Instagram bots found or error`);
      console.log(`   Response: ${responseText.substring(0, 300)}...`);
      return [];
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return [];
  }
}

async function listAllChatbots(token) {
  console.log(`\n🔍 Listing All Chatbots (Alternative API)`);
  
  try {
    const r = await fetch('https://api.sendpulse.com/chatbots/bots', {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    const responseText = await r.text();
    let json = null; try { json = JSON.parse(responseText); } catch {}
    
    console.log(`   Chatbots Endpoint: ${r.status}`);
    
    if (r.ok && json && json.success !== false && json.data) {
      console.log(`   ✅ Found ${json.data.length} chatbots`);
      
      json.data.forEach((bot, index) => {
        console.log(`\n   📋 Chatbot ${index + 1}:`);
        console.log(`      ID: ${bot.id}`);
        console.log(`      Name: ${bot.name || 'Unknown'}`);
        console.log(`      Type: ${bot.type || 'Unknown'}`);
        console.log(`      Channel: ${bot.channel || 'Unknown'}`);
        console.log(`      Status: ${bot.status || 'Unknown'}`);
      });
      
      return json.data;
    } else {
      console.log(`   ❌ No chatbots found or error`);
      console.log(`   Response: ${responseText.substring(0, 300)}...`);
      return [];
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return [];
  }
}

async function testBotWithId(token, botId, botName) {
  console.log(`\n🧪 Testing Bot: ${botName} (ID: ${botId})`);
  
  try {
    // Test if bot details are retrievable
    const detailsR = await fetch(`https://api.sendpulse.com/instagram/bots/${botId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    if (detailsR.ok) {
      console.log(`   ✅ Bot details retrievable`);
      
      // Test if we can send a message using this bot
      const contactId = '68ab4050ac7632ce7d0d0250'; // Known contact
      const testMessage = `Test with bot ${botId} - ${new Date().toISOString()}`;
      
      const payload = {
        chat_id: contactId,
        contact_id: contactId,
        text: testMessage
      };
      
      console.log(`   📤 Testing message send with this bot...`);
      
      const sendR = await fetch('https://api.sendpulse.com/instagram/chats/messages', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      if (sendR.ok) {
        console.log(`   ✅ Message sending works with this bot!`);
        return { working: true, reason: 'Bot details retrievable and message sending works' };
      } else {
        console.log(`   ❌ Message sending failed with this bot`);
        return { working: false, reason: 'Message sending failed' };
      }
    } else {
      console.log(`   ❌ Bot details not retrievable (${detailsR.status})`);
      return { working: false, reason: 'Bot details not retrievable' };
    }
  } catch (e) {
    console.log(`   ❌ Error testing bot: ${e.message}`);
    return { working: false, reason: `Error: ${e.message}` };
  }
}

async function checkEnvironmentVariables() {
  console.log(`\n🔍 Checking Environment Variables`);
  
  const envVars = [
    'SENDPULSE_BOT_ID_INSTAGRAM',
    'SENDPULSE_BOT_ID_FACEBOOK',
    'SENDPULSE_CLIENT_ID',
    'SENDPULSE_CLIENT_SECRET'
  ];
  
  envVars.forEach(varName => {
    const value = process.env[varName];
    if (value) {
      console.log(`   ✅ ${varName}: ${value}`);
    } else {
      console.log(`   ❌ ${varName}: NOT SET`);
    }
  });
}

async function provideRecommendations(instagramBots, chatbots) {
  console.log(`\n💡 RECOMMENDATIONS`);
  console.log(`==================`);
  
  if (instagramBots.length === 0 && chatbots.length === 0) {
    console.log(`   ❌ No bots found in your SendPulse account`);
    console.log(`   🔧 Action: Create a new Instagram bot in SendPulse dashboard`);
    console.log(`   🔧 Action: Connect your Instagram Business account`);
    console.log(`   🔧 Action: Grant necessary permissions`);
  } else if (instagramBots.length > 0) {
    console.log(`   ✅ Found ${instagramBots.length} Instagram bot(s)`);
    console.log(`   🔧 Action: Update your .env file with the correct bot ID`);
    console.log(`   🔧 Action: Test each bot to find the working one`);
    
    instagramBots.forEach((bot, index) => {
      console.log(`   📝 Bot ${index + 1}: ${bot.name} (ID: ${bot.id})`);
    });
  } else if (chatbots.length > 0) {
    console.log(`   ⚠️  Found ${chatbots.length} chatbot(s) but no Instagram bots`);
    console.log(`   🔧 Action: Check if any chatbots are Instagram-enabled`);
    console.log(`   🔧 Action: Convert a chatbot to Instagram or create new Instagram bot`);
  }
  
  console.log(`\n🔧 IMMEDIATE ACTIONS:`);
  console.log(`   1. Update SENDPULSE_BOT_ID_INSTAGRAM in your .env file`);
  console.log(`   2. Restart your server after updating the environment variable`);
  console.log(`   3. Test outbound messaging with the new bot ID`);
  console.log(`   4. If still not working, check SendPulse dashboard for bot status`);
}

(async function main() {
  console.log('🔍 Find Correct Instagram Bot ID');
  console.log('================================');
  
  try {
    const token = await getToken();
    console.log('✅ Got authentication token');
    
    // Check current environment variables
    await checkEnvironmentVariables();
    
    // List all available bots
    const instagramBots = await listAllBots(token);
    const chatbots = await listAllChatbots(token);
    
    console.log(`\n📊 SUMMARY:`);
    console.log(`   Instagram Bots: ${instagramBots.length}`);
    console.log(`   Chatbots: ${chatbots.length}`);
    
    // Test each Instagram bot to find the working one
    if (instagramBots.length > 0) {
      console.log(`\n🧪 Testing Each Instagram Bot...`);
      
      for (const bot of instagramBots) {
        const result = await testBotWithId(token, bot.id, bot.name);
        
        if (result.working) {
          console.log(`\n🎉 WORKING BOT FOUND!`);
          console.log(`   Name: ${bot.name}`);
          console.log(`   ID: ${bot.id}`);
          console.log(`   Reason: ${result.reason}`);
          
          console.log(`\n🔧 UPDATE YOUR .ENV FILE:`);
          console.log(`   SENDPULSE_BOT_ID_INSTAGRAM=${bot.id}`);
          
          break;
        }
        
        // Wait between tests
        if (bot !== instagramBots[instagramBots.length - 1]) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    // Provide recommendations
    await provideRecommendations(instagramBots, chatbots);
    
  } catch (e) {
    console.log(`❌ ERROR: ${e.message}`);
  }
})();
