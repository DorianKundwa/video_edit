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
  if (!existsSync(filePath)) return null;
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
  return null;
}

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
  .sort((a, b) => a.startSec - b.startSec || a.name.localeCompare(b.name));

if (rawImages.length === 0) {
  console.error('❌ No timestamped images found in image directory!');
  process.exit(1);
}

const detectedAudioDur = getAudioDuration(AUDIO_PATH);
const fallbackTotalDuration = (rawImages.at(-1)?.startSec || 0) + 5;
const AUDIO_DURATION = detectedAudioDur || fallbackTotalDuration;

// Compute each clip's duration with robust duplicate/equal timestamp grouping
const rawClips = [];
let imgIdx = 0;
while (imgIdx < rawImages.length) {
  let j = imgIdx;
  while (j < rawImages.length && rawImages[j].startSec === rawImages[imgIdx].startSec) {
    j++;
  }
  const groupCount = j - imgIdx;
  const currentStart = rawImages[imgIdx].startSec;
  const nextStart = j < rawImages.length ? rawImages[j].startSec : AUDIO_DURATION;
  const totalGroupSpan = Math.max(groupCount * 1.5, nextStart - currentStart);
  const durPerImg = totalGroupSpan / groupCount;

  for (let k = 0; k < groupCount; k++) {
    rawClips.push({
      name: rawImages[imgIdx + k].name,
      nominalStartSec: parseFloat((currentStart + k * durPerImg).toFixed(2)),
    });
  }
  imgIdx = j;
}

const images = rawClips.map((c, idx) => {
  const targetStartSec = idx === 0 ? 0 : c.nominalStartSec;
  return {
    name: c.name,
    nominalStartSec: c.nominalStartSec,
    startSec: parseFloat(targetStartSec.toFixed(3)),
  };
});

for (let i = 0; i < images.length; i++) {
  const nextStart = i < images.length - 1 ? images[i + 1].startSec : AUDIO_DURATION;
  images[i].durationSec = parseFloat(Math.max(0.5, nextStart - images[i].startSec).toFixed(3));
}

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
  const parts = t.replace(',', '.').split(':');
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  return 0;
}

function secToAssTime(sec) {
  const totalCs = Math.max(0, Math.round(sec * 100));
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
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
// Uses FFmpeg's continuous bicubic spline perspective interpolation engine (eval=frame).
// Completely eliminates the discrete integer-boundary stair-stepping and shaking of the legacy zoompan filter.

function buildClipFilter(clipIdx, effectName, totalFrames, clipFps, width, height) {
  const safeFrames = Math.max(2, totalFrames);
  const d = safeFrames;

  // Scale & crop normalises to canvas aspect ratio with exact output framerate
  const prepChain = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${clipFps}`;
  const tbNorm = `trim=start_frame=0:end_frame=${safeFrames},setpts=PTS-STARTPTS,settb=1/${clipFps}`;

  if (isStatic || effectName === 'static') {
    return `[${clipIdx}:v]${prepChain},${tbNorm}[v${clipIdx}];\n`;
  }

  let perspExpr;
  switch (effectName) {
    case 'zoom-out': {
      const z = `(1.14-0.14*on/${d})`;
      perspExpr = `x0='(W/2)*(1-1/${z})':y0='(H/2)*(1-1/${z})':x1='W-(W/2)*(1-1/${z})':y1='(H/2)*(1-1/${z})':x2='(W/2)*(1-1/${z})':y2='H-(H/2)*(1-1/${z})':x3='W-(W/2)*(1-1/${z})':y3='H-(H/2)*(1-1/${z})'`;
      break;
    }
    case 'pan-left': {
      const z = 1.12;
      const invZ = (1 / z).toFixed(6);
      const rx = (1 - 1 / z).toFixed(6);
      const my = ((1 - 1 / z) / 2).toFixed(6);
      perspExpr = `x0='W*${rx}*(1-on/${d})':y0='H*${my}':x1='W*${rx}*(1-on/${d})+W*${invZ}':y1='H*${my}':x2='W*${rx}*(1-on/${d})':y2='H-H*${my}':x3='W*${rx}*(1-on/${d})+W*${invZ}':y3='H-H*${my}'`;
      break;
    }
    case 'pan-right': {
      const z = 1.12;
      const invZ = (1 / z).toFixed(6);
      const rx = (1 - 1 / z).toFixed(6);
      const my = ((1 - 1 / z) / 2).toFixed(6);
      perspExpr = `x0='W*${rx}*(on/${d})':y0='H*${my}':x1='W*${rx}*(on/${d})+W*${invZ}':y1='H*${my}':x2='W*${rx}*(on/${d})':y2='H-H*${my}':x3='W*${rx}*(on/${d})+W*${invZ}':y3='H-H*${my}'`;
      break;
    }
    case 'pan-up': {
      const z = 1.12;
      const invZ = (1 / z).toFixed(6);
      const mx = ((1 - 1 / z) / 2).toFixed(6);
      const ry = (1 - 1 / z).toFixed(6);
      perspExpr = `x0='W*${mx}':y0='H*${ry}*(1-on/${d})':x1='W-W*${mx}':y1='H*${ry}*(1-on/${d})':x2='W*${mx}':y2='H*${ry}*(1-on/${d})+H*${invZ}':x3='W-W*${mx}':y3='H*${ry}*(1-on/${d})+H*${invZ}'`;
      break;
    }
    case 'pan-down': {
      const z = 1.12;
      const invZ = (1 / z).toFixed(6);
      const mx = ((1 - 1 / z) / 2).toFixed(6);
      const ry = (1 - 1 / z).toFixed(6);
      perspExpr = `x0='W*${mx}':y0='H*${ry}*(on/${d})':x1='W-W*${mx}':y1='H*${ry}*(on/${d})':x2='W*${mx}':y2='H*${ry}*(on/${d})+H*${invZ}':x3='W-W*${mx}':y3='H*${ry}*(on/${d})+H*${invZ}'`;
      break;
    }
    case 'diag-tl': {
      const z = `(1.0+0.08*on/${d})`;
      perspExpr = `x0='(W*(1-1/${z}))*(1-on/${d})':y0='(H*(1-1/${z}))*(1-on/${d})':x1='(W*(1-1/${z}))*(1-on/${d})+W/${z}':y1='(H*(1-1/${z}))*(1-on/${d})':x2='(W*(1-1/${z}))*(1-on/${d})':y2='(H*(1-1/${z}))*(1-on/${d})+H/${z}':x3='(W*(1-1/${z}))*(1-on/${d})+W/${z}':y3='(H*(1-1/${z}))*(1-on/${d})+H/${z}'`;
      break;
    }
    case 'diag-br': {
      const z = `(1.0+0.08*on/${d})`;
      perspExpr = `x0='(W*(1-1/${z}))*(on/${d})':y0='(H*(1-1/${z}))*(on/${d})':x1='(W*(1-1/${z}))*(on/${d})+W/${z}':y1='(H*(1-1/${z}))*(on/${d})':x2='(W*(1-1/${z}))*(on/${d})':y2='(H*(1-1/${z}))*(on/${d})+H/${z}':x3='(W*(1-1/${z}))*(on/${d})+W/${z}':y3='(H*(1-1/${z}))*(on/${d})+H/${z}'`;
      break;
    }
    case 'push-in': {
      const z = `(1.0+0.22*on/${d})`;
      perspExpr = `x0='(W/2)*(1-1/${z})':y0='(H/2)*(1-1/${z})':x1='W-(W/2)*(1-1/${z})':y1='(H/2)*(1-1/${z})':x2='(W/2)*(1-1/${z})':y2='H-(H/2)*(1-1/${z})':x3='W-(W/2)*(1-1/${z})':y3='H-(H/2)*(1-1/${z})'`;
      break;
    }
    case 'pull-out': {
      const z = `(1.22-0.22*on/${d})`;
      perspExpr = `x0='(W/2)*(1-1/${z})':y0='(H/2)*(1-1/${z})':x1='W-(W/2)*(1-1/${z})':y1='(H/2)*(1-1/${z})':x2='(W/2)*(1-1/${z})':y2='H-(H/2)*(1-1/${z})':x3='W-(W/2)*(1-1/${z})':y3='H-(H/2)*(1-1/${z})'`;
      break;
    }
    case 'zoom-in':
    default: {
      const z = `(1.0+0.14*on/${d})`;
      perspExpr = `x0='(W/2)*(1-1/${z})':y0='(H/2)*(1-1/${z})':x1='W-(W/2)*(1-1/${z})':y1='(H/2)*(1-1/${z})':x2='(W/2)*(1-1/${z})':y2='H-(H/2)*(1-1/${z})':x3='W-(W/2)*(1-1/${z})':y3='H-(H/2)*(1-1/${z})'`;
      break;
    }
  }

  return `[${clipIdx}:v]${prepChain},perspective=${perspExpr}:interpolation=cubic:eval=frame,${tbNorm}[v${clipIdx}];\n`;
}

// ── 6. Assemble Complex Filter Graph with Transitions ─────────────────────────
console.log(`\n🧩 Building video pipeline for ${images.length} clips...`);

const inputs = [];
let filterGraph = '';

// Determine transition and motion effect for each clip
const clipData = images.map((img, idx) => {
  const override = timelineSettings.clipOverrides?.[img.name] || {};
  const effect = isStatic ? 'static' : (override.motion || (activeEffectLabels ? EFFECT_POOL[simpleHash(img.name) % EFFECT_POOL.length] : 'zoom-in'));
  
  let transition = override.transition || globalTransition;
  if (transition === 'random') {
    const ALL_XFADES = ['fade', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'circlecrop', 'dissolve', 'zoomin', 'smoothleft', 'smoothright'];
    transition = ALL_XFADES[simpleHash(img.name + '_trans') % ALL_XFADES.length];
  }
  
  const nextClip = images[idx + 1];
  const maxSafeTransDur = nextClip ? Math.min(img.durationSec * 0.75, nextClip.durationSec * 0.75) : 0;
  const requestedTransDur = override.transitionDuration ?? globalTransDur;
  const rawTransDur = Math.min(
    Math.max(0.1, requestedTransDur),
    Math.max(0.1, maxSafeTransDur)
  );

  const isCut = transition === 'cut' || transition === 'none' || !nextClip;
  const tFrames = isCut ? 0 : Math.max(1, Math.round(rawTransDur * fps));
  const transDur = isCut ? 0 : tFrames / fps;

  return {
    ...img,
    effect,
    transition: isCut ? 'cut' : transition,
    transFrames: tFrames,
    transDur,
  };
});

// Calculate total frames required for each clip
let imageInputCount = 0;
for (let idx = 0; idx < clipData.length; idx++) {
  const c = clipData[idx];
  const nextTransDur = idx < clipData.length - 1 ? clipData[idx].transDur : 0;
  const totalFrames = Math.max(2, Math.round((c.durationSec + nextTransDur) * fps));
  c.actualRenderSec = totalFrames / fps;

  const imgPath = resolve(IMAGE_DIR, c.name).replace(/\\/g, '/');
  inputs.push('-framerate', String(fps), '-loop', '1', '-t', c.actualRenderSec.toFixed(3), '-i', imgPath);
  imageInputCount++;

  filterGraph += buildClipFilter(idx, c.effect, totalFrames, fps, outWidth, outHeight);
}

// Chain xfade transitions between clips with frame-accurate stream duration tracking
let lastStream = 'v0';
let streamDuration = clipData[0].actualRenderSec;

for (let idx = 1; idx < clipData.length; idx++) {
  const prevClip = clipData[idx - 1];
  const currClip = clipData[idx];
  const outLabel = `xf${idx}`;
  const tType = prevClip.transition;
  const tDur  = prevClip.transDur;

  if (tDur > 0 && tType !== 'cut' && tType !== 'none') {
    const offset = streamDuration - tDur;
    filterGraph += `[${lastStream}][v${idx}]xfade=transition=${tType}:duration=${tDur.toFixed(3)}:offset=${offset.toFixed(3)},settb=1/${fps}[${outLabel}];\n`;
    streamDuration = offset + currClip.actualRenderSec;
  } else {
    // Hard cut fallback
    filterGraph += `[${lastStream}][v${idx}]concat=n=2:v=1:a=0,settb=1/${fps}[${outLabel}];\n`;
    streamDuration += currClip.actualRenderSec;
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
// imageInputCount tracks the exact number of -i flags used for images,
// so the audio stream index is always correct regardless of other flags.
const audioInputIdx = imageInputCount;
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
            process.stdout.write(`${pct}%\n`);
          }
        }
      }
    }
  });

  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
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
      // Always print full FFmpeg stderr on failure so the error is visible
      console.error('\n🔴 FFmpeg stderr output:\n');
      console.error(stderrBuf);
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
