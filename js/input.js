"use strict";

// Captures raw input and sends it to the server on a fixed timer. Holds
// nothing but "what's currently pressed" — the server decides what that
// input does. No movement, cooldowns, or combat math happens here.

const INPUT_HZ = 20;

const heldKeys = { up: false, down: false, left: false, right: false };
let queuedAction = null; // one-shot: sent on the next tick, then cleared

// ---------- KEYBOARD ----------
window.addEventListener('keydown', e=>{
  const k = e.key.toLowerCase();
  if(k === 'w' || k === 'arrowup') heldKeys.up = true;
  if(k === 's' || k === 'arrowdown') heldKeys.down = true;
  if(k === 'a' || k === 'arrowleft') heldKeys.left = true;
  if(k === 'd' || k === 'arrowright') heldKeys.right = true;
  if(k === ' ') queuedAction = 'attack';
  if(k === 'e') queuedAction = 'special1';
  if(k === 'q') queuedAction = 'special2';
});
window.addEventListener('keyup', e=>{
  const k = e.key.toLowerCase();
  if(k === 'w' || k === 'arrowup') heldKeys.up = false;
  if(k === 's' || k === 'arrowdown') heldKeys.down = false;
  if(k === 'a' || k === 'arrowleft') heldKeys.left = false;
  if(k === 'd' || k === 'arrowright') heldKeys.right = false;
});

// ---------- TOUCH STICK ----------
// The protocol only carries discrete up/down/left/right, so the analog
// stick vector is thresholded into directions (up to two, for diagonals)
// instead of carrying a magnitude.
const STICK_DEADZONE = 0.3;
let stickActive = false;
const stickZone = document.getElementById('stickZone');
const stickNub = document.getElementById('stickNub');

function stickHandler(e){
  e.preventDefault();
  const t = e.touches ? e.touches[0] : e;
  const rect = stickZone.getBoundingClientRect();
  let dx = t.clientX - (rect.left + rect.width / 2);
  let dy = t.clientY - (rect.top + rect.height / 2);
  const max = 40;
  const dist = Math.min(Math.hypot(dx, dy), max);
  const ang = Math.atan2(dy, dx);
  dx = Math.cos(ang) * dist; dy = Math.sin(ang) * dist;
  stickNub.style.left = (38 + dx) + 'px';
  stickNub.style.top = (38 + dy) + 'px';

  const nx = dx / max, ny = dy / max;
  heldKeys.left = nx < -STICK_DEADZONE;
  heldKeys.right = nx > STICK_DEADZONE;
  heldKeys.up = ny < -STICK_DEADZONE;
  heldKeys.down = ny > STICK_DEADZONE;
}
function stickReset(){
  stickActive = false;
  heldKeys.up = heldKeys.down = heldKeys.left = heldKeys.right = false;
  stickNub.style.left = '38px'; stickNub.style.top = '38px';
}
stickZone.addEventListener('touchstart', e=>{ stickActive = true; stickHandler(e); });
stickZone.addEventListener('touchmove', e=>{ if(stickActive) stickHandler(e); });
stickZone.addEventListener('touchend', stickReset);

// ---------- ACTION BUTTONS ----------
document.getElementById('btnAttack').addEventListener('click', ()=> queuedAction = 'attack');
document.getElementById('btnSpecial1').addEventListener('click', ()=> queuedAction = 'special1');
document.getElementById('btnSpecial2').addEventListener('click', ()=> queuedAction = 'special2');
['btnAttack', 'btnSpecial1', 'btnSpecial2'].forEach(id=>{
  document.getElementById(id).addEventListener('touchstart', e=>e.preventDefault());
});

// ---------- SEND ON TIMER ----------
// `state` is the current screen, owned by main.js — only send while actually
// in the game screen, and only ever include an action once per press/click.
setInterval(()=>{
  if(state !== 'game') return;
  sendInput(heldKeys, queuedAction);
  queuedAction = null;
}, 1000 / INPUT_HZ);
