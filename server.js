/**
 * server.js — production-ready server for ar-mirror.
 *
 * Features:
 *   - HTTPS (if certs/server.key + certs/server.crt exist, else HTTP fallback)
 *   - GET  /api/garments       → serves garments.json catalog
 *   - POST /api/events         → appends analytics event to data/events.ndjson
 *   - POST /api/errors         → appends error report to data/errors.ndjson
 *   - GET  /healthz            → health check for cloud platforms
 *   - CSP + security headers on every response
 *   - Path-traversal protection
 *
 * Cloud deploy (Railway / Render):
 *   process.env.PORT is used automatically. TLS is terminated by the platform.
 *
 * Local dev with HTTPS (needed for camera on non-localhost):
 *   node generate-cert.js      ← creates certs/
 *   node server.js             ← auto-detects certs, starts HTTPS on :3443
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT       = parseInt(process.env.PORT, 10) || 3000;
const HTTPS_PORT = 3443;
const ROOT       = __dirname;
const DATA_DIR   = path.join(ROOT, 'data');

// Ensure data directory exists for log files
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── MIME types ────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.wasm': 'application/wasm',
  '.bin':  'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
};

// ── Security headers (added to every response) ───────────────────────────
function securityHeaders(ext) {
  return {
    // MediaPipe WASM shared memory requires these two
    'Cross-Origin-Opener-Policy':   'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    // Camera permission
    'Permissions-Policy': 'camera=*',
    // Content-Security-Policy — tighten for production
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' https://cdn.jsdelivr.net",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options':   'nosniff',
    'X-Frame-Options':          'DENY',
    'Referrer-Policy':          'strict-origin-when-cross-origin',
    'Cache-Control': (ext === '.html' || ext === '') ? 'no-cache, no-store' : 'public, max-age=3600',
  };
}

// ── Read request body as string ───────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end',  () => resolve(body));
    req.on('error', reject);
  });
}

// ── Append one NDJSON line to a log file ─────────────────────────────────
function appendLog(filename, obj) {
  const line = JSON.stringify({ ...obj, _serverTime: new Date().toISOString() }) + '\n';
  fs.appendFile(path.join(DATA_DIR, filename), line, () => {});
}

// ── Rate limiter (per IP, per minute) ─────────────────────────────────────
const _ipCounts = new Map();
setInterval(() => _ipCounts.clear(), 60_000);  // reset every minute
function rateLimit(ip, maxPerMin = 200) {
  const c = (_ipCounts.get(ip) || 0) + 1;
  _ipCounts.set(ip, c);
  return c > maxPerMin;
}

// ── Main request handler ──────────────────────────────────────────────────
async function handleRequest(req, res) {
  const ip      = req.socket.remoteAddress || 'unknown';
  const method  = req.method;
  let   urlPath = req.url.split('?')[0];

  // Rate limiting
  if (rateLimit(ip)) {
    res.writeHead(429, { 'Content-Type': 'text/plain' }); res.end('Too Many Requests'); return;
  }

  // ── Health check (for Railway / Render) ───────────────────────────────
  if (urlPath === '/healthz' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // ── API routes ────────────────────────────────────────────────────────
  if (urlPath === '/api/garments' && method === 'GET') {
    const garmentFile = path.join(ROOT, 'garments.json');
    fs.readFile(garmentFile, 'utf8', (err, data) => {
      if (err) { res.writeHead(500); res.end('{}'); return; }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=30',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    });
    return;
  }

  if (urlPath === '/api/events' && method === 'POST') {
    try {
      const body = await readBody(req);
      const event = JSON.parse(body);
      appendLog('events.ndjson', event);
      res.writeHead(204); res.end();
    } catch (_) { res.writeHead(400); res.end('Bad Request'); }
    return;
  }

  if (urlPath === '/api/errors' && method === 'POST') {
    try {
      const body = await readBody(req);
      const err  = JSON.parse(body);
      appendLog('errors.ndjson', { ...err, ip });
      console.error('[ClientError]', err.message || err);
      res.writeHead(204); res.end();
    } catch (_) { res.writeHead(400); res.end('Bad Request'); }
    return;
  }

  // ── Analytics dashboard ───────────────────────────────────────────────
  if (urlPath === '/dashboard' && method === 'GET') {
    const eventsFile = path.join(DATA_DIR, 'events.ndjson');
    let events = [];
    try {
      const raw = fs.readFileSync(eventsFile, 'utf8');
      events = raw.trim().split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean).reverse(); // newest first
    } catch (_) {}

    // Summarise
    const total     = events.length;
    const tryons    = events.filter(e => e.event === 'tryon_active' || e.event === 'garment_view').length;
    const carts     = events.filter(e => e.event === 'add_to_cart').length;
    const garmentCounts = {};
    events.forEach(e => { if (e.garmentId) garmentCounts[e.garmentId] = (garmentCounts[e.garmentId]||0)+1; });
    const topGarment = Object.entries(garmentCounts).sort((a,b) => b[1]-a[1])[0];

    const rows = events.slice(0, 200).map(e => `
      <tr>
        <td>${(e._serverTime || '').slice(0,19).replace('T',' ')}</td>
        <td><span class="badge badge-${e.event}">${e.event || ''}</span></td>
        <td>${e.garmentId || e.garmentName || ''}</td>
        <td>${e.sessionId ? e.sessionId.slice(0,8) : ''}</td>
        <td>${e.price != null ? '$'+e.price : ''}</td>
      </tr>`).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AR Mirror — Analytics</title>
<meta http-equiv="refresh" content="30">
<style>
  :root { --bg:#0a0a0a; --surface:#141414; --border:#2a2a2a; --fg:#f5f5f5; --muted:#666; --accent:#e5e7eb; --green:#4ade80; --blue:#60a5fa; --yellow:#fbbf24; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--fg); font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size: 13px; padding: 24px; }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { color: var(--muted); font-size: 11px; margin-bottom: 24px; }
  .stats { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 28px; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; min-width: 140px; }
  .stat-val { font-size: 28px; font-weight: 700; color: var(--accent); }
  .stat-label { font-size: 10px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); padding: 8px 12px; border-bottom: 1px solid var(--border); }
  td { padding: 8px 12px; border-bottom: 1px solid #1a1a1a; font-size: 12px; }
  tr:hover td { background: var(--surface); }
  .badge { font-size: 10px; padding: 2px 7px; border-radius: 4px; font-weight: 600; white-space: nowrap; background: #222; color: var(--muted); }
  .badge-garment_view { background: rgba(96,165,250,.15); color: var(--blue); }
  .badge-add_to_cart   { background: rgba(74,222,128,.15); color: var(--green); }
  .badge-tryon_active  { background: rgba(251,191,36,.12); color: var(--yellow); }
  .badge-session_start,.badge-session_end { background: #1a1a1a; color: #555; }
  a { color: var(--blue); text-decoration: none; } a:hover { text-decoration: underline; }
  .refresh-note { color: var(--muted); font-size: 10px; margin-bottom: 16px; }
</style>
</head>
<body>
<h1>AR Mirror — Analytics</h1>
<div class="subtitle"><a href="/">← Back to app</a></div>
<div class="stats">
  <div class="stat-card"><div class="stat-val">${total}</div><div class="stat-label">Total Events</div></div>
  <div class="stat-card"><div class="stat-val">${tryons}</div><div class="stat-label">Try-On Views</div></div>
  <div class="stat-card"><div class="stat-val">${carts}</div><div class="stat-label">Add to Cart</div></div>
  <div class="stat-card"><div class="stat-val">${topGarment ? topGarment[0] : '—'}</div><div class="stat-label">Top Garment</div></div>
</div>
<div class="refresh-note">Auto-refreshes every 30s. Showing ${Math.min(200,total)} of ${total} events (newest first).</div>
<table>
<thead><tr><th>Time (UTC)</th><th>Event</th><th>Garment</th><th>Session</th><th>Price</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" style="color:#555;padding:24px 12px">No events logged yet — open the app and try on a garment.</td></tr>'}</tbody>
</table>
</body></html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
    return;
  }

  // CORS preflight for API
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  // ── Static files ──────────────────────────────────────────────────────
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(ROOT, urlPath);
  const ext      = path.extname(filePath).toLowerCase();
  const mime     = MIME[ext] || 'application/octet-stream';

  // Security: prevent path traversal outside ROOT
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`404: ${urlPath}`);
      } else {
        res.writeHead(500); res.end('Server error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': mime, ...securityHeaders(ext) });
    res.end(data);
  });
}

// ── Boot servers ──────────────────────────────────────────────────────────
const KEY_FILE = path.join(ROOT, 'certs', 'server.key');
const CRT_FILE = path.join(ROOT, 'certs', 'server.crt');

const hasCerts = fs.existsSync(KEY_FILE) && fs.existsSync(CRT_FILE);

if (hasCerts && !process.env.PORT) {
  // Local dev with HTTPS (not used on cloud — cloud terminates TLS)
  const credentials = {
    key:  fs.readFileSync(KEY_FILE),
    cert: fs.readFileSync(CRT_FILE),
  };
  https.createServer(credentials, handleRequest).listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  AR Mirror — HTTPS server running (local dev)');
    console.log(`  https://localhost:${HTTPS_PORT}`);
    console.log('  (Accept the self-signed cert warning once in browser)');
  });

  // HTTP → HTTPS redirect (local only)
  http.createServer((req, res) => {
    const host = req.headers.host?.replace(/:∙d+$/, '') || 'localhost';
    res.writeHead(301, { Location: `https://${host}:${HTTPS_PORT}${req.url}` });
    res.end();
  }).listen(PORT, '0.0.0.0');

} else {
  // Cloud or plain HTTP (Railway / Render inject process.env.PORT)
  http.createServer(handleRequest).listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  AR Mirror server running');
    console.log(`  http://0.0.0.0:${PORT}`);
    if (!process.env.PORT) {
      console.log(`  http://localhost:${PORT}`);
      console.log('');
      console.log('  Tip: run  node generate-cert.js  for HTTPS (needed for non-localhost camera)');
    }
  });
}

console.log(`  API:  GET  /api/garments`);
console.log(`        POST /api/events   → data/events.ndjson`);
console.log(`        POST /api/errors   → data/errors.ndjson`);
console.log(`        GET  /dashboard    → analytics dashboard`);
console.log(`        GET  /healthz      → health check`);
console.log('');
console.log('  Ctrl+C to stop');
