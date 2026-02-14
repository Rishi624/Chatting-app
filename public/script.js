const socket = io();

let cryptoKey = null;
let roomExpiryTime = null;
let timerInterval = null;
let isBurnMode = false;

const authView = document.getElementById('auth-view');
const chatView = document.getElementById('chat-view');
const duressView = document.getElementById('duress-view');
const statusMsg = document.getElementById('status-msg');
const messagesContainer = document.getElementById('messages-container');
const duressContainer = document.getElementById('duress-messages');

// --- 1. PRIVACY FEATURES ---

window.addEventListener('blur', () => {
    if(currentRoomId) document.body.style.filter = "blur(15px)";
});
window.addEventListener('focus', () => {
    document.body.style.filter = "none";
});
document.addEventListener('contextmenu', event => event.preventDefault());


// --- 2. CRYPTOGRAPHY (Web Crypto API) ---

function generateSalt() { 
    return window.crypto.getRandomValues(new Uint8Array(16)); 
}
function bufferToHex(buffer) {
    return [...new Uint8Array(buffer)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function deriveHash(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
    );
    const hashBits = await window.crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: salt, iterations: 50000, hash: "SHA-256" },
        keyMaterial, 256
    );
    return bufferToHex(hashBits);
}

async function deriveCryptoKey(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]
    );
    return window.crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
        keyMaterial, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
    );
}

// --- 3. ROOM MANAGEMENT ---

async function createRoom() {
    const roomId = document.getElementById('c-room').value;
    const passReal = document.getElementById('c-pass').value;
    const passDuress = document.getElementById('c-duress').value;

    if (!roomId || !passReal) return showStatus("❌ Enter Room ID & Real Password");

    showStatus("Generating Keys...");

    const salt = generateSalt();
    const verifierHash = await deriveHash(passReal, salt);
    const encryptionKey = await deriveCryptoKey(passReal, salt);
    
    let duressVerifierHash = null;
    if (passDuress) {
        duressVerifierHash = await deriveHash(passDuress, salt);
    }

    cryptoKey = encryptionKey;
    currentRoomId = roomId;

    socket.emit('create-room', { 
        roomId, 
        verifier: verifierHash, 
        duressVerifier: duressVerifierHash,
        salt: Array.from(salt) 
    });
}

function joinRoomInitiate() {
    const roomId = document.getElementById('j-room').value;
    if (!roomId) return showStatus("❌ Enter Room ID");
    showStatus("Connecting...");
    socket.emit('check-room', roomId);
}

socket.on('salt-response', async (saltArray) => {
    try {
        const password = document.getElementById('j-pass').value;
        const roomId = document.getElementById('j-room').value;
        
        if (!password) return showStatus("❌ Enter Password");

        const salt = new Uint8Array(saltArray);
        const attemptHash = await deriveHash(password, salt);
        
        cryptoKey = await deriveCryptoKey(password, salt);
        currentRoomId = roomId;

        socket.emit('join-verify', { roomId, passwordHashAttempt: attemptHash });
    } catch(e) {
        showStatus("❌ Crypto Error");
        console.error(e);
    }
});

socket.on('join-success', ({ mode, creationTime }) => {
    authView.classList.add('hidden');
    
    if (mode === 'real') {
        chatView.classList.remove('hidden');
        document.getElementById('room-label').innerText = currentRoomId;
        roomExpiryTime = creationTime + 3600000; // 1 Hour
        startTimer();
    } else {
        loadDuressMode();
    }
});

socket.on('room-created', ({ creationTime }) => {
    authView.classList.add('hidden');
    chatView.classList.remove('hidden');
    document.getElementById('room-label').innerText = currentRoomId;
    roomExpiryTime = creationTime + 3600000;
    startTimer();
});

socket.on('error-msg', (msg) => showStatus(msg));

// --- 4. CHAT LOGIC ---

function toggleBurnMode() {
    isBurnMode = !isBurnMode;
    const btn = document.getElementById('burn-btn');
    const text = document.getElementById('burn-text');
    
    if(isBurnMode) {
        btn.classList.add('active');
        text.innerText = "ON";
    } else {
        btn.classList.remove('active');
        text.innerText = "OFF";
    }
}

async function sendMessage() {
    const input = document.getElementById('msg-input');
    const txt = input.value;
    if (!txt) return;

    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(txt);
    const encrypted = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv }, cryptoKey, encoded
    );

    socket.emit('chat-message', {
        roomId: currentRoomId,
        content: Array.from(new Uint8Array(encrypted)),
        iv: Array.from(iv),
        isBurn: isBurnMode 
    });

    renderBubble(txt, true, isBurnMode, messagesContainer);
    input.value = '';
}

socket.on('receive-message', async (data) => {
    try {
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(data.iv) },
            cryptoKey,
            new Uint8Array(data.content)
        );
        const txt = new TextDecoder().decode(decrypted);
        
        renderBubble(txt, false, data.isBurn, messagesContainer);
    } catch (e) {
        console.error("Decryption failed or message corrupted");
    }
});

// --- 5. BUBBLE RENDERER (Handles Names, Alignment & Burn Logic) ---

function renderBubble(text, isMe, isBurn, container, senderNameOverride) {
    const row = document.createElement('div');
    row.className = `msg-row ${isMe ? 'row-you' : 'row-stranger'}`;

    const nameLabel = document.createElement('span');
    nameLabel.className = 'sender-name';
    
    if (senderNameOverride) {
        nameLabel.innerText = senderNameOverride;
    } else {
        nameLabel.innerText = isMe ? "You" : "Anonymous";
    }

    const bubble = document.createElement('div');
    bubble.className = `msg-bubble ${isMe ? 'msg-you' : 'msg-stranger'}`;
    
    if (isBurn) {
        bubble.classList.add('burn-msg');
        const fuseTimer = setTimeout(() => {
            if(row && row.parentNode) row.remove();
        }, 30000);

        bubble.onclick = () => {
            if (bubble.classList.contains('revealed')) return;
            
            clearTimeout(fuseTimer);
            
            bubble.classList.add('revealed');
            bubble.innerText = text;

            setTimeout(() => {
                if(row && row.parentNode) row.remove();
            }, 10000);
        };
    } else {
        bubble.innerText = text;
    }

    row.appendChild(nameLabel);
    row.appendChild(bubble);
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
}

// --- 6. DURESS MODE (FAKE CHAT) ---

function loadDuressMode() {
    duressView.classList.remove('hidden');
    
    renderBubble("Did you get the groceries?", false, false, duressContainer, "Mom");
    renderBubble("Yeah, putting them away.", true, false, duressContainer, "You");
    renderBubble("Ok, call me later.", false, false, duressContainer, "Mom");
}

function sendFakeMessage() {
    const input = document.getElementById('fake-input');
    const txt = input.value;
    if(!txt) return;

    renderBubble(txt, true, false, duressContainer, "You");
    input.value = "";

    setTimeout(() => {
        const replies = ["Okay.", "Sure.", "I will.", "Sounds good.", "Got it.", "Call me."];
        const randomReply = replies[Math.floor(Math.random() * replies.length)];
        renderBubble(randomReply, false, false, duressContainer, "Mom");
    }, 1500); 
}

// --- 7. UTILITIES ---

function nukeRoom() {
    if(confirm("⚠️ DESTROY ROOM?\nThis will permanently delete data for ALL users.")) {
        socket.emit('destroy-room', currentRoomId);
    }
}

socket.on('force-disconnect', () => {
    alert("⛔ Room Destroyed by Admin.");
    window.location.reload();
});

function startTimer() {
    const display = document.getElementById('timer-display');
    timerInterval = setInterval(() => {
        const left = roomExpiryTime - Date.now();
        if (left <= 0) {
            clearInterval(timerInterval);
            alert("Room Expired"); 
            window.location.reload();
            return;
        }
        
        const m = Math.floor(left / 60000);
        const s = Math.floor((left % 60000) / 1000);
        display.innerText = `${m}:${s.toString().padStart(2, '0')}`;
        
        if (left < 300000) display.style.color = "#ff6b6b"; // Red if < 5 mins
    }, 1000);
}

function showStatus(msg) { 
    statusMsg.innerText = msg; 
}

window.switchTab = function(tab) {
    document.getElementById('form-create').classList.add('hidden');
    document.getElementById('form-join').classList.add('hidden');
    document.getElementById(`form-${tab}`).classList.remove('hidden');
    
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');
    statusMsg.innerText = "";
};