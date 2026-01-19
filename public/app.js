// State management
const state = {
    credentials: null,
    activeConversation: null,
    conversations: [],
    senderNumber: '',
    proxyEnabled: false,
    proxyNumber: '',
    proxySender: '',
    reportEndpoint: '',
    badNumber: '',
    linkNumber: '',
    companyFraudNumber: '',
    coworkerScamNumber: '',
    aiDecoyEnabled: false,
    anthropicApiKey: ''
};

// Initialize app
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
});

async function initializeApp() {
    // Load credentials from storage
    const storedCreds = localStorage.getItem('vonageCredentials') || sessionStorage.getItem('vonageCredentials');
    if (storedCreds) {
        try {
            state.credentials = JSON.parse(storedCreds);
        } catch (e) {
            console.error('Failed to parse credentials:', e);
        }
    }
    
    // If no credentials, redirect to login
    if (!state.credentials) {
        window.location.href = 'login.html';
        return;
    }

    // Load sender number
    const savedSender = localStorage.getItem('senderNumber');
    if (savedSender) {
        state.senderNumber = savedSender;
    }
    
    // Load saved API key
    const savedApiKey = localStorage.getItem('anthropicApiKey');
    if (savedApiKey) {
        state.anthropicApiKey = savedApiKey;
        document.getElementById('anthropicApiKey').value = savedApiKey;
    }

    setupEventListeners();
    await loadConversations();
    await loadProxySettings();
    startPolling(); // Poll for new messages every 3 seconds
}

// Poll for new conversations/messages
function startPolling() {
    setInterval(async () => {
        const oldConversations = JSON.stringify(state.conversations);
        await loadConversations();
        const newConversations = JSON.stringify(state.conversations);
        
        // If conversations changed and we have an active chat, reload messages
        if (oldConversations !== newConversations && state.activeConversation) {
            const response = await fetch(`/api/conversations/${state.activeConversation}/messages`);
            const data = await response.json();
            
            // Only update if message count changed
            const currentMessages = document.querySelectorAll('.message').length - 1; // -1 for date divider
            if (data.messages && data.messages.length !== currentMessages) {
                renderMessages(data.messages || []);
            }
        }
    }, 3000); // Poll every 3 seconds
}

function setupEventListeners() {
    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    
    // Proxy buttons
    document.getElementById('enableProxyBtn').addEventListener('click', enableProxy);
    document.getElementById('disableProxyBtn').addEventListener('click', disableProxy);
    
    // AI Decoy checkbox
    document.getElementById('aiDecoyEnabled').addEventListener('change', function() {
        const settings = document.getElementById('aiDecoySettings');
        settings.style.display = this.checked ? 'block' : 'none';
    });
    
    // New Chat Button
    document.getElementById('newChatBtn').addEventListener('click', openNewChatModal);
    
    // Start Chat Button
    document.getElementById('startChatBtn').addEventListener('click', startNewChat);
    
    // Send Button
    document.getElementById('sendBtn').addEventListener('click', sendMessage);
    
    // Enter key to send
    document.getElementById('messageInput').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    
    // Auto-resize textarea
    document.getElementById('messageInput').addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
    
    // Clear Chat
    document.getElementById('clearChatBtn').addEventListener('click', clearActiveChat);
    
    // Logout
    document.getElementById('logoutBtn').addEventListener('click', logout);
    
    // Modal close buttons
    const modal = document.getElementById('newChatModal');
    modal.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', () => closeModal(modal));
    });
    
    // Search
    document.getElementById('searchInput').addEventListener('input', filterConversations);
}

// Tab switching
function switchTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(tabName + 'Tab').classList.add('active');
}

// Load conversations from server
async function loadConversations() {
    try {
        const response = await fetch('/api/conversations');
        const data = await response.json();
        state.conversations = data.conversations || [];
        renderConversationList();
    } catch (error) {
        console.error('Failed to load conversations:', error);
    }
}

// Render conversation list
function renderConversationList() {
    const container = document.getElementById('conversationList');
    
    if (state.conversations.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" width="64" height="64">
                    <path fill="currentColor" d="M19.005 3.175H4.674C3.642 3.175 3 3.789 3 4.821V21.02l3.544-3.514h12.461c1.033 0 2.064-1.06 2.064-2.093V4.821c-.001-1.032-1.032-1.646-2.064-1.646zm-4.989 9.869H7.041V11.1h6.975v1.944zm3-4H7.041V7.1h9.975v1.944z"/>
                </svg>
                <p>No conversations yet</p>
                <p class="empty-subtitle">Start a new chat to begin messaging</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = '';
    
    state.conversations.forEach(conversation => {
        const item = document.createElement('div');
        item.className = 'conversation-item';
        if (state.activeConversation === conversation.from) {
            item.classList.add('active');
        }
        
        const time = formatTime(new Date(conversation.lastMessageTime));
        const unreadBadge = conversation.unreadCount > 0 
            ? `<span class="unread-badge">${conversation.unreadCount}</span>` 
            : '';
        
        item.innerHTML = `
            <div class="conversation-avatar"></div>
            <div class="conversation-details">
                <div class="conversation-header">
                    <h4 class="conversation-name">+${conversation.from}</h4>
                    <span class="conversation-time">${time}</span>
                </div>
                <div class="conversation-last-message">
                    <p>${escapeHtml(conversation.lastMessage)}</p>
                    ${unreadBadge}
                </div>
            </div>
        `;
        
        item.addEventListener('click', () => openConversation(conversation.from));
        container.appendChild(item);
    });
}

// Open conversation
async function openConversation(number) {
    state.activeConversation = number;
    
    // Update UI
    document.getElementById('noChat').style.display = 'none';
    document.getElementById('activeChat').style.display = 'flex';
    document.getElementById('activeChatName').textContent = '+' + number;
    
    // Highlight active conversation
    renderConversationList();
    
    // Load messages
    try {
        const response = await fetch(`/api/conversations/${number}/messages`);
        const data = await response.json();
        renderMessages(data.messages || []);
        
        // Reload conversations to clear unread count
        await loadConversations();
    } catch (error) {
        console.error('Failed to load messages:', error);
    }
}

// Render messages
function renderMessages(messages) {
    const container = document.getElementById('messageContainer');
    container.innerHTML = '<div class="date-divider">Today</div>';
    
    messages.forEach(message => {
        addMessageToUI(message.direction, message.text, message.status || 'sent', false, message.audioUrl);
    });
    
    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
}

// Add message to UI
function addMessageToUI(direction, text, status = 'sent', scroll = true, audioUrl = null) {
    const container = document.getElementById('messageContainer');
    const now = new Date();
    
    const messageEl = document.createElement('div');
    messageEl.className = `message ${direction}`;
    
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    
    // Check if this is a voice message with audio URL
    if (audioUrl) {
        const audioContainer = document.createElement('div');
        audioContainer.className = 'audio-message';
        audioContainer.innerHTML = `
            <div class="audio-player">
                <button class="play-btn" onclick="toggleAudio(this)">
                    <svg class="play-icon" viewBox="0 0 24 24" width="24" height="24">
                        <path fill="currentColor" d="M8 5v14l11-7z"/>
                    </svg>
                    <svg class="pause-icon" viewBox="0 0 24 24" width="24" height="24" style="display:none">
                        <path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                    </svg>
                </button>
                <div class="audio-waveform">
                    <div class="waveform-progress"></div>
                </div>
                <span class="audio-duration">0:00</span>
                <audio src="${audioUrl}" preload="metadata"></audio>
            </div>
        `;
        bubble.appendChild(audioContainer);
        
        // Setup audio events after adding to DOM
        setTimeout(() => {
            const audio = audioContainer.querySelector('audio');
            const durationEl = audioContainer.querySelector('.audio-duration');
            const progressEl = audioContainer.querySelector('.waveform-progress');
            
            audio.addEventListener('loadedmetadata', () => {
                durationEl.textContent = formatAudioDuration(audio.duration);
            });
            
            audio.addEventListener('timeupdate', () => {
                const progress = (audio.currentTime / audio.duration) * 100;
                progressEl.style.width = progress + '%';
            });
            
            audio.addEventListener('ended', () => {
                const playBtn = audioContainer.querySelector('.play-btn');
                playBtn.querySelector('.play-icon').style.display = 'block';
                playBtn.querySelector('.pause-icon').style.display = 'none';
                progressEl.style.width = '0%';
            });
        }, 0);
    } else {
        const textEl = document.createElement('div');
        textEl.className = 'message-text';
        textEl.textContent = text;
        bubble.appendChild(textEl);
    }
    
    const timeEl = document.createElement('div');
    timeEl.className = 'message-time';
    
    let timeContent = formatMessageTime(now);
    
    if (direction === 'outbound') {
        const statusIcon = status === 'delivered' 
            ? '<svg class="checkmark" viewBox="0 0 16 15"><path fill="currentColor" d="M15.01 3.316l-.478-.372a.365.365 0 0 0-.51.063L8.666 9.879a.32.32 0 0 1-.484.033l-.358-.325a.319.319 0 0 0-.484.032l-.378.483a.418.418 0 0 0 .036.541l1.32 1.266c.143.14.361.125.484-.033l6.272-8.048a.366.366 0 0 0-.064-.512zm-4.1 0l-.478-.372a.365.365 0 0 0-.51.063L4.566 9.879a.32.32 0 0 1-.484.033L1.891 7.769a.366.366 0 0 0-.515.006l-.423.433a.364.364 0 0 0 .006.514l3.258 3.185c.143.14.361.125.484-.033l6.272-8.048a.365.365 0 0 0-.063-.51z"/></svg>'
            : '<svg class="checkmark" viewBox="0 0 16 15"><path fill="currentColor" d="M10.91 3.316l-.478-.372a.365.365 0 0 0-.51.063L4.566 9.879a.32.32 0 0 1-.484.033L1.891 7.769a.366.366 0 0 0-.515.006l-.423.433a.364.364 0 0 0 .006.514l3.258 3.185c.143.14.361.125.484-.033l6.272-8.048a.365.365 0 0 0-.063-.51z"/></svg>';
        timeContent += `<span class="message-status">${statusIcon}</span>`;
    }
    
    timeEl.innerHTML = timeContent;
    
    bubble.appendChild(timeEl);
    messageEl.appendChild(bubble);
    container.appendChild(messageEl);
    
    if (scroll) {
        container.scrollTop = container.scrollHeight;
    }
}

// Send message
async function sendMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    
    if (!text || !state.activeConversation) return;
    
    // Clear input
    input.value = '';
    input.style.height = 'auto';
    
    // Add message to UI immediately
    addMessageToUI('outbound', text, 'sent');
    
    // Send to server
    try {
        // Construct the WhatsApp message payload
        const payload = {
            from: state.senderNumber,
            to: state.activeConversation,
            message_type: 'text',
            text: text,
            channel: 'whatsapp'
        };
        
        const response = await fetch('/api/send-message', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                payload: payload,
                appId: state.credentials.appId,
                privateKey: state.credentials.privateKey
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            // Store message in conversation
            await fetch(`/api/conversations/${state.activeConversation}/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text: text,
                    messageId: result.message_uuid,
                    timestamp: new Date().toISOString(),
                    to: state.activeConversation
                })
            });
        } else {
            alert('Failed to send message: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Send message error:', error);
        alert('Failed to send message');
    }
}

// Load proxy settings
async function loadProxySettings() {
    try {
        const response = await fetch('/api/proxy');
        const data = await response.json();
        
        state.proxyEnabled = data.enabled;
        state.proxyNumber = data.proxyNumber || '';
        state.proxySender = data.proxySender || '';
        state.reportEndpoint = data.reportEndpoint || '';
        state.badNumber = data.badNumber || '';
        state.linkNumber = data.linkNumber || '';
        state.companyFraudNumber = data.companyFraudNumber || '';
        state.coworkerScamNumber = data.coworkerScamNumber || '';
        state.aiDecoyEnabled = data.aiDecoyEnabled || false;
        
        // Update form fields
        document.getElementById('proxyNumber').value = state.proxyNumber;
        document.getElementById('proxySender').value = state.proxySender;
        document.getElementById('reportEndpoint').value = state.reportEndpoint;
        document.getElementById('badNumber').value = state.badNumber;
        document.getElementById('linkNumber').value = state.linkNumber;
        document.getElementById('companyFraudNumber').value = state.companyFraudNumber;
        document.getElementById('coworkerScamNumber').value = state.coworkerScamNumber;
        document.getElementById('aiDecoyEnabled').checked = state.aiDecoyEnabled;
        
        // Show/hide decoy settings based on checkbox
        document.getElementById('aiDecoySettings').style.display = state.aiDecoyEnabled ? 'block' : 'none';
        
        updateProxyUI();
    } catch (error) {
        console.error('Failed to load proxy settings:', error);
    }
}

// Enable proxy
async function enableProxy() {
    const proxyNumber = document.getElementById('proxyNumber').value.trim();
    const proxySender = document.getElementById('proxySender').value.trim();
    const reportEndpoint = document.getElementById('reportEndpoint').value.trim();
    const badNumber = document.getElementById('badNumber').value.trim();
    const linkNumber = document.getElementById('linkNumber').value.trim();
    const companyFraudNumber = document.getElementById('companyFraudNumber').value.trim();
    const coworkerScamNumber = document.getElementById('coworkerScamNumber').value.trim();
    const aiDecoyEnabled = document.getElementById('aiDecoyEnabled').checked;
    const anthropicApiKey = document.getElementById('anthropicApiKey').value.trim();
    
    if (!proxyNumber) {
        alert('Please enter a proxy number');
        return;
    }
    
    if (!proxySender) {
        alert('Please enter your sender number');
        return;
    }
    
    if (!reportEndpoint) {
        alert('Please enter a report server endpoint');
        return;
    }
    
    // Validate AI Decoy settings if enabled
    if (aiDecoyEnabled && !anthropicApiKey) {
        alert('Please enter your Claude API key to enable AI Decoy');
        return;
    }
    
    if (aiDecoyEnabled && !badNumber) {
        alert('AI Decoy requires a Bad Number to be set');
        return;
    }
    
    // Save API key locally
    if (anthropicApiKey) {
        localStorage.setItem('anthropicApiKey', anthropicApiKey);
    }
    
    try {
        const response = await fetch('/api/proxy', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                proxyNumber: proxyNumber,
                proxySender: proxySender,
                reportEndpoint: reportEndpoint,
                badNumber: badNumber || null,
                linkNumber: linkNumber || null,
                companyFraudNumber: companyFraudNumber || null,
                coworkerScamNumber: coworkerScamNumber || null,
                aiDecoyEnabled: aiDecoyEnabled,
                anthropicApiKey: anthropicApiKey || null,
                appId: state.credentials.appId,
                privateKey: state.credentials.privateKey
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            state.proxyEnabled = data.enabled;
            state.proxyNumber = data.proxyNumber;
            state.proxySender = data.proxySender;
            state.reportEndpoint = data.reportEndpoint || '';
            state.badNumber = data.badNumber || '';
            state.linkNumber = data.linkNumber || '';
            state.companyFraudNumber = data.companyFraudNumber || '';
            state.coworkerScamNumber = data.coworkerScamNumber || '';
            state.aiDecoyEnabled = data.aiDecoyEnabled || false;
            updateProxyUI();
            
            let message = 'Proxy enabled! All inbound messages will be forwarded to ' + proxyNumber;
            const securityFeatures = [];
            if (badNumber) securityFeatures.push('Bad Number protection');
            if (linkNumber) securityFeatures.push('Link blocking');
            if (companyFraudNumber) securityFeatures.push('Company fraud detection');
            if (coworkerScamNumber) securityFeatures.push('Co-worker scam protection');
            if (aiDecoyEnabled) securityFeatures.push('AI Decoy (Walter)');
            
            if (securityFeatures.length > 0) {
                message += '\n\nSecurity features enabled: ' + securityFeatures.join(', ');
            }
            
            if (aiDecoyEnabled) {
                message += '\n\nWhen the Bad Number messages, you will receive ONE warning. After that, Walter (the AI) will handle all responses automatically.';
            }
            
            alert(message);
        }
    } catch (error) {
        console.error('Failed to enable proxy:', error);
        alert('Failed to enable proxy');
    }
}

// Disable proxy
async function disableProxy() {
    try {
        const response = await fetch('/api/proxy', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                proxyNumber: null,
                proxySender: null,
                badNumber: null,
                linkNumber: null,
                companyFraudNumber: null,
                coworkerScamNumber: null,
                aiDecoyEnabled: false
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            state.proxyEnabled = false;
            state.badNumber = '';
            state.linkNumber = '';
            state.companyFraudNumber = '';
            state.coworkerScamNumber = '';
            state.aiDecoyEnabled = false;
            updateProxyUI();
            alert('Proxy disabled');
        }
    } catch (error) {
        console.error('Failed to disable proxy:', error);
        alert('Failed to disable proxy');
    }
}

// Update proxy UI based on state
function updateProxyUI() {
    const statusText = document.getElementById('proxyStatusText');
    const enableBtn = document.getElementById('enableProxyBtn');
    const disableBtn = document.getElementById('disableProxyBtn');
    
    if (state.proxyEnabled) {
        let statusMessage = `Proxy: Enabled → +${state.proxyNumber}`;
        if (state.aiDecoyEnabled) {
            statusMessage += ' (AI Decoy Active)';
        }
        statusText.textContent = statusMessage;
        statusText.style.color = state.aiDecoyEnabled ? '#667eea' : '#00a884';
        enableBtn.style.display = 'none';
        disableBtn.style.display = 'block';
    } else {
        statusText.textContent = 'Proxy: Disabled';
        statusText.style.color = '#8696a0';
        enableBtn.style.display = 'block';
        disableBtn.style.display = 'none';
    }
}

// New chat modal
function openNewChatModal() {
    const modal = document.getElementById('newChatModal');
    modal.classList.add('active');
    
    // Pre-fill sender if saved
    if (state.senderNumber) {
        document.getElementById('newChatSender').value = state.senderNumber;
    }
    
    document.getElementById('newChatNumber').focus();
}

function startNewChat() {
    const recipientNumber = document.getElementById('newChatNumber').value.trim();
    const senderNumber = document.getElementById('newChatSender').value.trim();
    
    if (!recipientNumber) {
        alert('Please enter a recipient number');
        return;
    }
    
    if (!senderNumber) {
        alert('Please enter your sender number');
        return;
    }
    
    // Save sender number
    state.senderNumber = senderNumber;
    localStorage.setItem('senderNumber', senderNumber);
    
    // Close modal
    closeModal(document.getElementById('newChatModal'));
    
    // Open conversation (will create if doesn't exist)
    openConversation(recipientNumber);
}

function clearActiveChat() {
    if (confirm('Clear this conversation? (This only clears locally, not on the server)')) {
        const container = document.getElementById('messageContainer');
        container.innerHTML = '<div class="date-divider">Today</div>';
    }
}

function filterConversations() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    const items = document.querySelectorAll('.conversation-item');
    
    items.forEach(item => {
        const name = item.querySelector('.conversation-name').textContent.toLowerCase();
        const message = item.querySelector('.conversation-last-message p').textContent.toLowerCase();
        
        if (name.includes(searchTerm) || message.includes(searchTerm)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
}

function closeModal(modal) {
    modal.classList.remove('active');
}

function logout() {
    if (confirm('Are you sure you want to logout?')) {
        localStorage.removeItem('vonageCredentials');
        sessionStorage.removeItem('vonageCredentials');
        window.location.href = 'login.html';
    }
}

// Utility functions
function formatTime(date) {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    
    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    } else if (date.toDateString() === yesterday.toDateString()) {
        return 'Yesterday';
    } else {
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
}

function formatMessageTime(date) {
    return date.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Audio player functions
function toggleAudio(btn) {
    const audioContainer = btn.closest('.audio-player');
    const audio = audioContainer.querySelector('audio');
    const playIcon = btn.querySelector('.play-icon');
    const pauseIcon = btn.querySelector('.pause-icon');
    
    // Pause all other audio players
    document.querySelectorAll('.audio-player audio').forEach(a => {
        if (a !== audio && !a.paused) {
            a.pause();
            const otherBtn = a.closest('.audio-player').querySelector('.play-btn');
            otherBtn.querySelector('.play-icon').style.display = 'block';
            otherBtn.querySelector('.pause-icon').style.display = 'none';
        }
    });
    
    if (audio.paused) {
        audio.play();
        playIcon.style.display = 'none';
        pauseIcon.style.display = 'block';
    } else {
        audio.pause();
        playIcon.style.display = 'block';
        pauseIcon.style.display = 'none';
    }
}

function formatAudioDuration(seconds) {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}
