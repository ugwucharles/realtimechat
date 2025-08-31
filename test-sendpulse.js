// Test script for SendPulse API integration
require('dotenv').config();

async function testSendPulseAPI() {
  console.log('🧪 Testing SendPulse API Integration...\n');
  
  // Check if credentials are configured
  const userId = process.env.SENDPULSE_API_USER_ID;
  const secret = process.env.SENDPULSE_API_SECRET;
  
  if (!userId || userId === 'your_user_id_here') {
    console.log('❌ SENDPULSE_API_USER_ID not configured in .env');
    console.log('   Please update your .env file with real SendPulse credentials');
    return;
  }
  
  if (!secret || secret === 'your_api_secret_here') {
    console.log('❌ SENDPULSE_API_SECRET not configured in .env');
    console.log('   Please update your .env file with real SendPulse credentials');
    return;
  }
  
  console.log('✅ SendPulse credentials found in .env');
  
  // Test token retrieval
  try {
    const url = 'https://api.sendpulse.com/oauth/access_token';
    const payload = {
      grant_type: 'client_credentials',
      client_id: userId,
      client_secret: secret
    };
    
    console.log('🔑 Testing SendPulse OAuth token...');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const result = await response.json();
    
    if (response.ok && result.access_token) {
      console.log('✅ SendPulse API authentication successful!');
      console.log(`   Token type: ${result.token_type}`);
      console.log(`   Expires in: ${result.expires_in} seconds`);
    } else {
      console.log('❌ SendPulse API authentication failed:');
      console.log('   Response:', JSON.stringify(result, null, 2));
    }
    
  } catch (error) {
    console.log('❌ Error testing SendPulse API:', error.message);
  }
}

// Test webhook endpoint
async function testWebhookEndpoint() {
  console.log('\n🔗 Testing webhook endpoint...');
  
  try {
    const testPayload = {
      contact: {
        id: "webhook_test_456",
        name: "Webhook Test User",
        variables: {
          instagram_id: "ig_test_789"
        }
      },
      message: {
        text: "Test message from webhook test script",
        id: "msg_test_123"
      }
    };
    
    const response = await fetch('http://localhost:3000/webhooks/sendpulse/instagram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload)
    });
    
    const result = await response.text();
    
    if (response.ok && result === 'OK') {
      console.log('✅ Webhook endpoint working correctly!');
      console.log('   Check your server console and dashboard for the new message');
    } else {
      console.log('❌ Webhook endpoint test failed:');
      console.log(`   Status: ${response.status}`);
      console.log(`   Response: ${result}`);
    }
    
  } catch (error) {
    console.log('❌ Error testing webhook:', error.message);
    console.log('   Make sure your server is running on http://localhost:3000');
  }
}

// Run tests
async function runTests() {
  await testSendPulseAPI();
  await testWebhookEndpoint();
  
  console.log('\n📋 Next steps:');
  console.log('1. Update .env with real SendPulse API credentials');
  console.log('2. Make sure webhook URL is saved in SendPulse dashboard');
  console.log('3. Test with a real Instagram message via SendPulse');
  console.log('4. Check your realtime chat dashboard for incoming messages');
}

runTests().catch(console.error);
