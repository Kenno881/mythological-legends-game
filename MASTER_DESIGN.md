# Quest for Camelot — Master Design Document

*Living document. Update as decisions get made — this is meant to be the one
place Claude Code, and anyone else working on this, can check for "what is
this game, actually" without re-deriving it from chat history.*

Repo: https://github.com/Kenno881/mythological-legends-game

---

## 1. Pitch

A co-op top-down dungeon crawler for a family to play together (ages ~7 and
up), drawing on Arthurian legend and the wider tapestry of British Isles
folklore (see §5's story arcs), with the class-role feel of old EverQuest /
Dark Age of Camelot. Server-authoritative, networked, playable on a browser
on PC or tablet. One class (Squire) is deliberately simple enough for a young
child; others carry real tactical depth (threat, cooldown management, mana).

**One unified run model** *(direction as of this revision — supersedes the
earlier separate-modes draft)*: each dungeon run plays like a Vampire
Survivors session set inside an Arthurian dungeon. Auto-attack + target-lock
handles combat; enemies spawn continuously and escalate over the run instead
of being hand-placed room-by-room; players level up mid-run and choose
upgrade cards; bosses trigger at points in the run probabilistically, usually
the dungeon's standard boss, rarely a named/rare variant with better
guaranteed loot. New dungeons get added over time as new themed runs, rather
than needing a second game mode maintained in parallel.

This feeds a **persistent meta-progression layer** *(planned)* so runs matter
beyond the session they happen in.

---

## 2. Design Pillars

1. **Easy to get into, real depth once you're in.** The Squire should never
   need an adult's help. The Cleric should reward genuine attention.
2. **Server is the only truth.** Position, HP, damage, spawns, loot — all
   resolved server-side. Clients render and send input. Never trust the client.
3. **Family-scale, not internet-scale.** One shared passphrase-gated world.
   No matchmaking, no lobbies, no anti-cheat arms race. Build for ~4 concurrent
   players, not thousands.
4. **Reskin before redesign.** New content should extend existing data
   structures (a new dungeon entry, a new enemy type) before it justifies new
   engine code. Keep the class/enemy/dungeon tables as the single source of
   truth shared between server and client (`js/data.js`).
5. **Real risk of not succeeding — added 2026-08-23.** A dungeon has to be
   an actual challenge, not a guaranteed win with extra steps — the family
   should be able to fail a run. Not impossible, though: difficulty should
   sit in a band where losing occasionally is part of the fun, not a wall
   that stops a young child from ever finishing. Concrete mechanics (a real
   wipe/fail state, difficulty tuning, what "failing" even means for a
   world that currently has no wipe condition at all) are open — see §9.

---

## 3. Current Status (as of this doc)

### Working and deployed
- Node/`ws` server, 20Hz authoritative tick, deployed on Railway.
- Passphrase gate on the WebSocket connection, remembered client-side.
- Real login — 5 reserved accounts (Dad, Mum, Amelia, Declan + a `test`
  account exempt from the party gate below), 4-digit PIN self-set on
  first login, remembered per-device thereafter. Permanent per-account
  class choice.
- Every dungeon opens into a safe room — no monsters, a torch-lit visual
  break from the danger rooms ahead — with a glowing exit gate the party
  walks into together once everyone who's coming is actually there. On
  Sherwood Approach (the first dungeon) that gate always opens — solo or
  any subset can start immediately. Every dungeon beyond it also requires
  all 4 family accounts online before the gate opens *(replaces the
  earlier login-time "muster" screen, removed 2026-08-23 — the family
  gate belongs on later dungeons, not on getting into the game at all)*.
- Sherwood Approach's first chamber branches into an optional side
  chamber (2026-08-23, §9) — tougher fight, guaranteed loot, clearly
  warned before committing. Only this one dungeon/branch so far.
- Tiled pixel floor texture + a decorative title banner (2026-08-23).
- Persistent identity (account id) + reconnect grace window
  (`RECONNECT_GRACE_MS`) — survives a refresh or brief disconnect, not a
  server restart.
- Spawn protection on join/reconnect.
- Roster HUD (party HP at a glance).
- Five classes (added Enchanter, 2026-08-23 — the first Phase 6 class),
  four full dungeons with named bosses (see §4, §5).
- AI-generated sprite art for every class, monster, and gear tier, via a
  Gemini-image → `tools/process-sprites.js` (flood-fill background removal,
  auto-trim, resize) pipeline. Fallback to colored circles for anything
  without art — nothing breaks mid-rollout.
- Synthesized sound (Web Audio API, no external assets) — hits, ability
  casts, boss slam telegraph, victory/defeat stingers (`js/audio.js`).
- SQLite-shaped persistence (a JSON file, not actual SQL — see §11) on a
  Railway volume — lifetime kill/death counts and per-dungeon best times
  survive a restart, keyed by account id.
- Taunt as a hard target-override (not yet a full accumulating threat table).
- Flat loot drop (35% per kill, 100% from bosses) — no rarity tiers yet.

### Known gaps (Campaign)
- All four bosses share one mechanic (telegraphed AoE slam) at different
  numbers. No boss has a mechanic distinct to its legend yet.
- No rare/named spawns. No weighted loot rarity.
- Threat is "nearest player, unless taunted" — no accumulating threat table,
  so healing doesn't pull aggro the way it would on a real threat system.

### Not started (new direction)
- The Wilds (horde mode).
- In-run leveling + upgrade-card choices.
- Currency/unlocks meta-progression — the persistence and account layer
  now exist (§12 Phase 2, done 2026-08-23), but nothing in-game earns
  currency or has anything to unlock yet.
- Ranger / Bard / Rogue / Battle Conjurer — remaining Phase 6 classes,
  not built (Enchanter shipped 2026-08-23, see Working and deployed above).

---

## 4. Classes

| Class | Role | HP | Key kit | Complexity | Inspiration |
|---|---|---|---|---|---|
| **Squire** | Simple melee | 130 | Auto-melee + Shield Bash (AoE stun) | Easy — built for a young child | EQ/Albion Warrior |
| **Knight** | Tank | 110 | Attack, Parry, Taunt (hard aggro pull) | Moderate | Albion Paladin/Armsman |
| **Merlin's Apprentice** | Ranged DPS | 75 | Arcane Bolt, Arcane Nova | Complex — mana management | EQ/Albion Wizard/Sorcerer |
| **Avalon Cleric** | Healer | 85 | Staff strike, Healing Light, group Blessing | Complex — party awareness | EQ/Albion Cleric |

### Planned additions (curated from DAoC Albion + EQ, not a full port of either)

**Lore note:** the four existing classes stay Arthurian-pure (Merlin,
Avalon, the Round Table). For the new additions, broader British
mythology/fantasy is fair game — ties in naturally with the Fae/Otherworld
thread opened up by Queen Mab (§5) rather than being a disconnected lore
pocket.

| Class | Role | Complexity | Inspiration | Note |
|---|---|---|---|---|
| **Enchanter** | Crowd control | High | EQ Enchanter | Mesmerize (removes one enemy from the fight), group Haste. Completes the trinity-plus-CC group. Fae-court flavor fits naturally. |
| **Ranger** | Ranged physical DPS | Moderate | EQ Ranger / Albion Scout | Kiting, traps. Natural fit for Sherwood Approach's forest theme. |
| **Bard** | Mobile support | Moderate–High | EQ Bard / Albion Minstrel | Party-wide song buffs. Fills a support niche the Cleric doesn't — unique enough to be worth the build effort. |
| **Rogue** | Burst melee DPS | High | EQ Rogue / Albion Infiltrator | Stealth, backstab burst. Highest skill-ceiling class — good for whoever wants the hardest thing to master. |
| **Battle Conjurer** | Pet/summoner | High | EQ Necromancer / Albion Cabalist | Summons and commands a **fae/nature-spirit companion** — reskinned away from undead/necromancy theming (family game, young kids) and toward the same Otherworld thread as Queen Mab. |

**Rollout:** add 1-2 new classes per content phase rather than all five at
once — same reasoning as everything else on this roadmap.

All class/ability numbers live in `js/data.js` (`CLASSES`), shared verbatim
between server and client so there's exactly one source of truth for balance.

---

## 5. Dungeons & Story Arcs

**Confirmed direction: lean fully into folklore, not just Arthurian
purism.** Dungeons are organized into **arcs** — each drawing from a
distinct pool of British Isles folklore — rather than one flat list. This
is the structure that scales to many more than five dungeons without
turning into an unorganized pile.

### Arc I — The Round Table *(built / in progress)*

| # | Name | Theme | Level requirement | Standard boss | Rare/named boss variant |
|---|---|---|---|---|---|
| 1 | Sherwood Approach | Forest, tutorial | 1 (always open) | Black Knight of the Ford | TBD |
| 2 | The Sunken Chapel | Flooded, undead | TBD | Green Knight | TBD |
| 3 | Mordred's Keep | Dark, knights | TBD | Mordred (or his lieutenant — see below) | TBD |
| 4 | Avalon's Mist | Mystical | TBD | The Questing Beast | TBD |
| 5 | **Camlann** *(proposed capstone — open decision)* | The final battle | Highest | **Mordred** (true final confrontation) | — |

**Open story decision — where Arc I actually climaxes.** Mordred is
currently dungeon 3's boss, but the Battle of Camlann (Arthur and Mordred's
final, mutually fatal clash) is the legend's real climax. Two options:
1. **Reorder** — make Mordred's Keep the last dungeon, Mordred the true
   final boss, and move the Questing Beast to a mid-campaign or mini-boss
   role instead.
2. **Add Camlann as a capstone** *(leaning toward this)* — keep the four
   existing dungeons as-is; Mordred's Keep becomes a fight against his
   forces/a lieutenant; a new 5th dungeon, Camlann, is the actual final
   confrontation with Mordred. Preserves everything already built and gives
   the ending direct mythological weight.

### Arc II — The Fae Court *(new — Otherworld/fae folklore)*

Anchored by **Queen Mab**, working title for her dungeon: *The Hollow
Court* / *Mab's Bower*. Optional/bonus rather than main-line — a superboss
to grow into, not a gate blocking progress. Ties to the existing
nature/fae-magic undertones of the Green Knight and Lady of the Lake.

Room to expand: **Titania and Oberon** (fairy king/queen), **Puck/Robin
Goodfellow** as a trickster mini-boss, **the Wild Hunt** led by **Gwyn ap
Nudd** (Welsh lord of the Otherworld) as an atmospheric dungeon concept.
This arc is also the natural lore home for the Enchanter and Battle
Conjurer (§4).

### Arc III — Isles & Legends *(new — broader British/Celtic folklore)*

Idea bank, not committed:
- **The Lambton Worm** — English dragon-worm legend, strong dungeon-boss material
- **Jenny Greenteeth** — water-hag lurking in ponds/mires, good mini-boss for a bog-themed dungeon
- **Black Shuck** — ghostly black hound, East Anglian folklore
- **The Cailleach** — Scottish/Irish winter-hag goddess, fits an ice-cavern finale
- **Redcaps** — murderous goblins living in ruined castles (Border folklore) — better suited as a common enemy/mini-boss type than a unique dungeon boss

### Arc IV — deeper cuts *(later, if the well needs refilling)*

The Mabinogion (Welsh mythology): **Arawn** (King of Annwn), **Rhiannon**,
**Bran the Blessed** — rich, less commonly used in games, genuinely fresh
material when the more obvious folklore figures are used up.

### Cross-arc mechanics

**Sequential, level-gated access.** A dungeon requires hitting its level
threshold (and/or clearing prerequisite dungeons) before it's selectable —
no queueing straight into Mordred's Keep at level 3. Exact thresholds TBD;
should scale against how leveling actually plays out once Phase 3/4 land.
Bonus-arc dungeons (Fae Court) don't need to gate main-line progress the
same way Arc I does.

**Structure: maze, not arena.** All dungeons, regardless of arc, keep their
room-to-room, corridor-and-chamber layout. Enemy escalation (§9) happens as
the party moves through the maze, not by dropping them into one open field.

**Idea bank for boss differentiation** *(not committed, for discussion)*:
- Green Knight: a regrowth/heal phase unless focused down — echoes the
  beheading-game legend (he doesn't stay down easily).
- Mordred: summons 1-2 adds mid-fight rather than fighting alone.
- Questing Beast: a fear/flee phase instead of pure tank-and-spank —
  it's a beast, not a knight, so it shouldn't fight like one.
- Queen Mab: likely illusion/charm-based, fitting fae trickery over brute
  force.
- Lambton Worm: could split into segments requiring different targeting,
  echoing how the legend's Worm re-joins itself if not cut properly.

---

## 6. Enemies & Encounter Tiers

Regular enemies scale roughly with dungeon order (bandit → zombie/wraith →
direKnight/darkKnight → mistWraith), all defined in `ENEMY_TYPES` in
`js/data.js`. Bosses use the same shape as regular enemies plus
`slamCd`/`slamRadius`/`slamDmg`/`slamTelegraph` fields.

**Encounter tiers (new — mini-bosses added):**

| Tier | Where it appears | Loot | Mechanic complexity |
|---|---|---|---|
| Trash | Continuous spawn escalation (§9) | Common drops only | None beyond base AI |
| **Mini-boss** *(new)* | Guards a side chamber/branch in the maze, not the critical path | Better-than-trash guaranteed drop | One real mechanic, not a full boss kit |
| Dungeon boss | End of dungeon | Guaranteed dungeon-tier loot | Full mechanic (slam + planned unique mechanics, §5) |
| Rare/named boss variant | Rare roll in place of the standard dungeon boss (§9) | Guaranteed better loot than standard | Standard boss kit + a twist |
| Campaign villain | Named story beats — Mordred, Queen Mab | Best-in-slot / unique | Bespoke, built individually rather than from the tier template |

Mini-bosses give the maze structure a reason to have branches worth
exploring, not just a critical path to the dungeon boss.

---

## 7. Gear & Progression

**Current (as built):** one flat tier stat (Iron → Steel → Silver →
Excalibur Shard) applying a single damage-reduction multiplier, auto-upgraded
on pickup. No slots, no player choice — purely a loot-luck ladder.

**New direction — three gear slots, decided:**

| Slot | Structure | Effect | Example ladder/items |
|---|---|---|---|
| **Weapon** | Tiered ladder (own progression track) | Attack damage / range scaling | Iron Blade → Steel Blade → Silver Blade → **Excalibur** |
| **Armor** | Tiered ladder (own progression track) | HP / damage-reduction scaling | Iron Mail → Steel Plate → Silver Plate → **Aegis of Avalon** |
| **Artifact/Shield** | Curated unique named items, not a linear tier | Bespoke passive effect, one per item | *Round Table Shard* (Camlann), *Mab's Favor* (Fae Court), *Lambton Coil* (Isles & Legends) — idea bank, not committed |

**Why Artifact is structured differently:** "artifact" implies something
specific and story-connected, not a generic number. Tying named artifacts to
specific bosses/arcs (§5) makes rare boss loot feel like a real reward
rather than "tier 4 of the ladder" — and reinforces the persistent-campaign
feel (§10) rather than undercutting it.

**Excalibur is now a specific weapon**, not a name slapped on the top tier
of everything — a more satisfying payoff on its own.

**Persistence impact — matters now, before Phase 2 is built.** The player
schema (§11) needs an `equipment: { weapon, armor, artifact }` object from
the start rather than a single `gearTier` integer, since retrofitting this
after Phase 2 ships would mean a data migration. Build it three-slot from
day one even before all three slots have real loot tables behind them.

**Coexists with in-run boons (§10):** boons stay temporary and per-run;
gear (all three slots) stays permanent, exactly as before — this change
only affects how many "permanent" tracks there are (three instead of one),
not the gear/boon split itself.

---

## 8. Networking Architecture

- Node.js + `ws`, deployed on Railway (Sydney's nearest region: Southeast
  Asia / Singapore).
- Server tick: 20Hz. Broadcasts full state (`players`, `monsters`,
  `projectiles`, `loot`) each tick — not yet delta-compressed; revisit if
  bandwidth or tablet performance becomes a problem.
- Auth: shared passphrase via query param on the WebSocket URL, checked
  before the socket is accepted.
- Reconnect: client holds a persistent `playerId` (localStorage). Server
  keys player state by that ID, not the socket. A disconnected player's
  character survives `RECONNECT_GRACE_MS` (currently 75s) before removal.

---

## 8a. Accounts, Characters & Party Flow (New Direction, Planning Stage)

**Two identity layers, not one — decided.**
1. **Connection passphrase** (existing) — the outer gate. Keeps strangers
   off the public Railway URL entirely, before login even happens.
2. **Account login** (new) — username + short PIN per family member,
   identifying *which* persistent character this is, independent of
   device. Replaces the old device-bound anonymous `playerId`
   (localStorage-only identity broke if two kids shared a tablet, or one
   kid used two devices).

**Login once per device, then remembered.** Same UX pattern as the
existing reconnect mechanic — store the logged-in account's ID in
localStorage after first login, so kids aren't re-entering a PIN every
session, only the first time on a given device or when explicitly
switching accounts on a shared one.

**PINs stored hashed, not plaintext** — cheap to do correctly from the
start, no reason not to.

**Character creation, once per account, immediately after first login.**
Name + class — both genuinely permanent (decided — matches the D&D-campaign
framing, §10).

**Party is a fixed roster of four.** Not inferred, not managed as a list —
the family's four accounts *are* the roster.

**Safe room, not a login screen — decided, revised 2026-08-23.** The
gate belongs at the *start of a dungeon*, not on getting into the game at
all. An earlier build (2026-08-23, same day) put a "party muster" staging
*screen* between login and any gameplay — that blocked solo/partial play
entirely and was removed the same day it shipped, once it became clear
the gate was meant for the dungeons beyond the first, not for playing at
all. What's built now: every dungeon opens into an in-world **safe
room** — no monsters, players can actually see each other there — with a
glowing exit gate that leads into the first real chamber. Walking into it
is the "let's go" moment, in the world rather than a menu.

**Full party (all four) required for every dungeon past the first, not
just first clears — decided, revised 2026-08-23.** Sherwood Approach's
exit gate always opens; anyone can start it solo or with whoever's
around. Every dungeon beyond it requires all 4 family accounts online
before its exit gate opens, every time, not just the first clear — the
`firstCleared`-flag nuance (full party only for a dungeon's very first
clear, any subset after) is simpler to revisit later than to get right
now; see §13.

**Level boosting for catch-up.** Ken's account carries an admin flag,
enabling a direct level-set action on any character — for someone who
missed sessions and needs to catch up to the rest of the family. No
separate access-control system needed at this scale, just the one flag.

**Open questions:**
- PIN length/format and recovery (if a kid forgets it — likely just "ask
  Ken to reset it" via the same admin flag, no need for anything fancier).
- Whether the roster could ever grow past four if a friend joins
  occasionally, or whether that's explicitly out of scope.

---

## 9. Dungeon Runs — Maze-Structured Escalation (New Direction, Planning Stage)

**Supersedes the earlier separate "Campaign vs. Wilds" split, and resolves
the arena-vs-chambers question: chambers win.** Every dungeon keeps its
room-to-room maze structure. Auto-attack + target-lock is the core combat
input, shared across all classes. What changes from the current hand-placed
build is that enemy density escalates as the party moves through the maze
(time and/or kill-count driven — TBD) rather than each room having a fixed,
identical enemy count every time.

**Boss encounters trigger probabilistically at points during the run** —
usually the dungeon's standard boss, rarely a named/rare variant with
guaranteed better loot (the "sometimes it's someone special" rare-spawn
feeling, built into the run itself).

**A dungeon ends** on defeating its (standard or rare) final boss. Level
gating (§5) controls which dungeons are even accessible — difficulty
escalation across dungeons, not within a single flat arena.

**Why this over two separate modes:** one system to build and balance, not
two maintained in parallel. New dungeons added over time are new maze
layouts + spawn tables + boss rosters on the same engine.

**Shares across all dungeons:** classes, abilities, server-authoritative
combat, sprite art, gear tiers, leveling/boon system (§10).

**Branching side chambers — first exploration content, shipped
2026-08-23.** Sherwood Approach's room 1 now forks: clear it and two
gates appear instead of auto-advancing — continue on, or take an
optional detour into a tougher fight with guaranteed loot, clearly
warned as the harder road before committing. Both routes reconverge at
room 2. Currently just the one chamber in the one dungeon actually being
played (§12 Phase 1's "prove it on one dungeon" pattern) — extending the
same pattern to the other 3 dungeons, and to more than one branch per
dungeon, is unstarted. **This is optional extra risk a player chooses,
not the mandatory wipe condition Pillar 5 below is actually asking for**
— the main path is exactly as failure-free as it always was.

**A run has to be able to fail — added 2026-08-23, see Pillar 5.** Right
now there's no wipe condition at all: dying just costs a brief respawn
(spawn protection covers the walk back in), and a dungeon can't actually
be lost. That's not really a "challenge" — it's a inconvenience. Needs a
real fail state before this pillar is true rather than aspirational; see
Open questions below.

**Open questions:**
- Primary escalation driver: run time, kill count, or both?
- Exact level thresholds per dungeon (§5).
- What "failing a dungeon" actually means mechanically — a full-party
  wipe kicks everyone back to town/the safe room and the run resets? A
  death limit (e.g. 3 party deaths and the run ends)? A timer that can run
  out? Needs picking before Pillar 5 is more than a stated goal.

---

## 10. Character Progression — Permanent Levels + Temporary Boons (New Direction, Planning Stage)

**Decided: this is a persistent D&D-style campaign, not a roguelite.**
Character level and gear are permanent and never reset between sessions —
the whole point is the same character growing over weeks/months of family
play, same as an ongoing tabletop campaign.

The Vampire-Survivors-style "pick an upgrade" moment still happens, but
reframed to fit that: during a dungeon run, players find **temporary
in-dungeon boons** — a relic or blessing that strengthens them for the rest
of *that run*, gone if they leave or die. This keeps the tactical
in-the-moment choice-making fun of the VS loop without it fighting the
permanent-character feel that's actually the point here.

- **Permanent:** character level, XP, gear tier, and eventually meta-unlocks
  (§11) — carried by the persistence layer (§11), survives forever.
- **Temporary (per-run):** boons picked up mid-dungeon, offering the
  build-choice moment, cleared at the end of the run regardless of outcome.

**Open questions:**
- What actually grants permanent XP — boss kills, dungeon completion, both?
- Boon pool size/rarity — should mirror the "sometimes it's something
  special" feeling used for rare bosses (§9) and rare loot.

---

## 10a. Skill Loadouts — Choose 4 of 8, Controller-Style (New Direction, Planning Stage)

**Proposed 2026-08-23.** Each class gets a pool of **8 skills total**, of
which **4 are equipped at once** — chosen at the start of a dungeon
(naturally fits the safe room, §8a: pick your loadout before walking
through the exit gate). Same shape as a modern controller-style
ability bar (four face buttons), not the current fixed
attack/special1/special2 kit every class has today.

**Loadout composition — must include one of each:**
- **Main attack** — the class's primary damage skill.
- **Utility** — crowd control, mobility, a debuff, etc. (Mesmerize and
  Taunt are already this shape).
- **Ultimate** — a big, cooldown-gated payoff skill.
- **A fourth, more open slot** — exact category TBD; could be a second
  utility, a defensive skill, or left as a free pick from whatever's left
  in the pool. Needs deciding once real skill pools exist to choose from.

**UI:** the four equipped skills show at the bottom of the screen with
their bound input shown directly on each icon — extends the existing
attack/special1/special2 button row (`camelot-crawler.html`'s
`#controls`) to four slots instead of the current three, both for the
on-screen touch buttons and the keyboard/gamepad hints shown alongside
them.

**Scale note:** this roughly quadruples the ability-design surface per
class — 8 skills instead of the current 2 specials, times 5 classes (and
growing, §4/Phase 6) — plus the loadout-selection UI itself. Real content
work, not a quick extension; likely its own phase rather than a drop-in
addition to an existing one.

**Open questions:**
- Exact 4th-slot category (see above).
- Whether loadout choice is locked for the whole dungeon run or can be
  re-picked between dungeons/rooms.
- How this interacts with the existing gear/boon systems (§7, §10) —
  does a boon ever unlock or swap a skill mid-run, or stay purely
  stat-based?
- Retrofitting the 4 existing classes' current 2-special kits into an
  8-skill pool each, vs. only building this for classes added from here
  on (Enchanter onward).

---

## 11. Persistence (New Direction, Planning Stage)

**Why now:** nothing survives a Railway restart today. Meta-progression
requires a real store.

**Proposed approach:** SQLite on a small Railway persistent volume — no
need for a separate managed Postgres service at family scale.

**Schema — updated for accounts/login (§8a) and the three-slot gear system
(§7). Build this shape from day one; both changes land before Phase 2
ships, so there's no migration to worry about:**
```
accounts
  id (primary key)
  username
  pin_hash              -- never store plaintext
  is_admin              -- Ken's account only, gates level-boost action
  created_at, last_seen_at

characters
  account_id (foreign key -> accounts.id, one-to-one for now)
  name
  class                 -- permanent once set
  level, xp
  equipment (json — { weapon: tierId, armor: tierId, artifact: itemId|null })

family_progress          -- shared, not per-account
  currency               -- shared pool, decided (see below)
  unlocks (json array)
  dungeons_first_cleared (json array of dungeon IDs)
  total_kills, total_deaths
  best_run_time_seconds  -- per dungeon or overall, TBD
```

**Decided:** shared family currency (and unlock/first-clear progress) lives
at the family level, not duplicated per account — matches the "we're
building this together" framing, and is simpler than reconciling four
separate copies of the same shared state.

**Open questions:**
- What's actually worth unlocking? (New starting classes, cosmetic skins,
  starting perks, dungeon variants — needs a real list, not just "TBD.")
- Is `best_run_time_seconds` tracked per-dungeon or as one overall record?

---

## 12. Roadmap

**Phase 1 — Sprite/loot/sound cleanup** *(nearly done, still worth finishing
as-is regardless of the run-model change)*
- [x] Iron gear icon *(done 2026-08-23)*
- [x] Remaining 7 monster sprites *(done 2026-08-23, via
      `tools/enemy-requests.json` batch generation)*
- [x] Sound pass (Web Audio API, synthesized — no external assets needed)
      *(done 2026-08-23, `js/audio.js`)*

**Phase 2 — Persistence, accounts & party foundation**
- [x] Persistence layer + Railway volume *(done 2026-08-23 — plain JSON
      file, not SQLite: better-sqlite3's native build failed on Railway's
      Nixpacks/Node 18 image, not worth fighting for a dependency this
      project doesn't need the query power of. Still keyed by the
      existing anonymous `playerId`, not accounts yet — tracks lifetime
      kills/deaths and per-dungeon best times; `level`/`xp`/`equipment`
      and family currency/unlocks are schema-ready but unwired, no
      in-game mechanic produces them yet)*
- [x] Login flow: username + PIN, remembered client-side after first
      login on a device *(done 2026-08-23 — scoped to exactly 5 reserved
      accounts, Dad/Mum/Amelia/Declan + a muster-exempt `test` account,
      not open self-registration; PIN hashed with Node's built-in crypto
      (scrypt), not bcrypt, to avoid another native-module Railway build
      failure. `equipment`/full `accounts`+`characters`+`family_progress`
      table split from §11 not built — the existing flat `players` JSON
      store just gained an `accounts` section keyed the same way)*
- [x] One-time character creation immediately after first login (name +
      class, both permanent) *(done 2026-08-23 — name comes from the
      account, not typed; class is chosen once and never re-picked, even
      after death)*
- [x] In-world safe room + exit gate before every dungeon's real chambers
      *(done 2026-08-23, replacing an earlier login-time "muster" screen
      shipped and removed the same day — the party gate belongs at a
      dungeon's start, not at login. Applies every time, not just first
      clears — see Open Decisions)*
- [ ] `firstCleared` flag per dungeon (family-wide) — gates the full-party
      (all four accounts) requirement on first clears only; already-cleared
      dungeons allow any subset *(deferred — the safe-room gate currently
      requires all four every time on dungeons past the first, not just
      first clears)*
- [ ] Admin flag on Ken's account, gating a direct level-set action for
      catch-up *(deferred — nothing to level yet, Phase 3 isn't built)*
- [x] Remember the connection passphrase client-side too, alongside the
      logged-in account, so kids aren't retyping either credential each
      session

**Phase 3 — Permanent leveling + in-run boons**
- [ ] Permanent XP/level system (never resets)
- [ ] Temporary in-dungeon boon pool per class
- [ ] Boon-choice UI (client)

**Phase 4 — Dungeon run rework**
- [ ] Escalating spawn tables within the existing maze/room structure (§9)
- [ ] Auto-attack + target-lock as the shared input model
- [ ] Boss-encounter trigger logic: probabilistic timing, standard vs.
      rare/named roll, weighted loot tied to which boss shows up
- [ ] Level-gated dungeon unlock sequence (§5)
- [ ] Weapon/Armor tier ladders + Artifact drop tables per dungeon/boss (§7)
- [ ] Resolve remaining open questions in §9/§13 before starting

**Phase 5 — Meta-progression**
- [ ] Currency-per-run
- [ ] Permanent unlock catalog + purchase flow
- [ ] Tie into persistence layer from Phase 2

**Phase 6 — New classes** *(1-2 at a time, not all at once)*
- [x] Enchanter (CC) *(done 2026-08-23 — Mesmerize single-target hard CC,
      breaks on damage taken; Group Haste party speed buff)*
- [ ] Ranger
- [ ] Bard
- [ ] Rogue
- [ ] Battle Conjurer (pet class)

**Phase 7 — Arc expansion**
- [ ] Finish Arc I: resolve the Camlann-vs-reorder decision (§5), build
      the true campaign finale
- [ ] Arc II (The Fae Court): Queen Mab / The Hollow Court as the anchor
      bonus dungeon; room for Titania/Oberon, Puck, the Wild Hunt later
- [ ] Arc III (Isles & Legends): pick from the idea bank (Lambton Worm,
      Jenny Greenteeth, Black Shuck, Cailleach, Redcaps) and build out as
      new maze layouts + spawn tables + boss rosters + mini-bosses on the
      Phase 4 system
- [ ] Arc IV (Mabinogion) held in reserve for whenever more folklore depth
      is wanted

---

## 13. Open Decisions Log

*Running list of things that need a call before the relevant phase starts.*

- **Where Arc I climaxes** — reorder Mordred's Keep to be last, or add
  Camlann as a 5th capstone dungeon (§5). Leaning toward Camlann.
- Primary escalation driver: run time, kill count, or both? (§9)
- What "failing a dungeon" means mechanically — wipe condition, death
  limit, timer? Nothing currently stops a run from being unlosable (§2
  Pillar 5, §9)
- Skill loadouts (§10a): the 4th loadout slot's category, whether a
  loadout locks for a whole run or can be re-picked, how it interacts
  with gear/boons, and whether to retrofit the 4 existing classes or only
  build it for classes added from Enchanter onward
- Extending branching side chambers (§9) beyond Sherwood Approach's one
  chamber — same pattern for the other 3 dungeons, and whether any
  dungeon should get more than one branch
- Exact level thresholds per dungeon (§5)
- What grants permanent XP — boss kills, dungeon completion, both? (§10)
- In-run boon pool size/rarity (§10)
- Concrete unlock catalog for meta-progression (§11)
- Rare/named boss roster per dungeon — who they are, what makes each one
  feel distinct beyond a stat bump (§5)
- New-class rollout order within Phase 6 for the *remaining* four
  (Ranger, Bard, Rogue, Battle Conjurer) — Enchanter went first, decided
  and shipped 2026-08-23
- Queen Mab's actual boss mechanic, once her bonus dungeon is scoped (§5)
- Which Arc III folklore figures to build first — full idea bank in §5
  isn't meant to all get built at once
- Weapon/Armor tier names beyond the current sketch (§7)
- Full Artifact catalog — which bosses drop which named item, and each
  item's specific passive effect (§7)
- PIN recovery flow — if a kid forgets it, currently the only fix is
  manually editing the persisted JSON file; no admin-reset UI exists yet
  (§8a)
- Whether the roster could ever grow past four (§8a)
- Whether the safe-room party gate's "all four, every time" rule (§8a,
  shipped 2026-08-23) should loosen to "first clear only" once it's
  actually been played a few times, per §12 Phase 2's original
  `firstCleared` plan

### Decided (kept here for reference, not deleted once resolved)
- Dungeons are level-gated and sequential — no jumping to Mordred's Keep
  early (§5).
- Dungeons keep their maze/room structure — no flat open arenas (§9).
- Character level and gear are permanent, never reset between sessions —
  this is a persistent campaign, not a roguelite (§10).
- The Battle Conjurer (pet class) is reskinned to fae/nature-spirit
  summons rather than undead — ties into the Otherworld/Queen Mab thread
  instead of necromancy, given the young-child audience (§4).
- New classes beyond the original four are free to draw on broader British
  mythology/fantasy, not strict Arthurian purism (§4).
- Mini-bosses added as a tier between trash and dungeon bosses, guarding
  maze side-chambers (§6).
- Dungeons are organized into story arcs (Round Table / Fae Court / Isles
  & Legends / Mabinogion) rather than one flat list, confirmed as the
  structure for scaling well beyond five dungeons (§5).
- Gear splits into three slots — Weapon and Armor as independent tiered
  ladders, Artifact/Shield as curated unique named items tied to specific
  bosses/arcs rather than a generic tier (§7). Persistence schema (§11)
  built three-slot from the start.
- Currency is a shared family pool, not per-player (§11).
- Party roster is fixed at four accounts — not inferred or managed as a
  list, the four family logins are the roster (§8a).
- Real login (username + PIN, hashed) replaces the old anonymous
  device-based identity, so any family member gets their own persistent
  character from any device (§8a). **Shipped 2026-08-23.**
- Class choice is permanent once a character is created — no respec
  (§8a). **Shipped 2026-08-23.**
- PIN format: 4 digits, numeric, self-set by each account on its own
  first login rather than pre-assigned (§8a, decided 2026-08-23).
- The party gate lives at an in-world safe room's exit before each
  dungeon's real chambers, not a login-time staging screen — Sherwood
  Approach's exit always opens (solo/any subset), every dungeon beyond
  it needs all 4 family accounts online, every time, not just first
  clears. Loosening to match §12's original `firstCleared`-only plan is
  an easy later follow-up (§8a, revised 2026-08-23 — corrects an
  earlier same-day version of this decision that gated login itself).
