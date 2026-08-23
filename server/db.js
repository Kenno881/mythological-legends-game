"use strict";

// Persistence foundation (MASTER_DESIGN.md §11/§12 Phase 2). SQLite chosen
// over a managed Postgres service — this is a ~4-player family game, not
// internet-scale (§2 pillar 3), so a single-file embedded DB is plenty and
// avoids running/paying for a separate database service.
//
// DB_PATH points at a file on a Railway persistent volume in production
// (set DB_PATH in Railway's Variables tab to the volume's mount path, e.g.
// "/data/camelot.db" — attaching the volume itself is a Railway dashboard
// action, not something this code can do). Falls back to a local file
// under server/data/ for dev, gitignored since it's throwaway local state.
//
// Scope note: this covers what's actually simulated by server.js today —
// lifetime kill/death counts (survive both reconnects and a "new character"
// after death — see recordKill/recordDeath below) and per-dungeon best clear
// times. `level`/`xp` columns exist because MASTER_DESIGN.md §11's schema
// names them, but nothing writes to them yet since in-run leveling is
// Phase 3, not built. Same for family currency/unlocks: the row and helper
// exist (addFamilyCurrency) but nothing calls it yet — no currency-earning
// mechanic exists in server.js today, and inventing one wasn't part of this
// phase. Gear stays exactly as it works today (flat gearTier, reset to 0 on
// a fresh join after death) — not touched here, since changing that would
// be a gameplay/balance call, not infrastructure.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'camelot.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // safer under a hard process kill (Railway redeploys send SIGTERM, not always graceful)

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,           -- the client's persistent playerId (net.js's PLAYER_ID)
    name TEXT,
    level INTEGER DEFAULT 1,       -- unused until Phase 3's leveling system exists
    xp INTEGER DEFAULT 0,          -- unused until Phase 3
    total_kills INTEGER NOT NULL DEFAULT 0,
    total_deaths INTEGER NOT NULL DEFAULT 0,
    equipment_json TEXT,           -- reserved for Phase 4's three-slot gear (§7); NULL until then
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS best_times (
    dungeon_name TEXT PRIMARY KEY,
    seconds REAL NOT NULL,
    achieved_at INTEGER NOT NULL
  );

  -- Single-row table (id is always 1) — currency/unlocks are a shared
  -- family pool (§11, decided), not per-player, so there's exactly one of
  -- these rather than one per playerId.
  CREATE TABLE IF NOT EXISTS family_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    currency INTEGER NOT NULL DEFAULT 0,
    unlocks_json TEXT NOT NULL DEFAULT '[]'
  );
  INSERT OR IGNORE INTO family_state (id, currency, unlocks_json) VALUES (1, 0, '[]');
`);

const stmts = {
  getPlayer: db.prepare('SELECT * FROM players WHERE id = ?'),
  insertPlayer: db.prepare(`
    INSERT INTO players (id, name, created_at, last_seen_at)
    VALUES (@id, @name, @now, @now)
  `),
  touchPlayer: db.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?'),
  savePlayerStats: db.prepare(`
    UPDATE players SET name = ?, total_kills = ?, total_deaths = ?, last_seen_at = ?
    WHERE id = ?
  `),
  bestTime: db.prepare('SELECT seconds FROM best_times WHERE dungeon_name = ?'),
  upsertBestTime: db.prepare(`
    INSERT INTO best_times (dungeon_name, seconds, achieved_at) VALUES (?, ?, ?)
    ON CONFLICT(dungeon_name) DO UPDATE SET seconds = excluded.seconds, achieved_at = excluded.achieved_at
  `),
  getFamilyState: db.prepare('SELECT currency, unlocks_json FROM family_state WHERE id = 1'),
  addCurrency: db.prepare('UPDATE family_state SET currency = currency + ? WHERE id = 1')
};

// Called on every new WebSocket connection (server.js), before 'join' is
// handled — read-on-connect. Creates the row on this playerId's first-ever
// connection; otherwise just bumps last_seen_at. Returns the persisted row
// (or null for a brand new id, which has no history to restore).
function touchOrCreatePlayer(id, fallbackName){
  const existing = stmts.getPlayer.get(id);
  const now = Date.now();
  if(existing){
    stmts.touchPlayer.run(now, id);
    return existing;
  }
  stmts.insertPlayer.run({ id, name: fallbackName || null, now });
  return null;
}

// Called from the 'join' handler once the in-memory player object exists —
// restores lifetime stats that must survive both a server restart and a
// fresh character after death (kills/deaths are framed as "how many ever",
// not per-character session stats).
function loadPlayerStats(id){
  const row = stmts.getPlayer.get(id);
  if(!row) return { totalKills: 0, totalDeaths: 0 };
  return { totalKills: row.total_kills, totalDeaths: row.total_deaths };
}

// Write-on-key-event / write-on-disconnect — both just persist whatever the
// in-memory player object currently holds.
function savePlayerStats(player){
  stmts.savePlayerStats.run(player.name, player.totalKills, player.totalDeaths, Date.now(), player.id);
}

// Only overwrites if this run beat (or set) the record for that dungeon.
function recordDungeonClear(dungeonName, seconds){
  const existing = stmts.bestTime.get(dungeonName);
  if(existing && existing.seconds <= seconds) return;
  stmts.upsertBestTime.run(dungeonName, seconds, Date.now());
}

function getFamilyState(){
  const row = stmts.getFamilyState.get();
  return { currency: row.currency, unlocks: JSON.parse(row.unlocks_json) };
}

// Not called anywhere yet — no in-game currency-earning event exists.
// Here so Phase 3/5 has a ready primitive instead of writing raw SQL then.
function addFamilyCurrency(amount){
  stmts.addCurrency.run(amount);
}

module.exports = {
  touchOrCreatePlayer, loadPlayerStats, savePlayerStats,
  recordDungeonClear, getFamilyState, addFamilyCurrency
};
