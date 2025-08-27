/*
  Find Correct SendPulse Bot IDs
  This script helps identify the correct bot IDs from your SendPulse account
  
  Usage:
    node scripts/find_correct_bot_ids.js
*/

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true }); } catch {}
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true }); } catch {}

function sanitizeBase(b) { return String(b || '').trim().replace(/\/+$/, ''); }

async function getSendpulseToken(baseCandidates) {
  const clientId = process.env.SENDPULSE_CLIENT_ID;
  const clientSecret = process.env.SENDPULSE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing SENDPULSE_CLIENT_ID/SECRET');
  
  const form = new URLSearchParams();
  form.set('grant_type', 'client_credentials');
  form.set('client_id', clientId);
  form.set('client_secret', clientSecret);
  
  for (const base of baseCandidates) {
    try {
      const r = await fetch(`${base}/oauth/access_token`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, 
        body: form.toString() 
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.access_token) return { token: j.access_token, base };
    } catch {}
  }
  throw new Error('Failed to obtain SendPulse token');
}

async function spGetJson(token, url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const t = await r.text().catch(() => '');
  let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { ok: r.ok, status: r.status, data: j ?? t };
}

async function findInstagramBots(token, base) {
  console.log('\n📱 Finding Instagram bots...');
  
  try {
    const result = await spGetJson(token, `${base}/instagram/bots`);
    if (result.ok && result.data && Array.isArray(result.data)) {
      console.log(`   ✅ Found ${result.data.length} Instagram bots:`);
      for (const bot of result.data) {
        console.log(`\n     🤖 Bot ID: ${bot.id}`);
        console.log(`        Name: ${bot.name || 'Unknown'}`);
        console.log(`        Status: ${bot.status || 'Unknown'}`);
        console.log(`        Platform: ${bot.platform || 'Unknown'}`);
        console.log(`        Created: ${bot.created_at || 'Unknown'}`);
        if (bot.description) console.log(`        Description: ${bot.description}`);
      }
      return result.data;
    } else {
      console.log(`   ❌ Failed to fetch Instagram bots: ${result.status}`);
      return [];
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return [];
  }
}

async function findChatbotBots(token, base) {
  console.log('\n🤖 Finding Chatbot bots...');
  
  try {
    const result = await spGetJson(token, `${base}/chatbots/bots`);
    if (result.ok && result.data && Array.isArray(result.data)) {
      console.log(`   ✅ Found ${result.data.length} Chatbot bots:`);
      for (const bot of result.data) {
        console.log(`\n     🤖 Bot ID: ${bot.id}`);
        console.log(`        Name: ${bot.name || 'Unknown'}`);
        console.log(`        Status: ${bot.status || 'Unknown'}`);
        console.log(`        Platform: ${bot.platform || 'Unknown'}`);
        console.log(`        Type: ${bot.type || 'Unknown'}`);
        if (bot.description) console.log(`        Description: ${bot.description}`);
      }
      return result.data;
    } else {
      console.log(`   ❌ Failed to fetch Chatbot bots: ${result.status}`);
      return [];
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return [];
  }
}

async function findInstagramContacts(token, base) {
  console.log('\n👥 Finding Instagram contacts...');
  
  try {
    // Try different approaches to find contacts
    const approaches = [
      { name: 'Instagram Chats', url: `${base}/instagram/chats?limit=10` },
      { name: 'Instagram Contacts (direct)', url: `${base}/instagram/contacts?limit=10` }
    ];
    
    for (const approach of approaches) {
      try {
        console.log(`\n   📡 Trying ${approach.name}...`);
        const result = await spGetJson(token, approach.url);
        if (result.ok && result.data && Array.isArray(result.data)) {
          console.log(`     ✅ Found ${result.data.length} items via ${approach.name}`);
          
          // Show first few items to understand structure
          for (let i = 0; i < Math.min(3, result.data.length); i++) {
            const item = result.data[i];
            console.log(`\n       Item ${i + 1}:`);
            console.log(`         Keys: ${Object.keys(item).join(', ')}`);
            if (item.id) console.log(`         ID: ${item.id}`);
            if (item.contact_id) console.log(`         Contact ID: ${item.contact_id}`);
            if (item.chat_id) console.log(`         Chat ID: ${item.chat_id}`);
            if (item.username) console.log(`         Username: ${item.username}`);
            if (item.name) console.log(`         Name: ${item.name}`);
          }
          
          if (approach.name === 'Instagram Chats') {
            return result.data;
          }
        } else {
          console.log(`     ❌ ${approach.name} failed: ${result.status}`);
        }
      } catch (e) {
        console.log(`     ❌ ${approach.name} error: ${e.message}`);
      }
    }
    
    return [];
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return [];
  }
}

async function testBotWithContact(token, base, botId, contactId) {
  console.log(`\n🧪 Testing bot ${botId} with contact ${contactId}...`);
  
  // Test Instagram endpoint
  try {
    const payload = {
      chat_id: contactId,
      contact_id: contactId,
      text: 'Test message from bot ID finder script'
    };
    
    const r = await fetch(`${base}/instagram/chats/messages`, {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${token}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify(payload)
    });
    
    const text = await r.text().catch(() => '');
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    
    if (r.ok && json && json.success !== false) {
      console.log('     ✅ Instagram send successful!');
      return true;
    } else {
      console.log(`     ❌ Instagram send failed (${r.status}):`, json || text);
    }
  } catch (e) {
    console.log(`     ❌ Instagram send error: ${e.message}`);
  }

  // Test Chatbots endpoint
  try {
    const payload = {
      bot_id: botId,
      chat_id: contactId,
      contact_id: contactId,
      message: { type: 'text', text: 'Test message from bot ID finder script' }
    };
    
    const r = await fetch(`${base}/chatbots/messages/send`, {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${token}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify(payload)
    });
    
    const text = await r.text().catch(() => '');
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    
    if (r.ok && json && json.success !== false) {
      console.log('     ✅ Chatbots send successful!');
      return true;
    } else {
      console.log(`     ❌ Chatbots send failed (${r.status}):`, json || text);
    }
  } catch (e) {
    console.log(`     ❌ Chatbots send error: ${e.message}`);
  }

  return false;
}

(async function main() {
  console.log('🚀 SendPulse Bot ID Finder');
  console.log('============================');
  
  const base = sanitizeBase(process.env.SENDPULSE_API_BASE || 'https://api.sendpulse.com');
  const bases = Array.from(new Set([base, 'https://api.eu.sendpulse.com', 'https://api.sendpulse.com']));
  
  try {
    // Get authentication
    console.log('\n🔐 Getting SendPulse token...');
    const auth = await getSendpulseToken(bases);
    console.log(`✅ Authenticated with ${auth.base}`);
    
    // Find all available bots
    const instagramBots = await findInstagramBots(auth.token, auth.base);
    const chatbotBots = await findChatbotBots(auth.token, auth.base);
    
    // Find contacts to test with
    const contacts = await findInstagramContacts(auth.token, auth.base);
    
    if (contacts.length === 0) {
      console.log('\n❌ No contacts found to test with');
      console.log('   You may need to wait for customer messages or check your bot configuration');
      return;
    }
    
    // Test each bot with a contact
    console.log('\n🧪 Testing bots with contacts...');
    const workingBots = [];
    
    for (const bot of [...instagramBots, ...chatbotBots]) {
      for (const contact of contacts.slice(0, 2)) { // Test with first 2 contacts
        const contactId = contact.id || contact.contact_id || contact.chat_id;
        if (contactId) {
          const success = await testBotWithContact(auth.token, auth.base, bot.id, contactId);
          if (success) {
            workingBots.push({ bot, contact, contactId });
            break; // Found a working combination for this bot
          }
        }
      }
    }
    
    // Summary
    console.log('\n📊 SUMMARY:');
    console.log(`   Instagram bots found: ${instagramBots.length}`);
    console.log(`   Chatbot bots found: ${chatbotBots.length}`);
    console.log(`   Contacts found: ${contacts.length}`);
    console.log(`   Working bot-contact combinations: ${workingBots.length}`);
    
    if (workingBots.length > 0) {
      console.log('\n✅ WORKING COMBINATIONS:');
      for (const combo of workingBots) {
        console.log(`\n   Bot: ${combo.bot.name || combo.bot.id} (${combo.bot.id})`);
        console.log(`   Contact: ${combo.contact.username || combo.contact.name || combo.contactId} (${combo.contactId})`);
        console.log(`   Platform: ${combo.bot.platform || 'Unknown'}`);
      }
      
      console.log('\n🔧 ENVIRONMENT VARIABLE UPDATES:');
      const igBot = workingBots.find(w => w.bot.platform === 'instagram' || w.bot.type === 'instagram');
      const fbBot = workingBots.find(w => w.bot.platform === 'facebook' || w.bot.type === 'facebook');
      
      if (igBot) {
        console.log(`   SENDPULSE_BOT_ID_INSTAGRAM=${igBot.bot.id}`);
      }
      if (fbBot) {
        console.log(`   SENDPULSE_BOT_ID_FACEBOOK=${fbBot.bot.id}`);
      }
      
      console.log('\n💡 TIP: Update your .env file with these bot IDs and restart your server');
    } else {
      console.log('\n❌ No working bot-contact combinations found');
      console.log('   This suggests a deeper SendPulse configuration issue');
      console.log('   Contact SendPulse support to verify your account setup');
    }
    
  } catch (e) {
    console.log(`\n❌ ERROR: ${e.message}`);
  }
})();
