// Live collaboration via Yjs + WebRTC (peer-to-peer)
// No backend; uses public signaling server. Share a room code to sync.

import * as Y from 'https://cdn.jsdelivr.net/npm/yjs@13.6.20/+esm';
import { WebrtcProvider } from 'https://cdn.jsdelivr.net/npm/y-webrtc@10.3.0/+esm';
import { WebsocketProvider } from 'https://cdn.jsdelivr.net/npm/y-websocket@2.0.4/+esm';
import { IndexeddbPersistence } from 'https://cdn.jsdelivr.net/npm/y-indexeddb@9.0.12/+esm';

const SYNC_FIELDS = [
  'project-a','c-goal-a','c-dod-a','c-nongoals-a','c-risk-a','c-impl-a',
  'project-b','c-goal-b','c-dod-b','c-nongoals-b','c-risk-b','c-impl-b',
  'retro-experiment',
  'retro-well-a','retro-improve-a','retro-actions-a','retro-carryover-a',
  'retro-well-b','retro-improve-b','retro-actions-b','retro-carryover-b'
];

const COLORS = ['#6366f1','#10b981','#f59e0b','#f43f5e','#06b6d4','#a78bfa','#ec4899','#84cc16'];

const collabBar = document.getElementById('collab-bar');
const collabDot = document.getElementById('collab-dot');
const collabLabel = document.getElementById('collab-label');
const collabUsers = document.getElementById('collab-users');
const collabJoinBtn = document.getElementById('collab-join-btn');
const joinModal = document.getElementById('join-modal');
const joinNameInput = document.getElementById('join-name');
const joinRoomInput = document.getElementById('join-room');

let ydoc = null, provider = null, wsProvider = null, persistence = null, ymap = null;
let currentRoom = localStorage.getItem('ms-room') || '';
let currentName = localStorage.getItem('ms-name') || '';
let currentServer = localStorage.getItem('ms-server') || '';

function openJoinModal() {
  joinNameInput.value = currentName;
  joinRoomInput.value = currentRoom;
  document.getElementById('join-server').value = currentServer;
  joinModal.classList.add('open');
  joinModal.setAttribute('aria-hidden', 'false');
  setTimeout(() => (currentName ? joinRoomInput : joinNameInput).focus(), 100);
}

function closeJoinModal() {
  joinModal.classList.remove('open');
  joinModal.setAttribute('aria-hidden', 'true');
}

function randomRoom() {
  const words = ['sprint','build','demo','ship','focus','flow','launch','rocket','pulse','craft'];
  const w1 = words[Math.floor(Math.random() * words.length)];
  const w2 = words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(Math.random() * 900) + 100;
  return `${w1}-${w2}-${n}`;
}

function updateBar(connected, peerCount, peers) {
  if (!currentRoom) {
    collabDot.style.background = 'var(--text-dim)';
    collabLabel.textContent = 'Solo';
    collabUsers.textContent = '';
    collabJoinBtn.textContent = 'Join Room';
    return;
  }
  collabDot.style.background = connected ? 'var(--emerald)' : 'var(--amber)';
  collabLabel.textContent = `Room: ${currentRoom}`;
  if (peerCount > 0) {
    const names = peers.map(p => `<span style="color:${p.color}">${escapeHtml(p.name)}</span>`).join(', ');
    collabUsers.innerHTML = `${peerCount + 1} online: <strong>You</strong>${names ? ', ' + names : ''}`;
  } else {
    collabUsers.textContent = 'Waiting for cofounder...';
  }
  collabJoinBtn.textContent = 'Change';
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}

async function connect(roomCode, userName, serverUrl) {
  // Disconnect previous if any
  if (provider) { try { provider.destroy(); } catch {} provider = null; }
  if (wsProvider) { try { wsProvider.destroy(); } catch {} wsProvider = null; }
  if (persistence) { try { persistence.destroy(); } catch {} persistence = null; }
  if (ydoc) { try { ydoc.destroy(); } catch {} ydoc = null; }

  currentRoom = roomCode;
  currentName = userName || 'Anon';
  currentServer = (serverUrl || '').trim().replace(/\/+$/, ''); // strip trailing slashes
  localStorage.setItem('ms-room', currentRoom);
  localStorage.setItem('ms-name', currentName);
  if (currentServer) localStorage.setItem('ms-server', currentServer);
  else localStorage.removeItem('ms-server');

  ydoc = new Y.Doc();
  const roomKey = `microsprint-${currentRoom}`;
  persistence = new IndexeddbPersistence(roomKey, ydoc);

  // PRIMARY: WebSocket relay (reliable, works through any NAT/firewall)
  if (currentServer) {
    try {
      wsProvider = new WebsocketProvider(currentServer, roomKey, ydoc);
      console.log(`[collab] WebSocket connecting to ${currentServer}/${roomKey}`);
    } catch (e) { console.warn('WebSocket provider failed:', e); }
  } else {
    console.warn('[collab] No server URL set. Sync will only work if WebRTC peer connection succeeds (unreliable). Deploy a relay: see server/README.md');
  }

  // SECONDARY: WebRTC (peer-to-peer, attempts direct connection — often fails behind NAT)
  try {
    provider = new WebrtcProvider(roomKey, ydoc, {
      signaling: ['wss://signaling.yjs.dev'],
      maxConns: 20,
      filterBcConns: true
    });
  } catch (e) { console.warn('WebRTC provider failed:', e); }

  ymap = ydoc.getMap('form');

  await persistence.whenSynced;

  // Apply Yjs state → DOM
  SYNC_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const v = ymap.get(id);
    if (typeof v === 'string') el.value = v;
  });
  window.updatePrompt?.();

  // DOM input → Yjs (replace previous listeners by using a dedicated handler)
  SYNC_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el || el._collabBound) return;
    el._collabBound = true;
    el.addEventListener('input', () => {
      ymap.set(id, el.value);
    });
  });

  // Yjs → DOM (remote updates)
  ymap.observe(event => {
    event.keysChanged.forEach(key => {
      const el = document.getElementById(key);
      if (!el) return;
      const v = ymap.get(key);
      if (typeof v === 'string' && el.value !== v) {
        // Preserve cursor position when possible
        const isFocused = document.activeElement === el;
        const start = isFocused ? el.selectionStart : null;
        const end = isFocused ? el.selectionEnd : null;
        el.value = v;
        if (isFocused && start !== null) {
          try { el.setSelectionRange(start, end); } catch {}
        }
      }
    });
    window.updatePrompt?.();
  });

  // Awareness (presence) — set on both providers
  const myColor = COLORS[Math.floor(Math.random() * COLORS.length)];
  if (provider?.awareness) provider.awareness.setLocalStateField('user', { name: currentName, color: myColor });
  if (wsProvider?.awareness) wsProvider.awareness.setLocalStateField('user', { name: currentName, color: myColor });

  const refreshPresence = () => {
    // Merge states from both providers, dedupe by clientID
    const all = new Map();
    if (provider?.awareness) {
      provider.awareness.getStates().forEach((state, id) => { if (id !== provider.awareness.clientID && state.user) all.set(id, state.user); });
    }
    if (wsProvider?.awareness) {
      wsProvider.awareness.getStates().forEach((state, id) => { if (id !== wsProvider.awareness.clientID && state.user) all.set(id, state.user); });
    }
    const peers = Array.from(all.values());
    const connected = (provider?.connected || false) || (wsProvider?.wsconnected || false);
    updateBar(connected, peers.length, peers);
  };
  provider?.awareness?.on('change', refreshPresence);
  wsProvider?.awareness?.on('change', refreshPresence);
  provider?.on('status', refreshPresence);
  provider?.on('peers', refreshPresence);
  wsProvider?.on('status', refreshPresence);
  wsProvider?.on('sync', refreshPresence);
  refreshPresence();
}

function disconnect() {
  if (provider) { try { provider.destroy(); } catch {} provider = null; }
  if (wsProvider) { try { wsProvider.destroy(); } catch {} wsProvider = null; }
  if (persistence) { try { persistence.destroy(); } catch {} persistence = null; }
  if (ydoc) { try { ydoc.destroy(); } catch {} ydoc = null; }
  ymap = null;
  currentRoom = '';
  localStorage.removeItem('ms-room');
  // Keep ms-server so user doesn't have to re-paste it next time
  updateBar(false, 0, []);
}

// Event wiring
collabJoinBtn.addEventListener('click', openJoinModal);
document.getElementById('join-modal-close').addEventListener('click', closeJoinModal);
document.getElementById('join-modal-backdrop').addEventListener('click', closeJoinModal);
document.getElementById('join-random').addEventListener('click', () => { joinRoomInput.value = randomRoom(); });

document.getElementById('join-confirm-btn').addEventListener('click', async () => {
  const room = joinRoomInput.value.trim();
  const name = joinNameInput.value.trim() || 'Anon';
  const server = document.getElementById('join-server').value.trim();
  if (!room) { joinRoomInput.focus(); return; }
  closeJoinModal();
  await connect(room, name, server);
});

document.getElementById('join-leave-btn').addEventListener('click', () => {
  disconnect();
  closeJoinModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && joinModal.classList.contains('open')) closeJoinModal();
});

// Auto-connect if we have a saved room
if (currentRoom && currentName) {
  connect(currentRoom, currentName, currentServer).catch(err => {
    console.error('Collab connect failed:', err);
    updateBar(false, 0, []);
  });
} else {
  updateBar(false, 0, []);
}

// Expose for debugging
window.msCollab = { connect, disconnect, get ydoc() { return ydoc; }, get provider() { return provider; } };
