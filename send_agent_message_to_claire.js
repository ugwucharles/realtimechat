/*
  Send Agent Message to Claire via Dashboard System
  This script simulates an agent sending a message through the proper conversation system
*/

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '.env'), override: true }); } catch {}
try { require('dotenv').config({ path: path.join(__dirname, '.env.local'), override: true }); } catch {}

const { Pool } = require('pg');

// Database connection
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'chatapp',
  password: process.env.PGPASSWORD || 'chatpass',
  database: process.env.PGDATABASE || 'chatapp'
});

async function findClaireConversation() {
  console.log('🔍 Looking for Claire\'s conversation...');
  
  try {
    // Find Instagram channel
    const channelQuery = await pool.query("SELECT id FROM channels WHERE name = 'instagram' LIMIT 1");
    if (!channelQuery.rowCount) {
      console.log('❌ Instagram channel not found');
      return null;
    }
    const channelId = channelQuery.rows[0].id;
    
    // Find Claire's conversation with her contact ID
    const claireChatId = 'thecl_aireee'; // Claire's Instagram username
    const claireContactId = '68ab4050ac7632ce7d0d0250'; // Claire's contact ID
    
    // Try to find by external_id first (Instagram username)
    let conv = await pool.query(`
      SELECT id, customer_name, customer_external_id, customer_contact_id, status, assigned_agent_id
      FROM conversations 
      WHERE channel_id = $1 AND customer_external_id = $2 
      ORDER BY created_at DESC LIMIT 1
    `, [channelId, claireChatId]);
    
    if (!conv.rowCount) {
      // Try by contact_id
      conv = await pool.query(`
        SELECT id, customer_name, customer_external_id, customer_contact_id, status, assigned_agent_id
        FROM conversations 
        WHERE channel_id = $1 AND customer_contact_id = $2 
        ORDER BY created_at DESC LIMIT 1
      `, [channelId, claireContactId]);
    }
    
    if (conv.rowCount) {
      console.log('✅ Found Claire\'s conversation:', {
        id: conv.rows[0].id,
        name: conv.rows[0].customer_name,
        external_id: conv.rows[0].customer_external_id,
        contact_id: conv.rows[0].customer_contact_id,
        status: conv.rows[0].status
      });
      return conv.rows[0];
    } else {
      console.log('❌ No conversation found for Claire');
      return null;
    }
  } catch (error) {
    console.log('❌ Database error:', error.message);
    return null;
  }
}

async function createOrGetAgent() {
  console.log('🤖 Setting up test agent...');
  
  try {
    const agentName = 'Test Agent';
    const { rows } = await pool.query(`
      INSERT INTO agents (name, online, socket_id)
      VALUES ($1, TRUE, $2)
      ON CONFLICT (name)
      DO UPDATE SET online = TRUE, socket_id = EXCLUDED.socket_id
      RETURNING id, name, online
    `, [agentName, 'test-socket-id']);
    
    const agent = rows[0];
    console.log('✅ Agent ready:', { id: agent.id, name: agent.name });
    return agent;
  } catch (error) {
    console.log('❌ Agent setup error:', error.message);
    return null;
  }
}

async function sendMessageThroughSystem(conversationId, agentId, messageText) {
  console.log(`📤 Sending message through system to conversation ${conversationId}...`);
  
  try {
    // 1. Insert the message into the database (like the socket handler does)
    const insertSQL = `
      INSERT INTO messages (username, content, conversation_id, sender)
      VALUES ($1, $2, $3, 'agent')
      RETURNING id, username, content, created_at, sender, conversation_id`;
    
    const { rows } = await pool.query(insertSQL, ['Test Agent', messageText, conversationId]);
    const saved = rows[0];
    
    // 2. Update conversation activity
    await pool.query(`
      UPDATE conversations
      SET last_activity_at = NOW(), last_sender = 'agent'
      WHERE id = $1`,
      [conversationId]
    );
    
    console.log('✅ Message saved to database:', {
      id: saved.id,
      content: saved.content.substring(0, 50) + '...',
      sender: saved.sender,
      created_at: saved.created_at
    });
    
    // 3. Now trigger the outbound sending logic (like in the socket handler)
    const q = await pool.query(`
      SELECT conv.customer_external_id, conv.customer_contact_id, ch.name AS channel_name
      FROM conversations conv LEFT JOIN channels ch ON ch.id = conv.channel_id
      WHERE conv.id = $1`,
      [conversationId]
    );
    
    if (q.rowCount) {
      const { customer_external_id: extId, customer_contact_id: contactId, channel_name } = q.rows[0];
      
      console.log('🎯 Triggering outbound send:', {
        channel: channel_name,
        external_id: extId,
        contact_id: contactId,
        message: messageText.substring(0, 30) + '...'
      });
      
      if (channel_name === 'instagram' && contactId) {
        // This should trigger your SendPulse integration
        const success = await sendPulseMessage(contactId, messageText);
        console.log('📱 SendPulse result:', success ? 'SUCCESS' : 'FAILED');
        return { success, messageId: saved.id };
      } else {
        console.log('⚠️ No contact_id available for SendPulse');
        return { success: false, error: 'No contact_id for SendPulse', messageId: saved.id };
      }
    } else {
      console.log('❌ Could not find conversation details');
      return { success: false, error: 'Conversation not found', messageId: saved.id };
    }
  } catch (error) {
    console.log('❌ Send error:', error.message);
    return { success: false, error: error.message };
  }
}

// SendPulse function (copied from your server.js)
async function sendPulseMessage(contactId, text) {
  try {
    if (!contactId || !text) return false;
    const token = await getSendPulseToken();
    if (!token) return false;

    console.log('   - Trying SendPulse Instagram API with contact_id:', contactId);
    
    // Use direct message API (the working method from our tests)
    const directUrl = 'https://api.sendpulse.com/instagram/chats/messages';
    const directPayload = {
      chat_id: String(contactId),
      contact_id: String(contactId),
      text: String(text)
    };

    const directResponse = await fetch(directUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(directPayload)
    });
    
    if (!directResponse.ok) {
      const t = await directResponse.text().catch(() => '');
      console.warn('   ❌ SendPulse direct send failed', directResponse.status, t);
      return false;
    }
    
    console.log('   ✅ SendPulse message sent to Instagram');
    return true;
  } catch (e) {
    console.error('SendPulse send error', e.message);
    return false;
  }
}

async function getSendPulseToken() {
  const clientId = process.env.SENDPULSE_CLIENT_ID;
  const clientSecret = process.env.SENDPULSE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  
  try {
    const form = new URLSearchParams();
    form.set('grant_type', 'client_credentials');
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
    
    const r = await fetch('https://api.sendpulse.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    
    const json = await r.json();
    return r.ok ? json.access_token : null;
  } catch (e) {
    console.error('SendPulse token error', e.message);
    return null;
  }
}

async function main() {
  console.log('🚀 Testing Agent Message to Claire via Dashboard System');
  console.log('====================================================');
  
  try {
    // 1. Find Claire's conversation
    const conversation = await findClaireConversation();
    if (!conversation) {
      console.log('❌ Cannot proceed without Claire\'s conversation');
      return;
    }
    
    // 2. Create/get agent
    const agent = await createOrGetAgent();
    if (!agent) {
      console.log('❌ Cannot proceed without agent');
      return;
    }
    
    // 3. Send message through the proper system
    const testMessage = `Hi Claire! This is a test message from the agent dashboard to verify Instagram outbound messaging is working. Sent at ${new Date().toLocaleString()}`;
    
    console.log(`\n📝 Sending message: "${testMessage}"`);
    const result = await sendMessageThroughSystem(conversation.id, agent.id, testMessage);
    
    console.log('\n🎯 FINAL RESULT:', result.success ? 'SUCCESS' : 'FAILED');
    if (result.success) {
      console.log('✅ Message sent through agent dashboard system!');
      console.log('✅ Message should now appear in your dashboard');
      console.log('✅ Message should be delivered to Claire via SendPulse');
    } else {
      console.log('❌ Message failed:', result.error);
    }
    
    console.log('\n📱 NEXT STEPS:');
    console.log('1. Check your agent dashboard - the message should appear there');
    console.log('2. Check Claire\'s Instagram DM for the actual message');
    console.log('3. Check your server logs for outbound processing details');
    
  } catch (error) {
    console.log('❌ Script error:', error.message);
  } finally {
    await pool.end();
  }
}

main();
