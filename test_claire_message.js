/*
  Test Instagram Message to Claire
  This script sends a real test message to Claire and checks delivery
*/

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '.env'), override: true }); } catch {}
try { require('dotenv').config({ path: path.join(__dirname, '.env.local'), override: true }); } catch {}

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

async function sendTestMessageToClaire() {
  console.log('🧪 Sending test message to Claire (C.l.A.I.R.E💗💕)');
  console.log('=================================================');
  
  const token = await getToken();
  console.log('✅ Got authentication token');
  
  const contactId = '68ab4050ac7632ce7d0d0250'; // Claire's contact ID
  const testMessage = `Hi Claire! This is a test message from the admin dashboard to verify our Instagram messaging is working. Sent at ${new Date().toLocaleString()}`;
  
  console.log(`\n📤 Sending message to contact: ${contactId}`);
  console.log(`📝 Message: "${testMessage}"`);
  
  // Use Method 1 (Standard Instagram API) - the working method
  const payload = {
    chat_id: contactId,
    contact_id: contactId,
    text: testMessage
  };
  
  try {
    const response = await fetch('https://api.sendpulse.com/instagram/chats/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    const responseText = await response.text();
    let jsonResponse = null;
    try { jsonResponse = JSON.parse(responseText); } catch {}
    
    console.log(`\n📊 Response Status: ${response.status}`);
    console.log(`📊 Response: ${responseText}`);
    
    if (response.ok && jsonResponse && jsonResponse.success !== false) {
      console.log('\n✅ MESSAGE SENT SUCCESSFULLY!');
      console.log(`📧 Message ID: ${jsonResponse.data?.[0]?.id || 'Unknown'}`);
      console.log('📱 Check Claire\'s Instagram DM to confirm delivery');
      
      // Additional delivery verification
      console.log('\n🔍 Delivery Status Information:');
      if (jsonResponse.data?.[0]?.status) {
        console.log(`   Status Code: ${jsonResponse.data[0].status}`);
      }
      if (jsonResponse.data?.[0]?.direction) {
        console.log(`   Direction: ${jsonResponse.data[0].direction} (1 = outbound)`);
      }
      
      console.log('\n📱 VERIFICATION STEPS:');
      console.log('   1. Check Instagram app/website for Claire\'s DM');
      console.log('   2. Look for the test message sent just now');
      console.log('   3. Message should appear from your business account');
      
      return { success: true, messageId: jsonResponse.data?.[0]?.id, response: jsonResponse };
    } else {
      console.log('\n❌ MESSAGE SEND FAILED');
      console.log(`Error: ${responseText}`);
      return { success: false, error: responseText };
    }
  } catch (error) {
    console.log('\n❌ ERROR SENDING MESSAGE');
    console.log(`Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Alternative method using the chatbot flow (if direct API fails)
async function sendViaFlowTrigger() {
  console.log('\n🔄 Trying alternative method: Flow Trigger');
  
  const token = await getToken();
  const contactId = '68ab4050ac7632ce7d0d0250';
  const testMessage = `Alternative test message via flow trigger. Sent at ${new Date().toLocaleString()}`;
  
  const payload = {
    contact_id: contactId,
    bot_id: "68ab38663bef0841770e2282",
    trigger: "start", // Using "start" trigger as it's most commonly available
    variables: {
      message: testMessage,
      text: testMessage,
      agent_message: testMessage
    }
  };
  
  try {
    const response = await fetch('https://api.sendpulse.com/messengers/flow/run', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    const responseText = await response.text();
    console.log(`📊 Flow Response Status: ${response.status}`);
    console.log(`📊 Flow Response: ${responseText}`);
    
    return response.ok;
  } catch (error) {
    console.log(`❌ Flow trigger error: ${error.message}`);
    return false;
  }
}

async function verifyRecentMessages() {
  console.log('\n🔍 Checking recent chat messages with Claire...');
  
  const token = await getToken();
  const contactId = '68ab4050ac7632ce7d0d0250';
  
  try {
    const response = await fetch(`https://api.sendpulse.com/instagram/chats/${encodeURIComponent(contactId)}/messages?limit=5`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    if (response.ok) {
      const messages = await response.json();
      console.log('✅ Recent messages retrieved:');
      
      if (messages.data && messages.data.length > 0) {
        messages.data.slice(-3).forEach((msg, idx) => {
          const time = new Date(msg.created_at).toLocaleString();
          const direction = msg.direction === 1 ? 'SENT' : 'RECEIVED';
          const text = msg.text || '[no text]';
          console.log(`   ${idx + 1}. [${time}] ${direction}: ${text.substring(0, 60)}...`);
        });
      } else {
        console.log('   No recent messages found');
      }
    } else {
      console.log(`❌ Could not retrieve messages (${response.status})`);
    }
  } catch (error) {
    console.log(`❌ Error checking messages: ${error.message}`);
  }
}

(async function main() {
  try {
    // Send the test message
    const result = await sendTestMessageToClaire();
    
    // If primary method fails, try alternative
    if (!result.success) {
      console.log('\n🔄 Primary method failed, trying flow trigger...');
      await sendViaFlowTrigger();
    }
    
    // Wait a moment, then check recent messages
    console.log('\n⏳ Waiting 3 seconds before checking recent messages...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    await verifyRecentMessages();
    
    console.log('\n🎯 TEST COMPLETE');
    console.log('================');
    console.log('✅ Message sending process completed');
    console.log('📱 Please check Claire\'s Instagram DM to confirm delivery');
    console.log('💡 If message doesn\'t appear, it may be due to Instagram\'s 24-hour rule or business messaging restrictions');
    
  } catch (error) {
    console.log(`\n❌ SCRIPT ERROR: ${error.message}`);
  }
})();
