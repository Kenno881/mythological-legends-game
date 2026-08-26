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

**Clarified 2026-08-25 — a co-op dungeon crawler that needs a group, not a
solo-viable horde mode.** The Vampire Survivors comparison above is about
the *encounter shape* (auto-attack, continuous escalating spawns, run-based
boss triggers) — it isn't a claim that solo should play like a VS run, where
one person is the whole intended audience. A dungeon should be realistically
completable by 2 players, but not really by 1: cooperation is the point, not
an optional multiplier on top of a solo-first design. First difficulty pass
toward this, §9.

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
5. **Real risk of not succeeding — added 2026-08-23, shipped same day.** A
   dungeon has to be an actual challenge, not a guaranteed win with extra
   steps — the family should be able to fail a run. Not impossible, though:
   difficulty should sit in a band where losing occasionally is part of the
   fun, not a wall that stops a young child from ever finishing. **Now
   real**: a fallen player can be revived by a teammate, but a full party
   wipe resets the current dungeon back to its safe room and a difficulty
   pass makes that an actual possibility — see §9.

---

## 3. Current Status (as of this doc)

### Working and deployed
- Node/`ws` server, 20Hz authoritative tick, deployed on Railway.
- Passphrase gate on the WebSocket connection, remembered client-side.
- Real login — 5 reserved accounts (Dad, Mum, Amelia, Declan + a `test`
  account exempt from the party gate below), 4-digit PIN self-set on
  first login, remembered per-device thereafter.
- **Character roster (revised 2026-08-23 — supersedes the earlier
  "permanent class choice" decision below).** Each account saves up to
  4 characters (class + gender), picked before each run instead of
  being locked to whichever class was created first. Deletable to free
  a slot. Gender is stored now; actual male/female sprite art is a
  content follow-up — falls back to the existing single sprite per
  class until then.
- **Revive & wipe (2026-08-23) — makes Pillar 5 real.** A fallen
  player isn't a dead end: any alive, connected teammate who stands
  near them for ~4 seconds revives them at partial HP with a brief
  immunity window (leaving range resets the channel). If nobody
  connected is left alive, the party wipes — after a short beat, the
  whole dungeon resets to its own safe room at full HP, not a
  character/account reset and not a trip to the title screen.
- **Leave & restart (2026-08-23).** A "Leave" button during a run logs
  just that player out cleanly to the title screen without disrupting
  teammates still playing. If they're the only one connected, leaving
  also resets the dungeon to its safe room, since nothing would
  otherwise be left running with no one there.
- **Difficulty pass (2026-08-23).** `ENEMY_TYPES` HP/damage bumped
  across the board (~+20-25% HP on trash, ~+15% on bosses, ~+10-15%
  damage everywhere) so revive/wipe actually matters — a full family of
  four should have to work for a clear, not steamroll it.
- Sprites render larger on small screens (`radius * 6` draw size, up
  from `radius * 4.5`) plus a portrait-mode "rotate your device" hint
  on phones — the fixed 4:3 game canvas letterboxes hard on a narrow
  portrait screen (2026-08-23).
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
- **First slice of the Phase 4 run-model, shipped on Sherwood Approach
  only (2026-08-24) — see §9/§13.** Basic attack is now automatic with
  target-lock (`tickAutoAttack`, `server.js`) across every class/dungeon;
  specials stay manual. Sherwood itself gained: a second branch (Old
  Watchtower → the Poacher's Den) guarded by the first real mini-boss,
  the Bandit Captain (§6's mini-boss tier, previously unoccupied); a
  continuous-spawn wave room (The Sunken Trail, kill-count-driven
  escalation — resolves the §13 "escalation driver" question); the Black
  Knight gained a second mechanic (a telegraphed Charge dash, alongside
  the existing slam) and a 12% chance to instead be a named rare variant,
  Sir Gorlagon the Crimson Knight, with bumped stats, guaranteed extra
  loot, and his own flavor text; and a boss clear now awards family
  currency (`db.addFamilyCurrency`, previously unused — first thing that
  actually calls it) shown on an extended, actually-readable post-boss
  reward banner. `sideChamber` moved from the dungeon onto individual
  branch rooms so a dungeon can hold more than one. Deliberately scoped
  to Sherwood only — the other 3 dungeons still run the old fixed-room
  model; extending this pattern to them is unstarted, same as branching
  chambers before it.
- **Party-size monster scaling + a real post-dungeon summary screen,
  shipped 2026-08-24 after the first real solo playtest of the above.**
  Solo (kiting a Merlin's Apprentice) cleared Sherwood without much
  trouble — nothing before this scaled monster toughness with how many
  people are actually playing, so a full family of 4 stacking auto-attack
  damage would have trivialized it even further. Fixed: `partyScale()` in
  `server.js` scales spawned monster HP and a wave room's kill quota by
  `1 + (playerCount-1) * 0.35` (2p:1.35x, 3p:1.7x, 4p:2.05x) — deliberately
  HP/quota only, not monster damage output, so fights take longer with
  more players rather than punishing anyone individually. **Confirmed live
  with an actual 4-tab simulated party (2026-08-24):** the small fixed
  rooms (1–2) still die in under a second regardless of scaling — 4
  simultaneous attackers just delete a handful of enemies no matter how
  tanky — but the wave room took real, meaningful time with genuine
  deaths/revives along the way, and the boss fully wiped a party that
  arrived already worn down. Worth knowing: that test party played
  passively (no active kiting/healing/specials) — a real family playing
  with actual tactics will likely fare better, so treat this as "harder,
  confirmed working," not "precisely tuned." Separately, defeating a boss
  now shows a real dismissible summary screen (dungeon name, time, kills,
  currency earned) instead of a banner that used to auto-advance past
  before it could be read.
- **Dungeon select + real independent instances, shipped 2026-08-24 —
  the biggest structural change yet.** Until now the whole family shared
  exactly one dungeon/room state server-side, always advancing forward
  automatically; there was no way back to an earlier dungeon, not even
  for the `test` account to solo-replay Sherwood. Rebuilt on real
  per-dungeon instances (`server.js`'s `instances` map, keyed by
  dungeonIndex — at most one active instance per dungeon, a second player
  picking the same one joins the existing run) so genuinely simultaneous,
  independent play works: two family members can replay one dungeon while
  the other two progress a different one at the same moment, fully
  isolated. A new dungeon-select screen (after character pick, before the
  safe room) lists all 4 dungeons up front — **any dungeon is selectable
  from the outset**, no sequential unlock (§5's eventual level-gated
  sequence still isn't built — nothing to gate on yet, Phase 3). Any
  already-cleared dungeon (`db.js`'s new `dungeonsCleared`, family-wide)
  is unrestricted for anyone, any subset, any time; an uncleared one still
  needs all 4 family accounts present *in that same instance* — this also
  finally builds the `firstCleared` idea deferred back at launch (§12
  Phase 2, §13). The automatic "clear a boss, get shoved into the next
  dungeon" flow is gone — dismissing the dungeon-complete screen now
  returns to dungeon-select instead. Victory ("Camelot is Saved") is a
  one-time celebration on the family's first-ever clear of all 4, not a
  hard stop — the campaign stays playable afterward, matching the
  persistent-campaign framing (§10). **Confirmed live with a real 4-tab
  test (2026-08-24):** two simultaneous instances (different dungeons)
  never leaked state into each other; the family-gate correctly counted
  only players actually present in the *same* instance (a family member
  in a different dungeon did not count toward unlocking this one);
  clearing a dungeon with all 4 flipped `dungeonsCleared` and immediately
  let a solo `test` account back in past the safe room; an empty instance
  was torn down automatically. Each dungeon also gained real lore (why/
  objective/reward) shown on its select-screen card — see §5.
- **Fixed the "grey screen" bug in dungeon-select, 2026-08-24 — reported
  by the user right after the above shipped.** Picking a dungeon card
  used to switch to the game screen the instant the join message was
  *sent*, not once the server actually confirmed it — fine on low-latency
  local testing, but on a real connection there's a real gap, and a
  silently-rejected join (no reply was ever sent for that case) left the
  screen permanently blank with nothing to draw and no error shown.
  `server.js`'s join handler now always replies (`joinResult`, with a
  reason on failure); the client waits for that or the first real state
  broadcast — whichever arrives first — before switching screens, and
  times out into a visible, retryable error after 6s if neither shows up.
  Confirmed live: normal join still resolves in ~20ms, and a forced
  rejection now shows a real message instead of hanging.
- **Server-wide crash containment, 2026-08-26 — reported: "the grey screen
  bug once more."** The 2026-08-24 fix above only covers one specific
  cause (a join silently rejected with no reply). Auditing the server for
  what else could produce the same symptom turned up something more
  serious: `server.js` had **no crash protection anywhere**. A single
  uncaught exception in the 20Hz tick loop, in per-connection message
  handling, or in any of the scattered `setTimeout` callbacks (wipe reset,
  boss-defeat summary, room-advance delay) is fatal to the whole Node
  process by default — crashing it for *every* family member across
  *every* dungeon at once, not just the one player who triggered it. With
  a lot of new server logic landing this session (leveling, boons, level
  gates, wall collision, ability unlocks — some of it from a different,
  less-tested session), an edge case somewhere throwing is a completely
  plausible cause of a sudden shared "grey screen." Added three layers:
  each instance's per-tick work is now wrapped individually (one broken
  dungeon run can't take down any other instance or the process), the
  per-connection message handler is wrapped the same way (one bad message
  can't crash the server for everyone else), and a top-level
  `process.on('uncaughtException'/'unhandledRejection')` backstops
  anything outside either of those. Same "a failure here can't take down
  the actual game" principle `db.js` already applies to persistence
  failures — log loudly, keep running. **Confirmed live:** deliberately
  injected a throwing bug into the tick loop, restarted, joined a dungeon
  — the server logged the error every tick (with a real stack trace) but
  stayed fully responsive (`fetch('/')` kept returning 200) the whole
  time; reverted the injected bug before committing. **Honest caveat:**
  this is a structural fix, not a confirmed root-cause fix — there's no
  access to this morning's actual Railway logs from here, so the exact
  line that threw (if that's really what happened) is still unknown. If
  it recurs, Railway's Deploy Logs should now show a clear `[tick]` or
  `[message]` error with a stack trace instead of the process just going
  silent, which is what actually lets it get fixed for good next time.
- **Client-side render-loop crash containment, 2026-08-26 — likely the
  actual root cause of "the grey screen bug once more."** A real browser
  console paste caught it directly: `Uncaught ReferenceError: state is
  not defined at renderLoop (render.js:591)`. `js/render.js`'s
  `renderLoop()` re-arms itself via `requestAnimationFrame(renderLoop)` as
  the *last* line of the function — meaning if anything above it threw
  (here, apparently a load-order/timing race where `state`, defined in
  main.js, wasn't ready yet on the very first frame), that last line
  simply never ran. No error shown to the player, nothing left to retry —
  the render loop was dead forever, on whatever frame happened to be on
  screen when it died. This is likely a better explanation for the
  reported symptom than the server-side crash-containment fix above: it
  explains a *permanently frozen client* with a *fine, unaffected server*,
  which fits "grey screen" more precisely. Fixed the same way as the
  server-side version: the risky work is now inside a try/catch, with
  `requestAnimationFrame(renderLoop)` unconditionally after it — a bad
  frame gets logged and skipped, and the very next frame (~16ms later)
  tries again instead of the whole client dying for the rest of the
  session. Confirmed the fix's correctness by direct inspection (this is
  guaranteed JS control flow, not something that needs a live repro to be
  certain of) and confirmed no regression to normal rendering via a real
  playthrough afterward.
- **Installable PWA — manifest + service worker, 2026-08-25 (never
  actually written up in this doc until the bug below forced the issue).**
  `manifest.json` (standalone display, landscape orientation, icons
  generated from the knight sprite) plus `service-worker.js` make "Add to
  Home Screen" behave like a real installed app on tablets and phones.
  **Bug found and fixed, 2026-08-26 — reported live: an Android phone's
  installed PWA showed room 1 with no walls (§9) and ability buttons that
  didn't respond, both real features that existed in the current server's
  code.** Root cause: the service worker's original "network-first, cache
  as an offline fallback" design silently served a stale cached bundle on
  *any* network hiccup, not just genuine offline — so an installed phone
  could easily end up running old client-side JS (no wall rendering, no
  knowledge of ability level-gating) against the current server, which
  just silently no-ops what the stale client doesn't know to ask for
  correctly. Every symptom of a real bug, none of the visibility. Fixed:
  HTML/CSS/JS now network-*only* — no cache fallback at all, since this is
  a live WebSocket multiplayer game anyway (genuinely offline was always
  unplayable, so silently serving a version-mismatched bundle was never
  actually better than just failing the request). Also added
  `skipWaiting()`/`clients.claim()` so a newly-deployed service worker
  takes over on next reload instead of waiting for the app to be fully
  force-quit first. Confirmed live: registers and activates cleanly, no
  console errors. **If this exact "stuff that should work doesn't"
  pattern shows up again on an installed device, the fix is to uninstall
  and reinstall the PWA (or clear the app's storage) to force a truly
  fresh fetch** — this change prevents it recurring going forward, but
  doesn't retroactively un-stick a device already stuck on a stale cache
  from before the fix shipped.
- **Safe-area (notch/status-bar) support, 2026-08-26 — reported live: "the
  top of the screen is getting cut off by my status bar."** An installed
  standalone PWA's web content isn't automatically guaranteed to avoid a
  phone's status bar/notch — that only happens if the page opts in via
  `viewport-fit=cover` (added to the viewport meta) and then actually
  respects the resulting `env(safe-area-inset-*)` CSS values, which this
  page wasn't doing at all before. Fixed by padding `#app` with the safe
  -area insets on all 4 sides — global `box-sizing:border-box` (already
  in place) keeps `#app`'s own box at exactly the full viewport size, so
  this only shrinks the *content* area the flex-centered `#stage` centers
  into, naturally clearing the status bar using whatever letterbox slack
  already exists. `#stage`'s own width/height budgets also subtract the
  same insets directly (not just relying on the padding above), so its
  max size can't still be too tall/wide to fit even on a device where the
  inset eats more than the existing slack. Verified the CSS is valid and
  the zero-inset case (this dev environment, no real notch to trigger it)
  renders pixel-identical to before — the actual notch-clearing behavior
  needs a real notched/status-bar device to fully confirm, same
  limitation as every other "how does this look on a real phone" item
  this session.

  **Follow-up, same day — `manifest.json`'s `display` switched
  `standalone` → `fullscreen`.** The safe-area work above makes content
  correctly avoid the status bar; this instead removes it outright,
  which is what was actually wanted for a game. Android-only —
  `fullscreen` isn't available to a home-screen web app on iOS at all
  (a platform restriction, not something fixable in code); unsupported
  browsers fall back to `standalone` automatically per the manifest
  spec's own display-mode fallback chain, so this is a safe, low-risk
  change either way. Trade-off: fullscreen also hides quick glances at
  the clock/battery/notifications — swipe down from the top edge to
  briefly reveal them instead of always seeing them. The safe-area
  support above stays in place regardless (still needed for iOS, and
  harmless if a browser ever falls back to standalone on Android too).
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
- **Background music, 2026-08-25.** A small generative ambient loop, not a
  fixed clip — same no-external-assets constraint as the SFX, and it means
  nothing repeats note-for-note over a real 15-30 minute session. D Dorian
  (heroic, not sad-minor); drone + bass pulse + a weighted-random-walk
  melody line, all scheduled with a standard Web Audio look-ahead scheduler.
  Runs on its own gain node, independent of the SFX `masterGain`, so combat
  hits stay clearly audible over it. Starts on the same first-gesture unlock
  the SFX context already required; ducks to silent (not stopped — avoids
  re-deriving the beat schedule) whenever the tab is hidden. One continuous
  score for the whole session, not per-screen tracks. No mute/volume UI yet
  — `MUSIC_GAIN_LEVEL` in `js/audio.js` is the one knob if it's too loud.
- SQLite-shaped persistence (a JSON file, not actual SQL — see §11) on a
  Railway volume — lifetime kill/death counts and per-dungeon best times
  survive a restart, keyed by account id.
- **Permanent leveling + in-run boons, first slice, 2026-08-25 (§10).** XP
  from kills (both trash and bosses), permanent +4%/level HP+damage growth,
  and a 3-boon generic pool offered on level-up. `level`/`xp` now actually
  persist — the schema had these fields since launch but nothing wrote to
  them until this pass.
- Taunt as a hard target-override (not yet a full accumulating threat table).
- Flat loot drop (35% per kill, 100% from bosses) — no rarity tiers yet.
- **Co-op-required difficulty, first pass, 2026-08-25 (§1/§9).** A
  solo-only incoming-damage multiplier so a lone player can genuinely fail
  a dungeon, not just clear it slower — soft risk, not an entry block.
- **Level-gated dungeon unlocks + per-dungeon XP caps, 2026-08-25 (§5).**
  A dungeon requires a minimum character level to join at all; each also
  caps how much XP is earnable while farming it, so the easy first dungeon
  can't be grinded into permanently out-leveling the rest of the campaign.
- **Real wall-collision exploration, 2026-08-25 (§9).** Rooms could carry
  zero interior geometry before this — Sherwood's room 1 is now reshaped
  into "Forest Crossroads," 3 real corridors off a hub instead of two exit
  gates floating in one open field. The collision primitive itself is
  reusable by any room going forward, not bespoke to this one.
- **Monster wall-steering, 2026-08-26 — reported live: "walls that do work
  on characters, but mobs are unaffected by them."** Monsters previously
  had zero wall awareness at all (not even collision, let alone routing)
  — a straight-line chase just clipped visually through geometry. Not full
  pathfinding (no help in a real maze of concave shapes), but a
  provably-safe two-phase steering heuristic for this game's actual wall
  shape (sparse, room-spanning rectangular bands): when the direct line to
  the target is blocked, first slide purely horizontally until clear of
  the wall's x-range (can't clip it — the move never changes y), then
  align vertically at that now-safe x (also can't clip it — that x is by
  construction outside the wall's x-range for the whole move). Recomputed
  fresh every tick, no stored path. Verification found and fixed two real
  bugs on the way, not just a live report: a "closer edge by raw
  distance" version sent a monster straight through the wall it was
  trying to route around, because the wall's right edge coincides with
  the room's own outer border — not a real route, a dead end; and a
  single-diagonal-waypoint version reliably grazed the wall's corner
  during transit regardless of clearance padding, which the two-phase
  split (proven safe per-phase, not just at the final destination)
  eliminates outright. Confirmed via a deterministic simulation (not
  live-timing-dependent, given how much faster a leveled-up test
  character kills trash than a fresh one) replaying the server's actual
  functions verbatim across 5 scenarios — hub-to-lane, mid-lane-to-
  different-lane, no-wall-direct, the largest monster in the game
  (Questing Beast, radius 30), and the hardest case (routing around both
  of room 1's walls in sequence) — zero wall clips in any of them.
- **Second monster difficulty pass, 2026-08-26 — reported live: "everything
  is a bit easy."** The 2026-08-23 pass (§ above) was the last time
  `ENEMY_TYPES` moved — tuned before leveling, boons, or the three-slot
  gear system existed. Since then a character gains +4% HP/damage per
  level (up to +28% at Sherwood's own level-8 cap), up to three stackable
  boons (+15% damage/+20% HP/+12% speed each), and gear up to 2.4x, none
  of which the monsters ever got a matching pass for. Trash +18% HP/+10%
  damage, the mini-boss +15%/+10%, bosses +12%/+8% (slam/charge damage
  scaled the same) — sized to roughly counter what *every* character gets
  for free just from leveling (the one guaranteed source; boons/gear vary
  by luck and choice, so fully countering a maximally-stacked character
  would over-punish everyone else). First-cut, same as the original
  pass — needs a real family session to confirm it lands right, not DPS
  math. Confirmed live: new numbers load correctly in a fresh Sherwood
  instance (bandit 46hp/9dmg → 54hp/10dmg).
- **Admin panel, 2026-08-26 (§8a).** Dad's account only — a small screen
  (level-set on any family member's character, reset a dungeon instance
  to its safe room, clear a stuck join lock), each action re-verified
  server-side regardless of the panel's own client-side visibility.
  Finally builds the level-boost catch-up tool the design doc named back
  at launch but never implemented.
- **Room-clear gates, 2026-08-26 (§9).** A cleared room now opens a gate to
  walk through instead of auto-teleporting the party on a blind timer —
  Binding of Isaac's "clear it, doors open" feel, reusing the same gate
  mechanism branch rooms already had. Shared code path, so it applies to
  every dungeon's plain rooms, not just Sherwood.
- **Sherwood hub-and-spoke, 2026-08-26 (§9).** Old Watchtower is now a real
  hub — clearing it opens three doors at once (Poacher's Den, straight to
  the boss, or the Sunken Trail wave room, now optional rather than
  mandatory) instead of one linear path with a single detour. First real
  branching exploration, generalized from the room-clear gate above into
  an N-door mechanism; one dungeon, hand-authored, not a general room
  graph yet.
- **Directional doors + a building minimap, 2026-08-26 (§9).** The hub's
  doors now render on the wall matching their actual compass direction
  (north/south/east/west) instead of all three sitting on the same wall,
  and walking through one repositions the player at the opposite wall of
  the new room. A minimap panel builds itself as you explore rather than
  showing the layout upfront, reading room topology straight from the
  shared `js/data.js` — no new server broadcast needed.
- **Backtracking, 2026-08-26 (§9).** The Poacher's Den and the Sunken
  Trail now have a door back to the hub, and a cleared room stays cleared
  — no monsters, doors already open — instead of respawning a fresh fight
  every time you re-enter it. The map can finally be used to navigate,
  not just to look at.
- **Caster speed fix, 2026-08-26 (§9).** Merlin's Apprentice and Enchanter
  dropped from 190 to 90 speed — every player class used to move nearly
  2x faster than any Sherwood monster, so either ranged class could kite
  forever and never take a hit, solo, no teammate needed. Now slower than
  every Sherwood trash mob; a teammate holding aggro is what actually
  keeps a caster safe.
- **Switch Account button, 2026-08-26 (§8a).** Added to the character-
  select and dungeon-select screens — the underlying logout flow already
  existed (it's what the in-game Leave button used), it just wasn't
  reachable anywhere except mid-run. A family member can now get from one
  account to another without joining a dungeon first.
- **Sherwood dungeon expansion, 2026-08-26 (§9).** A second hub, The
  Ford's Edge, plus an optional harder detour, The Riverbank Ambush —
  Sherwood grew from 6 rooms to 8, and the hub's old free "onward to the
  boss" door now costs a real fight first. Pure content on the existing
  doors/grid/backtracking framework, no new mechanism.
- **Ability button labels, 2026-08-26 — user request ("we need to know
  what we're doing").** The two ability buttons used to just say the
  static, generic "Ability"/"Special" forever, regardless of class — no
  indication anywhere in the HUD of what pressing one actually does. Now
  shows the real name (`CLASSES[classKey].special1/2.name`, `js/render.js`'s
  `updateHud`) — "Shield Bash," "Arcane Nova," "Taunt," whatever the
  current class actually has. Confirmed live for two classes (Squire:
  "Shield Bash"/"Second Wind" both shown at level 6; Apprentice: "Arcane
  Nova" shown, second button correctly still hidden pre-unlock at level 1
  — the existing `unlockLevel` gating wasn't disturbed). Couldn't get a
  real pixel/visual confirmation this pass — this sandboxed browser
  reports a zero-size layout box for every element (consistent with the
  environment's other rendering limits noted elsewhere in this doc:
  `requestAnimationFrame` never firing, screenshots failing), so the CSS
  sizing (9.5px label font, wrapping enabled, inside the existing 76px
  circular button) is reasoned-through rather than eyeballed — worth an
  actual look on a real device before calling it done.
- **Sound settings, 2026-08-27 — user request ahead of the first family
  weekend session.** With four family members each on their own device at
  the same physical table, `js/audio.js`'s generative background music has
  no shared clock across devices, so four independent copies running at
  once just becomes noise. Added a speaker button (top-right, every
  screen, outside the `.screen` divs since it's a per-device preference
  rather than a per-run one) opening a small panel with Music and Sound
  Effects volume sliders. Both are multipliers on the existing baseline
  gains (`SFX_BASE_GAIN`, `MUSIC_GAIN_LEVEL`), stored per-device in
  `localStorage` (`camelotMusicVolume`/`camelotSfxVolume`) so each phone/
  tablet remembers its own mix across sessions; default is 100% (no
  behavior change until someone touches a slider). Confirmed live: SFX
  slider updates `masterGain` immediately; music slider persists and
  correctly reseeds the panel on reload; the live music-gain ramp
  (`setTargetAtTime`) couldn't be exercised end-to-end in this sandboxed
  browser since it reports the tab as backgrounded (`document.hidden`),
  which the code treats the same as a real backgrounded tab (stays
  silent, picks up the new volume on the next real visibilitychange) —
  worth a quick real-device check that dragging the music slider is
  actually audible immediately, not just on the next tab switch.

### Known gaps (Campaign)
- Three of four bosses still only have the shared telegraphed AoE slam at
  different numbers — the Black Knight is the first exception (Charge, a
  telegraphed dash, added 2026-08-24 alongside his slam). Green Knight,
  Mordred, and the Questing Beast still have no mechanic distinct to
  their own legend.
- One rare/named spawn exists now (Sherwood's Sir Gorlagon, 2026-08-24) —
  the other 3 dungeons still have none. Still no weighted loot rarity
  system generally, just the guaranteed-vs-35%-chance drop rule.
- Threat is "nearest player, unless taunted" — no accumulating threat table,
  so healing doesn't pull aggro the way it would on a real threat system.
### Not started (new direction)
- The Wilds (horde mode).
- Currency/unlocks meta-progression — the persistence and account layer
  now exist (§12 Phase 2, done 2026-08-23), but nothing in-game earns
  currency or has anything to unlock yet.
- Ranger / Bard / Rogue / Battle Conjurer — remaining Phase 6 classes,
  not built (Enchanter shipped 2026-08-23, see Working and deployed above).

---

## 4. Classes

| Class | Role | HP | Key kit | Complexity | Inspiration |
|---|---|---|---|---|---|
| **Squire** | Simple melee | 130 | Auto-melee + Shield Bash (AoE stun); Second Wind (self heal+shield) at level 3 | Easy — built for a young child | EQ/Albion Warrior |
| **Knight** | Tank | 110 | Attack, Parry, Taunt (hard aggro pull, level 3) | Moderate | Albion Paladin/Armsman |
| **Merlin's Apprentice** | Ranged DPS | 75 | Arcane Bolt, Arcane Nova; Blink (reposition) at level 3 | Complex — mana management | EQ/Albion Wizard/Sorcerer |
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

**Lore, shipped 2026-08-24.** All 4 Arc I dungeons now carry a `lore`
block (`js/data.js` — why the party's there, the objective, the reward),
shown on the dungeon-select screen so the family can read it together
before diving in. Sherwood Approach additionally has a couple of per-room
`loreText` strings on its branch/wave rooms — "more lore the deeper in you
go" — as a first proof of concept; extending that to the other 3 dungeons
is unstarted, same pattern as everything else that's shipped Sherwood-only
so far.

| # | Name | Theme | Level requirement | Standard boss | Rare/named boss variant |
|---|---|---|---|---|---|
| 1 | Sherwood Approach | Forest, tutorial | 1 (always open) | Black Knight of the Ford | Sir Gorlagon, the Crimson Knight (2026-08-24, 12% roll) |
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

**Sequential, level-gated access — built 2026-08-25.** A dungeon requires
hitting its level threshold before it's selectable at all — checked
server-side at 'join' (`server.js`, rejects with `level_too_low` +
the required level), surfaced proactively on the dungeon-select screen as
a "Requires Level N" badge (`js/main.js`) rather than only as an
after-the-click error. Checked against the joining account's own level,
independent of teammates' — matches §8a's admin catch-up flag existing
specifically to unblock one behind player, which only makes sense if this
gate is per-account. Paired with a second, related mechanic: each
dungeon's `xpCapLevel` (`js/data.js`) caps how much XP is *earnable while
farming that dungeon* — once a character reaches the cap, further kills
there grant 0 XP (no punishment, just no more reward), which is the actual
fix for "grinding the easy first dungeon forever shouldn't let you
out-level the whole game." Bands deliberately overlap — a dungeon's
`minLevel` sits below the previous one's `xpCapLevel` — so you don't have
to fully max one out before the next unlocks:

| Dungeon | minLevel | xpCapLevel |
|---|---|---|
| Sherwood Approach | 1 (always open) | 8 |
| The Sunken Chapel | 5 | 16 |
| Mordred's Keep | 12 | 24 |
| Avalon's Mist | 20 | none (last dungeon) |

**First-cut numbers, not validated by real family play** — same caveat as
every other number shipped this session (XP curve, per-kill weights, solo
damage multiplier). Confirmed live: a real level-3 test account correctly
saw Sunken Chapel/Mordred's Keep/Avalon's Mist all badged and blocked;
temporarily lowering Sherwood's `xpCapLevel` to match that character's
current level confirmed further kills granted exactly 0 XP (level/xp both
stayed frozen across 3 real kills) — reverted before committing. Bonus-arc
dungeons (Fae Court) still won't need to gate main-line progress the same
way once they exist.

**Structure: maze, not arena.** All dungeons, regardless of arc, keep their
room-to-room, corridor-and-chamber layout. Enemy escalation (§9) happens as
the party moves through the maze, not by dropping them into one open field.

**Sherwood Approach's two bosses now have real CC, not just damage —
shipped 2026-08-25, first slice of boss differentiation beyond
slam/charge.** The Bandit Captain's slam (js/data.js's `slamStunDur`)
now stuns on landing, not just damages — a fully-blocked hit (Buckler/
spawn protection) correctly skips the stun (`damagePlayer` now returns
whether the hit landed). The Black Knight (and Sir Gorlagon) gained a
third, wholly separate mechanic — Fear (`fearCd`/`fearRadius`/`fearDur`/
`fearTelegraph`) — a telegraphed warcry that, once it lands, overrides a
feared player's movement to flee the boss and blocks their attacks for
its duration, rather than dealing damage like slam/charge do. Both are
gated the same "has the fields" way slam/charge already were, and won't
start telegraphing mid-slam/charge-telegraph. New player-side fields:
`stunTimer` (freezes movement+attacks entirely), `fearTimer`/
`fearSourceId` (forces flee, blocks attacks, normal movement input
ignored) — see server.js's `tickPlayers`/`tickAutoAttack`/`doSpecial`.
Client shows a 💫/😱 icon over a stunned/feared player and a pulsing
purple ring for the fear telegraph (distinct from slam's red), see
js/render.js. Confirmed live: Bandit Captain's stun observed firing
(`p.stunTimer` set, matching `slamStunDur`) and Black Knight's fear
observed firing twice during one real boss fight.
**Idea bank for the other 3 dungeons' bosses** *(not committed, for
discussion — same shape, not yet built)*:
- Green Knight: a regrowth/heal phase unless focused down — echoes the
  beheading-game legend (he doesn't stay down easily).
- Mordred: summons 1-2 adds mid-fight rather than fighting alone.
- Questing Beast: could reuse the new Fear mechanic (or a variant of it)
  for a flee phase instead of pure tank-and-spank — it's a beast, not a
  knight, so it shouldn't fight like one. (Beast-Hide Mantle's §7 fear-
  immunity clause was trimmed for not existing — now that Fear is real,
  that's revisitable.)
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
| **Mini-boss** | Guards a side chamber/branch in the maze, not the critical path | Better-than-trash guaranteed drop | One real mechanic, not a full boss kit — first one built: Sherwood's Bandit Captain (2026-08-24, a slam cleave), guarding the Poacher's Den |
| Dungeon boss | End of dungeon | Guaranteed dungeon-tier loot | Full mechanic (slam + planned unique mechanics, §5) |
| Rare/named boss variant | Rare roll in place of the standard dungeon boss (§9) | Guaranteed better loot than standard | Standard boss kit + a twist |
| Campaign villain | Named story beats — Mordred, Queen Mab | Best-in-slot / unique | Bespoke, built individually rather than from the tier template |

Mini-bosses give the maze structure a reason to have branches worth
exploring, not just a critical path to the dungeon boss.

---

## 7. Gear & Progression

**Built 2026-08-24 — the flat `gearTier` ladder is gone.** Three real
slots now, each independent: Weapon and Armor as tiered ladders, Artifact
as the curated catalog below. Account-wide (like lifetime kills/deaths),
not per saved character — a family member's gear carries across whichever
of their 4 characters they're currently playing. Persisted in `db.js`
(`equipment: {weaponTier, armorTier, artifacts}`, with a back-compat
migration for any row written before this existed). Loot drops are typed
now (`kind: 'weapon'|'armor'|'artifact'`) instead of one undifferentiated
pickup — trash/side-chamber drops roll weapon-or-armor 50/50 (same
guaranteed-vs-35%-chance rule as before); a boss always drops its own
artifact *plus* a weapon/armor token, so a boss kill is always a double
reward — confirmed live end-to-end (persistence survives a full
disconnect + relogin, not just in-memory; a boss granted exactly its
mapped artifact; Ford-Warden's Buckler blocked a hit below 25% HP, then
correctly failed to block the next one while its 20s cooldown was still
running).

**Trash drop chance lowered 35% → 12%, 2026-08-25** (`server.js`'s
`TRASH_GEAR_DROP_CHANCE`) — user feedback after playing with the
three-slot system: gear was arriving far too fast. With only 4 tiers per
ladder (3 upgrades needed) and Sherwood's main path alone throwing ~23
trash kills at a solo player before any side chamber, 35% maxed both
Weapon and Armor well inside one dungeon clear, which defeats gear being
persistent-campaign progression rather than a same-session curve.
Side-chamber/boss guaranteed drops are unchanged — those stay the
"worth the extra risk/effort" reward.

**Weapon/armor pickups now roll a tier instead of always being a
guaranteed +1, 2026-08-26 — user feedback: "gear doesn't drop, it
upgrades every time."** Every pickup used to unconditionally step
`weaponTier`/`armorTier` up by one — a "drop" was really an invisible
stat counter with no chance involved, so it never felt like finding
something. `pushGearLoot` now rolls each weapon/armor drop its own tier
(`rollGearTier()`, weighted `[50, 30, 15, 5]` across the 4 tiers — Iron-
equivalent common, the named capstone a 5% tail) at the moment it spawns,
and `applyLootPickup` only equips it if that roll actually beats what's
already worn; a roll that doesn't melts down into a small chunk of family
currency instead (`SALVAGE_CURRENCY_BASE + tier * SALVAGE_CURRENCY_PER_TIER`
— 3/5/7/9 coin) rather than just vanishing, so picking one up still means
something even on a miss. "Guaranteed drop" (a side chamber, a boss
token) now means guaranteed a roll, not a guaranteed upgrade — the harder
room is still worth it on average, just no longer a sure thing at the top
end. `TRASH_GEAR_DROP_CHANCE` raised 0.12 → 0.20 alongside this: a drop
showing up more often is fine now that it doesn't automatically max gear
out. The ground token's color now reflects its own rolled tier
(`js/render.js`) rather than always matching whatever's currently
equipped, so a gold-tinted drop on the floor is a real "that one's worth
grabbing" signal; a whiff shows as a small "+N coin" toast (the only live
feedback for that case, since the tier itself doesn't change on a miss).
Confirmed live via a temporary debug log (removed before committing): a
tier-0 character's bandit kill rolled tier 1 and correctly upgraded;
follow-up kills at tier 1 rolled tier 1 and tier 0 and both correctly
salvaged (+5, +3) instead of no-op-ing. The `[50,30,15,5]` weighted roll
was also verified against a 200k-trial simulation (50.2/30.0/14.9/4.9%)
before shipping. First-cut numbers, not validated by a real family
session, same caveat as every other balance number on this doc.

| Slot | Structure | Effect | Ladder/items |
|---|---|---|---|
| **Weapon** | Tiered ladder (own progression track) | Attack damage / range scaling | Iron Blade → Steel Blade → Silver Blade → **Excalibur** |
| **Armor** | Tiered ladder (own progression track) | HP / damage-reduction scaling | Iron Mail → Steel Plate → Silver Plate → **Aegis of Avalon** |
| **Artifact/Shield** | Curated unique named items, not a linear tier | Bespoke passive effect, one per item | See Arc I catalog below — **built and wired 2026-08-24** |

**Weapon/Armor naming — resolves the §13 "beyond the current sketch"
question: the 4-tier shape stays as originally sketched (Iron → Steel →
Silver → a named capstone), just confirmed rather than re-themed. Iron/
Steel/Silver read as generic on purpose — they're the common, loot-luck
tiers any dungeon can drop; only the top tier is a unique, story-tied
name (Excalibur, Aegis of Avalon). Differentiating every rung further
(e.g. dungeon-specific material names) was considered and dropped: with
one universal ladder shared across all dungeons (not per-dungeon loot
tables), a kid picking up "Steel Blade" in Sherwood and again in Mordred's
Keep should read as the same upgrade both times, not a confusing reskin.

**Arc I Artifact catalog — built and wired 2026-08-24.** Two of the five
originally-drafted effects (2026-08-24, first proposal) were trimmed to
match what the game actually has, rather than implying a mechanic that
isn't real: Gorlagon's Crimson Spur no longer claims charge-stun immunity
(Charge still only ever damages, never stuns, a player — nothing to be
immune to); Beast-Hide Mantle no longer claims fear immunity (at the
time, no fear mechanic existed at all — it does now, shipped 2026-08-25
on the Black Knight, see §5 — but the Questing Beast's own planned fear
phase is still just a §5 idea-bank entry, so the immunity clause still
has nothing to attach to yet). Both trims are copy-only; the clauses can
come back for free once those mechanics get built for their own bosses.

| Boss | Artifact | Passive effect | Why |
|---|---|---|---|
| Black Knight of the Ford | **Ford-Warden's Buckler** | Below 25% HP, block the next hit entirely (once per 20s) | He guards a crossing — the buckler is what lets *you* survive crossing too |
| Sir Gorlagon, the Crimson Knight (Sherwood's rare variant) | **Gorlagon's Crimson Spur** | +10% move speed, always | The one boss whose whole kit is a dash — his own trick, turned against the next one who tries it on you |
| Green Knight | **The Green Knight's Girdle** | Once per dungeon run, a killing blow leaves you at 1 HP instead of dying | Straight from the actual legend — Gawain's girdle protects him from the Green Knight's axe; barely had to invent anything here |
| Mordred | **Mordred's Broken Blade** | +15% damage on the first hit against each new room's enemies | He strikes first, hard, and without warning — a treacherous opening blow, same as the man |
| The Questing Beast | **Beast-Hide Mantle** | +10% max HP | Ties to the Beast's own planned fear-phase mechanic (§5 idea bank) — the fear-immunity half of this waits for that to actually exist |

**Beyond Arc I — still idea bank, not committed** (unnamed dungeons don't
have artifacts assigned yet): *Round Table Shard* (Camlann, if it ships as
the capstone — §5's open decision), *Mab's Favor* (Fae Court), *Lambton
Coil* (Isles & Legends).

**Why Artifact is structured differently:** "artifact" implies something
specific and story-connected, not a generic number. Tying named artifacts to
specific bosses/arcs (§5) makes rare boss loot feel like a real reward
rather than "tier 4 of the ladder" — and reinforces the persistent-campaign
feel (§10) rather than undercutting it.

**Excalibur is now a specific weapon**, not a name slapped on the top tier
of everything — a more satisfying payoff on its own.

**Persistence — done 2026-08-24.** `db.js`'s player row carries
`equipment: { weaponTier, armorTier, artifacts }`, exactly the shape §11
called for building early to avoid a migration — the retrofit never
actually ended up being needed since this went in as a single pass rather
than gear shipping ahead of persistence.

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

**Character roster, up to 4 per account — revised 2026-08-23, supersedes
the earlier "one permanent character" decision.** The original plan was
name + class chosen once, forever, matching the D&D-campaign framing
(§10). In practice that meant no way to try a different class without
losing everything on the first one, so accounts now hold a roster of up
to 4 saved characters (class + gender each), picked fresh before every
run from a character-select screen between login and the safe room.
Deletable to free a slot when the cap's hit. Character *level/gear*
(once §10/§11 land) stays permanent per saved character — this change
is about how many characters an account can have, not about
re-introducing respec within one.

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

**Full party (all four) required only until a dungeon's first clear —
decided 2026-08-23, revised again 2026-08-24 once dungeon-select
shipped.** Sherwood Approach's exit gate always opens; anyone can start it
solo or with whoever's around. Every other dungeon requires all 4 family
accounts present *in that same run* before its exit gate opens — but only
until the family clears it once. From then on it's unrestricted for
anyone, any subset, solo included, permanently (`db.js`'s
`dungeonsCleared`, checked by `tickSafeRoom`) — this is the
`firstCleared`-flag idea originally deferred at launch (§12 Phase 2),
finally built alongside real dungeon selection (§9).

**Level boosting for catch-up — built 2026-08-26.** Dad's account carries
an admin flag (`ACCOUNTS.dad.isAdmin`, server.js), enabling a direct
level-set action on any family member's character — for someone who
missed sessions and needs to catch up to the rest of the family. No
separate access-control system needed at this scale, just the one flag,
re-checked server-side on every `admin*` message regardless of what the
client claims (the panel's own visibility is convenience, not the real
gate — confirmed live: a non-admin account's direct probe of the same
message type got silently ignored, no reply, no crash).

Shipped as a small admin screen (reached via a "Admin" button that only
renders for the admin account), not a generic command console — three
narrow actions, each its own explicit message type:
- **Set a character's level** (any family member, any of their saved
  characters) — the catch-up tool above. Updates the persisted character
  row and, if that exact character happens to be live in an active
  instance right now, the runtime object too, so the change is visible
  immediately rather than only on their next join.
- **Reset a dungeon instance to its safe room** — everyone currently in
  it gets the same reset a real wipe gives (full HP, boons cleared,
  repositioned to the entrance), without needing to actually wipe.
- **Clear a stuck "already active" join lock** — for an account the
  server still thinks is mid-instance after an unclean disconnect the
  normal reconnect-grace window didn't catch, blocking them from
  rejoining anything until it's cleared.

Confirmed live end-to-end: created a fresh Dad character, set it to
level 10 then back to 1 (both persisted and reflected in the panel
immediately), joined a real Sherwood instance and confirmed it appeared
correctly in both the "active runs" and "stuck locks" lists, reset it
(instance-state cleared, `[admin]` logged), then cleared the join lock
(instance correctly auto-tore-down once empty, matching the existing
instance-cleanup behavior).

**Switch Account, 2026-08-26 — user request: a way to get from Test to
Dad, or to any of the kids, without needing dev tools.** The actual
logout mechanics already existed and worked correctly — `net.js`'s
`clearAccountId()`, and `server.js`'s `leaveDungeon` handler, which
despite its name is really "log this connection out, keep the socket
open for a fresh login" (a no-op on instance membership if there isn't
any, so already safe to call from anywhere, not just mid-run). The gap
was UI: the only button wired to that flow was the in-game Leave button,
so switching accounts meant joining a dungeon first just to find a way
back to the login screen. Added a "Switch Account" button (same handler
as Leave, `js/main.js`'s new `switchAccount()`) to both the character-
select and dungeon-select screens — the two places a family member
actually is between runs. Confirmed live: from character-select, the
button correctly returns to the "Who's Playing?" screen with all 5 names
and clears the client's identity (`myId` → `null`); logging back in as
the same account still correctly re-prompts for its PIN (not silently
reusing the old session); the dungeon-select screen's copy of the button
behaves identically. Didn't touch `clearAccountId()`/localStorage
directly — logging into a *different* account already overwrites the
remembered device id on success (`net.js`'s `loginResult` handler), so
switching works end-to-end without needing to explicitly forget the old
one first.

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
2026-08-23, extended to a second branch 2026-08-24.** Sherwood Approach's
room 1 forks: clear it and two gates appear instead of auto-advancing —
continue on, or take an optional detour into a tougher fight with
guaranteed loot, clearly warned as the harder road before committing.
Both routes reconverge at the next room. Room 2 (Old Watchtower) now
forks the same way into the Poacher's Den, guarded by the Bandit Captain
mini-boss (§6) — `sideChamber` moved from the dungeon onto individual
branch rooms to make a second branch possible at all. Still just Sherwood
(§12 Phase 1's "prove it on one dungeon" pattern) — extending the pattern
to the other 3 dungeons is unstarted. **This is optional extra risk a
player chooses, not the mandatory wipe condition Pillar 5 below is
actually asking for** — the main path is exactly as failure-free as it
always was.

**Real wall-collision exploration, shipped 2026-08-25 — room 1 reshaped
into "Forest Crossroads."** Rooms had zero interior geometry before this —
an open rectangle with monsters and exit-gate circles, the two branch
gates just floating near each other on the right edge rather than reading
as genuinely different directions. Added the actual missing piece: a
`walls` array per room (`js/data.js`, simple axis-aligned rectangles) plus
a real collision primitive (`server.js`'s `moveWithWalls`/`circleHitsRect`)
— X and Y resolved as separate moves so a player slides along a wall
instead of snapping to a dead stop, the standard trick for this. Not
bespoke to one room: any room can carry `walls` from here on. Room 1's
hub (left third, unwalled) now opens into 3 real lanes carved by two
horizontal dividers — top lane to the Ambush Hollow fork (still the same
fight, just reached by actually walking a different corridor instead of
picking from two adjacent dots), middle lane onward, and a new bottom lane
to an unguarded secret nook holding a guaranteed loot token (reuses the
existing floor-pickup system — `secretNook` triggers one `pushGearLoot`
call the moment the hub clears, no new mechanic). Branch gate positions
became per-room-overridable too (`exits` field, `mainExitFor`/
`sideExitFor`/`returnExitFor` in server.js) rather than fixed shared
constants, since a spatial layout needs its gates to actually sit where
the corridors lead — every other branch room not yet reshaped this way
still falls back to the original shared positions, unaffected.
**Confirmed live, thoroughly:** walking straight from the hub into the
middle lane correctly stopped dead at the dividing wall (couldn't cut
through into the top lane); routing back through the hub and up the top
lane correctly reached the Ambush Hollow gate and triggered the side
chamber; the secret nook's loot token appeared exactly where placed the
moment the hub cleared. Also incidentally re-confirmed today's earlier
solo-danger-multiplier pass is doing its job — the same test character
solo'd into the Ambush Hollow's 2-dark-knight fight and wiped, exactly the
kind of real risk that pass was for. **Known gap, not addressed here:**
monsters don't path around walls (still simple move-toward-target) — room
1's enemies are placed so this doesn't matter for its layout, but a future
room whose walls are meant to matter tactically (monsters having to path
around, not just players) would need real pathfinding, not just
collision. Still just this one room (§12's "prove it on one thing first"
pattern) — extending real wall geometry to other rooms/dungeons is
unstarted.

**Escalating spawn tables — first slice shipped 2026-08-24, Sherwood
only.** Resolves the "primary escalation driver" open question below:
**kill count**, not wall-clock time. Sherwood's Sunken Trail (room 3) is a
continuous-spawn wave encounter — enemies trickle in up to a live cap,
spawn rate and toughness step up as the party's kill count in that room
climbs, and the room only clears once a kill quota is hit and the board
is empty. Auto-attack + target-lock (also shipped 2026-08-24) is now the
combat input everywhere, not just this room — every class's basic attack
fires automatically at a locked target; specials remain manual. Neither
change extends to the other 3 dungeons yet, which still use the original
fixed-room-of-enemies model.

**Room-clear gates, 2026-08-26 — explicit clarification of the exploration
feel: Binding of Isaac, not a conveyor belt.** A plain (non-branch,
non-boss, non-safe) room used to auto-teleport the whole party to the next
room on a blind 1400ms timer the instant the last enemy died — no player
action, nothing to walk to, nothing shown on screen while it counted down.
Replaced with the same gate primitive branch rooms and the safe room
already use: clearing the room sets `roomState: 'awaiting_exit'`
(`server.js`), which opens a single "Continue on" gate at `roomExitFor()`
(reuses a room's `exits.main` override if it has one, else the same
centered spot the safe room/branch-return gate sit at); walking into it
(`tickRoomExit()`) advances to the next room, same `someoneAt()` proximity
check as every other gate. Purely a trigger-mechanism change — no new
room data, no change to which rooms exist or what's in them. Currently
only reachable on Sherwood's wave room (Old Watchtower/Forest Crossroads
are branch rooms, so they already gated this way; the other 3 dungeons'
plain fixed-enemy rooms will pick this up automatically too, since it's
the shared room-clear path, not a per-dungeon change. Confirmed live: the
underlying mechanism (gate appears only once a room is actually cleared,
walking into it advances, resets cleanly on a fresh room load) was
exercised directly through Forest Crossroads' and Old Watchtower's own
branch gates in a real playthrough with no errors, including through a
mid-fight death → party wipe → safe-room reset — `roomState` resets
alongside `branchState` in `loadRoom()`, so an interrupted room-clear
doesn't leave a stale gate behind.

**Sherwood hub-and-spoke — real branching, 2026-08-26, first pass at the
actual Isaac feel.** The gate mechanism above only fixed the *trigger*
(walk through a door instead of an invisible timer) — the *layout*
underneath it was still a single linear sequence
(`dungeon.rooms[roomIndex]`, `roomIndex + 1` on advance), with exactly one
place that forked at all (a room's optional `sideChamber`, and even that
always reconverged onto the same single next room). This pass generalizes
the single-gate mechanism into a real N-door one and uses it once: what
was "Old Watchtower → the mandatory Sunken Trail wave room → the boss" is
now a **hub** — clearing Old Watchtower's own fight opens three doors at
once (`js/data.js`'s new `doors` field, an array of `{to, exit, label,
color}` — `to` is this dungeon's own room index, not necessarily +1) —
the Poacher's Den mini-boss chamber, straight onward to the boss, or the
Sunken Trail wave encounter, and the player picks exactly one. The
Poacher's Den was promoted from a nested `sideChamber` to a real
standalone room so it could be one of three doors instead of one branch's
only detour; the Sunken Trail, previously forced main-path content,
becomes a real optional risk/reward choice like the Poacher's Den already
was — same fight content in both cases, nothing new authored. `doorsFor()`
(`server.js`) returns a room's explicit `doors` if it has any, else
synthesizes today's exact single-gate behavior (`{to: roomIndex+1}`), so
every other room in the game — including Forest Crossroads, untouched —
keeps working exactly as before; `tickRoomExit()` loads whichever door's
target directly rather than always advancing by one.

Promoting the Poacher's Den out of `sideChamber` broke its guaranteed loot
(the old guarantee was keyed on `branchState === 'in_side_chamber'`, which
a standalone room reached via `loadRoom()` never sets) — fixed with an
explicit `guaranteedLoot` room flag, checked in `dropLoot()` alongside the
old branch check. The Sunken Trail becoming skippable needed its own
"worth it" argument, but *not* a per-kill guarantee like the side
chamber — 14+ kills × guaranteed drop would undercut the whole point of
the tier-roll change above (§7). Instead it keeps the normal 20% per-kill
roll during the fight, plus one bonus drop on room-clear
(`clearBonusLoot`), the same "guaranteed find" shape as Forest Crossroads'
secretNook rather than a new mechanic. **Confirmed live**, including one
real bug caught only by playing it: the hub's three `doors` entries
initially had two `to` indices transposed (the "Onward to the Ford" label
pointed at the Sunken Trail room and vice versa) — a real family player
choosing "onward" would have been silently dropped into the wave room
instead of the boss, and the "Sunken Trail" door would have skipped
straight to the boss. Caught by walking it, fixed, then re-confirmed: the
"Onward to the Ford" door correctly reaches the boss room (`chamber 2` →
`BOSS` in server logs, not `chamber 2` → `wave chamber`) across three
separate live runs; the Poacher's Den door correctly reaches its own room
and — via a temporary debug log, removed before committing — its
`guaranteedLoot` fix was directly observed firing for a bandit kill with
`branchState` null, exactly the coupling the promotion would otherwise
have silently broken. The Sunken Trail's own routing/`clearBonusLoot`
weren't independently re-confirmed this pass (a fresh low-level solo
character couldn't survive a full 14-kill wave clear to prove it, and
`clearBonusLoot`/the default-door path both reuse mechanisms — secretNook,
the synthesized single-door default — already proven live in the room-
clear-gates pass above), which is a real, named gap in this pass's
verification, not an assumption dressed up as one.

**Still not the full Isaac picture, deliberately.** This is one hub with
three spokes, hand-authored, on one dungeon — not a general room graph, no
revisiting a room once you've left it (matches the existing side-chamber
precedent — Ambush Hollow doesn't let you back into Forest Crossroads' hub
either), no procedural layout, and the other 3 dungeons are still the
original fully linear model. Scoped this way on purpose, matching how
every other feature here shipped — prove the mechanism on one dungeon
before deciding it's worth repeating. A real room-graph engine (arbitrary
N rooms, randomized layouts) is a bigger, separate undertaking if this
pattern proves worth extending.

**Directional doors + a map that builds as you explore, 2026-08-26 —
user feedback: the hub's three doors all sat on the same wall with no real
compass meaning, and nothing showed the shape of what you'd found.** Two
pieces sharing one foundation:

*Doors now render on the wall matching their actual direction.* A door
can name a compass `dir` (`js/data.js`) instead of a hand-placed pixel
`exit` — `server.js`'s `DOOR_SPOT` resolves it to a real gate on the
matching wall (north/south/east/west), and `doorsFor()` does that
resolution for any room that opts in, unchanged for every room that
doesn't. Direction is authored per-door, not derived from a room's grid
position — the boss room is a genuine 3-way convergence point (the hub's
own door, the Poacher's Den's return door, and the Sunken Trail's return
door all lead there), and a single grid position for it can't
simultaneously be the correct cardinal delta from three unrelated source
rooms. Authoring `dir` independently per edge sidesteps that: three
different doors can all target the boss with three different `dir`
values, no contradiction. Walking through a directional door now
repositions the player near the *opposite* wall of the room they arrive
in — the wall facing back the way they came — instead of just leaving them
wherever they happened to be standing, which is what every room
transition did before this (`pickSpawnPoint` generalized into
`pickEntryPoint(inst, basePoint)`, reusing its existing monster-avoidance
jitter for any base point, not just the join/reconnect entrance). Two
content-safety numbers got tuned alongside this, not assumed safe: the
north/south `DOOR_SPOT` y-values sit at 110/`H-110` rather than a naive
100/650 (a wall-clearance margin — the existing spawn jitter could
otherwise sample a point clipping the top wall band, since no collision
check runs on spawn placement), and the Sunken Trail's `{450,200}` wave
spawn point moved to `{450,260}` (its distance from the corrected north
entry point was only ~112px, tight enough to flag).

*A minimap builds itself as you explore, rather than showing the whole
layout upfront.* Needed no new server broadcast field — `js/data.js`'s
`DUNGEONS` is already loaded identically by client and server, so the
client reads a room's `grid`/`doors`/`to` straight from the shared static
data (the same way `currentRoomData()` already worked); only the live gate
*positions* are server-resolved. `grid` (a per-room `{x,y}`, minimap
layout only) is deliberately kept separate from `dir` for the same reason
described above — trying to derive one from the other would hit the same
boss-convergence problem. A room appears on the map once actually
visited, or once a door in the room you're standing in is open and leads
to it — the map reveals itself alongside what's already visible on screen,
not ahead of it. Every Sherwood room got a `grid` value (continuing west
from the hub's `{0,0}`: safe room, Forest Crossroads, hub, Poacher's Den,
Sunken Trail, boss) so the panel shows the current room from the moment a
run starts rather than staying empty until the hub's first cleared; the
panel hides itself entirely for the other 3 dungeons, which have no
`grid` data yet, rather than rendering an empty box. Resets on every fresh
entry into a dungeon's safe room (covers both a genuinely new run and a
wipe resetting the dungeon's rooms out from under whatever was already
explored), not on a bare dungeon-name change, which would've missed
rejoining the same dungeon after leaving.

**Confirmed live, precisely — server-side state read directly rather than
via the render loop** (this sandboxed browser environment never fires
`requestAnimationFrame` at all, confirmed separately by a 1-second probe
that counted zero frames despite the page reporting `visible`; this
affects every render-loop-driven feature equally, not something new here,
and doesn't apply to a real browser). All three hub doors resolved to
their exact intended `DOOR_SPOT` coordinates, and the moment they opened,
the minimap revealed the Poacher's Den/boss/Sunken Trail cells at exactly
their `grid`-implied positions relative to the hub. Walking through the
north door placed the player at the *south* wall of the Poacher's Den
(not the hub's coordinates); walking through the (default, no explicit
`doors`) south door into the Sunken Trail placed the player at *its*
north wall, clear of the nudged spawn point. The minimap correctly showed
only "visited" cells (no phantom "known" reveals) until a room's own
doors actually opened, and correctly reset to just the safe room's cell
after a wipe. Zero server errors across several full clear/death/wipe
cycles exercising all three routes.

**Backtracking, 2026-08-26 — user feedback right after the map shipped:
"we can't go back rooms."** Every door up to this point was one-way, and a
room forgot it was ever cleared the instant you left it — `loadRoom()`
unconditionally wiped and respawned monsters for whatever loaded next,
with zero memory of anywhere else. Authoring a door back wouldn't have
been "going back," it'd have been "re-fight the room from scratch." Two
small, additive pieces fixed this, both reusing infrastructure the doors/
grid pass already proved:

- A second `doors` entry on the Poacher's Den and the Sunken Trail,
  pointing back to the hub with the compass `dir` opposite the one the hub
  used to reach them. `doorsFor()`/`DOOR_SPOT`/`drawGate` were already
  fully generic over however many doors a room has — this needed zero
  code changes, just two new `js/data.js` entries.
- `inst.clearedRooms`, a `Set` recording a room index the moment it's
  cleared (the same point `roomState` becomes `'awaiting_exit'`).
  `loadRoom()` checks it: an already-cleared room skips spawning
  entirely and opens its doors immediately — no fight required, matching
  a room you've already dealt with. Loot not collected before leaving
  stays lost (unchanged from before this pass — a cleared room reads as
  genuinely empty, not a second loot opportunity), which also means no
  double-dipping on the Poacher's Den's `guaranteedLoot` or the Sunken
  Trail's `clearBonusLoot`: both only ever fire from inside the room-clear
  block, which a revisit skips by construction, not by an extra guard.
  Resets at the exact point `dungeonStartedAt`/`dungeonKillCount` already
  reset (`loadRoom`'s `idx === 1` block, which fires every time a real run
  (re)starts, including after a wipe) — cleared-room memory is dungeon-run
  state, not persistent progress, matching "a wipe resets the dungeon."
  No minimap changes needed either: `updateMinimap()` already treats
  "visited" as sticky, so walking back through an already-known room is
  a no-op for the map.

Scoped the same as the rest of this arc — the hub cluster only. The boss
room stays a one-way terminal (no reason to revisit a one-shot encounter,
and it's reached by three different rooms with three independently
authored `dir` values, so it was never going to get a return door of its
own without picking one arbitrary "back" direction). Forest Crossroads and
the safe room keep their existing one-way `branchState` behavior,
untouched — a separate, older subsystem, out of scope here same as it's
been for the whole hub-and-spoke arc.

**Confirmed live and thoroughly**, including one thing that only surfaced
because the test character kept dying to the Poacher's Den's mini-boss
before ever clearing it solo (expected — this is exactly the kind of
content Pillar 5's solo-danger multiplier is for): temporarily leveled the
local dev save's test character up, verified, then reverted it back to
its actual level before committing. With that headroom: cleared the hub
and the Poacher's Den, confirmed both doors ("Onward to the Ford" and the
new "Back to the Watchtower") rendered correctly on the cleared room;
walked back and confirmed the hub loaded with zero monsters, its doors
already open, and the player positioned at its north wall (opposite the
direction just traveled) — no re-fight, exactly the point. Re-entered the
Poacher's Den and the hub several more times back and forth, confirming
every revisit stayed empty (not just the first one) and the minimap never
duplicated or mis-styled a cell. Repeated the same for the Sunken Trail's
north↔south pair. Then died for real in the Sunken Trail, wiped, and
confirmed the *next* attempt correctly re-fought the hub from scratch
instead of treating it as still cleared — the `clearedRooms` reset on a
real run restart firing correctly, not just asserted. Zero server errors
across the entire extended session.

**Dungeon expansion — a second hub, 2026-08-26. User framing: "not
sprawling, but big enough," ahead of the family weekend session.** The
hub's own "onward" door used to lead straight to the boss for free — the
one route through Sherwood that skipped a real fight entirely. It now
leads to **The Ford's Edge**, a second hub, which itself opens two doors:
**The Riverbank Ambush** (optional, harder, guaranteed loot — same shape
as the Poacher's Den, but a tougher trash pack instead of a second named
mini-boss, since two Bandit Captains in one dungeon would read as a
reused asset rather than a real encounter) or straight on to the boss.
Every route through Sherwood now costs at least two real fights, not one.
Sherwood grew from 6 rooms to 8 — pure content on top of the doors/grid/
backtracking framework from the last three passes, zero new server or
client logic. The two existing shortcuts (Poacher's Den's and the Sunken
Trail's own direct "Onward to the Ford" doors) got their `to` index
updated to the boss's new position (5 → 7) and otherwise left exactly as
they were — they still bypass the new hub entirely, on purpose, the same
shortcut they always were. New rooms follow the established grid
convention exactly (Ford's Edge at `{1,0}`, east of the first hub;
Riverbank Ambush at `{1,-1}`, north of it; boss shifted from `{1,0}` to
`{2,0}`) and reuse only existing enemy types (`bandit`/`darkKnight`), no
new content authored beyond room data — matches Pillar 4.

One label was deliberately changed, not just added: the first hub's own
door to the new second hub kept the phrase "Onward to the Ford" reused
from before this pass would have been ambiguous once a door with that
exact name also leads to an intermediate room, not the boss — so it's now
"Press on toward the Ford," and every door that actually reaches the boss
(there are four now) keeps saying "Onward to the Ford" consistently,
reliably meaning the same thing everywhere it appears.

**Confirmed live end-to-end**, including a check the doors/grid pass never
had reason to make: that raising a room count doesn't silently break
anything room-index-agnostic code was already relying on. Temporarily
leveled up the local dev save's test character again (reverted before
committing, same as every other pass that's needed this). Walked the full
new route (hub → Ford's Edge → Riverbank Ambush → boss) and confirmed
each new room's doors, labels, and entry-wall positioning were exactly
right; the minimap correctly grew to show all 8 rooms at their precise
grid-implied positions with no code changes required. Then, separately,
re-ran the *existing* Poacher's Den shortcut and confirmed it still lands
correctly in the boss room at its new index (7) — the reindex didn't
quietly strand an old route. Zero server errors throughout.

**A run has to be able to fail — added 2026-08-23, shipped same day, see
Pillar 5.** Dying now leaves a player fallen, not respawned — they need
an alive teammate to walk over and revive them (a few seconds' channel,
interrupted by leaving range). If the whole party is down with nobody
connected left standing, the dungeon wipes: a short beat, then everyone
resets to that dungeon's safe room at full HP. A real fail state, not
just an inconvenience, without being a hard account/character reset.

**Bug fix, 2026-08-26 — a wipe reset everything about a fallen player
except where they actually were.** `checkForWipe`'s reset restored hp/
mana/boons and moved the *room* back to index 0, but never touched the
player's own x/y — they'd land back in the safe room logically while
still rendered wherever they died, possibly deep in a side chamber, and
had to wander back into range of the exit half-blind. Now resets position
too, via the same `pickSpawnPoint` helper join/reconnect already use
(the safe room has no monsters to bias away from, so it's just "near the
entrance"). Found and flagged while building room 1's wall-collision
exploration (§9); fixed once the family actually hit it in real play.

**Cooperation requirement — first pass, 2026-08-25 (§1's clarification).**
Solo already had no revive safety net (above — nobody's left to walk over
and revive a lone fallen player), but that only bites if a lone player is
actually likely to take a real hit, and baseline monster damage was tuned
around parties big enough to revive each other — confirmed live, a solo
playtest "cleared Sherwood without much trouble" (§3). `server.js`'s new
`SOLO_DANGER_MULT` (1.6x) multiplies incoming damage only at exactly 1
player, applied once in `damagePlayer()` so every damage source (basic
attacks, slams, charges) picks it up automatically; 2-4 players are
untouched, same as `partyScale()`'s existing choice to scale HP/quota (not
damage) for group play. **Soft risk, not a hard block** — a lone player can
still attempt and can still get lucky, matching Pillar 5's "losing
occasionally is part of the fun, not a wall" stance rather than flatly
disallowing solo entry (which would also contradict Sherwood's existing
"always opens, solo or any subset" decision, §8a). 1.6x is a first-cut
number, not validated by an actual solo family playtest — retune if a solo
run still feels too safe, or too punishing, once someone's actually tried
it. Untouched by this: dungeon *entry* — the family-presence gate on an
uncleared dungeon (§8a) is a separate lever from in-dungeon survivability,
and wasn't part of what this pass changed.

**Caster speed — closing a real kiting hole, 2026-08-26, user request ahead
of a family weekend session.** Checked the actual numbers rather than
guessing: every player class moved at ~190-200 while every Sherwood
monster moves at 80-110 (bandit 110, darkKnight 95, banditCaptain 105,
blackKnight boss 80) — any class could permanently outrun any Sherwood
monster, but it mattered most for the two classes with a genuine ranged
auto-attack (Merlin's Apprentice, 280-range projectile; Enchanter,
260-range projectile): at old speed, either could kite forever and simply
never take damage, no teammate required at all. That's a direct hole in
Pillar 5/§9's "co-op required" intent — `SOLO_DANGER_MULT` above raises
the cost of getting hit, but does nothing if a class can just never get
hit in the first place. Dropped both to `speed:90` (`js/data.js`) — below
every Sherwood trash mob, so a fleeing solo caster's head start shrinks to
nothing and it eventually gets caught, rather than kiting being a full
escape. Deliberately left a touch faster than the boss (80): bosses
already have their own anti-kite tools (Charge, Fear) that trash mobs
don't, so trash speed is the number that actually mattered here, not a
uniform "slower than everything" rule. A teammate holding aggro (Knight's
Taunt) is what's meant to turn "eventually caught" into "actually safe" —
the intended shape is solo-fragile, duo-viable, matching the pitch's
"realistically completable by 2, not really by 1" (§1). The Merlin's
Apprentice's own special2 comment already described it as "75 HP, zero
mobility" before this change — the old 190 speed never actually matched
that description; it does now. Confirmed live: a fresh level-1 Apprentice
resolves `speed:90` correctly in a real joined session, and — playtested
directly, not just asserted — got caught and killed fast by 3 close-range
bandits in Forest Crossroads, a matchup the old 190 speed would have let
it walk away from untouched. First-cut number, not validated by an actual
two-caster-vs-one family session; retune if duo play still isn't the
"good combination" the number's aiming for.

**Open questions:**
- Whether the 1.6x solo multiplier is actually well-tuned — needs a real
  solo run to judge, same caveat as the party-scaling numbers above.
- Whether `speed:90` for the two ranged classes is the right number, or
  needs retuning once a real two-player (tank+caster) session has actually
  tried it — same "first-cut, needs real play" caveat as everything else
  on this list.
- Whether a wipe should ever cost something beyond lost time (a death
  counter, a run-time penalty) — currently a wipe is "try the same
  dungeon again from its safe room," no other consequence.

**Logged for later, not built (2026-08-23):**
- **Phaser for animation.** The client is currently raw canvas draw
  calls (`js/render.js`) — flagged as worth moving to Phaser down the
  track for real sprite animation (walk cycles, attack swings) instead
  of static sprites snapping between states. No code written yet;
  noting it here so the direction isn't lost.
- **Scrolling dungeons.** Rooms currently render at a fixed camera —
  the whole room fits on screen at once. A real scrolling
  camera/viewport (rooms bigger than the screen, camera follows the
  party) is wanted eventually, tracked here as future work on top of
  whatever the maze/room system looks like once §9's escalation
  mechanics land.

---

## 10. Character Progression — Permanent Levels + Temporary Boons (First slice shipped 2026-08-25)

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

**Shipped 2026-08-25 — first slice, both halves built together since
leveling is what actually triggers a boon choice.** Answers the two open
questions below directly:

- **XP source: both boss kills and regular kills, not just dungeon
  completion.** `js/data.js`'s `xpGear` field already existed on every
  trash/mini-boss `ENEMY_TYPES` entry (weight 0.15-0.4) but nothing ever
  read it — this is that field's first actual use
  (`XP_PER_TRASH_WEIGHT * xpGear`, server.js's `xpForKill`). Bosses don't
  carry `xpGear`; they scale off the same `rewardCurrency` signal their
  currency payout already uses (×2), rather than inventing a second
  "how special is this kill" number that could drift from the first.
  Trash-only XP was deliberately rejected — with only 1-2 boss kills per
  dungeon, XP that only came from bosses/completion would make mid-run
  leveling (and therefore mid-run boon choices, the actual point of this
  section) never realistically happen.
- **Boon pool: 3 generic, class-agnostic boons for this first pass, not a
  bespoke pool per class.** `js/data.js`'s `BOONS` — Iron Will (+20% max HP
  now), Keen Edge (+15% damage this run), Swift Boots (+12% speed this
  run). A real per-class pool (tied to §10a's eventual "8 skills, pick 4"
  system) is genuine content-design work on its own; this proves the
  mechanism end-to-end first. Offered 3-at-a-time on level-up
  (`offerBoonChoice`); a single big XP grant crossing more than one level
  threshold at once queues multiple choice-rounds rather than the second
  silently overwriting the first (`pendingBoonChoices`, a queue not a
  single slot) — confirmed live, a boss-kill-sized XP grant against a
  level-1 test character queued two rounds correctly.
- **Level growth:** +4% max HP and +4% damage per level above 1
  (`LEVEL_STAT_BONUS_PER_LEVEL`), applied via `recomputeMaxHp()` /
  `player.levelMult` — recomputed from the class base every time (join,
  level-up, or boon pick) rather than repeatedly multiplying an
  already-modified number in place, so stacking several changes in one run
  can't compound rounding drift.
- **Boons are gone on leave or die, per the spec above — a wipe counts as
  "die."** `checkForWipe`'s reset resets `boonHpMult`/`boonDmgMult`/
  `boonSpeedMult` to 1 and clears any still-pending choice queue. Surviving
  a fall-and-revive mid-run is NOT "die" here — boons persist through that,
  since the whole point of revive is staying in the run, not restarting it.
- **Persistence: per-character, not account-wide — changed 2026-08-26,
  see below.** `level`/`xp` live on each saved character's own roster
  entry (`server/db.js`'s `accounts.<id>.characters[].level/xp`), matching
  §11's original schema sketch, not the account-wide `players` row this
  first slice used. Trying a different one of an account's up to 4 saved
  characters starts that character back at level 1 rather than inheriting
  another one's progress.
- **HUD:** class label gained a `Lv N · X/Y xp` line (`js/render.js`). No
  XP progress *bar* yet — text only, kept deliberately small for this pass.
- **Confirmed live** (temporarily lowered `xpToNextLevel` to trigger a fast
  test, reverted before commit): a real kill streak took a level-1 test
  character to level 3, queued two boon-choice rounds, both resolved
  correctly via actual clicks — `boonSpeedMult`/`boonHpMult` landed exactly
  as expected, and picking Iron Will bumped maxHp from 140→168 while
  preserving the exact amount of damage already taken (hp gained precisely
  the same +28 delta as maxHp, not a heal-to-full).

**Reconciled + ability unlocks added 2026-08-26 — two sessions (this
machine and the work laptop) built Phase 3 independently on the same
starting commit and diverged.** The work-laptop session shipped the
boons/stat-scaling/dungeon-gating slice above, account-wide. This machine
separately built a different leveling core the same day — per-character,
with real ability unlocks — before either side knew about the other's
work. Reconciled by keeping this section's boons, `xpToNextLevel` curve,
`XP_PER_TRASH_WEIGHT`, `LEVEL_STAT_BONUS_PER_LEVEL`, and `minLevel`/
`xpCapLevel` numbers exactly as shipped and tested here, converting only
*where* level/xp live (per-character, see above), and layering the
ability-unlock work on top:

- **Every class's `special2` now carries an `unlockLevel` (3,
  uniformly).** Knight/Cleric/Enchanter's existing Taunt/Blessing/Group
  Haste just got gated behind it (`server.js`'s `doSpecial`, the same
  silent no-op a class simply lacking `special2` already got). Squire and
  Merlin's Apprentice had no `special2` at all before this, so both got a
  genuinely new ability rather than staying empty: Squire's **Second
  Wind** (self heal + a brief damage-reduction shield, `cost:0` like
  Shield Bash) and Apprentice's **Blink** (instant reposition away from
  the nearest monster, routed through the same wall-collision system
  (§9) normal movement uses — moved in 20 small sub-steps rather than one
  big jump, since a single large displacement can otherwise tunnel clean
  through a wall thinner than the jump distance without ever registering
  as a collision; caught live while verifying this reconciliation).
- **⚠️ One-time consequence of the account-wide → per-character switch:**
  any level/XP a character had already earned on the account-wide system
  (if the family played on it between the two sessions) has no sensible
  destination to migrate to — every character's level/xp normalizes to
  1/0 the first time the reconciled server boots against the existing
  DB. Gear, kills, currency, and dungeon-clears are untouched.
- Confirmed live end-to-end after reconciling: a fresh character starts
  independently at level 1 regardless of another saved character's
  level; XP grants/boon queuing/boon-choice math still land exactly as
  before; dungeon-select's level-gate badges now read the *selected*
  character's own level; crossing level 3 reveals the ability button and
  both new abilities work correctly, including the wall-tunneling fix
  above (a blink toward a wall now stops at it instead of jumping clean
  through).

**Bug fix, 2026-08-26 — boon cards weren't actually touch-enabled.**
Reported live: choosing a boon on level-up didn't respond to taps on a
phone. Root cause confirmed by dispatching a real synthetic
touchstart/touchend on a card and checking whether the handler fired — it
didn't. The cards only had a `click` listener; unlike the ability buttons
(static `<button>` elements, `js/input.js`), boon cards are dynamically
created `<div>`s, and a tap on one doesn't reliably synthesize a browser
`click` event the way a real `<button>` does. Fixed by adding an explicit
`touchend` handler that calls the same selection logic directly and
`preventDefault()`s so the browser's own (unreliable) click synthesis, if
it fires at all, can't double-select. Confirmed fixed with the same
synthetic-touch-dispatch test that found it, plus confirmed the existing
desktop mouse-click path still works unchanged. Incidentally also found
and fixed a latent related issue while investigating: `#boonOverlay`'s
z-index (30) sat *below* `#rotateHint`'s (50, the "turn your device"
overlay) — bumped to 60 so a level-up during a brief portrait/rotation
moment can't get visually hidden behind, and blocked by, the rotate
prompt.

**Open questions (unchanged from before this pass, still genuinely open):**
- Whether the numbers are actually well-tuned — the curve
  (`xpToNextLevel`), `XP_PER_TRASH_WEIGHT`, `LEVEL_STAT_BONUS_PER_LEVEL`,
  and each boon's magnitude are all first-cut guesses, not validated by a
  real family session. Same caveat as §9's solo-danger multiplier and
  party-scaling numbers — everything numeric shipped this session needs a
  real playtest before it's trustworthy.
- Whether a level cap should exist eventually — none is enforced yet.
- Expanding the boon pool past 3, and whether it should ever go per-class.
- Boon "rarity" (the original open question's "should mirror the rare-boss
  feeling") — not built; all 3 current boons are equally likely.

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
- [x] `firstCleared`-equivalent gate per dungeon (family-wide) *(done
      2026-08-24, as part of the larger dungeon-select rework below —
      `db.js`'s `dungeonsCleared` list, checked by `tickSafeRoom`. Once a
      dungeon's cleared once, the full-party requirement drops for good,
      solo included)*
- [x] Admin flag on Ken's account, gating a direct level-set action for
      catch-up *(done 2026-08-26 — see §8a. Grew into a small admin
      screen: level-set, instance reset, and stuck-join-lock clearing,
      all re-verified server-side regardless of client-side visibility)*
- [x] Remember the connection passphrase client-side too, alongside the
      logged-in account, so kids aren't retyping either credential each
      session
- [x] Character roster (up to 4 per account, pick one per run, deletable)
      *(done 2026-08-23 — supersedes the earlier "one permanent character"
      plan, see §8a)*
- [x] Revive/wipe mechanic — a fallen player needs a nearby teammate to
      channel them back up; a full wipe resets the dungeon to its safe
      room *(done 2026-08-23, see §9)*
- [x] Leave & restart — a "Leave" button logs out cleanly without
      disrupting teammates; leaving while solo also resets the dungeon
      *(done 2026-08-23)*
- [x] Enemy difficulty pass so revive/wipe has real teeth *(done
      2026-08-23, see §3)*

**Phase 3 — Permanent leveling + in-run boons**
- [x] Permanent XP/level system (never resets) *(first slice done
      2026-08-25 — see §10. XP from both regular and boss kills,
      account-wide persistence, +4%/level HP+damage growth)*
- [x] Temporary in-dungeon boon pool *(first slice done 2026-08-25 — 3
      generic boons, not yet per-class; see §10)*
- [x] Boon-choice UI (client) *(done 2026-08-25 — a modal overlay of up to
      3 cards on level-up, `js/main.js`'s `updateBoonOverlay`)*

**Phase 4 — Dungeon run rework**
- [x] Auto-attack + target-lock as the shared input model *(done
      2026-08-24 — every class/dungeon, specials stay manual)*
- [x] Escalating spawn tables within the existing maze/room structure (§9)
      *(done 2026-08-24, Sherwood's Sunken Trail only — kill-count driven;
      other 3 dungeons still unconverted)*
- [x] Boss-encounter trigger logic: probabilistic standard vs. rare/named
      roll *(done 2026-08-24, Sherwood's Black Knight/Sir Gorlagon only —
      rolled once at boss-room load, not a mid-run ambush; loot tied to
      which boss shows up via `rewardCurrency`/guaranteed extra drop)*
- [x] Level-gated dungeon unlock sequence (§5) *(done 2026-08-25 — paired
      with a per-dungeon XP cap so the first dungeon can't be farmed past
      its usefulness; see §5's table)*
- [ ] Weapon/Armor tier ladders + Artifact drop tables per dungeon/boss (§7)
- [ ] Extend auto-attack's engine-wide but everything else above to the
      other 3 dungeons (Sunken Chapel, Mordred's Keep, Avalon's Mist)

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
- Whether a wipe should ever cost more than lost time (a death counter,
  a time penalty) beyond "try the dungeon again from its safe room" (§9)
- Skill loadouts (§10a): the 4th loadout slot's category, whether a
  loadout locks for a whole run or can be re-picked, how it interacts
  with gear/boons, and whether to retrofit the 4 existing classes or only
  build it for classes added from Enchanter onward
- Extending branching side chambers (§9) beyond Sherwood Approach's one
  chamber — same pattern for the other 3 dungeons, and whether any
  dungeon should get more than one branch
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
- Fae Court/Isles & Legends/Mabinogion artifact catalogs — Arc I's five
  are built (§7); the other arcs' artifacts are still genuinely open,
  those dungeons aren't scoped yet.
- PIN recovery flow — if a kid forgets it, currently the only fix is
  manually editing the persisted JSON file; no admin-reset UI exists yet
  (§8a)
- Whether the roster could ever grow past four (§8a)
- Whether the ~15-minute-per-dungeon target is actually being hit now
  that the difficulty pass and revive/wipe are live — a solo playtest
  (2026-08-24, before party-scaling shipped) and a simulated 4-player one
  (same day, after) both happened, but neither is a real family session
  with actual tactical play — still needs one to actually judge (§9)

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
- Character choice is no longer permanent-once-ever — accounts now hold
  a roster of up to 4 saved characters (class + gender), picked before
  each run, deletable to free a slot. Supersedes the original
  one-permanent-character plan (§8a, revised 2026-08-23).
- A run can genuinely fail: revive (teammate channels a fallen player
  back up) and wipe (whole party down resets the dungeon to its safe
  room) are both shipped, making Pillar 5 real rather than aspirational
  (§2, §9, decided and shipped 2026-08-23).
- Escalation driver for continuous-spawn wave rooms is kill count, not
  wall-clock time — spawn rate/toughness scale with kills in that room,
  and the room clears on a kill quota plus an empty board (§9, decided
  and shipped on Sherwood's Sunken Trail, 2026-08-24).
- Rare/named boss variants are rolled once, when the boss room loads, not
  as a mid-run ambush — simplest slice of "probabilistic boss triggers"
  that fits today's fixed boss rooms (§5/§6/§9, decided and shipped for
  Sherwood's Black Knight → Sir Gorlagon roll, 2026-08-24).
- Currency-on-clear amounts: 30 on a standard dungeon-boss kill, 60 on a
  rare variant, both via the existing `db.addFamilyCurrency` — no spend
  destination exists yet (§11/§12 Phase 5 still open), this only starts
  the number moving (decided and shipped 2026-08-24).
- The three-slot gear system (§7) replaces the flat `gearTier` ladder for
  real — Weapon and Armor as independent tiered ladders, Artifact as the
  5-item Arc I catalog, all account-wide and actually persisted
  (`db.js`'s `equipment`). Confirmed live: survives a full disconnect,
  not just in-memory; boss kills grant exactly the right artifact;
  Ford-Warden's Buckler's block-then-cooldown behaves exactly as designed
  (decided and shipped 2026-08-24).
- This is a co-op dungeon crawler that needs a group, not a solo-viable
  horde mode — the Vampire Survivors framing (§1) describes the encounter
  shape only, not solo-first design intent. A dungeon should be realistically
  completable by 2, not really by 1 (§1/§9, decided 2026-08-25). First
  implementation pass: a solo-only incoming-damage multiplier
  (`SOLO_DANGER_MULT`, §9) — soft risk, not a hard entry block; genuinely
  untested against a real solo family run, may need retuning.
- Permanent leveling + in-run boons (§10, Phase 3), first slice shipped
  2026-08-25: XP from both regular and boss kills (not completion-only —
  needed for mid-run level-ups to actually happen, which is what triggers a
  boon choice); +4%/level permanent HP+damage growth; 3 generic
  (class-agnostic, not per-class yet) boons offered on level-up, queued
  rather than overwritten if a big XP grant crosses two level thresholds at
  once. Confirmed live end-to-end including the multi-level-up queue case
  and the HP-boon's exact-delta math. All the actual numbers (XP curve,
  per-kill weights, level growth rate, boon magnitudes) are first-cut
  guesses, not validated by real family play.
- Level-gated dungeon unlock + a per-dungeon XP cap (§5), shipped
  2026-08-25 — resolves "exact level thresholds per dungeon" now that
  Phase 3 leveling exists to gate on. `minLevel` blocks joining a dungeon
  below its threshold outright (checked server-side, badged proactively on
  the dungeon-select screen); `xpCapLevel` is the separate, actually-load-
  bearing half — a ceiling on XP earned *while farming that dungeon*, which
  is what actually stops a family from grinding the easy tutorial dungeon
  into permanent over-leveling. Bands overlap by design (next dungeon's
  minLevel sits below the previous one's cap). Confirmed live: a real
  level-3 account correctly saw the other 3 dungeons badged/blocked, and
  temporarily capping Sherwood at that same level confirmed further real
  kills granted exactly 0 XP. First-cut numbers, not validated by real
  family play — see §5's table.
- Rooms can now carry real interior wall geometry (§9), not just an open
  rectangle — Sherwood's room 1 reshaped into "Forest Crossroads" as the
  proof, 3 corridors off a hub instead of two exit gates floating together
  in one field (decided and shipped 2026-08-25). The collision primitive
  (server.js's moveWithWalls/circleHitsRect) is generic, usable by any
  room from here on, not bespoke to this one. Confirmed live: blocked
  correctly at a dividing wall, routable via the hub, side-chamber gate
  and secret-nook loot both triggered exactly where placed. Known
  limitation: monsters don't path around walls yet, still simple
  move-toward-target — fine for this room's layout, would need real
  pathfinding for a room where that matters tactically.
