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
// Every write is wrapped so a persistence failure (bad mount, permissions,
// full disk) can never take down the actual game for the family — it logs
// loudly to stderr (visible in Railway's Deploy Logs) and the in-memory
// game state carries on exactly as it did before this file existed. Also
// runs a startup self-test that logs a clear PASS/FAIL for the resolved
// DB_PATH, so a bad mount shows up in the logs immediately instead of as
// silent "nothing ever gets written".
//
// Scope note: this covers what's actually simulated by server.js today —
// lifetime kill/death counts (survive both reconnects and a "new character"
// after death — see recordKill/recordDeath below) and per-dungeon best clear
// times. `level`/`xp`/`equipment` fields exist because MASTER_DESIGN.md
// §11's schema names them, but nothing writes to them yet since in-run
// leveling is Phase 3, not built. Same for family currency/unlocks: the
// row and helper exist (addFamilyCurrency) but nothing calls it yet — no
// currency-earning mechanic exists in server.js today, and inventing one
// wasn't part of this phase. Gear (`equipment`) is real now (2026-08-24,
// MASTER_DESIGN.md §7's three-slot system) — `{weaponTier, armorTier,
// artifacts}`, account-wide like kills/deaths, not per saved character.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'camelot.json');
console.log(`[db] DB_PATH resolved to: ${DB_PATH}`);

function defaultState(){
  return { players: {}, accounts: {}, bestTimes: {}, family: { currency: 0, unlocks: [], dungeonsCleared: [] } };
}

let state = defaultState();

try {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  state = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  if(!state.accounts) state.accounts = {}; // back-compat: DB files written before accounts existed
  // back-compat: DB files written before dungeon-select existed had no
  // dungeonsCleared list — every dungeon would otherwise look "not yet
  // cleared" and wrongly re-impose the full-family gate on things the
  // family had already beaten.
  if(!state.family) state.family = { currency: 0, unlocks: [], dungeonsCleared: [] };
  if(!state.family.dungeonsCleared) state.family.dungeonsCleared = [];
  // back-compat: DB files written before the three-slot gear system
  // existed have `equipment: null` (or nothing) — normalize every player
  // row to the new shape so loadPlayerStats/savePlayerStats never have to
  // guard against a missing/old-shape equipment field themselves.
  for(const id in state.players){
    const row = state.players[id];
    if(!row.equipment || typeof row.equipment !== 'object'){
      row.equipment = { weaponTier: 0, armorTier: 0, artifacts: [] };
    } else {
      if(typeof row.equipment.weaponTier !== 'number') row.equipment.weaponTier = 0;
      if(typeof row.equipment.armorTier !== 'number') row.equipment.armorTier = 0;
      if(!Array.isArray(row.equipment.artifacts)) row.equipment.artifacts = [];
    }
  }
  // back-compat: accounts written before the character roster existed had
  // a single permanent `classKey` — fold it into a one-item roster instead
  // of losing it (gender unknown for anything created before gender existed).
  for(const id in state.accounts){
    const acct = state.accounts[id];
    if(!acct.characters){
      acct.characters = acct.classKey
        ? [{ id: 'char_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), classKey: acct.classKey, gender: null, createdAt: acct.createdAt || Date.now() }]
        : [];
      delete acct.classKey;
    }
    // back-compat: characters saved before per-character leveling existed
    // (MASTER_DESIGN.md §10, reconciled 2026-08-26 from Phase 3's original
    // account-wide leveling onto per-character) have no level/xp at all —
    // including any leveled up on the account-wide system this replaces,
    // which has no sensible per-character value to migrate into, so those
    // start fresh at 1.
    for(const ch of acct.characters){
      if(typeof ch.level !== 'number') ch.level = 1;
      if(typeof ch.xp !== 'number') ch.xp = 0;
    }
  }
  console.log(`[db] loaded existing state (${Object.keys(state.players || {}).length} known players)`);
} catch (err) {
  if(err.code === 'ENOENT'){
    console.log('[db] no existing DB file yet — starting fresh (expected on first-ever boot)');
  } else {
    console.error(`[db] failed to load ${DB_PATH}, starting fresh in memory only:`, err.message);
  }
}

// Startup self-test: prove the resolved path is actually writable right
// now, rather than finding out the hard way on the first real game event.
(function selfTest(){
  const probePath = DB_PATH + '.selftest';
  try {
    fs.writeFileSync(probePath, 'ok');
    fs.unlinkSync(probePath);
    console.log('[db] startup write test: PASS — persistence should work');
  } catch (err) {
    console.error(`[db] startup write test: FAIL (${err.code}) — ${err.message}`);
    console.error('[db] persistence is DISABLED for this run; the game will play fine, nothing will survive a restart. Check the Railway volume is actually mounted and writable at this path.');
  }
})();

// Write to a temp file then rename over the real one — an atomic swap on
// both POSIX and Windows, so a process kill mid-write (Railway sends
// SIGTERM on redeploy) can never leave a half-written, corrupt JSON file.
// Never throws — logs and gives up on THIS write, leaving in-memory state
// (and gameplay) completely unaffected.
function persist(){
  const tmpPath = DB_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(state));
    fs.renameSync(tmpPath, DB_PATH);
  } catch (err) {
    console.error(`[db] write failed (${err.code}):`, err.message);
  }
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
    totalKills: 0, totalDeaths: 0,
    equipment: { weaponTier: 0, armorTier: 0, artifacts: [] },
    createdAt: now, lastSeenAt: now
  };
  persist();
  return null;
}

// Called from the 'join' handler once the in-memory player object exists —
// restores lifetime stats that must survive both a server restart and a
// fresh character after death (kills/deaths, and now gear, are framed as
// "how many ever" / "whatever's equipped," account-wide — not per saved
// character, matching kills/deaths' existing precedent). weaponTier/
// armorTier/artifacts are flattened directly onto the returned object,
// same as totalKills/totalDeaths, since server.js's join handler spreads
// this straight onto the runtime player (`...db.loadPlayerStats(id)`).
function loadPlayerStats(id){
  const row = state.players[id];
  if(!row) return { totalKills: 0, totalDeaths: 0, weaponTier: 0, armorTier: 0, artifacts: [] };
  const eq = row.equipment || { weaponTier: 0, armorTier: 0, artifacts: [] };
  return {
    totalKills: row.totalKills, totalDeaths: row.totalDeaths,
    weaponTier: eq.weaponTier, armorTier: eq.armorTier, artifacts: eq.artifacts.slice()
  };
}

// Write-on-key-event / write-on-disconnect — both just persist whatever the
// in-memory player object currently holds. Called on every gear pickup
// (server.js's applyLootPickup) as well as kills/deaths, same "persist
// immediately, it's cheap at family scale" pattern as everything else here.
function savePlayerStats(player){
  const row = state.players[player.id] || (state.players[player.id] = {
    level: 1, xp: 0, equipment: { weaponTier: 0, armorTier: 0, artifacts: [] }, createdAt: Date.now()
  });
  row.name = player.name;
  row.totalKills = player.totalKills;
  row.totalDeaths = player.totalDeaths;
  row.equipment = {
    weaponTier: player.weaponTier || 0,
    armorTier: player.armorTier || 0,
    artifacts: player.artifacts || []
  };
  row.lastSeenAt = Date.now();
  persist();
}

// Only overwrites the best time if this run beat (or set) the record for
// that dungeon — but always marks the dungeon cleared (server.js's
// dungeon-select gate reads dungeonsCleared to decide whether the
// full-family requirement still applies to a given dungeon; recording a
// clear and marking it cleared are the same event, so one function does
// both rather than needing a parallel call site everywhere this fires).
function recordDungeonClear(dungeonName, seconds){
  const existing = state.bestTimes[dungeonName];
  if(!existing || existing.seconds > seconds){
    state.bestTimes[dungeonName] = { seconds, achievedAt: Date.now() };
  }
  if(!state.family.dungeonsCleared.includes(dungeonName)){
    state.family.dungeonsCleared.push(dungeonName);
  }
  persist(); // always — dungeonsCleared can change even when the time doesn't beat the record
}

// ---------- ACCOUNTS (MASTER_DESIGN.md §8a) ----------
// PIN hashing uses Node's built-in crypto (scrypt), deliberately not a
// native module like bcrypt — that's exactly the class of bug that broke
// the Railway build earlier (better-sqlite3, see the top of this file).
function hashPin(pin, salt){
  return crypto.scryptSync(pin, salt, 64).toString('hex');
}

// Which of the 5 reserved account ids this actually is (display name,
// whether it's the test account, exempt from the family party gate) is
// server.js's concern —
// this file only stores/verifies credentials and the permanent class
// choice, keyed by the same lowercased id server.js already validated
// against its reserved-name list.
function verifyOrClaimPin(id, pin){
  let acct = state.accounts[id];
  if(!acct){
    acct = state.accounts[id] = { pinHash: null, pinSalt: null, characters: [], createdAt: Date.now() };
  }
  if(!acct.pinHash){
    // First-ever login for this account — the submitted PIN becomes its PIN.
    const salt = crypto.randomBytes(16).toString('hex');
    acct.pinSalt = salt;
    acct.pinHash = hashPin(pin, salt);
    acct.lastSeenAt = Date.now();
    persist();
    return { ok: true, isNewClaim: true };
  }
  const candidate = Buffer.from(hashPin(pin, acct.pinSalt), 'hex');
  const stored = Buffer.from(acct.pinHash, 'hex');
  const match = candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
  if(!match) return { ok: false, reason: 'wrong_pin' };
  acct.lastSeenAt = Date.now();
  persist();
  return { ok: true, isNewClaim: false };
}

// ---------- CHARACTER ROSTER ----------
// Up to 4 saved characters per account, picked fresh at the start of
// each run rather than one permanent class forever — see js/main.js's
// character-select screen. `gender` is nullable: unset until the player
// actually picks one, and unset for characters migrated from before
// gender existed at all (see the back-compat loop above).
const MAX_CHARACTERS = 4;

function getCharacters(id){
  const acct = state.accounts[id];
  return acct ? acct.characters.slice() : [];
}

function getCharacter(id, characterId){
  const acct = state.accounts[id];
  if(!acct) return null;
  return acct.characters.find(c => c.id === characterId) || null;
}

function createCharacter(id, classKey, gender){
  const acct = state.accounts[id] || (state.accounts[id] = { pinHash: null, pinSalt: null, characters: [], createdAt: Date.now() });
  if(acct.characters.length >= MAX_CHARACTERS) return { ok: false, reason: 'roster_full' };
  const character = {
    id: 'char_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    classKey, gender: gender || null, createdAt: Date.now(),
    level: 1, xp: 0 // per-character, not account-wide — MASTER_DESIGN.md §10/Phase 3
  };
  acct.characters.push(character);
  persist();
  return { ok: true, character };
}

// Called by server.js's grantXp() on every XP grant (write-on-key-event,
// same pattern as savePlayerStats/recordDungeonClear elsewhere in this
// file) — per-character, deliberately not folded into savePlayerStats/the
// account-wide `players` row. Level/xp live on the roster entry itself so
// each of an account's up to 4 saved characters progresses independently.
function saveCharacterProgress(accountId, characterId, level, xp){
  const acct = state.accounts[accountId];
  if(!acct) return;
  const character = acct.characters.find(c => c.id === characterId);
  if(!character) return;
  character.level = level;
  character.xp = xp;
  persist();
}

function deleteCharacter(id, characterId){
  const acct = state.accounts[id];
  if(!acct) return false;
  const before = acct.characters.length;
  acct.characters = acct.characters.filter(c => c.id !== characterId);
  if(acct.characters.length === before) return false; // nothing matched — not an error, just a no-op
  persist();
  return true;
}

function getFamilyState(){
  return {
    currency: state.family.currency,
    unlocks: state.family.unlocks.slice(),
    dungeonsCleared: state.family.dungeonsCleared.slice()
  };
}

// Called by server.js's onBossDefeated() — the first in-game event that
// actually earns currency (Sherwood Approach's boss-clear reward, added
// alongside the rest of §12 Phase 5's ready-but-unused primitives; no
// spend destination exists yet).
function addFamilyCurrency(amount){
  state.family.currency += amount;
  persist();
}

module.exports = {
  touchOrCreatePlayer, loadPlayerStats, savePlayerStats,
  recordDungeonClear, getFamilyState, addFamilyCurrency,
  verifyOrClaimPin, getCharacters, getCharacter, createCharacter, deleteCharacter,
  saveCharacterProgress
};
