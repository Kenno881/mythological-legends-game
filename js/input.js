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
//
// Tracks one specific touch by identifier rather than grabbing e.touches[0] —
// on a tablet the player routinely has a second finger down on an ability
// button at the same time (two-thumb play, way more natural with a tablet's
// extra screen room than on a phone). e.touches[0] is whichever touch
// currently has the lowest index across the WHOLE screen, not necessarily
// this one, so the stick could silently start reading the button-thumb's
// position instead of its own the moment a second finger touched down.
const STICK_DEADZONE = 0.3;
let stickTouchId = null;
const stickZone = document.getElementById('stickZone');
const stickNub = document.getElementById('stickNub');

function findTouch(touchList, id){
  for(let i = 0; i < touchList.length; i++){
    if(touchList[i].identifier === id) return touchList[i];
  }
  return null;
}
function moveStickTo(clientX, clientY){
  const rect = stickZone.getBoundingClientRect();
  let dx = clientX - (rect.left + rect.width / 2);
  let dy = clientY - (rect.top + rect.height / 2);
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
  stickTouchId = null;
  touchKeys.up = touchKeys.down = touchKeys.left = touchKeys.right = false;
  stickNub.style.left = '38px'; stickNub.style.top = '38px';
}
stickZone.addEventListener('touchstart', e=>{
  e.preventDefault();
  if(stickTouchId !== null) return; // already tracking a finger — ignore a second one landing here
  const t = e.changedTouches[0];
  stickTouchId = t.identifier;
  moveStickTo(t.clientX, t.clientY);
});
stickZone.addEventListener('touchmove', e=>{
  e.preventDefault();
  if(stickTouchId === null) return;
  const t = findTouch(e.touches, stickTouchId);
  if(t) moveStickTo(t.clientX, t.clientY);
});
function stickTouchEnd(e){
  if(stickTouchId !== null && findTouch(e.changedTouches, stickTouchId)) stickReset();
}
stickZone.addEventListener('touchend', stickTouchEnd);
stickZone.addEventListener('touchcancel', stickTouchEnd);

// ---------- ACTION BUTTONS ----------
// Basic attack is automatic now (server.js's tickAutoAttack) — no button
// for it. These two remain fully manual.
document.getElementById('btnSpecial1').addEventListener('click', ()=> queuedAction = 'special1');
document.getElementById('btnSpecial2').addEventListener('click', ()=> queuedAction = 'special2');
['btnSpecial1', 'btnSpecial2'].forEach(id=>{
  document.getElementById(id).addEventListener('touchstart', e=>e.preventDefault());
});

// ---------- GAMEPAD ----------
// No "stick moved" or "button pressed" events exist for gamepads — the only
// way to read one is to poll navigator.getGamepads() yourself, every frame,
// for as long as it might be in use. Standard-layout assumption (the vast
// majority of USB/Bluetooth pads report as "standard"): left stick or
// d-pad for movement, A/B for special1/special2 — basic attack is
// automatic now (server.js's tickAutoAttack), so there's no attack button
// to bind at all. Button state needs manual edge-detection (was it up last
// poll?) to get the same one-shot-per-press behavior keydown/click give
// for free.
const GAMEPAD_DEADZONE = 0.3;
const BTN_SPECIAL1 = 0, BTN_SPECIAL2 = 1; // A, B on a standard mapping
let prevButtonsPressed = {};
let lastLoggedGamepadId = null; // avoids re-logging "connected" every single poll

// The 'gamepadconnected' event is unreliable in practice — Chrome in
// particular often never fires it for a controller that was already plugged
// in before the page loaded, only for one plugged in *after*, and even then
// sometimes only once a button on it has actually been pressed. Gating the
// poll loop behind that event (an earlier version of this file did) meant a
// perfectly good, already-connected controller could just never be noticed.
// Polling navigator.getGamepads() directly every frame has no such
// dependency — it's always safe to call and simply returns empty slots when
// nothing's connected, so that's the only thing this now relies on. The
// event listeners below are kept purely for console visibility.
window.addEventListener('gamepadconnected', e=>{
  console.log(`[input] gamepad connected: ${e.gamepad.id}`);
});
window.addEventListener('gamepaddisconnected', e=>{
  gamepadKeys.up = gamepadKeys.down = gamepadKeys.left = gamepadKeys.right = false;
  console.log(`[input] gamepad disconnected: ${e.gamepad.id}`);
});

function pollGamepad(){
  let gp = null;
  if(navigator.getGamepads){
    const pads = navigator.getGamepads();
    // Some non-controller peripherals (certain headsets' inline controls,
    // among other things) expose a HID interface that also shows up here.
    // mapping === "standard" is the browser's own signal that it recognizes
    // this specific device as a real, standard-layout game controller —
    // prefer that over just grabbing whatever's in the first slot, or a
    // real controller sitting in slot 2+ next to some other device loses
    // silently (exactly what happened here: a HyperX headset in slot 0).
    for(let i = 0; i < pads.length; i++){
      if(pads[i] && pads[i].mapping === 'standard'){ gp = pads[i]; break; }
    }
    if(!gp){
      for(let i = 0; i < pads.length; i++){ if(pads[i]){ gp = pads[i]; break; } }
    }
  }

  if(gp){
    if(gp.id !== lastLoggedGamepadId){
      lastLoggedGamepadId = gp.id;
      console.log(`[input] reading gamepad: ${gp.id}`);
    }

    const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
    const dpadLeft = !!(gp.buttons[14] && gp.buttons[14].pressed);
    const dpadRight = !!(gp.buttons[15] && gp.buttons[15].pressed);
    const dpadUp = !!(gp.buttons[12] && gp.buttons[12].pressed);
    const dpadDown = !!(gp.buttons[13] && gp.buttons[13].pressed);

    gamepadKeys.left = ax < -GAMEPAD_DEADZONE || dpadLeft;
    gamepadKeys.right = ax > GAMEPAD_DEADZONE || dpadRight;
    gamepadKeys.up = ay < -GAMEPAD_DEADZONE || dpadUp;
    gamepadKeys.down = ay > GAMEPAD_DEADZONE || dpadDown;

    checkButtonEdge(gp, BTN_SPECIAL1, 'special1');
    checkButtonEdge(gp, BTN_SPECIAL2, 'special2');
  } else if(lastLoggedGamepadId !== null){
    lastLoggedGamepadId = null;
    gamepadKeys.up = gamepadKeys.down = gamepadKeys.left = gamepadKeys.right = false;
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
// Script tags load strictly sequentially over the network, and main.js
// loads after this file; normally that's harmless since this timer's first
// tick is 50ms out, well after the remaining scripts finish loading. But on
// a slow enough connection those extra fetches can occasionally take longer
// than that, so `state` may not exist yet on the very first tick or two —
// guard it the same way net.js already guards its own reference to
// main.js's onStateUpdate, rather than let a rare startup race throw.
setInterval(()=>{
  if(typeof state === 'undefined' || state !== 'game') return;
  sendInput(combinedKeys(), queuedAction);
  queuedAction = null;
}, 1000 / INPUT_HZ);
