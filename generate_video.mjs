// generate_video.mjs
// Reads images from ./image/, parses [M-SS] timestamps from filenames,
// computes each clip's duration, then renders directly with native FFmpeg.

import { readdirSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IMAGE_DIR   = resolve(__dirname, 'image');
const AUDIO_PATH  = resolve(__dirname, 'audio/untitled.mp3');
const OUTPUT_PATH = resolve(__dirname, 'output.mp4');
const CONCAT_FILE = resolve(__dirname, 'concat_list.txt');

const isFast = process.argv.includes('--fast');
const is2K   = process.argv.includes('--2k');
const noZoom = process.argv.includes('--no-zoom') || process.argv.includes('--zoom=false');

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

// ── 2. Build FFmpeg Concat Script & Interval Tree ─────────────────────────
const concatLines = ['ffconcat version 1.0'];
const intervals = [];

for (let i = 0; i < images.length; i++) {
  const img = images[i];
  const nextStart = i < images.length - 1 ? images[i + 1].startSec : AUDIO_DURATION;
  const duration = Math.max(nextStart - img.startSec, 0.1);
  const fullPath = resolve(IMAGE_DIR, img.name).replace(/\\/g, '/');
  const escapedPath = fullPath.replace(/'/g, "'\\''");

  concatLines.push(`file '${escapedPath}'`);
  concatLines.push(`duration ${duration.toFixed(3)}`);
  intervals.push({ start: img.startSec, end: nextStart, dur: duration });
}

// Last file repeated for concat demuxer requirement
const lastImgPath = resolve(IMAGE_DIR, images.at(-1).name).replace(/\\/g, '/').replace(/'/g, "'\\''");
concatLines.push(`file '${lastImgPath}'`);

writeFileSync(CONCAT_FILE, concatLines.join('\n'), 'utf-8');

// Build logarithmic binary search tree expression for butter-smooth Ken Burns zoom
function buildZoomTree(items) {
  if (items.length === 1) {
    const { start, dur } = items[0];
    return `0.06*clip((t-${start})/${dur.toFixed(3)},0,1)`;
  }
  const mid = Math.floor(items.length / 2);
  const left = items.slice(0, mid);
  const right = items.slice(mid);
  const splitTime = left[left.length - 1].end;
  return `if(lt(t,${splitTime}),${buildZoomTree(left)},${buildZoomTree(right)})`;
}

const zoomExpr = noZoom ? '0' : buildZoomTree(intervals);

// ── 3. Render via FFmpeg with smooth continuous scaling ──────────────────
// Background blur dimensions
const bgW = Math.max(160, Math.round(outWidth / 4));
const bgH = Math.max(90, Math.round(outHeight / 4));

// Continuous bicubic frame scaling without zoompan integer pixel stepping
const scaleW = noZoom ? `${outWidth}` : `trunc(${outWidth}*(1+${zoomExpr})/2)*2`;
const scaleH = noZoom ? `${outHeight}` : `trunc(${outHeight}*(1+${zoomExpr})/2)*2`;

const fgFilter = noZoom
  ? `[fg]scale=${outWidth}:${outHeight}:force_original_aspect_ratio=decrease[fgscaled];`
  : `[fg]scale='${scaleW}':'${scaleH}':force_original_aspect_ratio=decrease:eval=frame:flags=bicubic[fgscaled];`;

const videoFilter = `[0:v]fps=${fps},split=2[bg][fg];` +
  `[bg]scale=${bgW}:${bgH}:force_original_aspect_ratio=increase,crop=${bgW}:${bgH},boxblur=8:1,scale=${outWidth}:${outHeight}:flags=bilinear[bgblur];` +
  fgFilter +
  `[bgblur][fgscaled]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]`;

const hasAudio = existsSync(AUDIO_PATH);
const ffmpegArgs = [
  '-f', 'concat',
  '-safe', '0',
  '-i', CONCAT_FILE,
  ...(hasAudio ? ['-i', AUDIO_PATH] : []),
  '-filter_complex', videoFilter,
  '-map', '[v]',
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

console.log(`\n🎬 Starting native FFmpeg render (${outWidth}x${outHeight} @ ${fps}fps, CRF 17)...`);

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
    } catch {}
    rejectPromise(err);
  });
});
