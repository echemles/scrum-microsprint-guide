// Tiny y-websocket relay for the Microsprint OS app.
// Runs anywhere Node 18+ runs. Free tier on Render/Fly/Railway works fine.

import http from 'http';
import { WebSocketServer } from 'ws';
import { setupWSConnection } from 'y-websocket/bin/utils.js';

const PORT = process.env.PORT || 1234;

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Microsprint y-websocket relay is running. Connect via wss://<this-host>/');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (conn, req) => {
  setupWSConnection(conn, req);
});

server.listen(PORT, () => {
  console.log(`Microsprint relay listening on ${PORT}`);
});
