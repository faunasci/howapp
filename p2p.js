// ================================================================
// HOWAPP — Peer-to-Peer & WebRTC Logic
// Signaling, connections, calls, screen sharing
// ================================================================

const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        // TURN UDP (padrão)
        { urls: 'turn:openrelay.metered.ca:3478', username: 'openrelay2', credential: 'openrelay' },
        // TURN TCP (firewalls restritivos)
        { urls: 'turn:openrelay.metered.ca:3478?transport=tcp', username: 'openrelay2', credential: 'openrelay' },
        // TURN TLS (redes corporativas que bloqueiam UDP e TCP não-padrão)
        { urls: 'turns:openrelay.metered.ca:443', username: 'openrelay2', credential: 'openrelay' },
    ],
    iceCandidatePoolSize: 10
};

// ===== Video Quality Profiles =====
const VIDEO_CONSTRAINTS = {
    high: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
    medium: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 24 } },
    low: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 15 } },
};
const VIDEO_BITRATES = { high: 1500000, medium: 800000, low: 400000 };
const SCREEN_BITRATES = { high: 2500000, medium: 1500000, low: 800000 };
let currentVideoQuality = 'medium';

// Fila de ICE candidates para evitar race conditions
const pendingIceCandidates = {};
const pendingScreenIceCandidates = {};

// Aplica limite de bitrate nos senders de vídeo
async function applyVideoBitrate(pc, maxBitrate) {
    if (!pc || pc.signalingState === 'closed') return;
    const senders = pc.getSenders();
    for (const sender of senders) {
        if (sender.track?.kind !== 'video') continue;
        try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = maxBitrate;
            await sender.setParameters(params);
        } catch (e) {
            console.warn('Bitrate limit error:', e);
        }
    }
}

// Ajusta qualidade de todas as chamadas ativas baseado na conexão
function adaptVideoQuality(quality) {
    if (quality === currentVideoQuality) return;
    currentVideoQuality = quality;
    const bitrate = VIDEO_BITRATES[quality];
    for (const [, callData] of Object.entries(activeCalls)) {
        if (callData.pc) applyVideoBitrate(callData.pc, bitrate);
    }
    const screenBitrate = SCREEN_BITRATES[quality];
    for (const [, callData] of Object.entries(screenCallMap)) {
        if (callData.pc) applyVideoBitrate(callData.pc, screenBitrate);
    }
    console.log('Video quality adapted to:', quality);
}

// Drena fila de ICE candidates pendentes
async function drainPendingIce(fromPeer, pc, queue) {
    const candidates = queue[fromPeer];
    if (!candidates || candidates.length === 0) return;
    for (const candidate of candidates) {
        try {
            await pc.addIceCandidate(candidate);
        } catch (e) {
            console.warn('Pending ICE candidate error:', e);
        }
    }
    delete queue[fromPeer];
}

// ===== Setup PeerJS =====
async function setupPeer() {
    if (!window.Peer) {
        await loadScript('https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js');
    }

    return new Promise((resolve, reject) => {
        const attemptHost = window._wantToBeHost;
        let settled = false;

        let peerId;
        if (attemptHost) {
            peerId = roomId;
        } else {
            peerId = makeMemberId(roomId, nickname);
        }

        function createPeer(id, isHostAttempt) {
            const peer = new Peer(id, {
                debug: 2,
                config: ICE_SERVERS
            });

            myPeer = peer;
            myId = id;

            peer.on('connection', (conn) => {
                if (isHostAttempt) {
                    handleIncomingConnection(conn);
                }
            });

            peer.on('open', () => {
                if (settled) return;
                settled = true;
                console.log('Peer connected with ID:', myId, 'role:', isHostAttempt ? 'host' : 'member');
                resolve({ host: isHostAttempt });
            });

            peer.on('error', (err) => {
                console.error('Peer error:', err);
                if (isHostAttempt && (err.type === 'unavailable-id' || err.type === 'invalid-id')) {
                    console.log('Host ID taken, switching to member role...');
                    peer.destroy();
                    const memberId = makeMemberId(roomId, nickname);
                    createPeer(memberId, false);
                } else if (!settled) {
                    settled = true;
                    reject(err);
                }
            });

            peer.on('disconnected', () => {
                console.log('Disconnected from signaling, reconnecting...');
                setTimeout(() => {
                    if (myPeer && !myPeer.destroyed) {
                        myPeer.reconnect();
                    }
                }, 2000);
            });
        }

        createPeer(peerId, attemptHost);

        setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error('Connection timeout'));
            }
        }, 15000);
    });
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

// ===== Host: Handle Incoming Connections =====
function handleIncomingConnection(conn) {
    console.log('Incoming connection from member:', conn.peer);

    peers[conn.peer] = { nick: null, conn: conn, isMember: true };
    updateOnline();

    conn.on('data', (data) => {
        handleMessage(data, conn.peer);
    });

    conn.on('close', () => {
        handlePeerLeft(conn.peer);
    });

    conn.on('error', (err) => {
        console.error('Connection error:', err);
    });
}

// ===== Member: Connect to Host =====
let reconnectAttempts = 0;
function connectToHost() {
    if (!myPeer || myPeer.disconnected) return;
    console.log('Member connecting to host:', hostPeerId);
    const conn = myPeer.connect(hostPeerId, {
        reliable: true,
        metadata: { peerId: myId, nickname: nickname, roomId: roomId }
    });

    conn.on('open', () => {
        console.log('Connected to host');
        reconnectAttempts = 0;
        if (!peers[hostPeerId]) {
            peers[hostPeerId] = { nick: null, conn: conn, isMember: false };
        } else {
            peers[hostPeerId].conn = conn;
        }
        clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (conn.open) {
                try { conn.send({ type: 'ping', senderId: myId }); } catch(e) {}
            } else {
                clearInterval(heartbeatInterval);
            }
        }, 20000);
        conn.send({
            type: 'handshake',
            peerId: myId,
            nickname: nickname,
            roomId: roomId,
            timestamp: Date.now()
        });
    });

    conn.on('data', (data) => {
        handleMessage(data, hostPeerId);
    });

    conn.on('close', () => {
        console.log('Connection to host lost');
        clearInterval(heartbeatInterval);
        // Limpar referência ao host antigo para discoverNewHost funcionar
        if (peers[hostPeerId]) delete peers[hostPeerId];
        scheduleReconnect();
    });

    conn.on('error', (err) => {
        console.error('Host connection error:', err);
        clearInterval(heartbeatInterval);
        scheduleReconnect();
    });
}

function scheduleReconnect() {
    if (!myPeer || myPeer.destroyed || isHost) return;
    reconnectAttempts++;
    if (reconnectAttempts > 10) {
        // Tentar descobrir novo host entre os membros conhecidos
        discoverNewHost();
        return;
    }
    // Se o host original falhou 3 vezes, tentar descobrir novo host mais cedo
    if (reconnectAttempts === 3) {
        discoverNewHost();
        return;
    }
    const delay = Math.min(2000 * Math.pow(1.5, reconnectAttempts - 1), 30000);
    console.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts}/10)...`);
    setTimeout(() => {
        if (myPeer && !myPeer.destroyed && !isHost) {
            connectToHost();
        }
    }, delay);
}

function discoverNewHost() {
    // Calcular quem seria o novo host (primeiro peerID sorted)
    const sorted = [...Object.keys(peers), myId].sort();
    const newHostId = sorted[0];

    if (newHostId === myId) {
        // Somos o novo host
        addSystem('📌 Você é o novo anfitrião');
        promoteToHost();
        return;
    }

    // Verificar se temos conexão com o novo host
    const newHostInfo = peers[newHostId];
    if (newHostInfo?.conn?.open) {
        addSystem(`🔍 Conectando ao novo anfitrião: ${newHostInfo.nick || newHostId}`);
        hostPeerId = newHostId;
        reconnectAttempts = 0;
        connectToHost();
        return;
    }

    // Não temos conexão direta — tentar conectar diretamente ao peerID do novo host
    // (o novo host pode ainda ter seu peer aberto e receber novas conexões)
    addSystem(`🔍 Tentando conectar diretamente ao novo anfitrião...`);
    hostPeerId = newHostId;
    reconnectAttempts = 0;
    // Limpar conexão antiga que está fechada
    if (peers[hostPeerId]) delete peers[hostPeerId];
    connectToHost();
}

// ===== Member: Send message to host (who relays to everyone) =====
function sendToHost(type, extra) {
    const hostInfo = peers[hostPeerId];
    if (hostInfo?.conn?.open) {
        try {
            hostInfo.conn.send({
                type: type,
                senderId: myId,
                roomId: roomId,
                payload: { ...extra, nickname: nickname }
            });
        } catch(e) { console.warn('Host send failed:', e); }
    }
}

// ===== Message Handling & Relay =====
function handleMessage(data, fromPeer) {
    if (!data || !data.type) return;

    switch (data.type) {
        case 'handshake':
            if (!peers[fromPeer]) {
                peers[fromPeer] = { nick: data.nickname, conn: peers[fromPeer]?.conn || null, isMember: true };
            } else {
                peers[fromPeer].nick = data.nickname;
            }
            addSystem(`👋 ${data.nickname} entrou na sala`);
            updateOnline();
            console.log('New member:', data.nickname, '(', fromPeer, ')');
            {
                const existingMembers = Object.entries(peers)
                    .filter(([pid, info]) => pid !== fromPeer && info.nick)
                    .map(([pid, info]) => ({ peerId: pid, nickname: info.nick, isMember: true }));
                existingMembers.push({ peerId: myId, nickname: nickname, isMember: false });
                if (peers[fromPeer]?.conn?.open) {
                    try {
                        peers[fromPeer].conn.send({
                            type: 'member-list',
                            senderId: myId,
                            members: existingMembers
                        });
                    } catch(e) { console.warn('member-list send failed:', e); }
                }
            }
            broadcastRelay('member-joined', { peerId: fromPeer, nickname: data.nickname });
            break;

        case 'member-list':
            for (const m of (data.members || [])) {
                if (m.peerId !== myId && !peers[m.peerId]) {
                    peers[m.peerId] = { nick: m.nickname, conn: null, isMember: m.isMember !== false };
                }
            }
            updateOnline();
            updateCallUI();
            break;

        case 'member-joined':
            if (data.peerId !== myId && data.nickname) {
                addSystem(`👋 ${data.nickname} entrou na sala`);
                updateOnline();
                updateCallUI();
            }
            if (!peers[data.peerId]) {
                peers[data.peerId] = { nick: data.nickname, conn: null, isMember: true };
            }
            if (data.peerId === hostPeerId && !peers[hostPeerId]) {
                peers[hostPeerId] = { nick: data.nickname, conn: null, isMember: false };
            }
            break;

        case 'message':
            {
                if (data.senderId === myId) break;
                const msgNick = data.payload.nickname || peers[data.senderId]?.nick || data.senderId.substring(0, 6);
                addChat(msgNick, data.payload.text, 'received');
                broadcastRelay('message', { text: data.payload.text, nickname: msgNick }, data.senderId);
            }
            break;

        case 'image':
            {
                const imgNick = data.payload.nickname || peers[data.senderId]?.nick || data.senderId.substring(0, 6);
                addChat(imgNick,
                    `<img class="media" src="${data.payload.data}" alt="Imagem">`, 'received');
                broadcastRelay('image', { data: data.payload.data, nickname: imgNick }, data.senderId);
            }
            break;

        case 'file':
            {
                const fileNick = data.payload.nickname || peers[data.senderId]?.nick || data.senderId.substring(0, 6);
                addChat(fileNick,
                    `<div>📄 ${data.payload.name} (${formatBytes(data.payload.size)})</div>
                     <a href="${data.payload.data}" download="${data.payload.name}" style="color:var(--accent2);font-size:12px;">⬇️ Baixar</a>`,
                    'received');
                broadcastRelay('file', { name: data.payload.name, size: data.payload.size, data: data.payload.data, type: data.payload.type, nickname: fileNick }, data.senderId);
            }
            break;

        case 'voice':
            {
                if (data.senderId === myId) break;
                const voiceNick = data.payload.nickname || peers[data.senderId]?.nick || data.senderId.substring(0, 6);
                addVoiceChat(voiceNick, data.payload.audio, data.payload.duration, 'received');
                broadcastRelay('voice', { audio: data.payload.audio, duration: data.payload.duration, nickname: voiceNick }, data.senderId);
            }
            break;

        case 'stop-typing':
            broadcastRelay('stop-typing', {});
            break;

        case 'leave':
            if (fromPeer !== myId) handlePeerLeft(fromPeer);
            break;

        case 'typing':
            broadcastRelay('typing', {});
            break;

        case 'relay-message':
            if (data.senderId !== myId) {
                switch (data.payload.type) {
                    case 'message':
                        addChat(data.payload.nickname || data.senderId.substring(0, 6), data.payload.text, 'received');
                        break;
                    case 'image':
                        if (data.senderId === myId) break; // Skip own relayed image messages (already added in app.js)
                        addChat(data.payload.nickname || data.senderId.substring(0, 6),
                            `<img class="media" src="${data.payload.data}" alt="Imagem">`, 'received');
                        break;
                    case 'file':
                        if (data.senderId === myId) break; // Skip own relayed file messages (already added in app.js)
                        addChat(data.payload.nickname || data.senderId.substring(0, 6),
                            `<div>📄 ${data.payload.name} (${formatBytes(data.payload.size)})</div>
                             <a href="${data.payload.data}" download="${data.payload.name}" style="color:var(--accent2);font-size:12px;">⬇️ Baixar</a>`,
                            'received');
                        break;
                    case 'voice':
                        {
                            if (data.senderId === myId) break;
                            const voiceNick = data.payload.nickname || data.senderId.substring(0, 6);
                            addVoiceChat(voiceNick, data.payload.audio, data.payload.duration, 'received');
                        }
                        break;
                    case 'typing':
                        handleTypingIndicator(data.senderId, true);
                        break;
                    case 'stop-typing':
                        handleTypingIndicator(data.senderId, false);
                        break;
                    case 'member-left':
                        if (data.payload.nickname && data.payload.nickname !== nickname) {
                            addSystem(`👋 ${data.payload.nickname} saiu da sala`);
                        }
                        if (data.payload.peerId) handlePeerLeft(data.payload.peerId);
                        break;
                    case 'member-joined':
                        {
                            const jPeerId = data.payload.peerId;
                            const jNick = data.payload.nickname;
                            if (jPeerId && jPeerId !== myId) {
                                if (!peers[jPeerId]) {
                                    peers[jPeerId] = { nick: jNick, conn: null, isMember: true };
                                } else {
                                    peers[jPeerId].nick = jNick;
                                }
                                if (jNick && jNick !== nickname) {
                                    addSystem(`👋 ${jNick} entrou na sala`);
                                }
                                updateOnline();
                                updateCallUI();
                            }
                        }
                        break;
                    case 'screen-ended':
                        {
                            const seSender = data.senderId;
                            if (seSender && seSender !== myId) {
                                stopScreenShareTo(seSender);
                                addSystem(`🖥️ ${peers[seSender]?.nick || 'Alguém'} parou de compartilhar a tela`);
                            }
                        }
                        break;
                }
            }
            break;

        case 'relay-call-offer':
            if (isHost && data.senderId !== myId) {
                relayCallSignal(data.type, data);
            }
            if (data.targetId === myId || !data.targetId) {
                handleRemoteOffer(data.senderId, data.payload.sdp, data.payload);
            }
            break;

        case 'relay-call-answer-sdp':
            if (isHost && data.senderId !== myId) {
                relayCallSignal(data.type, data);
            }
            if (data.targetId === myId || !data.targetId) {
                handleRemoteAnswer(data.senderId, data.payload.sdp);
            }
            break;

        case 'relay-ice-candidate':
            if (isHost && data.senderId !== myId) {
                relayCallSignal(data.type, data);
            }
            if (data.targetId === myId || !data.targetId) {
                handleIceCandidate(data.senderId, data.payload.candidate);
            }
            break;

        case 'relay-call-ended':
            if (isHost && data.senderId !== myId) {
                relayCallSignal(data.type, data);
            }
            if (data.targetId === myId || !data.targetId) {
                endCallTo(data.senderId);
            }
            break;

        case 'host-ping-response':
            break;

        case 'host-vacated':
            if (data.senderId !== myId) {
                if (Object.keys(peers).length === 0) {
                    addSystem('⚠️ Sem anfitrião — promovendo para anfitrião');
                    promoteToHost();
                } else {
                    // Outro membro foi promovido — atualizar hostPeerId
                    addSystem(`📌 Anfitrião mudou para: ${data.senderId}`);
                    hostPeerId = data.senderId;
                    if (!isHost && myPeer && !myPeer.destroyed) {
                        connectToHost();
                    }
                }
            }
            break;

        case 'new-host':
            if (data.senderId !== myId) {
                const oldHost = hostPeerId;
                hostPeerId = data.senderId;
                if (oldHost !== hostPeerId) {
                    addSystem(`📌 Novo anfitrião: ${peers[data.senderId]?.nick || data.senderId}`);
                    // Reconectar ao novo host se não sou o host
                    if (!isHost && myPeer && !myPeer.destroyed) {
                        connectToHost();
                    }
                }
            }
            break;

        case 'relay-screen-offer':
            if (isHost && data.senderId !== myId) {
                relayCallSignal(data.type, data);
            }
            if (data.targetId === myId || !data.targetId) {
                handleScreenShareOffer(data.senderId, data.payload.sdp);
            }
            break;

        case 'relay-screen-answer':
            if (isHost && data.senderId !== myId) {
                relayCallSignal(data.type, data);
            }
            if (data.targetId === myId || !data.targetId) {
                handleScreenShareAnswer(data.senderId, data.payload.sdp);
            }
            break;

        case 'relay-screen-ice':
            if (isHost && data.senderId !== myId) {
                relayCallSignal(data.type, data);
            }
            if (data.targetId === myId || !data.targetId) {
                handleScreenShareIce(data.senderId, data.payload.candidate);
            }
            break;

        case 'screen-ended':
            {
                const screenEndSender = data.senderId || fromPeer;
                if (isHost && screenEndSender !== myId) {
                    Object.entries(peers).forEach(([pid, info]) => {
                        if (pid !== screenEndSender && info.conn?.open) {
                            try {
                                info.conn.send({
                                    type: 'relay-message',
                                    senderId: screenEndSender,
                                    roomId: roomId,
                                    payload: { type: 'screen-ended' }
                                });
                            } catch(e) {}
                        }
                    });
                    stopScreenShareTo(screenEndSender);
                    addSystem(`🖥️ ${peers[screenEndSender]?.nick || 'Alguém'} parou de compartilhar a tela`);
                } else if (screenEndSender === myId) {
                    removeSelfScreenCard();
                } else if (!isHost) {
                    stopScreenShareTo(screenEndSender);
                }
            }
            break;

        case 'ping':
            if (isHost && peers[fromPeer]?.conn?.open) {
                try { peers[fromPeer].conn.send({ type: 'pong', senderId: myId }); } catch(e) {}
            }
            break;

        case 'pong':
            break;
    }
}

// Host broadcasts a message to ALL connected members
function broadcastRelay(type, extra, senderIdOverride) {
    const payload = { type, ...extra };
    const senderId = senderIdOverride || myId;
    Object.entries(peers).forEach(([peerId, info]) => {
        if (info.conn?.open) {
            try {
                info.conn.send({
                    type: 'relay-message',
                    senderId: senderId,
                    roomId: roomId,
                    payload: payload
                });
            } catch(e) { console.warn('Relay send failed:', e); }
        }
    });
}

// ===== Peer Leave =====
function handlePeerLeft(peerId) {
    const info = peers[peerId];
    if (!info) return; // Already left
    const nick = info?.nick || peerId.substring(0, 6);
    if (peerId === hostPeerId) {
        addSystem(`🏠 O anfitrião (${nick}) saiu da sala`);
        delete peers[peerId];
        const remaining = Object.keys(peers).length;
        if (remaining > 0 && !isHost) {
            const sorted = [...Object.keys(peers), myId].sort();
            const designatedHost = sorted[0];
            if (myId === designatedHost) {
                promoteToHost();
                addSystem('⚠️ Você foi promovido a anfitrião');
                // Notificar todos os membros sobre o novo host
                for (const [pid, info] of Object.entries(peers)) {
                    if (info.conn?.open) {
                        try {
                            info.conn.send({
                                type: 'new-host',
                                senderId: myId,
                                roomId: roomId
                            });
                        } catch(e) {}
                    }
                }
            } else {
                hostPeerId = designatedHost;
                // Notificar todos sobre o novo host
                for (const [pid, info] of Object.entries(peers)) {
                    if (info.conn?.open && pid !== myId) {
                        try {
                            info.conn.send({
                                type: 'new-host',
                                senderId: designatedHost,
                                roomId: roomId
                            });
                        } catch(e) {}
                    }
                }
                setTimeout(() => {
                    if (!isHost && myPeer && !myPeer.destroyed) {
                        connectToHost();
                    }
                }, 1000);
            }
        } else if (remaining === 0 && !isHost) {
            promoteToHost();
            addSystem('⚠️ Sem outros membros — promovendo para anfitrião');
        }
    } else {
        addSystem(`👋 ${nick} saiu da sala`);
        delete peers[peerId];
        if (activeCalls[peerId]) {
            try { activeCalls[peerId].pc?.close(); } catch(e){}
            delete activeCalls[peerId];
        }
        removeVideoCard(peerId);
        updateOnline();
        updateCallUI();
        if (isHost) {
            broadcastRelay('member-left', { peerId: peerId, nickname: nick });
        }
    }
    updateOnline();
}

function promoteToHost() {
    isHost = true;
    hostPeerId = myId;
    // Membro não adicionava listener de connection, só o host tinha
    if (!myPeer._hasConnListener) {
        myPeer._hasConnListener = true;
        myPeer.on('connection', (conn) => {
            handleIncomingConnection(conn);
        });
    }
    addSystem('⚠️ Agora você é o anfitrião');
}

// ===== Calls (WebRTC) =====
async function startCall(type) {
    callType = type;
    callActive = true;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: type === 'video' ? VIDEO_CONSTRAINTS[currentVideoQuality] : false
        });
        myStream = stream;
        addSelfCard();
        const emptyMsg = $('empty-msg');
        if (emptyMsg) emptyMsg.remove();

        const hostConnOpen = peers[hostPeerId]?.conn?.open;
        for (const [peerId, info] of Object.entries(peers)) {
            if (activeCalls[peerId]) continue;
            if (peerId === myId) continue;
            const canReach = isHost ? info.conn?.open : hostConnOpen;
            if (!canReach) continue;
            try {
                await initiateP2PCall(peerId, stream, type);
            } catch (e) {
                console.error('Call error to', peerId, e);
            }
        }

        if (Object.keys(activeCalls).length === 0) {
            callActive = false;
            removeSelfVideo();
            showToast('⚠️ Nenhum membro na sala para chamar');
        } else {
            updateCallUI();
        }
    } catch (e) {
        console.error('Call error:', e);
        callActive = false;
        removeSelfVideo();
        showToast('❌ Não foi possível acessar mídia: ' + e.message);
    }
}

async function initiateP2PCall(targetId, stream, type) {
    // Fechar PC antigo se existir (previne áudio duplicado)
    if (activeCalls[targetId]?.pc) {
        try { activeCalls[targetId].pc.close(); } catch (e) {}
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);

    if (stream) {
        stream.getTracks().forEach(track => pc.addTrack(track, stream));
    }

    activeCalls[targetId] = { pc, stream: null, type, iceRestartAttempts: 0 };

    pc.ontrack = (event) => {
        const remoteStream = event.streams[0];
        activeCalls[targetId].stream = remoteStream;
        const existingVid = document.getElementById(`remote-video-${targetId}`);
        if (existingVid) {
            existingVid.srcObject = remoteStream;
        } else {
            addRemoteVideo(targetId, remoteStream);
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            relayCallMessage(targetId, 'relay-ice-candidate', {
                candidate: {
                    candidate: event.candidate.candidate,
                    sdpMid: event.candidate.sdpMid,
                    sdpMLineIndex: event.candidate.sdpMLineIndex
                }
            });
        }
    };

    // ICE restart automático em caso de falha
    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        if (state === 'failed') {
            const callData = activeCalls[targetId];
            if (callData && callData.iceRestartAttempts < 3) {
                callData.iceRestartAttempts++;
                console.log(`ICE restart attempt ${callData.iceRestartAttempts} for ${targetId}`);
                pc.createOffer({ iceRestart: true }).then(offer => {
                    return pc.setLocalDescription(offer);
                }).then(() => {
                    relayCallMessage(targetId, 'relay-call-offer', {
                        sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
                        type: callData.type,
                        iceRestart: true
                    });
                }).catch(e => console.error('ICE restart failed:', e));
            }
        } else if (state === 'connected') {
            const callData = activeCalls[targetId];
            if (callData) callData.iceRestartAttempts = 0;
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            // Só remove se ICE restart já esgotou
            const callData = activeCalls[targetId];
            if (!callData || callData.iceRestartAttempts >= 3) {
                removeVideoCard(targetId);
                delete activeCalls[targetId];
                if (Object.keys(activeCalls).length === 0) {
                    callActive = false;
                    updateCallUI();
                }
            }
        }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Aplicar limite de bitrate após conectar
    if (type === 'video') {
        applyVideoBitrate(pc, VIDEO_BITRATES[currentVideoQuality]);
    }

    relayCallMessage(targetId, 'relay-call-offer', { sdp: { type: offer.type, sdp: offer.sdp }, type: type });
    console.log('P2P call to', targetId);
}

function relayCallMessage(targetId, msgType, payload) {
    const data = {
        type: msgType,
        senderId: myId,
        targetId: targetId,
        roomId: roomId,
        payload: payload
    };

    if (isHost) {
        const info = peers[targetId];
        if (info?.conn?.open) {
            info.conn.send(data);
        }
    } else {
        const hostInfo = peers[hostPeerId];
        if (hostInfo?.conn?.open) {
            hostInfo.conn.send(data);
        }
    }
}

function relayScreenMessage(targetId, msgType, payload) {
    const msg = {
        type: msgType,
        senderId: myId,
        targetId: targetId,
        roomId: roomId,
        payload: payload
    };
    if (isHost) {
        const info = peers[targetId];
        if (info?.conn?.open) {
            try { info.conn.send(msg); } catch(e) {}
        }
    } else {
        const hostConn = peers[hostPeerId]?.conn;
        if (hostConn?.open) {
            try { hostConn.send(msg); } catch(e) {}
        }
    }
}

function relayCallSignal(type, data) {
    const relayData = {
        type: type,
        senderId: data.senderId,
        targetId: data.targetId,
        roomId: roomId,
        payload: data.payload
    };
    Object.entries(peers).forEach(([peerId, info]) => {
        if (peerId === data.senderId) return;
        if (info.conn?.open) {
            try {
                info.conn.send(relayData);
            } catch(e) { console.warn('Call relay send failed:', e); }
        }
    });
}

function handleRemoteOffer(fromPeer, sdp, payload) {
    // Se é ICE restart, reutilizar PC existente
    if (payload?.iceRestart && activeCalls[fromPeer]?.pc) {
        const existingPc = activeCalls[fromPeer].pc;
        existingPc.setRemoteDescription(sdp)
            .then(async () => {
                const answer = await existingPc.createAnswer();
                await existingPc.setLocalDescription(answer);
                relayCallMessage(fromPeer, 'relay-call-answer-sdp', {
                    sdp: { type: existingPc.localDescription.type, sdp: existingPc.localDescription.sdp }
                });
                console.log('ICE restart answer sent to', fromPeer);
            })
            .catch(e => console.error('ICE restart answer error:', e));
        return;
    }

    // Fechar PC antigo antes de criar novo (previne áudio órfão / eco)
    if (activeCalls[fromPeer]?.pc) {
        try { activeCalls[fromPeer].pc.close(); } catch (e) {}
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);

    activeCalls[fromPeer] = { pc, stream: null, iceRestartAttempts: 0 };

    pc.ontrack = (event) => {
        const remoteStream = event.streams[0];
        activeCalls[fromPeer].stream = remoteStream;
        const existingVid = document.getElementById(`remote-video-${fromPeer}`);
        if (existingVid) {
            existingVid.srcObject = remoteStream;
        } else {
            addRemoteVideo(fromPeer, remoteStream);
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            relayCallMessage(fromPeer, 'relay-ice-candidate', {
                candidate: {
                    candidate: event.candidate.candidate,
                    sdpMid: event.candidate.sdpMid,
                    sdpMLineIndex: event.candidate.sdpMLineIndex
                }
            });
        }
    };

    // ICE restart automático
    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        if (state === 'failed') {
            const callData = activeCalls[fromPeer];
            if (callData && callData.iceRestartAttempts < 3) {
                callData.iceRestartAttempts++;
                console.log(`ICE restart (receiver) attempt ${callData.iceRestartAttempts} for ${fromPeer}`);
                pc.createOffer({ iceRestart: true }).then(offer => {
                    return pc.setLocalDescription(offer);
                }).then(() => {
                    relayCallMessage(fromPeer, 'relay-call-offer', {
                        sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
                        type: callData.type || callType,
                        iceRestart: true
                    });
                }).catch(e => console.error('ICE restart failed:', e));
            }
        } else if (state === 'connected') {
            const callData = activeCalls[fromPeer];
            if (callData) callData.iceRestartAttempts = 0;
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            const callData = activeCalls[fromPeer];
            if (!callData || callData.iceRestartAttempts >= 3) {
                removeVideoCard(fromPeer);
                delete activeCalls[fromPeer];
                if (Object.keys(activeCalls).length === 0) {
                    callActive = false;
                    updateCallUI();
                }
            }
        }
    };

    pc.setRemoteDescription(sdp)
        .then(async () => {
            // Drenar ICE candidates que chegaram antes do setRemoteDescription
            await drainPendingIce(fromPeer, pc, pendingIceCandidates);

            if (!myStream) {
                const hasVideo = sdp.sdp && sdp.sdp.includes('m=video');
                try {
                    myStream = await navigator.mediaDevices.getUserMedia({
                        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                        video: hasVideo ? VIDEO_CONSTRAINTS[currentVideoQuality] : false
                    });
                    callActive = true;
                    callType = hasVideo ? 'video' : 'audio';
                    updateCallUI();
                } catch(e) {
                    try {
                        myStream = await navigator.mediaDevices.getUserMedia({
                            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                            video: false
                        });
                        callActive = true;
                        callType = 'audio';
                        updateCallUI();
                    } catch(e2) {
                        console.warn('No media available for incoming call:', e2);
                    }
                }
            }
            if (myStream) {
                myStream.getTracks().forEach(t => pc.addTrack(t, myStream));
                addSelfCard();
            }
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            // Aplicar bitrate após negociação
            const hasVideo = sdp.sdp && sdp.sdp.includes('m=video');
            if (hasVideo) {
                applyVideoBitrate(pc, VIDEO_BITRATES[currentVideoQuality]);
            }

            relayCallMessage(fromPeer, 'relay-call-answer-sdp', {
                sdp: {
                    type: pc.localDescription.type,
                    sdp: pc.localDescription.sdp
                }
            });
        })
        .catch(e => {
            console.error('Answer error:', e);
            delete activeCalls[fromPeer];
        });
}

function handleRemoteAnswer(fromPeer, sdp) {
    const callData = activeCalls[fromPeer];
    if (!callData) return;
    callData.pc.setRemoteDescription(sdp)
        .then(async () => {
            // Drenar ICE candidates que chegaram antes do answer
            await drainPendingIce(fromPeer, callData.pc, pendingIceCandidates);
            console.log('Call answered, waiting for remote tracks via ontrack');
        })
        .catch(e => console.error('Answer set error:', e));
}

function handleIceCandidate(fromPeer, candidate) {
    const callData = activeCalls[fromPeer];
    const iceObj = new RTCIceCandidate({
        candidate: candidate.candidate || '',
        sdpMid: candidate.sdpMid || '0',
        sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
        usernameFragment: candidate.usernameFragment || ''
    });

    // Se PC não existe ainda ou remoteDescription não foi definida, enfileirar
    if (!callData?.pc || !callData.pc.remoteDescription) {
        if (!pendingIceCandidates[fromPeer]) pendingIceCandidates[fromPeer] = [];
        pendingIceCandidates[fromPeer].push(iceObj);
        return;
    }

    callData.pc.addIceCandidate(iceObj)
        .catch(e => console.warn('ICE candidate error:', e));
}

function endCallTo(peerId) {
    if (activeCalls[peerId]) {
        try { activeCalls[peerId].pc?.close(); } catch (e) {}
        delete activeCalls[peerId];
        removeVideoCard(peerId);
    }
    if (Object.keys(activeCalls).length === 0) {
        callActive = false;
        if (myStream) {
            myStream.getTracks().forEach(t => t.stop());
            myStream = null;
        }
        removeSelfVideo();
        $('video-grid').querySelectorAll('.video-card').forEach(v => v.remove());
        if (!$('empty-msg')) {
            const em = document.createElement('div');
            em.className = 'empty-state';
            em.id = 'empty-msg';
            em.innerHTML = '<div>👆 Use os botões abaixo para iniciar uma chamada</div>';
            $('video-grid').appendChild(em);
        }
        updateCallUI();
    }
}

function endCall() {
    // Fechar screen share calls
    for (const pid of Object.keys(screenCallMap)) {
        try { screenCallMap[pid].pc?.close(); } catch (e) {}
    }
    screenCallMap = {};

    // Fechar todas as chamadas de vídeo/áudio
    for (const pid of Object.keys(activeCalls)) {
        try { activeCalls[pid].pc?.close(); } catch (e) {}
    }
    activeCalls = {};

    // Parar streams locais
    if (myStream) {
        myStream.getTracks().forEach(t => t.stop());
        myStream = null;
    }

    // Sair do fullscreen se estiver ativo
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
    }

    callActive = false;
    $('video-grid').querySelectorAll('.video-card').forEach(v => v.remove());
    if (!$('empty-msg')) {
        const em = document.createElement('div');
        em.className = 'empty-state';
        em.id = 'empty-msg';
        em.innerHTML = '<div>👆 Use os botões abaixo para iniciar uma chamada de áudio ou vídeo</div>';
        $('video-grid').appendChild(em);
    }
    // Reset call buttons
    $('call-mute-btn').style.display = 'none';
    $('call-cam-btn').style.display = 'none';
    $('call-screen-btn').style.display = 'none';
    $('call-end-btn').style.display = 'none';
    $('call-audio-btn').style.display = '';
    $('call-video-btn').style.display = '';
    $('call-mute-btn').classList.remove('muted');
    $('call-cam-btn').classList.remove('muted');
    $('call-screen-btn').classList.remove('muted');
    callMicOn = true;
    callCamOn = true;
    screenSharing = false;

    updateCallUI();
    $('active-call-info').classList.remove('show');
    stopCallTimer();
    addSystem('📞 Chamada encerrada');
    broadcastRelay('call-ended', {});
}

function toggleCallMic() {
    if (!myStream) return;
    callMicOn = !callMicOn;
    myStream.getAudioTracks().forEach(t => t.enabled = callMicOn);
    const btn = $('call-mute-btn');
    btn.classList.toggle('muted', !callMicOn);
    btn.textContent = callMicOn ? '🎤' : '🔇';
}

function toggleCam() {
    if (!myStream) return;
    callCamOn = !callCamOn;
    myStream.getVideoTracks().forEach(t => t.enabled = callCamOn);
    $('call-cam-btn').classList.toggle('muted', !callCamOn);
}

// ===== Screen Sharing =====
async function toggleScreenShare() {
    if (screenSharing) {
        await stopScreenShare();
    } else {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: 'always',
                    width: { ideal: 1920, max: 1920 },
                    height: { ideal: 1080, max: 1080 },
                    frameRate: { ideal: 15, max: 30 }
                },
                audio: true
            });

            addSelfScreenCard();

            screenSharing = true;
            $('call-screen-btn').classList.add('active');
            $('call-screen-btn').textContent = '⏹️';
            $('call-screen-btn').title = 'Parar compartilhamento';
            addSystem('🖥️ Você começou a compartilhar sua tela');

            screenStream.getVideoTracks()[0].onended = () => {
                if (screenSharing) {
                    addSystem('🖥️ Compartilhamento de tela parado');
                    stopScreenShare();
                }
            };

            const scrHostConnOpen = peers[hostPeerId]?.conn?.open;
            for (const [peerId, info] of Object.entries(peers)) {
                if (screenCallMap[peerId]) continue;
                if (peerId === myId) continue;
                const canReach = isHost ? info.conn?.open : scrHostConnOpen;
                if (!canReach) continue;
                try {
                    await initiateScreenShareToPeer(peerId);
                } catch (e) {
                    console.error('Screen share error to', peerId, e);
                }
            }
        } catch (err) {
            console.error('Screen capture error:', err);
            if (err.name !== 'NotAllowedError') {
                showToast('Erro ao capturar tela.', true);
            }
            screenSharing = false;
        }
    }
}

async function initiateScreenShareToPeer(targetId) {
    // Fechar PC antigo se existir
    if (screenCallMap[targetId]?.pc) {
        try { screenCallMap[targetId].pc.close(); } catch (e) {}
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);

    let videoTrackAdded = false;
    if (screenStream) {
        screenStream.getTracks().forEach(track => {
            if (track.kind === 'video') {
                pc.addTrack(track, screenStream);
                videoTrackAdded = true;
            } else if (track.kind === 'audio') {
                // Só envia áudio do sistema se NÃO houver chamada ativa
                // (evita loop de eco: speaker → getDisplayMedia → peer → speaker)
                if (!callActive) {
                    pc.addTrack(track, screenStream);
                }
            }
        });
    }

    if (!videoTrackAdded && myStream && myStream.getVideoTracks().length > 0) {
        myStream.getVideoTracks().forEach(track => pc.addTrack(track, myStream));
    }

    screenCallMap[targetId] = { pc, stream: null };

    pc.ontrack = (event) => {
        if (event.track.kind === 'video') {
            addRemoteScreen(targetId, event.streams[0]);
            screenCallMap[targetId].stream = event.streams[0];
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            const iceData = {
                candidate: {
                    candidate: event.candidate.candidate,
                    sdpMid: event.candidate.sdpMid,
                    sdpMLineIndex: event.candidate.sdpMLineIndex
                }
            };
            if (isHost) {
                const info = peers[targetId];
                if (info?.conn?.open) {
                    info.conn.send({
                        type: 'relay-screen-ice',
                        senderId: myId,
                        targetId: targetId,
                        roomId: roomId,
                        payload: iceData
                    });
                }
            } else {
                const hostInfo = peers[hostPeerId];
                if (hostInfo?.conn?.open) {
                    hostInfo.conn.send({
                        type: 'relay-screen-ice',
                        senderId: myId,
                        targetId: targetId,
                        roomId: roomId,
                        payload: iceData
                    });
                }
            }
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            removeRemoteScreen(targetId);
            delete screenCallMap[targetId];
        }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    applyVideoBitrate(pc, SCREEN_BITRATES[currentVideoQuality]);

    const screenData = {
        type: 'relay-screen-offer',
        senderId: myId,
        targetId: targetId,
        roomId: roomId,
        payload: { sdp: { type: offer.type, sdp: offer.sdp } }
    };

    if (isHost) {
        const info = peers[targetId];
        if (info?.conn?.open) {
            info.conn.send(screenData);
        }
    } else {
        const hostInfo = peers[hostPeerId];
        if (hostInfo?.conn?.open) {
            hostInfo.conn.send(screenData);
        }
    }
}

function handleScreenShareOffer(fromPeer, sdp) {
    // Fechar PC antigo se existir
    if (screenCallMap[fromPeer]?.pc) {
        try { screenCallMap[fromPeer].pc.close(); } catch (e) {}
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);

    screenCallMap[fromPeer] = { pc, stream: null };

    pc.ontrack = (event) => {
        if (event.track.kind === 'video') {
            addRemoteScreen(fromPeer, event.streams[0]);
            screenCallMap[fromPeer].stream = event.streams[0];
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            relayScreenMessage(fromPeer, 'relay-screen-ice', {
                candidate: {
                    candidate: event.candidate.candidate,
                    sdpMid: event.candidate.sdpMid,
                    sdpMLineIndex: event.candidate.sdpMLineIndex
                }
            });
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            removeRemoteScreen(fromPeer);
            delete screenCallMap[fromPeer];
        }
    };

    pc.setRemoteDescription(sdp)
        .then(async () => {
            await drainPendingIce(fromPeer, pc, pendingScreenIceCandidates);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            applyVideoBitrate(pc, SCREEN_BITRATES[currentVideoQuality]);
            relayScreenMessage(fromPeer, 'relay-screen-answer', {
                sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
            });
        })
        .catch(e => {
            console.error('Screen share answer error:', e);
            delete screenCallMap[fromPeer];
        });
}

function handleScreenShareAnswer(fromPeer, sdp) {
    const callData = screenCallMap[fromPeer];
    if (!callData) return;
    callData.pc.setRemoteDescription(sdp)
        .then(async () => {
            await drainPendingIce(fromPeer, callData.pc, pendingScreenIceCandidates);
            console.log('Screen share answered');
        })
        .catch(e => console.error('Screen share answer set error:', e));
}

function handleScreenShareIce(fromPeer, candidate) {
    const callData = screenCallMap[fromPeer];
    const iceObj = new RTCIceCandidate({
        candidate: candidate.candidate || '',
        sdpMid: candidate.sdpMid || '0',
        sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
        usernameFragment: candidate.usernameFragment || ''
    });

    if (!callData?.pc || !callData.pc.remoteDescription) {
        if (!pendingScreenIceCandidates[fromPeer]) pendingScreenIceCandidates[fromPeer] = [];
        pendingScreenIceCandidates[fromPeer].push(iceObj);
        return;
    }

    callData.pc.addIceCandidate(iceObj)
        .catch(e => console.warn('Screen share ICE candidate error:', e));
}

async function stopScreenShare() {
    for (const pid of Object.keys(screenCallMap)) {
        try {
            screenCallMap[pid].pc?.close();
        } catch (e) {}
        removeRemoteScreen(pid);
    }
    screenCallMap = {};

    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }

    screenSharing = false;
    $('call-screen-btn').classList.remove('active');
    $('call-screen-btn').textContent = '🖥️';
    $('call-screen-btn').title = 'Compartilhar tela';

    removeSelfScreenCard();
    addSystem('🖥️ Você parou de compartilhar sua tela');

    if (isHost) {
        broadcastRelay('screen-ended', {});
    } else {
        sendToHost('screen-ended', {});
    }
}

function stopScreenShareTo(peerId) {
    const callData = screenCallMap[peerId];
    if (!callData) return;
    try { callData.pc?.close(); } catch (e) {}
    removeRemoteScreen(peerId);
    delete screenCallMap[peerId];
}

// ===== Screen Share Video Cards =====
function addSelfScreenCard() {
    let card = document.getElementById('self-screen-card');
    if (card) card.remove();
    card = document.createElement('div');
    card.className = 'video-card self-card screen-card';
    card.id = 'self-screen-card';
    card.innerHTML = `
        <video id="self-screen-video" autoplay muted playsinline></video>
        <div class="label"><span class="status-dot"></span> 🖥️ Compartilhamento de tela (você)</div>
        <button class="btn-fullscreen" onclick="toggleFullscreen('self-screen-video')" title="Tela cheia">⛶</button>
    `;
    const eg = $('video-grid');
    if (eg.firstChild) eg.insertBefore(card, eg.firstChild);
    else eg.appendChild(card);
    const selfScreenVideo = document.getElementById('self-screen-video');
    if (selfScreenVideo && screenStream) {
        selfScreenVideo.srcObject = screenStream;
    }
}

function removeSelfScreenCard() {
    const el = document.getElementById('self-screen-card');
    if (el) {
        const v = el.querySelector('video');
        if (v && v.srcObject) {
            v.srcObject.getTracks().forEach(t => t.stop());
        }
        el.remove();
    }
}

function addRemoteScreen(peerId, stream) {
    removeRemoteScreen(peerId);
    const info = peers[peerId] || {};
    const nick = info.nick || peerId.substring(0, 8);
    const card = document.createElement('div');
    card.className = 'video-card screen-card';
    card.id = `vscreen-${peerId}`;
    card.innerHTML = `
        <video id="remote-screen-video-${peerId}" autoplay playsinline muted></video>
        <div class="label"><span class="status-dot"></span> 🖥️ ${DOMPurify.sanitize(nick, {ALLOW_TAGS: [], ALLOW_ATTR: []})}</div>
        <button class="btn-fullscreen" onclick="toggleFullscreen('remote-screen-video-${peerId}')" title="Tela cheia">⛶</button>
        <button class="btn-close-screen" onclick="stopScreenShareTo('${peerId}')" title="Fechar">✕</button>
    `;
    $('video-grid').appendChild(card);
    const rv = document.getElementById(`remote-screen-video-${peerId}`);
    if (rv && stream) {
        rv.srcObject = stream;
    }
}

function removeRemoteScreen(peerId) {
    const el = document.getElementById(`vscreen-${peerId}`);
    if (el) {
        const v = el.querySelector('video');
        if (v) { v.srcObject = null; }
        el.remove();
    }
}

// ===== Fullscreen =====
function toggleFullscreen(videoId) {
    const el = document.getElementById(videoId);
    if (!el) return;
    if (!document.fullscreenElement) {
        el.requestFullscreen().catch(err => {
            console.warn('Fullscreen error:', err);
            showToast('⚠️ Tela cheia não disponível');
        });
    } else {
        document.exitFullscreen();
    }
}

// ===== Video Cards =====
function addSelfCard() {
    let card = document.getElementById('self-card');
    if (card) card.remove();
    card = document.createElement('div');
    card.className = 'video-card self-card';
    card.id = 'self-card';
    card.innerHTML = `
        <video id="self-video" autoplay muted playsinline></video>
        <div class="label"><span class="status-dot"></span> ${DOMPurify.sanitize(nickname, {ALLOW_TAGS: [], ALLOW_ATTR: []})} (você)</div>
        <button class="btn-fullscreen" onclick="toggleFullscreen('self-video')" title="Tela cheia">⛶</button>
    `;
    const eg = $('video-grid');
    if (eg.firstChild) eg.insertBefore(card, eg.firstChild);
    else eg.appendChild(card);
    const selfVideo = document.getElementById('self-video');
    if (selfVideo && myStream) {
        selfVideo.srcObject = myStream;
    }
}

function addRemoteVideo(peerId, stream) {
    removeVideoCard(peerId);
    const info = peers[peerId] || {};
    const nick = info.nick || peerId.substring(0, 8);
    const card = document.createElement('div');
    card.className = 'video-card';
    card.id = `vcard-${peerId}`;
    card.innerHTML = `
        <video id="remote-video-${peerId}" autoplay playsinline></video>
        <div class="label"><span class="status-dot"></span> ${DOMPurify.sanitize(nick, {ALLOW_TAGS: [], ALLOW_ATTR: []})}</div>
        <button class="btn-fullscreen" onclick="toggleFullscreen('remote-video-${peerId}')" title="Tela cheia">⛶</button>
        <button class="btn-close-screen" onclick="endCallTo('${peerId}')" title="Encerrar chamada">✕</button>
    `;
    $('video-grid').appendChild(card);
    const rv = document.getElementById(`remote-video-${peerId}`);
    if (rv && stream) {
        rv.srcObject = stream;
    }
}

function removeSelfVideo() {
    const el = document.getElementById('self-card');
    if (el) {
        const v = el.querySelector('video');
        if (v && v.srcObject) {
            v.srcObject.getTracks().forEach(t => t.stop());
        }
        el.remove();
    }
}

function removeVideoCard(peerId) {
    const el = document.getElementById(`vcard-${peerId}`);
    if (el) {
        const v = el.querySelector('video');
        if (v) v.srcObject = null;
        el.remove();
    }
}

// ===== Call UI =====
function updateCallUI() {
    const hasCall = callActive;
    $('call-audio-btn').style.display = hasCall ? 'none' : '';
    $('call-video-btn').style.display = hasCall ? 'none' : '';
    $('call-end-btn').style.display = hasCall ? '' : 'none';
    $('call-mute-btn').style.display = (hasCall && myStream) ? '' : 'none';
    $('call-cam-btn').style.display = (hasCall && myStream && myStream.getVideoTracks().length > 0) ? '' : 'none';
    $('call-screen-btn').style.display = Object.keys(peers).length > 0 || callActive ? '' : 'none';
    const callInfo = $('active-call-info');
    callInfo.classList.toggle('show', hasCall);
    $('room-body').classList.toggle('has-call', hasCall);
    if (hasCall) {
        callInfo.textContent = `📞 Chamada ${callType === 'video' ? 'de vídeo' : 'de áudio'} em andamento`;
        startCallTimer();
    } else {
        stopCallTimer();
    }
}
