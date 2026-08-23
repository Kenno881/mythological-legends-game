"use strict";

// Thin-client networking. Owns the one WebSocket connection, sends input on
// a timer (see input.js), and stores the latest state snapshot from the
// server for render.js to draw. No simulation happens here — movement,
// combat, and monster AI are all server-side; this file only relays input
// out and state in.

// Local dev talks to the server on this machine; anywhere else, the server
// now serves this very page (see server/server.js's static file handler),
// so the WebSocket lives at the same host — no hardcoded domain to keep in
// sync. No build step or env var, just a runtime check of what page loaded
// this script.
const LOCAL_SERVER_URL = "ws://localhost:3000";
// Matches the server's local-dev fallback port (process.env.PORT || 3000).
// To test from a second device on the LAN, temporarily point this at the
// server machine's LAN IP instead, e.g. "ws://192.168.1.23:3000".

const isLocalHost = ['localhost', '127.0.0.1', ''].includes(location.hostname);
const SERVER_URL = isLocalHost ? LOCAL_SERVER_URL : `wss://${location.host}`;
console.log(`[net] ${isLocalHost ? 'local' : 'production'} mode — connecting to ${SERVER_URL}`);

// A persistent identity for this browser, independent of any one WebSocket
// connection — reconnecting with the same ID (wifi drop, refresh, backgrounded
// tab) reattaches to the same character server-side instead of starting a
// fresh one. Not tied to the passphrase or any account; just "this browser".
const PLAYER_ID_KEY = 'camelot_player_id';
function getOrCreatePlayerId(){
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if(!id){
    id = (crypto.randomUUID && crypto.randomUUID()) || `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}
const PLAYER_ID = getOrCreatePlayerId();

let ws = null;
let myId = null;
let resuming = false; // did this connection reattach to an existing character?
let connStatus = "idle"; // "idle" | "connecting" | "open" | "closed"
let latestState = null; // last {type:"state", ...} payload received

// Doesn't connect until someone actually submits a passphrase (see main.js's
// title-screen handler) — the passphrase check happens during the WebSocket
// handshake itself (server/server.js's verifyClient), so there's no separate
// "connect, then authenticate" step; a wrong phrase just fails to open.
// Resolves true/false rather than throwing, so the caller can show an inline
// error instead of an uncaught rejection. Resolves on the 'welcome' message
// rather than 'open', so `resuming` is known by the time callers check it.
function attemptConnect(passphrase){
  return new Promise((resolve)=>{
    connStatus = "connecting";
    const url = `${SERVER_URL}?passphrase=${encodeURIComponent(passphrase)}&playerId=${encodeURIComponent(PLAYER_ID)}`;
    ws = new WebSocket(url);
    let settled = false;
    const settle = (ok)=>{ if(!settled){ settled = true; resolve(ok); } };

    const timeout = setTimeout(()=>{ ws.close(); settle(false); }, 8000);

    ws.addEventListener('open', () => {
      connStatus = "open";
      console.log('[net] connected to', SERVER_URL);
      // wait for 'welcome' below before settling — it carries `resuming`
    });

    ws.addEventListener('close', () => {
      connStatus = "closed";
      clearTimeout(timeout);
      console.log('[net] disconnected');
      settle(false);
    });

    ws.addEventListener('error', (e) => {
      console.error('[net] socket error', e.message || e);
      // 'close' fires right after a failed handshake and settles the promise
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if(msg.type === 'welcome'){
        myId = msg.id;
        resuming = !!msg.resuming;
        console.log(`[net] welcome, id = ${myId}${resuming ? ' (resuming existing character)' : ''}`);
        clearTimeout(timeout);
        settle(true);
      } else if(msg.type === 'state'){
        latestState = msg;
        if(typeof onAudioState === 'function') onAudioState(msg);
        if(typeof onStateUpdate === 'function') onStateUpdate(msg);
      }
    });
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
