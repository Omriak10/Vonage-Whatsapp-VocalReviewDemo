# Vonage WhatsApp Platform

A comprehensive WhatsApp messaging platform built with Vonage APIs, featuring AI-powered voice transcription, hotel review collection, fraud detection, and message forwarding capabilities.

![Platform Overview](https://img.shields.io/badge/Platform-Node.js-green) ![AI](https://img.shields.io/badge/AI-Gemini%20%7C%20Claude-blue) ![WhatsApp](https://img.shields.io/badge/WhatsApp-Business%20API-brightgreen)

## Features

### 1. **WhatsApp Messaging**
- Send and receive WhatsApp messages via browser
- Conversation history with auto-refresh
- Support for text, images, audio, video, and documents

### 2. **Voice-to-Text Transcription**
- Automatic transcription of voice messages using Google Gemini AI
- Real-time processing with status tracking
- Supports multiple audio formats (OGG, MP3, AAC)

### 3. **Hotel Review System (Reserver)**
- Voice-powered hotel review collection
- AI analyzes reviews and extracts: food, amenities, location, service scores
- Hotel verification against real-world data
- Location confirmation via WhatsApp map pins
- Approval workflow before saving reviews

### 4. **Fraud Detection & AI Decoy**
- Identify and flag suspicious messages
- AI-powered "decoy" that wastes scammers' time
- Message forwarding with security warnings

### 5. **Message Proxy/Forwarding**
- Forward all incoming messages to another number
- Useful for monitoring and alerts

---

## Architecture

```
+------------------------------------------------------------------+
|                        CLIENT BROWSER                             |
|  +------------------------------------------------------------+  |
|  |              Single Page Application (SPA)                  |  |
|  |  +---------+----------+---------------+---------+--------+  |  |
|  |  |Messages | Reviews  | Transcriptions| Settings|  Logs  |  |  |
|  |  +---------+----------+---------------+---------+--------+  |  |
|  +------------------------------------------------------------+  |
+------------------------------------------------------------------+
                              |
                              v
+------------------------------------------------------------------+
|                      NODE.JS SERVER                               |
|  +------------------------------------------------------------+  |
|  |                    Express.js                               |  |
|  |  +------------+------------+------------+-------------+     |  |
|  |  | Webhooks   | REST API   | AI Engine  | Data Store  |     |  |
|  |  | /inbound   | /api/*     | Gemini     | In-Memory   |     |  |
|  |  | /status    |            | Claude     | Maps        |     |  |
|  |  +------------+------------+------------+-------------+     |  |
|  +------------------------------------------------------------+  |
+------------------------------------------------------------------+
                              |
                              v
+------------------------------------------------------------------+
|                    EXTERNAL SERVICES                              |
|  +-------------+  +-------------+  +---------------------------+  |
|  |   Vonage    |  |   Google    |  |       Anthropic          |  |
|  | Messages    |  |   Gemini    |  |        Claude            |  |
|  |    API      |  |    AI       |  |          AI              |  |
|  +-------------+  +-------------+  +---------------------------+  |
+------------------------------------------------------------------+
```

---

## Quick Start

### Prerequisites

- Node.js 18+
- Vonage Account with WhatsApp enabled
- Google AI Studio account (for Gemini)
- Anthropic account (optional, for Claude decoy)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/vonage-whatsapp-platform.git
cd vonage-whatsapp-platform

# Install dependencies
npm install

# Set environment variables (optional)
export PORT=3000

# Start the server
npm start
```

### Access the Application

Open `http://localhost:3000` in your browser.

---

## Configuration

### 1. Vonage Setup

#### Create a Vonage Application

1. Go to [Vonage Dashboard](https://dashboard.nexmo.com/applications)
2. Click "Create a new application"
3. Name your application
4. Enable **Messages** capability
5. Set webhook URLs:
   - **Inbound URL**: `https://your-domain.com/webhooks/inbound`
   - **Status URL**: `https://your-domain.com/webhooks/status`
6. Generate and download your **private key**
7. Note your **Application ID**

#### Link a WhatsApp Number

1. Go to [Vonage WhatsApp Sandbox](https://dashboard.nexmo.com/messages/sandbox) or link a production number
2. Link the number to your application

### 2. Google Gemini Setup

1. Go to [Google AI Studio](https://aistudio.google.com/)
2. Click "Get API Key"
3. Create a new API key
4. Copy the key (starts with `AIza...`)

### 3. Anthropic Claude Setup (Optional)

1. Go to [Anthropic Console](https://console.anthropic.com/)
2. Create an API key
3. Copy the key (starts with `sk-ant-...`)

### 4. Configure in the App

1. Open the **Settings** tab
2. Enter your credentials:
   - **Proxy Settings**: Application ID, Private Key, WhatsApp numbers
   - **AI Settings**: Gemini API Key, Claude API Key
3. Click Save

---

## WhatsApp Integration

### How Messages Flow

```
+-------------+     +-------------+     +-------------+
|   User      |---->|   Vonage    |---->|   Your      |
| (WhatsApp)  |     |   Cloud     |     |   Server    |
+-------------+     +-------------+     +-------------+
                           |                   |
                           |    Webhook POST   |
                           |   /webhooks/inbound
                           |                   v
                           |           +-------------+
                           |           |  Process    |
                           |           |  Message    |
                           |           +-------------+
                           |                   |
                           |<------------------+
                           |    Send Response
                           |    via API
                           v
                    +-------------+
                    |   User      |
                    | (WhatsApp)  |
                    +-------------+
```

### Webhook Payload Example

When a message arrives, Vonage sends:

```json
{
  "message_uuid": "abc123...",
  "from": "447700900123",
  "to": "447700900456",
  "timestamp": "2024-01-15T10:30:00Z",
  "message_type": "text",
  "text": "Hello!",
  "channel": "whatsapp"
}
```

For voice messages:

```json
{
  "message_type": "audio",
  "audio": {
    "url": "https://api.nexmo.com/media/...",
    "caption": null
  }
}
```

### Sending Messages

**Text Message:**
```javascript
POST https://api.nexmo.com/v1/messages
{
  "from": "447700900456",
  "to": "447700900123",
  "channel": "whatsapp",
  "message_type": "text",
  "text": "Hello from the platform!"
}
```

**Location Message:**
```javascript
POST https://api.nexmo.com/v1/messages
{
  "from": "447700900456",
  "to": "447700900123",
  "channel": "whatsapp",
  "message_type": "custom",
  "custom": {
    "type": "location",
    "location": {
      "latitude": 48.8566,
      "longitude": 2.3522,
      "name": "Hotel Paris",
      "address": "123 Rue Example, Paris"
    }
  }
}
```

---

## AI Integration

### Voice Transcription (Gemini)

When a voice message arrives:

1. Audio is fetched from Vonage
2. Converted to base64
3. Sent to Gemini for transcription

**Transcription Prompt:**
```
Transcribe this audio message. 
Return ONLY the spoken text, nothing else.
If you can't understand it, return "[unintelligible]".
```

### Hotel Review Analysis (Gemini)

**Analysis Prompt:**
```
Analyze this voice review transcript and extract hotel review information.

New transcript: "${transcript}"

Respond with ONLY a valid JSON object:
{
  "isHotelReview": true/false,
  "hotelName": "hotel name WITH city if mentioned",
  "hotelCity": "city mentioned or null",
  "personName": "reviewer's name or null",
  "cleanedReview": "review with filler words removed",
  "food": "SHORT summary (2-6 words) or null",
  "foodScore": 1-5 or null,
  "amenities": "SHORT summary or null",
  "amenitiesScore": 1-5 or null,
  "location": "SHORT summary or null",
  "locationScore": 1-5 or null,
  "service": "SHORT summary or null",
  "serviceScore": 1-5 or null,
  "overallSentiment": "positive/negative/mixed/neutral"
}

SCORING GUIDE:

GENERAL QUALITY SCORES:
- 5 (Excellent): "great", "awesome", "amazing", "excellent", "fantastic"
- 4 (Good): "really good", "very good", "nice", "enjoyed"
- 3 (Average): "ok", "okay", "fine", "decent", "acceptable"
- 2 (Below Average): "not great", "mediocre", "disappointing"
- 1 (Poor): "bad", "really bad", "awful", "terrible", "not good"

LOCATION-SPECIFIC SCORES:
- 5: "central", "perfect location", "heart of the city"
- 4: "kind of central", "fairly central", "near the center"
- 3: "a bit off center", "not too far", "walkable"
- 2: "really off center", "far from center", "quite far"
- 1: "not central at all", "very far", "isolated"
```

### Hotel Verification (Gemini)

**Verification Prompt:**
```
Find and verify this hotel: "${hotelName}"

CRITICAL RULES:
1. If a city is mentioned, find the hotel IN THAT CITY ONLY
2. Do NOT return a hotel from a different city
3. Return actual coordinates of THIS specific hotel

Respond with JSON:

If hotel EXISTS:
{
  "exists": true,
  "fullName": "official name",
  "description": "2-3 sentences",
  "location": "city, country",
  "address": "full street address",
  "latitude": 00.000000,
  "longitude": 00.000000,
  "website": "url or null",
  "category": "luxury/boutique/resort/business/budget/historic",
  "amenities": ["list", "of", "amenities"]
}

If hotel does NOT exist:
{
  "exists": false,
  "similarHotel": "suggestion or null"
}
```

### Review Cleanup (Gemini)

**Cleanup Prompt:**
```
Combine these voice message transcripts into ONE coherent review.

Transcripts:
${allTranscripts}

RULES:
1. Remove ALL filler words: uh, um, er, like, you know, I mean
2. Fix grammar and punctuation
3. DO NOT change actual words or meaning
4. Make it flow as one natural paragraph
5. Keep the reviewer's voice and style

Return ONLY the cleaned review text.
```

### Fraud Decoy (Claude)

**Decoy Persona Prompt:**
```
You are Walter, a confused elderly man who received a text from 
someone claiming to be his son asking for money. You're not very 
tech-savvy and easily confused. You want to help your "son" but 
keep asking clarifying questions. String them along by:

- Being confused about details
- Asking them to repeat things
- Getting distracted telling stories
- Asking how to use the phone
- Being slow to understand

Never reveal you're an AI. Keep responses short and confused.
```

---

## Review Flow

```
User sends voice message
         |
         v
+------------------+
| Transcribe with  |
|     Gemini       |
+--------+---------+
         |
         v
+------------------+
|  Analyze for     |
|  hotel review    |
+--------+---------+
         |
    +----+----+
    |         |
    v         v
 Is Hotel   Not Hotel
 Review?    Review
    |         |
    |         +---> Store transcription only
    v
+------------------+
| Extract: hotel,  |
| scores, summary  |
+--------+---------+
         |
         v
+------------------+    No
| Have all info?   |--------> Ask follow-up question
+--------+---------+          (max 3 questions)
         | Yes
         v
+------------------+
| Generate clean   |
| combined review  |
+--------+---------+
         |
         v
+------------------+
| Send for user    |
|   approval       |<------+
+--------+---------+       |
         |                 |
    +----+----+            |
    |         |            |
    v         v            |
  "Yes"      "No"          |
    |         |            |
    |         +------------+ Ask to start over
    v
+------------------+
| Verify hotel     |
| exists (Gemini)  |
+--------+---------+
         |
    +----+----+
    |         |
    v         v
 Exists    Not Found
    |         |
    |         +---> "Did you mean [suggestion]?"
    v                (user can retry)
+------------------+
|  Create hotel    |
|  profile + save  |
|     review       |
+--------+---------+
         |
         v
+------------------+
| Send thank you   |
| + location pin   |
+------------------+
```

---

## Project Structure

```
vonage-whatsapp-platform/
├── server.js           # Main Express server + all logic
├── package.json        # Dependencies
├── README.md           # This file
└── public/
    ├── index.html      # Single-page application
    ├── login.html      # Authentication page
    ├── styles.css      # Shared styles
    └── app.js          # Legacy client-side JS
```

---

## API Endpoints

### Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/conversations` | Get all conversations |
| POST | `/api/send` | Send a message |
| DELETE | `/api/conversations/:number` | Clear a conversation |

### Hotels/Reviews

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/hotels` | List all hotels |
| GET | `/api/hotels/:id` | Get hotel details + reviews |
| DELETE | `/api/hotels` | Clear all hotels |
| DELETE | `/api/hotels/:id` | Delete a hotel |

### Transcriptions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/transcriptions` | Get all transcriptions |
| DELETE | `/api/transcriptions` | Clear all |

### Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/proxy/status` | Get proxy status |
| POST | `/api/proxy/enable` | Enable message forwarding |
| POST | `/api/proxy/disable` | Disable forwarding |
| POST | `/api/t2v/settings` | Update Gemini settings |
| POST | `/api/decoy/settings` | Update Claude settings |

### Webhooks

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/webhooks/inbound` | Receive incoming messages |
| POST | `/webhooks/status` | Receive delivery status |

---

## Security Features

### Fraud Detection

Configure suspicious numbers in Settings:

- **Bad Number**: Triggers warning, enables AI decoy
- **Link Scam**: Blocks malicious link senders
- **Company Fraud**: Blocks business impersonators
- **Co-worker Scam**: Blocks fake colleague messages

---

## Voice Review System - User Guide

The voice review system allows users to submit hotel reviews via WhatsApp voice messages. The AI transcribes, analyzes, and structures the review automatically.

### How It Works

1. User sends a voice message reviewing a hotel
2. AI transcribes the audio to text
3. AI extracts review information and scores
4. If information is missing, AI asks follow-up questions
5. User approves the final review
6. Hotel is verified to exist in real life
7. Review is saved and location pin is sent

### Information the AI Looks For

The AI actively listens for these key pieces of information:

| Information | Required | Examples |
|-------------|----------|----------|
| **Hotel Name** | Yes | "I stayed at the Marriott", "The Drawing House hotel" |
| **City/Location** | Yes | "in Paris", "located in London", "New York" |
| **Reviewer Name** | No | "My name is John", "I'm Sarah" |
| **Food Opinion** | No | "breakfast was amazing", "the restaurant was just okay" |
| **Amenities Opinion** | No | "the pool was great", "room was spacious" |
| **Location Opinion** | No | "very central", "a bit off center" |
| **Service Opinion** | No | "staff were friendly", "slow check-in" |

### Example Voice Message

A complete review might sound like:

> "Hi, my name is Sarah. I just stayed at the Grand Hotel in Barcelona. The location was really central, right near the main square. The food was excellent, especially the breakfast buffet. The room amenities were good, nice pool and gym. Service was a bit slow at check-in but otherwise friendly staff."

### Follow-Up Questions

If the AI doesn't have enough information, it will ask up to 3 questions:

- "What is the name of the hotel you're reviewing?"
- "Where is the hotel located?"
- "How was your experience with the food, room, location, or service?"

### Scoring System

The AI scores each category from 1-5 based on keywords used:

**General Quality:**
| Score | Keywords |
|-------|----------|
| 5 | great, awesome, amazing, excellent, fantastic, wonderful, perfect |
| 4 | really good, very good, nice, enjoyed, impressed |
| 3 | ok, okay, fine, decent, alright, acceptable |
| 2 | not great, mediocre, disappointing, could be better |
| 1 | bad, really bad, awful, terrible, horrible, worst, not good |

**Location Specific:**
| Score | Keywords |
|-------|----------|
| 5 | central, perfect location, heart of the city, downtown |
| 4 | kind of central, fairly central, close to center, near the center |
| 3 | a bit off center, little bit off, not too far, walkable to center |
| 2 | really off center, far from center, quite far |
| 1 | not central at all, very far, middle of nowhere, isolated |

### Approval Process

Before saving, the AI sends the cleaned review for approval:

```
Here is your review:

"I stayed at the Grand Hotel in Barcelona. The location was really 
central, right near the main square. The food was excellent, especially 
the breakfast buffet. The room amenities were good with a nice pool 
and gym. Service was a bit slow at check-in but otherwise friendly staff."

Is this ok? Reply Yes or No
```

- Reply **Yes** to save the review
- Reply **No** to discard and start over
- If no response in 15 seconds, auto-approved

### Hotel Verification

After approval, the AI verifies the hotel exists:

- Hotel must be a real establishment
- Location must match the city mentioned
- If not found, AI suggests similar hotels
- If verified, a WhatsApp location pin is sent with coordinates

### Tips for Best Results

1. **Speak clearly** - Avoid background noise
2. **Mention the hotel name and city** - "Hotel X in City Y"
3. **Be specific** - "The breakfast was great" scores better than "it was fine"
4. **You can send multiple voice messages** - They will be combined into one review

---

## Development

### Run in Development Mode

```bash
npm run dev
```

### Expose Local Server (for webhooks)

Use ngrok or similar:

```bash
ngrok http 3000
```

Then update your Vonage webhook URLs to the ngrok URL.

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request
