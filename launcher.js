'use strict';
// Video Edit Studio — SEA Launcher
// This executable starts server.mjs and opens the browser.

const { spawn } = require('child_process');
const { get }   = require('http');
const { exec }  = require('child_process');
const path      = require('path');

// ── Project directory = folder where this .exe lives ─────────────────────────
const PROJECT_DIR = path.dirname(process.execPath);
const PORT        = 3000;
const SERVER_URL  = `http://localhost:${PORT}`;

// Set terminal title
try { process.stdout.write('\x1b]0;Video Edit Studio\x07'); } catch {}

console.log('\n  ╔══════════════════════════════════════╗');
console.log('  ║        🎬  Video Edit Studio          ║');
console.log('  ╚══════════════════════════════════════╝\n');
console.log(`  📁  Project : ${PROJECT_DIR}`);
console.log(`  🌐  URL     : ${SERVER_URL}`);
console.log('  ℹ️   Press Ctrl+C to stop the server\n');

// ── Start the backend server ──────────────────────────────────────────────────
const server = spawn('node', ['server.mjs'], {
  cwd:   PROJECT_DIR,
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', d => process.stdout.write(d));
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

// ── Poll until server responds, then open browser ─────────────────────────────
function waitAndOpen(attempts) {
  const req = get(SERVER_URL, () => {
    console.log('  ✅  Server ready — opening browser...\n');
    exec(`start "" "${SERVER_URL}"`);
  });

  req.on('error', () => {
    if (attempts > 0) setTimeout(() => waitAndOpen(attempts - 1), 400);
    else exec(`start "" "${SERVER_URL}"`); // open anyway as fallback
  });

  req.setTimeout(300, () => {
    req.destroy();
    if (attempts > 0) setTimeout(() => waitAndOpen(attempts - 1), 400);
  });
}

setTimeout(() => waitAndOpen(30), 800);

// ── Graceful shutdown ──────────────────────────────────────────────────────────
process.on('SIGINT',  () => { server.kill('SIGTERM'); setTimeout(() => process.exit(0), 800); });
process.on('SIGTERM', () => { server.kill('SIGTERM'); process.exit(0); });
