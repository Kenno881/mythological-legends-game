"use strict";

// Screen navigation, login, and character roster (MASTER_DESIGN.md §8a).
// Reacts to server messages (welcome, characterList, state) to switch
// screens — it never decides identity/victory/death/revive itself, only
// displays them. The party gate (whole family required beyond the first
// dungeon) is server-side and surfaces here only as a "waitingForFamily"
// banner, not a screen — see onStateUpdate below.

const screens = {
  title: document.getElementById('screen-title'),
  login: document.getElementById('screen-login'),
  characters: document.getElementById('screen-characters'),
  admin: document.getElementById('screen-admin'),
  dungeonSelect: document.getElementById('screen-dungeon-select'),
  game: document.getElementById('screen-game'),
  dungeonComplete: document.getElementById('screen-dungeon-complete'),
  end: document.getElementById('screen-end')
};
let state = "title";
function showScreen(name){
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
  state = name;
}

// ---------- CHARACTER ROSTER (up to 4 per account, pick one per run) ----------
const rosterList = document.getElementById('rosterList');
const createClassPanel = document.getElementById('createClassPanel');
const createGenderPanel = document.getElementById('createGenderPanel');
let pendingClassKey = null; // set once a class is chosen while creating a new character, cleared after

function showRosterPanel(){
  rosterList.classList.remove('hidden');
  createClassPanel.classList.add('hidden');
  createGenderPanel.classList.add('hidden');
  renderRoster();
}

function renderRoster(){
  rosterList.innerHTML = '';
  myCharacters.forEach(ch=>{
    const c = CLASSES[ch.classKey];
    const div = document.createElement('div');
    div.className = 'class-card roster-card';
    div.innerHTML = `<h3>${c ? c.name : ch.classKey}</h3>
      <p>${ch.gender ? ch.gender.charAt(0).toUpperCase() + ch.gender.slice(1) : 'Unspecified'} — Level ${ch.level || 1}</p>
      <button class="btn secondary roster-delete" type="button">Delete</button>`;
    div.addEventListener('click', (e)=>{
      if(e.target.classList.contains('roster-delete')) return; // handled separately below
      playCharacter(ch.id);
    });
    div.querySelector('.roster-delete').addEventListener('click', (e)=>{
      e.stopPropagation();
      sendDeleteCharacter(ch.id);
    });
    rosterList.appendChild(div);
  });
  if(myCharacters.length < 4){
    const div = document.createElement('div');
    div.className = 'class-card roster-card roster-create';
    div.innerHTML = `<h3>+ New Character</h3>`;
    div.addEventListener('click', ()=>{
      rosterList.classList.add('hidden');
      createClassPanel.classList.remove('hidden');
    });
    rosterList.appendChild(div);
  }
}

const createClassGrid = document.getElementById('createClassGrid');
Object.entries(CLASSES).forEach(([key, c])=>{
  const div = document.createElement('div');
  div.className = 'class-card';
  div.innerHTML = `<h3>${c.name}</h3><p>${c.desc1}</p><p>${c.desc2}</p><span class="tag">${c.tag}</span>`;
  div.addEventListener('click', ()=>{
    pendingClassKey = key;
    createClassPanel.classList.add('hidden');
    createGenderPanel.classList.remove('hidden');
  });
  createClassGrid.appendChild(div);
});

document.getElementById('btnCreateClassBack').addEventListener('click', showRosterPanel);
document.getElementById('btnCreateGenderBack').addEventListener('click', ()=>{
  createGenderPanel.classList.add('hidden');
  createClassPanel.classList.remove('hidden');
});
// New character created — auto-play it immediately rather than making the
// player tap it again from the roster. Any other roster refresh (a
// delete, or the initial fetch) just re-renders the roster panel in
// place. justCreated is set right before the create request goes out so
// onCharacterList (the reply) knows which case it's handling.
let justCreated = false;
['male', 'female'].forEach(gender=>{
  document.getElementById('btnGender' + gender.charAt(0).toUpperCase() + gender.slice(1))
    .addEventListener('click', ()=>{
      justCreated = true;
      sendCreateCharacter(pendingClassKey, gender);
      pendingClassKey = null;
    });
});

function onCharacterList(msg){
  if(justCreated){
    justCreated = false;
    const newest = myCharacters[myCharacters.length - 1];
    if(newest) playCharacter(newest.id);
    return;
  }
  if(state === 'characters') showRosterPanel();
}

// ---------- ADMIN (§8a, Dad's account only — server re-checks isAdmin on
// every action regardless of whether this button is visible) ----------
let lastAdminOverview = null;
const adminAccountSelect = document.getElementById('adminAccountSelect');
const adminCharacterSelect = document.getElementById('adminCharacterSelect');
const adminStatus = document.getElementById('adminStatus');

document.getElementById('btnOpenAdmin').addEventListener('click', ()=>{
  showScreen('admin');
  sendAdminGetOverview();
});
document.getElementById('btnAdminBack').addEventListener('click', ()=>{
  showRosterPanel();
  showScreen('characters');
});
document.getElementById('btnAdminRefresh').addEventListener('click', sendAdminGetOverview);

function renderAdminCharacterOptions(){
  adminCharacterSelect.innerHTML = '';
  if(!lastAdminOverview) return;
  const acct = lastAdminOverview.roster.find(a => a.id === adminAccountSelect.value);
  if(!acct) return;
  acct.characters.forEach(ch=>{
    const c = CLASSES[ch.classKey];
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = `${c ? c.name : ch.classKey} (Lv ${ch.level || 1})`;
    adminCharacterSelect.appendChild(opt);
  });
}
adminAccountSelect.addEventListener('change', renderAdminCharacterOptions);

// Refreshed after every admin action too (server.js sends a fresh overview
// back each time), not just the initial open — so the panel reflects
// reality immediately instead of needing a manual refresh to see whether
// an action actually took effect.
function onAdminOverview(msg){
  lastAdminOverview = msg;
  adminStatus.textContent = '';

  const prevAccount = adminAccountSelect.value;
  adminAccountSelect.innerHTML = '';
  msg.roster.forEach(acct=>{
    const opt = document.createElement('option');
    opt.value = acct.id;
    opt.textContent = acct.name;
    adminAccountSelect.appendChild(opt);
  });
  if(msg.roster.some(a => a.id === prevAccount)) adminAccountSelect.value = prevAccount;
  renderAdminCharacterOptions();

  const instanceListEl = document.getElementById('adminInstanceList');
  instanceListEl.innerHTML = '';
  if(msg.activeInstances.length === 0){
    instanceListEl.innerHTML = '<div class="admin-list-empty">No active dungeon runs right now.</div>';
  } else {
    msg.activeInstances.forEach(inst=>{
      const names = inst.playerIds.map(pid=>{
        const acct = msg.roster.find(a => a.id === pid);
        return acct ? acct.name : pid;
      }).join(', ') || 'empty';
      const row = document.createElement('div');
      row.className = 'admin-list-row';
      row.innerHTML = `<span>${inst.name} — ${names}</span>`;
      const btn = document.createElement('button');
      btn.className = 'btn secondary'; btn.type = 'button';
      btn.textContent = 'Reset to Safe Room';
      btn.addEventListener('click', ()=>{
        if(!confirm(`Reset ${inst.name} back to its safe room for everyone in it?`)) return;
        sendAdminResetInstance(inst.dungeonIndex);
      });
      row.appendChild(btn);
      instanceListEl.appendChild(row);
    });
  }

  const lockListEl = document.getElementById('adminLockList');
  lockListEl.innerHTML = '';
  const locked = msg.roster.filter(a => a.activeDungeonIndex !== null);
  if(locked.length === 0){
    lockListEl.innerHTML = '<div class="admin-list-empty">Nobody is currently locked into a run.</div>';
  } else {
    locked.forEach(acct=>{
      const dungeonName = DUNGEONS[acct.activeDungeonIndex] ? DUNGEONS[acct.activeDungeonIndex].name : '?';
      const row = document.createElement('div');
      row.className = 'admin-list-row';
      row.innerHTML = `<span>${acct.name} — ${dungeonName}</span>`;
      const btn = document.createElement('button');
      btn.className = 'btn secondary'; btn.type = 'button';
      btn.textContent = 'Clear Lock';
      btn.addEventListener('click', ()=>{
        if(!confirm(`Clear ${acct.name}'s join lock? Only do this if they're actually stuck, not mid-session.`)) return;
        sendAdminClearJoinLock(acct.id);
      });
      row.appendChild(btn);
      lockListEl.appendChild(row);
    });
  }
}

document.getElementById('btnAdminSetLevel').addEventListener('click', ()=>{
  const accountId = adminAccountSelect.value, characterId = adminCharacterSelect.value;
  const level = Number(document.getElementById('adminLevelInput').value) || 1;
  if(!accountId || !characterId){ adminStatus.textContent = 'Pick a family member and character first.'; return; }
  sendAdminSetLevel(accountId, characterId, level);
  adminStatus.textContent = 'Setting…';
});
document.getElementById('btnAdminResetLevel').addEventListener('click', ()=>{
  const accountId = adminAccountSelect.value, characterId = adminCharacterSelect.value;
  if(!accountId || !characterId){ adminStatus.textContent = 'Pick a family member and character first.'; return; }
  if(!confirm('Reset this character back to level 1?')) return;
  sendAdminSetLevel(accountId, characterId, 1);
  adminStatus.textContent = 'Resetting…';
});

// ---------- DUNGEON SELECT ----------
// Any dungeon can be picked from the outset (MASTER_DESIGN.md's §5
// sequential/level-gated unlock doesn't apply yet — no leveling system
// exists to gate on). A cleared dungeon is unrestricted for anyone, any
// subset, any time; an uncleared one still needs the whole family present
// once inside its safe room — that part is enforced server-side
// (tickSafeRoom/familyFullyConnected) and just surfaces here as a badge,
// not a hard block on selecting it at all.
let pendingCharacterId = null; // chosen character, carried from screen-characters into screen-dungeon-select

function playCharacter(characterId){
  pendingCharacterId = characterId;
  renderDungeonSelect();
  showScreen('dungeonSelect');
}

const dungeonList = document.getElementById('dungeonList');
const dungeonSelectStatus = document.getElementById('dungeonSelectStatus');

// Guards the window between sending 'join' and actually knowing whether it
// worked — see JOIN CONFIRMATION below. Only one join attempt in flight at
// a time; a card click while one's already pending is ignored rather than
// firing a second join.
let awaitingJoin = false;
let joinTimeoutId = null;

function renderDungeonSelect(){
  dungeonSelectStatus.textContent = '';
  dungeonList.innerHTML = '';
  // Level is per-character now (MASTER_DESIGN.md §10), not a single
  // account-wide number — look up the character just chosen rather than a
  // connect-time global, so the badge reflects whichever character is
  // about to actually join.
  const pendingChar = myCharacters.find(c => c.id === pendingCharacterId);
  const myLevel = (pendingChar && pendingChar.level) || 1;
  DUNGEONS.forEach((d, idx)=>{
    const cleared = myDungeonsCleared.includes(d.name);
    const needsFamily = idx > 0 && !cleared;
    const underLevel = !!d.minLevel && myLevel < d.minLevel;
    const div = document.createElement('div');
    div.className = 'dungeon-card' + (underLevel ? ' locked' : '');
    div.innerHTML = `
      <div class="dungeon-card-head">
        <h3>${d.name}</h3>
        ${cleared ? '<span class="dungeon-badge cleared">Cleared</span>' : ''}
        ${needsFamily ? '<span class="dungeon-badge needs-family">Needs the full family</span>' : ''}
        ${underLevel ? `<span class="dungeon-badge locked">Requires Level ${d.minLevel}</span>` : ''}
      </div>
      ${d.lore ? `
        <p class="lore-line"><span class="lore-label">Why:</span> ${d.lore.why}</p>
        <p class="lore-line"><span class="lore-label">Objective:</span> ${d.lore.objective}</p>
        <p class="lore-line"><span class="lore-label">Reward:</span> ${d.lore.reward}</p>
      ` : ''}
    `;
    div.addEventListener('click', ()=> attemptJoin(idx));
    dungeonList.appendChild(div);
  });
}

// ---------- JOIN CONFIRMATION ----------
// A join used to switch to the game screen the instant sendJoin() returned
// true — which only means "the socket was open enough to queue a send,"
// not "the server actually accepted it." On a real (non-localhost)
// connection the gap before the first real confirmation arrives is long
// enough to notice, and if the join was ever silently rejected or dropped,
// nothing would ever arrive to draw — a permanent blank grey game screen
// with no error shown. Confirmed live 2026-08-24 ("the grey screen bug").
// Now: wait for an explicit joinResult (ok:true) or the first real state
// broadcast — whichever comes first — before switching screens, and time
// out with a visible, retryable error if neither shows up.
function attemptJoin(dungeonIndex){
  if(awaitingJoin) return;
  awaitingJoin = true;
  dungeonSelectStatus.textContent = '';
  if(!sendJoin(pendingCharacterId, dungeonIndex)){
    awaitingJoin = false;
    dungeonSelectStatus.textContent = 'Not connected yet — try again in a moment.';
    return;
  }
  joinTimeoutId = setTimeout(()=>{
    if(!awaitingJoin) return;
    awaitingJoin = false;
    dungeonSelectStatus.textContent = "That didn't go through — try again.";
  }, 6000);
}

function clearJoinWait(){
  awaitingJoin = false;
  if(joinTimeoutId){ clearTimeout(joinTimeoutId); joinTimeoutId = null; }
}

function onJoinResult(msg){
  if(!awaitingJoin) return; // already resolved via the first state broadcast — nothing left to do
  if(msg.ok){ clearJoinWait(); showScreen('game'); return; }
  clearJoinWait();
  const reasons = {
    already_active: "Already in a dungeon on another device — leave that one first.",
    unknown_character: 'That character is out of sync — pick again from the roster.',
    invalid_dungeon: 'Something went wrong picking that dungeon — try again.',
    level_too_low: `Not ready for this one yet — needs level ${msg.minLevel}.`
  };
  dungeonSelectStatus.textContent = reasons[msg.reason] || 'Something went wrong — try again.';
}

// Reply to sendReturnToDungeonSelect() — same connection, still logged in,
// just back to picking (net.js already refreshed myDungeonsCleared from
// this message before calling here).
function onLeftInstance(){
  clearJoinWait();
  renderDungeonSelect();
  showScreen('dungeonSelect');
}

// ---------- TITLE SCREEN: PASSPHRASE GATE ----------
const btnStart = document.getElementById('btnStart');
const passphraseInput = document.getElementById('passphraseInput');
const passphraseError = document.getElementById('passphraseError');
passphraseInput.value = getSavedPassphrase(); // remembered per-device, same idea as the account login below

async function handleBeginQuest(){
  if(ws && ws.readyState === WebSocket.OPEN && myId){
    // Already connected and identified (e.g. clicking through again after
    // a victory) — no need to re-authenticate.
    const me = myPlayer();
    if(me){
      showScreen('game'); // still has a live entry (alive or fallen) — drop back in, fallen overlay handles the rest
    } else {
      showRosterPanel();
      showScreen('characters');
    }
    return;
  }
  if(ws && ws.readyState === WebSocket.OPEN && !myId){
    // Connected but unidentified — e.g. right after leaving a dungeon, the
    // same socket is still open but needs a fresh login.
    showScreen('login');
    return;
  }

  const phrase = passphraseInput.value;
  passphraseError.textContent = '';
  btnStart.disabled = true;
  btnStart.textContent = 'Knocking at the gate…';

  const ok = await attemptConnect(phrase);

  btnStart.disabled = false;
  btnStart.textContent = 'Begin the Quest';

  if(ok){
    // A remembered device's identity resolves via 'welcome' before this
    // await returns (see net.js) — onWelcome has already picked the right
    // screen in that case. No remembered identity means no 'welcome' yet;
    // show the login screen so a name can be picked.
    if(!myId) showScreen('login');
  } else {
    passphraseError.textContent = "That's not it — try again.";
    passphraseInput.select();
  }
}

btnStart.addEventListener('click', handleBeginQuest);
passphraseInput.addEventListener('keydown', e=>{
  if(e.key === 'Enter') handleBeginQuest();
});

// ---------- LOGIN (MASTER_DESIGN.md §8a) ----------
// Exactly 5 reserved names, matching server.js's ACCOUNTS — this list is
// purely cosmetic (which buttons to draw); the server is the actual
// authority on which accounts exist, so an out-of-sync list here would
// just mean a wrong button, never a security issue.
const ACCOUNT_NAMES = ['Dad', 'Mum', 'Amelia', 'Declan', 'test'];
let selectedUsername = null;

const loginNames = document.getElementById('loginNames');
ACCOUNT_NAMES.forEach(name=>{
  const div = document.createElement('div');
  div.className = 'class-card';
  div.innerHTML = `<h3>${name}</h3>`;
  div.addEventListener('click', ()=> showPinPanel(name));
  loginNames.appendChild(div);
});

const loginPinPanel = document.getElementById('loginPinPanel');
const loginPinPrompt = document.getElementById('loginPinPrompt');
const pinInput = document.getElementById('pinInput');
const pinConfirmInput = document.getElementById('pinConfirmInput');
const loginError = document.getElementById('loginError');

function showPinPanel(name){
  selectedUsername = name;
  loginNames.classList.add('hidden');
  loginPinPanel.classList.remove('hidden');
  loginPinPrompt.textContent = `Enter ${name}'s PIN twice — this sets it, the very first time.`;
  pinInput.value = ''; pinConfirmInput.value = ''; loginError.textContent = '';
  pinInput.focus();
}

document.getElementById('btnLoginBack').addEventListener('click', ()=>{
  loginPinPanel.classList.add('hidden');
  loginNames.classList.remove('hidden');
  selectedUsername = null;
});

document.getElementById('btnPinSubmit').addEventListener('click', submitPin);
[pinInput, pinConfirmInput].forEach(el=> el.addEventListener('keydown', e=>{ if(e.key === 'Enter') submitPin(); }));

// Always asking for the PIN twice — for both a brand-new claim and an
// existing account — keeps this one simple code path instead of needing
// to know in advance (a server round-trip) which case this is. A known
// PIN typed twice is a minor bit of friction; it avoids ever locking in a
// typo'd PIN with no recovery flow yet.
function submitPin(){
  const a = pinInput.value, b = pinConfirmInput.value;
  if(!/^\d{4}$/.test(a) || a !== b){
    loginError.textContent = "Enter the same 4-digit PIN in both boxes.";
    return;
  }
  loginError.textContent = '';
  sendLogin(selectedUsername, a);
}

function onLoginResult(msg){
  if(msg.ok) return; // 'welcome' arrives separately and actually drives the screen transition
  loginError.textContent = msg.reason === 'wrong_pin'
    ? "That's not the right PIN — try again."
    : "Something went wrong — try again.";
  pinInput.value = ''; pinConfirmInput.value = '';
  pinInput.focus();
}

// ---------- WELCOME (fires once identity is established — immediately
// for a remembered device, or right after a successful login) ----------
// Sherwood Approach (the first dungeon) never gates on the rest of the
// family — anyone logs straight in, solo or otherwise.
function onWelcome(msg){
  document.getElementById('btnOpenAdmin').classList.toggle('hidden', !myIsAdmin);
  if(msg.resuming){ showScreen('game'); return; } // already had a live character — drop straight back in
  showRosterPanel();
  showScreen('characters');
}

function onLeftDungeon(){
  // Same connection, now unidentified server-side — needs a fresh login
  // rather than a reconnect, same as server.js's leaveDungeon handling.
  showScreen('login');
}

// ---------- DUNGEON COMPLETE (per-dungeon summary, server.js's
// dungeonSummary — set the instant a boss dies, cleared again after a
// short beat) ----------
// dungeonSummaryShown guards against re-triggering every ~50ms tick while
// the server still has it set: dungeonSummary is a fresh object on every
// broadcast (JSON round-trip), so comparing it by reference/equality would
// fire repeatedly — a plain boolean edge-trigger (like lastWaitingForFamily
// below) is what's actually needed here.
let dungeonSummaryShown = false;

function formatDuration(totalSeconds){
  const m = Math.floor(totalSeconds / 60), s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function showDungeonComplete(summary){
  // campaignVictory (server.js's onBossDefeated — true only on the actual
  // clear that completes all 4 Arc I dungeons for the first time ever)
  // shows the existing "Camelot is Saved" screen instead of the regular
  // per-dungeon summary. Victory is a one-time celebration now, not a
  // dead end — dismissing it goes back to dungeon-select same as anything
  // else (see #screen-end's button below), the campaign stays playable.
  if(summary.campaignVictory){
    const d = DUNGEONS[DUNGEONS.length - 1];
    document.getElementById('endTitle').textContent = d.finalVictoryTitle;
    document.getElementById('endSubtitle').textContent = d.finalVictorySubtitle;
    showScreen('end');
    return;
  }
  document.getElementById('dcTitle').textContent = `Dungeon Cleared: ${summary.dungeonName}`;
  document.getElementById('dcFlavor').textContent = summary.flavorText;
  document.getElementById('dcTime').textContent = formatDuration(summary.elapsedSeconds);
  document.getElementById('dcKills').textContent = summary.kills;
  document.getElementById('dcCurrencyEarned').textContent = '+' + summary.currencyEarned;
  document.getElementById('dcCurrencyTotal').textContent = summary.familyCurrencyTotal;
  showScreen('dungeonComplete');
}

// Dismissing either the regular summary or the victory screen leaves the
// current (already-cleared) instance and returns to dungeon-select rather
// than assuming a fixed "next dungeon" — there isn't one anymore now that
// any dungeon can be picked (net.js's onLeftInstance renders the screen
// once the server confirms).
document.getElementById('btnDcContinue').addEventListener('click', sendReturnToDungeonSelect);
document.getElementById('btnRestart').addEventListener('click', sendReturnToDungeonSelect);

// ---------- REACT TO SERVER STATE ----------
let lastWaitingForFamily = false;
const fallenOverlay = document.getElementById('fallenOverlay');
const reviveBar = document.getElementById('reviveBar');
const boonOverlay = document.getElementById('boonOverlay');
const boonCards = document.getElementById('boonCards');

// Shows whichever boon-choice round is first in the queue (server.js can
// queue more than one if a single kill's XP crossed two level thresholds at
// once — see grantXp/offerBoonChoice). Rebuilds the 3 cards fresh only when
// the actual offered set changes, not every state tick, so a click isn't
// fighting a DOM rebuild racing it on the next 50ms tick.
let lastShownBoonRound = null;
function updateBoonOverlay(me){
  const round = me && me.pendingBoonChoices && me.pendingBoonChoices[0];
  if(!round){
    boonOverlay.classList.add('hidden');
    lastShownBoonRound = null;
    return;
  }
  boonOverlay.classList.remove('hidden');
  const key = round.join(',');
  if(key === lastShownBoonRound) return;
  lastShownBoonRound = key;
  boonCards.innerHTML = '';
  round.forEach(boonId=>{
    const b = BOONS[boonId];
    const card = document.createElement('div');
    card.className = 'boon-card';
    card.innerHTML = `<h4>${b.name}</h4><p>${b.description}</p>`;
    // A plain `click` listener isn't enough here — unlike the static
    // <button> ability buttons (input.js), these are dynamically created
    // <div>s, and a tap on one doesn't reliably synthesize a click event on
    // a real touch device (confirmed live: a real touchstart/touchend on a
    // card fired neither listener). touchend calls the same handler
    // directly and preventDefault()s so the browser's own (unreliable)
    // click synthesis, if it fires at all, can't double-select a boon.
    card.addEventListener('click', ()=> sendChooseBoon(boonId));
    card.addEventListener('touchend', (e)=>{ e.preventDefault(); sendChooseBoon(boonId); });
    boonCards.appendChild(card);
  });
}

function onStateUpdate(s){
  // A state broadcast arriving at all is proof the join went through —
  // resolves the join wait even if the explicit joinResult (net.js) got
  // here second, or got lost. See JOIN CONFIRMATION above.
  if(awaitingJoin){ clearJoinWait(); showScreen('game'); }

  if(s.dungeonSummary && !dungeonSummaryShown){
    dungeonSummaryShown = true;
    showDungeonComplete(s.dungeonSummary);
  } else if(!s.dungeonSummary){
    dungeonSummaryShown = false;
  }

  if(state !== 'game') return;

  if(s.waitingForFamily !== lastWaitingForFamily){
    lastWaitingForFamily = s.waitingForFamily;
    if(s.waitingForFamily) showBanner("Waiting for the whole family before continuing…");
  }

  // Death no longer leaves the game screen — a dead player stays here,
  // watching for a teammate to revive them (or the whole party wipes and
  // resets, server-side) — see the fallen overlay below.
  const me = myPlayer();
  if(me && me.dead){
    fallenOverlay.classList.remove('hidden');
    const pct = Math.min(100, (me.reviveProgress / REVIVE_CHANNEL_SECONDS) * 100);
    reviveBar.style.width = pct + '%';
  } else {
    fallenOverlay.classList.add('hidden');
  }

  updateBoonOverlay(me);
}

// ---------- LEAVE DUNGEON ----------
document.getElementById('btnLeave').addEventListener('click', ()=>{
  sendLeaveDungeon();
});
