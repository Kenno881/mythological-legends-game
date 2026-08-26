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

const SFX_BASE_GAIN = 0.35;

// Per-device volume preferences (2026-08-27, user request): four family
// members each bring their own device to the same table, and the
// generative background music (below) has no shared clock across devices —
// four independent copies running at once just becomes noise. These are
// multipliers (0-1) on top of the existing baseline gains, stored in
// localStorage so each device remembers its own mix. Read once at load;
// setSfxVolume/setMusicVolume (called from the sound-settings UI in
// main.js) update both the live gain node and the stored value.
function loadVolumePref(key){
  const raw = localStorage.getItem(key);
  const n = raw === null ? 1 : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}
let sfxVolume = loadVolumePref('camelotSfxVolume');
let musicVolume = loadVolumePref('camelotMusicVolume');

function setSfxVolume(v){
  sfxVolume = Math.max(0, Math.min(1, v));
  localStorage.setItem('camelotSfxVolume', String(sfxVolume));
  if(masterGain) masterGain.gain.value = SFX_BASE_GAIN * sfxVolume;
}
function getSfxVolume(){ return sfxVolume; }
function getMusicVolume(){ return musicVolume; }

function ensureAudioCtx(){
  if(audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if(!Ctx) return null;
  audioCtx = new Ctx();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = SFX_BASE_GAIN * sfxVolume;
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
  startMusic();
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

// ---------- BACKGROUND MUSIC ----------
// A small generative ambient loop, not a fixed recorded/composed clip — same
// "no external assets" constraint as the SFX above, and it means the score
// never repeats note-for-note the way one short looping bar would over a
// real 15-30 minute family session. D Dorian keeps it sounding old and
// heroic without tipping into a sad minor key — the same folk-fantasy mode
// a lot of real medieval-flavored music leans on. Runs on its own gain node
// (not routed through masterGain, which is the SFX bed) so a future
// music-only volume/mute control is a one-line addition, and so combat SFX
// always cuts through clearly over it rather than competing for the same
// headroom. Starts on the same first-gesture unlock the SFX context already
// waits for (browsers refuse to start any audio before one), plays
// continuously from the title screen onward — one score for the whole
// session rather than per-screen tracks, which would need state tracking
// this doesn't otherwise have any reason to carry.
let musicGain = null;
let musicStarted = false;
let musicSchedulerTimer = null;

const MUSIC_GAIN_LEVEL = 0.55; // the single knob to turn if it's too loud/quiet against SFX
const MUSIC_BPM = 88; // unhurried — ambient bed, not something to march to
const SEC_PER_BEAT = 60 / MUSIC_BPM;
const MUSIC_SCALE = [293.66, 329.63, 349.23, 392.00, 440.00, 493.88, 523.25]; // D4 Dorian, one octave
const MUSIC_ROOT = 146.83; // D3 — an octave below the melody line

let musicNextNoteTime = 0;
let musicBeatCount = 0;
let musicLastMelodyIdx = null;

function scheduleDrone(t0, dur){
  const ctx = ensureAudioCtx();
  [{ freq: MUSIC_ROOT, peak: 0.06 }, { freq: MUSIC_ROOT * 3 / 2, peak: 0.04 }].forEach(({ freq, peak })=>{
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 1.4);
    g.gain.setTargetAtTime(0.0001, t0 + dur - 1.4, 0.7);
    osc.connect(g); g.connect(musicGain);
    osc.start(t0); osc.stop(t0 + dur + 0.4);
  });
}

function scheduleBassPulse(t0){
  const ctx = ensureAudioCtx();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = MUSIC_ROOT;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.1, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + SEC_PER_BEAT * 0.9);
  osc.connect(g); g.connect(musicGain);
  osc.start(t0); osc.stop(t0 + SEC_PER_BEAT);
}

// A weighted random walk across the scale, not a fixed melody — small steps
// most of the time (reads as intentional phrasing), an occasional bigger
// leap so it doesn't feel like it's just idling on two adjacent notes.
function nextMelodyIdx(prevIdx){
  if(prevIdx === null) return Math.floor(MUSIC_SCALE.length / 2);
  const bigLeap = Math.random() < 0.3;
  const step = (Math.random() < 0.5 ? -1 : 1) * (bigLeap ? 2 : 1);
  return Math.max(0, Math.min(MUSIC_SCALE.length - 1, prevIdx + step));
}

function scheduleMelodyNote(t0){
  // Skipped more often than not — the gaps are what make this read as an
  // ambient bed instead of a busy tune fighting combat SFX for attention.
  if(Math.random() < 0.4) return;
  musicLastMelodyIdx = nextMelodyIdx(musicLastMelodyIdx);
  const ctx = ensureAudioCtx();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = MUSIC_SCALE[musicLastMelodyIdx];
  const dur = SEC_PER_BEAT * (Math.random() < 0.3 ? 2 : 1);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g); g.connect(musicGain);
  osc.start(t0); osc.stop(t0 + dur + 0.05);
}

// Standard Web Audio "look-ahead scheduler" pattern: a coarse setInterval
// tick just checks whether it's time to queue up the next beat's notes,
// with the actual note start times set precisely against audioCtx.currentTime
// — scheduling on the interval's own firing time directly would drift under
// tab-throttling the way a plain setInterval-driven note trigger would.
function musicSchedulerTick(){
  const ctx = ensureAudioCtx();
  if(!ctx) return;
  const lookahead = 0.15;
  while(musicNextNoteTime < ctx.currentTime + lookahead){
    if(musicBeatCount % 8 === 0) scheduleDrone(musicNextNoteTime, SEC_PER_BEAT * 8);
    if(musicBeatCount % 2 === 0) scheduleBassPulse(musicNextNoteTime);
    scheduleMelodyNote(musicNextNoteTime + SEC_PER_BEAT * 0.15);
    musicNextNoteTime += SEC_PER_BEAT;
    musicBeatCount++;
  }
}

function startMusic(){
  const ctx = ensureAudioCtx();
  if(!ctx || musicStarted) return;
  musicStarted = true;
  musicGain = ctx.createGain();
  musicGain.gain.value = MUSIC_GAIN_LEVEL * musicVolume;
  musicGain.connect(ctx.destination);
  musicNextNoteTime = ctx.currentTime + 0.1;
  musicBeatCount = 0;
  musicSchedulerTimer = setInterval(musicSchedulerTick, 100);
}

// Whichever of the two music systems is actually meant to be audible right
// now — the procedural generator (musicGain) normally, or a generated
// dungeon track (dungeonTrackGain) once one is playing (see
// "DUNGEON MUSIC" below). Volume changes and the visibility duck both need
// to act on this one specifically, not both at once, since the other is
// deliberately held silent.
function activeMusicGain(){
  return activeMusicIsDungeon ? dungeonTrackGain : musicGain;
}

function setMusicVolume(v){
  musicVolume = Math.max(0, Math.min(1, v));
  localStorage.setItem('camelotMusicVolume', String(musicVolume));
  const gainNode = activeMusicGain();
  if(gainNode){
    const ctx = ensureAudioCtx();
    // Matches the visibilitychange duck logic below — if the tab happens to
    // be hidden, stay silent rather than blip audible while backgrounded;
    // the next visibilitychange picks up this new musicVolume regardless.
    const target = document.hidden ? 0.0001 : MUSIC_GAIN_LEVEL * musicVolume;
    gainNode.gain.setTargetAtTime(target, ctx.currentTime, 0.15);
  }
}

// Duck to silent (not stop/restart — that would need re-deriving the beat
// schedule) whenever the tab isn't visible, so a backgrounded or
// screen-locked tablet isn't quietly running music nobody can hear.
document.addEventListener('visibilitychange', ()=>{
  const gainNode = activeMusicGain();
  if(!gainNode) return;
  const ctx = ensureAudioCtx();
  gainNode.gain.setTargetAtTime(document.hidden ? 0.0001 : MUSIC_GAIN_LEVEL * musicVolume, ctx.currentTime, 0.3);
});

// ---------- DUNGEON MUSIC (generated via tools/generate-music.js) ----------
// Real Lyria-3-generated tracks (Gemini API, one per dungeon) replace the
// procedural ambience above once the current dungeon's track has actually
// loaded — the generator stays running the whole time as the fallback, both
// for the title/login/character-select/dungeon-select screens (which never
// have a dungeon track to begin with) and for any dungeon whose track
// hasn't been generated yet or fails to fetch/decode. Nothing here ever
// stops musicGain's scheduler; it's only ever ducked to silent and back.
const DUNGEON_TRACK_SLUG = {
  "Sherwood Approach": "sherwood-approach",
  "The Sunken Chapel": "sunken-chapel",
  "Mordred's Keep": "mordreds-keep",
  "Avalon's Mist": "avalons-mist"
};
// Generation writes whatever extension the model actually returned (see
// generate-music.js's EXT_BY_MIME) — try the common ones in order rather
// than hardcoding one, so the client doesn't need to know which format a
// given track came back as.
const TRACK_EXTENSIONS = ['mp3', 'wav', 'ogg'];

let dungeonTrackGain = null;
let dungeonTrackSource = null;
let dungeonTrackLoopTimer = null;
let activeMusicIsDungeon = false;
let currentDungeonName = null;
const trackBufferPromises = new Map(); // slug -> Promise<AudioBuffer|null>, cached so a re-entered dungeon doesn't re-fetch

// Tries each known extension in turn; resolves null (not a rejection) if
// none exist or the audio fails to decode, so callers can just fall back
// to the procedural bed instead of handling an error.
async function fetchTrackBuffer(slug){
  const ctx = ensureAudioCtx();
  for(const ext of TRACK_EXTENSIONS){
    try {
      const res = await fetch(`/audio/music/${slug}.${ext}`);
      if(!res.ok) continue;
      const arrayBuffer = await res.arrayBuffer();
      return await ctx.decodeAudioData(arrayBuffer);
    } catch(err){ /* try the next extension */ }
  }
  console.warn(`[audio] no generated track for "${slug}" — staying on the procedural ambience`);
  return null;
}

function loadTrack(slug){
  if(!trackBufferPromises.has(slug)) trackBufferPromises.set(slug, fetchTrackBuffer(slug));
  return trackBufferPromises.get(slug);
}

// Loop point is disguised with a real crossfade (each clip fades in, plays
// full, fades out; the next clip's fade-in overlaps the current one's
// fade-out) rather than a hard cut — masks both the model's own loop seam
// and the fixed 30-second boundary lyria-3-clip-preview returns.
const TRACK_CROSSFADE_SEC = 1.5;

function scheduleTrackLoop(buffer, startAt){
  const ctx = ensureAudioCtx();
  const dur = buffer.duration;
  const fade = Math.min(TRACK_CROSSFADE_SEC, dur / 2);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const srcGain = ctx.createGain();
  srcGain.gain.setValueAtTime(0.0001, startAt);
  srcGain.gain.linearRampToValueAtTime(1, startAt + fade);
  srcGain.gain.setValueAtTime(1, startAt + dur - fade);
  srcGain.gain.linearRampToValueAtTime(0.0001, startAt + dur);
  src.connect(srcGain); srcGain.connect(dungeonTrackGain);
  src.start(startAt); src.stop(startAt + dur + 0.05);
  dungeonTrackSource = src;

  const nextStartAt = startAt + dur - fade;
  const delayMs = Math.max(0, (nextStartAt - ctx.currentTime) * 1000);
  dungeonTrackLoopTimer = setTimeout(()=> scheduleTrackLoop(buffer, nextStartAt), delayMs);
}

function playDungeonTrack(buffer){
  const ctx = ensureAudioCtx();
  if(!dungeonTrackGain){
    dungeonTrackGain = ctx.createGain();
    dungeonTrackGain.gain.value = 0.0001;
    dungeonTrackGain.connect(ctx.destination);
  }
  activeMusicIsDungeon = true;
  if(musicGain) musicGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.4);
  dungeonTrackGain.gain.setTargetAtTime(document.hidden ? 0.0001 : MUSIC_GAIN_LEVEL * musicVolume, ctx.currentTime, 0.6);
  scheduleTrackLoop(buffer, ctx.currentTime + 0.05);
}

function stopDungeonTrack(){
  activeMusicIsDungeon = false;
  if(dungeonTrackLoopTimer){ clearTimeout(dungeonTrackLoopTimer); dungeonTrackLoopTimer = null; }
  if(dungeonTrackSource){ try{ dungeonTrackSource.stop(); }catch(err){} dungeonTrackSource = null; }
  if(dungeonTrackGain){
    const ctx = ensureAudioCtx();
    dungeonTrackGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.4);
  }
  if(musicGain){
    const ctx = ensureAudioCtx();
    musicGain.gain.setTargetAtTime(document.hidden ? 0.0001 : MUSIC_GAIN_LEVEL * musicVolume, ctx.currentTime, 0.6);
  }
}

// Called on every state snapshot (onAudioState, below) and whenever the
// client leaves the game screen entirely (main.js's showScreen). A no-op
// on every snapshot after the first for the same dungeon — only reacts to
// dungeonName actually changing.
function syncDungeonMusic(dungeonName){
  if(dungeonName === currentDungeonName) return;
  currentDungeonName = dungeonName;
  const slug = dungeonName && DUNGEON_TRACK_SLUG[dungeonName];
  if(!slug){ stopDungeonTrack(); return; }
  loadTrack(slug).then(buffer=>{
    // The dungeon may have changed again (or the player may have left)
    // while this was in flight — don't resurrect a stale track.
    if(currentDungeonName !== dungeonName) return;
    if(buffer) playDungeonTrack(buffer);
    else stopDungeonTrack();
  });
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

  syncDungeonMusic(s.dungeonName);

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
