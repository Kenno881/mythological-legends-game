"use strict";

// Fully synthesized sound effects via the Web Audio API — no external audio
// files. The server only ever broadcasts full state snapshots (net.js),
// never a discrete event log, so "a hit just landed" or "an ability just
// fired" has to be detected here by diffing each snapshot against the
// previous one: hp dropping, a cooldown jumping back up to its max (meaning
// the ability just fired), a boss's slamState flipping to 'telegraph', or
// victory/dead flipping true.

let audioCtx = null;
let masterGain = null;

function ensureAudioCtx(){
  if(audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if(!Ctx) return null;
  audioCtx = new Ctx();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.35;
  masterGain.connect(audioCtx.destination);
  return audioCtx;
}

// Browsers refuse to start audio before a user gesture. Unlock (and resume,
// in case it came up suspended) on the very first click/keypress anywhere
// on the page, then get out of the way — this fires well before any
// gameplay sound is needed (the passphrase screen alone guarantees a click).
function unlockAudioOnce(){
  const ctx = ensureAudioCtx();
  if(ctx && ctx.state === 'suspended') ctx.resume();
  window.removeEventListener('pointerdown', unlockAudioOnce);
  window.removeEventListener('keydown', unlockAudioOnce);
}
window.addEventListener('pointerdown', unlockAudioOnce);
window.addEventListener('keydown', unlockAudioOnce);

// ---------- SYNTH PRIMITIVES ----------
function tone(freq, { type = 'sine', dur = 0.15, gain = 0.5, freqEnd = null, delay = 0 } = {}){
  const ctx = ensureAudioCtx();
  if(!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if(freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
  // Exponential ramps can't target 0 directly, so envelopes bottom out at a
  // near-silent floor instead of a hard cutoff (which would click).
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g); g.connect(masterGain);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}

function noiseBurst({ dur = 0.09, gain = 0.4, delay = 0 } = {}){
  const ctx = ensureAudioCtx();
  if(!ctx) return;
  const t0 = ctx.currentTime + delay;
  const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for(let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass'; filt.frequency.value = 2200;
  src.connect(filt); filt.connect(g); g.connect(masterGain);
  src.start(t0); src.stop(t0 + dur);
}

// ---------- SOUND EFFECTS ----------
function sfxMonsterHit(){
  noiseBurst({ dur: 0.07, gain: 0.35 });
  tone(180, { type: 'triangle', dur: 0.08, gain: 0.3, freqEnd: 90 });
}

function sfxPlayerHurt(){
  noiseBurst({ dur: 0.11, gain: 0.4 });
  tone(140, { type: 'sawtooth', dur: 0.22, gain: 0.35, freqEnd: 60 });
}

function sfxCastPhysical(){ // Shield Bash
  noiseBurst({ dur: 0.1, gain: 0.3 });
  tone(220, { type: 'square', dur: 0.14, gain: 0.3, freqEnd: 110 });
}
function sfxCastParry(){ // metallic ting
  tone(1100, { type: 'triangle', dur: 0.18, gain: 0.3, freqEnd: 1500 });
  tone(1650, { type: 'sine', dur: 0.12, gain: 0.15, delay: 0.02 });
}
function sfxCastTaunt(){ // low horn blare
  tone(150, { type: 'sawtooth', dur: 0.4, gain: 0.28, freqEnd: 130 });
}
function sfxCastArcane(){ // rising-then-falling zap
  tone(300, { type: 'sine', dur: 0.28, gain: 0.32, freqEnd: 900 });
  tone(900, { type: 'sine', dur: 0.16, gain: 0.2, delay: 0.14, freqEnd: 200 });
}
function sfxCastHeal(){ // soft ascending chime
  tone(520, { type: 'sine', dur: 0.22, gain: 0.25 });
  tone(660, { type: 'sine', dur: 0.22, gain: 0.22, delay: 0.08 });
  tone(880, { type: 'sine', dur: 0.3, gain: 0.2, delay: 0.16 });
}
function sfxCastGeneric(){
  tone(400, { type: 'triangle', dur: 0.16, gain: 0.3, freqEnd: 700 });
}
function sfxCastMesmerize(){ // soft, sparkly, descending — puts something "to sleep"
  tone(1200, { type: 'sine', dur: 0.35, gain: 0.22, freqEnd: 500 });
  tone(1800, { type: 'sine', dur: 0.25, gain: 0.14, delay: 0.06, freqEnd: 700 });
}
function sfxCastHaste(){ // quick energetic upward whoosh
  tone(500, { type: 'sawtooth', dur: 0.22, gain: 0.22, freqEnd: 1400 });
  tone(700, { type: 'triangle', dur: 0.18, gain: 0.18, delay: 0.05, freqEnd: 1600 });
}

// Keyed by ability display name (CLASSES[...].special1/2.name) so each
// class's abilities get a flavor matching what they actually do, rather
// than one generic "cast" blip for everything.
const CAST_SFX_BY_ABILITY = {
  "Shield Bash": sfxCastPhysical,
  "Parry": sfxCastParry,
  "Taunt": sfxCastTaunt,
  "Arcane Nova": sfxCastArcane,
  "Healing Light": sfxCastHeal,
  "Blessing": sfxCastHeal,
  "Mesmerize": sfxCastMesmerize,
  "Group Haste": sfxCastHaste
};

function sfxSlamTelegraph(){
  tone(90, { type: 'sawtooth', dur: 0.9, gain: 0.4, freqEnd: 220 });
  tone(45, { type: 'sine', dur: 0.9, gain: 0.3, freqEnd: 110, delay: 0.05 });
}

function sfxVictory(){
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i)=>
    tone(f, { type: 'triangle', dur: 0.5, gain: 0.3, delay: i * 0.13 }));
}

function sfxDefeat(){
  [392, 349.23, 293.66, 261.63].forEach((f, i)=>
    tone(f, { type: 'sine', dur: 0.6, gain: 0.28, delay: i * 0.2 }));
}

// ---------- STATE DIFFING ----------
// Each map is fully rebuilt every call from the current snapshot, so ids
// that vanish (room change gives monsters fresh ids; a dead player's old id
// just stops appearing until they rejoin) fall out on their own — nothing
// here needs explicit cleanup.
let prevPlayerHp = new Map();
let prevPlayerCds = new Map();
let prevMonsterHp = new Map();
let prevMonsterSlam = new Map();
let victoryFired = false;
let defeatFired = false;

const HP_EPSILON = 0.01;
const CD_EPSILON = 0.05; // cooldowns only ever count down on their own; a jump this big means an ability just fired

function onAudioState(s){
  if(!ensureAudioCtx()) return;

  // Multiple hits can land in the same 50ms tick (an AoE nova, a slam
  // hitting three players at once) — collapse each category to at most one
  // sound per snapshot rather than stacking/clipping.
  let monsterHit = false;
  const nextMonsterHp = new Map();
  s.monsters.forEach(mon=>{
    nextMonsterHp.set(mon.id, mon.hp);
    const prev = prevMonsterHp.get(mon.id);
    if(prev !== undefined && mon.hp < prev - HP_EPSILON) monsterHit = true;
  });
  prevMonsterHp = nextMonsterHp;
  if(monsterHit) sfxMonsterHit();

  let slamStarted = false;
  const nextMonsterSlam = new Map();
  s.monsters.forEach(mon=>{
    nextMonsterSlam.set(mon.id, mon.slamState);
    const prev = prevMonsterSlam.get(mon.id);
    if(mon.slamState === 'telegraph' && prev !== 'telegraph') slamStarted = true;
  });
  prevMonsterSlam = nextMonsterSlam;
  if(slamStarted) sfxSlamTelegraph();

  let playerHurt = false;
  const nextPlayerHp = new Map();
  const nextPlayerCds = new Map();
  s.players.forEach(p=>{
    nextPlayerHp.set(p.id, p.hp);
    const prevHp = prevPlayerHp.get(p.id);
    if(prevHp !== undefined && p.hp < prevHp - HP_EPSILON) playerHurt = true;

    const c = CLASSES[p.classKey];
    const prevCds = prevPlayerCds.get(p.id) || {};
    ['special1', 'special2'].forEach(key=>{
      if(!c[key]) return;
      const prevCd = prevCds[key];
      const curCd = p.cds[key];
      if(prevCd !== undefined && curCd > prevCd + CD_EPSILON){
        (CAST_SFX_BY_ABILITY[c[key].name] || sfxCastGeneric)();
      }
    });
    nextPlayerCds.set(p.id, { special1: p.cds.special1, special2: p.cds.special2 });
  });
  prevPlayerHp = nextPlayerHp;
  prevPlayerCds = nextPlayerCds;
  if(playerHurt) sfxPlayerHurt();

  // Campaign victory (server.js's dungeonSummary.campaignVictory — true
  // only on the boss kill that completes all 4 Arc I dungeons for the
  // first time) replaced the old persistent s.victory flag now that
  // dungeons stay replayable instead of the game just ending.
  const campaignVictory = !!(s.dungeonSummary && s.dungeonSummary.campaignVictory);
  if(campaignVictory && !victoryFired){ victoryFired = true; sfxVictory(); }
  if(!campaignVictory) victoryFired = false;

  const me = s.players.find(p => p.id === myId);
  if(me && me.dead && !defeatFired){ defeatFired = true; sfxDefeat(); }
  if(me && !me.dead) defeatFired = false;
}
