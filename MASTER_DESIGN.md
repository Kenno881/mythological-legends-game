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

---

## 3. Current Status (as of this doc)

### Working and deployed
- Node/`ws` server, 20Hz authoritative tick, deployed on Railway.
- Passphrase gate on the WebSocket connection.
- Persistent `playerId` + reconnect grace window (`RECONNECT_GRACE_MS`) —
  survives a refresh or brief disconnect, not a server restart.
- Spawn protection on join/reconnect.
- Roster HUD (party HP at a glance).
- Four classes, four full dungeons with named bosses (see §4, §5).
- AI-generated sprite art for the Campaign's first dungeon's roster + first
  boss, via a Gemini-image → `tools/process-sprites.js` (flood-fill background
  removal, auto-trim, resize) pipeline. Fallback to colored circles for
  anything without art yet — nothing breaks mid-rollout.
- Taunt as a hard target-override (not yet a full accumulating threat table).
- Flat loot drop (35% per kill, 100% from bosses) — no rarity tiers yet.

### Known gaps (Campaign)
- 7 of 11 monster sprites still placeholder circles (only Sherwood
  Approach's roster + Black Knight are done). Iron gear icon missing (source
  `.jpg` never converted — pipeline only reads `.png`).
- All four bosses share one mechanic (telegraphed AoE slam) at different
  numbers. No boss has a mechanic distinct to its legend yet.
- No rare/named spawns. No weighted loot rarity.
- No sound anywhere in the repo.
- Threat is "nearest player, unless taunted" — no accumulating threat table,
  so healing doesn't pull aggro the way it would on a real threat system.

### Not started (new direction)
- The Wilds (horde mode).
- In-run leveling + upgrade-card choices.
- Persistent accounts (currency, permanent unlocks, best times) — nothing
  currently survives a server restart.
- Enchanter / crowd-control class (Mesmerize, group Haste) — discussed,
  not built.

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
| 3 | Mordred's Keep | Dark, knights | TBD | A lieutenant of Mordred's (name TBD — see below) | TBD |
| 4 | Avalon's Mist | Mystical | TBD | The Questing Beast | TBD |
| 5 | **Camlann** | The final battle | Highest | **Mordred** (true final confrontation) | — |

**Arc I climax: Camlann is the capstone (decided).** The Battle of Camlann
(Arthur and Mordred's final, mutually fatal clash) is the legend's real
climax, so it gets its own dungeon rather than folding into Mordred's
Keep. The four existing dungeons stay as-is; Mordred's Keep (dungeon 3)
becomes a fight against his forces/a lieutenant, not Mordred himself; the
new 5th dungeon, Camlann, is the actual final confrontation. Preserves
everything already built and gives the ending direct mythological weight.

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

**Current:** four flat tiers (Iron → Steel → Silver → Excalibur Shard), each
a damage-reduction multiplier, auto-upgraded on pickup. No player choice
involved — purely a loot-luck ladder.

**Planned, once Phase 3 (below) lands:** gear tiers stay as the passive
power ladder; a separate **in-run leveling system** (XP from kills → level
up → choose 1 of 3 upgrade cards) becomes the active build-choice layer.
The two systems coexist rather than merge — gear is "what you found,"
levels are "what you chose."

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

## 9. Dungeon Runs — Maze-Structured Escalation (New Direction, Planning Stage)

**Supersedes the earlier separate "Campaign vs. Wilds" split, and resolves
the arena-vs-chambers question: chambers win.** Every dungeon keeps its
room-to-room maze structure. Auto-attack + target-lock is the core combat
input, shared across all classes. What changes from the current hand-placed
build is that enemy density escalates as the party moves through the maze
rather than each room having a fixed, identical enemy count every time.
**Escalation driver (decided): kill-count primary, with a time-based cap as
a safety net** — so a run can't stall forever camping easy kills instead of
pushing forward.

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

**Open questions:**
- Exact level thresholds per dungeon (§5).

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

**XP sources (decided): all three, weighted.** A small amount per regular
kill keeps XP flowing during a run; a large chunk on boss kill and a bonus
on dungeon completion make those the moments that actually move the needle.

**Open questions:**
- Boon pool size/rarity — should mirror the "sometimes it's something
  special" feeling used for rare bosses (§9) and rare loot.

---

## 11. Persistence (New Direction, Planning Stage)

**Why now:** nothing survives a Railway restart today. Meta-progression
requires a real store.

**Proposed approach:** SQLite on a small Railway persistent volume — no
need for a separate managed Postgres service at family scale. Keyed by the
existing persistent `playerId`.

**Currency: one shared family pool (decided), not per-player.** Fits the
"we're building this together" spirit better than internal competition —
this is a family game, not four separate save files.

**Proposed schema (draft, not committed):**
```
players
  id (playerId, primary key)
  name
  best_wilds_time_seconds
  total_kills
  total_deaths
  unlocks (json array — permanent unlock IDs)
  created_at, last_seen_at

family
  id (singleton row — always id=1)
  currency
```

**Open questions:**
- What's actually worth unlocking? (New starting classes, cosmetic skins,
  starting perks, Wilds arena variants — needs a real list, not just "TBD.")

---

## 12. Roadmap

**Phase 1 — Sprite/loot/sound cleanup** *(nearly done, still worth finishing
as-is regardless of the run-model change)*
- [ ] Remaining 7 monster sprites + Iron gear icon
- [ ] Sound pass (Web Audio API, synthesized — no external assets needed)

**Phase 2 — Persistence foundation**
- [ ] Add SQLite + Railway volume
- [ ] Schema + read/write wiring on connect/disconnect/key events

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
- [ ] Resolve remaining open questions in §9/§13 before starting

**Phase 5 — Meta-progression**
- [ ] Currency-per-run
- [ ] Permanent unlock catalog + purchase flow
- [ ] Tie into persistence layer from Phase 2

**Phase 6 — New classes** *(1-2 at a time, not all at once; Enchanter first
— decided, most fully designed already and completes the trinity-plus-CC
group immediately)*
- [ ] Enchanter (CC)
- [ ] Ranger
- [ ] Bard
- [ ] Rogue
- [ ] Battle Conjurer (pet class)

**Phase 7 — Arc expansion**
- [ ] Finish Arc I: build Camlann as the true campaign finale (§5)
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

- Exact level thresholds per dungeon (§5)
- In-run boon pool size/rarity (§10)
- Concrete unlock catalog for meta-progression (§11)
- Rare/named boss roster per dungeon — who they are, what makes each one
  feel distinct beyond a stat bump (§5)
- Queen Mab's actual boss mechanic, once her bonus dungeon is scoped (§5)
- Which Arc III folklore figures to build first — full idea bank in §5
  isn't meant to all get built at once

### Decided (kept here for reference, not deleted once resolved)
- Arc I climaxes at Camlann, a new 5th capstone dungeon, rather than
  reordering Mordred's Keep to be last — Mordred's Keep (dungeon 3) fights
  his forces/a lieutenant instead of Mordred himself (§5).
- Escalation driver is kill-count primary, with a time-based cap as a
  safety net against camping easy kills instead of pushing forward (§9).
- Permanent XP comes from all three sources: a small amount per kill, a
  large chunk on boss kill, a bonus on dungeon completion (§10).
- Currency is one shared family pool, not per-player or per-character —
  fits the "we're building this together" spirit over internal
  competition (§11).
- Enchanter is the first new class added in Phase 6 — most fully designed
  already, and completes the trinity-plus-CC group immediately (§4, §12).
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
