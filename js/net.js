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

// Account identity (MASTER_DESIGN.md §8a) — remembered per-device so a
// logged-in kid isn't re-entering a PIN every session, only the first time
// on a given device or after an explicit "switch account". Unlike the old
// anonymous playerId, this is never generated client-side: it's only ever
// set to a value the server itself returned from a successful login
// (see sendLogin below), since the server is the sole authority on which
// 5 account ids actually exist.
const ACCOUNT_ID_KEY = 'camelot_account_id';
function getAccountId(){ return localStorage.getItem(ACCOUNT_ID_KEY); }
function setAccountId(id){ localStorage.setItem(ACCOUNT_ID_KEY, id); }
function clearAccountId(){ localStorage.removeItem(ACCOUNT_ID_KEY); }

// Small convenience so returning to a shared device doesn't mean retyping
// the passphrase either — same "remember it locally" idea as the account
// id above. Not a secret from anyone using the device itself; the point is
// keeping strangers off the public URL, not hiding it from the family.
const PASSPHRASE_KEY = 'camelot_passphrase';
function getSavedPassphrase(){ return localStorage.getItem(PASSPHRASE_KEY) || ''; }

let ws = null;
let myId = null;
let myClassKey = null; // this account's permanent class, once known (null until the account's first join)
let myIsTest = false;
let resuming = false; // did this connection reattach to an existing character?
let connStatus = "idle"; // "idle" | "connecting" | "open" | "closed"
let latestState = null; // last {type:"state", ...} payload received

// Doesn't connect until someone actually submits a passphrase (see main.js's
// title-screen handler) — the passphrase check happens during the WebSocket
// handshake itself (server/server.js's verifyClient), so there's no separate
// "connect, then authenticate" step; a wrong phrase just fails to open.
// Resolves true/false rather than throwing, so the caller can show an inline
// error instead of an uncaught rejection.
//
// Identity is a separate step layered on top of this connection, not part
// of it: if this device already has a remembered account id, it's sent
// straight away and this resolves once 'welcome' confirms it (same as the
// old anonymous-playerId flow). If not, this resolves as soon as the
// socket is open — the passphrase alone was enough to get this far — and
// the caller is expected to show the login screen and call sendLogin();
// 'welcome' (and this file's myId/myClassKey/resuming) arrives later, once
// that succeeds.
function attemptConnect(passphrase){
  return new Promise((resolve)=>{
    connStatus = "connecting";
    localStorage.setItem(PASSPHRASE_KEY, passphrase);
    const remembered = getAccountId();
    let url = `${SERVER_URL}?passphrase=${encodeURIComponent(passphrase)}`;
    if(remembered) url += `&playerId=${encodeURIComponent(remembered)}`;
    ws = new WebSocket(url);
    let settled = false;
    const settle = (ok)=>{ if(!settled){ settled = true; resolve(ok); } };

    const timeout = setTimeout(()=>{ ws.close(); settle(false); }, 8000);

    ws.addEventListener('open', () => {
      connStatus = "open";
      console.log('[net] connected to', SERVER_URL);
      if(!remembered){
        clearTimeout(timeout);
        settle(true); // no known identity yet — caller shows the login screen next
      }
      // else: wait for 'welcome' below, same as before
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
        myClassKey = msg.classKey || null;
        myIsTest = !!msg.isTest;
        console.log(`[net] welcome, id = ${myId}${resuming ? ' (resuming existing character)' : ''}`);
        clearTimeout(timeout);
        settle(true); // no-op if the 'open' fast-path above already settled this
        if(typeof onWelcome === 'function') onWelcome(msg);
      } else if(msg.type === 'loginResult'){
        if(msg.ok) setAccountId(msg.accountId);
        if(typeof onLoginResult === 'function') onLoginResult(msg);
      } else if(msg.type === 'muster'){
        if(typeof onMuster === 'function') onMuster(msg);
      } else if(msg.type === 'state'){
        latestState = msg;
        if(typeof onAudioState === 'function') onAudioState(msg);
        if(typeof onStateUpdate === 'function') onStateUpdate(msg);
      }
    });
  });
}

function sendLogin(username, pin){
  if(!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type: 'login', username, pin }));
  return true;
}

function sendReady(ready){
  if(!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type: 'ready', ready }));
  return true;
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
