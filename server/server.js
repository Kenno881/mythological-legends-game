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
const { CLASSES, GEAR_TIERS, DUNGEONS, ENEMY_TYPES, REVIVE_CHANNEL_SECONDS } = require('../js/data.js');
const db = require('./db.js');

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

// Picks a spawn point near the room's entrance, biased away from whatever
// monsters are currently alive in this instance — so a join/rejoin mid-fight
// doesn't land someone in the middle of it just because the fight has
// drifted toward the entrance over time. Falls back to the entrance itself
// if nothing is alive (or all candidates are equally boxed in).
function pickSpawnPoint(inst){
  let best = { x: ENTRANCE_X, y: ENTRANCE_Y };
  let bestDist = -Infinity;
  for(let i = 0; i < SPAWN_CANDIDATES; i++){
    const x = ENTRANCE_X + (Math.random() * 2 - 1) * SPAWN_SEARCH_RADIUS;
    const y = ENTRANCE_Y + (Math.random() * 2 - 1) * SPAWN_SEARCH_RADIUS;
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
const ACCOUNTS = {
  dad:    { name: 'Dad',    isTest: false },
  mum:    { name: 'Mum',    isTest: false },
  amelia: { name: 'Amelia', isTest: false },
  declan: { name: 'Declan', isTest: false },
  test:   { name: 'test',   isTest: true }
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
    waveState: null, branchState: null
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
    chargeCd: t.chargeCd || 0, chargeState: null, chargeTimer: 0
  });
  return inst.monsters[id];
}

function loadRoom(inst, idx){
  inst.roomIndex = idx;
  inst.branchState = null; // any branch fork is resolved (or moot) whenever a fresh room loads
  inst.waveState = null;
  if(idx === 1){ inst.dungeonStartedAt = Date.now(); inst.dungeonKillCount = 0; } // idx 0 is always the safe room — the real run starts on leaving it
  const dungeon = currentDungeon(inst);
  const room = dungeon.rooms[idx];
  for(const id in inst.monsters) delete inst.monsters[id];
  inst.loot = [];

  if(room.wave){
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

function someoneAt(inst, spot){
  return Object.values(inst.players).some(p => !p.dead && Math.hypot(p.x - spot.x, p.y - spot.y) < spot.r);
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
  '.png': 'image/png'
};

function resolveStaticFile(urlPath){
  if(urlPath === '/' || urlPath === '/camelot-crawler.html'){
    return path.join(CLIENT_ROOT, 'camelot-crawler.html');
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
      characters: db.getCharacters(id), isTest: ACCOUNTS[id].isTest,
      dungeonsCleared: db.getFamilyState().dungeonsCleared
    }));
    console.log(`[connect] ${id}${resuming ? ' (resuming)' : ''}`);
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

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
    // Refuse to clobber a live entry, dead or alive — a dead one now needs
    // reviving (or a full wipe) rather than a fresh join; see REVIVE/WIPE
    // at the top of this file. Only ever runs against an account with no
    // active instance at all: a brand new session, or right after
    // returnToDungeonSelect/leaveDungeon.
    if(playerInstance.has(id)) return;
    const character = db.getCharacter(id, msg.characterId);
    if(!character) return; // unknown/stale characterId — client's roster is out of sync, ignore
    const dungeonIndex = Number(msg.dungeonIndex);
    if(!Number.isInteger(dungeonIndex) || dungeonIndex < 0 || dungeonIndex >= DUNGEONS.length) return;

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
      gearTier: 0,
      targetId: null, // auto-attack's locked target — see tickAutoAttack()
      keys: { up: false, down: false, left: false, right: false },
      cds: { attack: 0, special1: 0, special2: 0 },
      blockActive: false, blockTimer: 0,
      buffTimer: 0, buffMult: 1,
      spawnProtection: SPAWN_GRACE,
      hasteMult: 1, hasteTimer: 0,
      reviveProgress: 0,
      dead: false,
      // Lifetime counters, restored from disk — survive both a server
      // restart and a fresh character after death (framed as "how many
      // ever", not per-character session stats; see server/db.js).
      ...db.loadPlayerStats(id)
    };
    playerInstance.set(id, dungeonIndex);
    db.savePlayerStats(inst.players[id]); // persist the resolved name even if stats themselves are unchanged
    console.log(`[join] ${id} as ${classKey} into ${DUNGEONS[dungeonIndex].name} (character ${character.id})`);
    return;
  }

  const instIdx = playerInstance.get(id);
  const inst = instIdx !== undefined ? instances.get(instIdx) : undefined;
  const player = inst ? inst.players[id] : undefined;
  if(!player || player.dead) return;
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
    if(player.dead || player.cds.attack > 0) continue;

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

  if(a.projectile){
    let ang = 0;
    if(target) ang = Math.atan2(target.y - player.y, target.x - player.x);
    inst.projectiles.push({
      id: 'pr' + (++projSeq), ownerId: player.id,
      x: player.x, y: player.y,
      vx: Math.cos(ang) * 420, vy: Math.sin(ang) * 420,
      dmg: a.dmg * player.buffMult, life: a.range / 420, r: 6
    });
  } else {
    // Melee still cleaves everything in range rather than only the locked
    // target — that's how this already felt when manually mashing the old
    // attack button, and target-lock mainly matters for ranged aim/UI here.
    const buffed = a.dmg * player.buffMult;
    forEachAliveMonster(inst, mon=>{
      const d = Math.hypot(mon.x - player.x, mon.y - player.y);
      if(d < a.range + mon.radius) hitMonster(inst, mon, buffed, player.id);
    });
  }
}

function doSpecial(inst, player, slot){
  const c = CLASSES[player.classKey];
  const key = 'special' + slot;
  const sp = c[key];
  if(!sp) return;
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
  }
}

function hitMonster(inst, mon, dmg, killerId){
  mon.mesmerizeTimer = 0; // any damage breaks Mesmerize
  mon.hp -= dmg;
  if(mon.hp <= 0 && mon.alive){
    mon.alive = false;
    dropLoot(inst, mon);
    const killer = inst.players[killerId];
    if(killer){ killer.totalKills++; db.savePlayerStats(killer); }
    inst.dungeonKillCount++; // feeds the post-dungeon summary screen, see onBossDefeated()
    if(inst.waveState) inst.waveState.killsSoFar++; // drives tickWaveSpawns()'s escalation
    if(mon.boss) onBossDefeated(inst, mon);
  }
}

function dropLoot(inst, mon){
  // Guaranteed drop inside a side chamber — that's the whole point of the
  // harder detour (see js/data.js's sideChamber.warningText).
  if(mon.boss || inst.branchState === 'in_side_chamber' || Math.random() < 0.35){
    inst.loot.push({ id: 'l' + (++lootSeq), x: mon.x, y: mon.y, taken: false });
  }
  // Rare boss variant guarantees a second drop on top of the boss-kill
  // guarantee above — see js/data.js's blackKnightRare/rareVariant.
  if(mon.type === 'blackKnightRare'){
    inst.loot.push({ id: 'l' + (++lootSeq), x: mon.x + 20, y: mon.y + 20, taken: false });
  }
}

function damagePlayer(inst, player, dmg){
  if(player.spawnProtection > 0) return;
  const gearMult = GEAR_TIERS[player.gearTier].mult;
  const reduced = dmg / (0.6 + gearMult * 0.4);
  player.hp -= reduced;
  if(player.hp <= 0 && !player.dead){
    player.dead = true; player.hp = 0;
    player.totalDeaths++;
    db.savePlayerStats(player);
    console.log(`[death] ${player.id} fell in ${currentDungeon(inst).name}`);
    checkForWipe(inst);
  }
}

// Called after every death — if nobody currently connected is left alive
// to revive anyone, the party can't recover on its own. Resets the
// instance back to its own safe room (not a character/account reset) once
// the moment has had a beat to land. Harmless if it fires more than once
// for the same wipe (e.g. two players die in the same tick) — resetting
// already-alive/full-HP players and reloading room 0 again is a no-op.
function checkForWipe(inst){
  const ids = Object.keys(inst.players);
  if(ids.length === 0) return;
  const anyoneAliveAndConnected = ids.some(id => !inst.players[id].dead && clients.has(id));
  if(anyoneAliveAndConnected) return;
  console.log(`[wipe] the party has fallen in ${currentDungeon(inst).name} — resetting to the safe room`);
  setTimeout(()=>{
    for(const id in inst.players){
      const p = inst.players[id];
      p.dead = false;
      p.hp = p.maxHp;
      if(p.maxMana) p.mana = p.maxMana;
      p.reviveProgress = 0;
      p.spawnProtection = SPAWN_GRACE;
    }
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
    if(someoneAt(inst, BRANCH_MAIN_EXIT)){
      inst.branchState = null;
      advanceToNextRoom(inst);
    } else if(someoneAt(inst, BRANCH_SIDE_EXIT)){
      inst.branchState = 'in_side_chamber';
      loadSideChamber(inst);
    }
  } else if(inst.branchState === 'side_cleared_awaiting_return'){
    if(someoneAt(inst, BRANCH_RETURN_EXIT)){
      inst.branchState = null;
      advanceToNextRoom(inst);
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
              damagePlayer(inst, p, canBlock ? mon.slamDmg * (1 - pc.special1.block) : mon.slamDmg);
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

    if(!target){ continue; }

    const d = Math.hypot(target.x - mon.x, target.y - mon.y);
    if(mon.slamState !== 'telegraph' && !mon.chargeState){
      if(d > mon.range * 0.7){
        mon.x += (target.x - mon.x) / d * mon.speed * dt;
        mon.y += (target.y - mon.y) / d * mon.speed * dt;
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
    } else if(inst.branchState === null && !currentRoom(inst).boss){
      if(currentRoom(inst).branch){
        inst.branchState = 'awaiting_choice'; // fork: don't auto-advance, wait for a gate choice — see tickBranch()
      } else {
        inst.advancing = true;
        setTimeout(()=>{
          inst.advancing = false;
          advanceToNextRoom(inst);
        }, 1400);
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

    const { mx, my } = movementVector(p.keys);
    if(mx !== 0 || my !== 0){
      p.x += mx * p.speed * p.hasteMult * dt;
      p.y += my * p.speed * p.hasteMult * dt;
    }
    p.x = Math.max(p.radius, Math.min(W - p.radius, p.x));
    p.y = Math.max(p.radius + 60, Math.min(H - p.radius, p.y));

    Object.keys(p.cds).forEach(k => p.cds[k] = Math.max(0, p.cds[k] - dt));
    const c = CLASSES[p.classKey];
    if(p.maxMana) p.mana = Math.min(p.maxMana, p.mana + c.manaRegen * dt);
    if(p.blockTimer > 0){ p.blockTimer -= dt; if(p.blockTimer <= 0) p.blockActive = false; }
    if(p.buffTimer > 0){ p.buffTimer -= dt; if(p.buffTimer <= 0) p.buffMult = 1; }
    if(p.hasteTimer > 0){ p.hasteTimer -= dt; if(p.hasteTimer <= 0) p.hasteMult = 1; }
    if(p.spawnProtection > 0) p.spawnProtection = Math.max(0, p.spawnProtection - dt);
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

function tickLoot(inst){
  inst.loot.forEach(l=>{
    if(l.taken) return;
    for(const id in inst.players){
      const p = inst.players[id];
      if(p.dead) continue;
      if(Math.hypot(l.x - p.x, l.y - p.y) < p.radius + 16){
        l.taken = true;
        if(p.gearTier < GEAR_TIERS.length - 1) p.gearTier++;
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
      mainExit: BRANCH_MAIN_EXIT,
      sideExit: BRANCH_SIDE_EXIT,
      returnExit: BRANCH_RETURN_EXIT
    } : null,
    wave: inst.waveState ? { killsSoFar: inst.waveState.killsSoFar, killTarget: inst.waveState.killTarget } : null,
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

  for(const inst of instances.values()){
    tickPlayers(inst, dt);
    tickAutoAttack(inst);
    tickMonsters(inst, dt);
    tickWaveSpawns(inst, dt);
    tickProjectiles(inst, dt);
    tickLoot(inst);
    tickSafeRoom(inst);
    tickBranch(inst);
    tickRevive(inst, dt);
    broadcastInstanceState(inst);
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
