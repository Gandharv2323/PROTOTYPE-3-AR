/**
 * generate-cert.js — creates a self-signed TLS cert for local HTTPS.
 *
 * Run once:  node generate-cert.js
 * Then start server:  node server.js
 *
 * The cert is only for localhost — browsers will show a security warning
 * the first time. Click "Advanced → Proceed to localhost" once.
 *
 * For production: use Let's Encrypt (Caddy/certbot) instead.
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const CERT_DIR = path.join(__dirname, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'server.key');
const CRT_FILE = path.join(CERT_DIR, 'server.crt');

if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

if (fs.existsSync(KEY_FILE) && fs.existsSync(CRT_FILE)) {
  console.log('✓ Certs already exist at certs/server.key + certs/server.crt');
  console.log('  Delete them and re-run to regenerate.');
  process.exit(0);
}

// Try openssl (available on Windows via Git Bash, WSL, or Git for Windows)
const subj = '/C=GB/ST=London/L=London/O=AR Mirror/CN=localhost';
const cmd  = `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CRT_FILE}" -days 365 -nodes -subj "${subj}" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`;

try {
  execSync(cmd, { stdio: 'pipe' });
  console.log('✓ Self-signed cert created:');
  console.log('    certs/server.key');
  console.log('    certs/server.crt');
  console.log('');
  console.log('Now run:  node server.js');
  console.log('Open:     https://localhost:3443');
  console.log('(Accept the browser security warning once)');
} catch (e) {
  console.error('✗ openssl not found. Install Git for Windows or WSL, then retry.');
  console.error('  Alternatively, the server will run in HTTP mode on port 3000.');
  console.error('  For production, use Caddy: https://caddyserver.com');
  process.exit(1);
}
