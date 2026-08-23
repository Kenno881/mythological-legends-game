"use strict";

// Generates raw sprite art via the Gemini API and drops it into
// Assets/sprites/, ready for the existing chroma-key/trim pipeline
// (process-sprites.js) — generation and processing stay separate steps on
// purpose, so you can eyeball a new sprite before it's batch-processed.
//
// Requires GEMINI_API_KEY in your environment (get one at
// https://aistudio.google.com). This script never sees a hardcoded key —
// only reads whatever your shell already has set.
//
// Usage:
//   node generate-sprites.js <name> <prompt...>
//   node generate-sprites.js --file requests.json
//     where requests.json is [{ "name": "...", "prompt": "..." }, ...]
//
// Examples:
//   node generate-sprites.js zombie "a shambling undead zombie, tattered burial clothes, green-grey skin"
//   node generate-sprites.js --file tools/enemy-requests.json

const fs = require('fs');
const path = require('path');
const { GoogleGenAI, Modality } = require('@google/genai');

const OUT_DIR = path.join(__dirname, '..', 'Assets', 'sprites');
const MODEL = 'gemini-3.1-flash-image'; // current non-preview model; the -preview variants are deprecated

// Keeps every generated sprite compatible with process-sprites.js's
// flood-fill-from-border chroma-key: it needs an actual solid white
// background reaching the image edges, not a transparent or scenic one.
const STYLE_PREFIX = 'A single 2D game character sprite in a clean pixel-art style, '
  + 'front-facing or three-quarter view, centered in frame, standing pose, '
  + 'clean black outline, vibrant flat-shaded colors, no drop shadow, '
  + 'no ground/floor under the feet, isolated on a plain solid pure-white background '
  + 'that extends to all four edges of the image. Subject: ';

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

async function generateOne(ai, name, prompt){
  const fullPrompt = STYLE_PREFIX + prompt;
  console.log(`[${name}] requesting...`);

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: fullPrompt,
    config: { responseModalities: [Modality.TEXT, Modality.IMAGE] }
  });

  const parts = response.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData);
  if(!imagePart){
    const textPart = parts.find(p => p.text);
    throw new Error(
      'No image came back' + (textPart ? ` — model said: "${textPart.text}"` : ' (empty response)')
    );
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(outPath, Buffer.from(imagePart.inlineData.data, 'base64'));
  console.log(`[${name}] -> Assets/sprites/${name}.png`);
}

async function main(){
  const apiKey = requireApiKey();
  const ai = new GoogleGenAI({ apiKey });

  const args = process.argv.slice(2);
  let requests;

  if(args[0] === '--file'){
    const filePath = args[1];
    if(!filePath){
      console.error('Usage: node generate-sprites.js --file <path-to-requests.json>');
      process.exit(1);
    }
    requests = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } else if(args.length >= 2){
    requests = [{ name: args[0], prompt: args.slice(1).join(' ') }];
  } else {
    console.error(
      'Usage:\n' +
      '  node generate-sprites.js <name> <prompt...>\n' +
      '  node generate-sprites.js --file <requests.json>   (array of {name, prompt})'
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

  console.log('\nDone. Review the new file(s) in Assets/sprites/, then run: npm run process-sprites');
}

main().catch(err => { console.error(err); process.exit(1); });
