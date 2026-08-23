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

document.getElementById('btnStart').addEventListener('click', ()=> showScreen('class'));
document.getElementById('btnBack').addEventListener('click', ()=> showScreen('title'));
document.getElementById('btnRestart').addEventListener('click', ()=> showScreen('title'));
// Note: the server keeps this connection's player entry around (marked dead).
// Picking a class again sends a fresh "join", which resets it server-side —
// no reconnect needed.

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
