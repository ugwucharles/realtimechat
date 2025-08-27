require('dotenv').config();

async function getSendpulseToken() {
  try {
    const base = 'https://api.sendpulse.com';
    const response = await fetch(`${base}/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: process.env.SENDPULSE_CLIENT_ID,
        client_secret: process.env.SENDPULSE_CLIENT_SECRET,
      }),
    });

    if (!response.ok) {
      throw new Error(`Token request failed: ${response.status}`);
    }

    const data = await response.json();
    return data.access_token;
  } catch (error) {
    console.error('Error getting token:', error.message);
    return null;
  }
}

async function extractRealContactIds() {
  console.log('🔍 Extract Real Instagram Contact IDs');
  console.log('=====================================\n');

  const token = await getSendpulseToken();
  if (!token) {
    console.log('❌ Failed to get authentication token');
    return;
  }

  console.log('✅ Got authentication token\n');

  try {
    // Get Instagram chats
    const chatsResponse = await fetch('https://api.sendpulse.com/instagram/chats', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!chatsResponse.ok) {
      console.log(`❌ Failed to get Instagram chats: ${chatsResponse.status}`);
      return;
    }

    const chatsData = await chatsResponse.json();
    console.log('📱 Instagram Chats Response:');
    console.log('============================');
    
    if (chatsData.success && chatsData.data && chatsData.data.length > 0) {
      console.log(`✅ Found ${chatsData.data.length} chats\n`);
      
      chatsData.data.forEach((chat, index) => {
        console.log(`📋 Chat ${index + 1}:`);
        console.log(`   Raw data:`, JSON.stringify(chat, null, 2));
        console.log('');
        
        // Try to extract contact ID from different possible locations
        let contactId = null;
        let chatId = null;
        
        if (chat.contact_id) {
          contactId = chat.contact_id;
        } else if (chat.inbox_last_message && chat.inbox_last_message.contact_id) {
          contactId = chat.inbox_last_message.contact_id;
        } else if (chat.id) {
          chatId = chat.id;
        }
        
        if (contactId) {
          console.log(`   ✅ Contact ID: ${contactId}`);
        } else {
          console.log(`   ❌ Contact ID: Not found`);
        }
        
        if (chatId) {
          console.log(`   ✅ Chat ID: ${chatId}`);
        } else {
          console.log(`   ❌ Chat ID: Not found`);
        }
        
        console.log('');
      });
      
      // Try to get the first valid contact ID
      const firstChat = chatsData.data[0];
      let testContactId = null;
      
      if (firstChat.contact_id) {
        testContactId = firstChat.contact_id;
      } else if (firstChat.inbox_last_message && firstChat.inbox_last_message.contact_id) {
        testContactId = firstChat.inbox_last_message.contact_id;
      }
      
      if (testContactId) {
        console.log('🧪 Testing with extracted contact ID...');
        console.log(`   Contact ID: ${testContactId}`);
        
        // Test sending a message to this contact
        const testMessage = `Test message from contact extraction script - ${new Date().toISOString()}`;
        const payload = {
          chat_id: testContactId,
          contact_id: testContactId,
          text: testMessage
        };
        
        console.log(`   Payload:`, JSON.stringify(payload, null, 2));
        
        const sendResponse = await fetch('https://api.sendpulse.com/instagram/chats/messages', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        
        const sendData = await sendResponse.text();
        console.log(`   Send Status: ${sendResponse.status}`);
        console.log(`   Send Response: ${sendData.substring(0, 500)}...`);
        
        if (sendResponse.ok) {
          console.log('   ✅ Message sent successfully!');
          console.log('   📱 Check Instagram now to see if it appears');
        } else {
          console.log('   ❌ Message sending failed');
        }
      } else {
        console.log('❌ No valid contact ID found to test with');
      }
      
    } else {
      console.log('❌ No chats found or invalid response');
      console.log('Response:', JSON.stringify(chatsData, null, 2));
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

extractRealContactIds();
