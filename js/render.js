"use strict";

// Pure rendering. Draws whatever the latest server state snapshot contains —
// no physics, no combat resolution, no AI. If it's not read from
// `latestState` (net.js) or the static data tables (data.js), it doesn't
// belong in this file.

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;

function dungeonByName(name){
  return DUNGEONS.find(d => d.name === name) || null;
}

// ---------- SPRITE FACING (2026-08-27) ----------
// Every sprite only exists facing one direction (tools/generate-sprites.js's
// STYLE_PREFIX) — mirrored horizontally via a canvas transform when moving
// left, no new art needed. Tracked per-entity by comparing this frame's x
// against last frame's, not "which way are keys held": that would get Fear's
// forced-flee movement backwards (moving away from the fear source, not
// whatever direction the held key implies). Holds the last real direction
// while moving purely vertically or standing still, rather than snapping
// back to a default the moment horizontal movement stops.
const playerFacing = new Map(); // player id -> {lastX, dir}
const monsterFacing = new Map(); // monster id -> {lastX, dir}
function facingFor(cache, id, x){
  let entry = cache.get(id);
  if(!entry){ entry = { lastX: x, dir: 'right' }; cache.set(id, entry); return entry.dir; }
  const dx = x - entry.lastX;
  if(dx > 0.5) entry.dir = 'right';
  else if(dx < -0.5) entry.dir = 'left';
  entry.lastX = x;
  return entry.dir;
}
// Mirrors around the sprite's own horizontal center (already how drawX is
// computed — cx - drawWidth/2), so flipping never shifts its position.
function applyFacingFlip(cx, dir){
  if(dir !== 'left') return;
  ctx.translate(cx, 0);
  ctx.scale(-1, 1);
  ctx.translate(-cx, 0);
}

// Server only sends `roomId` ("dungeonIndex:roomIndex") — this looks up the
// actual room data object (js/data.js) it refers to, so room-level fields
// like `sideChamber` (moved off the dungeon and onto individual branch
// rooms so a dungeon can have more than one branch) can be read here too.
function currentRoomData(s){
  const dungeon = dungeonByName(s.dungeonName);
  if(!dungeon || !s.roomId) return null;
  const idx = Number(s.roomId.split(':')[1]);
  return dungeon.rooms[idx] || null;
}

// ---------- FLOOR TEXTURE ----------
// A single tileable stone texture reused for every dungeon (and the safe
// room), color-washed per-room with that room's floorColor so each
// dungeon still reads as visually distinct despite sharing one tile.
// Kept at its exact original pixel size (not run through
// tools/process-sprites.js's trim step, which would shift the tile
// boundary by a pixel or two and break the seamless repeat).
const floorTileImg = new Image();
floorTileImg.src = 'assets/sprites/dungeon_floor.png';
let floorPattern = null;
floorTileImg.addEventListener('load', () => { floorPattern = ctx.createPattern(floorTileImg, 'repeat'); });

// ---------- SPRITES ----------
// Preloaded once at startup from CLASSES/ENEMY_TYPES/WEAPON_TIERS/
// ARMOR_TIERS's `sprite` fields. Anything with no `sprite` entry (or one
// that hasn't finished loading yet) just falls back to the plain colored
// shape this game always drew — nothing breaks while art is still in
// progress for a given class, monster, or gear tier.
function loadSprites(table){
  const cache = {};
  Object.entries(table).forEach(([key, entry])=>{
    if(!entry.sprite) return;
    const img = new Image();
    img.src = entry.sprite;
    cache[key] = img;
  });
  return cache;
}
function readySprite(cache, key){
  const img = cache[key];
  return (img && img.complete && img.naturalWidth > 0) ? img : null;
}
// Weapon/Armor tiers reuse the same 4 sprite files (no dedicated weapon-
// vs-armor art yet — see MASTER_DESIGN.md §7) but are two independent
// ladders now, so each gets its own array-indexed cache.
function loadTierSprites(tiers){
  return tiers.map(t=>{
    if(!t.sprite) return null;
    const img = new Image();
    img.src = t.sprite;
    return img;
  });
}
function tierSpriteFor(cache, tier){
  const img = cache[tier];
  return (img && img.complete && img.naturalWidth > 0) ? img : null;
}

const characterSprites = loadSprites(CLASSES);
const monsterSprites = loadSprites(ENEMY_TYPES);
const weaponSprites = loadTierSprites(WEAPON_TIERS);
const armorSprites = loadTierSprites(ARMOR_TIERS);
// Gendered variants (js/data.js's optional spriteMale/spriteFemale) — none
// exist yet, so these caches just stay empty until that art lands; nothing
// else needs to change when it does.
function loadGenderedSprites(genderKey){
  const cache = {};
  Object.entries(CLASSES).forEach(([key, entry])=>{
    if(!entry[genderKey]) return;
    const img = new Image();
    img.src = entry[genderKey];
    cache[key] = img;
  });
  return cache;
}
const characterSpritesMale = loadGenderedSprites('spriteMale');
const characterSpritesFemale = loadGenderedSprites('spriteFemale');

function spriteFor(classKey, gender){
  if(gender === 'male' || gender === 'female'){
    const genderedSprite = readySprite(gender === 'male' ? characterSpritesMale : characterSpritesFemale, classKey);
    if(genderedSprite) return genderedSprite;
  }
  return readySprite(characterSprites, classKey); // fallback — always exists today
}
function monsterSpriteFor(type){ return readySprite(monsterSprites, type); }

// ---------- BANNER / LOOT TOAST ----------
let bannerTimeout = null;
function showBanner(text, duration){
  const b = document.getElementById('banner');
  b.textContent = text;
  b.classList.add('show');
  clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(()=> b.classList.remove('show'), duration || 2200);
}
function showLoot(text){
  const t = document.getElementById('loot-toast');
  t.textContent = text;
  t.classList.add('show');
  setTimeout(()=> t.classList.remove('show'), 1600);
}

// ---------- HUD ----------
let lastWeaponTier = 0, lastArmorTier = 0, lastArtifactCount = 0, lastLevel = 1;
let lastFamilyCurrency = null; // null until the first real state — avoids a spurious toast for currency earned before this session started
let lastHudWeaponTier = -1, lastHudArmorTier = -1; // -1 so the icons sync on the very first updateHud call
function setCdVisual(id, remain, total){
  const el = document.getElementById(id);
  const pct = total > 0 ? remain / total : 0;
  el.style.clipPath = `inset(0 0 ${100 - pct * 100}% 0)`;
}

function updateHud(s){
  const me = myPlayer();
  document.getElementById('dungeonLabel').textContent = s.dungeonName;
  if(!me) return;

  document.getElementById('hpBar').style.width = Math.max(0, me.hp / me.maxHp * 100) + '%';
  document.getElementById('manaWrap').style.display = me.maxMana ? 'block' : 'none';
  if(me.maxMana) document.getElementById('manaBar').style.width = (me.mana / me.maxMana * 100) + '%';

  // Three gear slots (§7) — weapon/armor each get a name + icon, same
  // toggle-on-change pattern the old single gear icon used; artifacts just
  // list by name (no bespoke icon art yet, see MASTER_DESIGN.md §7).
  document.getElementById('weaponLabelText').textContent = WEAPON_TIERS[me.weaponTier].name;
  document.getElementById('armorLabelText').textContent = ARMOR_TIERS[me.armorTier].name;
  document.getElementById('artifactLabelText').textContent = me.artifacts.length
    ? me.artifacts.map(id => ARTIFACTS[id].name).join(', ')
    : 'None yet';
  if(me.weaponTier !== lastHudWeaponTier){
    lastHudWeaponTier = me.weaponTier;
    const iconEl = document.getElementById('weaponIcon');
    const sprite = WEAPON_TIERS[me.weaponTier].sprite;
    iconEl.classList.toggle('hidden', !sprite);
    if(sprite) iconEl.src = sprite;
  }
  if(me.armorTier !== lastHudArmorTier){
    lastHudArmorTier = me.armorTier;
    const iconEl = document.getElementById('armorIcon');
    const sprite = ARMOR_TIERS[me.armorTier].sprite;
    iconEl.classList.toggle('hidden', !sprite);
    if(sprite) iconEl.src = sprite;
  }
  document.getElementById('classLabel').textContent = CLASSES[me.classKey].name;
  document.getElementById('levelLabel').textContent = `Lv ${me.level} · ${me.xp}/${xpToNextLevel(me.level)} xp`;

  // Wave/kill counter — only shown inside a wave encounter (js/data.js's
  // `wave: true` rooms, currently just Sherwood's Sunken Trail).
  const waveLabelEl = document.getElementById('waveLabel');
  waveLabelEl.classList.toggle('hidden', !s.wave);
  if(s.wave) waveLabelEl.textContent = `Cleared: ${s.wave.killsSoFar}/${s.wave.killTarget}`;

  // Family currency — always visible, ambient "the numbers are moving"
  // signal even with nothing to spend it on yet (§11/§12 Phase 5).
  document.getElementById('currencyLabel').textContent = 'Coffers: ' + (s.family ? s.family.currency : 0);

  const c = CLASSES[me.classKey];
  setCdVisual('cdSpecial1', me.cds.special1, c.special1 ? c.special1.cd : 1);
  // Ability button labels (2026-08-26, user request) — the buttons used to
  // just say the generic "Ability"/"Special" forever, with nothing telling
  // a player what pressing one actually does beyond memory or a one-time
  // glance at the class-select screen. Set once per class is enough (the
  // name never changes mid-run), but this runs every HUD update anyway —
  // textContent assignment is cheap and idempotent, no dirty-check needed.
  if(c.special1) document.getElementById('abtnLabel1').textContent = c.special1.name;
  // Locked-but-not-yet-learned (§10's unlockLevel) reads exactly like
  // "this class doesn't have one" already did — same hidden button, no
  // dead-button feel, no separate "locked" visual state to design.
  const special2Learned = c.special2 && (!c.special2.unlockLevel || me.level >= c.special2.unlockLevel);
  document.getElementById('btnSpecial2').classList.toggle('hidden', !special2Learned);
  if(special2Learned){
    setCdVisual('cdSpecial2', me.cds.special2, c.special2.cd);
    document.getElementById('abtnLabel2').textContent = c.special2.name;
  }
  // Keyboard/gamepad hint (2026-08-27) — the touch buttons above show the
  // real ability name (abtnLabel1/2), but #kbHint only ever showed generic
  // "Ability"/"Special" placeholders, since it's a static string in the
  // HTML rather than driven by updateHud like the touch labels are. A
  // keyboard/gamepad-only player (no touch buttons ever shown for them —
  // style.css hides #controls entirely on hover:hover+pointer:fine) had no
  // way to learn what E/Q or gamepad A/B actually do beyond the one-time
  // class-select screen. Special's segment only appears once it's actually
  // learned, matching the touch button's own hidden-until-unlocked state —
  // showing "Special: Taunt (Q...)" before level 3 would imply a working
  // button that silently does nothing yet.
  if(c.special1){
    // Cooldown as text (2026-08-27) — the touch buttons show it as the
    // radial cd overlay (setCdVisual above), but that's a visual-only cue
    // with no text equivalent; a keyboard/gamepad player had no way to
    // tell "still on cooldown" from "just didn't do anything" without
    // actually trying it. Omitted entirely once ready, same reasoning as
    // the Special segment below only appearing once it's actually usable.
    const cdText = remain => remain > 0 ? ` — ${remain.toFixed(1)}s` : '';
    const specialSegment = special2Learned
      ? `&nbsp; Special: ${c.special2.name} (Q / gamepad B)${cdText(me.cds.special2)}`
      : '';
    document.getElementById('kbHint').innerHTML =
      `Move: WASD / Arrows / gamepad stick &nbsp; Attack: automatic `
      + `&nbsp; Ability: ${c.special1.name} (E / gamepad A)${cdText(me.cds.special1)}${specialSegment}`;
  }

  // Loot toast fires for whichever slot actually changed since the last
  // update — each checked independently since a boss kill can grant more
  // than one at once (its artifact plus a weapon/armor token).
  if(me.weaponTier > lastWeaponTier) showLoot(`Found ${WEAPON_TIERS[me.weaponTier].name}!`);
  if(me.armorTier > lastArmorTier) showLoot(`Found ${ARMOR_TIERS[me.armorTier].name}!`);
  // A weapon/armor roll that didn't beat what's equipped melts down into a
  // bit of family currency instead (server.js's applyLootPickup, 2026-08-26)
  // — this is the only live feedback for that case, since the tier itself
  // doesn't change.
  if(lastFamilyCurrency !== null && s.family && s.family.currency > lastFamilyCurrency){
    showLoot(`+${s.family.currency - lastFamilyCurrency} coin`);
  }
  lastFamilyCurrency = s.family ? s.family.currency : lastFamilyCurrency;
  if(me.artifacts.length > lastArtifactCount){
    const newestId = me.artifacts[me.artifacts.length - 1];
    showLoot(`Found the ${ARTIFACTS[newestId].name}!`);
  }
  // Ability-unlock toast — the boon-choice modal already announces a plain
  // level-up, so this only needs to call out the ability itself, exactly
  // on the update that crosses its unlockLevel threshold.
  if(me.level > lastLevel && c.special2 && c.special2.unlockLevel
     && lastLevel < c.special2.unlockLevel && me.level >= c.special2.unlockLevel){
    showLoot(`New ability: ${c.special2.name}!`);
  }
  lastWeaponTier = me.weaponTier;
  lastArmorTier = me.armorTier;
  lastArtifactCount = me.artifacts.length;
  lastLevel = me.level;
}

// ---------- ROSTER ----------
// A party-at-a-glance sidebar — mainly for the Cleric, who otherwise has to
// visually hunt for low-HP allies on a canvas that gets crowded with
// particles and monsters. Diffs against `s.players` rather than rebuilding
// every frame: this runs at the state broadcast rate (20/s), and rebuilding
// the whole list that often causes visible flicker for no reason.
const rosterEls = new Map(); // playerId -> {el, hpText, hpBar}

function updateRoster(s){
  const container = document.getElementById('roster');
  const seen = new Set();

  s.players.forEach(p=>{
    seen.add(p.id);
    let entry = rosterEls.get(p.id);
    if(!entry){
      const el = document.createElement('div');
      el.className = 'roster-entry';
      el.innerHTML = `
        <div class="roster-row"><span class="roster-name"></span><span class="roster-hp-text"></span></div>
        <div class="roster-hpbar-wrap"><div class="roster-hpbar"></div></div>`;
      container.appendChild(el);
      entry = {
        el,
        nameEl: el.querySelector('.roster-name'),
        hpTextEl: el.querySelector('.roster-hp-text'),
        hpBarEl: el.querySelector('.roster-hpbar')
      };
      rosterEls.set(p.id, entry);
    }
    entry.nameEl.textContent = p.name + (p.id === myId ? ' (you)' : '');
    entry.hpTextEl.textContent = `${Math.max(0, Math.round(p.hp))}/${p.maxHp}`;
    entry.hpBarEl.style.width = Math.max(0, p.hp / p.maxHp * 100) + '%';
    entry.el.classList.toggle('me', p.id === myId);
    entry.el.classList.toggle('dead', p.dead);
  });

  // Drop entries for players no longer in the broadcast (left, or their
  // reconnect grace period fully expired).
  for(const [id, entry] of rosterEls){
    if(!seen.has(id)){
      entry.el.remove();
      rosterEls.delete(id);
    }
  }
}

// ---------- MINIMAP ----------
// Reveals as you explore (2026-08-26, MASTER_DESIGN.md §9's "actual Isaac
// feel" pass) rather than showing the whole dungeon upfront. Needs no new
// server broadcast field: js/data.js's DUNGEONS is already loaded
// identically by client and server, so a room's `grid`/`doors`/`to` are
// read straight from the shared static data via currentRoomData()-style
// lookups — only the live gate *positions* (already broadcast in s.doors)
// are server-resolved. A room only appears once actually visited, or once
// a door in the room you're standing in — currently open — leads to it, so
// the map genuinely builds alongside what's on screen rather than spoiling
// the layout in advance.
const visitedRooms = new Set();
const knownRooms = new Set();
const minimapEls = new Map(); // roomIndex -> element
const MINIMAP_CELL = 26, MINIMAP_OFFSET = 60, MINIMAP_SIZE = 20;
let minimapSvg = null; // lazily created — connecting lines between known/visited cells

function minimapCellCenter(grid){
  return {
    x: MINIMAP_OFFSET + grid.x * MINIMAP_CELL + MINIMAP_SIZE / 2,
    y: MINIMAP_OFFSET + grid.y * MINIMAP_CELL + MINIMAP_SIZE / 2
  };
}
// A room's real door connections — mirrors the exact same "explicit
// `doors`, else the synthesized `{to: roomIndex+1}`" fallback server.js's
// doorsFor() applies, so the lines drawn below always match the actual
// room graph instead of drifting from it.
function doorTargetsFor(dungeon, ri){
  const room = dungeon.rooms[ri];
  if(room.doors) return room.doors.map(d => d.to);
  return ri + 1 < dungeon.rooms.length ? [ri + 1] : [];
}

// 2026-08-27 — user-reported: "the mapping is very messy right now."
// Cells alone (no connecting geometry, every one styled identically) don't
// read as a maze, just a scatter of same-looking squares once a hub opens
// 3 doors at once. Two additions: SVG lines between any two cells that are
// BOTH already known/visited (drawn from the same static door data the
// cells' own reveal rule already uses, so a line never leaks a connection
// before its two endpoints are earned), and a distinct border on the boss
// room so there's an obvious "that's where this is headed" landmark.
function updateMinimap(s){
  if(!s.dungeonName || !s.roomId) return;
  const dungeon = dungeonByName(s.dungeonName);
  if(!dungeon) return;
  const panel = document.getElementById('minimap');
  // Dungeons that haven't gotten this treatment yet (still Sherwood-only)
  // carry no `grid` data at all — hide the panel entirely rather than
  // showing an empty box that reads as broken.
  const anyGrid = dungeon.rooms.some(r => r.grid);
  panel.classList.toggle('hidden', !anyGrid);
  if(!anyGrid) return;

  if(!minimapSvg){
    minimapSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    minimapSvg.setAttribute('class', 'minimap-lines');
    minimapSvg.setAttribute('width', '150');
    minimapSvg.setAttribute('height', '150');
    panel.appendChild(minimapSvg); // added first — cells (appended below) paint on top of the lines
  }

  const idx = Number(s.roomId.split(':')[1]);
  visitedRooms.add(idx);
  const room = dungeon.rooms[idx];
  if(room.doors && s.doors){
    room.doors.forEach(d => knownRooms.add(d.to));
  }

  const seen = new Set();
  new Set([...visitedRooms, ...knownRooms]).forEach(ri=>{
    const r = dungeon.rooms[ri];
    if(!r || !r.grid) return;
    seen.add(ri);
    let el = minimapEls.get(ri);
    if(!el){
      el = document.createElement('div');
      el.className = 'minimap-cell';
      panel.appendChild(el);
      minimapEls.set(ri, el);
    }
    el.style.left = (MINIMAP_OFFSET + r.grid.x * MINIMAP_CELL) + 'px';
    el.style.top  = (MINIMAP_OFFSET + r.grid.y * MINIMAP_CELL) + 'px';
    el.classList.toggle('current', ri === idx);
    el.classList.toggle('visited', visitedRooms.has(ri) && ri !== idx);
    el.classList.toggle('known', !visitedRooms.has(ri));
    el.classList.toggle('boss', !!r.boss);
  });
  for(const [ri, el] of minimapEls){
    if(!seen.has(ri)){ el.remove(); minimapEls.delete(ri); }
  }

  // Rebuilt every call — cheap at these counts (never more than a
  // handful of rooms), simpler than diffing edges the way cells are diffed.
  minimapSvg.innerHTML = '';
  seen.forEach(ri=>{
    const from = dungeon.rooms[ri];
    doorTargetsFor(dungeon, ri).forEach(to=>{
      if(to === ri || !seen.has(to)) return;
      const toRoom = dungeon.rooms[to];
      if(!toRoom || !toRoom.grid) return;
      const a = minimapCellCenter(from.grid), b = minimapCellCenter(toRoom.grid);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      line.setAttribute('class', 'minimap-edge');
      minimapSvg.appendChild(line);
    });
  });
}

// ---------- ROOM TRANSITIONS (derived from state, not simulated) ----------
let lastRoomId = null;
function checkRoomTransition(s){
  if(s.roomId === lastRoomId) return;
  lastRoomId = s.roomId;
  const dungeon = dungeonByName(s.dungeonName);
  if(!dungeon) return;
  if(s.safe){
    // A fresh entry into the safe room is the actual "a run just started
    // (or restarted after a wipe)" signal — reset the minimap here rather
    // than on a bare dungeonName change, which would miss rejoining the
    // same dungeon after leaving, or a wipe resetting the dungeon's rooms
    // out from under whatever was already explored.
    visitedRooms.clear();
    knownRooms.clear();
    minimapEls.forEach(el => el.remove());
    minimapEls.clear();
    showBanner("Safe Room — gather your party, then head for the light");
    return;
  }
  if(!s.boss){
    // A room can carry its own loreText (js/data.js — the "deeper in, more
    // lore" idea, Sherwood only for now) — falls back to the plain
    // dungeon name for rooms that don't define one.
    const room = currentRoomData(s);
    showBanner((room && room.loreText) || s.dungeonName);
    return;
  }
  // A rare boss variant (js/data.js's rareVariant, e.g. blackKnightRare)
  // carries its own introText — fall back to the dungeon's standard one
  // when the room rolled the ordinary boss.
  const bossMon = s.monsters.find(m => m.boss);
  const bossType = bossMon && ENEMY_TYPES[bossMon.type];
  showBanner((bossType && bossType.introText) || dungeon.bossIntroText);
}

// Same idea as checkRoomTransition, but for the branch fork — roomId
// doesn't change while a party stands at the fork or explores the side
// chamber (roomIndex is untouched, see server.js), so this needs its own
// edge-trigger on branchState instead.
let lastBranchState = null;
function checkBranchTransition(s){
  const state = s.branch ? s.branch.state : null;
  if(state === lastBranchState) return;
  lastBranchState = state;
  if(state === 'awaiting_choice') showBanner("A fork in the path…");
  else if(state === 'in_side_chamber'){
    const room = currentRoomData(s);
    if(room && room.sideChamber) showBanner(room.sideChamber.name);
  }
}

// Boss-defeat flavor text + currency earned used to show as a timed banner
// here — replaced by a dedicated, player-dismissed screen (server.js's
// dungeonSummary, watched in js/main.js) since a few seconds wasn't enough
// time to actually read it.

// ---------- DRAW ----------
function drawGate(spot, [r, g, b], label){
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
  ctx.beginPath();
  ctx.arc(spot.x, spot.y, spot.r, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${r},${g},${b},${0.12 + 0.1 * pulse})`;
  ctx.fill();
  ctx.strokeStyle = `rgba(${r},${g},${b},${0.6 + 0.4 * pulse})`;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.font = "13px Georgia"; ctx.textAlign = "center";
  ctx.fillText(label, spot.x, spot.y - spot.r - 10);
  ctx.textAlign = "left";
}

function draw(s){
  ctx.clearRect(0, 0, W, H);
  if(!s) return;

  const me = myPlayer(); // needed below for the auto-attack target-lock ring
  const dungeon = dungeonByName(s.dungeonName);
  // The safe room always reads as warm/torch-lit regardless of which
  // dungeon it belongs to — a deliberate visual break from the danger
  // colors of the rooms ahead, so it's obvious at a glance you're
  // somewhere nothing can hurt you.
  const floorColor = s.safe ? '#3d3020' : (dungeon ? dungeon.floorColor : '#222');
  const wallColor = s.safe ? '#241c12' : (dungeon ? dungeon.wallColor : '#111');

  // floor — tiled stone texture once loaded, color-washed per room so
  // each dungeon (and the safe room) still reads distinctly; a flat fill
  // until the texture finishes loading so there's never a blank frame.
  if(floorPattern){
    ctx.fillStyle = floorPattern;
    ctx.fillRect(-20, -20, W + 40, H + 40);
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = floorColor;
    ctx.fillRect(-20, -20, W + 40, H + 40);
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = floorColor;
    ctx.fillRect(-20, -20, W + 40, H + 40);
  }
  // walls border
  ctx.fillStyle = wallColor;
  ctx.fillRect(0, 0, W, 24); ctx.fillRect(0, H - 16, W, 16);
  ctx.fillRect(0, 0, 16, H); ctx.fillRect(W - 16, 0, 16, H);

  // Interior walls (MASTER_DESIGN.md §9, 2026-08-25) — real room geometry
  // (js/data.js's per-room `walls`) instead of one open rectangle. Same
  // color/read as the border so a carved-up room still feels like the same
  // stone, not a different material bolted on.
  const roomForWalls = currentRoomData(s);
  if(roomForWalls && roomForWalls.walls){
    roomForWalls.walls.forEach(w => ctx.fillRect(w.x, w.y, w.w, w.h));
  }

  // Exit gates — a pulsing circle of light the party walks into to advance.
  // Shared by the safe room's single exit and the branch fork's two/one
  // gates, just with different colors/labels.
  if(s.safe && s.safeExit){
    drawGate(s.safeExit, [232, 193, 74], s.waitingForFamily ? "Waiting for the whole family…" : "Enter when ready");
  }
  if(s.branch){
    const room = currentRoomData(s);
    const sideChamber = room && room.sideChamber;
    if(s.branch.state === 'awaiting_choice'){
      drawGate(s.branch.mainExit, [232, 193, 74], "Continue on");
      drawGate(s.branch.sideExit, [212, 60, 45], sideChamber ? sideChamber.warningText : "A harder road");
    } else if(s.branch.state === 'side_cleared_awaiting_return'){
      drawGate(s.branch.returnExit, [232, 193, 74], "Return to the path");
    }
  }
  // A plain room's exit gate(s) (MASTER_DESIGN.md §9, 2026-08-26) — only
  // ever present once the room is actually cleared (server-side, roomState
  // === 'awaiting_exit'), so there's simply nothing to walk into until then
  // — the Binding of Isaac "clear it, then the door(s) open" feel. A room
  // with real branching (`doors`, 2026-08-26's hub-and-spoke pass) sends
  // more than one, each with its own color/label.
  if(s.doors){
    s.doors.forEach(d => drawGate(d, d.color || [232, 193, 74], d.label));
  }

  // loot
  // Tinted per kind (§7) so a dropped artifact reads as different from a
  // weapon/armor token even before you reach it — gold for an artifact
  // (matches the top gear-tier color this used to always be), the token's
  // own *rolled* tier color for weapon/armor (2026-08-26 — each drop now
  // carries its own tier, server.js's pushGearLoot/rollGearTier, rather
  // than always matching whatever you're currently wearing), so a glimpse
  // of a gold-tinted drop on the ground is a real "that one's worth it"
  // signal rather than every token looking the same regardless of value.
  s.loot.forEach(l=>{
    let color = "#e8c14a";
    if(l.kind === 'weapon') color = WEAPON_TIERS[l.tier || 0].color;
    else if(l.kind === 'armor') color = ARMOR_TIERS[l.tier || 0].color;
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.rotate(performance.now() / 400);
    ctx.fillStyle = color;
    ctx.fillRect(-8, -8, 16, 16);
    ctx.restore();
  });

  // monsters
  s.monsters.forEach(mon=>{
    if(!mon.alive) return;
    const sprite = monsterSpriteFor(mon.type);

    // Same idea as players: HP bar/stun star/taunt ring hug the actual
    // drawn silhouette when a sprite is present, not the tiny collision
    // radius. The slam telegraph circle is a real gameplay AoE radius, not
    // decoration, so it always stays centered on the true position at full
    // scale regardless of sprite size.
    let visualCenterY = mon.y, visualRadius = mon.radius;

    if(sprite){
      const drawHeight = mon.radius * 6; // bumped from 4.5 2026-08-23 — sprites read too small, especially on phones (the whole 1000x750 world gets squeezed into a much smaller CSS box there)
      const drawWidth = drawHeight * (sprite.naturalWidth / sprite.naturalHeight);
      const drawX = mon.x - drawWidth / 2;
      const drawY = mon.y + mon.radius - drawHeight;
      ctx.save();
      applyFacingFlip(mon.x, facingFor(monsterFacing, mon.id, mon.x));
      ctx.drawImage(sprite, drawX, drawY, drawWidth, drawHeight);
      ctx.restore();
      visualCenterY = drawY + drawHeight / 2;
      visualRadius = drawHeight / 2 * 0.65;
    } else {
      ctx.beginPath();
      ctx.fillStyle = mon.color;
      ctx.arc(mon.x, mon.y, mon.radius, 0, Math.PI * 2);
      ctx.fill();
    }

    if(mon.stunTimer > 0){ ctx.fillStyle = "#fff"; ctx.font = "12px Georgia"; ctx.fillText("★", mon.x - 6, visualCenterY - visualRadius - 8); }
    if(mon.mesmerizeTimer > 0){ ctx.font = "14px Georgia"; ctx.fillText("💤", mon.x - 8, visualCenterY - visualRadius - 8); }
    if(mon.tauntTimer > 0){
      ctx.strokeStyle = "#c94040"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(mon.x, visualCenterY, visualRadius + 4, 0, Math.PI * 2); ctx.stroke();
    }
    const w = 40;
    ctx.fillStyle = "#000a"; ctx.fillRect(mon.x - w / 2, visualCenterY - visualRadius - 14, w, 6);
    ctx.fillStyle = mon.boss ? "#e8c14a" : "#c94040";
    ctx.fillRect(mon.x - w / 2, visualCenterY - visualRadius - 14, w * Math.max(0, mon.hp / mon.maxHp), 6);
    if(mon.slamState === 'telegraph'){
      ctx.beginPath();
      ctx.strokeStyle = "rgba(255,60,60,0.85)"; ctx.lineWidth = 3;
      ctx.arc(mon.x, mon.y, mon.slamRadius, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "rgba(255,60,60,0.15)"; ctx.fill();
    }
    // Charge (js/data.js's blackKnight charge* fields) — the telegraph draws
    // the actual dash line before it happens (direction locks in server-side
    // at telegraph start, see server.js's tickMonsters), so it's a real
    // dodge cue, not just decoration.
    if(mon.chargeState === 'telegraph'){
      ctx.save();
      ctx.strokeStyle = "rgba(255,150,40,0.85)"; ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(mon.x, mon.y);
      ctx.lineTo(mon.x + mon.chargeDirX * 220, mon.y + mon.chargeDirY * 220);
      ctx.stroke();
      ctx.restore();
    } else if(mon.chargeState === 'dashing'){
      ctx.strokeStyle = "rgba(255,150,40,0.9)"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(mon.x, mon.y, mon.radius + 6, 0, Math.PI * 2); ctx.stroke();
    }
    // Fear telegraph (js/data.js's blackKnight fear* fields) — a pulsing
    // purple ring at the actual fearRadius, distinct from slam's red so the
    // two AoE tells don't read the same at a glance.
    if(mon.fearState === 'telegraph'){
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 120);
      ctx.beginPath();
      ctx.strokeStyle = `rgba(150,60,210,${0.6 + 0.3 * pulse})`; ctx.lineWidth = 3;
      ctx.arc(mon.x, mon.y, mon.fearRadius, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "rgba(150,60,210,0.12)"; ctx.fill();
    }
    // Regrowth telegraph (Green Knight, js/data.js's regrow* fields) — a
    // pulsing green ring on the boss himself (not an AoE at range like the
    // other three, so no radius field to draw at — the "dodge" here is
    // dealing enough damage to interrupt it, not moving away), distinct
    // from slam(red)/charge(orange)/fear(purple).
    if(mon.regrowState === 'telegraph'){
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 120);
      ctx.beginPath();
      ctx.strokeStyle = `rgba(70,210,120,${0.6 + 0.3 * pulse})`; ctx.lineWidth = 3;
      ctx.arc(mon.x, mon.y, visualRadius + 10, 0, Math.PI * 2); ctx.stroke();
    }
    // Target-lock ring (auto-attack, server.js's tickAutoAttack) — only
    // drawn for the local player's own locked target, so it reads as "what
    // I'm fighting," not clutter from every player's target at once.
    if(me && me.targetId === mon.id){
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.arc(mon.x, visualCenterY, visualRadius + 10, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  });
  // Prune facing entries for monsters no longer in this snapshot — trash
  // spawns/despawns constantly over a long session, unlike players (small,
  // stable account ids), so this map actually needs the cleanup. A dead
  // monster still sits in `s.monsters` (alive:false) until the room
  // reloads, so a size comparison alone can't tell "stale" from "just
  // dead" — checking actual id membership is what's needed either way, and
  // it's cheap at these counts (never more than a couple dozen).
  if(monsterFacing.size > 0){
    const liveIds = new Set(s.monsters.map(mon => mon.id));
    for(const id of monsterFacing.keys()) if(!liveIds.has(id)) monsterFacing.delete(id);
  }

  // projectiles
  s.projectiles.forEach(p=>{
    ctx.beginPath(); ctx.fillStyle = "#7fd0ff"; ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
  });

  // players
  s.players.forEach(p=>{
    const sprite = spriteFor(p.classKey, p.gender);

    // Status rings (gear tier, block, buff, spawn protection) are meant to
    // visually hug the whole character. That's just p.radius when drawing
    // the old fallback circle, but a sprite is much taller than the tiny
    // collision radius, so ringCenterY/ringRadius describe its actual drawn
    // silhouette instead — collision/gameplay radius (p.radius) is
    // untouched, this is purely a rendering choice.
    let ringCenterY = p.y, ringRadius = p.radius;

    // A fallen player stays visible (dimmed) rather than vanishing — a
    // teammate needs to see where to go to revive them (server.js's
    // tickRevive, REVIVE_RANGE).
    ctx.save();
    if(p.dead) ctx.globalAlpha = 0.35;
    if(sprite){
      const drawHeight = p.radius * 6; // bumped from 4.5 2026-08-23, same reasoning as the monster sprite above
      const drawWidth = drawHeight * (sprite.naturalWidth / sprite.naturalHeight);
      const drawX = p.x - drawWidth / 2;
      const drawY = p.y + p.radius - drawHeight; // feet ~ bottom of the collision circle
      applyFacingFlip(p.x, facingFor(playerFacing, p.id, p.x));
      ctx.drawImage(sprite, drawX, drawY, drawWidth, drawHeight);
      ringCenterY = drawY + drawHeight / 2;
      ringRadius = drawHeight / 2 * 0.65;
    } else {
      ctx.beginPath();
      ctx.fillStyle = p.color;
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore(); // alpha back to 1 — the name/revive-bar below should always read clearly

    if(p.dead){
      ctx.fillStyle = "#ff9a9a"; ctx.font = "11px Georgia"; ctx.textAlign = "center";
      ctx.fillText(p.name + " — fallen", p.x, ringCenterY - ringRadius - 8);
      if(p.reviveProgress > 0){
        const barW = 50;
        const pct = Math.min(1, p.reviveProgress / REVIVE_CHANNEL_SECONDS);
        ctx.fillStyle = "#000a"; ctx.fillRect(p.x - barW / 2, ringCenterY - ringRadius - 20, barW, 6);
        ctx.fillStyle = "#5ac26a"; ctx.fillRect(p.x - barW / 2, ringCenterY - ringRadius - 20, barW * pct, 6);
      }
      ctx.textAlign = "left";
      return; // no status rings/gear badge while fallen — nothing to show
    }

    // Stun/fear (server.js's tickPlayers) — icon-only, same treatment as
    // the monster-side stun star/mesmerize icon above rather than another
    // ring, so it's readable at a glance without adding to the ring stack.
    if(p.stunTimer > 0){
      ctx.font = "14px Georgia"; ctx.textAlign = "center";
      ctx.fillText("💫", p.x, ringCenterY - ringRadius - 8);
      ctx.textAlign = "left";
    } else if(p.fearTimer > 0){
      ctx.font = "14px Georgia"; ctx.textAlign = "center";
      ctx.fillText("😱", p.x, ringCenterY - ringRadius - 8);
      ctx.textAlign = "left";
    }

    // Ring color reads Armor (what you visually look protected by);
    // Weapon gets the badge icon below; an owned artifact adds its own
    // glow ring — no bespoke per-artifact icon needed (§7).
    ctx.strokeStyle = ARMOR_TIERS[p.armorTier].color;
    ctx.lineWidth = p.id === myId ? 4 : 2;
    ctx.beginPath(); ctx.arc(p.x, ringCenterY, ringRadius, 0, Math.PI * 2); ctx.stroke();
    if(p.artifacts && p.artifacts.length > 0){
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 220);
      ctx.strokeStyle = `rgba(232,193,74,${0.5 + 0.4 * pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, ringCenterY, ringRadius + 4, 0, Math.PI * 2); ctx.stroke();
    }
    if(p.blockActive){
      ctx.strokeStyle = "rgba(220,230,240,0.9)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, ringCenterY, ringRadius + 6, 0, Math.PI * 2); ctx.stroke();
    }
    if(p.buffMult > 1){
      ctx.strokeStyle = "rgba(232,193,74,0.9)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, ringCenterY, ringRadius + 10, 0, Math.PI * 2); ctx.stroke();
    }
    if(p.hasteMult > 1){
      ctx.strokeStyle = "rgba(154,91,201,0.85)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, ringCenterY, ringRadius + 8, 0, Math.PI * 2); ctx.stroke();
    }
    if(p.spawnProtection > 0){
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 150);
      ctx.strokeStyle = `rgba(255,255,255,${0.35 + 0.35 * pulse})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(p.x, ringCenterY, ringRadius + 14, 0, Math.PI * 2); ctx.stroke();
    }
    // Weapon tier badge (skipped for the base tier — no icon for the
    // default, and nothing to call out yet). Visible for every player, not
    // just yourself, same "party at a glance" idea as the roster HUD.
    const weaponIcon = p.weaponTier > 0 ? tierSpriteFor(weaponSprites, p.weaponTier) : null;
    if(weaponIcon){
      const badgeSize = 22;
      const badgeX = p.x + ringRadius * 0.6;
      const badgeY = ringCenterY + ringRadius * 0.6;
      ctx.beginPath();
      ctx.fillStyle = "rgba(20,15,8,.75)";
      ctx.arc(badgeX, badgeY, badgeSize / 2 + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = WEAPON_TIERS[p.weaponTier].color; ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.drawImage(weaponIcon, badgeX - badgeSize / 2, badgeY - badgeSize / 2, badgeSize, badgeSize);
    }
    if(p.id !== myId){
      ctx.fillStyle = "#fff"; ctx.font = "11px Georgia"; ctx.textAlign = "center";
      ctx.fillText(p.name, p.x, ringCenterY - ringRadius - 8);
      ctx.textAlign = "left";
    }
  });
}

// ---------- RENDER LOOP ----------
// Runs independently of the network — just redraws whatever the latest
// snapshot is. No interpolation/prediction yet; add it only if the plain
// 20Hz-snapshot look turns out to be a problem in practice.
function renderLoop(){
  // A single bad frame must never permanently kill rendering. Before this,
  // an uncaught exception anywhere in the block below (e.g. `state` briefly
  // undefined on the very first frame, if main.js hadn't quite finished
  // initializing yet by the time this file's first requestAnimationFrame
  // call landed) meant this function returned via the exception *before*
  // reaching requestAnimationFrame(renderLoop) below — the loop never
  // rearmed itself, so the game froze on whatever was last drawn, forever,
  // with nothing in the UI to show anything had gone wrong. Confirmed live
  // 2026-08-26: exactly this ("Uncaught ReferenceError: state is not
  // defined at renderLoop"). Now: log and skip this one frame, try again
  // next frame — self-heals within ~16ms once the transient cause clears,
  // instead of never recovering at all.
  try {
    if(state === 'game' && latestState){
      checkRoomTransition(latestState);
      checkBranchTransition(latestState);
      updateHud(latestState);
      updateRoster(latestState);
      updateMinimap(latestState);
      draw(latestState);
    }
  } catch (err) {
    console.error('[render] frame error (skipped, retrying next frame):', err);
  }
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);
