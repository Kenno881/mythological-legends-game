"use strict";

// Screen navigation and the title/class-select menu. Reacts to server state
// (victory, death) to switch screens — it never decides those outcomes,
// only displays them.

const screens = {
  title: document.getElementById('screen-title'),
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

// Build class select cards
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

async function handleBeginQuest(){
  // Already have a live connection (e.g. clicking through again after a
  // death/victory "Return to Camelot") — no need to re-prompt or reconnect.
  if(ws && ws.readyState === WebSocket.OPEN){
    showScreen('class');
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
    // `resuming` means the server recognized this browser's persistent ID
    // and reattached us to a character already in progress (refresh, brief
    // wifi drop, backgrounded tab) — skip class-select and drop straight
    // back into the game with gear/hp/position intact.
    showScreen(resuming ? 'game' : 'class');
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
document.getElementById('btnRestart').addEventListener('click', ()=> showScreen('title'));
// Reaching "end" means this character is dead or the quest is won, so
// picking a class again on the same connection sends a fresh "join" for a
// brand-new character (server refuses to "join" over an existing live one —
// that guard is what protects reconnects from losing progress).

// ---------- REACT TO SERVER STATE ----------
function onStateUpdate(s){
  if(state !== 'game') return;

  if(s.victory){
    const d = DUNGEONS[DUNGEONS.length - 1];
    showScreen('end');
    document.getElementById('endTitle').textContent = d.finalVictoryTitle;
    document.getElementById('endSubtitle').textContent = d.finalVictorySubtitle;
    return;
  }

  const me = myPlayer();
  if(me && me.dead){
    showScreen('end');
    document.getElementById('endTitle').textContent = "Fallen at " + s.dungeonName;
    document.getElementById('endSubtitle').textContent = "Gather your courage — the quest awaits another try.";
  }
}
