"use strict";

// Screen navigation and login (MASTER_DESIGN.md §8a). Reacts to server
// messages (welcome, state) to switch screens — it never decides
// identity/victory/death itself, only displays them. The party gate
// (whole family required beyond the first dungeon) is server-side and
// surfaces here only as a "waitingForFamily" banner, not a screen — see
// onStateUpdate below.

const screens = {
  title: document.getElementById('screen-title'),
  login: document.getElementById('screen-login'),
  class: document.getElementById('screen-class'),
  game: document.getElementById('screen-game'),
  end: document.getElementById('screen-end')
};
let state = "title";
function showScreen(name){
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
  state = name;
}

// ---------- CLASS SELECT ----------
// Only ever shown once per account — see onWelcome below, which skips
// straight past this once an account already has a permanent classKey
// (§8a: chosen once, never re-picked).
const classGrid = document.getElementById('classGrid');
Object.entries(CLASSES).forEach(([key, c])=>{
  const div = document.createElement('div');
  div.className = 'class-card';
  div.innerHTML = `<h3>${c.name}</h3><p>${c.desc1}</p><p>${c.desc2}</p><span class="tag">${c.tag}</span>`;
  div.addEventListener('click', ()=> joinAs(key));
  classGrid.appendChild(div);
});

function joinAs(classKey){
  if(sendJoin(classKey)) showScreen('game');
  else console.warn('[main] not connected yet — try again in a moment');
}

// ---------- TITLE SCREEN: PASSPHRASE GATE ----------
const btnStart = document.getElementById('btnStart');
const passphraseInput = document.getElementById('passphraseInput');
const passphraseError = document.getElementById('passphraseError');
passphraseInput.value = getSavedPassphrase(); // remembered per-device, same idea as the account login below

async function handleBeginQuest(){
  if(ws && ws.readyState === WebSocket.OPEN){
    // Already connected (e.g. clicking through again from the end screen)
    // — no need to re-authenticate, just land wherever this character
    // actually belongs right now.
    const me = myPlayer();
    if(me && !me.dead) showScreen('game');
    else if(myClassKey) joinAs(myClassKey);
    else showScreen('class');
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

document.getElementById('btnBack').addEventListener('click', ()=> showScreen('title'));
// Reaching "end" means this character is dead or the quest is won; the
// restart button below (btnRestart) handles routing back in from there —
// picking a class again is now only ever a brand-new account's job.

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
  if(msg.resuming){ showScreen('game'); return; } // already had a live character — drop straight back in
  if(msg.classKey) joinAs(msg.classKey); else showScreen('class');
}

// ---------- REACT TO SERVER STATE ----------
let lastWaitingForFamily = false;
function onStateUpdate(s){
  if(state !== 'game') return;

  if(s.waitingForFamily !== lastWaitingForFamily){
    lastWaitingForFamily = s.waitingForFamily;
    if(s.waitingForFamily) showBanner("Waiting for the whole family before the next dungeon…");
  }

  const btnRestart = document.getElementById('btnRestart');

  if(s.victory){
    const d = DUNGEONS[DUNGEONS.length - 1];
    showScreen('end');
    document.getElementById('endTitle').textContent = d.finalVictoryTitle;
    document.getElementById('endSubtitle').textContent = d.finalVictorySubtitle;
    btnRestart.textContent = 'Return to Camelot';
    return;
  }

  const me = myPlayer();
  if(me && me.dead){
    showScreen('end');
    document.getElementById('endTitle').textContent = "Fallen at " + s.dungeonName;
    document.getElementById('endSubtitle').textContent = "Gather your courage — the quest awaits another try.";
    // Class is permanent (§8a) — dying rejoins straight back in as the same
    // class rather than routing back through class-select.
    btnRestart.textContent = myClassKey ? 'Rejoin the Fight' : 'Return to Camelot';
  }
}

document.getElementById('btnRestart').addEventListener('click', ()=>{
  const me = myPlayer();
  if(me && me.dead && myClassKey) joinAs(myClassKey);
  else showScreen('title');
});
