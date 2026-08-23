// transcribe.mjs
// Transcribes audio/untitled.mp3 using OpenAI Whisper (model: base).
// Writes the result to subtitles/subtitles.srt and streams progress to stdout
// so server.mjs can relay it to the UI as Server-Sent Events.

import { existsSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const AUDIO_PATH    = resolve(__dirname, 'audio/untitled.mp3');
const SUBTITLE_DIR  = resolve(__dirname, 'subtitles');
const SUBTITLE_PATH = resolve(__dirname, 'subtitles/subtitles.srt');

if (!existsSync(AUDIO_PATH)) {
  console.error(`❌ Audio file not found: ${AUDIO_PATH}`);
  process.exit(1);
}

// Snapshot existing SRT files before transcription so we can identify the new one
const beforeSrts = existsSync(SUBTITLE_DIR)
  ? new Set(readdirSync(SUBTITLE_DIR).filter(f => f.endsWith('.srt')))
  : new Set();

console.log(`🎙️  Whisper transcription starting (model: base)...`);
console.log(`📁 Audio: ${AUDIO_PATH}`);
console.log(`📂 Output dir: ${SUBTITLE_DIR}`);

const proc = spawn('python', [
  '-m', 'whisper',
  AUDIO_PATH,
  '--model', 'base',
  '--output_format', 'srt',
  '--output_dir', SUBTITLE_DIR,
  '--verbose', 'False',
], { stdio: ['ignore', 'pipe', 'pipe'] });

// Whisper writes progress to stderr — forward everything to stdout so the
// server's SSE handler picks it up uniformly.
proc.stdout.on('data', chunk => process.stdout.write(chunk.toString()));
proc.stderr.on('data', chunk => process.stdout.write(chunk.toString()));

proc.on('close', code => {
  if (code !== 0) {
    console.error(`❌ Whisper exited with code ${code}`);
    process.exit(code);
  }

  // Find the newly generated SRT file by diffing the directory
  try {
    const afterSrts = existsSync(SUBTITLE_DIR)
      ? readdirSync(SUBTITLE_DIR).filter(f => f.endsWith('.srt'))
      : [];
    const newFile = afterSrts.find(f => !beforeSrts.has(f) && f !== 'subtitles.srt');

    if (newFile) {
      if (existsSync(SUBTITLE_PATH)) unlinkSync(SUBTITLE_PATH);
      renameSync(resolve(SUBTITLE_DIR, newFile), SUBTITLE_PATH);
      console.log(`✅ Transcription complete! Saved → ${SUBTITLE_PATH}`);
    } else if (existsSync(SUBTITLE_PATH)) {
      console.log(`✅ Transcription complete! SRT updated: ${SUBTITLE_PATH}`);
    } else {
      console.error('❌ Could not locate generated SRT file after transcription');
      process.exit(1);
    }
  } catch (e) {
    console.error('❌ Post-processing error:', e.message);
    process.exit(1);
  }
});

proc.on('error', err => {
  console.error(`❌ Failed to start Whisper: ${err.message}`);
  console.error('   Ensure openai-whisper is installed: pip install openai-whisper');
  process.exit(1);
});
