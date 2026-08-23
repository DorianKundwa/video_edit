// generate_video.mjs
// Reads images from ./image/, parses [M-SS] timestamps from filenames,
// computes each clip's duration, then renders via native FFmpeg with
// smooth, cinematic Ken Burns digital pans and zoom-ins.

import { readdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IMAGE_DIR    = resolve(__dirname, 'image');
const AUDIO_PATH   = resolve(__dirname, 'audio/untitled.mp3');
const OUTPUT_PATH  = resolve(__dirname, 'output.mp4');
const CONCAT_FILE  = resolve(__dirname, 'concat_list.txt');
const FILTER_FILE  = resolve(__dirname, 'filter_complex.txt');
const SUBTITLE_PATH = resolve(__dirname, 'subtitles/subtitles.srt');
const ASS_PATH      = resolve(__dirname, 'subtitles/subtitles.ass');

const isFast   = process.argv.includes('--fast');
const is2K     = process.argv.includes('--2k');
const isStatic = process.argv.includes('--static') || process.argv.includes('--no-motion');

// Parse optional active-effects list passed from the UI: --effects=zoom-in,pan-left,...
const effectsArg = process.argv.find(a => a.startsWith('--effects='));
const activeEffectLabels = effectsArg ? effectsArg.slice('--effects='.length).split(',') : null;

// ── Helper: Get audio duration dynamically with ffprobe ────────────────────
function getAudioDuration(filePath) {
  if (!existsSync(filePath)) return 600;
  try {
    const stdout = execSync(
      `ffprobe -v quiet -print_format json -show_format "${filePath}"`,
      { encoding: 'utf-8' }
    );
    const info = JSON.parse(stdout);
    if (info?.format?.duration) {
      return parseFloat(info.format.duration);
    }
  } catch (e) {
    console.warn('ffprobe duration check failed, using fallback:', e.message);
  }
  return 600;
}

const AUDIO_DURATION = getAudioDuration(AUDIO_PATH);

// ── 1. Collect & sort images by timestamp ──────────────────────────────────
function parseTimestamp(filename) {
  const m = filename.match(/^\[(\d+)-(\d+)\]/);
  if (!m) return null;
  const min = parseInt(m[1], 10);
  const sec = parseInt(m[2], 10);
  return min * 60 + sec;
}

if (!existsSync(IMAGE_DIR)) {
  console.error(`❌ Image directory not found at: ${IMAGE_DIR}`);
  process.exit(1);
}

const images = readdirSync(IMAGE_DIR)
  .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
  .map(f => ({ name: f, startSec: parseTimestamp(f) }))
  .filter(x => x.startSec !== null)
  .sort((a, b) => a.startSec - b.startSec);

if (images.length === 0) {
  console.error('❌ No timestamped images found in image directory!');
  process.exit(1);
}

// Resolution Selection (Crisp 1080p Full HD default or 2K QHD)
let outWidth = 1920;
let outHeight = 1080;

if (is2K) {
  outWidth = 2560;
  outHeight = 1440;
} else if (isFast) {
  outWidth = 1280;
  outHeight = 720;
}

const fps = isFast ? 24 : 30;
const preset = isFast ? 'ultrafast' : 'veryfast';

const totalMin = Math.floor(AUDIO_DURATION / 60);
const totalSec = Math.floor(AUDIO_DURATION % 60);
console.log(`📸 Found ${images.length} timestamped images, spanning ${images[0].startSec}s → ${images.at(-1).startSec}s`);
console.log(`📐 Render Target: ${outWidth}x${outHeight} @ ${fps}fps (${is2K ? '2K QHD' : isFast ? '720p HD Preview' : '1080p Full HD'})`);
console.log(`🎵 Audio duration: ${AUDIO_DURATION.toFixed(2)}s (${totalMin}m ${totalSec}s)`);

// ── Subtitles ────────────────────────────────────────────────────────────────
const hasSubs = existsSync(SUBTITLE_PATH);
if (hasSubs) {
  console.log(`💬 Subtitles detected: ${SUBTITLE_PATH}`);
} else {
  console.log('💬 No subtitle file found — rendering without captions');
}

// ── 2. Motion Effects Pool ──────────────────────────────────────────────────
// Images are overscaled 15% so pans/zooms never reveal the canvas edge.
const OVER   = 1.15;
const ZOOM   = 0.08;  // max zoom magnitude
const PAN_PX = Math.round(outWidth  * 0.05);
const PAN_PY = Math.round(outHeight * 0.05);

// 10 distinct cinematic effects.
// zoomDir: 1=zoom-in, -1=zoom-out, 0=no-zoom, ±0.5=half-strength zoom
const ALL_EFFECTS = [
  { label: 'zoom-in',   zoomDir:  1,    dx:  0,                        dy:  0      },
  { label: 'zoom-out',  zoomDir: -1,    dx:  0,                        dy:  0      },
  { label: 'pan-left',  zoomDir:  0,    dx: -PAN_PX,                   dy:  0      },
  { label: 'pan-right', zoomDir:  0,    dx:  PAN_PX,                   dy:  0      },
  { label: 'pan-up',    zoomDir:  0,    dx:  0,                        dy: -PAN_PY },
  { label: 'pan-down',  zoomDir:  0,    dx:  0,                        dy:  PAN_PY },
  { label: 'diag-tl',  zoomDir:  0.5,  dx: -PAN_PX,                   dy: -PAN_PY },
  { label: 'diag-br',  zoomDir: -0.5,  dx:  PAN_PX,                   dy:  PAN_PY },
  { label: 'push-in',  zoomDir:  1,    dx: -Math.round(PAN_PX * 0.6), dy:  0      },
  { label: 'pull-out', zoomDir: -1,    dx:  Math.round(PAN_PX * 0.6), dy:  0      },
];

// Build the active pool from --effects= CLI arg; fall back to all effects
const _activePool = activeEffectLabels
  ? ALL_EFFECTS.filter(e => activeEffectLabels.includes(e.label))
  : ALL_EFFECTS;
const EFFECT_POOL = _activePool.length > 0 ? _activePool : ALL_EFFECTS;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Deterministic hash: same image filename always maps to the same effect
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ── SRT → ASS Subtitle Converter ─────────────────────────────────────────────
// Parses an SRT file and emits a properly-styled ASS file with customizable
// fonts, sizes, colors, strokes, shadow boxes, uppercase transform, and transitions.
// Using the `ass` FFmpeg filter avoids the Windows drive-letter path
// parsing bug that plagued the `subtitles` filter's option handling.

const SUBTITLE_SETTINGS_PATH = resolve(__dirname, 'subtitles/settings.json');

const DEFAULT_SUB_SETTINGS = {
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
  borderStyle: 1, // 1 = Outline + Drop shadow, 3 = Opaque Box Banner
  alignment: 2,   // 2 = Bottom-Center, 8 = Mid-Center, 5 = Top-Center
  marginV: 40,
  fadeInMs: 200,
};

function hexToAssColor(hex, alphaHex = '00') {
  if (!hex) return `&H${alphaHex}000000`;
  let clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    clean = clean.split('').map(c => c + c).join('');
  }
  if (clean.length === 8) {
    const r = clean.slice(0, 2);
    const g = clean.slice(2, 4);
    const b = clean.slice(4, 6);
    const a = clean.slice(6, 8);
    return `&H${a.toUpperCase()}${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}`;
  }
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H${alphaHex.toUpperCase()}${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}`;
}

function loadSubtitleSettings() {
  if (existsSync(SUBTITLE_SETTINGS_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(SUBTITLE_SETTINGS_PATH, 'utf-8'));
      return { ...DEFAULT_SUB_SETTINGS, ...raw };
    } catch (e) {
      console.warn('⚠️ Could not parse subtitle settings, using defaults:', e.message);
    }
  }
  return { ...DEFAULT_SUB_SETTINGS };
}

function parseSrtToEntries(content) {
  const entries = [];
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const block of normalized.split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    const ti = lines.findIndex(l => l.includes('-->'));
    if (ti === -1) continue;
    const [startStr, endStr] = lines[ti].split('-->').map(s => s.trim());
    const text = lines.slice(ti + 1).join('\n').trim();
    if (!text) continue;
    entries.push({ start: srtTimeToSec(startStr), end: srtTimeToSec(endStr), text });
  }
  return entries;
}

function srtTimeToSec(t) {
  const [hms, ms = '0'] = t.split(',');
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s + parseInt(ms, 10) / 1000;
}

function secToAssTime(sec) {
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const cs = Math.round((sec % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '00')}`;
}

function buildAssFile(entries, width, height, subSettings = {}, resScale = 1.0) {
  const cfg = { ...DEFAULT_SUB_SETTINGS, ...subSettings };

  const scaledFontSize = Math.max(14, Math.round((cfg.fontSize || 42) * resScale));
  const scaledMarginV  = Math.max(10, Math.round((cfg.marginV ?? 40) * resScale));
  const scaledOutline  = Math.max(0, (cfg.outlineWidth ?? 2.5) * resScale).toFixed(1);
  const scaledShadow   = Math.max(0, (cfg.shadowDepth ?? 1.0) * resScale).toFixed(1);

  const primaryAss = hexToAssColor(cfg.primaryColor, '00');
  const outlineAss = hexToAssColor(cfg.outlineColor, '00');
  const backAss    = hexToAssColor(cfg.backColor || '#000000', cfg.backAlpha || '99');

  const boldVal     = cfg.bold ? -1 : 0;
  const italicVal   = cfg.italic ? -1 : 0;
  const borderStyle = cfg.borderStyle || 1;
  const alignment   = cfg.alignment || 2;
  const fontName    = cfg.fontName || 'Inter';

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${fontName},${scaledFontSize},${primaryAss},&H000000FF,${outlineAss},${backAss},${boldVal},${italicVal},0,0,100,100,0,0,${borderStyle},${scaledOutline},${scaledShadow},${alignment},30,30,${scaledMarginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const fadeInMs = cfg.fadeInMs ?? 200;
  const fadTag = fadeInMs > 0 ? `{\\fad(${fadeInMs},0)}` : '';

  const dialogues = entries.map(e => {
    let clean = e.text.replace(/<[^>]+>/g, '').replace(/\n/g, '\\N');
    if (cfg.uppercase) {
      clean = clean.toUpperCase();
    }
    return `Dialogue: 0,${secToAssTime(e.start)},${secToAssTime(e.end)},Default,,0,0,0,,${fadTag}${clean}`;
  });

  return header + '\n' + dialogues.join('\n') + '\n';
}

// ── 3. Build FFmpeg Concat Script & Interval Tree ─────────────────────────
const concatLines = ['ffconcat version 1.0'];
const clips = [];

for (let i = 0; i < images.length; i++) {
  const img = images[i];
  const nextStart = i < images.length - 1 ? images[i + 1].startSec : AUDIO_DURATION;
  const duration = Math.max(nextStart - img.startSec, 0.1);
  const fullPath = resolve(IMAGE_DIR, img.name).replace(/\\/g, '/');
  const escapedPath = fullPath.replace(/'/g, "'\\''");

  concatLines.push(`file '${escapedPath}'`);
  concatLines.push(`duration ${duration.toFixed(3)}`);

  const motion = EFFECT_POOL[simpleHash(img.name) % EFFECT_POOL.length];
  clips.push({ startSec: img.startSec, duration, motion });
}

// Last file repeated for concat demuxer requirement
const lastImgPath = resolve(IMAGE_DIR, images.at(-1).name).replace(/\\/g, '/').replace(/'/g, "'\\''");
concatLines.push(`file '${lastImgPath}'`);

writeFileSync(CONCAT_FILE, concatLines.join('\n'), 'utf-8');

// ── 4. Build Motion Math & Expressions ─────────────────────────────────────
const bigW = Math.round(outWidth  * OVER / 2) * 2;
const bigH = Math.round(outHeight * OVER / 2) * 2;
const headX = (bigW - outWidth)  / 2;
const headY = (bigH - outHeight) / 2;

function buildTree(items, getter) {
  if (items.length === 1) return getter(items[0]);
  const mid = Math.floor(items.length / 2);
  const left = items.slice(0, mid);
  const right = items.slice(mid);
  const split = left[left.length - 1].startSec + left[left.length - 1].duration;
  return `if(lt(t,${split.toFixed(3)}),${buildTree(left, getter)},${buildTree(right, getter)})`;
}

function progressExpr(clip) {
  return `clip((t-${clip.startSec.toFixed(3)})/${clip.duration.toFixed(3)},0,1)`;
}

function zoomScaleExpr(clip) {
  const zd = clip.motion.zoomDir;
  if (isStatic || zd === 0) return '1';
  const strength = Math.abs(zd);
  const p = progressExpr(clip);
  if (zd > 0) return `(1+${(ZOOM * strength).toFixed(4)}*${p})`;
  return `(1+${(ZOOM * strength).toFixed(4)}*(1-${p}))`;
}

function panExpr(clip, axis) {
  if (isStatic) return '0';
  const delta = axis === 'x' ? clip.motion.dx : clip.motion.dy;
  if (delta === 0) return '0';
  const p = progressExpr(clip);
  // Pan from -delta to +delta across the duration
  return `(-(${delta}) + 2*(${delta})*${p})`;
}

const scaleExpr = buildTree(clips, (c) => zoomScaleExpr(c));
const panXExpr  = buildTree(clips, (c) => panExpr(c, 'x'));
const panYExpr  = buildTree(clips, (c) => panExpr(c, 'y'));

// Rock-solid smooth centering: references actual overlay frame dimensions (W-w)/2 and (H-h)/2
const overlayX = `(W-w)/2-(${panXExpr})`;
const overlayY = `(H-h)/2-(${panYExpr})`;

// ── 5. Render via FFmpeg with Smooth Digital Pans & Zooms ─────────────────
const bgW = Math.max(160, Math.round(outWidth / 4));
const bgH = Math.max(90, Math.round(outHeight / 4));

let videoFilter;
if (isStatic) {
  videoFilter = `[0:v]fps=${fps},split=2[bg][fg];` +
    `[bg]scale=${bgW}:${bgH}:force_original_aspect_ratio=increase,crop=${bgW}:${bgH},boxblur=8:1,scale=${outWidth}:${outHeight}:flags=bilinear[bgblur];` +
    `[fg]scale=${outWidth}:${outHeight}:force_original_aspect_ratio=decrease[fgscaled];` +
    `[bgblur][fgscaled]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]`;
} else {
  // Use trunc((...)/2)*2 so width & height are always even integers on every frame,
  // preventing subpixel phase jitter and shaking during zoom in and zoom out.
  videoFilter = `[0:v]fps=${fps},split=2[bg][fg];` +
    `[bg]scale=${bgW}:${bgH}:force_original_aspect_ratio=increase,crop=${bgW}:${bgH},boxblur=8:1,scale=${outWidth}:${outHeight}:flags=bilinear[bgblur];` +
    `[fg]scale=${bigW}:${bigH}:force_original_aspect_ratio=increase,crop=${bigW}:${bigH},scale='trunc((${bigW}*(${scaleExpr}))/2)*2':'trunc((${bigH}*(${scaleExpr}))/2)*2':eval=frame:flags=bicubic[bigzoom];` +
    `[bgblur][bigzoom]overlay='${overlayX}':'${overlayY}':eval=frame,format=yuv420p[v]`;
}

// Chain subtitle filter when an SRT file is present
const outLabel = hasSubs ? 'vout' : 'v';
if (hasSubs) {
  const srtContent = readFileSync(SUBTITLE_PATH, 'utf-8');
  const entries = parseSrtToEntries(srtContent);
  const subSettings = loadSubtitleSettings();
  const resScale = outWidth / 1920;
  writeFileSync(ASS_PATH, buildAssFile(entries, outWidth, outHeight, subSettings, resScale), 'utf-8');
  console.log(`💬 Generated ASS subtitles: ${entries.length} cues using font '${subSettings.fontName || 'Inter'}' (${subSettings.fontSize || 42}px${subSettings.bold ? ', Bold' : ''}${subSettings.uppercase ? ', ALL CAPS' : ''})`);

  // Windows drive-letter colon escape applies to the ass filter
  const assForFFmpeg = ASS_PATH
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, '$1\\:');

  videoFilter += `;[v]ass='${assForFFmpeg}'[vout]`;
}

writeFileSync(FILTER_FILE, videoFilter, 'utf-8');

const hasAudio = existsSync(AUDIO_PATH);
const ffmpegArgs = [
  '-f', 'concat',
  '-safe', '0',
  '-i', CONCAT_FILE,
  ...(hasAudio ? ['-i', AUDIO_PATH] : []),
  '-filter_complex_script', FILTER_FILE,
  '-map', `[${outLabel}]`,
  ...(hasAudio ? ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k'] : []),
  '-c:v', 'libx264',
  '-preset', preset,
  '-crf', '17', // High quality crisp encoding
  '-movflags', 'faststart',
  '-shortest',
  '-y',
  OUTPUT_PATH,
  '-progress', 'pipe:1',
];

console.log(`\n🎬 Starting native FFmpeg render with smooth digital pans & zooms (${outWidth}x${outHeight} @ ${fps}fps, CRF 17)${hasSubs ? ' + subtitles' : ''}...`);

await new Promise((resolvePromise, rejectPromise) => {
  const proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  let lastPercent = -1;
  let stdoutBuf = '';

  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('out_time_us=')) {
        const us = parseInt(trimmed.slice('out_time_us='.length), 10);
        if (!isNaN(us) && AUDIO_DURATION > 0) {
          const currentSec = us / 1_000_000;
          const pct = Math.min(100, Math.max(0, Math.floor((currentSec / AUDIO_DURATION) * 100)));
          if (pct !== lastPercent) {
            lastPercent = pct;
            process.stdout.write(`${pct}% `);
          }
        }
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString();
    if (msg.includes('Error') || msg.includes('fatal')) {
      console.error(msg);
    }
  });

  proc.on('close', (code) => {
    try {
      if (existsSync(CONCAT_FILE)) unlinkSync(CONCAT_FILE);
      if (existsSync(FILTER_FILE)) unlinkSync(FILTER_FILE);
    } catch {}

    if (code === 0) {
      process.stdout.write('100%\n');
      console.log(`\n✅ Done! Video saved to: ${OUTPUT_PATH}`);
      resolvePromise();
    } else {
      rejectPromise(new Error(`FFmpeg exited with code ${code}`));
    }
  });

  proc.on('error', (err) => {
    try {
      if (existsSync(CONCAT_FILE)) unlinkSync(CONCAT_FILE);
      if (existsSync(FILTER_FILE)) unlinkSync(FILTER_FILE);
    } catch {}
    rejectPromise(err);
  });
});
