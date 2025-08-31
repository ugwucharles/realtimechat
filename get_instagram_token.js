/*
  Get Instagram Page Access Token for Manual Messaging
  This script helps you authenticate and get the required token
*/

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '.env'), override: true }); } catch {}
try { require('dotenv').config({ path: path.join(__dirname, '.env.local'), override: true }); } catch {}

const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = 3001; // Different port from main app

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';

if (!META_APP_ID || !META_APP_SECRET) {
  console.log('❌ Missing META_APP_ID or META_APP_SECRET in .env file');
  process.exit(1);
}

console.log('🚀 Instagram Token Setup Helper');
console.log('==============================');
console.log('📋 App ID:', META_APP_ID);
console.log('🔧 Graph Version:', META_GRAPH_VERSION);

// Start authentication flow
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Instagram Token Setup</title></head>
      <body style="font-family: Arial, sans-serif; margin: 40px;">
        <h1>🔧 Instagram Token Setup</h1>
        <p>To enable manual Instagram messaging, you need to link your Instagram account to Facebook.</p>
        
        <h2>📋 Requirements:</h2>
        <ul>
          <li>Instagram Business or Creator account</li>
          <li>Facebook Page connected to your Instagram</li>
          <li>Admin access to both accounts</li>
        </ul>
        
        <h2>🚀 Get Started:</h2>
        <a href="/auth/start" 
           style="background: #1877f2; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-size: 18px;">
          Connect Instagram Account
        </a>
        
        <h2>⚠️ Important Notes:</h2>
        <ul>
          <li>Your Instagram must be switched to Business/Creator account</li>
          <li>You must be admin of the connected Facebook Page</li>
          <li>This only works with Instagram accounts linked to Facebook Pages</li>
        </ul>
      </body>
    </html>
  `);
});

// Start OAuth flow
app.get('/auth/start', (req, res) => {
  const baseUrl = `http://localhost:${PORT}`;
  const redirectUri = `${baseUrl}/auth/callback`;
  
  const scopes = [
    'pages_show_list',
    'pages_read_engagement', 
    'pages_manage_metadata',
    'pages_messaging',
    'instagram_basic',
    'instagram_manage_messages'
  ].join(',');
  
  const state = crypto.randomBytes(16).toString('hex');
  
  const authUrl = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth?` +
    `client_id=${encodeURIComponent(META_APP_ID)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `state=${encodeURIComponent(state)}`;
  
  console.log('🔗 Redirecting to Facebook OAuth...');
  res.redirect(authUrl);
});

// Handle OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  
  if (error) {
    return res.send(`
      <html><body style="font-family: Arial; margin: 40px;">
        <h1>❌ Authentication Failed</h1>
        <p>Error: ${error}</p>
        <a href="/">Try Again</a>
      </body></html>
    `);
  }
  
  if (!code) {
    return res.send(`
      <html><body style="font-family: Arial; margin: 40px;">
        <h1>❌ No Code Received</h1>
        <p>The authentication process didn't return a code.</p>
        <a href="/">Try Again</a>
      </body></html>
    `);
  }
  
  try {
    console.log('📥 Received auth code, exchanging for token...');
    
    // Exchange code for access token
    const baseUrl = `http://localhost:${PORT}`;
    const redirectUri = `${baseUrl}/auth/callback`;
    
    const tokenUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token?` +
      `client_id=${META_APP_ID}&` +
      `client_secret=${META_APP_SECRET}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `code=${code}`;
    
    const tokenResponse = await fetch(tokenUrl);
    const tokenData = await tokenResponse.json();
    
    if (!tokenResponse.ok || !tokenData.access_token) {
      throw new Error('Token exchange failed: ' + JSON.stringify(tokenData));
    }
    
    console.log('✅ Got user access token');
    const userToken = tokenData.access_token;
    
    // Get user's pages with Instagram accounts
    console.log('📄 Fetching user pages...');
    const pagesUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/me/accounts?` +
      `fields=name,access_token,instagram_business_account{id,username},connected_instagram_account{id,username}&` +
      `access_token=${encodeURIComponent(userToken)}`;
    
    const pagesResponse = await fetch(pagesUrl);
    const pagesData = await pagesResponse.json();
    
    if (!pagesResponse.ok) {
      throw new Error('Pages fetch failed: ' + JSON.stringify(pagesData));
    }
    
    console.log('📊 Found pages:', pagesData.data?.length || 0);
    
    // Find pages with Instagram accounts
    const instagramPages = (pagesData.data || []).filter(page => 
      page.instagram_business_account || page.connected_instagram_account
    );
    
    if (instagramPages.length === 0) {
      return res.send(`
        <html><body style="font-family: Arial; margin: 40px;">
          <h1>⚠️ No Instagram Business Account Found</h1>
          <p>We couldn't find any Facebook Pages connected to an Instagram Business account.</p>
          
          <h2>🔧 Setup Instructions:</h2>
          <ol>
            <li>Go to your Instagram app</li>
            <li>Switch to Professional account (Business or Creator)</li>
            <li>In Settings → Account → Switch account type</li>
            <li>Link it to a Facebook Page you manage</li>
            <li>Make sure you're admin of that Facebook Page</li>
          </ol>
          
          <p><strong>Found Pages:</strong></p>
          <pre>${JSON.stringify(pagesData.data?.map(p => ({ name: p.name, has_ig: !!p.instagram_business_account })), null, 2)}</pre>
          
          <a href="/">Try Again After Setup</a>
        </body></html>
      `);
    }
    
    // Show available Instagram pages
    let htmlContent = `
      <html><body style="font-family: Arial; margin: 40px;">
        <h1>✅ Instagram Pages Found!</h1>
        <p>Select the Instagram account you want to use for messaging:</p>
    `;
    
    instagramPages.forEach((page, index) => {
      const ig = page.instagram_business_account || page.connected_instagram_account;
      htmlContent += `
        <div style="border: 1px solid #ddd; padding: 20px; margin: 10px 0; border-radius: 5px;">
          <h3>${page.name}</h3>
          <p><strong>Instagram:</strong> @${ig.username} (ID: ${ig.id})</p>
          <p><strong>Page Access Token:</strong></p>
          <textarea style="width: 100%; height: 60px; font-family: monospace; font-size: 12px;" readonly onclick="this.select();">${page.access_token}</textarea>
          <br><br>
          <div style="background: #f0f0f0; padding: 10px; border-radius: 3px;">
            <strong>📋 Add this to your .env file:</strong><br>
            <code>IG_PAGE_ACCESS_TOKEN=${page.access_token}</code>
          </div>
        </div>
      `;
    });
    
    htmlContent += `
        <h2>🔧 Next Steps:</h2>
        <ol>
          <li>Copy the access token for your desired Instagram account</li>
          <li>Add it to your <code>.env</code> file as <code>IG_PAGE_ACCESS_TOKEN</code></li>
          <li>Restart your main application</li>
          <li>Test messaging from your dashboard</li>
        </ol>
        
        <p><strong>⚠️ Important:</strong> Keep this token secure and don't share it publicly!</p>
      </body></html>
    `;
    
    res.send(htmlContent);
    
    console.log('🎉 Setup complete! Tokens displayed in browser.');
    console.log('📋 Found Instagram pages:', instagramPages.length);
    instagramPages.forEach(page => {
      const ig = page.instagram_business_account || page.connected_instagram_account;
      console.log(`   - ${page.name} (@${ig.username})`);
    });
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.send(`
      <html><body style="font-family: Arial; margin: 40px;">
        <h1>❌ Error</h1>
        <p>${error.message}</p>
        <a href="/">Try Again</a>
      </body></html>
    `);
  }
});

app.listen(PORT, () => {
  console.log(`\n🌐 Open your browser and go to: http://localhost:${PORT}`);
  console.log('📱 Follow the instructions to get your Instagram access token');
  console.log('⏹️  Press Ctrl+C to stop this helper when done\n');
});
