// server.mjs — Video Edit UI backend
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT        = 0;         // 0 = OS picks a random free port
const IMAGE_DIR  = path.join(__dirname, 'image');
const AUDIO_PATH = path.join(__dirname, 'audio', 'untitled.mp3');
const OUTPUT_PATH = path.join(__dirname, 'output.mp4');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ── helpers ──────────────────────────────────────────────────────────────────
function parseTimestamp(filename) {
  const m = filename.match(/^\[(\d+)-(\d+)\]/);
  if (!m) return null;
  const min = parseInt(m[1]), sec = parseInt(m[2]);
  return { min, sec, total: min * 60 + sec, label: `${min}:${String(sec).padStart(2,'0')}` };
}

function mime(fp) {
  const ext = path.extname(fp).toLowerCase();
  return { '.html':'text/html','.css':'text/css','.js':'application/javascript',
           '.json':'application/json','.mp4':'video/mp4',
           '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png',
           '.webp':'image/webp','.ico':'image/x-icon' }[ext] || 'application/octet-stream';
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath) {
  try {
    const stat = fs.statSync(filePath);
    res.writeHead(200, { 'Content-Type': mime(filePath), 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

// ── state ─────────────────────────────────────────────────────────────────────
let isGenerating = false;
let activeProc   = null;

// ── server ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url  = new URL(req.url, `http://${req.headers.host}`);
  const path_ = url.pathname;

  // ── GET /api/images ─────────────────────────────────────────────────────────
  if (path_ === '/api/images' && req.method === 'GET') {
    try {
      const images = fs.readdirSync(IMAGE_DIR)
        .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
        .map(f => {
          const ts = parseTimestamp(f);
          return ts ? { name: f, timestamp: ts } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.timestamp.total - b.timestamp.total);
      return json(res, { count: images.length, images });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // ── GET /api/info ────────────────────────────────────────────────────────────
  if (path_ === '/api/info' && req.method === 'GET') {
    const audioExists = fs.existsSync(AUDIO_PATH);
    const outputExists = fs.existsSync(OUTPUT_PATH);
    const audioStat = audioExists ? fs.statSync(AUDIO_PATH) : null;
    const outputStat = outputExists ? fs.statSync(OUTPUT_PATH) : null;
    return json(res, {
      audio: audioExists ? { name: path.basename(AUDIO_PATH), size: audioStat.size } : null,
      output: outputExists ? { size: outputStat.size, mtime: outputStat.mtime } : null,
      isGenerating,
    });
  }

  // ── POST /api/generate ────────────────────────────────────────────────────────
  if (path_ === '/api/generate' && req.method === 'POST') {
    if (isGenerating) return json(res, { error: 'Already generating' }, 409);

    isGenerating = true;

    // SSE headers
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    send({ type: 'start', message: '🚀 Starting video generation...' });

    activeProc = spawn('node', ['generate_video.mjs'], { cwd: __dirname });

    let buffer = '';
    let lastPct = 0;

    const handleChunk = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        // Extract latest % from a line like " 57%  57%  58% ..."
        const pcts = [...line.matchAll(/(\d+)%/g)].map(m => parseInt(m[1]));
        if (pcts.length > 0) {
          const pct = Math.max(...pcts);
          if (pct !== lastPct) {
            lastPct = pct;
            send({ type: 'progress', percent: pct });
          }
        } else {
          send({ type: 'log', message: line.trim() });
        }
      }
    };

    activeProc.stdout.on('data', handleChunk);
    activeProc.stderr.on('data', (d) => {
      // filter noisy ffmpeg lines
      const msg = d.toString().trim();
      if (msg && !msg.startsWith('frame=') && !msg.startsWith('size=')) {
        send({ type: 'log', message: msg });
      }
    });

    activeProc.on('close', (code) => {
      isGenerating = false;
      activeProc   = null;
      if (code === 0) {
        const stat = fs.existsSync(OUTPUT_PATH) ? fs.statSync(OUTPUT_PATH) : null;
        send({ type: 'done', message: '✅ Video generated!', outputSize: stat?.size });
      } else {
        send({ type: 'error', message: `❌ Process exited with code ${code}` });
      }
      res.end();
    });

    req.on('close', () => {
      if (activeProc) { activeProc.kill(); isGenerating = false; activeProc = null; }
    });
    return;
  }

  // ── POST /api/cancel ─────────────────────────────────────────────────────────
  if (path_ === '/api/cancel' && req.method === 'POST') {
    if (activeProc) { activeProc.kill(); isGenerating = false; activeProc = null; }
    return json(res, { ok: true });
  }

  // ── GET /output.mp4 (with range support for seeking) ─────────────────────────
  if (path_ === '/output.mp4' && req.method === 'GET') {
    if (!fs.existsSync(OUTPUT_PATH)) { res.writeHead(404); res.end(); return; }
    const stat = fs.statSync(OUTPUT_PATH);
    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr);
      const end   = endStr ? parseInt(endStr) : stat.size - 1;
      res.writeHead(206, {
        'Content-Type':  'video/mp4',
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(OUTPUT_PATH, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(OUTPUT_PATH).pipe(res);
    }
    return;
  }

  // ── Serve image files ─────────────────────────────────────────────────────────
  if (path_.startsWith('/image/')) {
    return serveFile(res, path.join(__dirname, decodeURIComponent(path_)));
  }

  // ── Serve public/ ─────────────────────────────────────────────────────────────
  const fp = path_ === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, path_);
  serveFile(res, fp);
});

server.listen(PORT, () => {
  const { port } = server.address();
  // Emit a parseable line so the launcher knows which port was chosen
  process.stdout.write(`LISTENING_ON_PORT:${port}\n`);
  console.log(`\n🎬 Video Edit Studio running at http://localhost:${port}\n`);
});
