"use strict";

// Thin-client networking. Owns the one WebSocket connection, sends input on
// a timer (see input.js), and stores the latest state snapshot from the
// server for render.js to draw. No simulation happens here — movement,
// combat, and monster AI are all server-side; this file only relays input
// out and state in.

// Local dev talks to the server on this machine; anything else — the
// deployed site, or the HTML opened straight from disk via file:// — talks
// to the deployed Railway server. No build step or env var, just a runtime
// check of what page loaded this script.
const LOCAL_SERVER_URL = "ws://localhost:3000";
// Matches the server's local-dev fallback port (process.env.PORT || 3000).
// To test from a second device on the LAN, temporarily point this at the
// server machine's LAN IP instead, e.g. "ws://192.168.1.23:3000".

const PRODUCTION_SERVER_URL = "wss://mythological-legends-game-production.up.railway.app";

const isLocalHost = ['localhost', '127.0.0.1', ''].includes(location.hostname);
const SERVER_URL = isLocalHost ? LOCAL_SERVER_URL : PRODUCTION_SERVER_URL;
console.log(`[net] ${isLocalHost ? 'local' : 'production'} mode — connecting to ${SERVER_URL}`);

let ws = null;
let myId = null;
let connStatus = "connecting"; // "connecting" | "open" | "closed"
let latestState = null;        // last {type:"state", ...} payload received

function connect(){
  connStatus = "connecting";
  ws = new WebSocket(SERVER_URL);

  ws.addEventListener('open', () => {
    connStatus = "open";
    console.log('[net] connected to', SERVER_URL);
  });

  ws.addEventListener('close', () => {
    connStatus = "closed";
    console.log('[net] disconnected');
  });

  ws.addEventListener('error', (e) => {
    console.error('[net] socket error', e.message || e);
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if(msg.type === 'welcome'){
      myId = msg.id;
      console.log('[net] welcome, id =', myId);
    } else if(msg.type === 'state'){
      latestState = msg;
      if(typeof onStateUpdate === 'function') onStateUpdate(msg);
    }
  });
}

function sendJoin(classKey){
  if(!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type: 'join', classKey }));
  return true;
}

function sendInput(keys, action){
  if(!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'input', keys, action }));
}

function myPlayer(){
  if(!latestState || !myId) return null;
  return latestState.players.find(p => p.id === myId) || null;
}

connect();
