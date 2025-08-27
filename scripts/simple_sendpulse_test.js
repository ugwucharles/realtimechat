/*
  Simple SendPulse Test
  This script tests basic endpoints and shows raw responses
  
  Usage:
    node scripts/simple_sendpulse_test.js
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

async function testEndpoint(token, name, url) {
  console.log(`\n📡 Testing: ${name}`);
  console.log(`   URL: ${url}`);
  
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    const text = await r.text();
    console.log(`   Status: ${r.status}`);
    console.log(`   Response: ${text.substring(0, 500)}...`);
    
    if (r.ok) {
      try {
        const json = JSON.parse(text);
        if (json.data && Array.isArray(json.data)) {
          console.log(`   ✅ Found ${json.data.length} items`);
          if (json.data.length > 0) {
            console.log(`   First item keys: ${Object.keys(json.data[0]).join(', ')}`);
          }
        }
      } catch (e) {
        console.log(`   ⚠️  Response is not valid JSON`);
      }
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
  }
}

(async function main() {
  console.log('🚀 Simple SendPulse Test');
  console.log('=========================');
  
  try {
    const token = await getToken();
    console.log('✅ Got token');
    
    const endpoints = [
      { name: 'Instagram Bots', url: 'https://api.sendpulse.com/instagram/bots' },
      { name: 'Chatbot Bots', url: 'https://api.sendpulse.com/chatbots/bots' },
      { name: 'Instagram Chats', url: 'https://api.sendpulse.com/instagram/chats?limit=5' },
      { name: 'Chatbot Contacts', url: 'https://api.sendpulse.com/chatbots/contacts?limit=5' }
    ];
    
    for (const endpoint of endpoints) {
      await testEndpoint(token, endpoint.name, endpoint.url);
    }
    
  } catch (e) {
    console.log(`❌ Error: ${e.message}`);
  }
})();
