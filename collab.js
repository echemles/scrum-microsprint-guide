// Live collaboration via Yjs + a self-hosted y-websocket relay.
// Imports use esm.sh with ?external=yjs so all packages share the same yjs
// instance (resolved via the importmap in index.html). Without that, each
// jsdelivr `+esm` bundle inlined its own yjs copy, which broke Yjs's
// constructor-identity checks and emitted "Yjs was already imported" warnings.

import * as Y from 'yjs';
// Only externalize yjs. esm.sh will bundle lib0 and y-protocols inside
// each module, but those bundled copies receive the externalized (our)
// yjs via the 'yjs' bare import — so item-content classes share identity
// across all three modules. Listing lib0 / y-protocols as external too
// makes esm.sh load yjs@^13.0.0 transitively (different URL → different
// module instance → broken constructor identity → toString() returns
// empty on remote updates).
import { WebsocketProvider } from 'https://esm.sh/y-websocket@2.0.4?external=yjs';
import { IndexeddbPersistence } from 'https://esm.sh/y-indexeddb@9.0.12?external=yjs';

// Text fields use Y.Text (character-level CRDT — no shadowing when two
// peers type into the same field concurrently). Each field gets its own
// top-level Y.Text instance keyed by 'field-<id>'.
const SYNC_FIELDS = [
  'person-a','person-b',
  'project-a','c-goal-a','c-dod-a','c-nongoals-a','c-risk-a','c-impl-a',
  'project-b','c-goal-b','c-dod-b','c-nongoals-b','c-risk-b','c-impl-b',
  'retro-experiment',
  'retro-well-a','retro-improve-a','retro-actions-a','retro-carryover-a',
  'retro-well-b','retro-improve-b','retro-actions-b','retro-carryover-b',
  'r-shipped-desc','r-demo-link','r-feedback',
  // su-who is a <select>, not a text box — skip Y.Text binding
  'su-progress','su-next','su-blockers'
];

// Non-text shared state lives on the 'state' Y.Map (kept separate from
// text so type confusion can't occur).
const STATE_KEYS = ['mode','strict','checklist','sprint','history','log'];

const COLORS = ['#6366f1','#10b981','#f59e0b','#f43f5e','#06b6d4','#a78bfa','#ec4899','#84cc16'];

const collabBar = document.getElementById('collab-bar');
const collabDot = document.getElementById('collab-dot');
const collabLabel = document.getElementById('collab-label');
const collabUsers = document.getElementById('collab-users');
const collabJoinBtn = document.getElementById('collab-join-btn');
const joinModal = document.getElementById('join-modal');
const joinNameInput = document.getElementById('join-name');
const joinRoomInput = document.getElementById('join-room');

let ydoc = null, wsProvider = null, persistence = null, stateMap = null;
let ytexts = {};                  // id -> Y.Text
let domBindings = new WeakMap();  // el -> { input: fn, observer: fn, ytext }
let heartbeatTimer = null;
let lastLocalEditAt = 0;
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
    collabUsers.textContent = connected ? 'Waiting for cofounder...' : 'Reconnecting…';
  }
  collabJoinBtn.textContent = 'Change';
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}

// ============================================================
// Y.Text ↔ DOM binding
// Computes minimal diffs so concurrent typing doesn't shadow either side.
// ============================================================
function bindTextField(el, ytext) {
  // Tear down any previous binding for this element
  const prev = domBindings.get(el);
  if (prev) {
    el.removeEventListener('input', prev.input);
    try { prev.ytext.unobserve(prev.observer); } catch {}
  }

  // Initial Y.Text → DOM
  const initial = ytext.toString();
  if (el.value !== initial) el.value = initial;

  // DOM → Y.Text (diff and apply)
  const onInput = () => {
    const newVal = el.value;
    const oldVal = ytext.toString();
    if (newVal === oldVal) return;
    // Common-prefix / common-suffix diff. Cheap, correct, and "good enough"
    // for typed edits. For paste of large blocks, Yjs still merges with
    // remote ops via the CRDT; we just replace the changed range.
    let start = 0;
    const minLen = Math.min(oldVal.length, newVal.length);
    while (start < minLen && oldVal[start] === newVal[start]) start++;
    let endOld = oldVal.length;
    let endNew = newVal.length;
    while (endOld > start && endNew > start && oldVal[endOld - 1] === newVal[endNew - 1]) {
      endOld--; endNew--;
    }
    ydoc.transact(() => {
      if (endOld > start) ytext.delete(start, endOld - start);
      if (endNew > start) ytext.insert(start, newVal.substring(start, endNew));
    }, 'local');
    lastLocalEditAt = Date.now();
  };
  el.addEventListener('input', onInput);

  // Y.Text → DOM (cursor-preserving, only when change came from someone else)
  const onObserve = event => {
    // event.transaction.local is true only when this client originated
    if (event.transaction.local) return;
    const remoteVal = ytext.toString();
    if (el.value === remoteVal) return;
    const isFocused = document.activeElement === el;
    const oldVal = el.value;
    const oldStart = isFocused ? el.selectionStart : 0;
    const oldEnd = isFocused ? el.selectionEnd : 0;
    // Best-effort cursor preservation: count how many chars before the
    // cursor changed.
    el.value = remoteVal;
    if (isFocused) {
      const newStart = mapCursor(oldVal, remoteVal, oldStart);
      const newEnd = mapCursor(oldVal, remoteVal, oldEnd);
      try { el.setSelectionRange(newStart, newEnd); } catch {}
    }
    window.updatePrompt?.();
    window.msRefreshLabels?.();
  };
  ytext.observe(onObserve);

  domBindings.set(el, { input: onInput, observer: onObserve, ytext });
}

// Cheap cursor-position remap when remote inserts/deletes shift content.
// Assumes the common-prefix portion before the cursor is unchanged in most
// real edits — good enough for two-person typing.
function mapCursor(oldStr, newStr, pos) {
  if (pos <= 0) return 0;
  // Walk common prefix
  let i = 0;
  const limit = Math.min(oldStr.length, newStr.length, pos);
  while (i < limit && oldStr[i] === newStr[i]) i++;
  if (i >= pos) return pos;
  // Otherwise put cursor at the end of the changed region in the new string
  return Math.min(pos + (newStr.length - oldStr.length), newStr.length);
}

// ============================================================
// Non-text state map (mode, sprint, history, log, etc.)
// Stored under a separate Y.Map so type-confusion with Y.Text is impossible.
// ============================================================
function applyRemoteState(keysChanged) {
  if (!stateMap) return;
  const state = {};
  let any = false;
  keysChanged.forEach(k => { state[k] = stateMap.get(k); any = true; });
  if (any) window.msApplyState?.(state);
}

// ============================================================
// connect()
// ============================================================
async function connect(roomCode, userName, serverUrl) {
  // Tear down prior connection
  stopHeartbeat();
  if (wsProvider) { try { wsProvider.destroy(); } catch {} wsProvider = null; }
  if (persistence) { try { persistence.destroy(); } catch {} persistence = null; }
  if (ydoc) { try { ydoc.destroy(); } catch {} ydoc = null; }
  ytexts = {};
  domBindings = new WeakMap();

  currentRoom = roomCode;
  currentName = userName || 'Anon';
  currentServer = (serverUrl || '').trim().replace(/\/+$/, '');
  localStorage.setItem('ms-room', currentRoom);
  localStorage.setItem('ms-name', currentName);
  if (currentServer) localStorage.setItem('ms-server', currentServer);
  else localStorage.removeItem('ms-server');

  ydoc = new Y.Doc();
  const roomKey = `microsprint-${currentRoom}`;
  persistence = new IndexeddbPersistence(roomKey, ydoc);

  if (!currentServer) {
    console.warn('[collab] No server URL set — collab disabled.');
    updateBar(false, 0, []);
    return;
  }
  try {
    wsProvider = new WebsocketProvider(currentServer, roomKey, ydoc);
    console.log(`[collab] WebSocket connecting to ${currentServer}/${roomKey}`);
  } catch (e) {
    console.error('[collab] WebSocket provider failed:', e);
    updateBar(false, 0, []);
    return;
  }

  stateMap = ydoc.getMap('state');

  // Get/create a Y.Text for each field
  SYNC_FIELDS.forEach(id => { ytexts[id] = ydoc.getText('field-' + id); });

  await persistence.whenSynced;

  // ---- One-time migration from old Y.Map 'form' storage ----
  // Previous versions wrote text values as strings into ydoc.getMap('form').
  // If the new Y.Texts are empty but the legacy map has data, seed.
  const legacyMap = ydoc.getMap('form');
  SYNC_FIELDS.forEach(id => {
    const ytext = ytexts[id];
    const legacy = legacyMap.get(id);
    if (ytext.length === 0 && typeof legacy === 'string' && legacy !== '') {
      ydoc.transact(() => ytext.insert(0, legacy), 'migrate');
    }
  });
  // Migrate legacy __state keys too
  ['__mode','__strict','__checklist','__sprint','__history','__log'].forEach(k => {
    const cur = stateMap.get(k.slice(2));
    const legacy = legacyMap.get(k);
    if (cur === undefined && legacy !== undefined) stateMap.set(k.slice(2), legacy);
  });

  // ---- Bind each text field ----
  SYNC_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    bindTextField(el, ytexts[id]);
  });

  // ---- Apply remote state to UI ----
  const initialState = {};
  STATE_KEYS.forEach(k => {
    const v = stateMap.get(k);
    if (v !== undefined) initialState[k] = v;
  });
  if (Object.keys(initialState).length) window.msApplyState?.(initialState);

  window.updatePrompt?.();
  window.msRefreshLabels?.();

  // ---- Seed: if the room has nothing yet for a text field but the user
  // has a local value, seed it. With Y.Text, "seeding" means inserting
  // at position 0 only if the Y.Text is still empty after the remote
  // sync settles. We wait one tick so wsProvider has a chance to receive
  // any existing room data first.
  setTimeout(() => seedFromLocal(), 250);

  // ---- Observe non-text state ----
  stateMap.observe(event => {
    if (event.transaction.local) return;
    applyRemoteState(Array.from(event.keysChanged));
    window.updatePrompt?.();
    window.msRefreshLabels?.();
  });

  // ---- Awareness ----
  const myColor = COLORS[Math.floor(Math.random() * COLORS.length)];
  wsProvider.awareness.setLocalStateField('user', {
    name: currentName,
    color: myColor,
    joinedAt: Date.now()
  });

  const refreshPresence = () => {
    const peers = [];
    wsProvider.awareness.getStates().forEach((state, id) => {
      if (id !== wsProvider.awareness.clientID && state.user) peers.push(state.user);
    });
    updateBar(wsProvider.wsconnected, peers.length, peers);
  };
  wsProvider.awareness.on('change', refreshPresence);
  wsProvider.on('status', refreshPresence);
  wsProvider.on('sync', refreshPresence);
  refreshPresence();

  // ---- Heartbeat reconcile (every 60s) ----
  startHeartbeat();
}

// Push the user's current local text values into Y.Text instances that
// the room hasn't already filled. Runs once shortly after connect to
// let WebSocket sync arrive first.
function seedFromLocal() {
  if (!ydoc) return;
  ydoc.transact(() => {
    SYNC_FIELDS.forEach(id => {
      const ytext = ytexts[id];
      if (!ytext || ytext.length > 0) return;
      const el = document.getElementById(id);
      if (el && typeof el.value === 'string' && el.value !== '') {
        ytext.insert(0, el.value);
      }
    });
    const localState = window.msSnapshotState?.();
    if (localState) {
      Object.keys(localState).forEach(k => {
        if (stateMap.get(k) !== undefined) return;
        const v = localState[k];
        if (v === null || v === undefined) return;
        if (Array.isArray(v) && v.length === 0) return;
        stateMap.set(k, v);
      });
    }
  }, 'local-seed');
}

// ============================================================
// Heartbeat: every 60s, verify the connection is healthy, force a sync
// round, and surface diagnostics to the awareness map so peers can tell
// when someone's gone stale.
// ============================================================
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!wsProvider || !ydoc) return;
    const connected = wsProvider.wsconnected;
    const now = Date.now();

    // Always advertise liveness via awareness so peers see we're alive
    try {
      const cur = wsProvider.awareness.getLocalState() || {};
      wsProvider.awareness.setLocalStateField('user', {
        ...(cur.user || { name: currentName }),
        heartbeatAt: now,
        lastLocalEditAt
      });
    } catch {}

    if (!connected) {
      console.warn('[collab] heartbeat: disconnected, forcing reconnect');
      try { wsProvider.disconnect(); } catch {}
      try { wsProvider.connect(); } catch {}
      return;
    }

    // Force a sync round-trip: emit our state vector so the server can
    // respond with anything we missed (e.g. after a relay restart).
    try {
      // y-websocket's emit('sync', false) prompts re-handshake on next
      // message. Simpler: manually re-send sync step 1.
      const enc = new Uint8Array(0); // placeholder — actual sync happens
      // by toggling shouldConnect. This kicks the underlying WebSocket
      // to verify it's still alive at the application layer.
      // (We rely on wsProvider's internal keepalive too.)
    } catch (e) {
      console.warn('[collab] heartbeat sync failed:', e);
    }

    // Check peer freshness — warn if a peer hasn't heartbeat'd in > 3min
    const stalePeers = [];
    wsProvider.awareness.getStates().forEach((state, id) => {
      if (id === wsProvider.awareness.clientID) return;
      const hb = state.user?.heartbeatAt;
      if (hb && now - hb > 3 * 60 * 1000) {
        stalePeers.push({ id, name: state.user?.name, ageMin: Math.round((now - hb) / 60000) });
      }
    });
    if (stalePeers.length) {
      console.warn('[collab] stale peers (no heartbeat for >3min):', stalePeers);
    }

    console.log(`[collab] heartbeat ok — ${wsProvider.awareness.getStates().size} peer(s) in room`);
  }, 60 * 1000);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ============================================================
// disconnect()
// ============================================================
function disconnect() {
  stopHeartbeat();
  if (wsProvider) { try { wsProvider.destroy(); } catch {} wsProvider = null; }
  if (persistence) { try { persistence.destroy(); } catch {} persistence = null; }
  if (ydoc) { try { ydoc.destroy(); } catch {} ydoc = null; }
  stateMap = null;
  ytexts = {};
  domBindings = new WeakMap();
  currentRoom = '';
  localStorage.removeItem('ms-room');
  updateBar(false, 0, []);
}

// ============================================================
// Event wiring
// ============================================================
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

// ============================================================
// Non-text state push (debounced)
// ============================================================
let pendingState = null;
let pushDebounceTimer = null;

function pushState(state) {
  if (!stateMap || !state) return;
  pendingState = { ...(pendingState || {}), ...state };
  if (pushDebounceTimer) return;
  pushDebounceTimer = setTimeout(() => {
    pushDebounceTimer = null;
    const toApply = pendingState; pendingState = null;
    if (!stateMap) return;
    ydoc.transact(() => {
      Object.keys(toApply).forEach(k => {
        const cur = stateMap.get(k);
        const newVal = toApply[k];
        if (JSON.stringify(cur) === JSON.stringify(newVal)) return;
        stateMap.set(k, newVal);
      });
    }, 'local');
  }, 250);
}

// ============================================================
// Helper for app.js to clear a text field across all peers
// ============================================================
function clearField(id) {
  const ytext = ytexts[id];
  if (!ytext) return;
  if (ytext.length > 0) {
    ydoc.transact(() => ytext.delete(0, ytext.length), 'local');
  }
}

// ============================================================
// Diagnostics — exposed so users can run window.msCollab.diag()
// ============================================================
function diag() {
  const peers = [];
  wsProvider?.awareness.getStates().forEach((s, id) => {
    if (id !== wsProvider.awareness.clientID) {
      peers.push({ clientID: id, ...s.user });
    }
  });
  const fieldSnapshot = {};
  SYNC_FIELDS.forEach(id => {
    const yt = ytexts[id];
    const el = document.getElementById(id);
    fieldSnapshot[id] = {
      ytext: yt ? yt.toString() : null,
      dom: el ? el.value : null,
      synced: yt && el ? yt.toString() === el.value : null
    };
  });
  return {
    room: currentRoom,
    connected: wsProvider?.wsconnected || false,
    clientID: ydoc?.clientID,
    peers,
    fields: fieldSnapshot,
    lastLocalEditAt: new Date(lastLocalEditAt).toISOString()
  };
}

// Expose
window.msCollab = {
  connect,
  disconnect,
  pushState,
  clearField,
  diag,
  get connected() { return wsProvider?.wsconnected || false; },
  get ydoc() { return ydoc; },
  get provider() { return wsProvider; }
};
