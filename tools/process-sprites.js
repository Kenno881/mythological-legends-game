"use strict";

// Batch sprite prep: chroma-keys near-white backgrounds to transparent, then
// trims each image down to the tight bounding box of what's left. Run this
// once per art drop — safe to re-run any time (it always reads from
// Assets/sprites and overwrites Assets/processed/sprites, never the
// other way).
//
// Usage: npm run process-sprites   (from this directory)

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC_DIR = path.join(__dirname, '..', 'Assets', 'sprites');
// Nested under Assets/ (not a sibling lowercase assets/) deliberately: this
// filesystem is case-insensitive, so "Assets" and "assets" collide into one
// real directory here — git would silently record output written to
// "assets/..." as "Assets/..." anyway. Doing it explicitly avoids a mismatch
// against server.js's static file path once this hits Railway's
// case-SENSITIVE Linux container, where that mismatch would 404 silently.
const OUT_DIR = path.join(__dirname, '..', 'Assets', 'processed', 'sprites');

// How close to pure white (255,255,255) a pixel has to be to count as
// background. Flood-filling from the border (see below) rather than keying
// every matching pixel globally means this can be reasonably generous
// without risking eating into enclosed light-colored art (a white robe, a
// pale helmet plume) — those survive because they're not connected to the
// edge, not because of exact color distance.
const WHITE_THRESHOLD = 30;

// The source art is ~1200-2800px per side; on screen these draw at maybe
// 60-150px. Capping the longer edge keeps load size reasonable — this
// matters on the tablets-over-flaky-wifi this game is built for.
const MAX_DIMENSION = 400;

// Keys out background by flood-filling from the image border rather than a
// global per-pixel threshold. A global threshold either misses off-white
// patches that are just outside tolerance (leaving opaque islands — this is
// what happened to the excalibur sword's corner) or, if loosened enough to
// catch them, risks eating enclosed light-colored parts of the art itself.
// Flood-fill sidesteps both: only background pixels *connected* to the edge
// get cleared, and an outlined silhouette (these all have one) naturally
// blocks the fill from leaking into the character/object itself.
function keyOutBackground(data, width, height, channels){
  const isBg = (idx)=>{
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    return (255 - r) <= WHITE_THRESHOLD && (255 - g) <= WHITE_THRESHOLD && (255 - b) <= WHITE_THRESHOLD;
  };

  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let qHead = 0, qTail = 0;

  function tryEnqueue(x, y){
    if(x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if(visited[p]) return;
    if(!isBg(p * channels)) return;
    visited[p] = 1;
    queue[qTail++] = p;
  }

  for(let x = 0; x < width; x++){ tryEnqueue(x, 0); tryEnqueue(x, height - 1); }
  for(let y = 0; y < height; y++){ tryEnqueue(0, y); tryEnqueue(width - 1, y); }

  while(qHead < qTail){
    const p = queue[qHead++];
    const x = p % width, y = (p / width) | 0;
    tryEnqueue(x + 1, y); tryEnqueue(x - 1, y); tryEnqueue(x, y + 1); tryEnqueue(x, y - 1);
  }

  for(let p = 0; p < width * height; p++){
    if(visited[p]) data[p * channels + 3] = 0;
  }
}

async function processOne(srcPath, outPath){
  const image = sharp(srcPath).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  keyOutBackground(data, width, height, channels);

  await sharp(data, { raw: { width, height, channels } })
    .trim() // crop to the bounding box of non-transparent content
    .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

async function main(){
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = fs.readdirSync(SRC_DIR).filter(f => f.toLowerCase().endsWith('.png'));
  if(files.length === 0){
    console.log(`No .png files found in ${SRC_DIR}`);
    return;
  }

  for(const file of files){
    const srcPath = path.join(SRC_DIR, file);
    const outPath = path.join(OUT_DIR, file.toLowerCase());
    await processOne(srcPath, outPath);
    const { size } = fs.statSync(outPath);
    console.log(`${file} -> Assets/processed/sprites/${file.toLowerCase()} (${(size / 1024).toFixed(0)} KB)`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
