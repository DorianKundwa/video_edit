'use strict';
// Video Edit Studio — SEA Launcher
// Starts server.mjs on a random OS-assigned port, then opens the browser.

const { spawn } = require('child_process');
const { get }   = require('http');
const { exec }  = require('child_process');
const path      = require('path');

const PROJECT_DIR = path.dirname(process.execPath);

// Set terminal title
try { process.stdout.write('\x1b]0;Video Edit Studio\x07'); } catch {}

console.log('\n  ╔══════════════════════════════════════╗');
console.log('  ║        🎬  Video Edit Studio          ║');
console.log('  ╚══════════════════════════════════════╝\n');
console.log(`  📁  Project : ${PROJECT_DIR}`);
console.log('  🌐  URL     : (waiting for server...)\n');

// ── Start the backend server ──────────────────────────────────────────────────
const server = spawn('node', ['server.mjs'], {
  cwd:   PROJECT_DIR,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverURL = null;
let portFound = false;

server.stdout.on('data', d => {
  const text = d.toString();

  // Intercept the parseable port line emitted by server.mjs
  if (!portFound) {
    const match = text.match(/LISTENING_ON_PORT:(\d+)/);
    if (match) {
      portFound  = true;
      serverURL  = `http://localhost:${match[1]}`;
      process.stdout.write(`  🌐  URL     : ${serverURL}\n\n`);
      openBrowser(serverURL);
    }
  }

  // Forward all other stdout lines (skip the internal port marker)
  const filtered = text.replace(/LISTENING_ON_PORT:\d+\n?/, '');
  if (filtered.trim()) process.stdout.write(filtered);
});

server.stderr.on('data', d => process.stderr.write(d));

server.on('error', err => {
  console.error(`\n  ❌  Failed to start server: ${err.message}`);
  console.error('      Make sure Node.js is installed and in your PATH.\n');
  process.exit(1);
});

server.on('exit', code => {
  if (code !== 0) console.log(`\n  Server stopped (exit code ${code})`);
  process.exit(code || 0);
});

// ── Open browser ──────────────────────────────────────────────────────────────
function openBrowser(url) {
  exec(`start "" "${url}"`);
}

// ── Graceful shutdown ──────────────────────────────────────────────────────────
process.on('SIGINT',  () => { server.kill('SIGTERM'); setTimeout(() => process.exit(0), 800); });
process.on('SIGTERM', () => { server.kill('SIGTERM'); process.exit(0); });
