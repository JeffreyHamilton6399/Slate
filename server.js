const http = require('node:http');
const os   = require('node:os');
const path = require('node:path');

let express;
let ExpressPeerServer;
let compression;
try {
  express = require('express');
  ({ ExpressPeerServer } = require('peer'));
  compression = require('compression');
} catch (err) {
  console.error('Missing dependencies.');
  console.error('Run "npm install" once, then run "npm start".');
  process.exit(1);
}

const PORT = Number(process.env.PORT || 8080);
// How long (ms) before the server closes an idle keep-alive connection.
// Node default is 5 s which causes premature 502s behind most proxies/LBs;
// 65 s is safely above the 60 s idle timeout used by AWS ALB / Fly / Railway.
const KEEP_ALIVE_TIMEOUT = Number(process.env.KEEP_ALIVE_TIMEOUT || 65_000);
const ROOT = __dirname;

const app    = express();
const server = http.createServer(app);
server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT;
server.headersTimeout   = KEEP_ALIVE_TIMEOUT + 1_000;

// ── Middleware ────────────────────────────────────────────────────────────────

// Gzip/Brotli the HTML and JS responses — cuts wire bytes ~70%.
// PeerJS WebSocket upgrades are not affected.
app.use(compression({ threshold: 1024 }));

// Trust proxy headers (X-Forwarded-For etc.) when running behind Fly/Railway/nginx.
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

// ── PeerJS signaling ──────────────────────────────────────────────────────────
const peerServer = ExpressPeerServer(server, {
  path: '/',
  proxied: true,
});

function clientId(client) {
  return typeof client?.getId === 'function' ? client.getId() : String(client || 'unknown');
}

app.use('/peerjs', peerServer);

// ── Health check — used by container orchestrators / uptime monitors ──────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(ROOT, {
  etag: false,
  index: false,
  maxAge: 0,
  setHeaders(res) {
    res.setHeader('cache-control', 'no-cache');
  },
}));

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.method !== 'GET') { res.sendStatus(404); return; }
  res.setHeader('cache-control', 'no-cache');
  res.sendFile(path.join(ROOT, 'index.html'));
});

// ── PeerJS events ─────────────────────────────────────────────────────────────
peerServer.on('connection',  client => console.log(`[peer] connected    ${clientId(client)}`));
peerServer.on('disconnect',  client => console.log(`[peer] disconnected ${clientId(client)}`));

// ── Helpers ───────────────────────────────────────────────────────────────────
function localUrls() {
  const urls = [`http://localhost:${PORT}`];
  Object.values(os.networkInterfaces()).flat().forEach(net => {
    if (!net || net.internal || net.family !== 'IPv4') return;
    urls.push(`http://${net.address}:${PORT}`);
  });
  return urls;
}

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('Slate app:');
  localUrls().forEach(url => console.log(`  ${url}`));
  console.log('PeerJS signaling: /peerjs');
  console.log(`Health check:     http://localhost:${PORT}/health`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down…`);
  server.close(err => {
    if (err) { console.error('Shutdown error:', err); process.exit(1); }
    console.log('Server closed. Goodbye.');
    process.exit(0);
  });
  setTimeout(() => { console.error('Force exit after timeout'); process.exit(1); }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
