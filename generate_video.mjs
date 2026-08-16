// generate_video.mjs
// Reads images from ./image/, parses [M-SS] timestamps from filenames,
// computes each clip's duration, then runs editly with the audio track.

import { readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import editly from './editly/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IMAGE_DIR   = resolve(__dirname, 'image');
const AUDIO_PATH  = resolve(__dirname, 'audio/untitled.mp3');
const OUTPUT_PATH = resolve(__dirname, 'output.mp4');
const AUDIO_DURATION = 651.8857; // seconds — from ffprobe

// ── 1. Collect & sort images by timestamp ──────────────────────────────────
function parseTimestamp(filename) {
  // Matches [M-SS] or [MM-SS] at the start of the name
  const m = filename.match(/^\[(\d+)-(\d+)\]/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseInt(m[2]);
}

const images = readdirSync(IMAGE_DIR)
  .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
  .map(f => ({ name: f, startSec: parseTimestamp(f) }))
  .filter(x => x.startSec !== null)
  .sort((a, b) => a.startSec - b.startSec);

console.log(`Found ${images.length} images, spanning ${images[0].startSec}s → ${images.at(-1).startSec}s`);
console.log(`Audio duration: ${AUDIO_DURATION}s`);

// ── 2. Build editly clips — each image lasts until the next one starts ─────
const clips = images.map((img, i) => {
  const nextStart = i < images.length - 1 ? images[i + 1].startSec : AUDIO_DURATION;
  const duration  = Math.max(nextStart - img.startSec, 0.1); // never 0

  console.log(`  [${img.name}]  ${img.startSec}s  →  duration: ${duration.toFixed(2)}s`);

  return {
    duration,
    layers: [
      {
        type: 'image',
        path: resolve(IMAGE_DIR, img.name),
        resizeMode: 'contain-blur', // letterbox with blurred bg
      },
    ],
  };
});

// ── 3. Run editly ──────────────────────────────────────────────────────────
console.log('\nStarting editly render...');
await editly({
  outPath: OUTPUT_PATH,
  width:   1920,
  height:  1080,
  fps:     30,

  audioFilePath:   AUDIO_PATH,
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
