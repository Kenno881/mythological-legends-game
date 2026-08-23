"use strict";

// ---------- DATA: CLASSES ----------
const CLASSES = {
  squire: {
    name: "Squire", tag: "Easy — great for young knights",
    desc1: "One button smashes. One shield bash saves the day.",
    desc2: "Tough as oak. Hard to go wrong.",
    color:"#c94040", hp:130, speed:190, radius:16,
    sprite: "assets/sprites/squire.png",
    attack:{dmg:14, range:34, cd:0.35},
    special1:{name:"Shield Bash", cd:7, dmg:10, radius:70, stun:1.4, cost:0},
    hasMana:false
  },
  knight: {
    name: "Knight", tag: "Moderate — tank & protector",
    desc1: "Attack, Parry incoming blows, and Taunt foes off allies.",
    desc2: "Positioning and timing matter.",
    color:"#8a8a86", hp:110, speed:200, radius:16,
    sprite: "assets/sprites/knight.png",
    attack:{dmg:12, range:36, cd:0.4},
    special1:{name:"Parry", cd:6, block:0.65, dur:1.0, cost:0},
    special2:{name:"Taunt", cd:9, radius:150, dur:4, cost:0},
    hasMana:false
  },
  apprentice: {
    name: "Merlin's Apprentice", tag: "Complex — ranged spellcaster",
    desc1: "Arcane Bolt from range, Nova to clear a crowd.",
    desc2: "Manage mana. Keep your distance.",
    color:"#4090c9", hp:75, speed:190, radius:14,
    sprite: "assets/sprites/merlinsapprentice.png",
    attack:{dmg:11, range:280, cd:0.5, cost:8, projectile:true},
    special1:{name:"Arcane Nova", cd:5, dmg:26, radius:110, cost:35},
    hasMana:true, maxMana:100, manaRegen:9
  },
  cleric: {
    name: "Avalon Cleric", tag: "Complex — keeps the party alive",
    desc1: "Staff strikes, Healing Light, and a group Blessing.",
    desc2: "Watch everyone's health, not just your own.",
    color:"#e8c14a", hp:85, speed:195, radius:14,
    sprite: "assets/sprites/avaloncleric.png",
    attack:{dmg:8, range:40, cd:0.5},
    special1:{name:"Healing Light", cd:3, heal:32, cost:20},
    special2:{name:"Blessing", cd:14, heal:22, buff:1.3, buffDur:8, cost:55},
    hasMana:true, maxMana:100, manaRegen:8
  },
  enchanter: {
    name: "Enchanter", tag: "Complex — crowd control",
    desc1: "Mesmerize a foe out of the fight, then speed the party up.",
    desc2: "Control the battlefield instead of just hitting harder.",
    color:"#9a5bc9", hp:70, speed:190, radius:14,
    sprite: "assets/sprites/enchanter.png",
    attack:{dmg:8, range:260, cd:0.5, cost:6, projectile:true},
    // Single-target hard CC — locks one non-boss enemy out of the fight
    // entirely until it's hit (breaks the mez) or the duration runs out.
    special1:{name:"Mesmerize", cd:8, dur:5, cost:30, range:260},
    special2:{name:"Group Haste", cd:16, dur:10, mult:1.3, cost:45},
    hasMana:true, maxMana:90, manaRegen:8
  }
};

// ---------- DATA: GEAR TIERS ----------
const GEAR_TIERS = [
  {name:"Iron",   mult:1.0,  color:"#9a9a92", sprite:"assets/sprites/gear_tier_iron.png"},
  {name:"Steel",  mult:1.35, color:"#c7d3de", sprite:"assets/sprites/gear_tier_steel.png"},
  {name:"Silver", mult:1.75, color:"#dfe6ee", sprite:"assets/sprites/gear_tier_silver.png"},
  {name:"Excalibur Shard", mult:2.4, color:"#e8c14a", sprite:"assets/sprites/gear_tier_excalibur.png"}
];

// ---------- DATA: DUNGEONS ----------
// Rooms are simple: each has enemy spawns; last room is the boss.
const DUNGEONS = [
  { name: "Sherwood Approach",
    floorColor: "#2f3b23", wallColor: "#1c2417",
    bossIntroText: "The Black Knight of the Ford blocks the path",
    bossDefeatText: "The Black Knight falls! The way to the marshes opens...",
    // The Ambush Hollow — optional detour off room 1 (branch: true below).
    // Tougher than that room's own bandit trio (two dark knights, not
    // one, plus a bandit) in exchange for a guaranteed drop instead of
    // the usual 35% chance — see server.js's dropLoot().
    sideChamber: {
      name: "The Ambush Hollow",
      warningText: "A harder road — tougher foes wait, but the loot is worth it.",
      enemies: [
        {type:"darkKnight", x:450, y:220}, {type:"darkKnight", x:620, y:420},
        {type:"bandit", x:350, y:480}
      ]
    },
    rooms: [
      { safe: true, enemies: [] },
      { branch: true, enemies: [
          {type:"bandit", x:420, y:200}, {type:"bandit", x:600, y:400},
          {type:"bandit", x:300, y:500}
        ]},
      { enemies: [
          {type:"darkKnight", x:500, y:250}, {type:"bandit", x:700, y:450},
          {type:"bandit", x:250, y:350}, {type:"darkKnight", x:650, y:180}
        ]},
      { boss: true, enemies: [ {type:"blackKnight", x:500, y:280} ] }
    ]
  },
  { name: "The Sunken Chapel",
    floorColor: "#233a3d", wallColor: "#122024",
    bossIntroText: "A hush falls — the Green Knight rises from the flooded nave",
    bossDefeatText: "The Green Knight yields the exchange! Deeper into the keep...",
    rooms: [
      { safe: true, enemies: [] },
      { enemies: [
          {type:"zombie", x:400, y:220}, {type:"zombie", x:620, y:420},
          {type:"wraith", x:300, y:480}, {type:"wraith", x:700, y:250}
        ]},
      { enemies: [
          {type:"zombie", x:450, y:200}, {type:"zombie", x:550, y:500},
          {type:"wraith", x:250, y:350}, {type:"wraith", x:750, y:350}, {type:"zombie", x:600, y:230}
        ]},
      { boss: true, enemies: [ {type:"greenKnight", x:500, y:280} ] }
    ]
  },
  { name: "Mordred's Keep",
    floorColor: "#2a2226", wallColor: "#150f12",
    bossIntroText: "Mordred himself descends the stair, blade drawn",
    bossDefeatText: "Mordred is cast down! Only the mist-shrouded peak remains...",
    rooms: [
      { safe: true, enemies: [] },
      { enemies: [
          {type:"direKnight", x:420, y:220}, {type:"darkKnight", x:620, y:420},
          {type:"darkKnight", x:300, y:480}
        ]},
      { enemies: [
          {type:"direKnight", x:450, y:200}, {type:"direKnight", x:600, y:480},
          {type:"darkKnight", x:250, y:330}, {type:"darkKnight", x:750, y:350}
        ]},
      { boss: true, enemies: [ {type:"mordred", x:500, y:280} ] }
    ]
  },
  { name: "Avalon's Mist",
    floorColor: "#2a2740", wallColor: "#161425",
    bossIntroText: "Through the mist, the Questing Beast unfurls its wings",
    bossDefeatText: "The Questing Beast falls silent. Camelot is saved.",
    finalVictoryTitle: "Camelot is Saved",
    finalVictorySubtitle: "The Round Table stands whole once more. Well fought, champion.",
    rooms: [
      { safe: true, enemies: [] },
      { enemies: [
          {type:"mistWraith", x:400, y:220}, {type:"mistWraith", x:620, y:420},
          {type:"direKnight", x:300, y:480}
        ]},
      { enemies: [
          {type:"mistWraith", x:450, y:200}, {type:"mistWraith", x:600, y:480},
          {type:"mistWraith", x:250, y:330}, {type:"direKnight", x:750, y:350}
        ]},
      { boss: true, enemies: [ {type:"questingBeast", x:500, y:280} ] }
    ]
  }
];

// ---------- DATA: ENEMY TYPES ----------
// Stats bumped 2026-08-23 (trash ~+22% HP, bosses ~+15% HP, all ~+12%
// damage) — a full family of 4 was steamrolling these; this is a first
// pass toward "hard on the first try, still beatable," reassessed by
// actually playing it rather than picked from DPS math. Death now has
// real stakes (revive-by-teammate-or-wipe, server.js), which is most of
// what makes this land as "tough" rather than just slower.
const ENEMY_TYPES = {
  bandit:       {hp:46,  speed:110, dmg:9,  radius:15, color:"#7a5a3a", range:30, cd:0.9, xpGear:0.15,
                 sprite:"assets/sprites/bandit.png"},
  darkKnight:   {hp:85,  speed:95,  dmg:15, radius:17, color:"#4a4a52", range:34, cd:1.1, xpGear:0.3,
                 sprite:"assets/sprites/darkknight.png"},
  blackKnight:  {hp:480, speed:80,  dmg:22, radius:26, color:"#241a1a", range:46, cd:1.3, boss:true,
                 slamCd:4.5, slamRadius:120, slamDmg:34, slamTelegraph:1.1,
                 sprite:"assets/sprites/blackknightboss.png"},
  zombie:       {hp:67,  speed:70,  dmg:11, radius:16, color:"#4a5a3a", range:32, cd:1.0, xpGear:0.15,
                 sprite:"assets/sprites/zombie.png"},
  wraith:       {hp:34,  speed:155, dmg:10, radius:13, color:"#7ab0a0", range:28, cd:0.7, xpGear:0.15,
                 sprite:"assets/sprites/wraith.png"},
  greenKnight:  {hp:575, speed:92,  dmg:20, radius:24, color:"#1f5b45", range:42, cd:1.0, boss:true,
                 slamCd:4.2, slamRadius:110, slamDmg:30, slamTelegraph:1.0,
                 sprite:"assets/sprites/greenknight.png"},
  direKnight:   {hp:104, speed:105, dmg:17, radius:18, color:"#2a2a30", range:36, cd:1.0, xpGear:0.3,
                 sprite:"assets/sprites/direknight.png"},
  mordred:      {hp:690, speed:98,  dmg:25, radius:26, color:"#7a1f2b", range:46, cd:1.1, boss:true,
                 slamCd:3.8, slamRadius:130, slamDmg:36, slamTelegraph:1.0,
                 sprite:"assets/sprites/mordred.png"},
  mistWraith:   {hp:49,  speed:135, dmg:12, radius:14, color:"#8adfe0", range:30, cd:0.8, xpGear:0.2,
                 sprite:"assets/sprites/mistwraith.png"},
  questingBeast:{hp:860, speed:88,  dmg:28, radius:30, color:"#3a1f5b", range:50, cd:1.2, boss:true,
                 slamCd:3.5, slamRadius:150, slamDmg:38, slamTelegraph:0.9,
                 sprite:"assets/sprites/questingbeast.png"}
};

// Shared with server.js's revive channel timer, so the client's revive
// progress bar (js/render.js) always matches how long the server actually
// requires — one source of truth instead of two magic numbers drifting.
const REVIVE_CHANNEL_SECONDS = 4;

// Shared with the Node server (server/server.js) so class/enemy/dungeon stats
// live in exactly one place. No-op in the browser, where `module` is
// undefined. Deliberately does NOT include the connection passphrase — that
// lives only in server.js, since this file ships to the browser as plain JS
// and anyone can read it from page source.
if(typeof module !== 'undefined' && module.exports){
  module.exports = { CLASSES, GEAR_TIERS, DUNGEONS, ENEMY_TYPES, REVIVE_CHANNEL_SECONDS };
}
