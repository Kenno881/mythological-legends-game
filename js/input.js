"use strict";

// Captures raw input and sends it to the server on a fixed timer. Holds
// nothing but "what's currently pressed" — the server decides what that
// input does. No movement, cooldowns, or combat math happens here.
//
// Three independent sources (keyboard, touch stick, gamepad) each track
// their own held-direction state rather than sharing one mutable object —
// a gamepad can realistically be plugged in alongside a keyboard on the
// same desktop, and if both wrote into one shared object, whichever polled
// last would silently stomp the other's input. combinedKeys() ORs them
// together only at send time.

const INPUT_HZ = 20;

const keyboardKeys = { up: false, down: false, left: false, right: false };
const touchKeys = { up: false, down: false, left: false, right: false };
const gamepadKeys = { up: false, down: false, left: false, right: false };
let queuedAction = null; // one-shot: sent on the next tick, then cleared

function combinedKeys(){
  return {
    up: keyboardKeys.up || touchKeys.up || gamepadKeys.up,
    down: keyboardKeys.down || touchKeys.down || gamepadKeys.down,
    left: keyboardKeys.left || touchKeys.left || gamepadKeys.left,
    right: keyboardKeys.right || touchKeys.right || gamepadKeys.right
  };
}

// ---------- KEYBOARD ----------
window.addEventListener('keydown', e=>{
  const k = e.key.toLowerCase();
  if(k === 'w' || k === 'arrowup') keyboardKeys.up = true;
  if(k === 's' || k === 'arrowdown') keyboardKeys.down = true;
  if(k === 'a' || k === 'arrowleft') keyboardKeys.left = true;
  if(k === 'd' || k === 'arrowright') keyboardKeys.right = true;
  if(k === ' ') queuedAction = 'attack';
  if(k === 'e') queuedAction = 'special1';
  if(k === 'q') queuedAction = 'special2';
});
window.addEventListener('keyup', e=>{
  const k = e.key.toLowerCase();
  if(k === 'w' || k === 'arrowup') keyboardKeys.up = false;
  if(k === 's' || k === 'arrowdown') keyboardKeys.down = false;
  if(k === 'a' || k === 'arrowleft') keyboardKeys.left = false;
  if(k === 'd' || k === 'arrowright') keyboardKeys.right = false;
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
  touchKeys.left = nx < -STICK_DEADZONE;
  touchKeys.right = nx > STICK_DEADZONE;
  touchKeys.up = ny < -STICK_DEADZONE;
  touchKeys.down = ny > STICK_DEADZONE;
}
function stickReset(){
  stickActive = false;
  touchKeys.up = touchKeys.down = touchKeys.left = touchKeys.right = false;
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

// ---------- GAMEPAD ----------
// No "stick moved" or "button pressed" events exist for gamepads — the only
// way to read one is to poll navigator.getGamepads() yourself, every frame,
// for as long as it might be in use. Standard-layout assumption (the vast
// majority of USB/Bluetooth pads report as "standard"): left stick or
// d-pad for movement, A/B/X for attack/special1/special2 — A is the
// bottom face button, the natural "go" button for a kid picking this up
// cold. Button state needs manual edge-detection (was it up last poll?) to
// get the same one-shot-per-press behavior keydown/click give for free.
const GAMEPAD_DEADZONE = 0.3;
const BTN_ATTACK = 0, BTN_SPECIAL1 = 1, BTN_SPECIAL2 = 2; // A, B, X on a standard mapping
let gamepadConnected = false;
let prevButtonsPressed = {};

window.addEventListener('gamepadconnected', e=>{
  gamepadConnected = true;
  console.log(`[input] gamepad connected: ${e.gamepad.id}`);
});
window.addEventListener('gamepaddisconnected', e=>{
  gamepadConnected = false;
  gamepadKeys.up = gamepadKeys.down = gamepadKeys.left = gamepadKeys.right = false;
  console.log(`[input] gamepad disconnected: ${e.gamepad.id}`);
});

function pollGamepad(){
  if(gamepadConnected && navigator.getGamepads){
    const pads = navigator.getGamepads();
    let gp = null;
    for(let i = 0; i < pads.length; i++){ if(pads[i]){ gp = pads[i]; break; } }

    if(gp){
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      const dpadLeft = !!(gp.buttons[14] && gp.buttons[14].pressed);
      const dpadRight = !!(gp.buttons[15] && gp.buttons[15].pressed);
      const dpadUp = !!(gp.buttons[12] && gp.buttons[12].pressed);
      const dpadDown = !!(gp.buttons[13] && gp.buttons[13].pressed);

      gamepadKeys.left = ax < -GAMEPAD_DEADZONE || dpadLeft;
      gamepadKeys.right = ax > GAMEPAD_DEADZONE || dpadRight;
      gamepadKeys.up = ay < -GAMEPAD_DEADZONE || dpadUp;
      gamepadKeys.down = ay > GAMEPAD_DEADZONE || dpadDown;

      checkButtonEdge(gp, BTN_ATTACK, 'attack');
      checkButtonEdge(gp, BTN_SPECIAL1, 'special1');
      checkButtonEdge(gp, BTN_SPECIAL2, 'special2');
    }
  }
  requestAnimationFrame(pollGamepad);
}
function checkButtonEdge(gp, index, action){
  const pressed = !!(gp.buttons[index] && gp.buttons[index].pressed);
  if(pressed && !prevButtonsPressed[index]) queuedAction = action;
  prevButtonsPressed[index] = pressed;
}
requestAnimationFrame(pollGamepad);

// ---------- SEND ON TIMER ----------
// `state` is the current screen, owned by main.js — only send while actually
// in the game screen, and only ever include an action once per press/click.
setInterval(()=>{
  if(state !== 'game') return;
  sendInput(combinedKeys(), queuedAction);
  queuedAction = null;
}, 1000 / INPUT_HZ);
