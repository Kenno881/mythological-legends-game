"use strict";

// Authoritative multiplayer server for Quest for Camelot.
// Holds the true game state (players, monsters, current room) and simulates
// it on a fixed tick, broadcasting the full state to every connected client.
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
//     {type:"ready", ready}               toggle this account's muster-ready state
//     {type:"join", classKey}             one-time per account — ignored if the account
//                                          already has a permanent classKey (§8a)
//     {type:"input", keys:{up,down,left,right}, action:null|"attack"|"special1"|"special2"}
//   Server -> Client
//     {type:"loginResult", ok, accountId?, isNewClaim?, reason?}   reply to "login"
//     {type:"welcome", id, roomId, resuming, classKey, isTest}     once, right after identity
//                                                                  is established (immediately
//                                                                  for a remembered device, or
//                                                                  right after a successful login)
//     {type:"muster", connected:[...], ready:[...]}   sent to any logged-in-but-not-yet-joined
//                                                      socket whenever muster state changes
//     {type:"state", tick, players:[...], monsters:[...], projectiles:[...], loot:[...],
//                     roomId, dungeonName, boss, victory}              every tick (20/s)
//
// RECONNECT: players/clients are keyed by the account id, not a per-socket
// counter. On disconnect a character isn't deleted — it just sits in the
// world (still simulated, still targetable, not moving since its held keys
// reset to none) until RECONNECT_GRACE_MS passes with no reconnect, at
// which point it's actually removed. A new socket with the same id within
// that window cancels the removal and takes over the existing state
// (position, hp, gear, cooldowns) untouched.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { CLASSES, GEAR_TIERS, DUNGEONS, ENEMY_TYPES } = require('../js/data.js');
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
// monsters are currently alive — so a join/rejoin mid-fight doesn't land
// someone in the middle of it just because the fight has drifted toward the
// entrance over time. Falls back to the entrance itself if nothing is alive
// (or all candidates are equally boxed in) — there's nothing to avoid.
function pickSpawnPoint(){
  let best = { x: ENTRANCE_X, y: ENTRANCE_Y };
  let bestDist = -Infinity;
  for(let i = 0; i < SPAWN_CANDIDATES; i++){
    const x = ENTRANCE_X + (Math.random() * 2 - 1) * SPAWN_SEARCH_RADIUS;
    const y = ENTRANCE_Y + (Math.random() * 2 - 1) * SPAWN_SEARCH_RADIUS;
    let nearest = Infinity;
    for(const id in monsters){
      const mon = monsters[id];
      if(!mon.alive) continue;
      nearest = Math.min(nearest, Math.hypot(mon.x - x, mon.y - y));
    }
    if(nearest > bestDist){ bestDist = nearest; best = { x, y }; }
  }
  return best;
}

const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 75 * 1000; // how long a disconnected character survives before removal

// ---------- ACCOUNTS (MASTER_DESIGN.md §8a) ----------
// Exactly 5 reserved account ids — the family's fixed 4-person roster plus
// one solo QA account exempt from muster. No open self-registration: this
// list is the actual access control (an unrecognized username is rejected
// at login, same shape as the passphrase gate). PINs themselves are never
// pre-assigned here — see server/db.js's verifyOrClaimPin, which lets each
// account set its own PIN on first login rather than this file ever
// handling/transmitting one.
const ACCOUNTS = {
  dad:    { name: 'Dad',    isTest: false },
  mum:    { name: 'Mum',    isTest: false },
  amelia: { name: 'Amelia', isTest: false },
  declan: { name: 'Declan', isTest: false },
  test:   { name: 'test',   isTest: true }
};
const FAMILY_IDS = Object.keys(ACCOUNTS).filter(id => !ACCOUNTS[id].isTest);

// ---------- AUTHORITATIVE STATE ----------
const players = Object.create(null);    // playerId -> player state
const monsters = Object.create(null);   // monsterId -> monster state
let projectiles = [];
let loot = [];
let dungeonIndex = 0;
let roomIndex = 0;
let advancing = false;                  // room/dungeon transition in progress
let victory = false;
let dungeonStartedAt = Date.now();      // reset in loadRoom() whenever a fresh dungeon begins — feeds best-time tracking (server/db.js)

let monsterSeq = 0, lootSeq = 0, projSeq = 0;

function currentDungeon(){ return DUNGEONS[dungeonIndex]; }
function currentRoom(){ return currentDungeon().rooms[roomIndex]; }
function currentRoomId(){ return `${dungeonIndex}:${roomIndex}`; }

function loadRoom(idx){
  roomIndex = idx;
  if(idx === 0) dungeonStartedAt = Date.now();
  const dungeon = currentDungeon();
  const room = dungeon.rooms[idx];
  for(const id in monsters) delete monsters[id];
  loot = [];
  room.enemies.forEach(e=>{
    const t = ENEMY_TYPES[e.type];
    const id = 'm' + (++monsterSeq);
    monsters[id] = Object.assign({}, t, {
      id, type: e.type, x: e.x, y: e.y, hp: t.hp, maxHp: t.hp, cd: 0,
      slamCd: t.slamCd || 0, slamState: null, slamTimer: 0, alive: true,
      stunTimer: 0, tauntTimer: 0, tauntTarget: null
    });
  });
  console.log(`[room] ${dungeon.name} — ${room.boss ? 'BOSS' : 'chamber ' + (idx + 1)} (${room.enemies.length} monsters)`);
}

loadRoom(0);

// ---------- CONNECTIONS ----------
const clients = new Map();          // playerId -> ws (the live socket, if any, for that character)
const reconnectTimers = new Map();  // playerId -> pending-removal timeout, only set while disconnected

// ---------- MUSTER (in-memory only — a "who's here right now" lobby, not
// game progress, so nothing here is persisted or survives a restart) ----------
// account id -> logged in but hasn't joined a character this session yet
const musterConnected = new Set();
// account id -> hit "Ready" — cleared on disconnect and once they actually join
const musterReady = new Set();

function broadcastMuster(){
  const payload = JSON.stringify({ type: 'muster', connected: [...musterConnected], ready: [...musterReady] });
  for(const id of musterConnected){
    const ws = clients.get(id);
    if(ws && ws.readyState === 1) ws.send(payload);
  }
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
    const resuming = !!players[id];

    // A resuming connection (already had a live character) skips muster
    // entirely — muster is a per-session "everyone's here" lobby, not
    // something re-triggered by every reconnect or in-run death/rejoin.
    if(!resuming){
      musterConnected.add(id);
      broadcastMuster();
    }

    ws.send(JSON.stringify({
      type: 'welcome', id, roomId: currentRoomId(), resuming,
      classKey: db.getAccountClass(id), isTest: ACCOUNTS[id].isTest
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

    handleMessage(id, msg);
  });

  ws.on('close', () => {
    if(id === null) return; // never actually logged in — nothing was ever registered for this socket
    if(clients.get(id) !== ws) return; // a newer connection already replaced this one; nothing to do
    clients.delete(id);
    musterConnected.delete(id);
    musterReady.delete(id);
    broadcastMuster();
    const p = players[id];
    if(!p){ console.log(`[disconnect] ${id}`); return; }
    db.savePlayerStats(p); // write-on-disconnect
    p.keys.up = p.keys.down = p.keys.left = p.keys.right = false; // stop it from walking into a wall forever
    reconnectTimers.set(id, setTimeout(()=>{
      delete players[id];
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

  if(msg.type === 'ready'){
    if(msg.ready) musterReady.add(id); else musterReady.delete(id);
    broadcastMuster();
    return;
  }

  if(msg.type === 'join'){
    // Refuse to clobber a *live* character (protects a reconnect from
    // losing progress if the client redundantly re-sends "join"). A dead
    // one is fair game — dying and rejoining starts a fresh character
    // (position/hp/gear reset), same as it always has, but the class
    // itself is now permanent per account (§8a) rather than re-picked.
    if(players[id] && !players[id].dead) return;
    const persistedClass = db.getAccountClass(id);
    const classKey = (persistedClass && CLASSES[persistedClass]) ? persistedClass
      : (CLASSES[msg.classKey] ? msg.classKey : 'squire');
    if(!persistedClass) db.saveAccountClass(id, classKey); // first-ever join for this account — locks it in
    const c = CLASSES[classKey];
    const spawn = pickSpawnPoint();
    const name = ACCOUNTS[id].name;
    players[id] = {
      id, classKey, name,
      x: spawn.x, y: spawn.y,
      hp: c.hp, maxHp: c.hp,
      mana: c.hasMana ? c.maxMana : 0, maxMana: c.hasMana ? c.maxMana : 0,
      speed: c.speed, radius: c.radius, color: c.color,
      gearTier: 0,
      keys: { up: false, down: false, left: false, right: false },
      cds: { attack: 0, special1: 0, special2: 0 },
      blockActive: false, blockTimer: 0,
      buffTimer: 0, buffMult: 1,
      spawnProtection: SPAWN_GRACE,
      dead: false,
      // Lifetime counters, restored from disk — survive both a server
      // restart and a fresh character after death (framed as "how many
      // ever", not per-character session stats; see server/db.js).
      ...db.loadPlayerStats(id)
    };
    db.savePlayerStats(players[id]); // persist the resolved name even if stats themselves are unchanged
    musterConnected.delete(id); musterReady.delete(id); broadcastMuster(); // no longer waiting in the lobby
    console.log(`[join] ${id} as ${classKey}`);
    return;
  }

  const player = players[id];
  if(!player || player.dead) return;
  if(msg.type !== 'input') return;

  // {type:"input", keys:{up,down,left,right}, action:"attack"|"special1"|"special2"|null}
  // `keys` sets the player's held-direction state, applied to movement every tick.
  // `action` is level-triggered (safe to resend every message while held) — each
  // handler is already cooldown-gated below, so re-sending the same action is a no-op
  // until its cooldown clears.
  const k = msg.keys || {};
  player.keys.up = !!k.up;
  player.keys.down = !!k.down;
  player.keys.left = !!k.left;
  player.keys.right = !!k.right;

  if(msg.action === 'attack') doAttack(player);
  else if(msg.action === 'special1') doSpecial(player, 1);
  else if(msg.action === 'special2') doSpecial(player, 2);
}

// ---------- COMBAT ----------
function nearestMonster(player){
  let best = null, bd = Infinity;
  for(const id in monsters){
    const mon = monsters[id];
    if(!mon.alive) continue;
    const d = Math.hypot(mon.x - player.x, mon.y - player.y);
    if(d < bd){ bd = d; best = mon; }
  }
  return best;
}

function forEachAliveMonster(fn){
  for(const id in monsters){
    if(monsters[id].alive) fn(monsters[id]);
  }
}

function doAttack(player){
  if(player.cds.attack > 0) return;
  const c = CLASSES[player.classKey];
  const a = c.attack;
  if(a.cost && player.mana < a.cost) return;
  player.cds.attack = a.cd;
  if(a.cost) player.mana -= a.cost;

  if(a.projectile){
    const target = nearestMonster(player);
    let ang = 0;
    if(target) ang = Math.atan2(target.y - player.y, target.x - player.x);
    projectiles.push({
      id: 'pr' + (++projSeq), ownerId: player.id,
      x: player.x, y: player.y,
      vx: Math.cos(ang) * 420, vy: Math.sin(ang) * 420,
      dmg: a.dmg * player.buffMult, life: a.range / 420, r: 6
    });
  } else {
    const buffed = a.dmg * player.buffMult;
    forEachAliveMonster(mon=>{
      const d = Math.hypot(mon.x - player.x, mon.y - player.y);
      if(d < a.range + mon.radius) hitMonster(mon, buffed, player.id);
    });
  }
}

function doSpecial(player, slot){
  const c = CLASSES[player.classKey];
  const key = 'special' + slot;
  const sp = c[key];
  if(!sp) return;
  if(player.cds[key] > 0) return;
  if(sp.cost && player.mana < sp.cost) return;

  player.cds[key] = sp.cd;
  if(sp.cost) player.mana -= sp.cost;

  if(sp.name === "Shield Bash"){
    forEachAliveMonster(mon=>{
      const d = Math.hypot(mon.x - player.x, mon.y - player.y);
      if(d < sp.radius){ hitMonster(mon, sp.dmg, player.id); mon.stunTimer = sp.stun; }
    });
  } else if(sp.name === "Parry"){
    player.blockActive = true; player.blockTimer = sp.dur;
  } else if(sp.name === "Taunt"){
    forEachAliveMonster(mon=>{
      const d = Math.hypot(mon.x - player.x, mon.y - player.y);
      if(d < sp.radius){ mon.tauntTimer = sp.dur; mon.tauntTarget = player.id; }
    });
  } else if(sp.name === "Arcane Nova"){
    forEachAliveMonster(mon=>{
      const d = Math.hypot(mon.x - player.x, mon.y - player.y);
      if(d < sp.radius) hitMonster(mon, sp.dmg, player.id);
    });
  } else if(sp.name === "Healing Light"){
    player.hp = Math.min(player.maxHp, player.hp + sp.heal);
  } else if(sp.name === "Blessing"){
    // Multiplayer party heal + buff, matching the Cleric's "watch the whole party" design.
    for(const id in players){
      const p = players[id];
      if(p.dead) continue;
      p.hp = Math.min(p.maxHp, p.hp + sp.heal);
      p.buffMult = sp.buff; p.buffTimer = sp.buffDur;
    }
  }
}

function hitMonster(mon, dmg, killerId){
  mon.hp -= dmg;
  if(mon.hp <= 0 && mon.alive){
    mon.alive = false;
    dropLoot(mon);
    const killer = players[killerId];
    if(killer){ killer.totalKills++; db.savePlayerStats(killer); }
    if(mon.boss) onBossDefeated();
  }
}

function dropLoot(mon){
  if(mon.boss || Math.random() < 0.35){
    loot.push({ id: 'l' + (++lootSeq), x: mon.x, y: mon.y, taken: false });
  }
}

function damagePlayer(player, dmg){
  if(player.spawnProtection > 0) return;
  const gearMult = GEAR_TIERS[player.gearTier].mult;
  const reduced = dmg / (0.6 + gearMult * 0.4);
  player.hp -= reduced;
  if(player.hp <= 0 && !player.dead){
    player.dead = true; player.hp = 0;
    player.totalDeaths++;
    db.savePlayerStats(player);
    console.log(`[death] ${player.id} fell in ${currentDungeon().name}`);
  }
}

function onBossDefeated(){
  const d = currentDungeon();
  const elapsedSeconds = (Date.now() - dungeonStartedAt) / 1000;
  db.recordDungeonClear(d.name, elapsedSeconds); // only overwrites if this beats the existing record
  console.log(`[boss defeated] ${d.name} in ${elapsedSeconds.toFixed(1)}s`);
  advancing = true;
  setTimeout(()=>{
    advancing = false;
    if(dungeonIndex + 1 < DUNGEONS.length){
      dungeonIndex++;
      for(const id in players){
        const p = players[id];
        p.hp = p.maxHp;
        if(p.maxMana) p.mana = p.maxMana;
      }
      loadRoom(0);
    } else {
      victory = true;
      console.log('[victory] Camelot is saved');
    }
  }, 1800);
}

// ---------- MONSTER AI ----------
function pickTarget(mon){
  if(mon.tauntTimer > 0 && mon.tauntTarget){
    const t = players[mon.tauntTarget];
    if(t && !t.dead) return t;
  }
  let best = null, bd = Infinity;
  for(const id in players){
    const p = players[id];
    if(p.dead) continue;
    const d = Math.hypot(p.x - mon.x, p.y - mon.y);
    if(d < bd){ bd = d; best = p; }
  }
  return best;
}

function tickMonsters(dt){
  let allDead = true;
  for(const id in monsters){
    const mon = monsters[id];
    if(!mon.alive) continue;
    allDead = false;
    if(mon.stunTimer > 0){ mon.stunTimer -= dt; continue; }
    if(mon.tauntTimer > 0) mon.tauntTimer -= dt;

    const target = pickTarget(mon);

    if(mon.boss){
      mon.slamCd -= dt;
      if(mon.slamState === 'telegraph'){
        mon.slamTimer -= dt;
        if(mon.slamTimer <= 0){
          mon.slamState = null;
          // Boss slam is an AoE that hits every nearby player, not just one.
          for(const pid in players){
            const p = players[pid];
            if(p.dead) continue;
            const d = Math.hypot(p.x - mon.x, p.y - mon.y);
            if(d < mon.slamRadius){
              const pc = CLASSES[p.classKey];
              const canBlock = p.blockActive && pc.special1 && pc.special1.block;
              damagePlayer(p, canBlock ? mon.slamDmg * (1 - pc.special1.block) : mon.slamDmg);
            }
          }
          mon.slamCd = 4.5;
        }
      } else if(mon.slamCd <= 0){
        mon.slamState = 'telegraph'; mon.slamTimer = mon.slamTelegraph;
      }
    }

    if(!target){ continue; }

    const d = Math.hypot(target.x - mon.x, target.y - mon.y);
    if(mon.slamState !== 'telegraph'){
      if(d > mon.range * 0.7){
        mon.x += (target.x - mon.x) / d * mon.speed * dt;
        mon.y += (target.y - mon.y) / d * mon.speed * dt;
      } else {
        mon.cd -= dt;
        if(mon.cd <= 0){
          damagePlayer(target, mon.dmg);
          mon.cd = ENEMY_TYPES[mon.type].cd;
        }
      }
    }
  }

  if(allDead && Object.keys(monsters).length > 0 && !currentRoom().boss && !advancing){
    advancing = true;
    setTimeout(()=>{
      advancing = false;
      if(roomIndex + 1 < currentDungeon().rooms.length) loadRoom(roomIndex + 1);
    }, 1400);
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

function tickPlayers(dt){
  for(const id in players){
    const p = players[id];
    if(p.dead) continue;

    const { mx, my } = movementVector(p.keys);
    if(mx !== 0 || my !== 0){
      p.x += mx * p.speed * dt;
      p.y += my * p.speed * dt;
    }
    p.x = Math.max(p.radius, Math.min(W - p.radius, p.x));
    p.y = Math.max(p.radius + 60, Math.min(H - p.radius, p.y));

    Object.keys(p.cds).forEach(k => p.cds[k] = Math.max(0, p.cds[k] - dt));
    const c = CLASSES[p.classKey];
    if(p.maxMana) p.mana = Math.min(p.maxMana, p.mana + c.manaRegen * dt);
    if(p.blockTimer > 0){ p.blockTimer -= dt; if(p.blockTimer <= 0) p.blockActive = false; }
    if(p.buffTimer > 0){ p.buffTimer -= dt; if(p.buffTimer <= 0) p.buffMult = 1; }
    if(p.spawnProtection > 0) p.spawnProtection = Math.max(0, p.spawnProtection - dt);
  }
}

function tickProjectiles(dt){
  projectiles.forEach(pr=>{
    pr.x += pr.vx * dt; pr.y += pr.vy * dt; pr.life -= dt;
    forEachAliveMonster(mon=>{
      if(pr.dead) return;
      if(Math.hypot(mon.x - pr.x, mon.y - pr.y) < mon.radius + pr.r){ hitMonster(mon, pr.dmg, pr.ownerId); pr.dead = true; }
    });
  });
  projectiles = projectiles.filter(pr => pr.life > 0 && !pr.dead);
}

function tickLoot(){
  loot.forEach(l=>{
    if(l.taken) return;
    for(const id in players){
      const p = players[id];
      if(p.dead) continue;
      if(Math.hypot(l.x - p.x, l.y - p.y) < p.radius + 16){
        l.taken = true;
        if(p.gearTier < GEAR_TIERS.length - 1) p.gearTier++;
        break;
      }
    }
  });
  loot = loot.filter(l => !l.taken);
}

// ---------- TICK LOOP ----------
// {type:"state", players:[...], monsters:[...], projectiles:[...], tick:N}
// Arrays, each element carrying its own `id` — plus a few extra fields (roomId,
// dungeonName, boss, victory, loot) the client needs for HUD/progression that
// don't fit the three core entity lists.
function broadcastState(){
  const payload = JSON.stringify({
    type: 'state',
    tick: tickCount,
    roomId: currentRoomId(),
    dungeonName: currentDungeon().name,
    boss: !!currentRoom().boss,
    victory,
    players: Object.values(players),
    monsters: Object.values(monsters),
    projectiles,
    loot
  });
  for(const ws of clients.values()){
    if(ws.readyState === 1) ws.send(payload);
  }
}

let lastTick = Date.now();
let tickCount = 0;
setInterval(()=>{
  tickCount++;
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;

  if(!victory){
    tickPlayers(dt);
    tickMonsters(dt);
    tickProjectiles(dt);
    tickLoot();
  }
  broadcastState();
}, TICK_MS);

console.log(`Quest for Camelot server listening on ws://${HOST}:${PORT}`);
