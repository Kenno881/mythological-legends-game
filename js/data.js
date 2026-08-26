"use strict";

// ---------- DATA: CLASSES ----------
// special2.unlockLevel (added 2026-08-25, reconciled onto Phase 3's
// account-wide leveling+boons work — see MASTER_DESIGN.md §10) gates the
// button behind a level requirement — server.js's doSpecial() and
// js/render.js's HUD both check it the same way a class simply not having
// special2 was already handled (hidden button, silent no-op). Squire and
// Merlin's Apprentice didn't have a special2 at all before this — Second
// Wind and Blink are new, not just newly-gated versions of something that
// already existed.
const CLASSES = {
  squire: {
    name: "Squire", tag: "Easy — great for young knights",
    desc1: "One button smashes. One shield bash saves the day.",
    desc2: "Tough as oak. Hard to go wrong.",
    color:"#c94040", hp:130, speed:190, radius:16,
    sprite: "assets/sprites/squire.png",
    attack:{dmg:14, range:34, cd:0.35},
    special1:{name:"Shield Bash", cd:7, dmg:10, radius:70, stun:1.4, cost:0},
    // Self-target, no aim, no cost — same "hard to go wrong" shape as
    // Shield Bash. A flat heal plus a brief damage-reduction shield, not a
    // spell — keeps Squire's identity as the tanky one-button class even
    // once he has two buttons.
    special2:{name:"Second Wind", cd:12, heal:40, shield:0.5, shieldDur:2, cost:0, unlockLevel:3},
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
    special2:{name:"Taunt", cd:9, radius:150, dur:4, cost:0, unlockLevel:3},
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
    // Answers Apprentice's real weakness (75 HP, zero mobility) rather than
    // being filler — an instant reposition away from whatever's closing the
    // gap, reinforcing "keep your distance" as an actual playable habit
    // instead of just flavor text.
    special2:{name:"Blink", cd:10, dist:220, cost:25, unlockLevel:3},
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
    special2:{name:"Blessing", cd:14, heal:22, buff:1.3, buffDur:8, cost:55, unlockLevel:3},
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
    special2:{name:"Group Haste", cd:16, dur:10, mult:1.3, cost:45, unlockLevel:3},
    hasMana:true, maxMana:90, manaRegen:8
  }
};

// ---------- DATA: GEAR ----------
// Three slots (MASTER_DESIGN.md §7, built 2026-08-24 — replaces the old
// single flat gearTier). Weapon/Armor keep the same 4-tier shape gear
// always had, just as two independent ladders now; both reuse the same
// 4 sprite files (no new art needed — a generic tier icon differentiated
// by its on-screen label is enough, distinct weapon/armor art is a later
// polish pass). Artifact is a separate, curated catalog — see ARTIFACTS.
const WEAPON_TIERS = [
  {name:"Iron Blade",   mult:1.0,  color:"#9a9a92", sprite:"assets/sprites/gear_tier_iron.png"},
  {name:"Steel Blade",  mult:1.35, color:"#c7d3de", sprite:"assets/sprites/gear_tier_steel.png"},
  {name:"Silver Blade", mult:1.75, color:"#dfe6ee", sprite:"assets/sprites/gear_tier_silver.png"},
  {name:"Excalibur",    mult:2.4,  color:"#e8c14a", sprite:"assets/sprites/gear_tier_excalibur.png"}
];
const ARMOR_TIERS = [
  {name:"Iron Mail",       mult:1.0,  color:"#9a9a92", sprite:"assets/sprites/gear_tier_iron.png"},
  {name:"Steel Plate",     mult:1.35, color:"#c7d3de", sprite:"assets/sprites/gear_tier_steel.png"},
  {name:"Silver Plate",    mult:1.75, color:"#dfe6ee", sprite:"assets/sprites/gear_tier_silver.png"},
  {name:"Aegis of Avalon", mult:2.4,  color:"#e8c14a", sprite:"assets/sprites/gear_tier_excalibur.png"}
];

// Curated unique items, one per Arc I boss (MASTER_DESIGN.md §7's first
// full catalog pass) — bespoke passive effects wired in server.js, not a
// generic stat tier. `bossType` is the ENEMY_TYPES key it drops from.
// Two of the five drafted effects were trimmed to match what the game
// actually has: Charge never stuns a player (only damages), and no fear/
// flee mechanic exists yet, so those clauses were dropped rather than
// implying a mechanic that isn't real — see the "why" for each.
const ARTIFACTS = {
  fordWardenBuckler: {
    name: "Ford-Warden's Buckler", bossType: "blackKnight",
    description: "Below 25% HP, block the next hit entirely (once per 20s)."
  },
  gorlagonCrimsonSpur: {
    name: "Gorlagon's Crimson Spur", bossType: "blackKnightRare",
    description: "+10% move speed, always."
  },
  greenKnightGirdle: {
    name: "The Green Knight's Girdle", bossType: "greenKnight",
    description: "Once per dungeon run, a killing blow leaves you at 1 HP instead of dying."
  },
  mordredBrokenBlade: {
    name: "Mordred's Broken Blade", bossType: "mordred",
    description: "+15% damage on the first hit against each new room's enemies."
  },
  beastHideMantle: {
    name: "Beast-Hide Mantle", bossType: "questingBeast",
    description: "+10% max HP."
  }
};

// ---------- DATA: BOONS ----------
// Phase 3's in-run choice moment (MASTER_DESIGN.md §10) — offered 3 at a
// time on level-up, applied instantly, gone at the end of the run win or
// lose. Generic (class-agnostic) rather than a bespoke pool per class for
// this first pass — a real per-class pool is genuine content-design work of
// its own, and §10a's eventual "8 skills, pick 4" plan is really the fuller
// version of this same idea once it exists. Effect magnitudes are applied
// in server.js's applyBoonChoice(); each stacks multiplicatively if the
// same one comes up again on a later level-up this same run.
const BOONS = {
  ironWill: { name: "Iron Will", description: "+20% max HP, right now." },
  keenEdge: { name: "Keen Edge", description: "+15% damage, for the rest of this run." },
  swiftBoots: { name: "Swift Boots", description: "+12% move speed, for the rest of this run." }
};

// XP curve — a function, not a table, because both server.js (does the
// actual leveling) and render.js (draws the "X/Y xp" progress text) need
// the exact same formula; a plain data table would need is the same
// duplication risk this file otherwise avoids by living in one place. First
// cut, not validated by real family play — see MASTER_DESIGN.md §13.
function xpToNextLevel(level){ return 60 + (level - 1) * 40; }

// ---------- DATA: DUNGEONS ----------
// Rooms are simple: each has enemy spawns; last room is the boss.
const DUNGEONS = [
  { name: "Sherwood Approach",
    // Level bands (2026-08-25, MASTER_DESIGN.md §5's "eventual direction,
    // not built" — now built) — minLevel gates joining at all (checked
    // server-side at 'join'), xpCapLevel is a ceiling on XP *earned while
    // playing this dungeon*, not on joining it: once a character reaches
    // xpCapLevel, further kills here grant 0 xp (server.js's grantXp) so
    // grinding the easy tutorial dungeon forever can't out-level the game.
    // Bands deliberately overlap (a dungeon's minLevel sits below the
    // previous one's cap) rather than requiring you to fully max one out
    // before the next unlocks. First-cut numbers, not validated by real
    // family play — see §13.
    minLevel: 1, xpCapLevel: 8,
    floorColor: "#2f3b23", wallColor: "#1c2417",
    bossIntroText: "The Black Knight of the Ford blocks the path",
    bossDefeatText: "The Black Knight falls! The way to the marshes opens...",
    // Shown on the dungeon-select screen — why the party's here, what
    // needs doing, and what's actually at stake (§ dungeon-select,
    // 2026-08-24). Every dungeon carries one of these; only Sherwood gets
    // per-room loreText too (below) as the "deeper in, more lore" proof
    // of concept — extending that to the other 3 is a later pass.
    lore: {
      why: "Bandits have overrun the old forest road into Camelot, and Merlin senses a darker presence behind them — a fallen knight guarding the ford beyond.",
      objective: "Clear the road, break the bandits' hold, and put down whatever commands them at the ford.",
      reward: "Safe passage to the marshlands beyond, and the first coin for the family's coffers."
    },
    rooms: [
      { safe: true, enemies: [] },
      // Forest Crossroads (reshaped 2026-08-25, MASTER_DESIGN.md §9 — real
      // wall-carved exploration instead of two gates floating side by side
      // in an open field). Clear the hub trio, then the room's actual
      // layout gives 3 real directions instead of a menu: a top lane to the
      // Ambush Hollow fork, a middle lane onward, and a bottom lane to an
      // unguarded secret nook — reward is finding it, not fighting for it.
      // `walls` carves 2 horizontal dividers spanning the room's right
      // two-thirds; the hub (left third) stays open into all 3 lanes at
      // once, so which one you commit to is an actual choice made by
      // walking, not a click.
      { branch: true,
        loreText: "Bandit tracks crisscross the muddy road, forking three ways ahead — they're closer to Camelot than anyone realized.",
        walls: [
          { x: 300, y: 212, w: 684, h: 24 },
          { x: 300, y: 514, w: 684, h: 24 }
        ],
        exits: { main: { x: 900, y: 375, r: 45 }, side: { x: 900, y: 120, r: 45 } },
        secretNook: { x: 900, y: 630 },
        sideChamber: {
          name: "The Ambush Hollow",
          warningText: "A harder road — tougher foes wait, but the loot is worth it.",
          enemies: [
            {type:"darkKnight", x:450, y:260}, {type:"darkKnight", x:620, y:420},
            {type:"bandit", x:350, y:480}
          ]
        },
        enemies: [
          {type:"bandit", x:220, y:150}, {type:"bandit", x:220, y:600},
          {type:"bandit", x:260, y:375}
        ]},
      // Old Watchtower — a second fork. Main path is a modest fixed fight;
      // the side chamber (Poacher's Den) is guarded by a real mini-boss
      // (the Bandit Captain, §6 of MASTER_DESIGN.md's encounter tiers —
      // first thing to actually occupy that tier) for guaranteed loot.
      { branch: true,
        loreText: "An abandoned watchtower looms ahead, its garrison long since turned to banditry.",
        sideChamber: {
          name: "The Poacher's Den",
          warningText: "Their captain keeps watch here — worth the fight.",
          enemies: [
            {type:"banditCaptain", x:500, y:280},
            {type:"bandit", x:350, y:420}, {type:"bandit", x:650, y:420}
          ]
        },
        enemies: [
          {type:"darkKnight", x:500, y:250}, {type:"bandit", x:680, y:420},
          {type:"bandit", x:320, y:420}
        ]},
      // The Sunken Trail — a continuous-spawn wave encounter (§9's
      // escalating-spawn direction, first slice of it, Sherwood-only for
      // now). Kill quota drives escalation: spawns get faster and enemies
      // get tougher as killsSoFar climbs — see server.js's tickWaveSpawns.
      { wave: true, killTarget: 14, maxAlive: 5,
        loreText: "The road dips into marshland — and something is stirring in the reeds ahead.",
        spawnPoints: [
          {x:450, y:200}, {x:700, y:250}, {x:300, y:500},
          {x:650, y:550}, {x:500, y:400}
        ],
        pool: [ {type:"bandit", w:3}, {type:"darkKnight", w:1} ]
      },
      // Boss room — usually the Black Knight, rarely (see rareVariant)
      // Sir Gorlagon instead, per §5/§6/§9's "sometimes it's someone
      // special" rare-boss idea.
      { boss: true, enemies: [ {type:"blackKnight", x:500, y:280} ],
        rareVariant: { type: "blackKnightRare", chance: 0.12 } }
    ]
  },
  { name: "The Sunken Chapel",
    minLevel: 5, xpCapLevel: 16,
    floorColor: "#233a3d", wallColor: "#122024",
    bossIntroText: "A hush falls — the Green Knight rises from the flooded nave",
    bossDefeatText: "The Green Knight yields the exchange! Deeper into the keep...",
    lore: {
      why: "A flooded chapel deep in the marsh has begun raising its own dead — the Green Knight himself is said to walk its nave again.",
      objective: "Wade through the drowned dead and put the Green Knight's exchange to rest for good.",
      reward: "The keep beyond finally opens, and whatever the flooded chapel has kept safe all these years."
    },
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
    minLevel: 12, xpCapLevel: 24,
    floorColor: "#2a2226", wallColor: "#150f12",
    bossIntroText: "Mordred himself descends the stair, blade drawn",
    bossDefeatText: "Mordred is cast down! Only the mist-shrouded peak remains...",
    lore: {
      why: "Mordred has raised a keep of dark and dire knights, plotting against the Round Table from behind its walls.",
      objective: "Cut through his knights and confront Mordred himself before his plot reaches Camelot.",
      reward: "The road to Avalon opens, and a traitor finally answered for."
    },
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
    minLevel: 20, xpCapLevel: null, // last dungeon — no ceiling needed
    floorColor: "#2a2740", wallColor: "#161425",
    bossIntroText: "Through the mist, the Questing Beast unfurls its wings",
    bossDefeatText: "The Questing Beast falls silent. Camelot is saved.",
    finalVictoryTitle: "Camelot is Saved",
    finalVictorySubtitle: "The Round Table stands whole once more. Well fought, champion.",
    lore: {
      why: "Beyond the mist, the Questing Beast stirs — the last guardian standing between Camelot and lasting peace.",
      objective: "Cross the mist-shrouded peak and face the Beast itself.",
      reward: "Camelot saved, and the Round Table's name secured for good."
    },
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
//
// Second pass, 2026-08-26 — reported live: "everything is a bit easy."
// None of these numbers have moved since the 2026-08-23 pass above, but
// the character's side of the equation has grown a lot since: permanent
// per-level stat growth (+4% HP/damage a level, up to +28% at Sherwood's
// own level-8 cap — MASTER_DESIGN.md §10), in-run boons (+15% damage/
// +20% HP/+12% speed each, stackable), and three real gear slots (up to
// 2.4x at the top tier) — none of which existed when these numbers were
// last tuned. Trash +18% HP/+10% damage, the mini-boss +15%/+10%, bosses
// +12%/+8% (including their slam/charge damage, scaled the same) — sized
// to roughly counter what *every* character gets for free just from
// leveling (the one guaranteed source, unlike boons/gear which vary by
// luck and choice), not to fully counter a maximally-stacked character,
// which would over-punish anyone not doing that. First-cut like the
// original pass — needs an actual family session to confirm it lands
// right, not just DPS math.
const ENEMY_TYPES = {
  bandit:       {hp:54,  speed:110, dmg:10, radius:15, color:"#7a5a3a", range:30, cd:0.9, xpGear:0.15,
                 sprite:"assets/sprites/bandit.png"},
  darkKnight:   {hp:100, speed:95,  dmg:17, radius:17, color:"#4a4a52", range:34, cd:1.1, xpGear:0.3,
                 sprite:"assets/sprites/darkknight.png"},
  // Mini-boss (§6's encounter tiers) guarding the Poacher's Den side
  // chamber — tankier than darkKnight, well short of a dungeon boss, with
  // one real telegraphed mechanic (a slam cleave) reusing the same
  // slamCd/slamRadius/slamDmg/slamTelegraph fields bosses use — see
  // server.js's generalized "has slam fields" gate in tickMonsters.
  // slamStunDur adds a real stun on top of the damage (his one mechanic
  // doing double duty as this dungeon's stun-CC boss) — opt-in per monster
  // the same way chargeSpeed opts a boss into Charge below.
  banditCaptain:{hp:265, speed:105, dmg:19, radius:20, color:"#5a3a20", range:38, cd:1.0, xpGear:0.4,
                 slamCd:5.5, slamRadius:90, slamDmg:21, slamTelegraph:1.0, slamStunDur:1.1,
                 sprite:"assets/sprites/bandit.png"},
  // Charge fields (chargeCd/chargeDmg/chargeTelegraph/chargeSpeed) are a
  // second, distinct boss mechanic alongside the shared slam AoE — a
  // telegraphed dash toward the current target's position (locked in when
  // the telegraph starts, so it's actually dodgeable), damaging anyone it
  // passes through. Data-driven and reusable by any boss later, but only
  // wired onto blackKnight/blackKnightRare for now (chips at the "every
  // boss shares one mechanic" gap noted in MASTER_DESIGN.md §3 for this
  // one boss). rewardCurrency feeds the family-currency-on-clear payoff in
  // server.js's onBossDefeated.
  // fearCd/fearRadius/fearDur/fearTelegraph are a third distinct mechanic
  // (MASTER_DESIGN.md §5's boss-differentiation idea bank) — a telegraphed
  // warcry that, once it lands, forces nearby players to flee instead of
  // dealing damage. Dodgeable the same way Charge is (telegraph first),
  // gated in tickMonsters the same "has the fields" way slam/charge are.
  blackKnight:  {hp:538, speed:80,  dmg:24, radius:26, color:"#241a1a", range:46, cd:1.3, boss:true,
                 slamCd:4.5, slamRadius:120, slamDmg:37, slamTelegraph:1.1,
                 chargeCd:6.5, chargeDmg:26, chargeTelegraph:0.6, chargeSpeed:550,
                 fearCd:9, fearRadius:170, fearDur:1.6, fearTelegraph:0.8,
                 rewardCurrency:30,
                 sprite:"assets/sprites/blackknightboss.png"},
  // Rare named variant (§5/§6's "sometimes it's someone special") — same
  // kit as blackKnight, ~15% tougher, guaranteed better loot (see
  // server.js's dropLoot) and a bigger currency payoff. Rolled once when
  // Sherwood's boss room loads (js/data.js's rareVariant field on that
  // room) rather than a mid-run ambush.
  blackKnightRare:{hp:618, speed:80, dmg:27, radius:26, color:"#7a1f2b", range:46, cd:1.3, boss:true,
                 slamCd:4.5, slamRadius:120, slamDmg:42, slamTelegraph:1.1,
                 chargeCd:6.5, chargeDmg:30, chargeTelegraph:0.6, chargeSpeed:550,
                 fearCd:9, fearRadius:170, fearDur:1.8, fearTelegraph:0.8,
                 rewardCurrency:60, displayName:"Sir Gorlagon, the Crimson Knight",
                 introText:"A crimson-armored rider blocks the path — Sir Gorlagon himself!",
                 defeatText:"Sir Gorlagon falls! The way to the marshes opens...",
                 sprite:"assets/sprites/blackknightboss.png"},
  zombie:       {hp:79,  speed:70,  dmg:12, radius:16, color:"#4a5a3a", range:32, cd:1.0, xpGear:0.15,
                 sprite:"assets/sprites/zombie.png"},
  wraith:       {hp:40,  speed:155, dmg:11, radius:13, color:"#7ab0a0", range:28, cd:0.7, xpGear:0.15,
                 sprite:"assets/sprites/wraith.png"},
  greenKnight:  {hp:644, speed:92,  dmg:22, radius:24, color:"#1f5b45", range:42, cd:1.0, boss:true,
                 slamCd:4.2, slamRadius:110, slamDmg:32, slamTelegraph:1.0,
                 sprite:"assets/sprites/greenknight.png"},
  direKnight:   {hp:123, speed:105, dmg:19, radius:18, color:"#2a2a30", range:36, cd:1.0, xpGear:0.3,
                 sprite:"assets/sprites/direknight.png"},
  mordred:      {hp:773, speed:98,  dmg:27, radius:26, color:"#7a1f2b", range:46, cd:1.1, boss:true,
                 slamCd:3.8, slamRadius:130, slamDmg:39, slamTelegraph:1.0,
                 sprite:"assets/sprites/mordred.png"},
  mistWraith:   {hp:58,  speed:135, dmg:13, radius:14, color:"#8adfe0", range:30, cd:0.8, xpGear:0.2,
                 sprite:"assets/sprites/mistwraith.png"},
  questingBeast:{hp:963, speed:88,  dmg:30, radius:30, color:"#3a1f5b", range:50, cd:1.2, boss:true,
                 slamCd:3.5, slamRadius:150, slamDmg:41, slamTelegraph:0.9,
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
  module.exports = { CLASSES, WEAPON_TIERS, ARMOR_TIERS, ARTIFACTS, BOONS, DUNGEONS, ENEMY_TYPES, REVIVE_CHANNEL_SECONDS, xpToNextLevel };
}
