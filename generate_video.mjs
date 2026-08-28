// generate_video.mjs
// Professional Video Pipeline with:
// 1. Smooth, non-shaking Ken Burns motion engine (subpixel-stable high-res coordinate math)
// 2. Native FFmpeg xfade transitions between clips (Crossfade, Wipes, Slides, Dissolves, Zoom, etc.)
// 3. Exact audio & subtitle sync with customizable ASS typography overlay.

import { readdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IMAGE_DIR             = resolve(__dirname, 'image');
const AUDIO_PATH            = resolve(__dirname, 'audio/untitled.mp3');
const OUTPUT_PATH           = resolve(__dirname, 'output.mp4');
const FILTER_FILE           = resolve(__dirname, 'filter_complex.txt');
const SUBTITLE_PATH         = resolve(__dirname, 'subtitles/subtitles.srt');
const ASS_PATH              = resolve(__dirname, 'subtitles/subtitles.ass');
const TIMELINE_SETTINGS_PATH = resolve(__dirname, 'subtitles/timeline_settings.json');
const SUBTITLE_SETTINGS_PATH = resolve(__dirname, 'subtitles/settings.json');

const isFast   = process.argv.includes('--fast');
const is2K     = process.argv.includes('--2k');
const isStatic = process.argv.includes('--static') || process.argv.includes('--no-motion');

// Parse optional active-effects list passed from the UI: --effects=zoom-in,pan-left,...
const effectsArg = process.argv.find(a => a.startsWith('--effects='));
const activeEffectLabels = effectsArg ? effectsArg.slice('--effects='.length).split(',') : null;

// Parse optional global transition and duration
const transitionArg = process.argv.find(a => a.startsWith('--transition='));
const cliTransition = transitionArg ? transitionArg.slice('--transition='.length) : null;

const transDurArg = process.argv.find(a => a.startsWith('--transition-duration='));
const cliTransDur = transDurArg ? parseFloat(transDurArg.slice('--transition-duration='.length)) : null;

// ── 1. Audio Duration Check ──────────────────────────────────────────────────
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

// ── 2. Collect & Sort Images ─────────────────────────────────────────────────
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

const rawImages = readdirSync(IMAGE_DIR)
  .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
  .map(f => ({ name: f, startSec: parseTimestamp(f) }))
  .filter(x => x.startSec !== null)
  .sort((a, b) => a.startSec - b.startSec);

if (rawImages.length === 0) {
  console.error('❌ No timestamped images found in image directory!');
  process.exit(1);
}

// Compute each clip's duration
const images = rawImages.map((img, i) => {
  const nextStart = i < rawImages.length - 1 ? rawImages[i + 1].startSec : AUDIO_DURATION;
  const durationSec = Math.max(0.1, nextStart - img.startSec);
  return {
    ...img,
    durationSec: parseFloat(durationSec.toFixed(2)),
  };
});

// Load timeline settings if available
let timelineSettings = {
  globalTransition: 'fade',
  transitionDuration: 0.5,
  motionMode: 'ken-burns',
  clipOverrides: {},
};

if (existsSync(TIMELINE_SETTINGS_PATH)) {
  try {
    const raw = JSON.parse(readFileSync(TIMELINE_SETTINGS_PATH, 'utf-8'));
    timelineSettings = { ...timelineSettings, ...raw };
  } catch {}
}

const globalTransition = cliTransition || timelineSettings.globalTransition || 'fade';
const globalTransDur   = !isNaN(cliTransDur) && cliTransDur !== null ? cliTransDur : (timelineSettings.transitionDuration ?? 0.5);

// Resolution Selection
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
console.log(`📐 Target Canvas: ${outWidth}x${outHeight} @ ${fps}fps (${is2K ? '2K QHD' : isFast ? '720p HD Draft' : '1080p Full HD'})`);
console.log(`🎵 Audio duration: ${AUDIO_DURATION.toFixed(2)}s (${totalMin}m ${totalSec}s)`);
console.log(`🔀 Global Transition: ${globalTransition} (${globalTransDur}s)`);

// ── 3. Motion Effects Pool & Hash ────────────────────────────────────────────
const ALL_EFFECTS = [
  'zoom-in',
  'zoom-out',
  'pan-left',
  'pan-right',
  'pan-up',
  'pan-down',
  'diag-tl',
  'diag-br',
  'push-in',
  'pull-out',
];

const _activePool = activeEffectLabels
  ? ALL_EFFECTS.filter(e => activeEffectLabels.includes(e))
  : ALL_EFFECTS;
const EFFECT_POOL = _activePool.length > 0 ? _activePool : ALL_EFFECTS;

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ── 4. Subtitle ASS Builder ──────────────────────────────────────────────────
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
  borderStyle: 1,
  alignment: 2,
  marginV: 40,
  fadeInMs: 200,
};

function hexToAssColor(hex, alphaHex = '00') {
  if (!hex) return `&H${alphaHex}000000`;
  let clean = hex.replace('#', '').trim();
  if (clean.length === 3) clean = clean.split('').map(c => c + c).join('');
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
    } catch {}
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
    if (cfg.uppercase) clean = clean.toUpperCase();
    return `Dialogue: 0,${secToAssTime(e.start)},${secToAssTime(e.end)},Default,,0,0,0,,${fadTag}${clean}`;
  });

  return header + '\n' + dialogues.join('\n') + '\n';
}

// ── 5. Build Subpixel Smooth Ken Burns Filter for a Single Clip ─────────────
// High internal base resolution prevents any discrete integer rounding jumps or vibration.
const BASE_W = 2560;
const BASE_H = 1440;

function buildClipFilter(clipIdx, effectName, totalFrames, clipFps, width, height) {
  // Minimum 2 frames ensures zoompan filter always has enough data to initialise
  const safeFrames = Math.max(2, totalFrames);

  // setsar=1 normalises pixel-aspect-ratio so zoompan never sees non-square SAR,
  // which is the root cause of "Error reinitializing filters / Invalid argument".
  const prepChain = `scale=${BASE_W}:${BASE_H}:force_original_aspect_ratio=increase,crop=${BASE_W}:${BASE_H},setsar=1`;

  if (isStatic || effectName === 'static') {
    return `[${clipIdx}:v]${prepChain},zoompan=z=1.0:x=0:y=0:d=${safeFrames}:s=${width}x${height}:fps=${clipFps},setpts=PTS-STARTPTS[v${clipIdx}];\n`;
  }

  const d = safeFrames;
  const zoomInRate = (0.12 / d).toFixed(6);
  const pushInRate = (0.20 / d).toFixed(6);

  let zpExpr;
  switch (effectName) {
    case 'zoom-out':
      zpExpr = `z='max(1.14-${zoomInRate}*on,1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
      break;
    case 'pan-left':
      zpExpr = `z=1.12:x='max(0, (iw-iw/zoom)*(1-on/${d}))':y='ih/2-(ih/zoom/2)'`;
      break;
    case 'pan-right':
      zpExpr = `z=1.12:x='min(iw-iw/zoom, (iw-iw/zoom)*(on/${d}))':y='ih/2-(ih/zoom/2)'`;
      break;
    case 'pan-up':
      zpExpr = `z=1.12:x='iw/2-(iw/zoom/2)':y='max(0, (ih-ih/zoom)*(1-on/${d}))'`;
      break;
    case 'pan-down':
      zpExpr = `z=1.12:x='iw/2-(iw/zoom/2)':y='min(ih-ih/zoom, (ih-ih/zoom)*(on/${d}))'`;
      break;
    case 'diag-tl':
      zpExpr = `z='min(zoom+${(0.06/d).toFixed(6)},1.12)':x='max(0, (iw-iw/zoom)*(1-on/${d}))':y='max(0, (ih-ih/zoom)*(1-on/${d}))'`;
      break;
    case 'diag-br':
      zpExpr = `z='min(zoom+${(0.06/d).toFixed(6)},1.12)':x='min(iw-iw/zoom, (iw-iw/zoom)*(on/${d}))':y='min(ih-ih/zoom, (ih-ih/zoom)*(on/${d}))'`;
      break;
    case 'push-in':
      zpExpr = `z='min(zoom+${pushInRate},1.22)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
      break;
    case 'pull-out':
      zpExpr = `z='max(1.22-${pushInRate}*on,1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
      break;
    case 'zoom-in':
    default:
      zpExpr = `z='min(zoom+${zoomInRate},1.14)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
      break;
  }

  return `[${clipIdx}:v]${prepChain},zoompan=${zpExpr}:d=${safeFrames}:s=${width}x${height}:fps=${clipFps},setpts=PTS-STARTPTS[v${clipIdx}];\n`;
}

// ── 6. Assemble Complex Filter Graph with Transitions ─────────────────────────
console.log(`\n🧩 Building video pipeline for ${images.length} clips...`);

const inputs = [];
let filterGraph = '';

// Determine transition between clip i and clip i+1
const clipData = images.map((img, i) => {
  const override = timelineSettings.clipOverrides?.[img.name] || {};
  const effect = isStatic ? 'static' : (override.motion || EFFECT_POOL[simpleHash(img.name) % EFFECT_POOL.length]);
  
  let transition = override.transition || globalTransition;
  if (transition === 'random') {
    const ALL_XFADES = ['fade', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'circlecrop', 'dissolve', 'zoomin', 'smoothleft', 'smoothright'];
    transition = ALL_XFADES[simpleHash(img.name + '_trans') % ALL_XFADES.length];
  }
  
  const transDur = Math.min(
    Math.max(0.1, override.transitionDuration ?? globalTransDur),
    Math.max(0.1, img.durationSec * 0.75)
  );

  return {
    ...img,
    effect,
    transition,
    transDur: transition === 'cut' || transition === 'none' ? 0 : transDur,
  };
});

// Calculate total frames required for each clip
// If clip i transitions into clip i+1 with transition duration T, clip i needs an extra T seconds of rendered frames so xfade can blend
for (let i = 0; i < clipData.length; i++) {
  const c = clipData[i];
  const nextTransDur = i < clipData.length - 1 ? clipData[i].transDur : 0;
  const clipRenderDuration = c.durationSec + nextTransDur;
  const totalFrames = Math.max(2, Math.round(clipRenderDuration * fps));

  const imgPath = resolve(IMAGE_DIR, c.name).replace(/\\/g, '/');
  // -thread_queue_size prevents frame-injection bottlenecks with many image inputs
  inputs.push('-thread_queue_size', '512', '-i', imgPath);

  filterGraph += buildClipFilter(i, c.effect, totalFrames, fps, outWidth, outHeight);
}

// Chain xfade transitions between clips
let lastStream = 'v0';
let currentTimelineOffset = clipData[0].durationSec;

for (let i = 1; i < clipData.length; i++) {
  const prevClip = clipData[i - 1];
  const currClip = clipData[i];
  const outLabel = `xf${i}`;
  const tType = prevClip.transition;
  const tDur  = prevClip.transDur;

  if (tDur > 0 && tType !== 'cut' && tType !== 'none') {
    const xfadeOffset = Math.max(0, currentTimelineOffset - tDur).toFixed(3);
    filterGraph += `[${lastStream}][v${i}]xfade=transition=${tType}:duration=${tDur.toFixed(3)}:offset=${xfadeOffset}[${outLabel}];\n`;
    currentTimelineOffset += currClip.durationSec;
  } else {
    // Hard cut fallback
    filterGraph += `[${lastStream}][v${i}]concat=n=2:v=1:a=0[${outLabel}];\n`;
    currentTimelineOffset += currClip.durationSec;
  }
  lastStream = outLabel;
}

filterGraph += `[${lastStream}]format=yuv420p[vfinal]`;

// Handle Subtitles
const hasSubs = existsSync(SUBTITLE_PATH);
let outputStreamLabel = 'vfinal';

if (hasSubs) {
  try {
    const srtContent = readFileSync(SUBTITLE_PATH, 'utf-8');
    const entries = parseSrtToEntries(srtContent);
    const subSettings = loadSubtitleSettings();
    const resScale = outWidth / 1920;
    writeFileSync(ASS_PATH, buildAssFile(entries, outWidth, outHeight, subSettings, resScale), 'utf-8');
    console.log(`💬 Subtitles: ${entries.length} cues loaded (${subSettings.fontName || 'Inter'}, ${subSettings.fontSize || 42}px)`);

    const assForFFmpeg = ASS_PATH.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
    filterGraph += `;\n[vfinal]ass='${assForFFmpeg}'[vout]`;
    outputStreamLabel = 'vout';
  } catch (e) {
    console.warn('⚠️ Subtitle generation error:', e.message);
  }
}

writeFileSync(FILTER_FILE, filterGraph, 'utf-8');

// ── 7. Execute Native FFmpeg Render ──────────────────────────────────────────
const hasAudio = existsSync(AUDIO_PATH);
const audioInputIdx = inputs.length / 2;
const ffmpegArgs = [
  '-y',
  ...inputs,
  ...(hasAudio ? ['-i', AUDIO_PATH] : []),
  '-filter_complex_script', FILTER_FILE,
  '-map', `[${outputStreamLabel}]`,
  ...(hasAudio ? ['-map', `${audioInputIdx}:a:0`, '-c:a', 'aac', '-b:a', '192k'] : []),
  '-c:v', 'libx264',
  '-preset', preset,
  '-crf', '17',
  '-movflags', 'faststart',
  '-t', AUDIO_DURATION.toFixed(3),
  OUTPUT_PATH,
  '-progress', 'pipe:1',
];

console.log(`\n🚀 Starting native FFmpeg render (${outWidth}x${outHeight} @ ${fps}fps, CRF 17)...`);

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
      if (existsSync(FILTER_FILE)) unlinkSync(FILTER_FILE);
    } catch {}
    rejectPromise(err);
  });
});
