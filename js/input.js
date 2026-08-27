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
//
// Fires directly off touchstart, not just `click` — these buttons are only
// ever visible on a touch device at all (the `@media (hover:hover) and
// (pointer:fine)` rule in style.css hides #controls entirely otherwise), so
// `click` here only ever exists as the browser's own synthesized
// touch-to-click event, not a real mouse click. That synthesis is exactly
// the kind of thing `html,body{touch-action:none}` (style.css, needed to
// stop the page itself panning/zooming under a drag) can suppress on some
// mobile browsers once a touchstart on the same element already called
// preventDefault() — reported live as "the ability buttons don't work on
// my phone." The movement stick never had this problem because it was
// already driven straight off touchstart/touchmove, never a synthesized
// click; same fix applied here. `click` stays too, harmless if it does
// fire (queuedAction is idempotent to set twice), and it's what actually
// drives these buttons for mouse-driven testing (devtools, this project's
// own browser-automation tooling) where no touchstart ever happens.
document.getElementById('btnSpecial1').addEventListener('click', ()=> queuedAction = 'special1');
document.getElementById('btnSpecial2').addEventListener('click', ()=> queuedAction = 'special2');
['btnSpecial1', 'btnSpecial2'].forEach((id, i)=>{
  const action = i === 0 ? 'special1' : 'special2';
  document.getElementById(id).addEventListener('touchstart', e=>{
    e.preventDefault();
    queuedAction = action;
  });
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

// ---------- GAMEPAD MENU NAVIGATION (2026-08-27, user request) ----------
// Everything above only ever matters while state === 'game' (see the send
// timer at the bottom of this file) — every screen around a run (login
// account pick, character roster, class/gender pick, dungeon select) and
// the mid-run boon-choice overlay were completely inert for a controller.
// One generic, position-based nav instead of per-screen wiring: it needs
// zero knowledge of any screen's specific layout, so it keeps working
// unmodified as screens change or new ones get added.
//
// Deliberately out of scope: typed text (the title screen's passphrase,
// the login PIN panel) stays mouse/keyboard/touch-only — an on-screen
// keyboard is a much bigger feature on its own.
const MENU_NAV_SELECTOR = '.class-card, .dungeon-card, .btn, .boon-card';
let gpFocusEl = null;
let lastMenuNavContainer = null;
const prevDirPressed = { up: false, down: false, left: false, right: false };
let prevMenuConfirmPressed = false;

// The one currently-visible thing worth navigating — the mid-run boon
// overlay takes priority (it can be up while state is still 'game'), else
// whichever `.screen` isn't hidden. Returns null if nothing qualifies (a
// screen transition mid-frame, or nothing shown yet).
function menuNavContainer(){
  const boonOverlay = document.getElementById('boonOverlay');
  if(boonOverlay && !boonOverlay.classList.contains('hidden')) return boonOverlay;
  const screens = document.querySelectorAll('.screen');
  for(const s of screens){ if(!s.classList.contains('hidden')) return s; }
  return null;
}
// `el.offsetParent !== null` is what lets this need zero per-screen
// bookkeeping — it's the standard cheap "is this actually rendered" check,
// so anything inside a currently-hidden sub-panel (character-creation's
// class-grid vs. gender-grid, only one ever shown at once; the login
// screen's name-grid vs. PIN panel) is automatically excluded without this
// code needing to know those sub-panels exist at all.
function menuNavCandidates(container){
  if(!container) return [];
  return [...container.querySelectorAll(MENU_NAV_SELECTOR)].filter(el=>{
    if(el.offsetParent === null) return false;
    // A `.btn` nested inside a card (e.g. a roster card's own Delete
    // button) isn't a separate top-level choice — the card itself already
    // is. Selecting a character shouldn't require navigating past, or
    // risk landing on and confirming, its own delete button.
    if(el.classList.contains('btn') && el.closest('.class-card, .dungeon-card, .boon-card')) return false;
    return true;
  });
}
// Reading order — top row first, then left-to-right within a row (a 10px
// band absorbs sub-pixel/rounding differences between cards that are
// visually "the same row").
function topLeftMostCandidate(candidates){
  return candidates.slice().sort((a, b)=>{
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    if(Math.abs(ra.top - rb.top) > 10) return ra.top - rb.top;
    return ra.left - rb.left;
  })[0] || null;
}
function setGpFocus(el){
  if(gpFocusEl) gpFocusEl.classList.remove('gp-focus');
  gpFocusEl = el;
  if(gpFocusEl) gpFocusEl.classList.add('gp-focus');
}
// Standard TV/console-UI spatial nav: score every other candidate by how
// far it is in the pressed direction, weighted against how far it drifts
// sideways from dead-on — not a fixed row/column assumption, so this one
// function handles the 2-column class-grid, the 1-column dungeon list, the
// gender-grid-plus-a-Back-button-below, and the boon overlay's 3-wide row
// without any of them needing to describe their own shape.
function spatialNext(current, candidates, dir){
  const cr = current.getBoundingClientRect();
  const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
  let best = null, bestScore = Infinity;
  for(const el of candidates){
    if(el === current) continue;
    const r = el.getBoundingClientRect();
    const ex = r.left + r.width / 2, ey = r.top + r.height / 2;
    const dx = ex - cx, dy = ey - cy;
    let primary, cross;
    if(dir === 'up'){ if(dy >= -4) continue; primary = -dy; cross = Math.abs(dx); }
    else if(dir === 'down'){ if(dy <= 4) continue; primary = dy; cross = Math.abs(dx); }
    else if(dir === 'left'){ if(dx >= -4) continue; primary = -dx; cross = Math.abs(dy); }
    else { if(dx <= 4) continue; primary = dx; cross = Math.abs(dy); }
    const score = primary + cross * 2; // weight lateral drift more — prefer a closely-aligned target over a diagonal one
    if(score < bestScore){ bestScore = score; best = el; }
  }
  return best;
}
// Edge-triggered, not held-repeat — one press moves one step. No
// auto-repeat delay to tune; these menus are small enough (5-8 items) that
// this isn't a real cost, and it sidesteps a whole class of repeat-timing
// bugs. Mirrors checkButtonEdge's own one-shot-per-press shape below.
function handleMenuNav(dpadUp, dpadDown, dpadLeft, dpadRight, ax, ay){
  const container = menuNavContainer();
  const candidates = menuNavCandidates(container);

  if(container !== lastMenuNavContainer){
    lastMenuNavContainer = container;
    setGpFocus(null); // never carry a stale focus ref into a freshly-shown screen/sub-panel
  }
  if(!candidates.length){ setGpFocus(null); return; }
  if(!gpFocusEl || !candidates.includes(gpFocusEl)) setGpFocus(topLeftMostCandidate(candidates));

  const pressed = {
    up: dpadUp || ay < -GAMEPAD_DEADZONE,
    down: dpadDown || ay > GAMEPAD_DEADZONE,
    left: dpadLeft || ax < -GAMEPAD_DEADZONE,
    right: dpadRight || ax > GAMEPAD_DEADZONE
  };
  ['up', 'down', 'left', 'right'].forEach(dir=>{
    if(pressed[dir] && !prevDirPressed[dir]){
      const next = spatialNext(gpFocusEl, candidates, dir);
      if(next) setGpFocus(next);
    }
    prevDirPressed[dir] = pressed[dir];
  });
}
function handleMenuConfirm(gp){
  const pressed = !!(gp.buttons[BTN_SPECIAL1] && gp.buttons[BTN_SPECIAL1].pressed);
  if(pressed && !prevMenuConfirmPressed && gpFocusEl) gpFocusEl.click();
  prevMenuConfirmPressed = pressed;
}

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

    // Menu nav (see above) takes over d-pad/stick/A whenever there's a menu
    // to navigate — every screen around a run, plus the boon overlay, which
    // can be up while state is still 'game'. Movement/specials are
    // deliberately zeroed out for that same window, not just left alone —
    // otherwise a held direction would keep walking the character in the
    // background while its owner thinks they're browsing a menu.
    const boonOverlay = document.getElementById('boonOverlay');
    const menuNavActive = (typeof state === 'undefined' || state !== 'game')
      || (boonOverlay && !boonOverlay.classList.contains('hidden'));

    if(menuNavActive){
      handleMenuNav(dpadUp, dpadDown, dpadLeft, dpadRight, ax, ay);
      handleMenuConfirm(gp);
      gamepadKeys.left = gamepadKeys.right = gamepadKeys.up = gamepadKeys.down = false;
    } else {
      gamepadKeys.left = ax < -GAMEPAD_DEADZONE || dpadLeft;
      gamepadKeys.right = ax > GAMEPAD_DEADZONE || dpadRight;
      gamepadKeys.up = ay < -GAMEPAD_DEADZONE || dpadUp;
      gamepadKeys.down = ay > GAMEPAD_DEADZONE || dpadDown;

      checkButtonEdge(gp, BTN_SPECIAL1, 'special1');
      checkButtonEdge(gp, BTN_SPECIAL2, 'special2');
      // Back in real gameplay — drop any leftover menu highlight/state so
      // the next menu screen shown starts fresh rather than reusing a
      // reference into whatever's now hidden.
      if(gpFocusEl){ setGpFocus(null); lastMenuNavContainer = null; }
    }
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
