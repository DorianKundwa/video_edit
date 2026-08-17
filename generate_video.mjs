// generate_video.mjs
// Reads images from ./image/, parses [M-SS] timestamps from filenames,
// computes each clip's duration, then renders directly with native FFmpeg.

import { readdirSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IMAGE_DIR   = resolve(__dirname, 'image');
const AUDIO_PATH  = resolve(__dirname, 'audio/untitled.mp3');
const OUTPUT_PATH = resolve(__dirname, 'output.mp4');
const CONCAT_FILE = resolve(__dirname, 'concat_list.txt');

const isFast = process.argv.includes('--fast');

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

// ── Helper: Detect native image dimensions with ffprobe ─────────────────────
function getImageDimensions(filePath) {
  try {
    const stdout = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${filePath}"`,
      { encoding: 'utf-8' }
    ).trim();
    const parts = stdout.split('x').map(x => parseInt(x, 10));
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      const w = parts[0] % 2 === 0 ? parts[0] : parts[0] + 1;
      const h = parts[1] % 2 === 0 ? parts[1] : parts[1] + 1;
      return { width: w, height: h };
    }
  } catch (e) {
    console.warn('ffprobe image dimension check failed, using fallback:', e.message);
  }
  return { width: 1920, height: 1080 };
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

// Detect resolution from source images
const firstImagePath = resolve(IMAGE_DIR, images[0].name);
const nativeDimensions = getImageDimensions(firstImagePath);

const width = isFast ? Math.round(nativeDimensions.width / 2) : nativeDimensions.width;
const height = isFast ? Math.round(nativeDimensions.height / 2) : nativeDimensions.height;
// Ensure even numbers for H.264 encoder
const outWidth = width % 2 === 0 ? width : width + 1;
const outHeight = height % 2 === 0 ? height : height + 1;
const fps = isFast ? 15 : 30;
const preset = isFast ? 'ultrafast' : 'veryfast';

const totalMin = Math.floor(AUDIO_DURATION / 60);
const totalSec = Math.floor(AUDIO_DURATION % 60);
console.log(`📸 Found ${images.length} timestamped images, spanning ${images[0].startSec}s → ${images.at(-1).startSec}s`);
console.log(`📐 Image source resolution: ${nativeDimensions.width}x${nativeDimensions.height} → Output: ${outWidth}x${outHeight} @ ${fps}fps`);
console.log(`🎵 Audio duration: ${AUDIO_DURATION.toFixed(2)}s (${totalMin}m ${totalSec}s)`);
console.log(`⚡ Mode: ${isFast ? `FAST PREVIEW (${outWidth}x${outHeight} @ ${fps}fps)` : `NATIVE QUALITY (${outWidth}x${outHeight} @ ${fps}fps)`}`);

// ── 2. Build FFmpeg Concat Script & Interval Tree ─────────────────────────
const concatLines = ['ffconcat version 1.0'];
const intervals = [];

for (let i = 0; i < images.length; i++) {
  const img = images[i];
  const nextStart = i < images.length - 1 ? images[i + 1].startSec : AUDIO_DURATION;
  const duration = Math.max(nextStart - img.startSec, 0.1);
  const fullPath = resolve(IMAGE_DIR, img.name).replace(/\\/g, '/');
  // Escape single quotes for ffmpeg concat demuxer
  const escapedPath = fullPath.replace(/'/g, "'\\''");

  concatLines.push(`file '${escapedPath}'`);
  concatLines.push(`duration ${duration.toFixed(3)}`);
  intervals.push({ start: img.startSec, end: nextStart, dur: duration });
}

// FFmpeg concat demuxer requires the last file to be repeated without duration
const lastImgPath = resolve(IMAGE_DIR, images.at(-1).name).replace(/\\/g, '/').replace(/'/g, "'\\''");
concatLines.push(`file '${lastImgPath}'`);

writeFileSync(CONCAT_FILE, concatLines.join('\n'), 'utf-8');

// Build logarithmic binary search tree expression for smooth Ken Burns zoom (1.0 -> 1.08x per clip)
function buildZoomTree(items) {
  if (items.length === 1) {
    const { start, dur } = items[0];
    return `1+0.08*clip((it-${start})/${dur.toFixed(3)},0,1)`;
  }
  const mid = Math.floor(items.length / 2);
  const left = items.slice(0, mid);
  const right = items.slice(mid);
  const splitTime = left[left.length - 1].end;
  return `if(lt(it,${splitTime}),${buildZoomTree(left)},${buildZoomTree(right)})`;
}

const zoomExpr = buildZoomTree(intervals);

// ── 3. Render via FFmpeg with cinematic zoom & fade-in/out ─────────────────
const fadeDuration = 1.5; // 1.5s cinematic smooth fade
const fadeOutStart = Math.max(0, AUDIO_DURATION - fadeDuration);

// Background blur + foreground smooth Ken Burns zoom + cinematic fade in & out
const bgW = Math.max(160, Math.round(outWidth / 4));
const bgH = Math.max(90, Math.round(outHeight / 4));

const videoFilter = `[0:v]fps=${fps},` +
  `zoompan=z='${zoomExpr}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${outWidth}x${outHeight}:fps=${fps},` +
  `split=2[bg][fg];` +
  `[bg]scale=${bgW}:${bgH}:force_original_aspect_ratio=increase,crop=${bgW}:${bgH},boxblur=8:1,scale=${outWidth}:${outHeight}:flags=bilinear[bgblur];` +
  `[fg]scale=${outWidth}:${outHeight}:force_original_aspect_ratio=decrease[fgscaled];` +
  `[bgblur][fgscaled]overlay=(W-w)/2:(H-h)/2,fade=t=in:st=0:d=${fadeDuration}:color=black,fade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeDuration}:color=black,format=yuv420p[v]`;

const audioFilter = `afade=t=in:st=0:d=${fadeDuration},afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeDuration}`;

const hasAudio = existsSync(AUDIO_PATH);
const ffmpegArgs = [
  '-f', 'concat',
  '-safe', '0',
  '-i', CONCAT_FILE,
  ...(hasAudio ? ['-i', AUDIO_PATH] : []),
  '-filter_complex', videoFilter,
  '-map', '[v]',
  ...(hasAudio ? ['-map', '1:a:0', '-af', audioFilter, '-c:a', 'aac', '-b:a', '192k'] : []),
  '-c:v', 'libx264',
  '-preset', preset,
  '-crf', '18',
  '-movflags', 'faststart',
  '-shortest',
  '-y',
  OUTPUT_PATH,
  '-progress', 'pipe:1',
];

console.log('\n🎬 Starting native FFmpeg render with Ken Burns zoom & cinematic fade...');

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
