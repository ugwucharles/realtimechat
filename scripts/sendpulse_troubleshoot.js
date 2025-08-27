/*
  Comprehensive SendPulse Troubleshooting Script
  This script helps identify all configuration and API issues
  
  Usage:
    node scripts/sendpulse_troubleshoot.js
*/

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true }); } catch {}
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true }); } catch {}

function sanitizeBase(b) { return String(b || '').trim().replace(/\/+$/, ''); }

async function getSendpulseToken(baseCandidates) {
  const clientId = process.env.SENDPULSE_CLIENT_ID;
  const clientSecret = process.env.SENDPULSE_CLIENT_SECRET;
  
  console.log(`\n🔐 Authentication Details:`);
  console.log(`   Client ID: ${clientId ? clientId.substring(0, 8) + '...' : 'MISSING'}`);
  console.log(`   Client Secret: ${clientSecret ? '***SET***' : 'MISSING'}`);
  
  if (!clientId || !clientSecret) throw new Error('Missing SENDPULSE_CLIENT_ID/SECRET');
  
  const form = new URLSearchParams();
  form.set('grant_type', 'client_credentials');
  form.set('client_id', clientId);
  form.set('client_secret', clientSecret);
  
  for (const base of baseCandidates) {
    try {
      console.log(`\n   🔑 Trying ${base}...`);
      const r = await fetch(`${base}/oauth/access_token`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, 
        body: form.toString() 
      });
      
      const text = await r.text().catch(() => '');
      let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
      
      console.log(`     Status: ${r.status}`);
      if (j) console.log(`     Response: ${JSON.stringify(j, null, 2)}`);
      
      if (r.ok && j.access_token) {
        console.log(`     ✅ SUCCESS: Got token from ${base}`);
        return { token: j.access_token, base, expires_in: j.expires_in };
      } else {
        console.log(`     ❌ Failed: ${r.status} - ${text}`);
      }
    } catch (e) {
      console.log(`     ❌ Error: ${e.message}`);
    }
  }
  throw new Error('Failed to obtain SendPulse token from any base');
}

async function testApiEndpoints(token, base) {
  console.log(`\n🧪 Testing API endpoints with ${base}...`);
  
  const endpoints = [
    { name: 'Instagram Chats', url: `${base}/instagram/chats`, method: 'GET' },
    { name: 'Instagram Contacts', url: `${base}/instagram/contacts`, method: 'GET' },
    { name: 'Chatbots Contacts', url: `${base}/chatbots/contacts`, method: 'GET' },
    { name: 'Chatbots Bots', url: `${base}/chatbots/bots`, method: 'GET' },
    { name: 'Instagram Bots', url: `${base}/instagram/bots`, method: 'GET' },
    { name: 'Account Info', url: `${base}/account`, method: 'GET' }
  ];
  
  const results = [];
  
  for (const endpoint of endpoints) {
    try {
      console.log(`\n   📡 ${endpoint.name}:`);
      const r = await fetch(endpoint.url, { 
        method: endpoint.method,
        headers: { Authorization: `Bearer ${token}` }
      });
      
      const text = await r.text().catch(() => '');
      let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
      
      console.log(`     Status: ${r.status}`);
      if (json && Object.keys(json).length > 0) {
        console.log(`     Response keys: ${Object.keys(json).join(', ')}`);
        if (json.data && Array.isArray(json.data)) {
          console.log(`     Data count: ${json.data.length}`);
        }
      } else if (text) {
        console.log(`     Response: ${text.substring(0, 200)}...`);
      }
      
      results.push({
        name: endpoint.name,
        url: endpoint.url,
        status: r.status,
        ok: r.ok,
        data: json || text
      });
      
    } catch (e) {
      console.log(`     ❌ Error: ${e.message}`);
      results.push({
        name: endpoint.name,
        url: endpoint.url,
        status: 'ERROR',
        ok: false,
        error: e.message
      });
    }
  }
  
  return results;
}

async function checkBotConfiguration(token, base) {
  console.log(`\n🤖 Checking bot configuration...`);
  
  const botIdIG = process.env.SENDPULSE_BOT_ID_INSTAGRAM;
  const botIdFB = process.env.SENDPULSE_BOT_ID_FACEBOOK;
  
  console.log(`   Instagram Bot ID: ${botIdIG || 'NOT SET'}`);
  console.log(`   Facebook Bot ID: ${botIdFB || 'NOT SET'}`);
  
  if (!botIdIG && !botIdFB) {
    console.log('   ❌ No bot IDs configured - this will prevent outbound messaging');
    return false;
  }
  
  // Try to get bot details
  if (botIdIG) {
    try {
      console.log(`\n   📱 Checking Instagram bot ${botIdIG}...`);
      const r = await fetch(`${base}/instagram/bots/${botIdIG}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      const text = await r.text().catch(() => '');
      let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
      
      console.log(`     Status: ${r.status}`);
      if (json && json.data) {
        console.log(`     Bot name: ${json.data.name || 'Unknown'}`);
        console.log(`     Status: ${json.data.status || 'Unknown'}`);
        console.log(`     Platform: ${json.data.platform || 'Unknown'}`);
      } else {
        console.log(`     Response: ${text}`);
      }
    } catch (e) {
      console.log(`     ❌ Error: ${e.message}`);
    }
  }
  
  if (botIdFB) {
    try {
      console.log(`\n   📘 Checking Facebook bot ${botIdFB}...`);
      const r = await fetch(`${base}/chatbots/bots/${botIdFB}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      const text = await r.text().catch(() => '');
      let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
      
      console.log(`     Status: ${r.status}`);
      if (json && json.data) {
        console.log(`     Bot name: ${json.data.name || 'Unknown'}`);
        console.log(`     Status: ${json.data.status || 'Unknown'}`);
        console.log(`     Platform: ${json.data.platform || 'Unknown'}`);
      } else {
        console.log(`     Response: ${text}`);
      }
    } catch (e) {
      console.log(`     ❌ Error: ${e.message}`);
    }
  }
  
  return true;
}

async function testWebhookConfiguration() {
  console.log(`\n🔗 Checking webhook configuration...`);
  
  const webhookKey = process.env.SENDPULSE_WEBHOOK_KEY;
  const webhookStrict = process.env.SENDPULSE_WEBHOOK_STRICT;
  
  console.log(`   Webhook Key: ${webhookKey ? '***SET***' : 'NOT SET'}`);
  console.log(`   Webhook Strict: ${webhookStrict || 'false'}`);
  
  if (!webhookKey) {
    console.log('   ⚠️  No webhook key set - inbound webhooks may not work properly');
  }
  
  // Check if webhook endpoint is accessible
  try {
    const webhookUrl = 'http://localhost:3000/webhooks/sendpulse';
    console.log(`\n   📡 Testing webhook endpoint: ${webhookUrl}`);
    
    const r = await fetch(webhookUrl, { method: 'POST', body: 'test' });
    console.log(`     Status: ${r.status}`);
    
    if (r.status === 400 || r.status === 401) {
      console.log('     ✅ Webhook endpoint is accessible (expected auth error)');
    } else if (r.status === 404) {
      console.log('     ❌ Webhook endpoint not found - check server configuration');
    } else {
      console.log(`     ⚠️  Unexpected status: ${r.status}`);
    }
  } catch (e) {
    console.log(`     ❌ Cannot reach webhook endpoint: ${e.message}`);
    console.log('     💡 Make sure your server is running on port 3000');
  }
}

async function checkEnvironmentVariables() {
  console.log(`\n⚙️  Environment Variables Check:`);
  
  const required = [
    'SENDPULSE_CLIENT_ID',
    'SENDPULSE_CLIENT_SECRET',
    'SENDPULSE_BOT_ID_INSTAGRAM',
    'SENDPULSE_BOT_ID_FACEBOOK',
    'SENDPULSE_WEBHOOK_KEY'
  ];
  
  const optional = [
    'SENDPULSE_API_BASE',
    'SENDPULSE_WEBHOOK_STRICT',
    'DEBUG_SP_SEND'
  ];
  
  console.log('\n   🔴 Required variables:');
  for (const varName of required) {
    const value = process.env[varName];
    if (value) {
      console.log(`     ✅ ${varName}: ${varName.includes('SECRET') || varName.includes('KEY') ? '***SET***' : value.substring(0, 20) + '...'}`);
    } else {
      console.log(`     ❌ ${varName}: NOT SET`);
    }
  }
  
  console.log('\n   🟡 Optional variables:');
  for (const varName of optional) {
    const value = process.env[varName];
    if (value) {
      console.log(`     ✅ ${varName}: ${value}`);
    } else {
      console.log(`     ⚪ ${varName}: not set (using default)`);
    }
  }
}

async function generateRecommendations(results, hasValidToken) {
  console.log(`\n🎯 TROUBLESHOOTING RECOMMENDATIONS:`);
  console.log(`=====================================`);
  
  if (!hasValidToken) {
    console.log('\n🔴 CRITICAL: Cannot authenticate with SendPulse');
    console.log('   1. Verify your SENDPULSE_CLIENT_ID and SENDPULSE_CLIENT_SECRET');
    console.log('   2. Check if your SendPulse account is active');
    console.log('   3. Verify you\'re using the correct API region');
    console.log('   4. Check if your API credentials have expired');
    return;
  }
  
  const workingEndpoints = results.filter(r => r.ok);
  const failingEndpoints = results.filter(r => !r.ok);
  
  if (workingEndpoints.length === 0) {
    console.log('\n🔴 CRITICAL: No API endpoints are working');
    console.log('   1. Your SendPulse account may not have the required permissions');
    console.log('   2. You may need to upgrade your SendPulse plan');
    console.log('   3. Contact SendPulse support to verify your account setup');
    return;
  }
  
  if (failingEndpoints.length > 0) {
    console.log('\n🟡 WARNING: Some API endpoints are failing');
    for (const endpoint of failingEndpoints) {
      console.log(`   - ${endpoint.name}: ${endpoint.status} - ${endpoint.error || 'Unknown error'}`);
    }
    console.log('\n   This may indicate:');
    console.log('   1. Missing permissions for specific features');
    console.log('   2. Incorrect bot configuration');
    console.log('   3. Account limitations');
  }
  
  console.log('\n✅ WORKING ENDPOINTS:');
  for (const endpoint of workingEndpoints) {
    console.log(`   - ${endpoint.name}: ${endpoint.url}`);
  }
  
  console.log('\n🔧 NEXT STEPS:');
  console.log('   1. Use working endpoints to find valid contacts');
  console.log('   2. Update your database with correct contact IDs');
  console.log('   3. Test outbound messaging with valid contacts');
  console.log('   4. Ensure new conversations store correct IDs from webhooks');
}

(async function main() {
  console.log('🚀 SendPulse Comprehensive Troubleshooting');
  console.log('==========================================');
  
  const base = sanitizeBase(process.env.SENDPULSE_API_BASE || 'https://api.sendpulse.com');
  const bases = Array.from(new Set([base, 'https://api.eu.sendpulse.com', 'https://api.sendpulse.com']));
  
  try {
    // Check environment variables first
    await checkEnvironmentVariables();
    
    // Check webhook configuration
    await testWebhookConfiguration();
    
    // Try to get authentication token
    let auth = null;
    try {
      auth = await getSendpulseToken(bases);
    } catch (e) {
      console.log(`\n❌ AUTHENTICATION FAILED: ${e.message}`);
      await generateRecommendations([], false);
      return;
    }
    
    // Test API endpoints
    const results = await testApiEndpoints(auth.token, auth.base);
    
    // Check bot configuration
    const botsOk = await checkBotConfiguration(auth.token, auth.base);
    
    // Generate recommendations
    await generateRecommendations(results, true);
    
    console.log(`\n📊 SUMMARY:`);
    console.log(`   Authentication: ✅ (${auth.base})`);
    console.log(`   Working endpoints: ${results.filter(r => r.ok).length}/${results.length}`);
    console.log(`   Bot configuration: ${botsOk ? '✅' : '❌'}`);
    
  } catch (e) {
    console.log(`\n❌ UNEXPECTED ERROR: ${e.message}`);
    console.log('   Check your network connection and SendPulse service status');
  }
})();
