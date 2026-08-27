"use strict";

// Generates dungeon background-music tracks via the Gemini API's Interactions
// endpoint (Lyria 3) and drops them into Assets/audio/music/, ready to be
// served as-is — unlike sprites, generated audio needs no separate
// chroma-key/trim pass, so there's no process-* counterpart to this script.
//
// Requires GEMINI_API_KEY in your environment (get one at
// https://aistudio.google.com) — same key generate-sprites.js already uses.
//
// Usage:
//   node generate-music.js <name> <prompt...>
//   node generate-music.js --file requests.json
//     where requests.json is [{ "name": "...", "prompt": "..." }, ...]
//
// Example:
//   node generate-music.js --file tools/music-requests.json

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const OUT_DIR = path.join(__dirname, '..', 'Assets', 'audio', 'music');

// lyria-3-clip-preview returns a fixed 30-second clip -- explicitly the
// "loops, previews" model per Google's docs, which is exactly the shape a
// looping ambient dungeon bed needs. lyria-3-pro-preview aims for full song
// structure (verse/chorus/bridge) instead, which is the wrong shape for a
// bed that's meant to loop under gameplay, so it's not offered as the
// default here — override via GEMINI_MUSIC_MODEL if you want to experiment
// with it anyway.
const MODEL = process.env.GEMINI_MUSIC_MODEL || 'lyria-3-clip-preview';

// Every track shares this framing so the four dungeon prompts only need to
// describe mood/instrumentation, not repeat "no vocals, loopable, etc."
// each time. js/audio.js crossfades the clip's tail back into its own head
// to mask the loop seam, so "loops cleanly" here is a hint to the model, not
// a hard technical requirement.
const STYLE_PREFIX = 'Instrumental orchestral fantasy game background music, medieval/Arthurian in '
  + 'tone, no vocals, no spoken words, no lyrics. Written as an ambient bed that loops cleanly and '
  + 'plays continuously under fast-paced combat sound effects, so keep it atmospheric rather than '
  + 'busy or bombastic -- it needs to sit behind the action, not compete with it. ';

function requireApiKey(){
  const key = process.env.GEMINI_API_KEY;
  if(!key){
    console.error(
      'GEMINI_API_KEY is not set.\n\n' +
      'Get a key at https://aistudio.google.com, then set it in your shell, e.g.:\n' +
      '  (bash/zsh)   export GEMINI_API_KEY="your-key-here"\n' +
      '  (PowerShell) $env:GEMINI_API_KEY = "your-key-here"\n\n' +
      'This script only reads that variable — the key itself never gets written into any file here.'
    );
    process.exit(1);
  }
  return key;
}

// audio/mpeg isn't a typo for audio/mp3 -- it's the real registered MIME
// type; mp3 is just the file extension either way.
const EXT_BY_MIME = {
  'audio/mp3': 'mp3', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
  'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac'
};

async function generateOne(ai, name, prompt){
  const fullPrompt = STYLE_PREFIX + prompt;
  console.log(`[${name}] requesting (model: ${MODEL})...`);

  // The Interactions API's schema changed May 2026 (@google/genai >= 2.0.0
  // required): response_format replaces the old response_modalities, and
  // the SDK now exposes the audio output directly as output_audio instead
  // of a generic outputs[] array to scan.
  const interaction = await ai.interactions.create({
    model: MODEL,
    input: fullPrompt,
    response_format: { type: 'audio' }
  });

  const audio = interaction.output_audio;
  if(!audio){
    throw new Error(
      'No audio came back' + (interaction.output_text ? ` — model said: "${interaction.output_text}"` : ` (status: ${interaction.status})`)
    );
  }

  const ext = EXT_BY_MIME[audio.mime_type] || 'mp3';
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${name}.${ext}`);
  fs.writeFileSync(outPath, Buffer.from(audio.data, 'base64'));
  console.log(`[${name}] -> Assets/audio/music/${name}.${ext}`);
}

async function main(){
  const apiKey = requireApiKey();
  const ai = new GoogleGenAI({ apiKey });

  const args = process.argv.slice(2);
  let requests;

  if(args[0] === '--file'){
    const filePath = args[1];
    if(!filePath){
      console.error('Usage: node generate-music.js --file <path-to-requests.json>');
      process.exit(1);
    }
    requests = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } else if(args.length >= 2){
    requests = [{ name: args[0], prompt: args.slice(1).join(' ') }];
  } else {
    console.error(
      'Usage:\n' +
      '  node generate-music.js <name> <prompt...>\n' +
      '  node generate-music.js --file <requests.json>   (array of {name, prompt})'
    );
    process.exit(1);
  }

  for(const { name, prompt } of requests){
    try {
      await generateOne(ai, name, prompt);
    } catch(err){
      console.error(`[${name}] FAILED: ${err.message}`);
    }
  }

  console.log('\nDone. The filename (without extension) is what js/audio.js\'s DUNGEON_TRACK_SLUG must map to.');
}

main().catch(err => { console.error(err); process.exit(1); });
