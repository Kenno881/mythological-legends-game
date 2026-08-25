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
  // Locked-but-not-yet-learned (§10's unlockLevel) reads exactly like
  // "this class doesn't have one" already did — same hidden button, no
  // dead-button feel, no separate "locked" visual state to design.
  const special2Learned = c.special2 && (!c.special2.unlockLevel || me.level >= c.special2.unlockLevel);
  document.getElementById('btnSpecial2').classList.toggle('hidden', !special2Learned);
  if(special2Learned) setCdVisual('cdSpecial2', me.cds.special2, c.special2.cd);

  // Loot toast fires for whichever slot actually changed since the last
  // update — each checked independently since a boss kill can grant more
  // than one at once (its artifact plus a weapon/armor token).
  if(me.weaponTier > lastWeaponTier) showLoot(`Found ${WEAPON_TIERS[me.weaponTier].name}!`);
  if(me.armorTier > lastArmorTier) showLoot(`Found ${ARMOR_TIERS[me.armorTier].name}!`);
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

// ---------- ROOM TRANSITIONS (derived from state, not simulated) ----------
let lastRoomId = null;
function checkRoomTransition(s){
  if(s.roomId === lastRoomId) return;
  lastRoomId = s.roomId;
  const dungeon = dungeonByName(s.dungeonName);
  if(!dungeon) return;
  if(s.safe){ showBanner("Safe Room — gather your party, then head for the light"); return; }
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

  // loot
  // Tinted per kind (§7) so a dropped artifact reads as different from a
  // weapon/armor token even before you reach it — gold for an artifact
  // (matches the top gear-tier color this used to always be), the tier's
  // own color for a weapon/armor token at your current tier for that slot.
  s.loot.forEach(l=>{
    const me = myPlayer();
    let color = "#e8c14a";
    if(l.kind === 'weapon') color = WEAPON_TIERS[me ? me.weaponTier : 0].color;
    else if(l.kind === 'armor') color = ARMOR_TIERS[me ? me.armorTier : 0].color;
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
      ctx.drawImage(sprite, drawX, drawY, drawWidth, drawHeight);
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
  if(state === 'game' && latestState){
    checkRoomTransition(latestState);
    checkBranchTransition(latestState);
    updateHud(latestState);
    updateRoster(latestState);
    draw(latestState);
  }
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);
