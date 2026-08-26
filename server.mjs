// server.mjs — Video Edit UI backend
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT         = process.env.PORT ? parseInt(process.env.PORT, 10) : 0;
const AUDIO_DIR    = path.join(__dirname, 'audio');
const IMAGE_DIR    = path.join(__dirname, 'image');
const AUDIO_PATH   = path.join(__dirname, 'audio', 'untitled.mp3');
const OUTPUT_PATH  = path.join(__dirname, 'output.mp4');
const PUBLIC_DIR   = path.join(__dirname, 'public');
const SUBTITLE_DIR = path.join(__dirname, 'subtitles');
const SUBTITLE_PATH = path.join(SUBTITLE_DIR, 'subtitles.srt');
const SUBTITLE_SETTINGS_PATH = path.join(SUBTITLE_DIR, 'settings.json');
const TIMELINE_SETTINGS_PATH = path.join(SUBTITLE_DIR, 'timeline_settings.json');

// ── helpers ──────────────────────────────────────────────────────────────────
function parseSrtCues(content) {
  const entries = [];
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const block of normalized.split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    const ti = lines.findIndex(l => l.includes('-->'));
    if (ti === -1) continue;
    const [startStr, endStr] = lines[ti].split('-->').map(s => s.trim());
    const text = lines.slice(ti + 1).join('\n').trim();
    if (!text) continue;
    entries.push({ id: entries.length + 1, start: startStr, end: endStr, text });
  }
  return entries;
}
function parseTimestamp(filename) {
  const m = filename.match(/^\[(\d+)-(\d+)\]/);
  if (!m) return null;
  const min = parseInt(m[1], 10);
  const sec = parseInt(m[2], 10);
  return { min, sec, total: min * 60 + sec, label: `${min}:${String(sec).padStart(2, '0')}` };
}

function getAudioInfo(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  let duration = null;
  let durationFormatted = '—';
  try {
    const stdout = execSync(
      `ffprobe -v quiet -print_format json -show_format "${filePath}"`,
      { encoding: 'utf-8' }
    );
    const info = JSON.parse(stdout);
    if (info?.format?.duration) {
      duration = parseFloat(info.format.duration);
      const m = Math.floor(duration / 60);
      const s = Math.floor(duration % 60);
      durationFormatted = `${m}:${String(s).padStart(2, '0')}`;
    }
  } catch {}
  return {
    name: path.basename(filePath),
    size: stat.size,
    duration,
    durationFormatted,
  };
}

function mime(fp) {
  const ext = path.extname(fp).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.mp4':  'video/mp4',
    '.mkv':  'video/x-matroska',
    '.webm': 'video/webm',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.webp': 'image/webp',
    '.svg':  'image/svg+xml',
    '.mp3':  'audio/mpeg',
    '.wav':  'audio/wav',
    '.ico':  'image/x-icon',
  }[ext] || 'application/octet-stream';
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath) {
  try {
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': mime(filePath),
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

function killProcessTree(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${proc.pid} /T /F 2>nul`);
    } catch {}
  } else {
    try {
      proc.kill('SIGTERM');
    } catch {}
  }
}

// ── state ─────────────────────────────────────────────────────────────────────
let isGenerating = false;
let activeProc   = null;

// ── server ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url   = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path_ = url.pathname;

  // ── GET /api/images ─────────────────────────────────────────────────────────
  if (path_ === '/api/images' && req.method === 'GET') {
    try {
      if (!fs.existsSync(IMAGE_DIR)) return json(res, { count: 0, images: [] });
      const rawImages = fs.readdirSync(IMAGE_DIR)
        .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
        .map(f => {
          const ts = parseTimestamp(f);
          return ts ? { name: f, timestamp: ts } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.timestamp.total - b.timestamp.total);

      // Compute durations
      const audioInfo = getAudioInfo(AUDIO_PATH);
      const totalAudioSec = audioInfo?.duration || (rawImages.at(-1)?.timestamp.total + 5);

      const images = rawImages.map((img, i) => {
        const nextStart = i < rawImages.length - 1 ? rawImages[i + 1].timestamp.total : totalAudioSec;
        const durationSec = Math.max(0.1, nextStart - img.timestamp.total);
        return {
          ...img,
          durationSec: parseFloat(durationSec.toFixed(1)),
        };
      });

      return json(res, { count: images.length, images });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // ── GET /api/info ────────────────────────────────────────────────────────────
  if (path_ === '/api/info' && req.method === 'GET') {
    const audio = getAudioInfo(AUDIO_PATH);
    const outputExists = fs.existsSync(OUTPUT_PATH);
    const outputStat = outputExists ? fs.statSync(OUTPUT_PATH) : null;
    const subtitleExists = fs.existsSync(SUBTITLE_PATH);
    const subtitleStat = subtitleExists ? fs.statSync(SUBTITLE_PATH) : null;
    let subtitleEntries = null;
    if (subtitleExists) {
      try {
        subtitleEntries = fs.readFileSync(SUBTITLE_PATH, 'utf-8').split('\n').filter(l => l.includes('-->')).length;
      } catch {}
    }
    return json(res, {
      audio,
      output: outputExists ? { size: outputStat.size, mtime: outputStat.mtime } : null,
      subtitle: subtitleExists ? { name: 'subtitles.srt', size: subtitleStat.size, entries: subtitleEntries } : null,
      isGenerating,
    });
  }

  // ── GET /api/subtitles ───────────────────────────────────────────────────────
  if (path_ === '/api/subtitles' && req.method === 'GET') {
    if (!fs.existsSync(SUBTITLE_PATH)) {
      return json(res, { exists: false, content: '', entries: [], size: 0 });
    }
    try {
      const content = fs.readFileSync(SUBTITLE_PATH, 'utf-8');
      const entries = parseSrtCues(content);
      const stat = fs.statSync(SUBTITLE_PATH);
      return json(res, { exists: true, content, entries, size: stat.size });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // ── PUT /api/subtitles ───────────────────────────────────────────────────────
  if (path_ === '/api/subtitles' && req.method === 'PUT') {
    let body = '';
    req.on('data', c => body += c.toString());
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const content = parsed.content;
        if (typeof content !== 'string') return json(res, { error: 'Invalid content' }, 400);
        if (!fs.existsSync(SUBTITLE_DIR)) fs.mkdirSync(SUBTITLE_DIR, { recursive: true });
        fs.writeFileSync(SUBTITLE_PATH, content, 'utf-8');
        const entries = parseSrtCues(content);
        const stat = fs.statSync(SUBTITLE_PATH);
        return json(res, { ok: true, size: stat.size, entries: entries.length });
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    });
    return;
  }

  // ── GET /api/subtitle-settings ─────────────────────────────────────────────
  if (path_ === '/api/subtitle-settings' && req.method === 'GET') {
    const defaultSettings = {
      fontName: 'Inter',
      fontSize: 42,
      bold: false,
      italic: false,
      uppercase: false,
      primaryColor: '#FFFFFF',
      outlineColor: '#000000',
      outlineWidth: 2.5,
      shadowDepth: 1.0,
      backColor: '#000000',
      backAlpha: '99',
      borderStyle: 1,
      alignment: 2,
      marginV: 40,
      fadeInMs: 200,
    };
    if (!fs.existsSync(SUBTITLE_SETTINGS_PATH)) {
      return json(res, defaultSettings);
    }
    try {
      const data = JSON.parse(fs.readFileSync(SUBTITLE_SETTINGS_PATH, 'utf-8'));
      return json(res, { ...defaultSettings, ...data });
    } catch (e) {
      return json(res, defaultSettings);
    }
  }

  // ── POST /api/subtitle-settings ────────────────────────────────────────────
  if ((path_ === '/api/subtitle-settings') && (req.method === 'POST' || req.method === 'PUT')) {
    let body = '';
    req.on('data', c => body += c.toString());
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        if (!fs.existsSync(SUBTITLE_DIR)) fs.mkdirSync(SUBTITLE_DIR, { recursive: true });
        fs.writeFileSync(SUBTITLE_SETTINGS_PATH, JSON.stringify(parsed, null, 2), 'utf-8');
        return json(res, { ok: true, settings: parsed });
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    });
    return;
  }

  // ── GET /api/timeline-settings ─────────────────────────────────────────────
  if (path_ === '/api/timeline-settings' && req.method === 'GET') {
    const defaultTimeline = {
      globalTransition: 'fade',
      transitionDuration: 0.5,
      motionMode: 'ken-burns',
      activeEffects: ['zoom-in','zoom-out','pan-left','pan-right','pan-up','pan-down','diag-tl','diag-br','push-in','pull-out'],
      clipOverrides: {},
    };
    if (!fs.existsSync(TIMELINE_SETTINGS_PATH)) {
      return json(res, defaultTimeline);
    }
    try {
      const data = JSON.parse(fs.readFileSync(TIMELINE_SETTINGS_PATH, 'utf-8'));
      return json(res, { ...defaultTimeline, ...data });
    } catch (e) {
      return json(res, defaultTimeline);
    }
  }

  // ── POST /api/timeline-settings ────────────────────────────────────────────
  if ((path_ === '/api/timeline-settings') && (req.method === 'POST' || req.method === 'PUT')) {
    let body = '';
    req.on('data', c => body += c.toString());
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        if (!fs.existsSync(SUBTITLE_DIR)) fs.mkdirSync(SUBTITLE_DIR, { recursive: true });
        fs.writeFileSync(TIMELINE_SETTINGS_PATH, JSON.stringify(parsed, null, 2), 'utf-8');
        return json(res, { ok: true, settings: parsed });
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    });
    return;
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

    const resolution = url.searchParams.get('res') || (url.searchParams.get('fast') === 'true' ? '720p' : '1080p');
    const motionParam = url.searchParams.get('motion');
    const effectsParam = url.searchParams.get('effects') || '';
    const transitionParam = url.searchParams.get('transition') || '';
    const transitionDurParam = url.searchParams.get('transition_dur') || '';

    const args = ['generate_video.mjs'];
    if (resolution === '720p' || url.searchParams.get('fast') === 'true') {
      args.push('--fast');
    } else if (resolution === '2k') {
      args.push('--2k');
    }

    const isStaticMode = motionParam === 'static' || motionParam === 'false' || url.searchParams.get('static') === 'true';
    if (isStaticMode) {
      args.push('--static');
    } else if (effectsParam) {
      args.push(`--effects=${effectsParam}`);
    }

    if (transitionParam) {
      args.push(`--transition=${transitionParam}`);
    }
    if (transitionDurParam) {
      args.push(`--transition-duration=${transitionDurParam}`);
    }

    const modeLabel = resolution === '2k' ? '2K QHD (1440p)' : resolution === '720p' ? '720p HD DRAFT' : '1080p FULL HD';
    const effectCount = effectsParam ? effectsParam.split(',').length : 10;
    const motionLabel = isStaticMode ? 'Static Slides (No Motion)' : (effectsParam ? `${effectCount} effect${effectCount !== 1 ? 's' : ''}` : 'smooth Ken Burns');
    const transLabel = transitionParam ? `Transition: ${transitionParam} (${transitionDurParam || 0.5}s)` : 'Transitions enabled';
    send({
      type: 'start',
      message: `🚀 Starting video generation in ${modeLabel} mode (${motionLabel} · ${transLabel}) via Native FFmpeg...`,
    });

    activeProc = spawn('node', args, { cwd: __dirname });

    let buffer = '';
    let lastPct = 0;

    const handleChunk = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep partial line

      for (const line of lines) {
        if (!line.trim()) continue;
        // Extract latest % from line
        const pcts = [...line.matchAll(/(\d+)%/g)].map(m => parseInt(m[1], 10));
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
        send({ type: 'done', message: '✅ Video generated successfully!', outputSize: stat?.size });
      } else {
        send({ type: 'error', message: `❌ Render process exited with code ${code}` });
      }
      res.end();
    });

    req.on('close', () => {
      if (activeProc) {
        killProcessTree(activeProc);
        isGenerating = false;
        activeProc = null;
      }
    });
    return;
  }

  // ── POST /api/upload-srt ─────────────────────────────────────────────────────
  if (path_ === '/api/upload-srt' && req.method === 'POST') {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^;]+)/);
    if (!boundaryMatch) return json(res, { error: 'Missing multipart boundary' }, 400);
    const boundary = boundaryMatch[1].trim();

    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const bodyStr = body.toString('binary');

        // Find file content between boundaries
        const startMarker = `\r\n\r\n`;
        const endMarker = `\r\n--${boundary}`;
        const startIdx = bodyStr.indexOf(startMarker);
        const endIdx   = bodyStr.indexOf(endMarker, startIdx + startMarker.length);
        if (startIdx === -1 || endIdx === -1) return json(res, { error: 'Malformed multipart body' }, 400);

        const fileContent = body.slice(startIdx + startMarker.length, endIdx);

        // Validate: must look like an SRT (contains "-->")
        const preview = fileContent.slice(0, 512).toString('utf-8');
        if (!preview.includes('-->')) return json(res, { error: 'File does not appear to be a valid SRT' }, 400);

        // Ensure directory exists
        if (!fs.existsSync(SUBTITLE_DIR)) fs.mkdirSync(SUBTITLE_DIR, { recursive: true });
        fs.writeFileSync(SUBTITLE_PATH, fileContent);

        const lineCount = fileContent.toString('utf-8').split('\n').filter(l => l.includes('-->')).length;
        return json(res, { ok: true, size: fileContent.length, entries: lineCount });
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    });
    req.on('error', e => json(res, { error: e.message }, 500));
    return;
  }

  // ── DELETE /api/srt & /api/subtitles ─────────────────────────────────────────
  if ((path_ === '/api/srt' || path_ === '/api/subtitles') && req.method === 'DELETE') {
    try {
      if (fs.existsSync(SUBTITLE_PATH)) fs.unlinkSync(SUBTITLE_PATH);
      return json(res, { ok: true });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // ── POST /api/transcribe ────────────────────────────────────────────────────
  if (path_ === '/api/transcribe' && req.method === 'POST') {
    if (isGenerating) return json(res, { error: 'A render or transcription is already running' }, 409);

    isGenerating = true;

    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ type: 'start', message: '🎤 Whisper transcription started (model: base)...' });

    activeProc = spawn('node', ['transcribe.mjs'], { cwd: __dirname });

    let tbuf = '';
    const handleTChunk = (chunk) => {
      tbuf += chunk.toString();
      const lines = tbuf.split('\n');
      tbuf = lines.pop();
      for (const line of lines) {
        if (line.trim()) send({ type: 'log', message: line.trim() });
      }
    };

    activeProc.stdout.on('data', handleTChunk);
    activeProc.stderr.on('data', handleTChunk);

    activeProc.on('close', (code) => {
      isGenerating = false;
      activeProc   = null;
      if (code === 0) {
        const srtExists = fs.existsSync(SUBTITLE_PATH);
        const srtStat   = srtExists ? fs.statSync(SUBTITLE_PATH) : null;
        const entries   = srtExists
          ? fs.readFileSync(SUBTITLE_PATH, 'utf-8').split('\n').filter(l => l.includes('-->')).length
          : 0;
        send({ type: 'done', message: '✅ Transcription complete!', entries, size: srtStat?.size });
      } else {
        send({ type: 'error', message: `❌ Whisper failed with exit code ${code}` });
      }
      res.end();
    });

    req.on('close', () => {
      if (activeProc) { killProcessTree(activeProc); isGenerating = false; activeProc = null; }
    });
    return;
  }

  // ── POST /api/cancel ─────────────────────────────────────────────────────────
  if (path_ === '/api/cancel' && req.method === 'POST') {
    if (activeProc) {
      killProcessTree(activeProc);
      isGenerating = false;
      activeProc = null;
    }
    return json(res, { ok: true });
  }

  // ── GET /output.mp4 (with full HTTP range support for video player) ─────────
  if (path_ === '/output.mp4' && req.method === 'GET') {
    if (!fs.existsSync(OUTPUT_PATH)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Output video not found');
      return;
    }
    const stat = fs.statSync(OUTPUT_PATH);
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end   = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = end - start + 1;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunksize,
        'Content-Type':   'video/mp4',
      });
      fs.createReadStream(OUTPUT_PATH, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type':   'video/mp4',
        'Accept-Ranges':  'bytes',
      });
      fs.createReadStream(OUTPUT_PATH).pipe(res);
    }
    return;
  }

  // ── Serve image files ─────────────────────────────────────────────────────────
  if (path_.startsWith('/image/')) {
    const rel = decodeURIComponent(path_.slice('/image/'.length));
    const fullPath = path.join(IMAGE_DIR, rel);
    return serveFile(res, fullPath);
  }

  // ── Serve audio files ────────────────────────────────────────────────────────
  if (path_.startsWith('/audio/')) {
    const rel = decodeURIComponent(path_.slice('/audio/'.length));
    const fullPath = path.join(AUDIO_DIR, rel);
    return serveFile(res, fullPath);
  }

  // ── Serve subtitle files ─────────────────────────────────────────────────────
  if (path_.startsWith('/subtitles/')) {
    const rel = decodeURIComponent(path_.slice('/subtitles/'.length));
    const fullPath = path.join(SUBTITLE_DIR, rel);
    return serveFile(res, fullPath);
  }

  // ── Serve public files (HTML, CSS, etc.) ──────────────────────────────────────
  const reqPath = path_ === '/' ? 'index.html' : path_.slice(1);
  const fp = path.join(PUBLIC_DIR, reqPath);
  serveFile(res, fp);
});

server.listen(PORT, () => {
  const { port } = server.address();
  // Emit a parseable line so the launcher knows which port was chosen
  process.stdout.write(`LISTENING_ON_PORT:${port}\n`);
  console.log(`\n🎬 Video Edit Studio running at http://localhost:${port}\n`);
});
