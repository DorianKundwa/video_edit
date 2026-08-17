// generate_video.mjs
// Reads images from ./image/, parses [M-SS] timestamps from filenames,
// computes each clip's duration, then runs editly with the audio track.

import { readdirSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import editly from './editly/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IMAGE_DIR   = resolve(__dirname, 'image');
const AUDIO_PATH  = resolve(__dirname, 'audio/untitled.mp3');
const OUTPUT_PATH = resolve(__dirname, 'output.mp4');

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

const AUDIO_DURATION = getAudioDuration(AUDIO_PATH);

// ── 1. Collect & sort images by timestamp ──────────────────────────────────
function parseTimestamp(filename) {
  // Matches [M-SS] or [MM-SS] at the start of the filename
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

const totalMin = Math.floor(AUDIO_DURATION / 60);
const totalSec = Math.floor(AUDIO_DURATION % 60);
console.log(`📸 Found ${images.length} timestamped images, spanning ${images[0].startSec}s → ${images.at(-1).startSec}s`);
console.log(`🎵 Audio duration: ${AUDIO_DURATION.toFixed(2)}s (${totalMin}m ${totalSec}s)`);
console.log(`⚡ Mode: ${isFast ? 'FAST PREVIEW (640x360 @ 15fps)' : 'HIGH QUALITY (1920x1080 @ 30fps)'}`);

// ── 2. Build editly clips — each image lasts until the next one starts ─────
const clips = images.map((img, i) => {
  const nextStart = i < images.length - 1 ? images[i + 1].startSec : AUDIO_DURATION;
  const duration  = Math.max(nextStart - img.startSec, 0.1); // at least 0.1s

  return {
    duration,
    layers: [
      {
        type: 'image',
        path: resolve(IMAGE_DIR, img.name),
        resizeMode: 'contain-blur', // letterbox with blurred background fill
      },
    ],
  };
});

// ── 3. Run editly ──────────────────────────────────────────────────────────
console.log('\n🚀 Starting editly render...');
await editly({
  outPath: OUTPUT_PATH,
  width:   isFast ? 640 : 1920,
  height:  isFast ? 360 : 1080,
  fps:     isFast ? 15 : 30,
  fast:    isFast,

  audioFilePath:   existsSync(AUDIO_PATH) ? AUDIO_PATH : undefined,
  loopAudio:       false,
  keepSourceAudio: false,

  defaults: {
    transition: null, // Hard cuts — preserves exact timestamp timing
  },

  clips,

  verbose: false,
  enableFfmpegLog: false,
});

console.log(`\n✅ Done! Video saved to: ${OUTPUT_PATH}`);
