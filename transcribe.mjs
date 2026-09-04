// transcribe.mjs
// Transcribes active audio in audio/ using OpenAI Whisper (model: base).
// Writes the result to subtitles/subtitles.srt and streams progress to stdout
// so server.mjs can relay it to the UI as Server-Sent Events.

import { existsSync, readdirSync, renameSync, unlinkSync, readFileSync } from 'fs';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const AUDIO_DIR     = resolve(__dirname, 'audio');
const SUBTITLE_DIR  = resolve(__dirname, 'subtitles');
const SUBTITLE_PATH = resolve(__dirname, 'subtitles/subtitles.srt');
const AUDIO_EXTS    = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma', '.opus', '.aiff', '.m4b']);

function findAudioFile() {
  const cliAudio = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (cliAudio) {
    const p = resolve(__dirname, cliAudio);
    if (existsSync(p)) return p;
  }
  const audioSettingsPath = resolve(__dirname, 'subtitles/audio_settings.json');
  if (existsSync(audioSettingsPath)) {
    try {
      const data = JSON.parse(readFileSync(audioSettingsPath, 'utf-8'));
      if (data?.selectedAudio) {
        const p = resolve(AUDIO_DIR, data.selectedAudio);
        if (existsSync(p)) return p;
      }
    } catch {}
  }
  if (!existsSync(AUDIO_DIR)) return null;
  const files = readdirSync(AUDIO_DIR).filter(f => AUDIO_EXTS.has(extname(f).toLowerCase()));
  if (files.length === 0) return null;
  const preferred = files.find(f => f.toLowerCase().startsWith('untitled')) || files[0];
  return resolve(AUDIO_DIR, preferred);
}

const AUDIO_PATH = findAudioFile() || resolve(__dirname, 'audio/untitled.mp3');

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
