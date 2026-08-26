"use strict";

// Authoritative multiplayer server for Quest for Camelot.
// Holds the true game state and simulates it on a fixed tick, broadcasting
// each dungeon instance's state to only the clients currently inside it.
// The client never moves itself — it sends input, the server moves the
// player, the client just renders wherever the server says it is.
// Run with: npm start   (from this directory)
//
// Message protocol (JSON; kept small and explicit, no binary framing yet):
//   Connection URL: wss://host?passphrase=...&playerId=...
//     playerId, if present, must be one of the 5 reserved account ids
//     (ACCOUNTS below) — set by the client only after a successful login,
//     remembered in localStorage so a known device skips login on future
//     connects. Omitted (or an unrecognized value) on a device that's
//     never logged in — the connection is accepted but held pending until
//     a "login" message succeeds. See ACCOUNTS/LOGIN below.
//   Client -> Server
//     {type:"login", username, pin}       only while the connection is pending (no id yet)
//     {type:"createCharacter", classKey, gender}   add a saved character (max 4 — §8a roster)
//     {type:"deleteCharacter", characterId}        free up a roster slot
//     {type:"join", characterId, dungeonIndex}     play one of this account's saved characters
//                                          in the given dungeon (see INSTANCES below) — refused
//                                          if this account is already active in some instance
//                                          (leave or returnToDungeonSelect first)
//     {type:"returnToDungeonSelect"}      leave the current instance without logging out —
//                                          same connection, back to picking a dungeon
//     {type:"leaveDungeon"}               log this account's character out cleanly back to
//                                          title, without disturbing other connected players
//     {type:"input", keys:{up,down,left,right}, action:null|"special1"|"special2"}
//                                          basic attack is automatic now (see AUTO-ATTACK below) —
//                                          there is no "attack" action anymore
//   Server -> Client
//     {type:"loginResult", ok, accountId?, isNewClaim?, reason?}   reply to "login"
//     {type:"characterList", characters:[...], error?}   reply to create/deleteCharacter
//     {type:"welcome", id, roomId, resuming, characters:[...], isTest, dungeonsCleared}
//                                          once, right after identity is established. roomId is
//                                          null unless resuming (still active inside a live
//                                          instance from before a reconnect)
//     {type:"leftDungeon"}                reply to "leaveDungeon"
//     {type:"leftInstance", dungeonsCleared}   reply to "returnToDungeonSelect"
//     {type:"state", tick, players:[...], monsters:[...], projectiles:[...], loot:[...],
//                     roomId, dungeonName, boss, safe, safeExit:{x,y,r}, wave:{killsSoFar,killTarget}|null,
//                     family:{currency,unlocks}, dungeonsCleared, dungeonSummary, waitingForFamily}
//                     every tick (20/s), only to clients currently inside that instance — each
//                     player also carries reviveProgress (see REVIVE/WIPE below) and targetId
//                     (see AUTO-ATTACK below)
//
// INSTANCES: each dungeon a party is actually playing is its own independent
// "instance" (players/monsters/rooms/etc, see createInstance()) — at most one
// active instance per dungeon at a time (a second player picking the same
// dungeon joins the existing one), keyed by dungeonIndex in the `instances`
// map. An instance is created the moment someone selects that dungeon and
// torn down the moment it's empty (see the cleanup pass in the tick loop) —
// run state was always ephemeral and stays that way; only account/family
// stats persist (server/db.js). `playerInstance` tracks which instance (if
// any) each connected account is currently in.
//
// AUTO-ATTACK & TARGET-LOCK: basic attack fires automatically — no client
// action needed. Each player locks onto the nearest monster (tickAutoAttack)
// and keeps attacking it, on cooldown, as long as it's alive and in range;
// losing the target (it died) picks a fresh nearest one. Specials
// (special1/special2) stay fully manual, unchanged.
//
// REVIVE/WIPE: dying no longer lets a player just rejoin — an alive,
// currently-connected teammate has to stand within REVIVE_RANGE and hold
// there for REVIVE_CHANNEL_SECONDS (js/data.js, shared with the client's
// progress bar) to bring them back at partial HP (tickRevive). If nobody
// connected is left alive, the whole party wipes: after a short delay
// everyone's reset to alive/full HP and the instance resets to its own
// safe room (checkForWipe, called from damagePlayer).
//
// SAFE ROOM & PARTY GATE: every dungeon's room 0 is a safe room (no
// monsters — see js/data.js's DUNGEONS) where the party can see who's
// actually here before diving in. Walking into `safeExit` (a fixed spot
// near the far wall) advances into room 1, the first real chamber.
// Sherwood Approach (dungeonIndex 0) always works — anyone can start, solo
// or with whoever's around. Any dungeon beyond it that the family hasn't
// cleared yet also requires all 4 family accounts present *in this same
// instance* and connected; once a dungeon's been cleared once, it's
// unrestricted for everyone from then on, solo included. See tickSafeRoom().
//
// RECONNECT: a disconnected character isn't deleted — it just sits in its
// instance (still simulated, still targetable, not moving since its held
// keys reset to none) until RECONNECT_GRACE_MS passes with no reconnect, at
// which point it's actually removed. A new socket with the same id within
// that window cancels the removal and resumes in the same instance,
// position/hp/gear/cooldowns untouched.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { CLASSES, WEAPON_TIERS, ARMOR_TIERS, ARTIFACTS, BOONS, DUNGEONS, ENEMY_TYPES, REVIVE_CHANNEL_SECONDS, xpToNextLevel } = require('../js/data.js');
const db = require('./db.js');

// Outermost safety net — the tick loop and the per-connection message
// handler each already catch their own errors locally (better context: which
// instance, which message type), but this backstops anything outside
// either of those, e.g. a bug inside one of the various setTimeout()
// callbacks scattered through this file (wipe reset, boss-defeat summary,
// room-advance delay). A synchronous exception in any event/timer callback
// is fatal to the whole Node process by default — which would disconnect
// every family member across every dungeon at once over a bug that likely
// only affected one of them. Same "a failure here can't take down the
// actual game" principle db.js already applies to persistence — log
// loudly, keep running, rather than let one edge case end everyone's
// session.
process.on('uncaughtException', (err) => {
  console.error('[fatal-caught] uncaughtException (server kept running):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[fatal-caught] unhandledRejection (server kept running):', err);
});

const PORT = process.env.PORT || 3000; // Railway assigns PORT; 3000 is just the local-dev fallback
const HOST = '0.0.0.0';                // must bind all interfaces, not just localhost, for Railway

// Server-only — deliberately NOT in js/data.js, which ships to the browser
// as plain public JS. Override in Railway's dashboard (Variables tab) to set
// a real passphrase for the deployed instance without it ever touching git
// or public client code; the "round-table" fallback is just for local dev.
const SHARED_PASSPHRASE = process.env.SHARED_PASSPHRASE || 'round-table';
const W = 1000, H = 750;
const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;

const ENTRANCE_X = 100, ENTRANCE_Y = H / 2; // every room's layout puts enemies well clear of this
const SPAWN_SEARCH_RADIUS = 70; // how far from the entrance a spawn point is allowed to drift
const SPAWN_CANDIDATES = 8;     // sampled points to pick the one farthest from any alive monster
const SPAWN_GRACE = 3;     // seconds of damage immunity after a (re)join regardless of where they
                            // land — the entrance-seeking placement below is the main defense
                            // against spawning into a fight, this is just the backstop

// Picks a point near `basePoint`, biased away from whatever monsters are
// currently alive in this instance — so landing somewhere mid-fight doesn't
// drop someone right into it just because the fight has drifted toward
// that spot over time. Falls back to basePoint itself if nothing's alive
// (or every candidate is equally boxed in). Originally just the join/
// reconnect entrance point (pickSpawnPoint below); generalized 2026-08-26
// so a directional door (loadRoom's enterDir) can reuse the same
// avoidance logic around whichever wall the player is entering near.
function pickEntryPoint(inst, basePoint){
  let best = { x: basePoint.x, y: basePoint.y };
  let bestDist = -Infinity;
  for(let i = 0; i < SPAWN_CANDIDATES; i++){
    const x = basePoint.x + (Math.random() * 2 - 1) * SPAWN_SEARCH_RADIUS;
    const y = basePoint.y + (Math.random() * 2 - 1) * SPAWN_SEARCH_RADIUS;
    let nearest = Infinity;
    for(const id in inst.monsters){
      const mon = inst.monsters[id];
      if(!mon.alive) continue;
      nearest = Math.min(nearest, Math.hypot(mon.x - x, mon.y - y));
    }
    if(nearest > bestDist){ bestDist = nearest; best = { x, y }; }
  }
  return best;
}
function pickSpawnPoint(inst){ return pickEntryPoint(inst, { x: ENTRANCE_X, y: ENTRANCE_Y }); }

const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 75 * 1000; // how long a disconnected character survives before removal

// Revive: an alive, connected teammate standing within REVIVE_RANGE of a
// fallen player for REVIVE_CHANNEL_SECONDS (js/data.js, shared with the
// client's progress bar) brings them back at REVIVE_HP_FRACTION of max HP.
const REVIVE_RANGE = 50;
const REVIVE_HP_FRACTION = 0.4;

// ---------- ACCOUNTS (MASTER_DESIGN.md §8a) ----------
// Exactly 5 reserved account ids — the family's fixed 4-person roster plus
// one solo QA account exempt from the party gate below. No open
// self-registration: this list is the actual access control (an
// unrecognized username is rejected at login, same shape as the
// passphrase gate). PINs themselves are never pre-assigned here — see
// server/db.js's verifyOrClaimPin, which lets each account set its own
// PIN on first login rather than this file ever handling/transmitting one.
// isAdmin (2026-08-26, MASTER_DESIGN.md §8a) gates the admin panel/actions
// below — Dad's account only. No separate access-control system needed at
// this scale, same call the design doc already made: one flag on one
// account, checked server-side on every admin message (never trust the
// client's own "should I show the button" check as the real gate).
const ACCOUNTS = {
  dad:    { name: 'Dad',    isTest: false, isAdmin: true },
  mum:    { name: 'Mum',    isTest: false, isAdmin: false },
  amelia: { name: 'Amelia', isTest: false, isAdmin: false },
  declan: { name: 'Declan', isTest: false, isAdmin: false },
  test:   { name: 'test',   isTest: true,  isAdmin: false }
};
const FAMILY_IDS = Object.keys(ACCOUNTS).filter(id => !ACCOUNTS[id].isTest);

// ---------- INSTANCES ----------
// At most one active instance per dungeon (see the top-of-file INSTANCES
// note) — keyed by dungeonIndex, created lazily on first join, torn down
// once empty. playerInstance tracks which instance (if any) each connected
// account currently belongs to; absent means "at dungeon-select."
const instances = new Map();        // dungeonIndex -> Instance
const playerInstance = new Map();   // playerId -> dungeonIndex

function createInstance(dungeonIndex){
  return {
    dungeonIndex, roomIndex: 0,
    players: Object.create(null), monsters: Object.create(null),
    projectiles: [], loot: [],
    advancing: false, waitingForFamily: false, dungeonSummary: null,
    dungeonStartedAt: Date.now(), dungeonKillCount: 0,
    waveState: null, branchState: null,
    clearedRooms: new Set() // rooms already cleared this run — see loadRoom()'s backtracking skip
  };
}

function getOrCreateInstance(dungeonIndex){
  let inst = instances.get(dungeonIndex);
  if(!inst){
    inst = createInstance(dungeonIndex);
    instances.set(dungeonIndex, inst);
    loadRoom(inst, 0);
    console.log(`[instance] created for ${DUNGEONS[dungeonIndex].name}`);
  }
  return inst;
}

let monsterSeq = 0, lootSeq = 0, projSeq = 0; // shared id counters — fine across instances, just need uniqueness

function currentDungeon(inst){ return DUNGEONS[inst.dungeonIndex]; }
function currentRoom(inst){ return currentDungeon(inst).rooms[inst.roomIndex]; }
function currentRoomId(inst){ return `${inst.dungeonIndex}:${inst.roomIndex}`; }

// A solo player kiting one target and a full family of 4 auto-attacking
// simultaneously clear the exact same monster HP at very different real
// speeds — nothing before this scaled with party size. Applied to monster
// HP (spawnMonster) and a wave room's kill quota (loadRoom), deliberately
// NOT to monster damage output — this should make fights take longer with
// more players, not punish anyone individually. Recomputed at spawn/room-
// load time from however many characters have actually joined this
// instance (players object, not just currently-connected sockets — a
// fallen teammate still counts, they're still part of the fight). Tunable:
// 1.35x per extra player was a starting guess (2p:1.35, 3p:1.7, 4p:2.05),
// confirmed reasonable via a live 4-tab test (2026-08-24) — see
// MASTER_DESIGN.md §9 if this needs retuning after real family play.
function partyScale(inst){
  const n = Math.max(1, Object.keys(inst.players).length);
  return 1 + (n - 1) * 0.35;
}

// Design call (2026-08-25): this is a co-op dungeon crawl that NEEDS a group,
// not a solo-viable horde mode — a dungeon should be realistically
// completable by 2, but not really by 1. Solo already has zero revive safety
// net (damagePlayer/checkForWipe below — nobody's left to walk over and
// revive a fallen lone player), but that only bites if a lone player is
// actually likely to take a real hit in the first place. Baseline monster
// damage was tuned around parties big enough to revive each other, so solo
// rarely felt at risk at all — confirmed live, see MASTER_DESIGN.md §3
// ("Solo ... cleared Sherwood without much trouble"). This multiplies
// incoming damage only at exactly 1 player; 2-4 players are untouched,
// same as partyScale()'s existing choice to scale HP/quota (not damage) for
// group play. Soft risk, not a hard block — matches Pillar 5's existing
// "losing occasionally is part of the fun, not a wall" stance rather than
// flatly disallowing solo play. 1.6x is a first-cut guess, not validated by
// an actual solo family playtest — retune if it's wrong, see §9/§13.
const SOLO_DANGER_MULT = 1.6;
function soloDangerMult(inst){
  return Object.keys(inst.players).length === 1 ? SOLO_DANGER_MULT : 1;
}

// ---------- LEVELING & BOONS (MASTER_DESIGN.md §10, Phase 3) ----------
// Permanent XP/level (survives forever, via db.js) — per-character, not
// the account-wide shape kills/deaths/gear use (reconciled 2026-08-26;
// this was account-wide in the first Phase 3 slice, changed since a
// player trying a different saved character is meant to start that
// character back at level 1, not inherit progress from another one) —
// plus temporary in-run boons (gone on leave/die, §10's "relic or
// blessing for the rest of this run" — a wipe counts as "die" here, see
// checkForWipe).
// A player's derived combat stats stack from several independent sources —
// class base, gear (existing), one-off artifacts (existing), and now
// permanent level growth plus in-run boon picks. maxHp is recomputed from
// the class base every time any of those changes, rather than repeatedly
// multiplying an already-modified number in place — stacking percentage
// multiplies directly onto maxHp over several level-ups/boon-picks in one
// run would compound rounding drift; recomputing from scratch each time
// can't.
const LEVEL_STAT_BONUS_PER_LEVEL = 0.04; // +4% maxHp and +4% damage per level above 1 — first-cut, untuned
function levelStatMult(level){ return 1 + Math.max(0, level - 1) * LEVEL_STAT_BONUS_PER_LEVEL; }

function recomputeMaxHp(player){
  const c = CLASSES[player.classKey];
  const newMax = Math.round(c.hp * player.artifactHpMult * player.levelMult * player.boonHpMult);
  player.hp += newMax - player.maxHp; // preserves current damage taken rather than healing to full
  player.maxHp = newMax;
}

// XP per kill: `xpGear` already existed on every trash/mini-boss ENEMY_TYPES
// entry (weight 0.15-0.4) but nothing ever read it — this is that field's
// first actual use. Bosses don't carry xpGear, so they scale off the same
// signal their currency reward already uses (rewardCurrency), keeping "how
// special is this kill" defined in exactly one place per monster instead of
// two separate, potentially-drifting numbers.
const XP_PER_TRASH_WEIGHT = 40;
function xpForKill(mon){
  const t = ENEMY_TYPES[mon.type];
  if(t.boss) return (t.rewardCurrency || 30) * 2;
  return Math.round(XP_PER_TRASH_WEIGHT * (t.xpGear || 0.2));
}

// xpToNextLevel is shared from js/data.js (both this file and render.js's
// "X/Y xp" HUD text need the exact same curve) — first-cut, not validated
// by real family play, see §13. Shallow enough that a full dungeon clear (a
// wave room alone can be 15-30+ kills) should realistically produce a
// level-up or two, which matters here since that's also the only thing
// that triggers a boon choice — a curve so steep nobody ever levels up
// mid-run would quietly kill half of what this pass is meant to add.

const BOON_IDS = Object.keys(BOONS);
function offerBoonChoice(player){
  const pool = BOON_IDS.slice();
  const offered = [];
  for(let i = 0; i < 3 && pool.length; i++){
    offered.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  // A queue, not a single slot — a big enough XP grant (a boss kill against
  // a low level) can cross more than one level-up threshold in one
  // grantXp() call; queuing means a second one doesn't silently overwrite
  // and lose the first still-unresolved offer.
  player.pendingBoonChoices.push(offered);
}

function grantXp(inst, player, amount){
  if(!amount || player.dead) return; // a fallen player didn't land the kill that's crediting this
  // xpCapLevel (js/data.js's DUNGEONS, §5) — once a character has outgrown
  // this dungeon, further kills here are worth nothing. Not a punishment,
  // just no reward: they can still play it (helping a lower-level teammate,
  // farming gear, whatever), there's just no XP left to gain from it.
  const cap = currentDungeon(inst).xpCapLevel;
  if(cap && player.level >= cap) return;
  player.xp += amount;
  while(player.xp >= xpToNextLevel(player.level)){
    player.xp -= xpToNextLevel(player.level);
    player.level++;
    player.levelMult = levelStatMult(player.level);
    recomputeMaxHp(player);
    offerBoonChoice(player);
  }
  // Persisted on every grant, not just level-ups — same "write on every
  // key event" pattern totalKills already uses, so a disconnect mid-level
  // never loses partial XP progress. Per-character (server/db.js), not
  // routed through savePlayerStats/the account-wide row.
  db.saveCharacterProgress(player.id, player.characterId, player.level, player.xp);
}

function applyBoonChoice(player, boonId){
  const current = player.pendingBoonChoices[0];
  if(!current || !current.includes(boonId)) return; // not the currently-offered round — stale/forged request, ignore
  player.pendingBoonChoices.shift();
  if(boonId === 'ironWill'){ player.boonHpMult *= 1.2; recomputeMaxHp(player); }
  else if(boonId === 'keenEdge'){ player.boonDmgMult *= 1.15; }
  else if(boonId === 'swiftBoots'){ player.boonSpeedMult *= 1.12; }
}

// One artifact per boss (js/data.js's ARTIFACTS, keyed by bossType) — used
// by dropLoot() to know which artifact a boss kill grants. Built once,
// not per-lookup, since ARTIFACTS never changes at runtime.
const ARTIFACT_ID_BY_BOSS_TYPE = Object.fromEntries(
  Object.entries(ARTIFACTS).map(([id, a]) => [a.bossType, id])
);
function artifactIdForBoss(bossType){ return ARTIFACT_ID_BY_BOSS_TYPE[bossType] || null; }

// Shared by every place a monster gets spawned (a normal room, the side
// chamber, a wave room's initial/ongoing spawns) so the instance shape —
// which fields get reset vs. inherited from ENEMY_TYPES — lives in exactly
// one place. hpScale lets wave spawns get modestly tougher as a fight goes
// on (server.js's tickWaveSpawns) without a separate code path; it
// multiplies with partyScale() rather than replacing it.
function spawnMonster(inst, type, x, y, hpScale){
  const t = ENEMY_TYPES[type];
  const id = 'm' + (++monsterSeq);
  const hp = Math.round(t.hp * (hpScale || 1) * partyScale(inst));
  inst.monsters[id] = Object.assign({}, t, {
    id, type, x, y, hp, maxHp: hp, cd: 0,
    slamCd: t.slamCd || 0, slamState: null, slamTimer: 0, alive: true,
    stunTimer: 0, tauntTimer: 0, tauntTarget: null, mesmerizeTimer: 0,
    chargeCd: t.chargeCd || 0, chargeState: null, chargeTimer: 0,
    fearCd: t.fearCd || 0, fearState: null, fearCastTimer: 0
  });
  return inst.monsters[id];
}

function loadRoom(inst, idx, enterDir){
  inst.roomIndex = idx;
  inst.branchState = null; // any branch fork is resolved (or moot) whenever a fresh room loads
  inst.roomState = null; // any cleared-room exit gate is moot whenever a fresh room loads
  inst.waveState = null;
  // idx 0 is always the safe room — the real run (re)starts on leaving it,
  // including after a wipe (checkForWipe/adminResetInstance both return to
  // idx 0, then the player leaves again through here) — so this is also
  // the right point to forget which rooms were cleared on the previous
  // attempt (2026-08-26, backtracking pass): a wipe resets the dungeon,
  // not just position, and cleared-room memory is run state, not
  // persistent progress.
  if(idx === 1){ inst.dungeonStartedAt = Date.now(); inst.dungeonKillCount = 0; inst.clearedRooms = new Set(); }
  const dungeon = currentDungeon(inst);
  const room = dungeon.rooms[idx];
  for(const id in inst.monsters) delete inst.monsters[id];
  inst.loot = [];

  // Artifact effect resets — Mordred's Broken Blade is per-room (every
  // fresh room gets its own "first hit" bonus), the Green Knight's Girdle
  // is per-run (only reset when idx===1, the same point dungeonKillCount
  // resets, matching "once per dungeon run").
  for(const pid in inst.players){
    inst.players[pid].brokenBladeUsedThisRoom = false;
    if(idx === 1) inst.players[pid].girdleUsedThisRun = false;
  }

  if(inst.clearedRooms.has(idx)){
    // Backtracking (2026-08-26) — a room already cleared this run stays
    // cleared: no monsters, doors already open, nothing to fight. Without
    // this, a door back would just mean "re-fight the room from scratch,"
    // not actually going back.
    inst.roomState = 'awaiting_exit';
  } else if(room.wave){
    // Kill quota scales with party size too, not just monster HP — more
    // players also means more simultaneous kills happening, which HP
    // scaling alone doesn't touch.
    const killTarget = Math.round(room.killTarget * partyScale(inst));
    inst.waveState = { killsSoFar: 0, killTarget, spawnTimer: 2.5 };
    for(let i = 0; i < 3; i++) spawnWaveMonster(inst, room);
  } else {
    // A boss room may name a rare variant (js/data.js's rareVariant field)
    // rolled once here — "sometimes it's someone special" (§5/§6/§9). Every
    // boss room defined today has exactly one enemy entry, so overriding
    // every entry's type is equivalent to overriding "the boss."
    const rareRoll = room.boss && room.rareVariant && Math.random() < room.rareVariant.chance;
    room.enemies.forEach(e=> spawnMonster(inst, rareRoll ? room.rareVariant.type : e.type, e.x, e.y));
  }

  // Directional-door entry (2026-08-26) — arriving through a door with a
  // compass `dir` (server.js's doorsFor/DOOR_SPOT) lands near the opposite
  // wall of the new room, the wall facing back the way they came, instead
  // of just staying wherever they happened to be standing (today's default
  // for every non-directional room transition). Repositions every player
  // unconditionally, dead/disconnected included — inst.roomIndex is
  // instance-wide, so a fallen teammate is already considered "in" the new
  // room regardless of revive state, same as resetPlayerForFreshRun does
  // on a wipe.
  if(enterDir){
    const basePoint = DOOR_SPOT[enterDir];
    for(const pid in inst.players){
      const p = inst.players[pid];
      const spot = pickEntryPoint(inst, basePoint);
      p.x = spot.x; p.y = spot.y;
      p.spawnProtection = SPAWN_GRACE;
    }
  }

  const label = room.safe ? 'safe room' : room.boss ? 'BOSS' : room.wave ? 'wave chamber' : `chamber ${idx}`;
  console.log(`[room] ${dungeon.name} — ${label} (${Object.keys(inst.monsters).length} monsters)`);
}

// Picks a weighted-random type from a wave room's `pool` and spawns it at a
// random spawnPoint — used both for the initial batch and by
// tickWaveSpawns()'s ongoing trickle. hpScale grows with killsSoFar so
// later spawns are modestly tougher, part of the kill-count-driven
// escalation (§9, decided in MASTER_DESIGN.md's Open Decisions Log).
function spawnWaveMonster(inst, room){
  const totalWeight = room.pool.reduce((sum, e)=> sum + e.w, 0);
  let roll = Math.random() * totalWeight;
  let type = room.pool[0].type;
  for(const e of room.pool){
    if(roll < e.w){ type = e.type; break; }
    roll -= e.w;
  }
  const p = room.spawnPoints[Math.floor(Math.random() * room.spawnPoints.length)];
  const hpScale = 1 + Math.min(0.3, (inst.waveState ? inst.waveState.killsSoFar : 0) * 0.02);
  spawnMonster(inst, type, p.x, p.y, hpScale);
}

// Keeps a wave room's spawns trickling in while the kill quota hasn't been
// hit yet — spawn interval shrinks as killsSoFar climbs, which is the
// actual "escalation" (kill-count driven, not wall-clock — see §9).
function tickWaveSpawns(inst, dt){
  const waveState = inst.waveState;
  if(!waveState) return;
  if(waveState.killsSoFar >= waveState.killTarget) return;
  waveState.spawnTimer -= dt;
  if(waveState.spawnTimer > 0) return;
  const room = currentRoom(inst);
  const aliveCount = Object.values(inst.monsters).filter(m=>m.alive).length;
  if(aliveCount < room.maxAlive) spawnWaveMonster(inst, room);
  waveState.spawnTimer = Math.max(1.2, 3.2 - waveState.killsSoFar * 0.12);
}

// The safe room's exit — a fixed spot near the far wall, opposite the
// entrance, that a player walks into to signal "let's go". Same shape as
// the existing spawn-point/loot-pickup proximity checks, not a new
// mechanic. See tickSafeRoom(). Fixed world coordinates, shared by every
// instance — not per-instance state.
const SAFE_EXIT_X = W - 100, SAFE_EXIT_Y = H / 2, SAFE_EXIT_RADIUS = 50;

// Branching side chamber (js/data.js's `sideChamber` on individual branch
// rooms). Same trigger-zone shape as the safe room's exit, just three of
// them: a fork (main path vs. the harder, better-loot detour) and a single
// return spot once the detour's cleared. Fixed world coordinates, shared
// by every instance.
// branchState: null | 'awaiting_choice' | 'in_side_chamber' | 'side_cleared_awaiting_return'
const BRANCH_MAIN_EXIT = { x: W - 100, y: H / 2 - 90, r: 45 };
const BRANCH_SIDE_EXIT = { x: W - 100, y: H / 2 + 90, r: 45 };
const BRANCH_RETURN_EXIT = { x: W - 100, y: H / 2, r: 45 };

// A room can override where its gates actually sit (js/data.js's `exits`,
// 2026-08-25) — added for real spatial layouts (walls carving a room into
// distinct lanes/corridors, MASTER_DESIGN.md §9) where "both gates float
// near each other on the right edge" no longer reads as two genuinely
// different directions. Falls back to the original shared constants above
// for every branch room that hasn't been reshaped this way yet.
function mainExitFor(inst){ return (currentRoom(inst).exits && currentRoom(inst).exits.main) || BRANCH_MAIN_EXIT; }
function sideExitFor(inst){ return (currentRoom(inst).exits && currentRoom(inst).exits.side) || BRANCH_SIDE_EXIT; }
function returnExitFor(inst){ return (currentRoom(inst).exits && currentRoom(inst).exits.return) || BRANCH_RETURN_EXIT; }

// A plain (non-branch, non-boss) room's exit(s) once it's cleared —
// Binding of Isaac-style "clear the room, a door opens" (MASTER_DESIGN.md
// §9, 2026-08-26): the room used to auto-advance the whole party on a
// blind 1400ms timer with nothing to actually walk to. A room can define
// its own `doors` (2026-08-26's hub-and-spoke pass) — an array of
// `{to, exit, label, color}`, `to` being this dungeon's own room index, not
// necessarily +1 — to open more than one real direction at once. Every
// room that doesn't opt into that keeps today's exact single-gate
// behavior: a synthesized one-door array pointing at roomIndex+1, reusing
// the same centered gate spot the safe room/branch-return gate already sit
// at, and the same `exits.main` room override branch rooms use.
//
// A door can name a compass `dir` instead of a hand-placed `exit`
// (2026-08-26, the directional-doors pass) — DOOR_SPOT resolves it to a
// real gate position on the matching wall, and the same table doubles as
// where a player entering *through* that door lands in the new room (see
// loadRoom's enterDir param), always the wall opposite the direction they
// came from.
//
// `grid` (js/data.js, per-room {x,y}) is purely a minimap layout
// coordinate — NOT the source of `dir`. A room can be a convergence point
// for doors with different independently-authored `dir` values (the boss
// room here, reached from 3 different rooms via 3 different doors), which
// a single grid position can't represent as consistent cardinal deltas
// from every source room at once. Keep these two fields conceptually
// separate — don't try to derive one from the other later.
const DOOR_SPOT = {
  north: { x: W / 2, y: 110, r: 45 },
  south: { x: W / 2, y: H - 110, r: 45 },
  east:  { x: W - 100, y: H / 2, r: 45 },
  west:  { x: 100, y: H / 2, r: 45 }
};
const OPPOSITE_DIR = { north: 'south', south: 'north', east: 'west', west: 'east' };

function doorsFor(inst){
  const room = currentRoom(inst);
  if(room.doors) return room.doors.map(d => ({ ...d, exit: d.exit || DOOR_SPOT[d.dir] }));
  return [{ to: inst.roomIndex + 1, exit: (room.exits && room.exits.main) || BRANCH_RETURN_EXIT, label: 'Continue on' }];
}

function someoneAt(inst, spot){
  return Object.values(inst.players).some(p => !p.dead && Math.hypot(p.x - spot.x, p.y - spot.y) < spot.r);
}

// ---------- WALL COLLISION (MASTER_DESIGN.md §9, 2026-08-25) ----------
// Rooms had zero interior geometry before this — an open rectangle with
// monsters and exit-gate circles, no way to carve a room into real
// corridors/lanes. `walls` (js/data.js, per room, default none) is a list
// of simple axis-aligned rectangles; this is the one collision primitive
// every room can now use, not a per-room-bespoke thing. X and Y are
// resolved as two separate moves rather than one combined vector — the
// standard trick for "sliding" along a wall instead of just stopping dead
// the instant any part of a diagonal move would clip it.
function circleHitsRect(cx, cy, r, rect){
  const closestX = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const closestY = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  return Math.hypot(cx - closestX, cy - closestY) < r;
}
function hitsAnyWall(x, y, radius, walls){
  return walls.some(w => circleHitsRect(x, y, radius, w));
}
function moveWithWalls(p, dx, dy, walls){
  if(!walls || walls.length === 0){ p.x += dx; p.y += dy; return; }
  const nx = p.x + dx;
  if(!hitsAnyWall(nx, p.y, p.radius, walls)) p.x = nx;
  const ny = p.y + dy;
  if(!hitsAnyWall(p.x, ny, p.radius, walls)) p.y = ny;
}

// Monster steering around walls (2026-08-26) — monsters previously ignored
// `walls` entirely (no collision at all, straight-line chase clipped
// visually through them) since move-toward-target has no reason to know
// about obstacles on its own. Not full pathfinding (no guaranteed-shortest
// route, no help in a real maze of concave geometry) — a lightweight
// "steer around the near corner of whichever single wall is actually in
// the way" heuristic, recomputed fresh every tick rather than a stored
// path, which is genuinely enough for this game's walls so far (a
// handful of sparse rectangles per room, never a dense maze) and keeps
// monster AI exactly as simple as it's ever been. Revisit with something
// heavier only if/when a room's geometry actually needs it.
function segmentIntersectsRect(x1, y1, x2, y2, rect){
  let tmin = 0, tmax = 1;
  const dx = x2 - x1, dy = y2 - y1;
  if(dx === 0){
    if(x1 < rect.x || x1 > rect.x + rect.w) return false;
  } else {
    let t1 = (rect.x - x1) / dx, t2 = (rect.x + rect.w - x1) / dx;
    if(t1 > t2){ const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if(tmin > tmax) return false;
  }
  if(dy === 0){
    if(y1 < rect.y || y1 > rect.y + rect.h) return false;
  } else {
    let t1 = (rect.y - y1) / dy, t2 = (rect.y + rect.h - y1) / dy;
    if(t1 > t2){ const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if(tmin > tmax) return false;
  }
  return true;
}
// The waypoint is "the target's own y, but at whichever edge of the
// wall's x-range is closer to the mover" — not just the nearest corner.
// A first version aimed straight at the nearest corner and got monsters
// stuck oscillating just past it: for a wall that spans most of the
// room's width (this game's so far), reaching a corner doesn't actually
// clear line-of-sight — the direct line from there to the target dips
// back into the wall's y-band further along, since the corner is only
// barely past the wall's edge, not past its full extent. Matching the
// target's y *before* crossing the wall's x-range sidesteps that
// entirely: the move to this waypoint never enters the wall's x-range at
// all (mover and waypoint are both on the same side), and the subsequent
// move from waypoint to target holds y roughly constant at the target's
// own y — which can't be inside the wall's band, since the target is
// standing there right now.
function pickWallDetour(mx, my, tx, ty, rect, radius){
  const pad = (radius || 16) + 15;
  const leftX = rect.x - pad, rightX = rect.x + rect.w + pad;
  // "Closer edge by raw distance" isn't enough on its own — Sherwood's
  // room 1 walls span almost the full room width, so their right edge
  // sits right against the room's own outer border: not a real route
  // around, a dead end. Only actually route toward an edge that's still
  // inside the room; if only one side qualifies, use that one regardless
  // of which is numerically closer (confirmed needed live: without this,
  // a monster starting mid-lane picked the "closer" but unusable right
  // edge and walked straight through the wall trying to reach it).
  const leftValid = leftX > 20, rightValid = rightX < W - 20;
  const isLeft = leftValid && rightValid ? Math.abs(mx - leftX) < Math.abs(mx - rightX) : leftValid;
  const edgeX = isLeft ? leftX : rightX;

  // Two phases, decided fresh from current position every tick (no
  // stored path needed): first clear the wall's x-range entirely via a
  // PURE horizontal move (y unchanged) — provably safe regardless of the
  // wall's length, since a horizontal line at a y outside the wall's
  // y-band can never cross it no matter how far it travels in x. Only
  // once actually past the wall's edge does it start aligning y, now
  // moving vertically at x pinned to edgeX — also provably safe, since
  // that x is by construction outside the wall's x-range for the whole
  // move. Aiming straight at one combined (edgeX, target-y) waypoint in
  // a single diagonal step (the first version of this) cuts close enough
  // to the wall's corner during transit that no amount of padding alone
  // reliably keeps a large-radius monster from grazing it — confirmed
  // live, this two-phase version doesn't.
  const alreadyClearOfWall = isLeft ? mx <= edgeX : mx >= edgeX;
  if(!alreadyClearOfWall) return { x: edgeX, y: my };
  return { x: edgeX, y: ty };
}
// Returns {x,y} to actually steer toward this tick — the real target if
// the direct line to it is clear, otherwise a detour corner around
// whichever wall is in the way (first one found; this game's rooms don't
// have enough walls yet for "which of several" to matter).
function wallAwareGoal(mx, my, tx, ty, walls, radius){
  if(!walls || walls.length === 0) return { x: tx, y: ty };
  for(const w of walls){
    if(segmentIntersectsRect(mx, my, tx, ty, w)) return pickWallDetour(mx, my, tx, ty, w, radius);
  }
  return { x: tx, y: ty };
}

function advanceToNextRoom(inst){
  if(inst.roomIndex + 1 < currentDungeon(inst).rooms.length) loadRoom(inst, inst.roomIndex + 1);
}

// ---------- CONNECTIONS ----------
const clients = new Map();          // playerId -> ws (the live socket, if any, for that character)
const reconnectTimers = new Map();  // playerId -> pending-removal timeout, only set while disconnected

// All 4 family accounts present *in this specific instance* and connected
// — not just "connected somewhere on the server." With multiple
// simultaneous instances, a family member playing a different dungeon
// must not count toward unlocking this one.
function familyFullyConnected(inst){
  return FAMILY_IDS.every(id => {
    const p = inst.players[id];
    const ws = clients.get(id);
    return !!p && !!ws && ws.readyState === 1;
  });
}

// ---------- STATIC CLIENT ----------
// Serves the browser client (camelot-crawler.html, css/, js/ — all siblings
// of this server/ directory) over plain HTTP on the same port as the
// WebSocket, so the deployed URL is the actual game, not just an API.
//
// CLIENT_ROOT is the repo root, which also contains server/ (source, deps,
// package files) — so this deliberately does NOT serve "anything under
// CLIENT_ROOT". Only the one HTML file and the css/js directories below are
// reachable; everything else 404s regardless of what's actually on disk.
const CLIENT_ROOT = path.join(__dirname, '..');
const STATIC_DIRS = {
  '/css/': path.join(CLIENT_ROOT, 'css'),
  '/js/': path.join(CLIENT_ROOT, 'js'),
  // On-disk path is Assets/processed (see tools/process-sprites.js) — the
  // public URL prefix stays lowercase /assets/ to match this project's
  // other static routes; only the filesystem side needs the real casing.
  '/assets/': path.join(CLIENT_ROOT, 'Assets', 'processed')
};
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/manifest+json; charset=utf-8'
};

function resolveStaticFile(urlPath){
  if(urlPath === '/' || urlPath === '/camelot-crawler.html'){
    return path.join(CLIENT_ROOT, 'camelot-crawler.html');
  }
  // Service worker must be served from root (not under /js/) so its default
  // scope covers the whole app, matching manifest.json's "scope": "/".
  if(urlPath === '/manifest.json' || urlPath === '/service-worker.js'){
    return path.join(CLIENT_ROOT, urlPath.slice(1));
  }
  for(const prefix in STATIC_DIRS){
    if(!urlPath.startsWith(prefix)) continue;
    const dirRoot = STATIC_DIRS[prefix];
    const candidate = path.normalize(path.join(dirRoot, urlPath.slice(prefix.length)));
    return candidate.startsWith(dirRoot) ? candidate : null; // guard traversal, e.g. "/js/../server/server.js"
  }
  return null; // not one of the client's own files — don't serve it
}

function serveStatic(req, res){
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = resolveStaticFile(urlPath);
  if(!filePath){
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  fs.readFile(filePath, (err, data)=>{
    if(err){
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const httpServer = http.createServer(serveStatic);
// Reject the WebSocket handshake itself (not "connect then close") if the
// passphrase is missing or wrong — the client never even gets an 'open'.
const wss = new WebSocketServer({
  server: httpServer,
  verifyClient: (info, callback) => {
    const passphrase = new URL(info.req.url, 'http://internal').searchParams.get('passphrase');
    const ok = passphrase === SHARED_PASSPHRASE;
    if(!ok) console.log('[auth] rejected connection: bad or missing passphrase');
    callback(ok, 401, 'Unauthorized');
  }
});
httpServer.listen(PORT, HOST);

wss.on('connection', (ws, req) => {
  const requestedId = new URL(req.url, 'http://internal').searchParams.get('playerId');
  // Only trust a playerId from the URL if it's one of the 5 reserved
  // accounts — this is what makes login actually mean something rather
  // than the old "any random string is a valid identity" model. Anything
  // else (missing, stale, tampered) falls through to the login-pending
  // path below instead of being trusted outright.
  const remembered = (requestedId && ACCOUNTS[requestedId.toLowerCase()]) ? requestedId.toLowerCase() : null;
  let id = null; // set once identity is established — closures below read this live, not at registration time

  function finishConnect(boundId){
    id = boundId;

    // A second connection for the same account (duplicate tab, or a stale
    // socket that hasn't noticed it's dead yet) takes over — close
    // whichever socket was there before.
    const priorWs = clients.get(id);
    if(priorWs && priorWs !== ws && priorWs.readyState === 1 /* OPEN */) priorWs.close();
    clients.set(id, ws);

    db.touchOrCreatePlayer(id); // read-on-connect: creates the row on this id's first-ever connection, else bumps last_seen_at

    // Reconnecting within the grace window: cancel the pending removal.
    if(reconnectTimers.has(id)){
      clearTimeout(reconnectTimers.get(id));
      reconnectTimers.delete(id);
    }

    const instIdx = playerInstance.get(id);
    const inst = instIdx !== undefined ? instances.get(instIdx) : undefined;
    const resuming = !!(inst && inst.players[id]);

    ws.send(JSON.stringify({
      type: 'welcome', id, roomId: resuming ? currentRoomId(inst) : null, resuming,
      // Level is per-character now (MASTER_DESIGN.md §10), not a single
      // account-wide number — each entry in `characters` already carries
      // its own level/xp (db.js), so dungeon-select's level-gate badges
      // read the chosen character's own level client-side instead of a
      // separate top-level field here.
      characters: db.getCharacters(id), isTest: ACCOUNTS[id].isTest, isAdmin: ACCOUNTS[id].isAdmin,
      dungeonsCleared: db.getFamilyState().dungeonsCleared
    }));
    console.log(`[connect] ${id}${resuming ? ' (resuming)' : ''}`);
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Everything below can touch arbitrary game state on arbitrary
    // client-supplied input — one bad message from one client throwing
    // here used to crash the whole process (a synchronous exception in an
    // event listener is fatal by default in Node), disconnecting every
    // family member at once over what should only ever affect the sender.
    try {
      if(id === null){
        // Not yet identified — the only message this socket will act on is
        // a login attempt. Everything else is silently ignored rather than
        // erroring, since a slow/racy client could plausibly queue an
        // early message before login resolves.
        if(msg.type !== 'login') return;
        const attemptedId = typeof msg.username === 'string' ? msg.username.trim().toLowerCase() : '';
        const pin = typeof msg.pin === 'string' ? msg.pin : '';
        if(!ACCOUNTS[attemptedId] || !/^\d{4}$/.test(pin)){
          ws.send(JSON.stringify({ type: 'loginResult', ok: false, reason: 'unknown_account' }));
          return;
        }
        const result = db.verifyOrClaimPin(attemptedId, pin);
        if(!result.ok){
          ws.send(JSON.stringify({ type: 'loginResult', ok: false, reason: result.reason }));
          return;
        }
        ws.send(JSON.stringify({ type: 'loginResult', ok: true, accountId: attemptedId, isNewClaim: result.isNewClaim }));
        finishConnect(attemptedId);
        return;
      }

      if(msg.type === 'leaveDungeon'){
        // Special-cased here rather than in handleMessage() because it needs
        // to reset this closure's own `id` back to null — the whole point is
        // this same socket can go through 'login' again afterward without
        // reconnecting, exactly like a fresh, never-logged-in connection.
        const instIdx = playerInstance.get(id);
        const inst = instIdx !== undefined ? instances.get(instIdx) : undefined;
        if(inst) delete inst.players[id]; // instance cleanup (if now empty) happens in the tick loop, not here
        playerInstance.delete(id);
        if(reconnectTimers.has(id)){ clearTimeout(reconnectTimers.get(id)); reconnectTimers.delete(id); }
        clients.delete(id);
        console.log(`[leave] ${id} left the dungeon`);
        ws.send(JSON.stringify({ type: 'leftDungeon' }));
        id = null;
        return;
      }

      handleMessage(id, msg);
    } catch (err) {
      console.error(`[message] error handling '${msg && msg.type}' from ${id}:`, err);
    }
  });

  ws.on('close', () => {
    if(id === null) return; // never actually logged in — nothing was ever registered for this socket
    if(clients.get(id) !== ws) return; // a newer connection already replaced this one; nothing to do
    clients.delete(id);
    const instIdx = playerInstance.get(id);
    const inst = instIdx !== undefined ? instances.get(instIdx) : undefined;
    const p = inst ? inst.players[id] : undefined;
    if(!p){ console.log(`[disconnect] ${id}`); return; }
    db.savePlayerStats(p); // write-on-disconnect
    p.keys.up = p.keys.down = p.keys.left = p.keys.right = false; // stop it from walking into a wall forever
    reconnectTimers.set(id, setTimeout(()=>{
      if(inst) delete inst.players[id];
      playerInstance.delete(id);
      reconnectTimers.delete(id);
      console.log(`[expired] ${id} removed after ${RECONNECT_GRACE_MS / 1000}s with no reconnect`);
    }, RECONNECT_GRACE_MS));
    console.log(`[disconnect] ${id} (grace period started)`);
  });

  if(remembered) finishConnect(remembered);
  // else: connection stays open but pending — client is expected to send
  // {type:"login", username, pin} next.
});

function handleMessage(id, msg){
  if(!msg || typeof msg.type !== 'string') return;

  // Every admin.* message shares one gate here rather than each handler
  // re-checking it — never trust the client's own "should I show this
  // button" logic as the real access control, only this server-side check
  // of the account's own isAdmin flag (ACCOUNTS, MASTER_DESIGN.md §8a).
  if(msg.type.indexOf('admin') === 0){
    if(!ACCOUNTS[id] || !ACCOUNTS[id].isAdmin) return;
    handleAdminMessage(id, msg);
    return;
  }

  if(msg.type === 'createCharacter'){
    const classKey = CLASSES[msg.classKey] ? msg.classKey : null;
    if(!classKey) return;
    const gender = (msg.gender === 'male' || msg.gender === 'female') ? msg.gender : null;
    const result = db.createCharacter(id, classKey, gender);
    const ws = clients.get(id);
    if(ws) ws.send(JSON.stringify({ type: 'characterList', characters: db.getCharacters(id), error: result.ok ? null : result.reason }));
    return;
  }

  if(msg.type === 'deleteCharacter'){
    db.deleteCharacter(id, msg.characterId);
    const ws = clients.get(id);
    if(ws) ws.send(JSON.stringify({ type: 'characterList', characters: db.getCharacters(id) }));
    return;
  }

  if(msg.type === 'returnToDungeonSelect'){
    const instIdx = playerInstance.get(id);
    const inst = instIdx !== undefined ? instances.get(instIdx) : undefined;
    if(inst) delete inst.players[id];
    playerInstance.delete(id);
    const ws = clients.get(id);
    if(ws) ws.send(JSON.stringify({ type: 'leftInstance', dungeonsCleared: db.getFamilyState().dungeonsCleared }));
    return;
  }

  if(msg.type === 'join'){
    // Always reply — the client waits for this (or the first state
    // broadcast) before switching to the game screen rather than assuming
    // success the instant the message is sent (js/main.js). A silently
    // ignored join used to leave the client stuck on a blank game screen
    // forever with no feedback — confirmed live 2026-08-24, "the grey
    // screen bug" — since nothing ever arrived to draw.
    const replyWs = clients.get(id);
    function reject(reason, extra){
      if(replyWs) replyWs.send(JSON.stringify(Object.assign({ type: 'joinResult', ok: false, reason }, extra)));
    }

    // Refuse to clobber a live entry, dead or alive — a dead one now needs
    // reviving (or a full wipe) rather than a fresh join; see REVIVE/WIPE
    // at the top of this file. Only ever runs against an account with no
    // active instance at all: a brand new session, or right after
    // returnToDungeonSelect/leaveDungeon.
    if(playerInstance.has(id)){ reject('already_active'); return; }
    const character = db.getCharacter(id, msg.characterId);
    if(!character){ reject('unknown_character'); return; } // unknown/stale characterId — client's roster is out of sync
    const dungeonIndex = Number(msg.dungeonIndex);
    if(!Number.isInteger(dungeonIndex) || dungeonIndex < 0 || dungeonIndex >= DUNGEONS.length){
      reject('invalid_dungeon');
      return;
    }
    // Level gate (MASTER_DESIGN.md §5's "eventual direction, not built" —
    // now built alongside the xpCapLevel ceiling below). Checked against
    // this specific character's own persisted level (§10 — per-character,
    // not account-wide), independent of any other family member's or any
    // of this account's other saved characters'.
    const dungeon = DUNGEONS[dungeonIndex];
    const myLevel = character.level || 1;
    if(dungeon.minLevel && myLevel < dungeon.minLevel){
      reject('level_too_low', { minLevel: dungeon.minLevel });
      return;
    }

    const inst = getOrCreateInstance(dungeonIndex);
    const classKey = CLASSES[character.classKey] ? character.classKey : 'squire';
    const c = CLASSES[classKey];
    const spawn = pickSpawnPoint(inst);
    const name = ACCOUNTS[id].name;
    inst.players[id] = {
      id, classKey, name, characterId: character.id, gender: character.gender,
      x: spawn.x, y: spawn.y,
      hp: c.hp, maxHp: c.hp,
      mana: c.hasMana ? c.maxMana : 0, maxMana: c.hasMana ? c.maxMana : 0,
      speed: c.speed, radius: c.radius, color: c.color,
      weaponTier: 0, armorTier: 0, artifacts: [], // overridden by loadPlayerStats below — this account-wide gear (§7), not per-character
      targetId: null, // auto-attack's locked target — see tickAutoAttack()
      keys: { up: false, down: false, left: false, right: false },
      cds: { attack: 0, special1: 0, special2: 0 },
      blockActive: false, blockTimer: 0,
      buffTimer: 0, buffMult: 1,
      shieldTimer: 0, shieldMult: 1, // Squire's Second Wind — see damagePlayer()
      spawnProtection: SPAWN_GRACE,
      hasteMult: 1, hasteTimer: 0,
      // Boss CC (MASTER_DESIGN.md §5) — stunTimer freezes movement/attacks
      // entirely (Bandit Captain's slam); fearTimer instead overrides
      // movement input to run away from fearSourceId while still blocking
      // attacks (Black Knight's warcry). See tickPlayers/tickAutoAttack/doSpecial.
      stunTimer: 0, fearTimer: 0, fearSourceId: null,
      reviveProgress: 0,
      dead: false,
      // Artifact effect state — run/room-scoped, never persisted (unlike
      // weaponTier/armorTier/artifacts above): Ford-Warden's Buckler's own
      // cooldown, the Green Knight's Girdle's once-per-run save, Mordred's
      // Broken Blade's once-per-room bonus. See damagePlayer()/doAttack().
      fordBucklerCd: 0, girdleUsedThisRun: false, brokenBladeUsedThisRoom: false,
      // Permanent level growth plus in-run boons (§10) — level/xp are
      // per-character (sourced from the `character` row already fetched
      // above, not db.loadPlayerStats, which stays account-wide for
      // kills/deaths/gear only). Boon mults always start fresh at 1 here,
      // never persisted, since a boon is gone the moment you leave or
      // rejoin (see checkForWipe for the mid-run-wipe case, which clears
      // them the same way).
      level: character.level || 1, xp: character.xp || 0, levelMult: 1, artifactHpMult: 1,
      boonHpMult: 1, boonDmgMult: 1, boonSpeedMult: 1, pendingBoonChoices: [],
      // Lifetime counters, restored from disk — survive both a server
      // restart and a fresh character after death (framed as "how many
      // ever", not per-character session stats; see server/db.js).
      ...db.loadPlayerStats(id)
    };
    // Static per-character bonuses — applied once here since they don't
    // change mid-run, rather than recomputed every tick. levelMult/
    // artifactHpMult feed recomputeMaxHp() (LEVELING & BOONS above), which
    // handles the actual maxHp math from the class base — replaces the old
    // one-off "multiply maxHp directly" beastHideMantle used to do, now
    // that maxHp has more than one stacking source to account for.
    const newPlayer = inst.players[id];
    newPlayer.levelMult = levelStatMult(newPlayer.level);
    if(newPlayer.artifacts.includes('beastHideMantle')) newPlayer.artifactHpMult = 1.1;
    recomputeMaxHp(newPlayer);
    if(newPlayer.artifacts.includes('gorlagonCrimsonSpur')){
      newPlayer.speed = Math.round(newPlayer.speed * 1.1);
    }
    playerInstance.set(id, dungeonIndex);
    db.savePlayerStats(inst.players[id]); // persist the resolved name even if stats themselves are unchanged
    console.log(`[join] ${id} as ${classKey} into ${DUNGEONS[dungeonIndex].name} (character ${character.id})`);
    if(replyWs) replyWs.send(JSON.stringify({ type: 'joinResult', ok: true }));
    return;
  }

  const instIdx = playerInstance.get(id);
  const inst = instIdx !== undefined ? instances.get(instIdx) : undefined;
  const player = inst ? inst.players[id] : undefined;
  if(!player) return;

  // A fallen player can still resolve an already-offered boon choice — it's
  // not a combat action, and there's no reason a level-up mid-fall (the kill
  // that leveled you up isn't necessarily the one that felled you) should
  // strand the choice until a teammate revives them.
  if(msg.type === 'chooseBoon'){
    applyBoonChoice(player, msg.boonId);
    return;
  }

  if(player.dead) return;
  if(msg.type !== 'input') return;

  // {type:"input", keys:{up,down,left,right}, action:"special1"|"special2"|null}
  // `keys` sets the player's held-direction state, applied to movement every tick.
  // `action` is level-triggered (safe to resend every message while held) — each
  // handler is already cooldown-gated below, so re-sending the same action is a no-op
  // until its cooldown clears. Basic attack is no longer a client action — see
  // tickAutoAttack() and the AUTO-ATTACK note at the top of this file.
  const k = msg.keys || {};
  player.keys.up = !!k.up;
  player.keys.down = !!k.down;
  player.keys.left = !!k.left;
  player.keys.right = !!k.right;

  if(msg.action === 'special1') doSpecial(inst, player, 1);
  else if(msg.action === 'special2') doSpecial(inst, player, 2);
}

// ---------- ADMIN (MASTER_DESIGN.md §8a, 2026-08-26) ----------
// Reached only after handleMessage's isAdmin gate above — every branch
// here assumes that already passed, doesn't re-check it. Family-scale
// tooling: catch-up level sets, unsticking a wedged instance or join
// lock. Deliberately not exposed as a generic "run any server command"
// console — each action is its own explicit, narrow message type.
function handleAdminMessage(id, msg){
  const ws = clients.get(id);
  // Sent back after every action (not just the initial fetch) so the
  // panel reflects the actual new state immediately rather than the
  // admin having to manually hit refresh to see whether their own change
  // took effect.
  function sendOverview(){
    if(!ws) return;
    const roster = FAMILY_IDS.map(fid => ({
      id: fid,
      name: ACCOUNTS[fid].name,
      characters: db.getCharacters(fid),
      activeDungeonIndex: playerInstance.has(fid) ? playerInstance.get(fid) : null
    }));
    const activeInstances = Array.from(instances.keys()).map(idx => ({
      dungeonIndex: idx,
      name: DUNGEONS[idx].name,
      playerIds: Object.keys(instances.get(idx).players)
    }));
    ws.send(JSON.stringify({ type: 'adminOverview', roster, activeInstances }));
  }

  if(msg.type === 'adminGetOverview'){
    sendOverview();
    return;
  }

  if(msg.type === 'adminSetLevel'){
    const targetId = typeof msg.accountId === 'string' ? msg.accountId.toLowerCase() : '';
    if(!ACCOUNTS[targetId]) return;
    const character = db.getCharacter(targetId, msg.characterId);
    if(!character) return; // unknown/stale characterId
    const level = Math.max(1, Math.min(999, Math.round(Number(msg.level)) || 1));
    db.saveCharacterProgress(targetId, msg.characterId, level, 0);
    // If that exact character is the one currently live in an active
    // instance, update the runtime object too — otherwise the change only
    // takes effect on their next join, which reads as "I set it and
    // nothing happened" if they're mid-session right now.
    const targetInstIdx = playerInstance.get(targetId);
    if(targetInstIdx !== undefined){
      const targetInst = instances.get(targetInstIdx);
      const p = targetInst && targetInst.players[targetId];
      if(p && p.characterId === msg.characterId){
        p.level = level; p.xp = 0;
        p.levelMult = levelStatMult(level);
        recomputeMaxHp(p);
      }
    }
    console.log(`[admin] ${id} set ${targetId}'s character ${msg.characterId} to level ${level}`);
    sendOverview();
    return;
  }

  if(msg.type === 'adminResetInstance'){
    const dungeonIndex = Number(msg.dungeonIndex);
    const inst = instances.get(dungeonIndex);
    if(inst){
      for(const pid in inst.players) resetPlayerForFreshRun(inst.players[pid], inst);
      loadRoom(inst, 0);
      console.log(`[admin] ${id} reset instance ${DUNGEONS[dungeonIndex].name}`);
    }
    sendOverview();
    return;
  }

  if(msg.type === 'adminClearJoinLock'){
    // Un-wedges an account stuck thinking it's "already active" in an
    // instance — e.g. after an unclean disconnect the normal grace-period/
    // reconnect flow didn't catch. Removes them from that instance (if
    // they're still sitting in it) and clears the join lock so their next
    // join attempt starts clean rather than being rejected.
    const targetId = typeof msg.accountId === 'string' ? msg.accountId.toLowerCase() : '';
    const targetInstIdx = playerInstance.get(targetId);
    if(targetInstIdx !== undefined){
      const targetInst = instances.get(targetInstIdx);
      if(targetInst) delete targetInst.players[targetId];
      playerInstance.delete(targetId);
      console.log(`[admin] ${id} cleared join lock for ${targetId}`);
    }
    sendOverview();
    return;
  }
}

// ---------- COMBAT ----------
function nearestMonster(inst, player){
  let best = null, bd = Infinity;
  for(const id in inst.monsters){
    const mon = inst.monsters[id];
    if(!mon.alive) continue;
    const d = Math.hypot(mon.x - player.x, mon.y - player.y);
    if(d < bd){ bd = d; best = mon; }
  }
  return best;
}

function forEachAliveMonster(inst, fn){
  for(const id in inst.monsters){
    if(inst.monsters[id].alive) fn(inst.monsters[id]);
  }
}

// Auto-attack + target-lock (§9's "core combat input, shared across all
// classes"). Each alive player keeps a locked target (player.targetId) —
// stays locked while it's alive, rather than re-picking "nearest" on every
// single swing, and only reacquires once that target's gone. Specials stay
// fully manual (doSpecial, driven by client input), unchanged.
function tickAutoAttack(inst){
  for(const id in inst.players){
    const player = inst.players[id];
    if(player.dead || player.cds.attack > 0 || player.stunTimer > 0 || player.fearTimer > 0) continue;

    let target = player.targetId ? inst.monsters[player.targetId] : null;
    if(!target || !target.alive){
      target = nearestMonster(inst, player);
      player.targetId = target ? target.id : null;
    }
    if(!target) continue;

    const c = CLASSES[player.classKey];
    const a = c.attack;
    const inRange = Math.hypot(target.x - player.x, target.y - player.y) < a.range + (a.projectile ? 0 : target.radius);
    if(!inRange) continue;
    if(a.cost && player.mana < a.cost) continue;

    doAttack(inst, player, target);
  }
}

function doAttack(inst, player, target){
  const c = CLASSES[player.classKey];
  const a = c.attack;
  player.cds.attack = a.cd;
  if(a.cost) player.mana -= a.cost;

  let dmgMult = WEAPON_TIERS[player.weaponTier].mult * player.levelMult * player.boonDmgMult;
  // Mordred's Broken Blade — +15% on the first attack against a fresh
  // room's enemies (loadRoom() resets brokenBladeUsedThisRoom), then
  // normal for the rest of the room.
  if(player.artifacts.includes('mordredBrokenBlade') && !player.brokenBladeUsedThisRoom){
    dmgMult *= 1.15;
    player.brokenBladeUsedThisRoom = true;
  }

  if(a.projectile){
    let ang = 0;
    if(target) ang = Math.atan2(target.y - player.y, target.x - player.x);
    inst.projectiles.push({
      id: 'pr' + (++projSeq), ownerId: player.id,
      x: player.x, y: player.y,
      vx: Math.cos(ang) * 420, vy: Math.sin(ang) * 420,
      dmg: a.dmg * player.buffMult * dmgMult, life: a.range / 420, r: 6
    });
  } else {
    // Melee still cleaves everything in range rather than only the locked
    // target — that's how this already felt when manually mashing the old
    // attack button, and target-lock mainly matters for ranged aim/UI here.
    const buffed = a.dmg * player.buffMult * dmgMult;
    forEachAliveMonster(inst, mon=>{
      const d = Math.hypot(mon.x - player.x, mon.y - player.y);
      if(d < a.range + mon.radius) hitMonster(inst, mon, buffed, player.id);
    });
  }
}

function doSpecial(inst, player, slot){
  if(player.stunTimer > 0 || player.fearTimer > 0) return;
  const c = CLASSES[player.classKey];
  const key = 'special' + slot;
  const sp = c[key];
  if(!sp) return;
  if(sp.unlockLevel && player.level < sp.unlockLevel) return; // not learned yet — same silent no-op as a class not having this slot at all
  if(player.cds[key] > 0) return;
  if(sp.cost && player.mana < sp.cost) return;

  player.cds[key] = sp.cd;
  if(sp.cost) player.mana -= sp.cost;

  if(sp.name === "Shield Bash"){
    forEachAliveMonster(inst, mon=>{
      const d = Math.hypot(mon.x - player.x, mon.y - player.y);
      if(d < sp.radius){ hitMonster(inst, mon, sp.dmg, player.id); mon.stunTimer = sp.stun; }
    });
  } else if(sp.name === "Parry"){
    player.blockActive = true; player.blockTimer = sp.dur;
  } else if(sp.name === "Taunt"){
    forEachAliveMonster(inst, mon=>{
      const d = Math.hypot(mon.x - player.x, mon.y - player.y);
      if(d < sp.radius){ mon.tauntTimer = sp.dur; mon.tauntTarget = player.id; }
    });
  } else if(sp.name === "Arcane Nova"){
    forEachAliveMonster(inst, mon=>{
      const d = Math.hypot(mon.x - player.x, mon.y - player.y);
      if(d < sp.radius) hitMonster(inst, mon, sp.dmg, player.id);
    });
  } else if(sp.name === "Healing Light"){
    player.hp = Math.min(player.maxHp, player.hp + sp.heal);
  } else if(sp.name === "Blessing"){
    // Multiplayer party heal + buff, matching the Cleric's "watch the whole party" design.
    for(const id in inst.players){
      const p = inst.players[id];
      if(p.dead) continue;
      p.hp = Math.min(p.maxHp, p.hp + sp.heal);
      p.buffMult = sp.buff; p.buffTimer = sp.buffDur;
    }
  } else if(sp.name === "Mesmerize"){
    // Hard CC on the nearest enemy — bosses resist it outright (mezzing a
    // boss indefinitely would trivialize the fight). Breaks early if that
    // monster takes any damage (see hitMonster), same as classic MMO mez —
    // discourages AoEing a target you meant to keep locked down.
    const target = nearestMonster(inst, player);
    if(target && !target.boss && Math.hypot(target.x - player.x, target.y - player.y) < sp.range){
      target.mesmerizeTimer = sp.dur;
    }
  } else if(sp.name === "Group Haste"){
    for(const id in inst.players){
      const p = inst.players[id];
      if(p.dead) continue;
      p.hasteMult = sp.mult; p.hasteTimer = sp.dur;
    }
  } else if(sp.name === "Second Wind"){
    // Self-only, no aim — a flat heal plus a brief incoming-damage
    // reduction (checked in damagePlayer), not a spell. Keeps Squire's
    // "hard to go wrong" identity now that he has two buttons.
    player.hp = Math.min(player.maxHp, player.hp + sp.heal);
    player.shieldMult = 1 - sp.shield; player.shieldTimer = sp.shieldDur;
  } else if(sp.name === "Blink"){
    // Instant reposition away from the nearest monster — answers
    // Apprentice's real weakness (low HP, no mobility) rather than being
    // filler. Falls back to the currently-held movement direction if no
    // monster is around to flee from. Routed through moveWithWalls (§9's
    // wall collision) the same way normal movement/Fear's forced-flee
    // already are, so a blink can't teleport straight through a wall.
    const near = nearestMonster(inst, player);
    let dx, dy;
    if(near){
      const d = Math.hypot(player.x - near.x, player.y - near.y) || 1;
      dx = (player.x - near.x) / d; dy = (player.y - near.y) / d;
    } else {
      const mv = movementVector(player.keys);
      dx = mv.mx; dy = mv.my;
    }
    if(dx !== 0 || dy !== 0){
      // moveWithWalls only checks the destination point, not the path to
      // it — fine for small per-tick moves, but one big 220px jump can
      // land clean on the far side of a wall thinner than that without the
      // destination ever overlapping it ("tunneling"). Broken into small
      // sub-steps so each one is well under typical wall thickness — same
      // trick that keeps normal per-tick movement from tunneling, applied
      // manually here since this is one instant jump, not many ticks.
      const walls = currentRoom(inst).walls;
      const steps = 20;
      for(let i = 0; i < steps; i++) moveWithWalls(player, dx * sp.dist / steps, dy * sp.dist / steps, walls);
      player.x = Math.max(player.radius, Math.min(W - player.radius, player.x));
      player.y = Math.max(player.radius + 60, Math.min(H - player.radius, player.y));
    }
  }
}

function hitMonster(inst, mon, dmg, killerId){
  mon.mesmerizeTimer = 0; // any damage breaks Mesmerize
  mon.hp -= dmg;
  if(mon.hp <= 0 && mon.alive){
    mon.alive = false;
    dropLoot(inst, mon);
    const killer = inst.players[killerId];
    if(killer){
      killer.totalKills++;
      grantXp(inst, killer, xpForKill(mon));
      db.savePlayerStats(killer);
    }
    inst.dungeonKillCount++; // feeds the post-dungeon summary screen, see onBossDefeated()
    if(inst.waveState) inst.waveState.killsSoFar++; // drives tickWaveSpawns()'s escalation
    if(mon.boss) onBossDefeated(inst, mon);
  }
}

// Drops are typed now (§7's three-slot gear, 2026-08-24) — kind is
// 'weapon'|'armor'|'artifact', with artifactId set for the latter. A trash/
// side-chamber drop rolls weapon-or-armor 50/50; a boss always drops its
// own artifact (js/data.js's ARTIFACTS, matched by bossType) plus one
// weapon/armor token, so a boss fight is always a double reward. The rare
// variant's old "drops twice" bonus becomes an extra weapon/armor token on
// top of its own artifact, preserving "the rare variant drops more."
//
// TRASH_GEAR_DROP_CHANCE was 0.35 at launch (2026-08-24) — with only 4
// tiers per ladder (3 upgrades needed) and Sherwood's main path alone
// throwing ~23 trash kills at a solo player (before any side chamber),
// that maxed both weapon and armor well inside one dungeon clear, which
// defeats the point of gear being a persistent-campaign progression
// (MASTER_DESIGN.md's permanent-levels-and-gear decision). Dropped to
// 0.12 (2026-08-25). Raised to 0.20 (2026-08-26, alongside the tier-roll
// below) — a "drop" is no longer a guaranteed upgrade, so seeing one more
// often is fine now that it doesn't automatically max gear out.
const TRASH_GEAR_DROP_CHANCE = 0.20;

// Weapon/armor loot used to be a guaranteed +1 tier on pickup — every
// "drop" was really just an invisible stat counter, nothing to actually
// find. 2026-08-26: every weapon/armor drop now rolls its own tier
// (weighted toward the common end, same shape for both ladders since both
// currently have 4 tiers — js/data.js's WEAPON_TIERS/ARMOR_TIERS), and
// only replaces your equipped tier if it actually rolled higher. A roll
// that doesn't beat what you're already carrying gets melted down for a
// little family currency instead of just vanishing — see applyLootPickup.
// "Guaranteed drop" (a side chamber, a boss token) now means guaranteed a
// roll, not a guaranteed upgrade — matches the tougher rooms still feeling
// worth it on average without making the top tier a sure thing.
const GEAR_DROP_WEIGHTS = [50, 30, 15, 5]; // index = tier; Excalibur/Aegis is the 5% tail
const SALVAGE_CURRENCY_BASE = 3, SALVAGE_CURRENCY_PER_TIER = 2;
function rollGearTier(){
  const total = GEAR_DROP_WEIGHTS.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for(let i = 0; i < GEAR_DROP_WEIGHTS.length; i++){
    if(roll < GEAR_DROP_WEIGHTS[i]) return i;
    roll -= GEAR_DROP_WEIGHTS[i];
  }
  return GEAR_DROP_WEIGHTS.length - 1;
}
function randomGearKind(){ return Math.random() < 0.5 ? 'weapon' : 'armor'; }
function pushGearLoot(inst, x, y, kind, artifactId){
  const tier = (kind === 'weapon' || kind === 'armor') ? rollGearTier() : null;
  inst.loot.push({ id: 'l' + (++lootSeq), x, y, taken: false, kind, artifactId: artifactId || null, tier });
}

function dropLoot(inst, mon){
  if(mon.boss){
    const artifactId = artifactIdForBoss(mon.type);
    if(artifactId) pushGearLoot(inst, mon.x, mon.y, 'artifact', artifactId);
    pushGearLoot(inst, mon.x + 20, mon.y + 20, randomGearKind());
    // Rare boss variant guarantees an extra token on top of its own
    // artifact above — see js/data.js's blackKnightRare/rareVariant.
    if(mon.type === 'blackKnightRare'){
      pushGearLoot(inst, mon.x - 20, mon.y - 20, randomGearKind());
    }
    return;
  }
  // Guaranteed drop inside a side chamber, or a standalone room flagged
  // `guaranteedLoot` (js/data.js — 2026-08-26's hub-and-spoke pass promoted
  // the Poacher's Den out of `sideChamber`, so `branchState` alone no
  // longer covers it) — that's the whole point of the harder detour.
  if(inst.branchState === 'in_side_chamber' || currentRoom(inst).guaranteedLoot || Math.random() < TRASH_GEAR_DROP_CHANCE){
    pushGearLoot(inst, mon.x, mon.y, randomGearKind());
  }
}

// Returns whether the hit actually landed (false if spawn-protected or
// Buckler-blocked entirely) — callers that layer a secondary effect on top
// of damage (e.g. Bandit Captain's slam stun) check this so a fully-blocked
// hit doesn't still stun.
function damagePlayer(inst, player, dmg){
  if(player.spawnProtection > 0) return false;
  dmg *= soloDangerMult(inst);

  // Ford-Warden's Buckler — already below 25% HP and its 20s cooldown is
  // ready: block this hit entirely rather than reduce it. Checked before
  // applying damage, using current HP (the trigger is "already critical,"
  // not "this hit would make you critical").
  if(player.artifacts.includes('fordWardenBuckler') && player.fordBucklerCd <= 0
     && player.hp < player.maxHp * 0.25){
    player.fordBucklerCd = 20;
    return false;
  }

  const armorMult = ARMOR_TIERS[player.armorTier].mult;
  // Squire's Second Wind (shieldMult, set in doSpecial) — a brief flat
  // damage-reduction window, applied before armor's own reduction.
  const reduced = dmg * player.shieldMult / (0.6 + armorMult * 0.4);
  player.hp -= reduced;
  if(player.hp <= 0 && !player.dead){
    // The Green Knight's Girdle — once per dungeon run, a killing blow
    // leaves you at 1 HP instead of dying. Straight from the legend.
    if(player.artifacts.includes('greenKnightGirdle') && !player.girdleUsedThisRun){
      player.girdleUsedThisRun = true;
      player.hp = 1;
      return true;
    }
    player.dead = true; player.hp = 0;
    player.totalDeaths++;
    db.savePlayerStats(player);
    console.log(`[death] ${player.id} fell in ${currentDungeon(inst).name}`);
    checkForWipe(inst);
  }
  return true;
}

// Called after every death — if nobody currently connected is left alive
// to revive anyone, the party can't recover on its own. Resets the
// instance back to its own safe room (not a character/account reset) once
// the moment has had a beat to land. Harmless if it fires more than once
// for the same wipe (e.g. two players die in the same tick) — resetting
// already-alive/full-HP players and reloading room 0 again is a no-op.
// Shared by the automatic wipe-reset below and the admin "reset instance"
// action (2026-08-26) — both mean the same thing: send this player back to
// the dungeon's safe room at full health with no run-scoped state carried
// over. A wipe is the "die" half of boons' "gone if you leave or die"
// (§10) — reset before recomputeMaxHp so ironWill's HP bump doesn't
// survive into the reset run.
function resetPlayerForFreshRun(p, inst){
  p.dead = false;
  p.boonHpMult = 1; p.boonDmgMult = 1; p.boonSpeedMult = 1;
  p.pendingBoonChoices = [];
  recomputeMaxHp(p);
  p.hp = p.maxHp;
  if(p.maxMana) p.mana = p.maxMana;
  p.reviveProgress = 0;
  p.spawnProtection = SPAWN_GRACE;
  const spot = pickSpawnPoint(inst);
  p.x = spot.x; p.y = spot.y;
}

function checkForWipe(inst){
  const ids = Object.keys(inst.players);
  if(ids.length === 0) return;
  const anyoneAliveAndConnected = ids.some(id => !inst.players[id].dead && clients.has(id));
  if(anyoneAliveAndConnected) return;
  console.log(`[wipe] the party has fallen in ${currentDungeon(inst).name} — resetting to the safe room`);
  setTimeout(()=>{
    for(const id in inst.players) resetPlayerForFreshRun(inst.players[id], inst);
    loadRoom(inst, 0);
  }, 2000);
}

function onBossDefeated(inst, mon){
  const d = currentDungeon(inst);
  const elapsedSeconds = (Date.now() - inst.dungeonStartedAt) / 1000;

  // Campaign victory is a one-shot computed event, not stored state: was
  // this dungeon NOT already in the family's cleared list before this
  // exact kill, and does clearing it now complete all of them? Checked
  // before/after recordDungeonClear so it only fires once, on the actual
  // completing clear — not on every later replay of whichever dungeon
  // happened to be last.
  const wasAlreadyCleared = db.getFamilyState().dungeonsCleared.includes(d.name);
  db.recordDungeonClear(d.name, elapsedSeconds); // marks this dungeon cleared + only overwrites the best time if this beats it
  const nowCleared = db.getFamilyState().dungeonsCleared;
  const campaignVictory = !wasAlreadyCleared && nowCleared.length === DUNGEONS.length;

  // Currency-on-clear (first thing that actually calls addFamilyCurrency —
  // see MASTER_DESIGN.md §11/§12 Phase 5, which has no spend destination
  // yet, this just starts the number moving). Amount and defeat flavor
  // text both come from the monster type so a rare variant (js/data.js's
  // blackKnightRare) pays out more without any dungeon-specific code here.
  const t = ENEMY_TYPES[mon.type];
  const reward = t.rewardCurrency || 30;
  db.addFamilyCurrency(reward);

  // A dedicated dungeon-complete screen (client-side, see js/main.js)
  // shows this until the player dismisses it and returns to dungeon-select
  // (returnToDungeonSelect) — there's no more fixed "next dungeon" to
  // auto-advance into now that any dungeon can be picked.
  inst.dungeonSummary = {
    dungeonName: d.name,
    flavorText: t.defeatText || d.bossDefeatText,
    rare: !!t.displayName,
    currencyEarned: reward,
    familyCurrencyTotal: db.getFamilyState().currency,
    elapsedSeconds: Math.round(elapsedSeconds),
    kills: inst.dungeonKillCount,
    campaignVictory
  };
  console.log(`[boss defeated] ${d.name} in ${elapsedSeconds.toFixed(1)}s — +${reward} currency${campaignVictory ? ' — CAMPAIGN VICTORY' : ''}`);

  inst.advancing = true;
  setTimeout(()=>{
    inst.advancing = false;
    inst.dungeonSummary = null;
  }, 2000); // just a short beat — the summary screen, not this pause, is what gives time to read
}

// The safe room has no monsters to clear, so it needs its own advance
// trigger: a player walking into the exit spot. Sherwood Approach's safe
// room (dungeonIndex 0) lets anyone currently here through — no family
// requirement, ever. Any other dungeon the family hasn't cleared yet also
// needs all 4 family accounts present in this instance and connected
// before the exit does anything; standing at it otherwise just sets
// `waitingForFamily` so clients know why nothing happened yet, and it
// keeps re-checking every tick without needing a separate retry timer.
// Once a dungeon's been cleared once, this gate never applies to it again.
function tickSafeRoom(inst){
  const room = currentRoom(inst);
  if(!room.safe){ inst.waitingForFamily = false; return; }
  const someoneAtExit = Object.values(inst.players).some(p =>
    !p.dead && Math.hypot(p.x - SAFE_EXIT_X, p.y - SAFE_EXIT_Y) < SAFE_EXIT_RADIUS);
  if(!someoneAtExit){ inst.waitingForFamily = false; return; }

  const dungeon = currentDungeon(inst);
  const alreadyCleared = db.getFamilyState().dungeonsCleared.includes(dungeon.name);
  if(inst.dungeonIndex > 0 && !alreadyCleared && !familyFullyConnected(inst)){
    inst.waitingForFamily = true;
    return;
  }
  inst.waitingForFamily = false;
  loadRoom(inst, 1);
}

// Same shape as loadRoom(), but for the optional side chamber — doesn't
// touch roomIndex, so the main path's position is preserved for the trip
// back (see tickBranch()'s 'side_cleared_awaiting_return' case).
function loadSideChamber(inst){
  for(const id in inst.monsters) delete inst.monsters[id];
  inst.loot = [];
  const sc = currentRoom(inst).sideChamber;
  sc.enemies.forEach(e=> spawnMonster(inst, e.type, e.x, e.y));
  console.log(`[room] ${currentDungeon(inst).name} — side chamber: ${sc.name} (${sc.enemies.length} monsters)`);
}

// Drives the fork once a `branch: true` room is cleared (see tickMonsters)
// — awaiting_choice shows both gates; walking into the main one continues
// exactly as any other room would, the side one detours into the harder,
// guaranteed-loot chamber. Clearing that chamber opens a single return
// gate leading to the same next room the main path would have reached.
function tickBranch(inst){
  if(inst.branchState === 'awaiting_choice'){
    if(someoneAt(inst, mainExitFor(inst))){
      inst.branchState = null;
      advanceToNextRoom(inst);
    } else if(someoneAt(inst, sideExitFor(inst))){
      inst.branchState = 'in_side_chamber';
      loadSideChamber(inst);
    }
  } else if(inst.branchState === 'side_cleared_awaiting_return'){
    if(someoneAt(inst, returnExitFor(inst))){
      inst.branchState = null;
      advanceToNextRoom(inst);
    }
  }
}

// Drives a plain (non-branch, non-boss) room's exit gate(s) once it's
// cleared — see the 'awaiting_exit' assignment in tickMonsters() and
// doorsFor(). Loads whichever door's target directly (not
// advanceToNextRoom() — a door's `to` isn't necessarily roomIndex+1 once a
// room defines real `doors`, e.g. the hub's three-way choice).
function tickRoomExit(inst){
  if(inst.roomState !== 'awaiting_exit') return;
  for(const door of doorsFor(inst)){
    if(someoneAt(inst, door.exit)){
      inst.roomState = null;
      loadRoom(inst, door.to, door.dir && OPPOSITE_DIR[door.dir]);
      return;
    }
  }
}

// A dead player only comes back by having an alive, connected teammate
// hold near them for REVIVE_CHANNEL_SECONDS — see the REVIVE/WIPE note at
// the top of this file. Leaving range resets progress immediately rather
// than decaying, so a reviver has to actually commit to standing still
// (often next to whatever just killed the fallen player) rather than
// poke in and out safely.
function tickRevive(inst, dt){
  for(const id in inst.players){
    const p = inst.players[id];
    if(!p.dead) continue;
    const reviver = Object.values(inst.players).find(o =>
      o.id !== p.id && !o.dead && clients.has(o.id) && Math.hypot(o.x - p.x, o.y - p.y) < REVIVE_RANGE);
    if(!reviver){
      p.reviveProgress = 0;
      continue;
    }
    p.reviveProgress += dt;
    if(p.reviveProgress >= REVIVE_CHANNEL_SECONDS){
      p.dead = false;
      p.hp = p.maxHp * REVIVE_HP_FRACTION;
      p.spawnProtection = SPAWN_GRACE;
      p.reviveProgress = 0;
      console.log(`[revive] ${p.id} revived by ${reviver.id} in ${currentDungeon(inst).name}`);
    }
  }
}

// ---------- MONSTER AI ----------
function pickTarget(inst, mon){
  if(mon.tauntTimer > 0 && mon.tauntTarget){
    const t = inst.players[mon.tauntTarget];
    if(t && !t.dead) return t;
  }
  let best = null, bd = Infinity;
  for(const id in inst.players){
    const p = inst.players[id];
    if(p.dead) continue;
    const d = Math.hypot(p.x - mon.x, p.y - mon.y);
    if(d < bd){ bd = d; best = p; }
  }
  return best;
}

function tickMonsters(inst, dt){
  let allDead = true;
  for(const id in inst.monsters){
    const mon = inst.monsters[id];
    if(!mon.alive) continue;
    allDead = false;
    if(mon.stunTimer > 0){ mon.stunTimer -= dt; continue; }
    if(mon.mesmerizeTimer > 0){ mon.mesmerizeTimer -= dt; continue; }
    if(mon.tauntTimer > 0) mon.tauntTimer -= dt;

    const target = pickTarget(inst, mon);

    // Slam AoE — gated on "has slam fields" rather than "is a boss", so the
    // Bandit Captain mini-boss (js/data.js) gets the same telegraphed-AoE
    // behavior without being flagged boss:true (which also affects
    // Mesmerize immunity and onBossDefeated()/dungeon-advance below —
    // neither should fire for a mini-boss kill).
    if(mon.slamRadius){
      mon.slamCd -= dt;
      if(mon.slamState === 'telegraph'){
        mon.slamTimer -= dt;
        if(mon.slamTimer <= 0){
          mon.slamState = null;
          // Slam is an AoE that hits every nearby player, not just one.
          for(const pid in inst.players){
            const p = inst.players[pid];
            if(p.dead) continue;
            const d = Math.hypot(p.x - mon.x, p.y - mon.y);
            if(d < mon.slamRadius){
              const pc = CLASSES[p.classKey];
              const canBlock = p.blockActive && pc.special1 && pc.special1.block;
              const landed = damagePlayer(inst, p, canBlock ? mon.slamDmg * (1 - pc.special1.block) : mon.slamDmg);
              // Bandit Captain's slamStunDur (js/data.js) — a fully-blocked
              // hit (Buckler/spawn protection) shouldn't still stun.
              if(landed && mon.slamStunDur) p.stunTimer = Math.max(p.stunTimer, mon.slamStunDur);
            }
          }
          mon.slamCd = 4.5;
        }
      } else if(mon.slamCd <= 0){
        mon.slamState = 'telegraph'; mon.slamTimer = mon.slamTelegraph;
      }
    }

    // Charge — a second, distinct boss mechanic (js/data.js's blackKnight
    // charge* fields; §3's "every boss shares one mechanic" gap, chipped
    // at for this one boss). Direction locks in when the telegraph starts,
    // not when the dash commits, so it's actually dodgeable rather than
    // tracking the target live.
    if(mon.chargeSpeed){
      mon.chargeCd -= dt;
      if(mon.chargeState === 'telegraph'){
        mon.chargeTimer -= dt;
        if(mon.chargeTimer <= 0){
          mon.chargeState = 'dashing'; mon.chargeTimer = 0.35; mon.chargeHit = {};
        }
      } else if(mon.chargeState === 'dashing'){
        mon.x += mon.chargeDirX * mon.chargeSpeed * dt;
        mon.y += mon.chargeDirY * mon.chargeSpeed * dt;
        mon.x = Math.max(mon.radius, Math.min(W - mon.radius, mon.x));
        mon.y = Math.max(mon.radius + 60, Math.min(H - mon.radius, mon.y));
        for(const pid in inst.players){
          const p = inst.players[pid];
          if(p.dead || mon.chargeHit[pid]) continue;
          if(Math.hypot(p.x - mon.x, p.y - mon.y) < mon.radius + p.radius + 10){
            mon.chargeHit[pid] = true;
            damagePlayer(inst, p, mon.chargeDmg);
          }
        }
        mon.chargeTimer -= dt;
        if(mon.chargeTimer <= 0){
          mon.chargeState = null;
          mon.chargeCd = ENEMY_TYPES[mon.type].chargeCd;
        }
      } else if(mon.chargeCd <= 0){
        const tgt = pickTarget(inst, mon);
        const ang = tgt ? Math.atan2(tgt.y - mon.y, tgt.x - mon.x) : 0;
        mon.chargeDirX = Math.cos(ang); mon.chargeDirY = Math.sin(ang);
        mon.chargeState = 'telegraph'; mon.chargeTimer = mon.chargeTelegraph;
      }
    }

    // Fear — a third, distinct boss mechanic (js/data.js's blackKnight
    // fear* fields, MASTER_DESIGN.md §5's boss-differentiation idea bank).
    // A telegraphed warcry: once it lands, every player still in range
    // gets fearTimer set instead of taking damage — tickPlayers() turns
    // that into forced movement away from this monster and blocks their
    // attacks while it lasts. Won't start mid-slam/charge-telegraph so
    // the three mechanics don't stack their tells on top of each other.
    if(mon.fearRadius){
      mon.fearCd -= dt;
      if(mon.fearState === 'telegraph'){
        mon.fearCastTimer -= dt;
        if(mon.fearCastTimer <= 0){
          mon.fearState = null;
          for(const pid in inst.players){
            const p = inst.players[pid];
            if(p.dead) continue;
            const d = Math.hypot(p.x - mon.x, p.y - mon.y);
            if(d < mon.fearRadius){
              p.fearTimer = mon.fearDur;
              p.fearSourceId = mon.id;
            }
          }
          mon.fearCd = ENEMY_TYPES[mon.type].fearCd;
        }
      } else if(mon.fearCd <= 0 && mon.slamState !== 'telegraph' && !mon.chargeState){
        mon.fearState = 'telegraph'; mon.fearCastTimer = mon.fearTelegraph;
      }
    }

    if(!target){ continue; }

    const d = Math.hypot(target.x - mon.x, target.y - mon.y);
    if(mon.slamState !== 'telegraph' && !mon.chargeState && mon.fearState !== 'telegraph'){
      if(d > mon.range * 0.7){
        const walls = currentRoom(inst).walls;
        const goal = wallAwareGoal(mon.x, mon.y, target.x, target.y, walls, mon.radius);
        const gd = Math.hypot(goal.x - mon.x, goal.y - mon.y) || 1;
        moveWithWalls(mon, (goal.x - mon.x) / gd * mon.speed * dt, (goal.y - mon.y) / gd * mon.speed * dt, walls);
      } else {
        mon.cd -= dt;
        if(mon.cd <= 0){
          damagePlayer(inst, target, mon.dmg);
          mon.cd = ENEMY_TYPES[mon.type].cd;
        }
      }
    }
  }

  // A wave room (js/data.js's `wave: true`) isn't "cleared" just because
  // the board is momentarily empty — tickWaveSpawns() keeps refilling it
  // until the kill quota is hit. Every other room keeps the original
  // all-dead-means-cleared behavior.
  const waveState = inst.waveState;
  const waveStillGoing = waveState && waveState.killsSoFar < waveState.killTarget;
  if(allDead && Object.keys(inst.monsters).length > 0 && !inst.advancing && !waveStillGoing){
    if(inst.branchState === 'in_side_chamber'){
      inst.branchState = 'side_cleared_awaiting_return'; // wait for a player to walk to the return gate — see tickBranch()
    } else if(inst.branchState === null && inst.roomState === null && !currentRoom(inst).boss){
      if(currentRoom(inst).branch){
        inst.branchState = 'awaiting_choice'; // fork: don't auto-advance, wait for a gate choice — see tickBranch()
        // Secret nook (js/data.js's `secretNook`, real spatial exploration —
        // MASTER_DESIGN.md §9): a guaranteed loot token sitting in a
        // dead-end pocket the walls make you actually go looking for,
        // reusing the existing floor-pickup system rather than a new
        // mechanic. Reward is finding it, so it's unguarded on purpose.
        const nook = currentRoom(inst).secretNook;
        if(nook) pushGearLoot(inst, nook.x, nook.y, randomGearKind());
      } else {
        // Binding of Isaac-style room clear (MASTER_DESIGN.md §9,
        // 2026-08-26) — a gate opens rather than the party getting blindly
        // teleported on a timer. See tickRoomExit().
        inst.roomState = 'awaiting_exit';
        inst.clearedRooms.add(inst.roomIndex); // backtracking memory (2026-08-26) — see loadRoom()
        // One guaranteed drop on top of the normal per-kill rolls, once
        // (js/data.js's `clearBonusLoot` — the Sunken Trail, since it
        // became an optional hub door 2026-08-26) — same "guaranteed find"
        // shape as Forest Crossroads' secretNook, not a per-kill guarantee
        // across 14+ kills, which would undercut the tier-roll system.
        if(currentRoom(inst).clearBonusLoot) pushGearLoot(inst, W / 2, H / 2, randomGearKind());
      }
    }
  }
}

// ---------- PLAYERS / PROJECTILES / LOOT ----------
function movementVector(keys){
  let mx = 0, my = 0;
  if(keys.up) my -= 1;
  if(keys.down) my += 1;
  if(keys.left) mx -= 1;
  if(keys.right) mx += 1;
  const len = Math.hypot(mx, my);
  if(len > 0){ mx /= len; my /= len; }
  return { mx, my };
}

function tickPlayers(inst, dt){
  for(const id in inst.players){
    const p = inst.players[id];
    if(p.dead) continue;

    // Stun/fear (MASTER_DESIGN.md §5) override normal input-driven movement
    // entirely while active — stunned means frozen in place, feared means
    // fleeing the fear source regardless of what keys are held. tickAutoAttack
    // and doSpecial separately gate attacks on both timers.
    const walls = currentRoom(inst).walls;
    if(p.stunTimer > 0){
      p.stunTimer = Math.max(0, p.stunTimer - dt);
    } else if(p.fearTimer > 0){
      p.fearTimer = Math.max(0, p.fearTimer - dt);
      const src = inst.monsters[p.fearSourceId];
      if(src){
        const d = Math.hypot(p.x - src.x, p.y - src.y) || 1;
        moveWithWalls(p, (p.x - src.x) / d * p.speed * dt, (p.y - src.y) / d * p.speed * dt, walls);
      }
    } else {
      const { mx, my } = movementVector(p.keys);
      if(mx !== 0 || my !== 0){
        moveWithWalls(p, mx * p.speed * p.hasteMult * p.boonSpeedMult * dt, my * p.speed * p.hasteMult * p.boonSpeedMult * dt, walls);
      }
    }
    p.x = Math.max(p.radius, Math.min(W - p.radius, p.x));
    p.y = Math.max(p.radius + 60, Math.min(H - p.radius, p.y));

    Object.keys(p.cds).forEach(k => p.cds[k] = Math.max(0, p.cds[k] - dt));
    const c = CLASSES[p.classKey];
    if(p.maxMana) p.mana = Math.min(p.maxMana, p.mana + c.manaRegen * dt);
    if(p.blockTimer > 0){ p.blockTimer -= dt; if(p.blockTimer <= 0) p.blockActive = false; }
    if(p.shieldTimer > 0){ p.shieldTimer -= dt; if(p.shieldTimer <= 0) p.shieldMult = 1; }
    if(p.buffTimer > 0){ p.buffTimer -= dt; if(p.buffTimer <= 0) p.buffMult = 1; }
    if(p.hasteTimer > 0){ p.hasteTimer -= dt; if(p.hasteTimer <= 0) p.hasteMult = 1; }
    if(p.spawnProtection > 0) p.spawnProtection = Math.max(0, p.spawnProtection - dt);
    if(p.fordBucklerCd > 0) p.fordBucklerCd = Math.max(0, p.fordBucklerCd - dt);
  }
}

function tickProjectiles(inst, dt){
  inst.projectiles.forEach(pr=>{
    pr.x += pr.vx * dt; pr.y += pr.vy * dt; pr.life -= dt;
    forEachAliveMonster(inst, mon=>{
      if(pr.dead) return;
      if(Math.hypot(mon.x - pr.x, mon.y - pr.y) < mon.radius + pr.r){ hitMonster(inst, mon, pr.dmg, pr.ownerId); pr.dead = true; }
    });
  });
  inst.projectiles = inst.projectiles.filter(pr => pr.life > 0 && !pr.dead);
}

// Applies a typed loot drop (dropLoot()'s kind:'weapon'|'armor'|'artifact')
// to whoever picked it up, then persists immediately — same "write on key
// event" pattern already used for kills/deaths. Picking up an artifact
// already owned is a harmless no-op (still consumed off the ground, no
// duplicate) — simplest handling, no need to special-case "don't spawn it
// again" server-side.
// Weapon/armor pickups jump straight to the rolled tier (js/data.js's
// pushGearLoot) rather than always stepping +1 — only if that tier is
// actually better than what's equipped. A roll that isn't an upgrade
// melts down into a bit of family currency instead of doing nothing, so
// picking it up still means something even when it isn't a new item.
function applyLootPickup(player, l){
  if(l.kind === 'weapon' || l.kind === 'armor'){
    const field = l.kind === 'weapon' ? 'weaponTier' : 'armorTier';
    if(l.tier > player[field]) player[field] = l.tier;
    else db.addFamilyCurrency(SALVAGE_CURRENCY_BASE + l.tier * SALVAGE_CURRENCY_PER_TIER);
  } else if(l.kind === 'artifact' && l.artifactId){
    if(!player.artifacts.includes(l.artifactId)) player.artifacts.push(l.artifactId);
  }
  db.savePlayerStats(player);
}

function tickLoot(inst){
  inst.loot.forEach(l=>{
    if(l.taken) return;
    for(const id in inst.players){
      const p = inst.players[id];
      if(p.dead) continue;
      if(Math.hypot(l.x - p.x, l.y - p.y) < p.radius + 16){
        l.taken = true;
        applyLootPickup(p, l);
        break;
      }
    }
  });
  inst.loot = inst.loot.filter(l => !l.taken);
}

// ---------- TICK LOOP ----------
// {type:"state", players:[...], monsters:[...], projectiles:[...], tick:N}
// Arrays, each element carrying its own `id` — plus a few extra fields
// (roomId, dungeonName, boss, etc) the client needs for HUD/progression
// that don't fit the three core entity lists. Sent only to clients
// currently inside this instance, not broadcast globally.
function broadcastInstanceState(inst){
  const payload = JSON.stringify({
    type: 'state',
    tick: tickCount,
    roomId: currentRoomId(inst),
    dungeonName: currentDungeon(inst).name,
    boss: !!currentRoom(inst).boss,
    safe: !!currentRoom(inst).safe,
    safeExit: { x: SAFE_EXIT_X, y: SAFE_EXIT_Y, r: SAFE_EXIT_RADIUS },
    branch: inst.branchState ? {
      state: inst.branchState,
      mainExit: mainExitFor(inst),
      sideExit: sideExitFor(inst),
      returnExit: returnExitFor(inst)
    } : null,
    wave: inst.waveState ? { killsSoFar: inst.waveState.killsSoFar, killTarget: inst.waveState.killTarget } : null,
    doors: inst.roomState === 'awaiting_exit'
      ? doorsFor(inst).map(d => ({ x: d.exit.x, y: d.exit.y, r: d.exit.r, label: d.label || 'Continue on', color: d.color || null }))
      : null,
    family: db.getFamilyState(),
    dungeonsCleared: db.getFamilyState().dungeonsCleared,
    dungeonSummary: inst.dungeonSummary,
    waitingForFamily: inst.waitingForFamily,
    players: Object.values(inst.players),
    monsters: Object.values(inst.monsters),
    projectiles: inst.projectiles,
    loot: inst.loot
  });
  for(const pid in inst.players){
    const ws = clients.get(pid);
    if(ws && ws.readyState === 1) ws.send(payload);
  }
}

let lastTick = Date.now();
let tickCount = 0;
setInterval(()=>{
  tickCount++;
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;

  // Each instance's tick is isolated — an uncaught exception in one
  // family's dungeon run used to crash this whole setInterval callback,
  // which crashes the entire Node process (Node re-throws a synchronous
  // error from an event/timer callback and exits by default), taking
  // down every OTHER instance and every connected player along with it.
  // One bad edge case in one room shouldn't be able to freeze the game
  // for the whole family — same "a failure here can't take down the
  // actual game" principle db.js already applies to persistence.
  for(const [idx, inst] of instances){
    try {
      tickPlayers(inst, dt);
      tickAutoAttack(inst);
      tickMonsters(inst, dt);
      tickWaveSpawns(inst, dt);
      tickProjectiles(inst, dt);
      tickLoot(inst);
      tickSafeRoom(inst);
      tickBranch(inst);
      tickRoomExit(inst);
      tickRevive(inst, dt);
      broadcastInstanceState(inst);
    } catch (err) {
      console.error(`[tick] error in instance ${idx} (${DUNGEONS[idx] ? DUNGEONS[idx].name : '?'}):`, err);
    }
  }

  // Instance cleanup — run state was always ephemeral (see the top-of-file
  // INSTANCES note); once nobody's left in one, there's nothing worth
  // keeping around simulating.
  for(const [idx, inst] of instances){
    if(Object.keys(inst.players).length === 0){
      instances.delete(idx);
      console.log(`[instance] torn down: ${DUNGEONS[idx].name}`);
    }
  }
}, TICK_MS);

console.log(`Quest for Camelot server listening on ws://${HOST}:${PORT}`);
