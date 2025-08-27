/*
  Fix SendPulse Database Schema for Outbound Messaging
  This script helps update your database to use the correct SendPulse contact IDs
  
  Usage:
    node scripts/fix_sendpulse_database.js
*/

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true }); } catch {}
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true }); } catch {}

const { Pool } = require('pg');

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

async function findValidContacts(auth) {
  console.log('\n🔍 Searching for valid SendPulse contacts...');
  
  // Method 1: Try to list recent contacts
  console.log('  📱 Method 1: List recent contacts...');
  try {
    const contactsResult = await spGetJson(auth.token, `${auth.base}/chatbots/contacts?limit=100`);
    if (contactsResult.ok && contactsResult.data && Array.isArray(contactsResult.data)) {
      console.log(`    ✅ Found ${contactsResult.data.length} contacts`);
      return contactsResult.data.filter(c => c.id || c.contact_id).map(c => ({
        id: c.id || c.contact_id,
        chat_id: c.chat_id,
        name: c.name || c.username || 'Unknown',
        platform: c.platform || 'unknown',
        created_at: c.created_at
      }));
    } else {
      console.log(`    ❌ Could not fetch contacts (${contactsResult.status})`);
    }
  } catch (e) {
    console.log(`    ❌ Error: ${e.message}`);
  }

  // Method 2: Try Instagram-specific contacts
  console.log('  📱 Method 2: Instagram contacts...');
  try {
    const igResult = await spGetJson(auth.token, `${auth.base}/instagram/contacts?limit=100`);
    if (igResult.ok && igResult.data && Array.isArray(igResult.data)) {
      console.log(`    ✅ Found ${igResult.data.length} Instagram contacts`);
      return igResult.data.filter(c => c.id || c.contact_id).map(c => ({
        id: c.id || c.contact_id,
        chat_id: c.chat_id,
        name: c.username || c.name || 'Unknown',
        platform: 'instagram',
        created_at: c.created_at
      }));
    } else {
      console.log(`    ❌ Could not fetch Instagram contacts (${igResult.status})`);
    }
  } catch (e) {
    console.log(`    ❌ Error: ${e.message}`);
  }

  return [];
}

async function testContactSend(contact, auth) {
  console.log(`\n🧪 Testing contact: ${contact.name} (${contact.id})`);
  
  // Test Instagram endpoint
  try {
    const payload = {
      chat_id: contact.id,
      contact_id: contact.id,
      text: 'Test message from database fix script'
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
      return { success: true, method: 'instagram', contact };
    } else {
      console.log(`    ❌ Instagram send failed (${r.status}):`, json || text);
    }
  } catch (e) {
    console.log(`    ❌ Instagram send error: ${e.message}`);
  }

  // Test Chatbots endpoint
  try {
    const botId = process.env.SENDPULSE_BOT_ID_INSTAGRAM || process.env.SENDPULSE_BOT_ID_FACEBOOK;
    if (!botId) {
      console.log('    ❌ No bot ID configured');
      return { success: false, method: 'no_bot', contact };
    }
    
    const payload = {
      bot_id: botId,
      chat_id: contact.id,
      contact_id: contact.id,
      message: { type: 'text', text: 'Test message from database fix script' }
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
      return { success: true, method: 'chatbots', contact };
    } else {
      console.log(`    ❌ Chatbots send failed (${r.status}):`, json || text);
    }
  } catch (e) {
    console.log(`    ❌ Chatbots send error: ${e.message}`);
  }

  return { success: false, method: 'failed', contact };
}

async function updateDatabaseSchema(pool) {
  console.log('\n🗄️  Checking database schema...');
  
  try {
    // Check if customer_contact_id column exists
    const schemaCheck = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'conversations' 
      AND column_name IN ('customer_external_id', 'customer_contact_id')
      ORDER BY column_name
    `);
    
    const columns = schemaCheck.rows.map(r => r.column_name);
    console.log(`  📋 Found columns: ${columns.join(', ')}`);
    
    if (!columns.includes('customer_contact_id')) {
      console.log('  ⚠️  Missing customer_contact_id column - adding it...');
      await pool.query(`
        ALTER TABLE conversations 
        ADD COLUMN customer_contact_id VARCHAR(255)
      `);
      console.log('  ✅ Added customer_contact_id column');
    }
    
    if (!columns.includes('customer_external_id')) {
      console.log('  ⚠️  Missing customer_external_id column - adding it...');
      await pool.query(`
        ALTER TABLE conversations 
        ADD COLUMN customer_external_id VARCHAR(255)
      `);
      console.log('  ✅ Added customer_external_id column');
    }
    
    return true;
  } catch (e) {
    console.log(`  ❌ Schema update error: ${e.message}`);
    return false;
  }
}

async function findMatchingConversations(pool, validContacts) {
  console.log('\n🔍 Finding conversations that might match valid contacts...');
  
  try {
    // Get all Instagram conversations
    const conversations = await pool.query(`
      SELECT id, customer_external_id, customer_contact_id, last_activity_at, status
      FROM conversations 
      WHERE channel_id = (SELECT id FROM channels WHERE name = 'instagram' LIMIT 1)
      ORDER BY last_activity_at DESC
      LIMIT 50
    `);
    
    console.log(`  📊 Found ${conversations.rows.length} Instagram conversations`);
    
    const matches = [];
    for (const conv of conversations.rows) {
      const chatId = conv.customer_external_id;
      const contactId = conv.customer_contact_id;
      
      // Look for exact matches
      const exactMatch = validContacts.find(c => 
        c.id === chatId || c.id === contactId || 
        c.chat_id === chatId || c.chat_id === contactId
      );
      
      if (exactMatch) {
        matches.push({
          conversation: conv,
          contact: exactMatch,
          matchType: 'exact',
          needsUpdate: exactMatch.id !== contactId
        });
      } else {
        // Look for partial matches (same name, recent activity)
        const partialMatch = validContacts.find(c => 
          c.name && conv.customer_external_id && 
          c.name.toLowerCase().includes(conv.customer_external_id.toLowerCase()) ||
          conv.customer_external_id.toLowerCase().includes(c.name.toLowerCase())
        );
        
        if (partialMatch) {
          matches.push({
            conversation: conv,
            contact: partialMatch,
            matchType: 'partial',
            needsUpdate: true
          });
        }
      }
    }
    
    console.log(`  🎯 Found ${matches.length} potential matches`);
    return matches;
    
  } catch (e) {
    console.log(`  ❌ Database query error: ${e.message}`);
    return [];
  }
}

(async function main() {
  console.log('🚀 SendPulse Database Schema Fix Script');
  console.log('========================================');
  
  const base = sanitizeBase(process.env.SENDPULSE_API_BASE || 'https://api.sendpulse.com');
  const bases = Array.from(new Set([base, 'https://api.eu.sendpulse.com', 'https://api.sendpulse.com']));
  
  try {
    // Get authentication
    console.log('\n🔐 Getting SendPulse token...');
    const auth = await getSendpulseToken(bases);
    console.log(`✅ Authenticated with ${auth.base}`);
    
    // Find valid contacts
    const validContacts = await findValidContacts(auth);
    if (validContacts.length === 0) {
      console.log('\n❌ No valid contacts found in SendPulse');
      console.log('   This suggests a deeper configuration issue');
      return;
    }
    
    console.log(`\n✅ Found ${validContacts.length} valid contacts in SendPulse`);
    
    // Test a few contacts to see which ones work
    console.log('\n🧪 Testing contact send capabilities...');
    const workingContacts = [];
    for (let i = 0; i < Math.min(3, validContacts.length); i++) {
      const result = await testContactSend(validContacts[i], auth);
      if (result.success) {
        workingContacts.push(result);
      }
    }
    
    if (workingContacts.length === 0) {
      console.log('\n❌ No contacts can send messages successfully');
      console.log('   This indicates a SendPulse configuration issue');
      return;
    }
    
    console.log(`\n✅ Found ${workingContacts.length} working contacts`);
    
    // Connect to database
    console.log('\n🗄️  Connecting to database...');
    const pool = new Pool({
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT || '5432'),
      user: process.env.PGUSER || 'chatapp',
      password: process.env.PGPASSWORD || 'chatpass',
      database: process.env.PGDATABASE || 'chatapp'
    });
    
    try {
      // Update schema if needed
      const schemaOk = await updateDatabaseSchema(pool);
      if (!schemaOk) {
        console.log('\n❌ Failed to update database schema');
        return;
      }
      
      // Find matching conversations
      const matches = await findMatchingConversations(pool, validContacts);
      
      if (matches.length === 0) {
        console.log('\n⚠️  No conversations match the valid contacts');
        console.log('\n🔧 RECOMMENDATIONS:');
        console.log('   1. The chat_id in your database may be outdated');
        console.log('   2. You may need to wait for new customer messages');
        console.log('   3. Consider manually updating contact IDs based on customer names');
        return;
      }
      
      console.log('\n📝 SUMMARY OF NEEDED UPDATES:');
      for (const match of matches) {
        const conv = match.conversation;
        const contact = match.contact;
        
        console.log(`\n   Conversation ${conv.id}:`);
        console.log(`     Current external_id: ${conv.customer_external_id || 'NULL'}`);
        console.log(`     Current contact_id: ${conv.customer_contact_id || 'NULL'}`);
        console.log(`     SendPulse contact: ${contact.name} (${contact.id})`);
        console.log(`     Match type: ${match.matchType}`);
        console.log(`     Needs update: ${match.needsUpdate ? 'YES' : 'NO'}`);
        
        if (match.needsUpdate) {
          console.log(`     SQL: UPDATE conversations SET customer_contact_id = '${contact.id}' WHERE id = ${conv.id};`);
        }
      }
      
      console.log('\n🎯 NEXT STEPS:');
      console.log('   1. Update your database with the correct contact IDs above');
      console.log('   2. Test outbound messaging with the updated IDs');
      console.log('   3. Ensure new conversations store the correct contact_id from webhooks');
      
    } finally {
      await pool.end();
    }
    
  } catch (e) {
    console.log(`\n❌ ERROR: ${e.message}`);
  }
})();
