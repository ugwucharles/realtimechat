/*
  Fix SendPulse Contact ID Issues for Outbound Messaging
  This script helps identify and resolve the mismatch between inbound webhook IDs and outbound API IDs
  
  Usage:
    node scripts/fix_sendpulse_contact_ids.js
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

async function findContactByChatId(chatId, auth) {
  console.log(`\n🔍 Searching for contact using chat_id: ${chatId}`);
  
  // Method 1: Try Instagram chats endpoint
  console.log('  📱 Method 1: Instagram chats endpoint');
  try {
    const chatResult = await spGetJson(auth.token, `${auth.base}/instagram/chats/${encodeURIComponent(chatId)}`);
    if (chatResult.ok && chatResult.data) {
      console.log('    ✅ Found chat data:', JSON.stringify(chatResult.data, null, 2));
      const contactId = chatResult.data?.contact?.id || chatResult.data?.contact_id || chatResult.data?.subscriber?.id;
      if (contactId) {
        console.log(`    🎯 Contact ID found: ${contactId}`);
        return { contactId, method: 'instagram_chats', data: chatResult.data };
      }
    } else {
      console.log(`    ❌ Chat not found (${chatResult.status})`);
    }
  } catch (e) {
    console.log(`    ❌ Error: ${e.message}`);
  }

  // Method 2: Try Instagram messages endpoint
  console.log('  📱 Method 2: Instagram messages endpoint');
  try {
    const messagesResult = await spGetJson(auth.token, `${auth.base}/instagram/chats/${encodeURIComponent(chatId)}/messages?limit=1`);
    if (messagesResult.ok && messagesResult.data) {
      console.log('    ✅ Found messages data:', JSON.stringify(messagesResult.data, null, 2));
      const contactId = messagesResult.data?.chat?.contact_id || messagesResult.data?.contact?.id;
      if (contactId) {
        console.log(`    🎯 Contact ID found: ${contactId}`);
        return { contactId, method: 'instagram_messages', data: messagesResult.data };
      }
    } else {
      console.log(`    ❌ Messages not found (${messagesResult.status})`);
    }
  } catch (e) {
    console.log(`    ❌ Error: ${e.message}`);
  }

  // Method 3: Try chatbots contacts endpoint
  console.log('  🤖 Method 3: Chatbots contacts endpoint');
  try {
    const contactResult = await spGetJson(auth.token, `${auth.base}/chatbots/contacts/${encodeURIComponent(chatId)}`);
    if (contactResult.ok && contactResult.data) {
      console.log('    ✅ Found contact data:', JSON.stringify(contactResult.data, null, 2));
      const contactId = contactResult.data?.id || contactResult.data?.contact_id;
      if (contactId) {
        console.log(`    🎯 Contact ID found: ${contactId}`);
        return { contactId, method: 'chatbots_contacts', data: contactResult.data };
      }
    } else {
      console.log(`    ❌ Contact not found (${contactResult.status})`);
    }
  } catch (e) {
    console.log(`    ❌ Error: ${e.message}`);
  }

  // Method 4: Try to list recent contacts and find a match
  console.log('  🔍 Method 4: List recent contacts to find match');
  try {
    const contactsResult = await spGetJson(auth.token, `${auth.base}/chatbots/contacts?limit=50`);
    if (contactsResult.ok && contactsResult.data && Array.isArray(contactsResult.data)) {
      console.log(`    ✅ Found ${contactsResult.data.length} recent contacts`);
      // Look for any contact that might match our chat_id
      for (const contact of contactsResult.data) {
        if (contact.chat_id === chatId || contact.id === chatId || contact.contact_id === chatId) {
          console.log(`    🎯 Found matching contact:`, JSON.stringify(contact, null, 2));
          return { contactId: contact.id || contact.contact_id, method: 'recent_contacts_match', data: contact };
        }
      }
      console.log('    ❌ No matching contact found in recent contacts');
    } else {
      console.log(`    ❌ Could not fetch contacts (${contactsResult.status})`);
    }
  } catch (e) {
    console.log(`    ❌ Error: ${e.message}`);
  }

  return null;
}

async function testOutboundSend(contactId, auth) {
  console.log(`\n🧪 Testing outbound send with contact_id: ${contactId}`);
  
  // Test Instagram-specific endpoint
  console.log('  📱 Testing Instagram endpoint...');
  try {
    const payload = {
      chat_id: contactId,
      contact_id: contactId,
      text: 'Test message from contact ID fix script'
    };
    
    const r = await fetch(`${auth.base}/instagram/chats/messages`, {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${auth.token}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify(payload)
    });
    
    const text = await r.text().catch(() => '');
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    
    if (r.ok && json && json.success !== false) {
      console.log('    ✅ Instagram send successful!');
      return true;
    } else {
      console.log(`    ❌ Instagram send failed (${r.status}):`, json || text);
    }
  } catch (e) {
    console.log(`    ❌ Instagram send error: ${e.message}`);
  }

  // Test Chatbots endpoint as fallback
  console.log('  🤖 Testing Chatbots endpoint...');
  try {
    const botId = process.env.SENDPULSE_BOT_ID_INSTAGRAM || process.env.SENDPULSE_BOT_ID_FACEBOOK;
    if (!botId) {
      console.log('    ❌ No bot ID configured');
      return false;
    }
    
    const payload = {
      bot_id: botId,
      chat_id: contactId,
      contact_id: contactId,
      message: { type: 'text', text: 'Test message from contact ID fix script' }
    };
    
    const r = await fetch(`${auth.base}/chatbots/messages/send`, {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${auth.token}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify(payload)
    });
    
    const text = await r.text().catch(() => '');
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    
    if (r.ok && json && json.success !== false) {
      console.log('    ✅ Chatbots send successful!');
      return true;
    } else {
      console.log(`    ❌ Chatbots send failed (${r.status}):`, json || text);
    }
  } catch (e) {
    console.log(`    ❌ Chatbots send error: ${e.message}`);
  }

  return false;
}

(async function main() {
  console.log('🚀 SendPulse Contact ID Fix Script');
  console.log('=====================================');
  
  const base = sanitizeBase(process.env.SENDPULSE_API_BASE || 'https://api.sendpulse.com');
  const bases = Array.from(new Set([base, 'https://api.eu.sendpulse.com', 'https://api.sendpulse.com']));
  
  try {
    // Get authentication
    console.log('\n🔐 Getting SendPulse token...');
    const auth = await getSendpulseToken(bases);
    console.log(`✅ Authenticated with ${auth.base}`);
    
    // Test with the problematic chat_id from your database
    const problematicChatId = '68ab4050ac7632ce7d0d0250';
    
    // Try to find the correct contact_id
    const contactInfo = await findContactByChatId(problematicChatId, auth);
    
    if (contactInfo) {
      console.log(`\n🎉 SUCCESS: Found contact_id: ${contactInfo.contactId}`);
      console.log(`   Method: ${contactInfo.method}`);
      
      // Test if we can actually send with this contact_id
      const canSend = await testOutboundSend(contactInfo.contactId, auth);
      
      if (canSend) {
        console.log('\n✅ SOLUTION: Update your database with this contact_id');
        console.log(`   Old chat_id: ${problematicChatId}`);
        console.log(`   New contact_id: ${contactInfo.contactId}`);
        console.log('\n   SQL to fix:');
        console.log(`   UPDATE conversations SET customer_contact_id = '${contactInfo.contactId}' WHERE customer_external_id = '${problematicChatId}';`);
      } else {
        console.log('\n⚠️  WARNING: Found contact_id but outbound send still fails');
        console.log('   This suggests a deeper SendPulse configuration issue');
      }
    } else {
      console.log('\n❌ FAILED: Could not find any contact_id for this chat_id');
      console.log('\n🔧 TROUBLESHOOTING STEPS:');
      console.log('   1. Check if the chat_id is from a recent conversation (within 24h)');
      console.log('   2. Verify your SendPulse bot is properly configured');
      console.log('   3. Check if you\'re using the correct SendPulse region');
      console.log('   4. Ensure the contact actually exists in SendPulse');
      console.log('\n   💡 TIP: Try sending a new message from the customer to refresh the contact');
    }
    
  } catch (e) {
    console.log(`\n❌ ERROR: ${e.message}`);
  }
})();
