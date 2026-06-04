// ================================================================
// HOWAPP — Core Application Logic
// Peer-to-Peer Communication App (Text, Audio, Video)
// ================================================================

// ===== State =====
let myPeer = null;
let myId = '';
let roomId = '';
let nickname = '';
let isHost = false;
let hostPeerId = '';
let peers = {};
let myStream = null;
let callActive = false;
let callMicOn = true;
let callCamOn = true;
let callType = null;
let activeCalls = {};
let hostChanged = false;
let hostPingTimer = null;
let heartbeatInterval = null;
let typingTimer = null;
let typingPeers = {};
let recMedia = null;
let recChunks = [];
let myPeerId = '';
let screenStream = null;
let screenSharing = false;
let screenCallMap = {};

// ===== DOM helpers =====
const $ = id => document.getElementById(id);
const show = id => $(id).classList.add('active');
const hide = id => $(id).classList.remove('active');

// ===== Emoji data =====
const EMOJIS = ['😀','😂','🥹','😍','🤩','😎','🥳','😇','🤗','🫡','👍','👏','🙏','❤️','🔥','✨','💪','🎉','🤝','👋','✅','⭐','💬','📹','🎙️','📷','🎵','💬','🌍','🙌'];

// ===== Init =====
function init() {
    const params = new URLSearchParams(location.search);
    const roomFromUrl = params.get('room');
    const nickFromUrl = params.get('nick');
    if (roomFromUrl) {
        $('room-link').value = roomFromUrl;
    }
    if (nickFromUrl) {
        $('nickname').value = decodeURIComponent(nickFromUrl).substring(0, 20);
    }

    const picker = $('emoji-picker');
    picker.innerHTML = EMOJIS.map(e => `<button onclick="insertEmoji('${e}')">${e}</button>`).join('');

    if (roomFromUrl) {
        setTimeout(() => joinRoom(), 300);
    }

    $('nickname').onkeydown = e => { if (e.key === 'Enter') createRoom(); };
    $('room-link').onkeydown = e => { if (e.key === 'Enter') joinRoom(); };

    const messages = $('messages');
    messages.addEventListener('dragover', e => { e.preventDefault(); messages.style.border = '2px dashed var(--accent)'; });
    messages.addEventListener('dragleave', () => { messages.style.border = ''; });
    messages.addEventListener('drop', e => {
        e.preventDefault();
        messages.style.border = '';
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) sendImageFile(file);
        else if (file) sendFileFile(file);
    });

    document.addEventListener('click', e => {
        if (!$('emoji-picker').contains(e.target) && e.target.id !== 'emoji-btn') {
            $('emoji-picker').classList.remove('show');
        }
    });
}

// ===== Room ID generation =====
function genRoomId() {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let r = '';
    for (let i = 0; i < 8; i++) r += c[Math.floor(Math.random() * c.length)];
    return r;
}

function sanitizeForPeer(str) {
    return str.toLowerCase()
        .replace(/[^a-z0-9\-_]/g, '')
        .substring(0, 20);
}

function makeMemberId(roomId, nickname) {
    const safeRoom = sanitizeForPeer(roomId);
    const safeNick = sanitizeForPeer(nickname);
    const unique = Math.random().toString(36).substring(2, 8);
    return safeRoom + '-' + safeNick + '-' + unique;
}

function extractRoomId(input) {
    input = input.trim().toLowerCase();
    if (input.includes('room=')) {
        const m = input.match(/[?&]room=([a-z0-9]+)/i);
        if (m) return m[1];
    }
    if (input.includes('/room/')) {
        const m = input.split('/room/')[1]?.split(/[?# ]/)[0];
        if (m) return m.toLowerCase();
    }
    const clean = input.replace(/[^a-z0-9]/g, '');
    if (clean.length >= 4) return clean;
    return null;
}

// ===== Room entry =====
async function createRoom() {
    nickname = $('nickname').value.trim() || 'Anônimo';
    roomId = genRoomId().toLowerCase();
    window._wantToBeHost = true;
    hide('join-screen');
    show('loading-screen');
    $('loading-text').textContent = 'Criando sala ' + roomId.toUpperCase() + '...';

    try {
        const result = await setupPeer();
        isHost = result.host;
        hostPeerId = roomId;
        hide('loading-screen');
        show('room-screen');
        $('room-id-display').textContent = `Sala: ${roomId.toUpperCase()} • ${isHost ? 'Você é o anfitrião' : 'Conectado'}`;
        updateShareLink();
        addSystem(isHost ? `🏠 Sala criada: ${roomId.toUpperCase()}` : `🏠 Você se juntou à sala: ${roomId.toUpperCase()}`);
        addSystem(`👋 Bem-vindo, ${nickname}!`);
        if (isHost) {
            updateOnline();
        } else {
            connectToHost();
        }
    } catch (err) {
        console.error('Create room error:', err);
        showToast('Erro ao criar sala: ' + err.message, true);
        show('join-screen');
    }
}

async function joinRoom() {
    const _nickFromUrl = new URLSearchParams(location.search).get('nick');
    nickname = $('nickname').value.trim()
        || (_nickFromUrl ? decodeURIComponent(_nickFromUrl).substring(0, 20).trim() : '')
        || 'Anônimo';
    const input = $('room-link').value.trim();
    const id = extractRoomId(input);
    if (!id) {
        showToast('ID inválido. Use letras minúsculas e números (mínimo 4 caracteres).', true);
        return;
    }

    roomId = id;
    window._wantToBeHost = false;
    hide('join-screen');
    show('loading-screen');
    $('loading-text').textContent = 'Conectando à sala ' + roomId.toUpperCase() + '...';

    try {
        const result = await setupPeer();
        isHost = result.host;
        hostPeerId = roomId;
        hide('loading-screen');
        show('room-screen');
        $('room-id-display').textContent = `Sala: ${roomId.toUpperCase()}`;
        updateShareLink();
        addSystem(`🔗 Entrou na sala: ${roomId.toUpperCase()}`);
        addSystem(`👋 Bem-vindo, ${nickname}!`);
        if (isHost) {
            addSystem('🏠 Você se tornou o anfitrião da sala');
        } else {
            connectToHost();
        }
    } catch (err) {
        console.error('Join room error:', err);
        showToast('Erro ao conectar à sala. Verifique se o ID está correto.', true);
        show('join-screen');
    }
}

// ===== Chat =====
function sendMessage() {
    const inp = $('msg-input');
    const text = inp.value.trim();
    if (!text) return;

    addChat(nickname, escapeHtml(text), 'sent');
    if (isHost) {
        broadcastRelay('message', { text: text });
    } else {
        sendToHost('message', { text: text });
    }
    inp.value = '';
    inp.style.height = 'auto';
    if (isHost) {
        broadcastRelay('stop-typing', {});
    } else {
        sendToHost('stop-typing', {});
    }
    $('typing-indicator').textContent = '';
}

function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

function addChat(sender, content, type) {
    const c = $('messages');
    const d = document.createElement('div');
    d.className = `message ${type}`;
    if (type !== 'system') {
        const s = document.createElement('div');
        s.className = 'sender';
        s.textContent = sender;
        d.appendChild(s);
    }
    const inner = document.createElement('div');
    if (typeof content === 'string' && /^<(img|div|a|span)\b/i.test(content.trimStart())) {
        inner.innerHTML = typeof DOMPurify !== 'undefined'
            ? DOMPurify.sanitize(content, { ALLOW_TAGS: ['img','div','a','span','br'], ALLOW_ATTR: ['class','src','alt','href','download','style'] })
            : content;
    } else {
        inner.textContent = content ?? '';
    }
    d.appendChild(inner);
    const t = document.createElement('div');
    t.className = 'time';
    t.textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    d.appendChild(t);
    c.appendChild(d);
    c.scrollTop = c.scrollHeight;
}

function addSystem(text) {
    addChat('', text, 'system');
}

// ===== Media =====
function sendImage() { $('file-input').click(); }

function sendImageFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
        addChat(nickname, `<img class="media" src="${e.target.result}" alt="Imagem">`, 'sent');
        if (isHost) {
            broadcastRelay('image', { data: e.target.result });
        } else {
            sendToHost('image', { data: e.target.result });
        }
    };
    reader.readAsDataURL(file);
}

function sendFile() { $('file-input').click(); }

function sendFileFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
        addChat(nickname, `<div>📄 ${file.name} (${formatBytes(file.size)})</div>
            <a href="${e.target.result}" download="${file.name}" style="color:var(--accent2);font-size:12px;">⬇️ Baixar</a>`, 'sent');
        const payload = { name: file.name, size: file.size, data: e.target.result, type: file.type };
        if (isHost) {
            broadcastRelay('file', payload);
        } else {
            sendToHost('file', payload);
        }
    };
    reader.readAsDataURL(file);
}

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.type.startsWith('image/')) {
        sendImageFile(file);
    } else {
        sendFileFile(file);
    }
    event.target.value = '';
}

// ===== Voice Recording =====
function startVoiceRecording() {
    if (recMedia) {
        stopVoiceRecording();
        return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
            recMedia = new MediaRecorder(stream);
            recChunks = [];
            recMedia.ondataavailable = e => {
                if (e.data.size > 0) recChunks.push(e.data);
            };
            recMedia.onstop = () => {
                const blob = new Blob(recChunks, { type: 'audio/webm' });
                const url = URL.createObjectURL(blob);
                const tempAudio = new Audio(url);
                tempAudio.addEventListener('loadedmetadata', () => {
                    const duration = Math.round(tempAudio.duration);
                    const reader = new FileReader();
                    reader.onload = () => {
                        addChat(nickname, '<div class="audio-recording">🎙️ Áudio enviado</div>', 'sent');
                        if (isHost) { broadcastRelay('voice', { audio: reader.result, duration: duration }); } else { sendToHost('voice', { audio: reader.result, duration: duration }); }
                    };
                    reader.readAsDataURL(blob);
                    stream.getTracks().forEach(t => t.stop());
                    URL.revokeObjectURL(url);
                });
                tempAudio.addEventListener('error', () => {
                    const duration = Math.round(recChunks.reduce((a, b) => a + b.size, 0) / 16000);
                    const reader = new FileReader();
                    reader.onload = () => {
                        addChat(nickname, '<div class="audio-recording">🎙️ Áudio enviado</div>', 'sent');
                        if (isHost) { broadcastRelay('voice', { audio: reader.result, duration: duration }); } else { sendToHost('voice', { audio: reader.result, duration: duration }); }
                    };
                    reader.readAsDataURL(blob);
                    stream.getTracks().forEach(t => t.stop());
                    URL.revokeObjectURL(url);
                });
                recMedia = null;
                recChunks = [];
                $('rec-indicator').classList.remove('show');
                $('voice-btn').classList.remove('active');
            };
            recMedia.start();
            $('rec-indicator').classList.add('show');
            $('voice-btn').classList.add('active');
        })
        .catch(err => {
            console.error('Mic error:', err);
            showToast('Permita acesso ao microfone.', true);
        });
}

function stopVoiceRecording() {
    if (recMedia && recMedia.state !== 'inactive') {
        recMedia.stop();
    }
}

function playVoiceMessage(data) {
    const audio = new Audio(data);
    audio.play().catch(e => console.error('Play error:', e));
}

// ===== Typing Indicator =====
function handleTyping() {
    clearTimeout(typingTimer);
    if (isHost) {
        broadcastRelay('typing', {});
    } else {
        sendToHost('typing', {});
    }
    typingTimer = setTimeout(() => {
        if (isHost) { broadcastRelay('stop-typing', {}); } else { sendToHost('stop-typing', {}); }
    }, 2000);
}

function handleTypingIndicator(fromPeer, isTyping) {
    const info = peers[fromPeer];
    const nick = info?.nick || fromPeer.substring(0, 6);
    if (isTyping) {
        typingPeers[fromPeer] = Date.now();
        const others = Object.keys(typingPeers).filter(p => p !== myId);
        if (others.length > 0) {
            $('typing-indicator').textContent = others.map(p => (peers[p]?.nick || p.substring(0, 6))).join(', ') + ' está digitando...';
        }
    } else {
        delete typingPeers[fromPeer];
        if (Object.keys(typingPeers).length === 0) {
            $('typing-indicator').textContent = '';
        }
    }
}

function handleInputKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 100) + 'px';
}

// ===== Emoji Picker =====
function toggleEmojiPicker() {
    $('emoji-picker').classList.toggle('show');
}

function insertEmoji(emoji) {
    const inp = $('msg-input');
    inp.value += emoji;
    inp.focus();
    $('emoji-picker').classList.remove('show');
}

// ===== Share =====
function updateShareLink() {
    const shareUrl = `${location.origin}${location.pathname}?room=${roomId}`;
    $('share-link').value = shareUrl;
    const url = new URL(location);
    url.searchParams.set('room', roomId);
    history.replaceState(null, '', url);
}

function copyShareLink() {
    const inp = $('share-link');
    inp.select();
    navigator.clipboard?.writeText(inp.value).then(() => {
        showToast('Link copiado!');
    }).catch(() => {
        document.execCommand('copy');
        showToast('Link copiado!');
    });
}

function copyRoomId() {
    navigator.clipboard?.writeText(roomId).then(() => {
        showToast(`ID ${roomId.toUpperCase()} copiado!`);
    }).catch(() => {
        showToast(`ID: ${roomId.toUpperCase()}`);
    });
}

function generateInviteLink() {
    const name = $('invite-name').value.trim();
    if (!name) { showToast('Digite o nome do convidado.', true); return; }
    const url = `${location.origin}${location.pathname}?room=${roomId}&nick=${encodeURIComponent(name)}`;
    $('invite-link-out').value = url;
    $('invite-result').classList.add('show');
    navigator.clipboard?.writeText(url).then(() => {
        showToast(`Link para ${name} copiado!`);
    }).catch(() => {
        $('invite-link-out').select();
        document.execCommand('copy');
        showToast(`Link para ${name} copiado!`);
    });
}

function copyInviteLink() {
    const inp = $('invite-link-out');
    navigator.clipboard?.writeText(inp.value).then(() => {
        showToast('Link de convite copiado!');
    }).catch(() => {
        inp.select();
        document.execCommand('copy');
        showToast('Link de convite copiado!');
    });
}

// ===== UI Updates =====
function showRoom() {
    hide('join-screen');
    show('room-screen');
    $('room-id-display').textContent = 'Sala: ' + roomId.toUpperCase();
    updateShareLink();
    updateOnline();
    updateCallUI();
}

function updateOnline() {
    const members = isHost
        ? Object.values(peers).filter(p => p.isMember).length
        : Object.values(peers).filter(p => p.isMember && p.nick).length;
    const total = isHost ? 1 + members : 1 + members + 1;
    $('online-count').textContent = `${total} online${total > 1 ? 's' : ''}`;
}

function leaveRoom() {
    const hostInfo = peers[hostPeerId];
    if (hostInfo?.conn?.open) {
        try {
            hostInfo.conn.send({
                type: 'leave',
                nickname: nickname,
                roomId: roomId
            });
        } catch(e) {}
    }

    addSystem('Você saiu da sala');

    for (const pid of Object.keys(activeCalls)) {
        try { activeCalls[pid].pc?.close(); } catch (e) {}
    }
    activeCalls = {};
    if (myStream) { myStream.getTracks().forEach(t => t.stop()); myStream = null; }
    callActive = false;
    removeSelfVideo();
    $('video-grid').querySelectorAll('.video-card').forEach(v => v.remove());

    if (hostPingTimer) {
        clearInterval(hostPingTimer);
        hostPingTimer = null;
    }

    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    screenSharing = false;
    screenCallMap = {};

    if (myPeer) {
        myPeer.destroy();
        myPeer = null;
    }
    peers = {};
    activeCalls = {};
    isHost = false;

    show('join-screen');
    showToast('Saiu da sala');
}

function toggleParticipants() {
    const count = Object.keys(peers).length + (isHost ? 1 : 1);
    showToast(`${count} participantes`);
}

// ===== Utilities =====
function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

function showToast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ===== Start =====
init();
