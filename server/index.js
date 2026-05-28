// Minimal Yjs WebSocket relay for the Microsprint OS app.
// No dependency on y-websocket internals — implements the wire protocol
// directly via y-protocols + ws + lib0, which all publish proper subpath
// exports under strict ESM (unlike y-websocket which broke ./bin/utils.js).

import http from 'http';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const PORT = process.env.PORT || 1234;
const PING_TIMEOUT = 30000;

// Message types — must match what y-websocket client uses
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

// roomname -> { ydoc, awareness, conns: Set<ws> }
const rooms = new Map();

function getRoom(name) {
  let room = rooms.get(name);
  if (room) return room;

  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  awareness.setLocalState(null);
  const conns = new Set();

  // Broadcast doc updates to every connected peer except origin
  ydoc.on('update', (update, origin) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const msg = encoding.toUint8Array(enc);
    conns.forEach(ws => { if (ws !== origin && ws.readyState === 1) ws.send(msg); });
  });

  // Broadcast awareness changes to everyone (including origin's own clientID
  // can be filtered by clients; matches y-websocket behaviour)
  awareness.on('update', ({ added, updated, removed }) => {
    const changedClients = added.concat(updated, removed);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
    );
    const msg = encoding.toUint8Array(enc);
    conns.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
  });

  room = { ydoc, awareness, conns };
  rooms.set(name, room);
  return room;
}

function send(ws, msg) {
  if (ws.readyState !== 1) return;
  try { ws.send(msg); } catch (e) { ws.close(); }
}

function setupConnection(ws, req) {
  ws.binaryType = 'arraybuffer';

  // Pathname after the host is the room name (e.g. /microsprint-foo)
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; }
  catch { pathname = req.url || '/'; }
  const roomname = pathname.replace(/^\/+/, '') || 'default';

  const room = getRoom(roomname);
  room.conns.add(ws);
  // Track which awareness client IDs were contributed by this socket so we
  // can clean them up on disconnect
  const controlledIds = new Set();

  ws.on('message', data => {
    try {
      const buf = new Uint8Array(data);
      const dec = decoding.createDecoder(buf);
      const messageType = decoding.readVarUint(dec);
      const enc = encoding.createEncoder();

      if (messageType === MSG_SYNC) {
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, enc, room.ydoc, ws);
        if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
      } else if (messageType === MSG_AWARENESS) {
        const update = decoding.readVarUint8Array(dec);
        // Track clientIds so we can clear them on disconnect
        const decoded = decoding.createDecoder(update);
        const len = decoding.readVarUint(decoded);
        for (let i = 0; i < len; i++) {
          const clientId = decoding.readVarUint(decoded);
          controlledIds.add(clientId);
          // Skip clock and state
          decoding.readVarUint(decoded);
          decoding.readVarString(decoded);
        }
        awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);
      }
    } catch (err) {
      console.error('[relay] message error:', err.message);
    }
  });

  const cleanup = () => {
    room.conns.delete(ws);
    if (controlledIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(controlledIds), null);
    }
    if (room.conns.size === 0) {
      // Free memory after grace period
      setTimeout(() => { if (room.conns.size === 0) rooms.delete(roomname); }, 60000);
    }
  };

  ws.on('close', cleanup);
  ws.on('error', () => { try { ws.close(); } catch {} cleanup(); });

  // Keep connection alive (some PaaS providers kill idle WS after 30-60s)
  let pongOk = true;
  const interval = setInterval(() => {
    if (!pongOk) { try { ws.terminate(); } catch {} clearInterval(interval); return; }
    pongOk = false;
    try { ws.ping(); } catch {}
  }, PING_TIMEOUT);
  ws.on('pong', () => { pongOk = true; });
  ws.on('close', () => clearInterval(interval));

  // Send sync step 1 + current awareness to bring the new peer up to date
  const syncEnc = encoding.createEncoder();
  encoding.writeVarUint(syncEnc, MSG_SYNC);
  syncProtocol.writeSyncStep1(syncEnc, room.ydoc);
  send(ws, encoding.toUint8Array(syncEnc));

  const states = room.awareness.getStates();
  if (states.size > 0) {
    const awEnc = encoding.createEncoder();
    encoding.writeVarUint(awEnc, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      awEnc,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys()))
    );
    send(ws, encoding.toUint8Array(awEnc));
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`Microsprint relay running. Rooms: ${rooms.size}. Connect via wss://<this-host>/<room-name>`);
});

const wss = new WebSocketServer({ server });
wss.on('connection', setupConnection);

server.listen(PORT, () => {
  console.log(`Microsprint relay listening on ${PORT}`);
});
