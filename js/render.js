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
// Preloaded once at startup from CLASSES/ENEMY_TYPES/GEAR_TIERS's `sprite`
// fields. Anything with no `sprite` entry (or one that hasn't finished
// loading yet) just falls back to the plain colored shape this game always
// drew — nothing breaks while art is still in progress for a given class,
// monster, or gear tier.
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

const characterSprites = loadSprites(CLASSES);
const monsterSprites = loadSprites(ENEMY_TYPES);
const gearSprites = GEAR_TIERS.map(t => {
  if(!t.sprite) return null;
  const img = new Image();
  img.src = t.sprite;
  return img;
});
function spriteFor(classKey){ return readySprite(characterSprites, classKey); }
function monsterSpriteFor(type){ return readySprite(monsterSprites, type); }
function gearSpriteFor(tier){
  const img = gearSprites[tier];
  return (img && img.complete && img.naturalWidth > 0) ? img : null;
}

// ---------- BANNER / LOOT TOAST ----------
let bannerTimeout = null;
function showBanner(text){
  const b = document.getElementById('banner');
  b.textContent = text;
  b.classList.add('show');
  clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(()=> b.classList.remove('show'), 2200);
}
function showLoot(text){
  const t = document.getElementById('loot-toast');
  t.textContent = text;
  t.classList.add('show');
  setTimeout(()=> t.classList.remove('show'), 1600);
}

// ---------- HUD ----------
let lastGearTier = 0;
let lastHudGearTier = -1; // -1 so the icon syncs on the very first updateHud call
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
  document.getElementById('gearLabelText').textContent = 'Gear: ' + GEAR_TIERS[me.gearTier].name;
  if(me.gearTier !== lastHudGearTier){
    lastHudGearTier = me.gearTier;
    const gearTierData = GEAR_TIERS[me.gearTier];
    const gearIconEl = document.getElementById('gearIcon');
    gearIconEl.classList.toggle('hidden', !gearTierData.sprite);
    if(gearTierData.sprite) gearIconEl.src = gearTierData.sprite;
  }
  document.getElementById('classLabel').textContent = CLASSES[me.classKey].name;

  const c = CLASSES[me.classKey];
  setCdVisual('cdSpecial1', me.cds.special1, c.special1 ? c.special1.cd : 1);
  document.getElementById('btnSpecial2').classList.toggle('hidden', !c.special2);
  if(c.special2) setCdVisual('cdSpecial2', me.cds.special2, c.special2.cd);

  if(me.gearTier > lastGearTier){
    showLoot(`Found ${GEAR_TIERS[me.gearTier].name} gear!`);
  }
  lastGearTier = me.gearTier;
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
  if(s.safe) showBanner("Safe Room — gather your party, then head for the light");
  else showBanner(s.boss ? dungeon.bossIntroText : s.dungeonName);
}

// ---------- DRAW ----------
function draw(s){
  ctx.clearRect(0, 0, W, H);
  if(!s) return;

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

  // safe room exit — a pulsing gate of light the party walks into when ready
  if(s.safe && s.safeExit){
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
    ctx.beginPath();
    ctx.arc(s.safeExit.x, s.safeExit.y, s.safeExit.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(232,193,74,${0.12 + 0.1 * pulse})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(232,193,74,${0.6 + 0.4 * pulse})`;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "#e8c14a"; ctx.font = "13px Georgia"; ctx.textAlign = "center";
    ctx.fillText(
      s.waitingForFamily ? "Waiting for the whole family…" : "Enter when ready",
      s.safeExit.x, s.safeExit.y - s.safeExit.r - 10
    );
    ctx.textAlign = "left";
  }

  // loot
  s.loot.forEach(l=>{
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.rotate(performance.now() / 400);
    ctx.fillStyle = GEAR_TIERS[GEAR_TIERS.length - 1].color;
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
      const drawHeight = mon.radius * 4.5;
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
  });

  // projectiles
  s.projectiles.forEach(p=>{
    ctx.beginPath(); ctx.fillStyle = "#7fd0ff"; ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
  });

  // players
  s.players.forEach(p=>{
    if(p.dead) return;
    const sprite = spriteFor(p.classKey);

    // Status rings (gear tier, block, buff, spawn protection) are meant to
    // visually hug the whole character. That's just p.radius when drawing
    // the old fallback circle, but a sprite is much taller than the tiny
    // collision radius, so ringCenterY/ringRadius describe its actual drawn
    // silhouette instead — collision/gameplay radius (p.radius) is
    // untouched, this is purely a rendering choice.
    let ringCenterY = p.y, ringRadius = p.radius;

    if(sprite){
      const drawHeight = p.radius * 4.5;
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

    ctx.strokeStyle = GEAR_TIERS[p.gearTier].color;
    ctx.lineWidth = p.id === myId ? 4 : 2;
    ctx.beginPath(); ctx.arc(p.x, ringCenterY, ringRadius, 0, Math.PI * 2); ctx.stroke();
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
    // Gear tier badge (skipped for Iron — no icon for the default tier, and
    // nothing to call out yet). Visible for every player, not just yourself,
    // same "party at a glance" idea as the roster HUD.
    const gearIcon = p.gearTier > 0 ? gearSpriteFor(p.gearTier) : null;
    if(gearIcon){
      const badgeSize = 22;
      const badgeX = p.x + ringRadius * 0.6;
      const badgeY = ringCenterY + ringRadius * 0.6;
      ctx.beginPath();
      ctx.fillStyle = "rgba(20,15,8,.75)";
      ctx.arc(badgeX, badgeY, badgeSize / 2 + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = GEAR_TIERS[p.gearTier].color; ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.drawImage(gearIcon, badgeX - badgeSize / 2, badgeY - badgeSize / 2, badgeSize, badgeSize);
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
    updateHud(latestState);
    updateRoster(latestState);
    draw(latestState);
  }
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);
