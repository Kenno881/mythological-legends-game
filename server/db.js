"use strict";

// Persistence foundation (MASTER_DESIGN.md §11/§12 Phase 2). Started out on
// better-sqlite3, but its native binary failed to build on Railway's
// Nixpacks image (works fine locally on Node 22 — Railway's build is on
// Node 18, and the native module has no matching prebuilt binary there, so
// it falls back to compiling from source and fails). Rather than fight
// Node-version/toolchain pinning for a dependency this project doesn't
// actually need the power of, this is a plain JSON file — no relational
// queries happen anywhere here, just keyed lookups and counters, and at
// ~4 players (§2 pillar 3: family-scale, not internet-scale) a full-file
// rewrite on every write is trivially cheap. Removes the native-build
// failure mode entirely rather than working around it.
//
// DB_PATH points at a file on a Railway persistent volume in production
// (set DB_PATH in Railway's Variables tab to the volume's mount path, e.g.
// "/data/camelot.json" — attaching the volume itself is a Railway dashboard
// action, not something this code can do). Falls back to a local file
// under server/data/ for dev, gitignored since it's throwaway local state.
//
// Scope note: this covers what's actually simulated by server.js today —
// lifetime kill/death counts (survive both reconnects and a "new character"
// after death — see recordKill/recordDeath below) and per-dungeon best clear
// times. `level`/`xp`/`equipment` fields exist because MASTER_DESIGN.md
// §11's schema names them, but nothing writes to them yet since in-run
// leveling is Phase 3, not built. Same for family currency/unlocks: the
// row and helper exist (addFamilyCurrency) but nothing calls it yet — no
// currency-earning mechanic exists in server.js today, and inventing one
// wasn't part of this phase. Gear stays exactly as it works today (flat
// gearTier, reset to 0 on a fresh join after death) — not touched here,
// since changing that would be a gameplay/balance call, not infrastructure.

const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'camelot.json');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

function defaultState(){
  return { players: {}, bestTimes: {}, family: { currency: 0, unlocks: [] } };
}

function load(){
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (err) {
    if(err.code !== 'ENOENT') console.error('[db] failed to read/parse DB file, starting fresh:', err.message);
    return defaultState();
  }
}

let state = load();

// Write to a temp file then rename over the real one — an atomic swap on
// both POSIX and Windows, so a process kill mid-write (Railway sends
// SIGTERM on redeploy) can never leave a half-written, corrupt JSON file.
function persist(){
  const tmpPath = DB_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(state));
  fs.renameSync(tmpPath, DB_PATH);
}

// Called on every new WebSocket connection (server.js), before 'join' is
// handled — read-on-connect. Creates the row on this playerId's first-ever
// connection; otherwise just bumps lastSeenAt. Returns the persisted row
// (or null for a brand new id, which has no history to restore).
function touchOrCreatePlayer(id, fallbackName){
  const now = Date.now();
  const existing = state.players[id];
  if(existing){
    existing.lastSeenAt = now;
    persist();
    return existing;
  }
  state.players[id] = {
    name: fallbackName || null, level: 1, xp: 0,
    totalKills: 0, totalDeaths: 0, equipment: null,
    createdAt: now, lastSeenAt: now
  };
  persist();
  return null;
}

// Called from the 'join' handler once the in-memory player object exists —
// restores lifetime stats that must survive both a server restart and a
// fresh character after death (kills/deaths are framed as "how many ever",
// not per-character session stats).
function loadPlayerStats(id){
  const row = state.players[id];
  if(!row) return { totalKills: 0, totalDeaths: 0 };
  return { totalKills: row.totalKills, totalDeaths: row.totalDeaths };
}

// Write-on-key-event / write-on-disconnect — both just persist whatever the
// in-memory player object currently holds.
function savePlayerStats(player){
  const row = state.players[player.id] || (state.players[player.id] = {
    level: 1, xp: 0, equipment: null, createdAt: Date.now()
  });
  row.name = player.name;
  row.totalKills = player.totalKills;
  row.totalDeaths = player.totalDeaths;
  row.lastSeenAt = Date.now();
  persist();
}

// Only overwrites if this run beat (or set) the record for that dungeon.
function recordDungeonClear(dungeonName, seconds){
  const existing = state.bestTimes[dungeonName];
  if(existing && existing.seconds <= seconds) return;
  state.bestTimes[dungeonName] = { seconds, achievedAt: Date.now() };
  persist();
}

function getFamilyState(){
  return { currency: state.family.currency, unlocks: state.family.unlocks.slice() };
}

// Not called anywhere yet — no in-game currency-earning event exists.
// Here so Phase 3/5 has a ready primitive instead of hand-rolling file I/O
// then.
function addFamilyCurrency(amount){
  state.family.currency += amount;
  persist();
}

module.exports = {
  touchOrCreatePlayer, loadPlayerStats, savePlayerStats,
  recordDungeonClear, getFamilyState, addFamilyCurrency
};
