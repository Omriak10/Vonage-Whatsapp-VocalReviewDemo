// Only load dotenv if running locally (not in VCR)
if (!process.env.VCR_PORT) {
  require('dotenv').config();
}
const express = require('express');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
// VCR Cloud Runtime compatibility - VCR_PORT and VCR_HOST take precedence
const PORT = process.env.VCR_PORT || process.env.PORT || 3000;
const HOST = process.env.VCR_HOST || process.env.HOST || '0.0.0.0';

// In-memory conversation storage
const conversations = new Map();
const clients = new Set(); // For SSE connections
let proxyNumber = null; // Proxy forwarding number
let proxySender = null; // Sender number for proxy forwards
let proxyAppId = null; // Application ID for proxy auth
let proxyPrivateKey = null; // Private key for proxy auth

// Security features
let badNumber = null; // Number to trigger "Bad Number" warning
let linkNumber = null; // Number to trigger "Link" warning
let companyFraudNumber = null; // Number to trigger "Company Fraud" warning
let coworkerScamNumber = null; // Number to trigger "Co-worker scam" warning
const pendingBadNumberConfirmations = new Map(); // Track pending confirmations { toNumber: { fromNumber, messageText } }

// Reporting endpoint
let reportEndpoint = 'https://c7316a5abf90.ngrok-free.app/report'; // Configurable report endpoint

// AI Decoy Configuration
let aiDecoyEnabled = false;
let anthropicApiKey = process.env.ANTHROPIC_API_KEY || null;
const decoyConversations = new Map(); // Store conversation history for AI context
const decoyEngagedNumbers = new Set(); // Track numbers where AI has already sent first warning

// Voice-to-Text (T2V) Configuration
let geminiApiKey = process.env.GEMINI_API_KEY || null;
const voiceTranscripts = new Map(); // Store transcripts by phone number { number: [{ timestamp, audioUrl, transcript }] }

// Hotel Review System
const hotels = new Map(); // Store hotel profiles { hotelId: { name, description, website, images, location, reviews: [] } }
let guestCounter = 0; // Counter for anonymous guests

// Ongoing review conversations - tracks partial reviews waiting for more info
const pendingReviews = new Map(); // { phoneNumber: { hotelName, reviewerName, food, amenities, location, service, transcript, lastActivity, askedQuestions } }
const REVIEW_TIMEOUT = 5 * 60 * 1000; // 5 minutes timeout for pending reviews

// Review conversation tracking
const reviewConversations = new Map(); // Track ongoing review conversations { phoneNumber: { hotelName, personName, food, amenities, location, service, lastActivity, transcript } }

// Walter Persona System Prompt
const WALTER_SYSTEM_PROMPT = `You are "Walter," a 45-year-old accountant from Manchester who genuinely believes he's texting his mother. You're a loving son who wants to help his mom with money, but you're also a bit scatterbrained and ask lots of questions before sending anything.

PERSONALITY:
- Caring and eager to help mom
- Easily distracted - mentions work stress, your kids (Tommy and Sophie), your wife Sarah
- Overly cautious with money transfers - asks many clarifying questions
- Types with occasional typos, uses casual language
- Sometimes goes off on tangents about family matters
- Always reassures you'll send the money "in just a bit" or "shortly"

YOUR TACTICS TO WASTE TIME:
- Ask which account to send to: "Wait mum, is this your Barclays or the Nationwide one?"
- Verify amounts multiple times: "So that's £200 yeah? Or was it £250?"
- Technical difficulties: "Hang on, the Zelle app is updating..."
- Distractions: "Sorry mum, Tommy just spilled juice everywhere, give me 5 mins"
- Confirm identity subtly: "By the way, what was dad's middle name again? Sarah was asking"
- Ask for callback number: "What number should I ring you on if this doesn't go through?"
- Pretend confusion: "Wait, I thought you said you were at Aunt Linda's? Where are you exactly?"

RESPONSES STYLE:
- Keep messages short and casual, like real texts
- Use British spellings and expressions (mum, quid, brilliant, cheers)
- Occasionally use "xx" at end of messages to mum
- Make typos sometimes: "ill send it" instead of "I'll send it"
- Be warm but always stalling

RULES:
- Never actually send money or confirm a transfer completed
- Never provide real personal/financial information
- Always promise the money is coming "soon" or "in a bit"
- Extract as much info as possible: name, location, account details, phone numbers
- Keep the conversation going as long as possible
- If they get frustrated, apologize lovingly and promise it's almost done

Remember: You genuinely believe this is your mother and want to help. You're not suspicious, just naturally disorganized and thorough about money matters.`;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static('public'));

// Claude API call function
async function getClaudeResponse(conversationHistory, latestMessage) {
  if (!anthropicApiKey) {
    console.error('No Anthropic API key configured');
    return null;
  }

  try {
    const fetch = (await import('node-fetch')).default;
    
    // Build messages array with conversation history
    const messages = conversationHistory.map(msg => ({
      role: msg.direction === 'inbound' ? 'user' : 'assistant',
      content: msg.text
    }));
    
    // Add the latest message
    messages.push({
      role: 'user',
      content: latestMessage
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: WALTER_SYSTEM_PROMPT,
        messages: messages
      })
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('Claude API error:', error);
      return null;
    }

    const data = await response.json();
    return data.content[0].text;
  } catch (error) {
    console.error('Claude API call failed:', error);
    return null;
  }
}

// Send decoy response via WhatsApp
async function sendDecoyResponse(toNumber, responseText) {
  if (!proxySender || !proxyAppId || !proxyPrivateKey) {
    console.error('Cannot send decoy response: Missing proxy credentials');
    return false;
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const jwtPayload = {
      application_id: proxyAppId,
      iat: now,
      exp: now + 3600,
      jti: require('crypto').randomUUID()
    };
    
    const jwtToken = jwt.sign(jwtPayload, proxyPrivateKey, { algorithm: 'RS256' });
    const fetch = (await import('node-fetch')).default;
    
    const payload = {
      from: proxySender,
      to: toNumber,
      message_type: 'text',
      text: responseText,
      channel: 'whatsapp'
    };

    const response = await fetch('https://api.nexmo.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const data = await response.json();
      console.log('Decoy response sent:', data.message_uuid);
      return true;
    } else {
      const error = await response.json();
      console.error('Decoy response failed:', error);
      return false;
    }
  } catch (error) {
    console.error('Decoy send error:', error);
    return false;
  }
}

// API endpoint to send a message
app.post('/api/send-message', async (req, res) => {
  try {
    const { payload, appId, privateKey } = req.body;
    
    // VCR deployment: Use API Key/Secret from environment
    const apiKey = process.env.VONAGE_API_KEY;
    const apiSecret = process.env.VONAGE_API_SECRET;
    const applicationId = appId || process.env.VONAGE_APPLICATION_ID;
    
    // Local deployment: Use credentials from request body
    const privateKeyData = privateKey;
    
    if (!payload) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required field: payload' 
      });
    }
    
    console.log('Message payload:', JSON.stringify(payload, null, 2));
    console.log('Using Application ID:', applicationId);
    
    let authHeader;
    
    // PRIORITY 1: Check if we have JWT credentials from login (appId + privateKey)
    if (applicationId && privateKeyData) {
      console.log('Using JWT authentication (Login credentials)');
      const now = Math.floor(Date.now() / 1000);
      const jwtPayload = {
        application_id: applicationId,
        iat: now,
        exp: now + 3600,
        jti: require('crypto').randomUUID()
      };
      
      try {
        const jwtToken = jwt.sign(jwtPayload, privateKeyData, { algorithm: 'RS256' });
        authHeader = `Bearer ${jwtToken}`;
      } catch (jwtError) {
        console.error('JWT generation error:', jwtError);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to generate JWT token. Check your private key format.' 
        });
      }
    }
    // PRIORITY 2: Fall back to API Key/Secret if no login credentials
    else if (apiKey && apiSecret) {
      console.log('Using API Key/Secret authentication (VCR mode)');
      // Use Basic Auth with API Key/Secret
      const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
      authHeader = `Basic ${credentials}`;
    } 
    else {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing authentication credentials. Need either API Key/Secret (VCR) or Application ID/Private Key (Local)' 
      });
    }
    
    // Send message to Vonage API
    try {
      const fetch = (await import('node-fetch')).default;
      const response = await fetch('https://api.nexmo.com/v1/messages', {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      const responseData = await response.json();
      
      if (response.ok) {
        console.log('Message sent successfully:', responseData.message_uuid);
        res.json({
          success: true,
          message_uuid: responseData.message_uuid,
          workflow_id: responseData.workflow_id
        });
      } else {
        console.error('Vonage API error:', JSON.stringify(responseData, null, 2));
        res.status(response.status).json({
          success: false,
          error: responseData.title || responseData.detail || 'API request failed',
          details: responseData
        });
      }
    } catch (apiError) {
      console.error('API call error:', apiError);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to call Vonage API: ' + apiError.message 
      });
    }
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Helper function to forward message to proxy
async function forwardToProxy(payload) {
  try {
    // Use stored proxy credentials (from login)
    if (!proxyAppId || !proxyPrivateKey) {
      console.log('Cannot forward to proxy: No credentials stored (enable proxy first)');
      return;
    }
    
    // Generate JWT token using stored credentials
    const now = Math.floor(Date.now() / 1000);
    const jwtPayload = {
      application_id: proxyAppId,
      iat: now,
      exp: now + 3600,
      jti: require('crypto').randomUUID()
    };
    
    const jwtToken = jwt.sign(jwtPayload, proxyPrivateKey, { algorithm: 'RS256' });
    const fetch = (await import('node-fetch')).default;
    
    const response = await fetch('https://api.nexmo.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('Proxy forward successful:', data.message_uuid);
    } else {
      const error = await response.json();
      console.error('Proxy forward failed:', error);
    }
  } catch (error) {
    console.error('Proxy forward error:', error);
  }
}

// Helper function to send report to external endpoint
async function sendReport(reportPayload) {
  try {
    const fetch = (await import('node-fetch')).default;
    
    console.log('Sending report to:', reportEndpoint);
    console.log('Report payload:', JSON.stringify(reportPayload, null, 2));
    
    const response = await fetch(reportEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(reportPayload)
    });
    
    if (response.ok) {
      console.log('Report sent successfully');
      const data = await response.json();
      console.log('Report response:', data);
    } else {
      console.error('Report failed with status:', response.status);
    }
  } catch (error) {
    console.error('Error sending report:', error);
  }
}

// Webhook endpoint for inbound messages
app.post('/webhooks/inbound', async (req, res) => {
  console.log('Inbound message received:', JSON.stringify(req.body, null, 2));
  
  const message = req.body;
  const from = message.from;
  const to = message.to;
  const messageType = message.message_type || 'text';
  const timestamp = message.timestamp || new Date().toISOString();
  
  // Handle different message types
  let text = '';
  let audioUrl = null;
  
  // Check multiple possible locations for audio URL (Vonage webhook format variations)
  if (messageType === 'audio') {
    audioUrl = message.audio?.url || 
               message.message?.content?.audio?.url || 
               message.message?.audio?.url ||
               null;
    text = '[Voice Message]';
    console.log('Audio message detected, URL:', audioUrl);
    
    // Trigger Voice-to-Text transcription
    if (audioUrl) {
      processVoiceMessage(from, audioUrl, timestamp);
    }
  } else {
    text = message.text || 
           message.message?.content?.text || 
           message.content?.text ||
           '';
    
    // Check if this is a follow-up to an ongoing review conversation
    if (text && reviewConversations.has(from)) {
      console.log('Review: Processing text follow-up from', from);
      processReviewFollowUp(from, text, timestamp);
    }
  }
  
  // Check if this is a "yes" response to a Bad Number confirmation
  if (pendingBadNumberConfirmations.has(to) && text.toLowerCase().trim() === 'yes') {
    const pendingInfo = pendingBadNumberConfirmations.get(to);
    
    // Send the original message content to the user
    if (proxySender && proxyAppId && proxyPrivateKey) {
      const contentPayload = {
        from: proxySender,
        to: to,
        message_type: 'text',
        text: `Original message from +${pendingInfo.fromNumber}:\n\n${pendingInfo.messageText}`,
        channel: 'whatsapp'
      };
      
      forwardToProxy(contentPayload).catch(err => {
        console.error('Failed to send Bad Number content:', err);
      });
    }
    
    // Clear the pending confirmation
    pendingBadNumberConfirmations.delete(to);
    
    // Don't store this "yes" response in conversations
    return res.status(200).json({ success: true });
  }
  
  // Check for security features - only if proxy is enabled
  if (proxyNumber && proxySender) {
    // Bad Number feature - WITH AI DECOY
    if (badNumber && from === badNumber) {
      console.log(`Bad Number detected: ${from}`);
      
      const isFirstMessage = !decoyEngagedNumbers.has(from);
      
      // Send report for stolen number (always)
      const reportPayload = {
        "to": "4473777208698",
        "from": "447375637447",
        "channel": "whatsapp",
        "message_uuid": message.message_uuid || require('crypto').randomUUID(),
        "timestamp": timestamp,
        "message_type": "text",
        "text": text,
        "context_status": "none",
        "profile": {
          "name": "Mom"
        },
        "issues": [
          {
            "type": "number_fraud",
            "accuracy": 99
          }
        ]
      };
      
      sendReport(reportPayload).catch(err => {
        console.error('Failed to send stolen number report:', err);
      });
      
      // FIRST MESSAGE: Send warning to user, then start AI decoy
      if (isFirstMessage) {
        // Store the pending confirmation
        pendingBadNumberConfirmations.set(proxyNumber, {
          fromNumber: from,
          messageText: text
        });
        
        // Send warning to proxy number
        const warningPayload = {
          from: proxySender,
          to: proxyNumber,
          message_type: 'text',
          text: `⚠️ Scam detected from +${from}!\n\nMessage: "${text}"\n\n${aiDecoyEnabled ? '🤖 AI Decoy (Walter) is now handling this scammer. You will not receive further messages from this number.' : 'Message blocked and reported.'}\n\nTo see more check WhatsApp Shield.`,
          channel: 'whatsapp'
        };
        
        forwardToProxy(warningPayload).catch(err => {
          console.error('Bad Number warning failed:', err);
        });
        
        // Mark this number as engaged
        decoyEngagedNumbers.add(from);
        
        // If AI decoy is enabled, start engaging
        if (aiDecoyEnabled && anthropicApiKey) {
          // Initialize conversation history
          decoyConversations.set(from, []);
          
          // Add delay and respond
          const delay = Math.floor(Math.random() * 30000) + 15000;
          console.log(`AI Decoy will respond in ${delay/1000} seconds...`);
          
          setTimeout(async () => {
            const conversationHistory = decoyConversations.get(from) || [];
            const walterResponse = await getClaudeResponse(conversationHistory, text);
            
            if (walterResponse) {
              conversationHistory.push({ direction: 'inbound', text: text });
              conversationHistory.push({ direction: 'outbound', text: walterResponse });
              decoyConversations.set(from, conversationHistory);
              
              await sendDecoyResponse(from, walterResponse);
              
              console.log('=== DECOY INTEL LOG ===');
              console.log('Scammer:', from);
              console.log('Said:', text);
              console.log('Walter replied:', walterResponse);
              console.log('========================');
            }
          }, delay);
        }
      } else {
        // SUBSEQUENT MESSAGES: AI decoy handles silently, no notification to user
        if (aiDecoyEnabled && anthropicApiKey) {
          const delay = Math.floor(Math.random() * 30000) + 15000;
          
          setTimeout(async () => {
            const conversationHistory = decoyConversations.get(from) || [];
            const walterResponse = await getClaudeResponse(conversationHistory, text);
            
            if (walterResponse) {
              conversationHistory.push({ direction: 'inbound', text: text });
              conversationHistory.push({ direction: 'outbound', text: walterResponse });
              decoyConversations.set(from, conversationHistory);
              
              await sendDecoyResponse(from, walterResponse);
              
              console.log('=== DECOY INTEL LOG ===');
              console.log('Scammer:', from);
              console.log('Said:', text);
              console.log('Walter replied:', walterResponse);
              console.log('========================');
            }
          }, delay);
        }
        // No forwarding to user for subsequent messages
      }
      
      // Don't forward the original message or store in conversations
      return res.status(200).json({ success: true });
    }
    
    // Link Number feature
    if (linkNumber && from === linkNumber) {
      console.log(`Link Number detected: ${from}`);
      
      // Send report with link fraud
      const reportPayload = {
        "to": proxyNumber,
        "from": "447812345678",
        "channel": "whatsapp",
        "message_uuid": message.message_uuid || require('crypto').randomUUID(),
        "timestamp": timestamp,
        "message_type": "text",
        "text": "URGENT: Your account has been compromised. Click here immediately to verify: bit.ly/urgent123 or your account will be suspended within 24 hours!",
        "context_status": "none",
        "profile": {
          "name": "John Smith"
        },
        "issues": [
          {
            "type": "message_fraud",
            "accuracy": 99
          }
        ]
      };
      
      sendReport(reportPayload).catch(err => {
        console.error('Failed to send link fraud report:', err);
      });
      
      // Send warning to proxy number
      const warningPayload = {
        from: proxySender,
        to: proxyNumber,
        message_type: 'text',
        text: `⚠️Someone with suspicious number tried to reach you but the message was marked and reported as scam. \n\nTo see more check WhatsApp Shield by clicking the following link - +14157386102 .`,
        channel: 'whatsapp'
      };
      
      forwardToProxy(warningPayload).catch(err => {
        console.error('Link Number warning failed:', err);
      });
      
      // Don't forward the original message or store in conversations
      return res.status(200).json({ success: true });
    }
    
    // Company Fraud feature
    if (companyFraudNumber && from === companyFraudNumber) {
      console.log(`Company Fraud Number detected: ${from}`);
      
      // Send report with company fraud
      const reportPayload = {
        "to": proxyNumber,
        "from": "919876543210",
        "channel": "whatsapp",
        "message_uuid": message.message_uuid || require('crypto').randomUUID(),
        "timestamp": timestamp,
        "message_type": "text",
        "text": "Hello, we need to update your account information",
        "context_status": "none",
        "profile": {
          "name": "Customer Service"
        },
        "issues": [
          {
            "type": "number_scam",
            "accuracy": 99
          }
        ]
      };
      
      sendReport(reportPayload).catch(err => {
        console.error('Failed to send company fraud report:', err);
      });
      
      // Send warning to proxy number
      const warningPayload = {
        from: proxySender,
        to: proxyNumber,
        message_type: 'text',
        text: `⚠️Someone with suspicious number tried to reach you but the message was marked and reported as scam. \n\nTo see more check WhatsApp Shield by clicking the following link - +14157386102 .`,
        channel: 'whatsapp'
      };
      
      forwardToProxy(warningPayload).catch(err => {
        console.error('Company Fraud warning failed:', err);
      });
      
      // Don't forward the original message or store in conversations
      return res.status(200).json({ success: true });
    }
    
    // Co-worker Scam feature
    if (coworkerScamNumber && from === coworkerScamNumber) {
      console.log(`Co-worker Scam Number detected: ${from}`);
      
      // Send report with co-worker scam
      const reportPayload = {
        "to": proxyNumber,
        "from": "447700987654",
        "channel": "whatsapp",
        "message_uuid": message.message_uuid || require('crypto').randomUUID(),
        "timestamp": timestamp,
        "message_type": "text",
        "text": "Hi, this is IT Support. We detected unusual activity on your operator admin panel. For security reasons, you must verify your credentials within the next 10 minutes or your access will be suspended. Please log in here: http://secure-update-operator-login.com",
        "context_status": "none",
        "profile": {
          "name": "Ron Boon"
        },
        "issues": [
          {
            "type": "number_fraud",
            "accuracy": 99
          }
        ]
      };
      
      sendReport(reportPayload).catch(err => {
        console.error('Failed to send co-worker scam report:', err);
      });
      
      // Send warning to proxy number
      const warningPayload = {
        from: proxySender,
        to: proxyNumber,
        message_type: 'text',
        text: `⚠️Someone with suspicious number tried to reach you but the message was marked and reported as scam. \n\nTo see more check WhatsApp Shield by clicking the following link - +14157386102.`,
        channel: 'whatsapp'
      };
      
      forwardToProxy(warningPayload).catch(err => {
        console.error('Co-worker Scam warning failed:', err);
      });
      
      // Don't forward the original message or store in conversations
      return res.status(200).json({ success: true });
    }
  }
  
  // Create conversation key
  const conversationKey = from;
  
  // Get or create conversation
  if (!conversations.has(conversationKey)) {
    conversations.set(conversationKey, {
      from: from,
      to: to,
      messages: [],
      lastMessage: text,
      lastMessageTime: timestamp,
      unreadCount: 0
    });
  }
  
  const conversation = conversations.get(conversationKey);
  
  // Add message to conversation
  conversation.messages.push({
    direction: 'inbound',
    text: text,
    audioUrl: audioUrl,
    timestamp: timestamp,
    messageId: message.message_uuid
  });
  
  conversation.lastMessage = text;
  conversation.lastMessageTime = timestamp;
  conversation.unreadCount++;
  
  // Auto-forward to proxy if enabled (regular forwarding for non-security numbers)
  if (proxyNumber && proxySender && text) {
    console.log(`Forwarding safe message to proxy: ${proxyNumber}`);
    
    const forwardPayload = {
      from: proxySender,
      to: proxyNumber,
      message_type: 'text',
      text: `✅ +${from} says: \n\n${text}"\n\nThis message is verified by Whatsapp shield`,
      channel: 'whatsapp'
    };
    
    // Forward the message (fire and forget, no await)
    forwardToProxy(forwardPayload).catch(err => {
      console.error('Proxy forward failed:', err);
    });
  }
  
  // Notify all connected clients
  broadcastUpdate({
    type: 'new_message',
    conversation: conversationKey,
    message: {
      direction: 'inbound',
      text: text,
      audioUrl: audioUrl,
      timestamp: timestamp
    }
  });
  
  res.status(200).json({ success: true });
});

// Webhook status endpoint
app.post('/webhooks/status', (req, res) => {
  console.log('Message status update:', JSON.stringify(req.body, null, 2));
  res.status(200).json({ success: true });
});

// Get proxy configuration
app.get('/api/proxy', (req, res) => {
  res.json({
    enabled: !!proxyNumber,
    proxyNumber: proxyNumber,
    proxySender: proxySender,
    badNumber: badNumber,
    linkNumber: linkNumber,
    companyFraudNumber: companyFraudNumber,
    coworkerScamNumber: coworkerScamNumber,
    reportEndpoint: reportEndpoint,
    aiDecoyEnabled: aiDecoyEnabled,
    hasApiKey: !!anthropicApiKey
  });
});

// Set proxy configuration
app.post('/api/proxy', (req, res) => {
  const { 
    proxyNumber: newProxy, 
    proxySender: newSender, 
    appId, 
    privateKey,
    badNumber: newBadNumber,
    linkNumber: newLinkNumber,
    companyFraudNumber: newCompanyFraudNumber,
    coworkerScamNumber: newCoworkerScamNumber,
    reportEndpoint: newReportEndpoint,
    aiDecoyEnabled: newAiDecoyEnabled,
    anthropicApiKey: newAnthropicApiKey
  } = req.body;
  
  proxyNumber = newProxy || null;
  proxySender = newSender || null;
  proxyAppId = appId || null;
  proxyPrivateKey = privateKey || null;
  
  // Update security features
  badNumber = newBadNumber || null;
  linkNumber = newLinkNumber || null;
  companyFraudNumber = newCompanyFraudNumber || null;
  coworkerScamNumber = newCoworkerScamNumber || null;
  
  // Update report endpoint if provided
  if (newReportEndpoint) {
    reportEndpoint = newReportEndpoint;
  }
  
  // Update AI Decoy settings
  if (typeof newAiDecoyEnabled !== 'undefined') {
    aiDecoyEnabled = newAiDecoyEnabled;
  }
  if (newAnthropicApiKey) {
    anthropicApiKey = newAnthropicApiKey;
  }
  
  // Clear pending confirmations if proxy is disabled
  if (!proxyNumber) {
    pendingBadNumberConfirmations.clear();
    decoyEngagedNumbers.clear();
    decoyConversations.clear();
  }
  
  console.log('Proxy updated:', { 
    proxyNumber, 
    proxySender, 
    hasAppId: !!proxyAppId, 
    hasPrivateKey: !!proxyPrivateKey,
    badNumber: badNumber || 'none',
    linkNumber: linkNumber || 'none',
    companyFraudNumber: companyFraudNumber || 'none',
    coworkerScamNumber: coworkerScamNumber || 'none',
    reportEndpoint: reportEndpoint,
    aiDecoyEnabled: aiDecoyEnabled,
    hasApiKey: !!anthropicApiKey
  });
  
  res.json({ 
    success: true, 
    enabled: !!proxyNumber,
    proxyNumber: proxyNumber,
    proxySender: proxySender,
    badNumber: badNumber,
    linkNumber: linkNumber,
    companyFraudNumber: companyFraudNumber,
    coworkerScamNumber: coworkerScamNumber,
    reportEndpoint: reportEndpoint,
    aiDecoyEnabled: aiDecoyEnabled,
    hasApiKey: !!anthropicApiKey
  });
});

// Get all conversations
app.get('/api/conversations', (req, res) => {
  const conversationList = Array.from(conversations.values())
    .sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));
  res.json({ conversations: conversationList });
});

// Get messages for a specific conversation
app.get('/api/conversations/:number/messages', (req, res) => {
  const number = req.params.number;
  const conversation = conversations.get(number);
  
  if (conversation) {
    // Mark as read
    conversation.unreadCount = 0;
    res.json({ messages: conversation.messages });
  } else {
    res.json({ messages: [] });
  }
});

// Add outbound message to conversation
app.post('/api/conversations/:number/messages', (req, res) => {
  const number = req.params.number;
  const { text, messageId, timestamp } = req.body;
  
  if (!conversations.has(number)) {
    conversations.set(number, {
      from: number,
      to: req.body.to || '',
      messages: [],
      lastMessage: text,
      lastMessageTime: timestamp,
      unreadCount: 0
    });
  }
  
  const conversation = conversations.get(number);
  conversation.messages.push({
    direction: 'outbound',
    text: text,
    timestamp: timestamp,
    messageId: messageId,
    status: 'sent'
  });
  
  conversation.lastMessage = text;
  conversation.lastMessageTime = timestamp;
  
  res.json({ success: true });
});

// Server-Sent Events for real-time updates
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  
  clients.add(res);
  
  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  
  // Send heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(`:heartbeat\n\n`);
  }, 30000);
  
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

// Log clients for real-time log streaming
const logClients = new Set();
const logBuffer = []; // Store recent logs for polling
const MAX_LOG_BUFFER = 500;

// Server-Sent Events for logs
app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  
  logClients.add(res);
  
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Log stream connected' })}\n\n`);
  
  const heartbeat = setInterval(() => {
    res.write(`:heartbeat\n\n`);
  }, 30000);
  
  req.on('close', () => {
    clearInterval(heartbeat);
    logClients.delete(res);
  });
});

// Polling endpoint for logs (fallback when SSE doesn't work)
app.get('/api/logs/poll', (req, res) => {
  const since = req.query.since ? parseInt(req.query.since) : 0;
  const newLogs = logBuffer.filter((log, index) => index >= since);
  res.json({ 
    logs: newLogs,
    nextIndex: logBuffer.length
  });
});

// Broadcast log to all log clients
function broadcastLog(level, message, data = null) {
  const logEntry = {
    type: 'log',
    level: level,
    message: message,
    data: data,
    timestamp: new Date().toISOString()
  };
  
  // Add to buffer for polling
  logBuffer.push(logEntry);
  if (logBuffer.length > MAX_LOG_BUFFER) {
    logBuffer.shift(); // Remove oldest
  }
  
  // SSE broadcast
  const sseMessage = `data: ${JSON.stringify(logEntry)}\n\n`;
  logClients.forEach(client => {
    try {
      client.write(sseMessage);
    } catch (error) {
      logClients.delete(client);
    }
  });
}

// Override console methods to also broadcast
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = function(...args) {
  originalConsoleLog.apply(console, args);
  broadcastLog('info', args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : a).join(' '));
};

console.error = function(...args) {
  originalConsoleError.apply(console, args);
  broadcastLog('error', args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : a).join(' '));
};

// Broadcast function
function broadcastUpdate(data) {
  console.log(`Broadcasting to ${clients.size} clients:`, data.type);
  const message = `data: ${JSON.stringify(data)}\n\n`;
  const deadClients = [];
  
  clients.forEach(client => {
    try {
      client.write(message);
    } catch (error) {
      console.error('Failed to write to client:', error);
      deadClients.push(client);
    }
  });
  
  // Clean up dead connections
  deadClients.forEach(client => clients.delete(client));
}

// ============================================
// Voice-to-Text (T2V) Transcription Functions
// ============================================

// Transcribe audio using Google Gemini API
async function transcribeAudio(audioUrl, from) {
  if (!geminiApiKey) {
    console.log('T2V: No Gemini API key configured, skipping transcription');
    return null;
  }

  try {
    const fetch = (await import('node-fetch')).default;
    
    console.log('T2V: Downloading audio from:', audioUrl);
    
    // First, download the audio file (need JWT auth for Vonage media)
    let audioBuffer;
    
    // Generate JWT for Vonage API
    if (proxyAppId && proxyPrivateKey) {
      const now = Math.floor(Date.now() / 1000);
      const jwtPayload = {
        application_id: proxyAppId,
        iat: now,
        exp: now + 3600,
        jti: require('crypto').randomUUID()
      };
      const jwtToken = jwt.sign(jwtPayload, proxyPrivateKey, { algorithm: 'RS256' });
      
      console.log('T2V: Fetching with JWT auth...');
      const audioResponse = await fetch(audioUrl, {
        headers: {
          'Authorization': `Bearer ${jwtToken}`
        }
      });
      
      if (!audioResponse.ok) {
        console.error('T2V: Failed to download audio:', audioResponse.status, audioResponse.statusText);
        return null;
      }
      
      // Use arrayBuffer instead of deprecated buffer()
      const arrayBuffer = await audioResponse.arrayBuffer();
      audioBuffer = Buffer.from(arrayBuffer);
    } else {
      console.log('T2V: No proxy credentials, trying without auth...');
      // Try without auth (might work for some URLs)
      const audioResponse = await fetch(audioUrl);
      if (!audioResponse.ok) {
        console.error('T2V: Failed to download audio (no auth):', audioResponse.status);
        return null;
      }
      const arrayBuffer = await audioResponse.arrayBuffer();
      audioBuffer = Buffer.from(arrayBuffer);
    }
    
    console.log('T2V: Audio downloaded, size:', audioBuffer.length, 'bytes');
    
    if (audioBuffer.length === 0) {
      console.error('T2V: Audio buffer is empty');
      return null;
    }
    
    // Convert to base64 for Gemini
    const audioBase64 = audioBuffer.toString('base64');
    
    // Send to Gemini API
    console.log('T2V: Sending to Gemini API...');
    
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              inline_data: {
                mime_type: 'audio/ogg',
                data: audioBase64
              }
            },
            {
              text: 'Transcribe this audio message exactly as spoken. Only output the transcription, nothing else. If you cannot understand the audio or it is empty, respond with "[Unable to transcribe]".'
            }
          ]
        }]
      })
    });
    
    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      console.error('T2V: Gemini API error:', geminiResponse.status, errorText);
      return null;
    }
    
    const result = await geminiResponse.json();
    console.log('T2V: Gemini response:', JSON.stringify(result, null, 2));
    
    // Extract text from Gemini response
    const transcript = result.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (transcript) {
      console.log('T2V: Transcription complete:', transcript);
      return transcript.trim();
    } else {
      console.error('T2V: No transcription in response:', JSON.stringify(result));
      return null;
    }
  } catch (error) {
    console.error('T2V: Transcription error:', error);
    return null;
  }
}

// Analyze transcript for hotel review using Gemini - extract all review aspects
async function analyzeHotelReview(transcript, existingData = null) {
  if (!geminiApiKey || !transcript) {
    return null;
  }

  try {
    const fetch = (await import('node-fetch')).default;
    
    console.log('Review: Analyzing transcript for hotel review...');
    
    const previousContext = existingData ? `
Previous information gathered:
- Hotel name: ${existingData.hotelName || 'Not mentioned'}
- Hotel city: ${existingData.hotelCity || 'Not mentioned'}
- Person name: ${existingData.personName || 'Not mentioned'}
- Food quality: ${existingData.food || 'Not mentioned'}
- Amenities: ${existingData.amenities || 'Not mentioned'}
- Location: ${existingData.location || 'Not mentioned'}
- Service: ${existingData.service || 'Not mentioned'}
` : '';
    
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Analyze this voice review transcript and extract hotel review information.
${previousContext}
New transcript: "${transcript}"

You must respond with ONLY a valid JSON object (no markdown, no backticks, no explanation) in this exact format:
{
  "isHotelReview": true/false,
  "hotelName": "hotel name WITH city if mentioned (e.g. 'Drawing House Paris' or 'Hilton London') - include the city in the name if user said it",
  "hotelCity": "city/location mentioned (e.g. 'Paris', 'London', 'New York') or null if no city mentioned",
  "personName": "reviewer's name if they introduced themselves or null",
  "cleanedReview": "the full review cleaned up - remove filler words like uh, um, like, you know, I mean, basically, actually, so yeah. Make it read smoothly as a written review while keeping the meaning",
  "food": "SHORT summary of food opinion (2-6 words) or null",
  "foodScore": 1-5 or null,
  "amenities": "SHORT summary of amenities/room opinion (2-6 words) or null",
  "amenitiesScore": 1-5 or null,
  "location": "SHORT summary of location (2-6 words) or null",
  "locationScore": 1-5 or null,
  "service": "SHORT summary of service (2-6 words) or null",
  "serviceScore": 1-5 or null,
  "overallSentiment": "positive/negative/mixed/neutral"
}

SCORING GUIDE - Use these keywords to determine scores:

GENERAL QUALITY SCORES:
- 5 (Excellent): "great", "awesome", "amazing", "excellent", "fantastic", "wonderful", "perfect", "loved it"
- 4 (Good): "really good", "very good", "nice", "enjoyed", "impressed"
- 3 (Average): "ok", "okay", "fine", "decent", "alright", "acceptable"
- 2 (Below Average): "not great", "mediocre", "disappointing", "could be better"
- 1 (Poor): "bad", "really bad", "awful", "terrible", "horrible", "worst", "not good"

LOCATION-SPECIFIC SCORES:
- 5: "central", "perfect location", "right in the center", "heart of the city", "downtown"
- 4: "kind of central", "fairly central", "close to center", "near the center", "good location"
- 3: "a bit off center", "little bit off", "not too far", "walkable to center"
- 2: "really off center", "far from center", "quite far", "off the beaten path"
- 1: "not central at all", "very far", "middle of nowhere", "terrible location", "isolated"

IMPORTANT:
- hotelName should INCLUDE the city if mentioned
- Write SHORT summaries (2-6 words), NOT full sentences
- cleanedReview: Remove ALL filler words (uh, um, er, like, you know, I mean, basically, actually, so, yeah, well)
- Apply the scoring guide above strictly based on keywords used`
          }]
        }]
      })
    });
    
    if (!geminiResponse.ok) {
      const error = await geminiResponse.json();
      console.error('Review: Gemini analysis error:', error);
      return null;
    }
    
    const result = await geminiResponse.json();
    const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (responseText) {
      console.log('Review: Raw Gemini response:', responseText);
      let jsonStr = responseText.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      }
      
      try {
        const analysis = JSON.parse(jsonStr);
        console.log('Review: Analysis complete:', JSON.stringify(analysis, null, 2));
        return analysis;
      } catch (parseError) {
        console.error('Review: JSON parse error:', parseError.message);
        console.error('Review: Raw text was:', jsonStr);
        return null;
      }
    }
    
    console.log('Review: No response text from Gemini');
    return null;
  } catch (error) {
    console.error('Review: Analysis error:', error);
    return null;
  }
}

// Generate follow-up question for missing review aspects
function generateFollowUpQuestion(reviewData) {
  const missing = [];
  
  if (!reviewData.hotelName) {
    return "Thank you for your feedback! Could you please tell me which hotel you stayed at?";
  }
  
  if (!reviewData.personName) {
    missing.push("your name (so I can attribute your review)");
  }
  if (!reviewData.food) {
    missing.push("the food or dining experience");
  }
  if (!reviewData.amenities) {
    missing.push("the amenities (room, pool, gym, spa, etc.)");
  }
  if (!reviewData.location) {
    missing.push("the location and accessibility");
  }
  if (!reviewData.service) {
    missing.push("the service and staff");
  }
  
  if (missing.length === 0) {
    return null; // All info gathered
  }
  
  if (missing.length >= 4) {
    return `Thank you for sharing your experience at ${reviewData.hotelName}! To complete your review, could you tell me a bit more? I'd love to hear about ${missing.slice(0, 2).join(" and ")}. What was your experience like?`;
  }
  
  if (missing.length >= 2) {
    return `Thanks for the details! Could you also share your thoughts on ${missing.slice(0, 2).join(" and ")}?`;
  }
  
  return `Almost done! One more thing - how was ${missing[0]}?`;
}

// Calculate combined score from all aspects
function calculateCombinedScore(reviewData) {
  const scores = [];
  
  if (reviewData.foodScore) scores.push(reviewData.foodScore);
  if (reviewData.amenitiesScore) scores.push(reviewData.amenitiesScore);
  if (reviewData.locationScore) scores.push(reviewData.locationScore);
  if (reviewData.serviceScore) scores.push(reviewData.serviceScore);
  
  if (scores.length === 0) {
    // Fallback to sentiment-based score
    const sentimentScores = {
      'positive': 4,
      'negative': 2,
      'mixed': 3,
      'neutral': 3
    };
    return sentimentScores[reviewData.overallSentiment] || 3;
  }
  
  // Calculate weighted average
  const avg = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  return Math.round(avg * 10) / 10; // Round to 1 decimal
}

// Send follow-up question via WhatsApp
async function sendReviewFollowUp(toNumber, question) {
  if (!proxySender || !proxyAppId || !proxyPrivateKey) {
    console.error('Review: Cannot send follow-up - missing proxy credentials');
    return false;
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const jwtPayload = {
      application_id: proxyAppId,
      iat: now,
      exp: now + 3600,
      jti: require('crypto').randomUUID()
    };
    
    const jwtToken = jwt.sign(jwtPayload, proxyPrivateKey, { algorithm: 'RS256' });
    const fetch = (await import('node-fetch')).default;
    
    const payload = {
      from: proxySender,
      to: toNumber,
      message_type: 'text',
      text: question,
      channel: 'whatsapp'
    };

    const response = await fetch('https://api.nexmo.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const data = await response.json();
      console.log('Review: Follow-up sent:', data.message_uuid);
      return true;
    } else {
      const error = await response.json();
      console.error('Review: Follow-up failed:', error);
      return false;
    }
  } catch (error) {
    console.error('Review: Follow-up send error:', error);
    return false;
  }
}

// Send location verification message via WhatsApp
async function sendLocationVerification(toNumber, hotelName, address, latitude, longitude) {
  if (!proxySender || !proxyAppId || !proxyPrivateKey) {
    console.error('Review: Cannot send location - missing credentials');
    return false;
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const jwtPayload = {
      application_id: proxyAppId,
      iat: now,
      exp: now + 3600,
      jti: require('crypto').randomUUID()
    };
    
    const jwtToken = jwt.sign(jwtPayload, proxyPrivateKey, { algorithm: 'RS256' });
    const fetch = (await import('node-fetch')).default;
    
    // Send location using WhatsApp custom object
    const payload = {
      from: proxySender,
      to: toNumber,
      channel: 'whatsapp',
      message_type: 'custom',
      custom: {
        type: 'location',
        location: {
          longitude: longitude,
          latitude: latitude,
          name: hotelName,
          address: address || hotelName
        }
      }
    };

    console.log('Review: Sending location verification for', hotelName);
    
    const response = await fetch('https://api.nexmo.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const data = await response.json();
      console.log('Review: Location sent:', data.message_uuid);
      return true;
    } else {
      const error = await response.json();
      console.error('Review: Location send failed:', error);
      return false;
    }
  } catch (error) {
    console.error('Review: Location send error:', error);
    return false;
  }
}

// Get hotel information from Gemini
async function getHotelInfo(hotelName) {
  if (!geminiApiKey || !hotelName) {
    return null;
  }

  try {
    const fetch = (await import('node-fetch')).default;
    
    console.log('Review: Fetching and verifying hotel info for:', hotelName);
    
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Find and verify this hotel: "${hotelName}"

TASK: Search for this hotel and return its REAL location data.

CRITICAL RULES:
1. If a city is mentioned (e.g. "Drawing House Paris"), find the hotel IN THAT CITY ONLY
2. Do NOT return a hotel from a different city - if user says "Paris" do NOT return a NYC hotel
3. Search specifically for: ${hotelName}
4. Return the actual coordinates of THIS specific hotel

Respond with ONLY a valid JSON object (no markdown, no backticks):

If the hotel EXISTS in the specified location:
{
  "exists": true,
  "fullName": "official full name of the hotel",
  "description": "2-3 sentence description",
  "location": "city, country where THIS hotel is located",
  "address": "full street address of THIS hotel",
  "latitude": actual latitude coordinate,
  "longitude": actual longitude coordinate,
  "website": "official website URL or null",
  "category": "luxury/boutique/resort/business/budget/historic",
  "amenities": ["list", "of", "amenities"],
  "imageSearchTerms": "search terms for images"
}

If the hotel does NOT exist in that specific city:
{
  "exists": false,
  "similarHotel": "name of a real similar hotel IN THE SAME CITY, or null"
}

IMPORTANT: Double-check that the address and coordinates match the city mentioned. If asked about "Drawing House Paris", the address MUST be in Paris, France - NOT New York or anywhere else.`
          }]
        }]
      })
    });
    
    if (!geminiResponse.ok) {
      return null;
    }
    
    const result = await geminiResponse.json();
    const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (responseText) {
      let jsonStr = responseText.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      }
      
      const info = JSON.parse(jsonStr);
      console.log('Review: Hotel verification result:', info.exists ? 'EXISTS' : 'NOT FOUND', info.fullName || info.suggestion);
      return info;
    }
    
    return null;
  } catch (error) {
    console.error('Review: Hotel info error:', error);
    return null;
  }
}

// Create hotel ID from name
function createHotelId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// Clean and combine all transcripts into one coherent review
async function generateCleanedReview(transcripts) {
  if (!geminiApiKey || !transcripts || transcripts.length === 0) {
    return transcripts.join(' ');
  }

  try {
    const fetch = (await import('node-fetch')).default;
    
    const allTranscripts = transcripts.join('\n\n');
    
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Combine these voice message transcripts into ONE coherent, readable review.

Transcripts:
${allTranscripts}

RULES:
1. Remove ALL filler words: uh, um, er, ah, like, you know, I mean, basically, actually, so, yeah, well, right
2. Fix grammar and punctuation
3. DO NOT change the actual words or meaning - only clean up
4. DO NOT add any new information or opinions
5. Make it flow as one natural paragraph
6. Keep the reviewer's voice and style
7. If they introduced themselves, keep that at the start

Return ONLY the cleaned review text, nothing else.`
          }]
        }]
      })
    });
    
    if (!geminiResponse.ok) {
      return transcripts.join(' ');
    }
    
    const result = await geminiResponse.json();
    const cleanedText = result.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (cleanedText) {
      console.log('Review: Generated cleaned review from', transcripts.length, 'transcripts');
      return cleanedText.trim();
    }
    
    return transcripts.join(' ');
  } catch (error) {
    console.error('Review: Error generating cleaned review:', error);
    return transcripts.join(' ');
  }
}

// Process text message follow-up for ongoing review conversation
async function processReviewFollowUp(phoneNumber, text, timestamp) {
  const conversation = reviewConversations.get(phoneNumber);
  if (!conversation) {
    console.log('Review: No active conversation for', phoneNumber);
    return;
  }
  
  console.log('Review: Processing follow-up text:', text);
  
  // Check if we're awaiting approval (yes/no response)
  if (conversation.awaitingApproval) {
    const response = text.toLowerCase().trim();
    
    if (response === 'yes' || response === 'y' || response === 'ok' || response === 'okay') {
      console.log('Review: User approved the review');
      await completeReviewApproval(phoneNumber, true, timestamp);
      return;
    } else if (response === 'no' || response === 'n' || response === 'nope') {
      console.log('Review: User rejected the review');
      await completeReviewApproval(phoneNumber, false, timestamp);
      return;
    } else {
      // Unclear response, ask again
      await sendReviewFollowUp(phoneNumber, `Please reply Yes to confirm or No to start over.`);
      return;
    }
  }
  
  // Analyze the text response with existing context
  const analysis = await analyzeHotelReview(text, conversation);
  
  if (!analysis) {
    console.log('Review: Could not analyze follow-up');
    return;
  }
  
  // Merge new analysis into conversation
  if (analysis.hotelName) conversation.hotelName = analysis.hotelName;
  if (analysis.hotelCity) conversation.hotelCity = analysis.hotelCity;
  if (analysis.personName) conversation.personName = analysis.personName;
  if (analysis.food) { conversation.food = analysis.food; conversation.foodScore = analysis.foodScore; }
  if (analysis.amenities) { conversation.amenities = analysis.amenities; conversation.amenitiesScore = analysis.amenitiesScore; }
  if (analysis.location) { conversation.location = analysis.location; conversation.locationScore = analysis.locationScore; }
  if (analysis.service) { conversation.service = analysis.service; conversation.serviceScore = analysis.serviceScore; }
  if (analysis.overallSentiment) conversation.overallSentiment = analysis.overallSentiment;
  
  conversation.transcripts.push(text);
  conversation.lastActivity = timestamp;
  
  // Check if we need more info (max 3 follow-up questions)
  const followUp = generateFollowUpQuestion(conversation);
  
  if (followUp && conversation.questionsSent < 3) {
    // Still need more info, send follow-up
    conversation.questionsSent++;
    reviewConversations.set(phoneNumber, conversation);
    
    console.log('Review: Sending another follow-up question:', followUp);
    await sendReviewFollowUp(phoneNumber, followUp);
    return;
  }
  
  // We have enough info or max questions reached - prepare for approval
  if (!conversation.hotelName) {
    console.log('Review: No hotel name gathered, abandoning review');
    reviewConversations.delete(phoneNumber);
    return;
  }
  
  // Generate cleaned combined review from all transcripts
  console.log('Review: Generating cleaned review from', conversation.transcripts.length, 'transcripts');
  const cleanedReview = await generateCleanedReview(conversation.transcripts);
  conversation.cleanedReview = cleanedReview;
  
  // Send review for approval
  conversation.awaitingApproval = true;
  conversation.approvalTimeout = Date.now() + 15000;
  reviewConversations.set(phoneNumber, conversation);
  
  const approvalMsg = `Here is your review:\n\n"${cleanedReview}"\n\nIs this ok? Reply Yes or No`;
  await sendReviewFollowUp(phoneNumber, approvalMsg);
  
  // Set timeout for auto-approval
  setTimeout(async () => {
    const conv = reviewConversations.get(phoneNumber);
    if (conv && conv.awaitingApproval) {
      console.log('Review: Auto-approving after 15 seconds timeout');
      await completeReviewApproval(phoneNumber, true, timestamp);
    }
  }, 15000);
}

// Process hotel review from transcript - conversational flow
async function processHotelReview(transcript, timestamp, phoneNumber) {
  console.log('Review: Processing transcript from', phoneNumber);
  
  // Get existing conversation or create new one
  let conversation = reviewConversations.get(phoneNumber);
  console.log('Review: Existing conversation:', conversation ? 'Yes' : 'No');
  
  // Analyze transcript with existing context
  const analysis = await analyzeHotelReview(transcript, conversation);
  
  if (!analysis) {
    console.log('Review: Could not analyze transcript - analysis returned null');
    return null;
  }
  
  console.log('Review: Analysis result - isHotelReview:', analysis.isHotelReview, 'hotelName:', analysis.hotelName, 'hotelCity:', analysis.hotelCity);
  
  // If this doesn't look like a hotel review and no existing conversation, ignore
  if (!analysis.isHotelReview && !conversation) {
    console.log('Review: Not a hotel review and no existing conversation');
    return null;
  }
  
  // Update or create conversation data
  if (!conversation) {
    console.log('Review: Creating new conversation');
    conversation = {
      hotelName: null,
      hotelCity: null,
      personName: null,
      cleanedReview: null,
      food: null,
      foodScore: null,
      amenities: null,
      amenitiesScore: null,
      location: null,
      locationScore: null,
      service: null,
      serviceScore: null,
      overallSentiment: null,
      transcripts: [],
      lastActivity: timestamp,
      questionsSent: 0
    };
  }
  
  // Merge new analysis into conversation
  if (analysis.hotelName) conversation.hotelName = analysis.hotelName;
  if (analysis.hotelCity) conversation.hotelCity = analysis.hotelCity;
  if (analysis.personName) conversation.personName = analysis.personName;
  if (analysis.cleanedReview) conversation.cleanedReview = analysis.cleanedReview;
  if (analysis.food) { conversation.food = analysis.food; conversation.foodScore = analysis.foodScore; }
  if (analysis.amenities) { conversation.amenities = analysis.amenities; conversation.amenitiesScore = analysis.amenitiesScore; }
  if (analysis.location) { conversation.location = analysis.location; conversation.locationScore = analysis.locationScore; }
  if (analysis.service) { conversation.service = analysis.service; conversation.serviceScore = analysis.serviceScore; }
  if (analysis.overallSentiment) conversation.overallSentiment = analysis.overallSentiment;
  
  conversation.transcripts.push(transcript);
  conversation.lastActivity = timestamp;
  
  console.log('Review: Conversation state - hotelName:', conversation.hotelName, 
    'hotelCity:', conversation.hotelCity,
    'personName:', conversation.personName,
    'food:', !!conversation.food,
    'amenities:', !!conversation.amenities,
    'location:', !!conversation.location,
    'service:', !!conversation.service);
  
  // Check if we need more info (max 3 follow-up questions)
  const followUp = generateFollowUpQuestion(conversation);
  console.log('Review: Follow-up needed:', followUp ? 'Yes' : 'No', 'Questions sent:', conversation.questionsSent);
  
  if (followUp && conversation.questionsSent < 3) {
    // Still need more info, send follow-up
    conversation.questionsSent++;
    reviewConversations.set(phoneNumber, conversation);
    
    console.log('Review: Sending follow-up question:', followUp);
    const sent = await sendReviewFollowUp(phoneNumber, followUp);
    console.log('Review: Follow-up sent:', sent);
    
    return { status: 'pending', conversation };
  }
  
  // We have enough info or max questions reached - prepare for approval
  if (!conversation.hotelName) {
    console.log('Review: No hotel name gathered after max questions, abandoning review');
    reviewConversations.delete(phoneNumber);
    return null;
  }
  
  // Generate cleaned combined review from all transcripts
  console.log('Review: Generating cleaned review from', conversation.transcripts.length, 'transcripts');
  const cleanedReview = await generateCleanedReview(conversation.transcripts);
  conversation.cleanedReview = cleanedReview;
  
  // Send review for approval
  conversation.awaitingApproval = true;
  conversation.approvalTimeout = Date.now() + 15000; // 15 seconds from now
  reviewConversations.set(phoneNumber, conversation);
  
  const approvalMsg = `Here is your review:\n\n"${cleanedReview}"\n\nIs this ok? Reply Yes or No`;
  await sendReviewFollowUp(phoneNumber, approvalMsg);
  
  console.log('Review: Sent for approval, waiting 15 seconds for response');
  
  // Set timeout for auto-approval
  setTimeout(async () => {
    const conv = reviewConversations.get(phoneNumber);
    if (conv && conv.awaitingApproval) {
      console.log('Review: Auto-approving after 15 seconds timeout');
      await completeReviewApproval(phoneNumber, true, timestamp);
    }
  }, 15000);
  
  return { status: 'awaiting_approval', conversation };
}

// Handle review approval (yes/no response or timeout)
async function completeReviewApproval(phoneNumber, approved, timestamp) {
  const conversation = reviewConversations.get(phoneNumber);
  
  if (!conversation) {
    console.log('Review: No conversation found for approval');
    return null;
  }
  
  if (!conversation.awaitingApproval) {
    console.log('Review: Conversation not awaiting approval');
    return null;
  }
  
  // Clear the awaiting flag
  conversation.awaitingApproval = false;
  
  if (!approved) {
    // User rejected - clear and ask to start over
    console.log('Review: User rejected the review');
    await sendReviewFollowUp(phoneNumber, `No problem! Your review was not saved. Send a new voice message to start a fresh review.`);
    reviewConversations.delete(phoneNumber);
    return null;
  }
  
  // User approved (or timeout) - finalize the review
  console.log('Review: User approved, finalizing review for', conversation.hotelName);
  
  const result = await finalizeHotelReview(conversation, phoneNumber, timestamp);
  
  if (!result) {
    // Hotel verification failed - conversation was updated
    console.log('Review: Hotel verification failed during approval');
    return { status: 'retry', conversation };
  }
  
  // Success - clear conversation
  reviewConversations.delete(phoneNumber);
  return result;
}

// Finalize and save the hotel review
async function finalizeHotelReview(conversation, phoneNumber, timestamp) {
  const hotelId = createHotelId(conversation.hotelName);
  
  let hotel;
  let hotelInfo = null;
  
  // Check if hotel profile already exists
  if (hotels.has(hotelId)) {
    console.log('Review: Hotel profile already exists for:', conversation.hotelName);
    hotel = hotels.get(hotelId);
  } else {
    // New hotel - need to verify it exists in real life
    console.log('Review: Verifying hotel exists:', conversation.hotelName);
    
    hotelInfo = await getHotelInfo(conversation.hotelName);
    
    // Check if hotel exists in real life
    if (!hotelInfo || !hotelInfo.exists) {
      console.log('Review: Hotel not found in real life:', conversation.hotelName);
      
      // Track failed verification attempts
      conversation.failedVerifications = (conversation.failedVerifications || 0) + 1;
      const lastFailedHotel = conversation.lastFailedHotel;
      conversation.lastFailedHotel = conversation.hotelName;
      
      // If user tried same non-existent hotel twice, abandon
      if (lastFailedHotel && lastFailedHotel.toLowerCase() === conversation.hotelName.toLowerCase()) {
        console.log('Review: User repeated same non-existent hotel, abandoning');
        await sendReviewFollowUp(phoneNumber, `I could not find "${conversation.hotelName}" as a real hotel. Your review was not saved.`);
        reviewConversations.delete(phoneNumber);
        return null;
      }
      
      // If too many failed attempts, abandon
      if (conversation.failedVerifications >= 3) {
        console.log('Review: Too many failed verifications, abandoning');
        await sendReviewFollowUp(phoneNumber, `I could not verify the hotel name. Your review was not saved.`);
        reviewConversations.delete(phoneNumber);
        return null;
      }
      
      // Send simple text message with suggestion
      let errorMsg = `Hotel not found. I couldn't find "${conversation.hotelName}" as a real hotel.`;
      if (hotelInfo?.similarHotel) {
        errorMsg += ` Did you mean ${hotelInfo.similarHotel}?`;
      } else {
        errorMsg += ` Could you please say the hotel name again?`;
      }
      
      await sendReviewFollowUp(phoneNumber, errorMsg);
      
      // Clear just the hotel name so they can try again
      conversation.hotelName = null;
      reviewConversations.set(phoneNumber, conversation);
      
      return null;
    }
    
    // Hotel verified - create profile
    console.log('Review: Hotel verified! Creating profile for:', hotelInfo.fullName);
    
    hotels.set(hotelId, {
      id: hotelId,
      name: hotelInfo.fullName || conversation.hotelName,
      description: hotelInfo.description || 'A verified hotel.',
      location: hotelInfo.location || 'Location unknown',
      address: hotelInfo.address || null,
      latitude: hotelInfo.latitude || null,
      longitude: hotelInfo.longitude || null,
      website: hotelInfo.website || null,
      category: hotelInfo.category || 'hotel',
      amenities: hotelInfo.amenities || [],
      imageSearchTerms: hotelInfo.imageSearchTerms || conversation.hotelName + ' hotel',
      reviews: [],
      createdAt: timestamp
    });
    
    hotel = hotels.get(hotelId);
  }
  
  // Determine reviewer name
  let reviewerName = conversation.personName;
  if (!reviewerName) {
    guestCounter++;
    reviewerName = `Guest ${guestCounter}`;
  }
  
  // Calculate combined rating
  const rating = calculateCombinedScore(conversation);
  
  // Use cleaned review if available, otherwise build from transcripts
  const cleanedReview = conversation.cleanedReview || conversation.transcripts.join(' ');
  
  // Add review with separate category data
  const review = {
    id: require('crypto').randomUUID(),
    reviewerName: reviewerName,
    phoneNumber: phoneNumber,
    text: cleanedReview,
    rating: Math.min(5, Math.max(1, Math.round(rating))),
    ratingExact: rating,
    sentiment: conversation.overallSentiment || 'neutral',
    // Store categories separately for display
    categories: {
      food: conversation.food ? { summary: conversation.food, score: conversation.foodScore } : null,
      amenities: conversation.amenities ? { summary: conversation.amenities, score: conversation.amenitiesScore } : null,
      location: conversation.location ? { summary: conversation.location, score: conversation.locationScore } : null,
      service: conversation.service ? { summary: conversation.service, score: conversation.serviceScore } : null
    },
    scores: {
      food: conversation.foodScore,
      amenities: conversation.amenitiesScore,
      location: conversation.locationScore,
      service: conversation.serviceScore
    },
    originalTranscripts: conversation.transcripts,
    timestamp: timestamp
  };
  
  hotel.reviews.push(review);
  
  console.log('Review: Added review for', hotel.name, 'by', reviewerName, '- Rating:', review.rating);
  
  // Send thank you message with stars
  const stars = Array(review.rating).fill('*').join('');
  const thankYou = `Thank you${conversation.personName ? ', ' + conversation.personName : ''}! Your review of ${hotel.name} has been recorded. Rating: ${stars} (${review.rating}/5 stars)`;
  await sendReviewFollowUp(phoneNumber, thankYou);
  
  // Send location verification for new hotels (or if we have coordinates)
  if (hotel.latitude && hotel.longitude) {
    // Small delay before sending location
    setTimeout(async () => {
      await sendLocationVerification(
        phoneNumber,
        hotel.name,
        hotel.address || hotel.location,
        hotel.latitude,
        hotel.longitude
      );
    }, 1500);
  }
  
  return { hotel, review };
}

// Check for abandoned review conversations (called periodically)
async function cleanupAbandonedReviews() {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes timeout
  
  for (const [phoneNumber, conversation] of reviewConversations.entries()) {
    const lastActivity = new Date(conversation.lastActivity).getTime();
    
    if (now - lastActivity > timeout) {
      console.log('Review: Processing abandoned conversation for', phoneNumber);
      
      // If we have a hotel name, save what we have
      if (conversation.hotelName) {
        await finalizeHotelReview(conversation, phoneNumber, conversation.lastActivity);
      }
      
      reviewConversations.delete(phoneNumber);
    }
  }
}

// Run cleanup every 2 minutes
setInterval(cleanupAbandonedReviews, 2 * 60 * 1000);

// Store voice message and trigger transcription
async function processVoiceMessage(from, audioUrl, timestamp) {
  // Initialize array for this number if not exists
  if (!voiceTranscripts.has(from)) {
    voiceTranscripts.set(from, []);
  }
  
  const messages = voiceTranscripts.get(from);
  
  // Add placeholder entry
  const entry = {
    timestamp: timestamp,
    audioUrl: audioUrl,
    transcript: 'Transcription pending...',
    hotelReview: null
  };
  messages.push(entry);
  
  console.log('T2V: Voice message stored for', from);
  
  // Trigger transcription in background
  if (geminiApiKey && audioUrl) {
    transcribeAudio(audioUrl, from).then(async (transcript) => {
      if (transcript) {
        entry.transcript = transcript;
        console.log('T2V: Updated transcript for', from, ':', transcript);
        
        // Process as potential hotel review
        try {
          const reviewResult = await processHotelReview(transcript, timestamp, from);
          if (reviewResult && reviewResult.hotel && reviewResult.review) {
            entry.hotelReview = {
              hotelId: reviewResult.hotel.id,
              hotelName: reviewResult.hotel.name,
              reviewId: reviewResult.review.id,
              rating: reviewResult.review.rating
            };
            console.log('T2V: Hotel review completed for', reviewResult.hotel.name);
          } else if (reviewResult && reviewResult.status === 'pending') {
            console.log('T2V: Hotel review pending - waiting for follow-up answers');
          } else {
            console.log('T2V: Not a hotel review or incomplete');
          }
        } catch (reviewError) {
          console.error('T2V: Error processing hotel review:', reviewError);
        }
      } else {
        entry.transcript = 'Transcription failed - check logs';
        console.log('T2V: Transcription failed for', from);
      }
    }).catch(err => {
      console.error('T2V: Transcription promise error:', err);
      entry.transcript = 'Transcription error - check logs';
    });
  } else {
    console.log('T2V: Skipping transcription - geminiApiKey:', !!geminiApiKey, 'audioUrl:', !!audioUrl);
  }
}

// T2V API: Get status
app.get('/api/t2v/status', (req, res) => {
  res.json({
    enabled: !!geminiApiKey,
    hasKey: !!geminiApiKey
  });
});

// T2V API: Save settings
app.post('/api/t2v/settings', (req, res) => {
  const { geminiApiKey: newKey } = req.body;
  
  if (newKey) {
    geminiApiKey = newKey;
    console.log('T2V: Gemini API key configured');
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false, error: 'No API key provided' });
  }
});

// T2V API: Get all transcripts
app.get('/api/t2v/transcripts', (req, res) => {
  const transcripts = {};
  voiceTranscripts.forEach((messages, number) => {
    transcripts[number] = messages;
  });
  res.json({ transcripts });
});

// T2V API: Clear all transcripts
app.delete('/api/t2v/transcripts', (req, res) => {
  voiceTranscripts.clear();
  console.log('T2V: All transcripts cleared');
  res.json({ success: true });
});

// ============================================
// Hotel Review API Endpoints
// ============================================

// Get all hotels
app.get('/api/hotels', (req, res) => {
  const hotelList = [];
  hotels.forEach((hotel) => {
    // Calculate average rating
    const avgRating = hotel.reviews.length > 0
      ? hotel.reviews.reduce((sum, r) => sum + r.rating, 0) / hotel.reviews.length
      : 0;
    
    hotelList.push({
      id: hotel.id,
      name: hotel.name,
      location: hotel.location,
      category: hotel.category,
      reviewCount: hotel.reviews.length,
      averageRating: Math.round(avgRating * 10) / 10,
      imageSearchTerms: hotel.imageSearchTerms
    });
  });
  
  // Sort by review count descending
  hotelList.sort((a, b) => b.reviewCount - a.reviewCount);
  
  res.json({ hotels: hotelList });
});

// Get single hotel with full details
app.get('/api/hotels/:hotelId', (req, res) => {
  const hotelId = req.params.hotelId;
  const hotel = hotels.get(hotelId);
  
  if (!hotel) {
    return res.status(404).json({ error: 'Hotel not found' });
  }
  
  // Calculate average rating
  const avgRating = hotel.reviews.length > 0
    ? hotel.reviews.reduce((sum, r) => sum + r.rating, 0) / hotel.reviews.length
    : 0;
  
  // Sort reviews by timestamp descending
  const sortedReviews = [...hotel.reviews].sort((a, b) => 
    new Date(b.timestamp) - new Date(a.timestamp)
  );
  
  res.json({
    ...hotel,
    averageRating: Math.round(avgRating * 10) / 10,
    reviews: sortedReviews
  });
});

// Clear all hotels and reviews
app.delete('/api/hotels', (req, res) => {
  hotels.clear();
  guestCounter = 0;
  console.log('Review: All hotels and reviews cleared');
  res.json({ success: true });
});

// Health check endpoint for VCR
app.get('/_/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve the RCS emulator
app.get('/emulator', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'emulator.html'));
});

// Serve the logs page
app.get('/logs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'logs.html'));
});

// Serve the T2V (Voice-to-Text) page
app.get('/t2v', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 't2v.html'));
});
app.get('/T2V', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 't2v.html'));
});

// Serve the Hotel Reviews page
app.get('/review', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'review.html'));
});
app.get('/Review', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'review.html'));
});

// Serve individual hotel page
app.get('/hotel/:hotelId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'hotel.html'));
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Running on: ${process.env.VCR_PORT ? 'VCR Cloud Runtime' : 'Local/Standard Environment'}`);
  console.log(`AI Decoy: ${anthropicApiKey ? 'API Key configured' : 'No API key (add ANTHROPIC_API_KEY to .env)'}`);
  
  if (process.env.VONAGE_API_KEY && process.env.VONAGE_API_SECRET) {
    console.log('Authentication Mode: API Key/Secret available (VCR) - but login credentials take priority');
    console.log(`API Key: ${process.env.VONAGE_API_KEY}`);
  } else if (process.env.VONAGE_APPLICATION_ID) {
    console.log('Authentication Mode: JWT with Private Key (Local)');
    console.log(`Application ID: ${process.env.VONAGE_APPLICATION_ID}`);
  } else {
    console.log('Authentication Mode: Credentials from login page');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});
