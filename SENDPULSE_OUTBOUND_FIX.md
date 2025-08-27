# SendPulse Outbound Messaging Fix

## 🚨 Problem Identified

Your SendPulse outbound messaging was failing because:

1. **Wrong API Endpoint**: You were trying to use `/chatbots/messages/send` which returns 404 errors
2. **Correct Endpoint**: The working endpoint is `/instagram/chats/messages` 
3. **Contact ID Mismatch**: The `chat_id` stored in your database is actually the correct `contact_id` for outbound

## ✅ Solution Implemented

### 1. Fixed the `sendPulseSendInstagram` Function

**Before (Broken):**
- Complex fallback logic across multiple API bases
- Attempted to use Chatbots API as fallback
- Unnecessary contact ID resolution

**After (Fixed):**
- Uses ONLY the Instagram API endpoint: `/instagram/chats/messages`
- Simplified payload structure
- Direct approach with confirmed working endpoint

### 2. Correct Payload Format

```json
{
  "chat_id": "68ab4050ac7632ce7d0d0250",
  "contact_id": "68ab4050ac7632ce7d0d0250",
  "text": "Your message text"
}
```

**Key Points:**
- Use the same ID for both `chat_id` and `contact_id`
- The ID from your database (`68ab4050ac7632ce7d0d0250`) is correct
- No need for complex ID resolution

### 3. Working Configuration

- **Bot ID**: `68ab38663bef0841770e2282` ✅ (Confirmed working)
- **API Base**: `https://api.sendpulse.com` ✅ (Confirmed working)
- **Endpoint**: `/instagram/chats/messages` ✅ (Confirmed working)

## 🔧 Changes Made to server.js

### Updated `sendPulseSendInstagram` Function

```javascript
// SendPulse Instagram sender: uses Instagram API endpoint (confirmed working)
async function sendPulseSendInstagram(chatId, text) {
  try {
    if (!chatId || !text) return false;
    
    // Use the Instagram API endpoint directly - this is confirmed working
    const base = 'https://api.sendpulse.com';
    const payload = {
      chat_id: String(chatId),
      contact_id: String(chatId), // Use the same ID for both fields
      text: String(text)
    };
    
    const debugSend = (process.env.DEBUG_SP_SEND || 'true') === 'true';
    if (debugSend) console.log('SP IG send attempt:', { chat_id: payload.chat_id, text: payload.text.substring(0, 100) });

    try {
      const token = await getSendpulseToken(false, base);
      const url = `${base}/instagram/chats/messages`;
      
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const textBody = await resp.text().catch(() => '');
      let json;
      try { json = textBody ? JSON.parse(textBody) : null; } catch {}

      if (!resp.ok) {
        console.error('SendPulse IG send failed', resp.status, url, JSON.stringify(payload), textBody.slice(0, 1000));
        return false;
      }
      
      if (json && typeof json.success === 'boolean' && json.success === false) {
        console.error('SendPulse IG send API error (success=false)', url, JSON.stringify(payload), textBody.slice(0, 1000));
        return false;
      }
      
      if (debugSend) console.log('SP IG send OK', url, { chat_id: payload.chat_id, success: true });
      return true;
      
    } catch (e) {
      console.error('SendPulse IG send error', e.message);
      return false;
    }
  } catch (e) {
    console.error('SendPulse IG send error', e.message);
    return false;
  }
}
```

## 🧪 Testing Results

### ✅ Working Test
```bash
node scripts/test_working_outbound.js
```

**Output:**
```
🎉 SUCCESS! Your outbound messaging is working!

🔧 TO FIX YOUR SERVER:
   1. Use ONLY the Instagram API endpoint: /instagram/chats/messages
   2. Use the contact_id from your database
   3. Remove any fallback to Chatbots API
   4. Ensure you're using the correct bot ID: 68ab38663bef0841770e2282
```

## 📋 Environment Variables

Ensure these are set in your `.env` file:

```bash
SENDPULSE_CLIENT_ID=2908ec8417932f5bcae6...
SENDPULSE_CLIENT_SECRET=your_secret_here
SENDPULSE_BOT_ID_INSTAGRAM=68ab38663bef0841770e2282
SENDPULSE_API_BASE=https://api.sendpulse.com
DEBUG_SP_SEND=true
```

## 🚀 Next Steps

1. **Restart your server** to apply the code changes
2. **Test outbound messaging** with a real conversation
3. **Monitor logs** for successful sends
4. **Remove old debugging scripts** if no longer needed

## 🔍 What Was Tested

- ✅ Authentication with SendPulse
- ✅ Instagram API endpoint functionality
- ✅ Contact ID validation
- ✅ Message sending capability
- ✅ Response parsing

## 💡 Key Insights

1. **SendPulse has different APIs** for different purposes:
   - `/instagram/chats/messages` - For sending messages (WORKING)
   - `/chatbots/messages/send` - For chatbot automation (NOT WORKING for Instagram)

2. **Your contact IDs are correct** - no need to change your database

3. **The Instagram API is the right choice** for outbound messaging

4. **Simpler is better** - removed complex fallback logic that was causing issues

## 🆘 If Issues Persist

1. Check server logs for error messages
2. Verify your SendPulse account is active
3. Ensure your bot has the correct permissions
4. Contact SendPulse support if needed

---

**Status**: ✅ **RESOLVED** - Outbound messaging should now work correctly
