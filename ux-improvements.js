// ================================================================
// HOWAPP — UX Improvements Module
// Handles: resize, a11y, toasts, reactions, search, reply, drawer, status
// ================================================================

// ===== State =====
let replyTo = null; // { sender, text, id }
let searchQuery = '';
let searchResults = [];
let searchIndex = -1;

// ===== 1. PANEL RESIZE =====
function initResizeHandle() {
    const handle = $('resize-handle');
    const chatPanel = $('chat-panel');
    const roomBody = $('room-body');
    let isResizing = false;

    // Load saved ratio
    const saved = localStorage.getItem('howapp-resize-ratio');
    if (saved) {
        const ratio = parseFloat(saved);
        const minRatio = 0.2;
        const clamped = Math.max(minRatio, Math.min(1 - minRatio, ratio));
        chatPanel.style.flex = clamped;
        const other = roomBody.querySelector('.video-grid');
        other.style.flex = 1;
    }

    function startResize(e) {
        e.preventDefault();
        isResizing = true;
        handle.classList.add('active');
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', doResize);
        document.addEventListener('mouseup', stopResize);
        document.addEventListener('touchmove', doResize, { passive: false });
        document.addEventListener('touchend', stopResize);
    }

    function doResize(e) {
        if (!isResizing) return;
        e.preventDefault();
        const rect = roomBody.getBoundingClientRect();
        const x = (e.clientX || (e.touches && e.touches[0].clientX)) || 0;
        const ratio = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
        const min = 0.2;
        const clamped = Math.max(min, Math.min(1 - min, ratio));
        chatPanel.style.flex = clamped;
        const other = roomBody.querySelector('.video-grid');
        other.style.flex = 1;
        localStorage.setItem('howapp-resize-ratio', clamped);
    }

    function stopResize() {
        isResizing = false;
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', doResize);
        document.removeEventListener('mouseup', stopResize);
        document.removeEventListener('touchmove', doResize);
        document.removeEventListener('touchend', stopResize);
    }

    handle.addEventListener('mousedown', startResize);
    handle.addEventListener('touchstart', startResize, { passive: false });
}

// ===== 2. TOAST IMPROVED =====
let toastQueue = [];
let toastActive = false;

function showToast(msg, isError, undoable) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(t._timer);

    if (undoable && !isError) {
        const undoBtn = document.createElement('button');
        undoBtn.textContent = 'Desfazer';
        undoBtn.style.cssText = 'margin-left:8px;background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.3);color:white;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;';
        undoBtn.onclick = () => {
            // Undo action would be implemented per action type
            t._undo && t._undo();
            t.classList.remove('show');
        };
        t.appendChild(undoBtn);
        t._timer = setTimeout(() => {
            if (undoBtn.parentNode) undoBtn.remove();
            t.classList.remove('show');
        }, 5000);
    } else {
        t._timer = setTimeout(() => t.classList.remove('show'), 3000);
    }
}

// ===== 3. CALL TIMER =====
let callTimerInterval = null;
let callTimerStart = 0;

function startCallTimer() {
    callTimerStart = Date.now();
    const timerEl = $('call-timer');
    if (!timerEl) return;
    timerEl.style.display = 'inline';
    callTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - callTimerStart) / 1000);
        const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const secs = String(elapsed % 60).padStart(2, '0');
        timerEl.textContent = `${mins}:${secs}`;
    }, 1000);
}

function stopCallTimer() {
    if (callTimerInterval) {
        clearInterval(callTimerInterval);
        callTimerInterval = null;
    }
    const timerEl = $('call-timer');
    if (timerEl) timerEl.style.display = 'none';
}

// ===== 4. CONNECTION STATUS =====
let connStatus = 'excellent';
let connLatency = 0;
let signalBars = 5;
let qualityWarningShown = false;

function updateConnectionStatus(status, latency, bars) {
    if (status) connStatus = status;
    if (latency !== undefined) connLatency = latency;
    if (bars !== undefined) signalBars = bars;

    const el = $('connection-status');
    const dot = el.querySelector('.status-dot');
    const barsContainer = el.querySelector('.signal-bars');
    const latencyText = $('latency-text');
    const tooltip = $('tooltip-detail');

    el.className = 'connection-status ' + connStatus;

    // Update bars
    const barSpans = barsContainer.querySelectorAll('span');
    for (let i = 0; i < 5; i++) {
        if (i < signalBars) {
            barSpans[i].classList.add('active');
        } else {
            barSpans[i].classList.remove('active');
        }
    }

    latencyText.textContent = connLatency > 0 ? connLatency + 'ms' : '';

    // Tooltip
    const msgs = {
        excellent: 'Conexão excelente',
        good: 'Conexão boa',
        fair: 'Conexão razoável',
        poor: 'Conexão instável'
    };
    tooltip.textContent = msgs[connStatus] || 'P2P direto';

    // Quality warning
    if (connStatus === 'poor' && !qualityWarningShown) {
        showToast('⚠️ Qualidade da conexão baixa. Considere usar TURN.', false, true);
        qualityWarningShown = true;
    }
}

// ===== 5. TALKING INDICATOR =====
function updateTalkingIndicator(peerId, isTalking) {
    const card = document.getElementById(`vcard-${peerId}`);
    if (card) {
        card.classList.toggle('talking', isTalking);
        const statusDot = card.querySelector('.status-dot');
        if (statusDot) {
            statusDot.classList.toggle('speaking', isTalking);
        }
    }
    // Also update in drawer
    const drawerItem = document.getElementById(`drawer-participant-${peerId}`);
    if (drawerItem) {
        const avatar = drawerItem.querySelector('.participant-avatar');
        if (avatar) avatar.classList.toggle('speaking', isTalking);
    }
}

// ===== 6. PARTICIPANT DRAWER =====
function toggleParticipants() {
    const drawer = $('participant-drawer');
    const backdrop = $('drawer-backdrop');
    const isOpen = drawer.classList.contains('open');

    if (isOpen) {
        closeParticipants();
    } else {
        openParticipants();
    }
}

function openParticipants() {
    renderParticipants();
    $('participant-drawer').classList.add('open');
    $('drawer-backdrop').classList.add('show');
    // Trap focus
    const firstFocusable = $('participant-drawer').querySelector('button, [tabindex]');
    if (firstFocusable) setTimeout(() => firstFocusable.focus(), 100);
}

function closeParticipants() {
    $('participant-drawer').classList.remove('open');
    $('drawer-backdrop').classList.remove('show');
    // Return focus to trigger button
    $('btn-participants').focus();
}

function renderParticipants() {
    const list = $('drawer-list');
    const members = [];

    // Add self
    members.push({ nick: nickname, peerId: myId, isHost: isHost });

    // Add peers
    for (const [pid, info] of Object.entries(peers)) {
        if (info.nick) {
            members.push({ nick: info.nick, peerId: pid, isHost: false });
        }
    }

    list.innerHTML = members.map(m => {
        const initial = (m.nick || '?')[0].toUpperCase();
        const hostBadge = m.isHost ? '👑' : '';
        const statusText = (peers[m.peerId]?.conn?.open || m.peerId === myId) ? 'Online' : 'Offline';
        const talking = isTalking(m.peerId);
        return `
            <div class="drawer-participant" id="drawer-participant-${m.peerId}">
                <div class="participant-avatar ${talking ? 'speaking' : ''}" aria-hidden="true">${initial}</div>
                <div class="participant-info">
                    <div class="pname">${m.nick} ${hostBadge}</div>
                    <div class="pstatus">${statusText}</div>
                </div>
                <div class="participant-actions">
                    ${m.peerId !== myId ? `<button class="icon-btn" style="width:32px;height:32px;font-size:12px;" onclick="removeParticipant('${m.peerId}')" aria-label="Remover ${m.nick}">❌</button>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function isTalking(peerId) {
    // TODO: Implement WebRTC volume detection using AudioContext/AnalyserNode
    // for activeCalls[peerId].pc to return real talking state
    return false;
}

function removeParticipant(peerId) {
    if (peers[peerId]?.conn?.open) {
        try {
            peers[peerId].conn.send({ type: 'leave', nickname: peers[peerId].nick, roomId: roomId });
        } catch(e) {}
        handlePeerLeft(peerId);
    }
}

// ===== 7. SEARCH =====
function toggleSearch() {
    const bar = $('search-bar');
    bar.classList.toggle('show');
    if (bar.classList.contains('show')) {
        $('search-input').focus();
    }
}

function performSearch() {
    const query = $('search-input').value.trim().toLowerCase();
    searchQuery = query;
    searchResults = [];
    searchIndex = -1;

    if (!query) return;

    const messages = document.querySelectorAll('#messages .message:not(.system)');
    messages.forEach(msg => {
        if (msg.textContent.toLowerCase().includes(query)) {
            searchResults.push(msg);
        }
    });

    // Highlight results
    document.querySelectorAll('#messages mark').forEach(m => m.replaceWith(m.textContent));

    if (searchResults.length > 0) {
        searchIndex = 0;
        scrollToResult();
        document.getElementById('search-count').textContent = `1/${searchResults.length}`;
    } else {
        document.getElementById('search-count').textContent = '0 resultados';
    }
}

function searchNext() {
    if (searchResults.length === 0) return;
    searchIndex = (searchIndex + 1) % searchResults.length;
    scrollToResult();
    document.getElementById('search-count').textContent = `${searchIndex + 1}/${searchResults.length}`;
}

function searchPrev() {
    if (searchResults.length === 0) return;
    searchIndex = (searchIndex - 1 + searchResults.length) % searchResults.length;
    scrollToResult();
    document.getElementById('search-count').textContent = `${searchIndex + 1}/${searchResults.length}`;
}

function scrollToResult() {
    document.querySelectorAll('#messages mark').forEach(m => m.replaceWith(m.textContent));
    if (searchIndex >= 0 && searchResults[searchIndex]) {
        const msg = searchResults[searchIndex];
        msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// ===== 8. REACTIONS =====

function addReactionBtn(msgEl) {
    // Guard against adding picker multiple times to the same message
    if (msgEl.querySelector('.reaction-picker')) return;
    const picker = document.createElement('div');
    picker.className = 'reaction-picker';
    picker.id = `reaction-picker-${msgEl._msgId}`;
    picker.innerHTML = REACTIONS.map(e =>
        `<button onclick="addReactionToMessage('${msgEl._msgId}', '${e}')" aria-label="Reagir com ${e}">${e}</button>`
    ).join('');
    msgEl.style.position = 'relative';
    msgEl.appendChild(picker);

    msgEl.addEventListener('mouseenter', () => {
        picker.classList.add('show');
    });
    msgEl.addEventListener('mouseleave', () => {
        setTimeout(() => picker.classList.remove('show'), 200);
    });
}

function addReactionToMessage(msgId, emoji) {
    // In production, this would broadcast via P2P
    const msgEl = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!msgEl) return;

    let container = msgEl.querySelector('.reactions-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'reactions-container';
        msgEl.appendChild(container);
    }

    // Check if this reaction already exists
    const existingBadge = container.querySelector(`[data-emoji="${emoji}"]`);
    if (existingBadge) {
        const countEl = existingBadge.querySelector('.count');
        const currentCount = parseInt(countEl.textContent);
        if (currentCount <= 1) {
            // Remove badge if count is 1 (toggle off)
            existingBadge.remove();
        } else {
            countEl.textContent = currentCount - 1;
        }
    } else {
        const badge = document.createElement('span');
        badge.className = 'reaction-badge';
        badge.dataset.emoji = emoji;
        badge.innerHTML = `${emoji} <span class="count">1</span>`;
        badge.onclick = (e) => {
            e.stopPropagation();
            addReactionToMessage(msgId, emoji);
        };
        container.appendChild(badge);
    }

    // Close picker
    const picker = document.getElementById(`reaction-picker-${msgId}`);
    if (picker) picker.classList.remove('show');
}

// ===== 9. REPLY THREAD =====
function setReply(sender, text, msgId) {
    replyTo = { sender, text, id: msgId };
    $('reply-preview').classList.add('show');
    $('reply-sender').textContent = sender;
    $('reply-text').textContent = text;
    $('msg-input').focus();
}

function cancelReply() {
    replyTo = null;
    $('reply-preview').classList.remove('show');
}

// Override sendMessage to include reply info
const originalSendMessage = window.sendMessage;
window.sendMessage = function() {
    if (replyTo) {
        const inp = $('msg-input');
        const originalText = inp.value;
        // In production, this would add replyTo to the payload before sending
        cancelReply();
    }
    if (originalSendMessage) originalSendMessage();
    else {
        // Inline implementation if original not available
        const inp = $('msg-input');
        const text = inp.value.trim();
        if (!text) return;
        addChat(nickname, escapeHtml(text), 'sent');
        inp.value = '';
        inp.style.height = 'auto';
        $('typing-indicator').textContent = '';
    }
};

// ===== 10. CONFIRMATION MODAL =====
let modalCallback = null;

function confirmEndCall() {
    showModal('Encerrar chamada', 'Tem certeza que deseja encerrar a chamada?', () => {
        endCall();
        showToast('Chamada encerrada');
    });
}

function showModal(title, message, onConfirm) {
    $('modal-title').textContent = title;
    $('modal-message').textContent = message;
    $('confirm-modal').classList.add('show');
    modalCallback = onConfirm;
    $('modal-confirm').focus();
}

function closeModal() {
    $('confirm-modal').classList.remove('show');
    modalCallback = null;
}

function modalConfirmAction() {
    if (modalCallback) modalCallback();
    closeModal();
}

// ===== 11. KEYBOARD NAVIGATION =====
document.addEventListener('keydown', e => {
    // Escape closes drawer and modal
    if (e.key === 'Escape') {
        if ($('confirm-modal').classList.contains('show')) {
            closeModal();
        } else if ($('participant-drawer').classList.contains('open')) {
            closeParticipants();
        }
    }
});

// ===== 12. AUTO INIT =====
document.addEventListener('DOMContentLoaded', () => {
    // Search input handler
    const searchInput = $('search-input');
    if (searchInput) {
        let searchTimer = null;
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(performSearch, 300);
        });
        searchInput.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); searchNext(); }
            if (e.key === 'ArrowUp') { e.preventDefault(); searchPrev(); }
            if (e.key === 'Enter') { e.preventDefault(); searchNext(); }
        });
    }

    // Add reaction pickers to new messages dynamically
    // This is handled in addChat override below

    initResizeHandle();
});

// ===== OVERRIDE addChat to add reaction support =====
const originalAddChat = window.addChat;
window.addChat = function(sender, content, type) {
    const result = originalAddChat ? originalAddChat(sender, content, type) : null;
    const messages = $('messages');
    const lastMsg = messages.lastElementChild;
    if (lastMsg && lastMsg.classList.contains('message') && type !== 'system') {
        lastMsg._msgId = Date.now() + Math.random();
        lastMsg.dataset.msgId = lastMsg._msgId;
        addReactionBtn(lastMsg);

        // Animate in
        lastMsg.style.animation = 'fadeIn 0.2s ease';
    }
    return result;
};

// ===== AUTO-DETECT CONNECTION QUALITY =====
// Simulated quality check (would use WebRTC stats in production)
function detectConnectionQuality() {
    if (!myPeer || !myPeer.conn) return;

    // Use RTCPeerConnection.getStats() for real latency measurement
    const pc = myPeer.conn?.conn;
    if (!pc || pc.signalingState !== 'stable') return;

    pc.getStats().then(stats => {
        let latency = 0;
        let activeConnections = 0;
        stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.nominated === true) {
                latency = report.currentRoundTripTime * 1000; // ms
                activeConnections++;
            }
        });

        // If no candidate-pair stats, use rtcp-moment stats as fallback
        if (latency === 0) {
            stats.forEach(report => {
                if (report.type === 'remote-candidate' && report.rtt) {
                    latency = report.rtt;
                }
            });
        }

        // If still no data, assume good (just connected)
        if (latency === 0) {
            latency = 20;
        }

        let bars = 5;
        let status = 'excellent';

        if (latency > 300) { bars = 2; status = 'poor'; }
        else if (latency > 200) { bars = 3; status = 'fair'; }
        else if (latency > 100) { bars = 4; status = 'good'; }

        updateConnectionStatus(status, Math.round(latency), bars);
    }).catch(() => {
        // Fallback if getStats fails (e.g., privacy restrictions)
        updateConnectionStatus('excellent', 20, 5);
    });
}

setInterval(detectConnectionQuality, 5000);
