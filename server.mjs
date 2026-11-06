import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const rootDirectory = dirname(fileURLToPath(import.meta.url));
const distDirectory = join(rootDirectory, 'dist');
const dataDirectory = process.env.DATA_DIR || join(rootDirectory, 'data');
const stateFile = join(dataDirectory, 'game-state.json');
const port = Number(process.env.PORT || 8080);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

await mkdir(dataDirectory, { recursive: true });

let gameState = null;
try {
  const stored = JSON.parse(await readFile(stateFile, 'utf8'));
  if (stored?.version === 1) gameState = stored;
} catch (error) {
  if (error?.code !== 'ENOENT') console.warn('Could not restore the saved game state.', error);
}

let persistenceQueue = Promise.resolve();
function persistState() {
  const serialized = JSON.stringify(gameState, null, 2);
  persistenceQueue = persistenceQueue.then(async () => {
    const temporaryFile = `${stateFile}.tmp`;
    await writeFile(temporaryFile, serialized, 'utf8');
    await rename(temporaryFile, stateFile);
  }).catch((error) => console.error('Could not persist the game state.', error));
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function serveFile(response, requestedFile) {
  const normalizedFile = normalize(requestedFile);
  if (normalizedFile !== distDirectory && !normalizedFile.startsWith(`${distDirectory}/`)) { sendJson(response, 403, { error: 'Forbidden' }); return; }
  try {
    const fileStats = await stat(normalizedFile);
    if (!fileStats.isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' });
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(normalizedFile)] || 'application/octet-stream',
      'Content-Length': fileStats.size,
      'Cache-Control': extname(normalizedFile) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    createReadStream(normalizedFile).pipe(response);
  } catch (error) {
    if (error?.code === 'ENOENT') sendJson(response, 404, { error: 'Not found' });
    else { console.error(error); sendJson(response, 500, { error: 'Server error' }); }
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health') { sendJson(response, 200, { ok: true, boardConnected: countRole('board') > 0 }); return; }
  if (url.pathname === '/') { response.writeHead(302, { Location: '/board' }); response.end(); return; }
  if (url.pathname === '/board' || url.pathname === '/board/') { await serveFile(response, join(distDirectory, 'index.html')); return; }
  if (url.pathname === '/controls' || url.pathname === '/controls/') { await serveFile(response, join(distDirectory, 'controls.html')); return; }
  const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  await serveFile(response, join(distDirectory, relativePath));
});

const webSocketServer = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });

function clientsWithRole(role) {
  return [...webSocketServer.clients].filter((client) => client.readyState === WebSocket.OPEN && client.role === role);
}

function countRole(role) { return clientsWithRole(role).length; }

function send(client, message) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}

function broadcast(message, role) {
  webSocketServer.clients.forEach((client) => {
    if (!role || client.role === role) send(client, message);
  });
}

function broadcastPresence() {
  broadcast({ type: 'presence', boards: countRole('board'), controls: countRole('controls') });
}

webSocketServer.on('connection', (socket) => {
  socket.role = null;
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', (rawMessage, isBinary) => {
    if (isBinary) return;
    let message;
    try { message = JSON.parse(rawMessage.toString()); }
    catch { return; }

    if (message?.type === 'hello' && (message.role === 'board' || message.role === 'controls')) {
      socket.role = message.role;
      if (gameState) send(socket, { type: 'state', state: gameState });
      else if (socket.role === 'board') send(socket, { type: 'state:request' });
      broadcastPresence();
      return;
    }

    if (message?.type === 'state:update' && socket.role === 'board' && message.state?.version === 1) {
      gameState = message.state;
      persistState();
      broadcast({ type: 'state', state: gameState }, 'controls');
      return;
    }

    if (message?.type === 'command' && socket.role === 'controls' && message.command?.type) {
      broadcast({ type: 'command', command: message.command }, 'board');
    }
  });

  socket.on('close', broadcastPresence);
});

const heartbeat = setInterval(() => {
  webSocketServer.clients.forEach((socket) => {
    if (!socket.isAlive) { socket.terminate(); return; }
    socket.isAlive = false;
    socket.ping();
  });
}, 30_000);

server.listen(port, '0.0.0.0', () => console.log(`Catan Enhanced listening on http://0.0.0.0:${port}`));

function shutDown() {
  clearInterval(heartbeat);
  webSocketServer.clients.forEach((socket) => socket.close(1001, 'Server shutting down'));
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutDown);
process.on('SIGINT', shutDown);
