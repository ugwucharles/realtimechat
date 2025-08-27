/*
  Find Real Instagram Contacts
  This script finds actual, valid Instagram contacts in SendPulse

  Usage:
    node scripts/find_real_instagram_contacts.js
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
  console.log(`\n🔍 Listing All Bots`);
  
  try {
    const r = await fetch('https://api.sendpulse.com/instagram/bots', {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    const responseText = await r.text();
    let json = null; try { json = JSON.parse(responseText); } catch {}
    
    console.log(`   Instagram Bots Status: ${r.status}`);
    console.log(`   Response: ${responseText.substring(0, 500)}...`);
    
    if (r.ok && json && json.data) {
      console.log(`   ✅ Found ${json.data.length} Instagram bots`);
      json.data.forEach((bot, i) => {
        console.log(`   Bot ${i + 1}: ${bot.name || 'Unknown'} (ID: ${bot.id})`);
        console.log(`     Channel: ${bot.channel || 'Unknown'}`);
        console.log(`     URL: ${bot.url || 'Unknown'}`);
        console.log(`     External ID: ${bot.external_id || 'Unknown'}`);
      });
      return json.data;
    } else {
      console.log(`   ❌ No Instagram bots found or error`);
      return [];
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return [];
  }
}

async function listAllContacts(token) {
  console.log(`\n🔍 Listing All Instagram Contacts`);
  
  try {
    const r = await fetch('https://api.sendpulse.com/instagram/contacts', {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    const responseText = await r.text();
    let json = null; try { json = JSON.parse(responseText); } catch {}
    
    console.log(`   Instagram Contacts Status: ${r.status}`);
    console.log(`   Response: ${responseText.substring(0, 500)}...`);
    
    if (r.ok && json && json.data) {
      console.log(`   ✅ Found ${json.data.length} Instagram contacts`);
      json.data.forEach((contact, i) => {
        console.log(`   Contact ${i + 1}: ${contact.name || 'Unknown'} (ID: ${contact.id})`);
        console.log(`     Username: ${contact.username || 'Unknown'}`);
        console.log(`     Last Message: ${contact.last_message || 'None'}`);
        console.log(`     Photo: ${contact.photo || 'None'}`);
      });
      return json.data;
    } else {
      console.log(`   ❌ No Instagram contacts found or error`);
      return [];
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return [];
  }
}

async function listAllChats(token) {
  console.log(`\n🔍 Listing All Instagram Chats`);
  
  try {
    const r = await fetch('https://api.sendpulse.com/instagram/chats', {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    const responseText = await r.text();
    let json = null; try { json = JSON.parse(responseText); } catch {}
    
    console.log(`   Instagram Chats Status: ${r.status}`);
    console.log(`   Response: ${responseText.substring(0, 500)}...`);
    
    if (r.ok && json && json.data) {
      console.log(`   ✅ Found ${json.data.length} Instagram chats`);
      json.data.forEach((chat, i) => {
        console.log(`   Chat ${i + 1}: Contact ID: ${chat.contact_id} (Chat ID: ${chat.id})`);
        console.log(`     Bot ID: ${chat.bot_id || 'Unknown'}`);
        console.log(`     Status: ${chat.status || 'Unknown'}`);
        console.log(`     Created: ${chat.created_at || 'Unknown'}`);
      });
      return json.data;
    } else {
      console.log(`   ❌ No Instagram chats found or error`);
      return [];
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return [];
  }
}

async function testContactWithRealId(token, contactId) {
  console.log(`\n🧪 Testing Contact ID: ${contactId}`);
  
  try {
    // First, try to get contact details
    const contactR = await fetch(`https://api.sendpulse.com/instagram/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    if (contactR.ok) {
      console.log(`   ✅ Contact exists and is valid`);
      
      // Try to send a test message
      const testMessage = `Test with real contact ${new Date().toISOString()}`;
      const payload = {
        chat_id: contactId,
        contact_id: contactId,
        text: testMessage
      };
      
      console.log(`   📤 Sending test message: "${testMessage}"`);
      
      const sendR = await fetch('https://api.sendpulse.com/instagram/chats/messages', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      const sendText = await sendR.text();
      let sendJson = null; try { sendJson = JSON.parse(sendText); } catch {}
      
      if (sendR.ok && sendJson && sendJson.success !== false) {
        console.log(`   ✅ Message sent successfully!`);
        console.log(`   Message ID: ${sendJson.data?.[0]?.id || 'Unknown'}`);
        return true;
      } else {
        console.log(`   ❌ Message sending failed: ${sendR.status}`);
        console.log(`   Response: ${sendText.substring(0, 200)}...`);
        return false;
      }
    } else {
      console.log(`   ❌ Contact not found (${contactR.status})`);
      return false;
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return false;
  }
}

async function checkAlternativeEndpoints(token) {
  console.log(`\n🔍 Checking Alternative API Endpoints`);
  
  const endpoints = [
    'https://api.sendpulse.com/chatbots/bots',
    'https://api.sendpulse.com/chatbots/contacts',
    'https://api.sendpulse.com/chatbots/chats',
    'https://api.sendpulse.com/chatbots/messages'
  ];
  
  for (const endpoint of endpoints) {
    try {
      const r = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      const responseText = await r.text();
      let json = null; try { json = JSON.parse(responseText); } catch {}
      
      console.log(`   ${endpoint.split('/').pop()}: ${r.status}`);
      
      if (r.ok && json && json.data) {
        console.log(`     ✅ Found ${json.data.length} items`);
        if (json.data.length > 0) {
          const first = json.data[0];
          console.log(`     First item ID: ${first.id || 'Unknown'}`);
          console.log(`     First item type: ${first.type || first.channel || 'Unknown'}`);
        }
      } else {
        console.log(`     ❌ No data or error`);
      }
    } catch (e) {
      console.log(`   ${endpoint.split('/').pop()}: ❌ Error - ${e.message}`);
    }
  }
}

(async function main() {
  console.log('🔍 Find Real Instagram Contacts in SendPulse');
  console.log('============================================');
  
  try {
    const token = await getToken();
    console.log('✅ Got authentication token');
    
    // List all available bots, contacts, and chats
    const bots = await listAllBots(token);
    const contacts = await listAllContacts(token);
    const chats = await listAllChats(token);
    
    // Check alternative endpoints
    await checkAlternativeEndpoints(token);
    
    console.log(`\n📊 Summary:`);
    console.log(`   Instagram Bots: ${bots.length}`);
    console.log(`   Instagram Contacts: ${contacts.length}`);
    console.log(`   Instagram Chats: ${chats.length}`);
    
    if (contacts.length > 0) {
      console.log(`\n🧪 Testing First Contact:`);
      const firstContact = contacts[0];
      await testContactWithRealId(token, firstContact.id);
      
      console.log(`\n💡 RECOMMENDATION:`);
      console.log(`   Use contact ID: ${firstContact.id}`);
      console.log(`   Name: ${firstContact.name || 'Unknown'}`);
      console.log(`   Username: ${firstContact.username || 'Unknown'}`);
    }
    
    if (chats.length > 0) {
      console.log(`\n🧪 Testing First Chat:`);
      const firstChat = chats[0];
      await testContactWithRealId(token, firstChat.contact_id);
      
      console.log(`\n💡 ALTERNATIVE RECOMMENDATION:`);
      console.log(`   Use chat contact ID: ${firstChat.contact_id}`);
      console.log(`   Chat ID: ${firstChat.id}`);
    }
    
    console.log(`\n🔧 TO FIX YOUR ISSUE:`);
    console.log(`   1. The contact ID '68ab4050ac7632ce7d0d0250' is NOT valid`);
    console.log(`   2. Use one of the REAL contact IDs found above`);
    console.log(`   3. Update your database with the correct contact ID`);
    console.log(`   4. Test with the new contact ID`);
    
  } catch (e) {
    console.log(`❌ ERROR: ${e.message}`);
  }
})();
