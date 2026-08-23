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

// How close to pure white (255,255,255) a pixel has to be to get keyed out.
// These are clean flat illustrations, not photos, so a fairly tight
// tolerance avoids eating into pale-but-colored parts of the art (e.g. a
// light blue helmet plume) while still catching JPEG-ish off-white noise.
const WHITE_THRESHOLD = 18;

// The source art is ~1200-2800px per side; on screen these draw at maybe
// 60-150px. Capping the longer edge keeps load size reasonable — this
// matters on the tablets-over-flaky-wifi this game is built for.
const MAX_DIMENSION = 400;

async function processOne(srcPath, outPath){
  const image = sharp(srcPath).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  for(let i = 0; i < data.length; i += channels){
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if(255 - r <= WHITE_THRESHOLD && 255 - g <= WHITE_THRESHOLD && 255 - b <= WHITE_THRESHOLD){
      data[i + 3] = 0;
    }
  }

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
