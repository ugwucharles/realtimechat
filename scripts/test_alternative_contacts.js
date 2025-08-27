/*
  Test Alternative Instagram Contacts
  This script tests sending messages to different Instagram contacts to isolate the issue

  Usage:
    node scripts/test_alternative_contacts.js
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

async function testContactMessage(token, contactId, contactName) {
  console.log(`\n🧪 Testing Contact: ${contactName} (ID: ${contactId})`);
  
  const testMessage = `Test message to ${contactName} - ${new Date().toISOString()}`;
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
    
    console.log(`   API Response: ${r.status}`);
    console.log(`   Response Body: ${responseText.substring(0, 300)}...`);
    
    if (r.ok && json && json.success !== false) {
      console.log(`   ✅ API reports SUCCESS`);
      console.log(`   Message ID: ${json.data?.[0]?.id || 'Unknown'}`);
      
      // Wait and check if message is retrievable
      console.log(`   ⏳ Waiting 3 seconds to check message retrieval...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      if (json.data?.[0]?.id) {
        const checkR = await fetch(`https://api.sendpulse.com/instagram/chats/messages/${json.data[0].id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (checkR.ok) {
          console.log(`   ✅ Message is retrievable from API`);
        } else {
          console.log(`   ❌ Message not retrievable (${checkR.status})`);
        }
      }
      
      return { success: true, messageId: json.data?.[0]?.id };
    } else {
      console.log(`   ❌ API reports failure`);
      return { success: false, error: responseText };
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function checkContactValidity(token, contactId) {
  console.log(`   🔍 Checking contact validity...`);
  
  try {
    // Try to get contact details
    const contactR = await fetch(`https://api.sendpulse.com/instagram/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    if (contactR.ok) {
      console.log(`   ✅ Contact details retrievable`);
      return true;
    } else {
      console.log(`   ❌ Contact details not retrievable (${contactR.status})`);
      return false;
    }
  } catch (e) {
    console.log(`   ❌ Error checking contact: ${e.message}`);
    return false;
  }
}

async function checkChatHistory(token, contactId) {
  console.log(`   🔍 Checking chat history...`);
  
  try {
    const r = await fetch(`https://api.sendpulse.com/instagram/chats?contact_id=${contactId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    if (r.ok) {
      const responseText = await r.text();
      let json = null; try { json = JSON.parse(responseText); } catch {}
      
      if (json && json.data && json.data.length > 0) {
        console.log(`   ✅ Chat history found (${json.data.length} messages)`);
        return true;
      } else {
        console.log(`   ❌ No chat history found`);
        return false;
      }
    } else {
      console.log(`   ❌ Chat history not retrievable (${r.status})`);
      return false;
    }
  } catch (e) {
    console.log(`   ❌ Error checking chat history: ${e.message}`);
    return false;
  }
}

(async function main() {
  console.log('🧪 Test Alternative Instagram Contacts');
  console.log('=====================================');
  
  try {
    const token = await getToken();
    console.log('✅ Got authentication token');
    
    // Test contacts from the previous script
    const contacts = [
      { id: '68ab4050ac7632ce7d0d0250', name: 'C.l.A.I.R.E💗💕 (thecl_aireee)' },
      { id: '68ac2a01a18372d6cd0b2638', name: 'Favour-Moses (king_blark_k)' },
      { id: '68abd0c4ac01a93a6d03b589', name: 'Contact 3' },
      { id: '68abca37a18372d6cd0b1bf9', name: 'Contact 4' }
    ];
    
    console.log(`\n📋 Testing ${contacts.length} contacts...`);
    
    const results = [];
    
    for (const contact of contacts) {
      console.log(`\n${'='.repeat(60)}`);
      
      // Check contact validity first
      const isValid = await checkContactValidity(token, contact.id);
      
      // Check chat history
      const hasHistory = await checkChatHistory(token, contact.id);
      
      // Test sending message
      const sendResult = await testContactMessage(token, contact.id, contact.name);
      
      results.push({
        contactId: contact.id,
        name: contact.name,
        isValid: isValid,
        hasHistory: hasHistory,
        sendSuccess: sendResult.success,
        messageId: sendResult.messageId,
        error: sendResult.error
      });
      
      // Wait between contacts to avoid rate limiting
      if (contact !== contacts[contacts.length - 1]) {
        console.log(`   ⏳ Waiting 2 seconds before next contact...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    console.log(`\n${'='.repeat(60)}`);
    console.log('📊 TEST RESULTS SUMMARY');
    console.log('========================');
    
    results.forEach((result, index) => {
      console.log(`\n${index + 1}. ${result.name}`);
      console.log(`   Contact ID: ${result.contactId}`);
      console.log(`   Valid Contact: ${result.isValid ? '✅' : '❌'}`);
      console.log(`   Has Chat History: ${result.hasHistory ? '✅' : '❌'}`);
      console.log(`   Message Sent: ${result.sendSuccess ? '✅' : '❌'}`);
      if (result.sendSuccess) {
        console.log(`   Message ID: ${result.messageId}`);
      } else {
        console.log(`   Error: ${result.error}`);
      }
    });
    
    const workingContacts = results.filter(r => r.sendSuccess);
    const failingContacts = results.filter(r => !r.sendSuccess);
    
    console.log(`\n🎯 ANALYSIS:`);
    console.log(`   Working Contacts: ${workingContacts.length}`);
    console.log(`   Failing Contacts: ${failingContacts.length}`);
    
    if (workingContacts.length > 0) {
      console.log(`\n✅ WORKING CONTACTS:`);
      workingContacts.forEach(contact => {
        console.log(`   - ${contact.name} (${contact.contactId})`);
      });
      
      console.log(`\n💡 RECOMMENDATION:`);
      console.log(`   Use one of the working contact IDs above`);
      console.log(`   The issue was with the specific contact, not the API`);
    } else {
      console.log(`\n❌ ALL CONTACTS FAILED`);
      console.log(`   This suggests a broader issue with your SendPulse setup`);
      console.log(`   Check your Instagram bot connection and permissions`);
    }
    
  } catch (e) {
    console.log(`❌ ERROR: ${e.message}`);
  }
})();
