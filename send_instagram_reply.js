#!/usr/bin/env node
/**
 * Simple command-line tool to send manual Instagram replies
 * Usage: node send_instagram_reply.js "Your message here"
 * 
 * This bypasses browser issues and sends messages directly through your system
 */

require('dotenv').config();
const { Pool } = require('pg');

// Database connection (same as server.js)
const DB_URL = process.env.DATABASE_URL || '';
const PGSSLMODE = (process.env.PGSSLMODE || 'disable').toLowerCase();
const ssl = PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined;

const pool = DB_URL
  ? new Pool({ connectionString: DB_URL, ssl })
  : new Pool({
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      user: process.env.PGUSER || 'chatapp',
      password: process.env.PGPASSWORD || 'chatpass',
      database: process.env.PGDATABASE || 'chatapp',
      ...(ssl ? { ssl } : {})
    });

// SendPulse API helper
async function getSendPulseToken() {
  const clientId = process.env.SENDPULSE_CLIENT_ID || process.env.SENDPULSE_API_USER_ID;
  const clientSecret = process.env.SENDPULSE_CLIENT_SECRET || process.env.SENDPULSE_API_SECRET;
  if (!clientId || !clientSecret) return null;
  try {
    const url = 'https://api.sendpulse.com/oauth/access_token';
    const form = new URLSearchParams();
    form.set('grant_type', 'client_credentials');
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
    const r = await fetch(url, {
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

// Send message via SendPulse
async function sendPulseMessage(contactId, text) {
  try {
    if (!contactId || !text) return false;
    const token = await getSendPulseToken();
    if (!token) return false;

    // Try direct message API (which has been working)
    console.log('📤 Sending via SendPulse Instagram API...');
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
      console.error('❌ SendPulse send failed:', directResponse.status, t);
      return false;
    }
    
    console.log('✅ SendPulse message sent successfully');
    return true;
  } catch (e) {
    console.error('❌ SendPulse error:', e.message);
    return false;
  }
}

async function listInstagramConversations() {
  try {
    const { rows } = await pool.query(`
      SELECT conv.id, conv.customer_name, conv.customer_contact_id, 
             conv.last_activity_at, conv.last_sender,
             (SELECT content FROM messages WHERE conversation_id = conv.id 
              ORDER BY created_at DESC LIMIT 1) as last_message
      FROM conversations conv
      LEFT JOIN channels ch ON ch.id = conv.channel_id
      WHERE ch.name = 'instagram' AND conv.status = 'open'
      ORDER BY conv.last_activity_at DESC
      LIMIT 20
    `);
    
    if (!rows.length) {
      console.log('📭 No open Instagram conversations found');
      return [];
    }
    
    console.log('\n📱 Open Instagram Conversations:');
    console.log('═'.repeat(80));
    
    rows.forEach((conv, index) => {
      const lastMsg = conv.last_message ? 
        (conv.last_message.length > 50 ? conv.last_message.slice(0, 50) + '...' : conv.last_message)
        : 'No messages';
      const time = new Date(conv.last_activity_at).toLocaleString();
      
      console.log(`${index + 1}. ID: ${conv.id} | ${conv.customer_name || 'Instagram User'}`);
      console.log(`   Contact ID: ${conv.customer_contact_id || 'N/A'}`);
      console.log(`   Last: ${time} (${conv.last_sender || 'unknown'})`);
      console.log(`   Message: "${lastMsg}"`);
      console.log();
    });
    
    return rows;
  } catch (error) {
    console.error('❌ Database error:', error.message);
    return [];
  }
}

async function sendManualReply(conversationId, message) {
  try {
    const convId = parseInt(conversationId, 10);
    if (isNaN(convId)) {
      console.error('❌ Invalid conversation ID');
      return false;
    }
    
    const content = String(message).slice(0, 2000).trim();
    if (!content) {
      console.error('❌ Empty message');
      return false;
    }
    
    // Get conversation details
    const convQuery = await pool.query(`
      SELECT conv.customer_contact_id, conv.customer_name, ch.name as channel_name
      FROM conversations conv 
      LEFT JOIN channels ch ON ch.id = conv.channel_id
      WHERE conv.id = $1
    `, [convId]);
    
    if (!convQuery.rowCount) {
      console.error('❌ Conversation not found');
      return false;
    }
    
    const conv = convQuery.rows[0];
    const contactId = conv.customer_contact_id;
    
    console.log(`📝 Sending to: ${conv.customer_name || 'Instagram User'}`);
    console.log(`💬 Message: "${content}"`);
    
    // Save to database
    const { rows } = await pool.query(`
      INSERT INTO messages (username, content, conversation_id, sender)
      VALUES ($1, $2, $3, $4)
      RETURNING id, created_at
    `, ['Manual Agent', content, convId, 'agent']);
    
    const saved = rows[0];
    console.log(`💾 Saved to database (ID: ${saved.id})`);
    
    // Update conversation activity
    await pool.query(`
      UPDATE conversations 
      SET last_activity_at = NOW(), last_sender = 'agent'
      WHERE id = $1
    `, [convId]);
    
    // Try to send via Instagram if we have contact ID
    let sent = false;
    if (contactId && conv.channel_name === 'instagram') {
      sent = await sendPulseMessage(contactId, content);
    } else {
      console.log('⚠️  No contact ID available for outbound delivery');
    }
    
    console.log('\n🎯 Result:');
    console.log(`   Database: ✅ Saved`);
    console.log(`   Instagram: ${sent ? '✅ Sent' : '❌ Failed/Limited'}`);
    
    return true;
  } catch (error) {
    console.error('❌ Error sending reply:', error.message);
    return false;
  }
}

async function main() {
  try {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
      // List conversations
      console.log('🔍 Instagram Manual Reply Tool');
      await listInstagramConversations();
      console.log('💡 Usage: node send_instagram_reply.js <conversation_id> "Your message"');
      console.log('💡 Example: node send_instagram_reply.js 123 "Hi! Thanks for your message."');
      return;
    }
    
    if (args.length < 2) {
      console.error('❌ Usage: node send_instagram_reply.js <conversation_id> "Your message"');
      process.exit(1);
    }
    
    const conversationId = args[0];
    const message = args.slice(1).join(' ').replace(/^["']|["']$/g, ''); // Remove quotes
    
    console.log('🚀 Sending manual Instagram reply...\n');
    const success = await sendManualReply(conversationId, message);
    
    if (success) {
      console.log('\n🎉 Reply sent successfully!');
    } else {
      console.log('\n💥 Failed to send reply');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('💥 Fatal error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', async () => {
  console.log('\n👋 Goodbye!');
  await pool.end();
  process.exit(0);
});

main().catch(console.error);
