// Client: Netzwerk + Zeitabgleich, Bedienung (Maus, Touch, Fernbedienung), HUD und die beiden Darstellungen.
import { PaperWorld } from './paper.js';
import * as sfx from './sfx.js';

const G = window.Game;
const { FLEET, SIZE } = G;
const COLS = 'ABCDEFGHIJ';
const EMOTES = ['😂', '😱', '🔥', '😎', '💀', '👋'];
// gleiche Reihenfolge wie die 3D-Welt (HitYear-Palette)
const PLAYER_COLORS = ['#ff3d9a', '#3dd8ff', '#ffd93d', '#3dffb0'];
const TV_IDLE_DEMO_MS = 5 * 60_000; // leere TV-Lobby → Demo als Bildschirmschoner (wie HitYear)
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const touchUI = matchMedia('(pointer: coarse)').matches;
const cellName = (x, y) => `${COLS[x]}${y + 1}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privat */ } },
};
// sessionStorage: jeder Tab ist ein eigener Spieler (praktisch zum Testen)
const session = {
  get() { try { return JSON.parse(sessionStorage.getItem('sv-session')); } catch { return null; } },
  set(v) { try { sessionStorage.setItem('sv-session', JSON.stringify(v)); } catch { /* privat */ } },
  clear() { try { sessionStorage.removeItem('sv-session'); } catch { /* privat */ } },
};

// ------------------------------------------------------------------ Zustand

let S = null;            // letzter Server-Zustand
let me = null;           // eigener Spieler (null für Zuschauer)
let shotKey = null;
let lastTurnId = null;
let viewId = null;
let viewManual = false;
let overview = false;
let firing = false;
let touchAim = null;     // { target, x, y } – erst zielen, dann feuern
let remoteAim = null;
let lastAimSent = 0;
let resultReadyAt = 0;
let resultCollapsed = false;
let interactiveKey = '';
let countdownShown = null;
let tvIdleSince = Date.now();
let level = store.get('sv-level', 'mittel');
let theme = store.get('sv-theme', '3d');
let quality = store.get('sv-quality', touchUI ? 'normal' : 'erweitert');
const logEntries = [];
const place = { placements: FLEET.map(() => null), selected: 0, dir: 'h', hover: null };
const params = new URLSearchParams(location.search);
let invite = params.get('k');

// ------------------------------------------------------------------ Darstellungen (3D / Papier)

const handlers = { onHover, onClick, onContext: rotate };
let world3d = null;
let world3dFailed = false;
let paperWorld = null;
let R = null; // aktive Darstellung

async function ensure3d() {
  if (world3d || world3dFailed) return world3d;
  try {
    const { World } = await import('./scene.js');
    world3d = new World($('#scene'), handlers, quality);
  } catch (err) {
    console.warn('3D nicht verfügbar, nutze Papier', err);
    world3dFailed = true;
    $('#scene').style.display = 'none';
  }
  return world3d;
}

function ensurePaper() {
  if (!paperWorld) paperWorld = new PaperWorld($('#paper'), handlers);
  return paperWorld;
}

/** Handys im TV-Modus sind Controller: immer Papier (leicht, präzise zu tippen). */
const wantedTheme = () => (S?.controller ? 'paper' : theme);

async function applyTheme() {
  let want = wantedTheme();
  if (want === '3d' && !(await ensure3d())) {
    want = 'paper';
    if (theme === '3d') toast('3D geht auf diesem Gerät nicht – Papier-Ansicht aktiv.');
  }
  const next = want === '3d' ? world3d : ensurePaper();
  if (next !== R) {
    if (R) R.pause();
    R = next;
    R.resume();
    interactiveKey = '';
  }
  document.body.classList.toggle('theme-paper', want === 'paper');
  $('#paper').hidden = want !== 'paper';
  render();
}

// ------------------------------------------------------------------ Netzwerk & Zeitabgleich

let ws = null;
let retry = 400;
const queue = [];
let clockOffset = 0;     // Serveruhr − lokale Uhr
let lastPong = Date.now();
const timePings = new Map();
const serverNow = () => Date.now() + clockOffset;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 400;
    lastPong = Date.now();
    $('#conn').hidden = true;
    syncClock();
    const s = session.get();
    if (s) ws.send(JSON.stringify({ t: 'resume', code: s.code, token: s.token }));
    for (const m of queue.splice(0)) ws.send(JSON.stringify(m));
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    handle(m);
  };
  ws.onclose = () => {
    if (S) $('#conn').hidden = false;
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 6000);
  };
}

function send(m) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  else queue.push(m);
}

/** 1) Uhrabgleich wie HitYear: 5 Messungen, die mit der kürzesten Laufzeit zählt. */
async function syncClock() {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    if (!ws || ws.readyState !== 1) return;
    const id = Math.random().toString(36).slice(2);
    const t0 = performance.now();
    const t0wall = Date.now();
    const server = await new Promise((resolve) => {
      timePings.set(id, resolve);
      ws.send(JSON.stringify({ t: 'time', id }));
      setTimeout(() => { timePings.delete(id); resolve(null); }, 2000);
    });
    const rtt = performance.now() - t0;
    if (typeof server === 'number') samples.push({ rtt, offset: server - (t0wall + rtt / 2) });
  }
  samples.sort((a, b) => a.rtt - b.rtt);
  if (samples.length) clockOffset = samples[0].offset;
}
setInterval(syncClock, 60_000);

/** 2) Stand-Abgleich: alle 5 s eigenen Stand melden – Verpasstes kommt sofort, ausbleibende Antwort = neu verbinden. */
setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  if (Date.now() - lastPong > 12_000) {
    try { ws.close(); } catch { /* egal */ }
    return;
  }
  ws.send(JSON.stringify({ t: 'sync', seq: S ? S.seq : -1 }));
}, 5000);
document.addEventListener('visibilitychange', () => {
  // Handy wacht auf: sofort abgleichen statt bis zu 5 s zu warten
  if (!document.hidden && ws?.readyState === 1) {
    ws.send(JSON.stringify({ t: 'sync', seq: S ? S.seq : -1 }));
    syncClock();
  }
  renderTurnBanner();
});

function handle(m) {
  switch (m.t) {
    case 'state': return onState(m);
    case 'time': {
      const r = timePings.get(m.id);
      if (r) { timePings.delete(m.id); r(m.now); }
      return;
    }
    case 'pong':
      lastPong = Date.now();
      return;
    case 'error':
      firing = false;
      if (!m.quiet) {
        vibrate(30);
        toast(m.msg, 'error');
      }
      renderFireButton();
      return;
    case 'notice': return toast(m.msg);
    case 'aim': return onAim(m);
    case 'emote': return onEmote(m);
    case 'resume-failed':
      session.clear();
      S = null;
      me = null;
      return applyTheme();
    case 'kicked':
    case 'closed':
    case 'left':
      if (m.msg) toast(m.msg);
      session.clear();
      S = null;
      me = null;
      invite = null;
      history.replaceState(null, '', location.pathname);
      return applyTheme();
    default:
  }
}

const playerById = (id, st = S) => st?.players.find((p) => p.id === id);
const myTurn = () => !!(S && me && S.phase === 'playing' && S.turnId === me.id);
const canFireNow = () => myTurn() && serverNow() >= (S.readyAt || 0) - 50;
const opponents = () => (S ? S.players.filter((p) => p !== me) : []);

function onState(m) {
  lastPong = Date.now();
  const prev = S;
  if (prev && prev.code === m.code && m.seq < prev.seq) return; // veralteter Stand
  S = m;
  session.set({ code: m.code, token: m.token });
  const url = new URL(location.href);
  if (url.searchParams.get('room') !== m.code || url.searchParams.has('k')) {
    url.searchParams.set('room', m.code);
    url.searchParams.delete('k');
    history.replaceState(null, '', url);
  }
  me = playerById(m.you) || null;
  firing = false;

  const sameRoom = prev && prev.code === m.code;
  if (!sameRoom || prev.round !== m.round) {
    viewManual = false;
    overview = false;
    resultCollapsed = false;
    touchAim = null;
    remoteAim = null;
    logEntries.length = 0;
    renderLog();
  }
  if (m.phase === 'placing' && (!sameRoom || prev.phase !== 'placing' || prev.round !== m.round)) resetPlacement();
  if (m.phase === 'lobby') tvIdleSince = Date.now();

  // Themenwechsel nötig (z. B. Handy wird Controller)?
  const themeChange = (prev?.controller ?? null) !== m.controller;

  // Neuer Schuss → Animation bis zum gemeinsamen Einschlagzeitpunkt (vor dem Rendern, Feld bleibt bis dahin verdeckt)
  const ls = m.lastShot;
  const key = ls ? `${m.code}:${m.round}:${ls.seq}` : null;
  if (key && key !== shotKey && sameRoom && !themeChange) animateShot(ls, m);
  shotKey = key;

  if (m.turnId !== lastTurnId) {
    lastTurnId = m.turnId;
    remoteAim = null;
    touchAim = null;
    viewManual = false;
    R?.setRemoteAim(null);
    if (myTurn() && sameRoom && m.lastShot) {
      // Glocke erst nach dem Einschlag
      setTimeout(() => { if (myTurn()) { sfx.play('turn'); vibrate(25); } }, Math.max(0, (m.readyAt || 0) - serverNow()));
    }
  }
  if (m.phase === 'over' && sameRoom && prev.phase !== 'over') onGameOver(m);
  else if (m.phase === 'over' && !sameRoom) resultReadyAt = 0;
  if (themeChange || !R) applyTheme();
  else render();
}

function onAim(m) {
  if (!S || (me && m.by === me.id)) return;
  remoteAim = m.target ? m : null;
  R?.setRemoteAim(m.target, m.x, m.y, playerById(m.by)?.color);
  updateFocus();
  renderTurnBanner();
}

function onEmote(m) {
  const e = EMOTES[m.e];
  if (!e) return;
  const host = document.querySelector(`.pcard[data-id="${m.by}"]`) || $('#turn-banner');
  const b = document.createElement('span');
  b.className = 'bubble';
  b.textContent = e;
  host.appendChild(b);
  setTimeout(() => b.remove(), 2300);
}

// ------------------------------------------------------------------ Schüsse & Ende

function animateShot(ls, st) {
  if (!R) return;
  const mine = me && ls.by === me.id;
  const atMe = me && ls.target === me.id;
  // 4) gemeinsamer Einschlag: Flugzeit = Zeit bis impactAt (Serveruhr)
  const duration = clamp((ls.impactAt || 0) - serverNow(), 200, 2500);
  sfx.play('fire');
  R.fireShot({ by: ls.by, target: ls.target, x: ls.x, y: ls.y, result: ls.result, duration }).then(() => {
    if (ls.result === 'miss') {
      sfx.play('splash');
      if (mine) pop('Wasser …', 'miss');
    } else if (ls.result === 'hit') {
      sfx.play('hit');
      pop(atMe ? 'Autsch!' : 'Treffer!', 'hit');
      vibrate(atMe ? [60, 40, 60] : 40);
    } else {
      sfx.play('sunk');
      pop(mine ? `${ls.ship} versenkt!` : atMe ? `${ls.ship} verloren!` : 'Versenkt!', 'sunk');
      vibrate([90, 50, 160]);
    }
    addLog(ls, st);
    renderFireButton();
  });
}

function onGameOver(m) {
  // Der Server schickt das Ergebnis erst nach dem letzten Einschlag – für alle gleichzeitig
  resultReadyAt = Date.now() + 1400;
  setTimeout(render, 1450);
  const won = me && m.winnerId === me.id;
  sfx.play(!me || won ? 'win' : 'lose');
  if (me) pop(won ? 'Sieg!' : 'Versenkt …', won ? 'win' : 'sunk');
  vibrate(won ? [40, 60, 40, 60, 120] : 200);
}

function addLog(ls, st) {
  const by = playerById(ls.by, st), target = playerById(ls.target, st);
  if (!by || !target) return;
  const name = (p) => `<b style="--c:${PLAYER_COLORS[p.color]}">${esc(me && p.id === me.id ? 'Du' : p.name)}</b>`;
  const what = ls.result === 'miss' ? 'Wasser 💦' : ls.result === 'hit' ? 'Treffer! 💥' : `${esc(ls.ship)} versenkt! ☠️`;
  let html = `${name(by)} → ${cellName(ls.x, ls.y)}: ${what}`;
  if (ls.auto) html += ' <small>(Autopilot)</small>';
  if (ls.eliminated) html += `<br>${name(target)}: ganze Flotte versenkt!`;
  logEntries.push(html);
  if (logEntries.length > 6) logEntries.shift();
  renderLog();
}

function renderLog() {
  $('#log').innerHTML = logEntries.map((h) => `<li>${h}</li>`).join('');
}

// ------------------------------------------------------------------ Platzieren

function resetPlacement() {
  place.placements = FLEET.map(() => null);
  place.selected = 0;
  place.dir = 'h';
  place.hover = null;
}

const canPlaceNow = () => !!(S && me && S.phase === 'placing' && !me.ready);
const nextUnplaced = (from) => {
  for (let k = 1; k <= FLEET.length; k++) {
    const i = (from + k) % FLEET.length;
    if (!place.placements[i]) return i;
  }
  return null;
};

function ghostFor(cell, dir = place.dir) {
  const i = place.selected;
  if (i == null || !cell) return null;
  const len = FLEET[i].len;
  const off = Math.floor((len - 1) / 2);
  const p = {
    x: clamp(dir === 'h' ? cell.x - off : cell.x, 0, dir === 'h' ? SIZE - len : SIZE - 1),
    y: clamp(dir === 'v' ? cell.y - off : cell.y, 0, dir === 'v' ? SIZE - len : SIZE - 1),
    dir,
  };
  return { p, ok: G.canPlace(G.buildGrid(place.placements), p, len, i) };
}

function updateGhost() {
  if (!R) return;
  const g = canPlaceNow() && ghostFor(place.hover);
  if (!g) return R.setGhost(null);
  const f = FLEET[place.selected];
  R.setGhost({ boardId: me.id, name: f.name, len: f.len, dir: g.p.dir, x: g.p.x, y: g.p.y, ok: g.ok });
}

function select(i) {
  place.selected = i;
  if (place.placements[i]) place.dir = place.placements[i].dir;
  renderPlace();
  updateGhost();
}

function rotate() {
  if (!canPlaceNow()) return;
  const i = place.selected;
  const cur = i != null && place.placements[i];
  const dir = place.dir === 'h' ? 'v' : 'h';
  if (cur && !place.hover) {
    // ohne Maus über dem Feld (Touch): das gewählte Schiff an Ort und Stelle drehen
    const p = { x: cur.x, y: cur.y, dir };
    if (!G.canPlace(G.buildGrid(place.placements), p, FLEET[i].len, i)) {
      toast('Zum Drehen ist dort kein Platz.', 'error');
      vibrate(30);
      return;
    }
    place.placements[i] = p;
    sfx.play('place');
    renderBoards();
  }
  place.dir = dir;
  renderPlace();
  updateGhost();
}

function placeClick(cell, pointerType) {
  const grid = G.buildGrid(place.placements);
  const occ = grid[cell.y * SIZE + cell.x];
  if (occ >= 0 && occ !== place.selected) {
    select(occ);
    sfx.play('place', { volume: 0.5 });
    return;
  }
  if (occ >= 0 && occ === place.selected && pointerType !== 'mouse') {
    place.hover = null; // erneutes Antippen des gewählten Schiffs dreht es
    rotate();
    return;
  }
  if (place.selected == null) return;
  const g = ghostFor(cell);
  if (!g.ok) {
    toast('Passt da nicht – Schiffe dürfen sich nicht berühren.', 'error');
    vibrate(30);
    return;
  }
  place.placements[place.selected] = g.p;
  sfx.play('place');
  vibrate(12);
  place.selected = nextUnplaced(place.selected);
  if (pointerType !== 'mouse') place.hover = null;
  renderPlace();
  renderBoards();
  updateGhost();
}

function localShips() {
  return place.placements.map((p, i) => p && {
    name: FLEET[i].name, len: FLEET[i].len, dir: p.dir, cells: G.cellsOf(p, FLEET[i].len), sunk: false,
  }).filter(Boolean);
}

// ------------------------------------------------------------------ Eingaben aus der Darstellung

function onHover(boardId, cell) {
  if (canPlaceNow()) {
    place.hover = cell;
    updateGhost();
    return;
  }
  if (myTurn() && cell && !touchAim) sendAim(boardId, cell);
}

function sendAim(target, cell) {
  const now = performance.now();
  if (now - lastAimSent < 60) return;
  lastAimSent = now;
  send({ t: 'aim', target, x: cell.x, y: cell.y });
}

function onClick(boardId, cell, pointerType) {
  sfx.unlock();
  if (canPlaceNow()) return placeClick(cell, pointerType);
  if (!myTurn() || firing) return;
  if (R.boards.get(boardId)?.blocked.has(G.key(cell.x, cell.y))) return;
  if (pointerType === 'mouse') {
    if (!canFireNow()) return toast('Moment – die letzte Granate fliegt noch.');
    return fire({ target: boardId, x: cell.x, y: cell.y });
  }
  // Touch: erst zielen, dann (zweites Tippen oder Knopf) feuern
  if (touchAim && touchAim.target === boardId && touchAim.x === cell.x && touchAim.y === cell.y && canFireNow()) return fire(touchAim);
  touchAim = { target: boardId, x: cell.x, y: cell.y };
  lastAimSent = 0;
  sendAim(boardId, cell);
  vibrate(8);
  renderFireButton();
}

function fire(t) {
  firing = true;
  touchAim = null;
  renderFireButton();
  send({ t: 'fire', target: t.target, x: t.x, y: t.y });
}

// ------------------------------------------------------------------ Rendering

function screenName() {
  if (!S) return 'home';
  if (S.phase === 'lobby') {
    if (S.mode === 'tv') return S.spectator ? 'tv' : 'pad';
    return 'lobby';
  }
  if (S.phase === 'placing') return S.spectator ? 'battle' : 'place';
  if (S.phase === 'playing') return 'battle';
  return 'over';
}

function render() {
  const screen = screenName();
  for (const id of ['home', 'lobby', 'tv', 'pad', 'place', 'battle', 'over']) $(`#screen-${id}`).hidden = id !== screen;
  if (screen !== 'over') document.body.classList.remove('result-open');
  if (screen === 'over') $('#screen-battle').hidden = false;

  $('#room-chip').hidden = !(S && (S.mode === 'pvp' || S.mode === 'tv') && !S.demo);
  if (S) $('#room-code').textContent = S.code;
  $('#btn-leave').hidden = !S;
  $('#btn-view').hidden = !(screen === 'battle' || screen === 'over') || !!S?.controller || isTvView();
  renderSettings();

  document.body.classList.toggle('tv-view', isTvView());
  if (R) R.setMode(!S || S.phase === 'lobby' ? 'menu' : 'game');
  renderBoards();
  if (screen === 'home') renderHome();
  if (screen === 'lobby') renderLobby();
  if (screen === 'tv') renderTv();
  if (screen === 'pad') renderPad();
  if (screen === 'place') renderPlace();
  if (screen === 'battle' || screen === 'over') renderBattle();
  if (screen === 'over') renderOver();
  $('#qr-klein').hidden = !(S && S.mode === 'tv' && S.spectator && S.demo);
  if (S && (screen === 'lobby' || screen === 'tv' || !$('#qr-klein').hidden)) loadQr();
  updateInteractive();
  updateGhost();
  updateFocus();
  requestAnimationFrame(updateInsets);
}

function renderSettings() {
  for (const b of $$('#set-theme button')) b.setAttribute('aria-checked', String(b.dataset.v === theme));
  for (const b of $$('#set-quality button')) b.setAttribute('aria-checked', String(b.dataset.v === quality));
  for (const b of $$('#set-sound button')) b.setAttribute('aria-checked', String((b.dataset.v === 'off') === sfx.isMuted()));
  $('#row-quality').hidden = theme !== '3d';
}

function renderBoards() {
  if (!R) return;
  if (!S || S.phase === 'lobby') {
    R.setBoards([], '');
    return;
  }
  const order = me ? [me, ...opponents()] : S.players;
  R.setBoards(order.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    isMe: p === me,
    isTurn: S.turnId === p.id,
    eliminated: p.eliminated,
    connected: p.connected,
    bot: p.bot,
    winner: S.phase === 'over' && S.winnerId === p.id,
    board: p.board,
    ships: p === me && canPlaceNow() ? localShips() : undefined,
  })), `${S.code}:${S.round}`);
}

// ------------------------------------------------------------------ Bestenliste

const MEDALS = ['🥇', '🥈', '🥉'];
let bestCache = { at: 0, top: [] };

function bestListHtml(list, highlight = [], compact = false) {
  const mine = new Set(highlight.map((n) => n.trim().toLowerCase()));
  return list.map((e) => `<li class="${mine.has(e.name.trim().toLowerCase()) ? 'ich' : ''}">
    <span class="platz">${MEDALS[e.rank - 1] || `${e.rank}.`}</span>
    <span class="wer"><b>${esc(e.name)}</b><small>${e.wins} ${e.wins === 1 ? 'Sieg' : 'Siege'}${compact ? '' : ` · ${e.games} ${e.games === 1 ? 'Spiel' : 'Spiele'}`} · ${e.accuracy} % Treffer</small></span>
    <span class="pkt">${e.points}<small>P</small></span></li>`).join('');
}

async function loadBest(force = false) {
  if (!force && Date.now() - bestCache.at < 20_000) return bestCache.top;
  try {
    const res = await fetch('/api/bestenliste?n=10');
    bestCache = { at: Date.now(), top: (await res.json()).top };
  } catch { /* offline: alte Liste behalten */ }
  return bestCache.top;
}

async function renderBestLists() {
  const top = await loadBest();
  const myName = store.get('sv-name', '');
  $('#best-home').innerHTML = bestListHtml(top, myName ? [myName] : []);
  $('#best-home-empty').hidden = top.length > 0;
  $('#best-tv').innerHTML = bestListHtml(top.slice(0, 5), [], true);
  $('#best-tv-empty').hidden = top.length > 0;
}

function renderHome() {
  renderBestLists();
  const input = $('#in-name');
  if (!input.value) input.value = store.get('sv-name', '');
  for (const b of $$('#level button, #tv-level button')) b.setAttribute('aria-checked', String(b.dataset.level === level));
  const code = params.get('room');
  if (code && !$('#in-code').value) $('#in-code').value = code.replace(/\D/g, '').slice(0, 4);
}

let qrFor = null;
async function loadQr() {
  if (!S || qrFor === S.code) return;
  qrFor = S.code;
  for (const el of $$('[data-code]')) el.textContent = S.code;
  try {
    const res = await fetch(`/api/join?room=${S.code}`);
    if (!res.ok) throw new Error();
    const { svg, display } = await res.json();
    for (const el of $$('[data-qr]')) el.innerHTML = svg;
    for (const el of $$('[data-url]')) el.textContent = display;
  } catch {
    qrFor = null;
  }
}

function renderLobby() {
  for (const el of $$('[data-code]')) el.textContent = S.code;
}

function avatarFor(p) {
  return p.bot ? '🤖' : esc(p.name.slice(0, 1).toUpperCase());
}

function renderTv() {
  renderBestLists();
  const slots = [];
  for (let i = 0; i < G.MAX_PLAYERS; i++) {
    const p = S.players[i];
    if (p) {
      slots.push(`<div class="tv-slot" style="--pc:${PLAYER_COLORS[p.color]}">
        <span class="avatar">${avatarFor(p)}</span><span>${esc(p.name)}</span>
        ${p.connected ? '' : '<small class="leise">📡 offline</small>'}
        <button type="button" class="kick" data-kick="${p.id}" aria-label="${esc(p.name)} entfernen" title="Entfernen">✕</button></div>`);
    } else {
      slots.push(`<div class="tv-slot leer"><span class="avatar">+</span><span>${i === 1 && S.players.length === 1 ? 'Platz frei – sonst spielt ein Bot' : 'Platz frei – QR-Code scannen'}</span></div>`);
    }
  }
  $('#tv-slots').innerHTML = slots.join('');
  for (const b of $$('#tv-level button')) b.setAttribute('aria-checked', String(b.dataset.level === level));
  const n = S.players.length;
  const btn = $('#btn-tv-start');
  btn.disabled = n === 0;
  btn.textContent = n === 0 ? 'Warte auf Handys …' : n === 1 ? 'Gegen Bot starten 🤖' : 'Spiel starten ✨';
}

function renderPad() {
  const av = $('#pad-avatar');
  if (me) {
    av.style.setProperty('--pc', PLAYER_COLORS[me.color]);
    av.textContent = avatarFor(me);
  }
}

function renderPlace() {
  if (!S || !me) return;
  const ready = me.ready;
  $('#ship-chips').innerHTML = FLEET.map((f, i) => {
    const cls = ['ship-chip', place.placements[i] ? 'placed' : '', i === place.selected && !ready ? 'selected' : ''].join(' ');
    return `<button type="button" class="${cls}" data-i="${i}" ${ready ? 'disabled' : ''}>
      <span class="name">${esc(f.name)}</span><span class="pips">${'<i></i>'.repeat(f.len)}</span></button>`;
  }).join('');
  const all = place.placements.every(Boolean);
  const btn = $('#btn-ready');
  btn.textContent = ready ? '✏️ Ändern' : 'Bereit!';
  btn.disabled = !ready && !all;
  $('#btn-rotate').hidden = ready;
  $('#btn-random').hidden = ready;
  const opp = opponents()[0];
  $('#place-sub').innerHTML = ready
    ? `Warte auf ${esc(opp?.name || 'den Gegner')} …`
    : touchUI
      ? 'Schiff wählen, aufs Feld tippen. Nochmal tippen dreht.'
      : 'Wähle ein Schiff und klicke aufs Feld. <kbd>R</kbd> oder Rechtsklick dreht.';
  $('#opp-status').textContent = !opp ? ''
    : opp.ready ? `✅ ${opp.bot ? '🤖 ' : ''}${opp.name} ist bereit!` : `⏳ ${opp.name} platziert noch …`;
}

function renderBattle() {
  renderTurnBanner();
  const order = me ? [me, ...opponents()] : S.players;
  const focus = currentFocus();
  $('#fleet-cards').innerHTML = order.map((p) => {
    const sunk = new Set(p.board.sunk.map((s) => s.name));
    const cls = ['pcard', focus === p.id ? 'viewing' : '', S.turnId === p.id ? 'turn' : '', p.eliminated ? 'dead' : ''].join(' ');
    const status = p.eliminated ? '💀 Flotte versenkt' : !p.connected ? '📡 offline – Autopilot'
      : S.phase === 'placing' ? (p.ready ? 'bereit' : 'platziert …') : `${p.board.afloat} von 5 Schiffen`;
    return `<button type="button" class="${cls}" data-id="${p.id}" style="--pc:${PLAYER_COLORS[p.color]}">
      <div class="pcard-head">
        <span class="pcard-dot">${avatarFor(p)}</span>
        <span class="pcard-name">${esc(p.name)}${p === me ? ' (Du)' : ''}</span>
        <span class="pcard-wins" title="Siege">🏆 ${p.wins}</span>
      </div>
      <div class="pcard-fleet">${FLEET.map((f) => `<span class="${sunk.has(f.name) ? 'sunk' : ''}" title="${esc(f.name)}">${'<i></i>'.repeat(f.len)}</span>`).join('')}</div>
      <div class="pcard-sub">${status}${p.bot ? ` · Bot (${p.bot})` : ''}</div>
    </button>`;
  }).join('');
  renderFireButton();
}

function renderTurnBanner() {
  if (!S) return;
  const banner = $('#turn-banner');
  const title = $('#turn-title'), sub = $('#turn-sub');
  banner.classList.toggle('mine', myTurn());
  $('#timer').hidden = S.phase !== 'playing' || !S.turnId;
  if (S.demo && S.mode === 'tv') {
    title.textContent = '🍿 Demo läuft';
    sub.textContent = 'Handy verbinden: QR-Code scannen oder Code eingeben';
  } else if (S.phase === 'placing') {
    title.textContent = 'Flotten werden platziert …';
    sub.textContent = S.players.map((p) => `${p.name} ${p.ready ? '✅' : '⏳'}`).join('  ·  ');
  } else if (S.phase === 'over') {
    const w = playerById(S.winnerId);
    title.textContent = w ? (me && w === me ? 'Du hast gewonnen! 🎉' : `${w.name} gewinnt!`) : 'Spiel vorbei';
    sub.textContent = S.demo ? 'Neue Runde gleich …' : 'Felder ansehen oder nochmal spielen';
  } else if (!S.turnId) {
    title.textContent = 'Letzter Schuss …';
    sub.textContent = '';
  } else if (myTurn()) {
    title.textContent = 'Du bist dran! 🎯';
    sub.textContent = !canFireNow() ? 'Granate unterwegs …'
      : touchAim ? `Ziel ${cellName(touchAim.x, touchAim.y)} – nochmal tippen zum Feuern`
        : touchUI ? 'Tippe aufs gegnerische Feld, um zu zielen' : 'Klicke aufs gegnerische Feld';
  } else {
    const p = playerById(S.turnId);
    title.textContent = p ? `${p.bot ? '🤖 ' : ''}${p.name} ist dran` : '…';
    sub.textContent = remoteAim ? `zielt auf ${cellName(remoteAim.x, remoteAim.y)} …` : 'überlegt …';
  }
  document.title = myTurn() && document.hidden ? '🔴 Du bist dran! · Schiffe versenken' : 'Schiffe versenken';
}

function renderFireButton() {
  const btn = $('#btn-fire');
  const show = !!(touchAim && myTurn() && !firing);
  btn.hidden = !show;
  if (show) {
    btn.disabled = !canFireNow();
    btn.textContent = `🔥 Feuer auf ${cellName(touchAim.x, touchAim.y)}!`;
  }
  renderTurnBanner();
}

function renderOver() {
  const ready = Date.now() >= resultReadyAt;
  const winner = playerById(S.winnerId);
  const won = me && winner === me;
  $('#over-icon').textContent = !me || won ? '🏆' : '🌊';
  $('#over-title').textContent = !me ? `${winner?.name || 'Niemand'} gewinnt!` : won ? 'Gewonnen!' : 'Verloren …';
  $('#over-sub').textContent = !me ? 'Was für ein Gefecht!'
    : won ? 'Alle feindlichen Schiffe liegen auf dem Meeresgrund.' : `${winner?.name || 'Der Gegner'} war diesmal schneller.`;
  $('#scoreboard').innerHTML = S.players.map((p) => `<div class="score" style="--pc:${PLAYER_COLORS[p.color]}"><b>${p.wins}</b><span>${p.bot ? '🤖 ' : ''}${esc(p.name)}</span></div>`).join('');
  const again = $('#btn-again');
  const host = playerById(S.hostId);
  const mayAgain = S.mode === 'demo' || S.tvHost || (S.mode === 'tv' && me) || (me && S.hostId === me.id);
  again.disabled = !mayAgain;
  again.textContent = !mayAgain ? `Warte auf ${host ? host.name : 'den Gastgeber'} …`
    : S.demo ? '▶ Nächste Runde' : S.mode === 'bot' ? '⚔️ Revanche!' : 'Nochmal! ✨';
  $('#btn-home').textContent = S.tvHost ? 'Spiel beenden' : 'Hauptmenü';
  // Bestenliste: eigene Punkte + Platz, Top 5 mit den aktuellen Spielern hervorgehoben
  const res = S.results || {};
  const pts = $('#over-points');
  if (me && res[me.id]) {
    const r = res[me.id];
    pts.innerHTML = `<span class="verlaufstext">+${r.points} Punkte</span>${r.rank ? ` · Platz ${r.rank} in der Bestenliste` : ''}`;
    pts.hidden = false;
  } else if (!me && Object.keys(res).length) {
    pts.innerHTML = S.players.filter((p) => res[p.id]).map((p) => `${esc(p.name)}: <b>+${res[p.id].points}</b>${res[p.id].rank ? ` (Platz ${res[p.id].rank})` : ''}`).join(' · ');
    pts.hidden = false;
  } else pts.hidden = true;
  const lb = S.leaderboard || [];
  $('#best-over-box').hidden = !lb.length || !Object.keys(res).length;
  $('#best-over').innerHTML = bestListHtml(lb, S.players.filter((p) => !p.bot).map((p) => p.name), true);
  if (Object.keys(res).length) bestCache.at = 0; // Startseite holt die neue Liste
  $('#result-card').hidden = !ready || resultCollapsed;
  $('#btn-result').hidden = !ready || !resultCollapsed;
  document.body.classList.toggle('result-open', !$('#result-card').hidden);
}

// ------------------------------------------------------------------ Kamera & Interaktion

function defaultTarget() {
  const t = opponents().find((p) => !p.eliminated && p.ready);
  return t ? t.id : null;
}

const wideScreen = () => innerWidth > 900 && innerWidth > innerHeight;
/** Fernseher bzw. Zuschauer am großen Bildschirm: beide Felder zentriert nebeneinander. */
const isTvView = () => !!(S && S.spectator && S.phase !== 'lobby' && wideScreen());

function currentFocus() {
  if (!S || S.phase === 'lobby') return null;
  if (S.phase === 'placing') return S.spectator ? 'all' : me.id;
  if (overview) return 'all';
  if (viewManual && viewId) return viewId;
  if (isTvView()) return 'all'; // TV: immer beide Felder, das Live-Fadenkreuz zeigt, wohin gezielt wird
  if (S.phase === 'over') return wideScreen() ? 'all' : (me ? defaultTarget() : 'all');
  if (myTurn()) return touchAim?.target || defaultTarget();
  if (remoteAim?.target) return remoteAim.target;
  if (me) return me.id;
  return wideScreen() ? 'all' : (S.lastShot?.target || 'all');
}

function updateFocus() {
  const f = currentFocus();
  R?.setFocus(f);
  for (const c of $$('.pcard')) c.classList.toggle('viewing', c.dataset.id === f);
}

function updateInteractive() {
  if (!R) return;
  let opts = null;
  if (canPlaceNow()) opts = { id: me.id, mode: 'place', color: me.color };
  else if (myTurn()) {
    const f = currentFocus();
    const target = f && f !== 'all' && f !== me.id ? f : defaultTarget();
    if (target) opts = { id: target, mode: 'fire', color: me.color };
  }
  const key = opts ? `${opts.id}:${opts.mode}` : '';
  if (key !== interactiveKey) {
    interactiveKey = key;
    R.setInteractive(opts);
  }
}

/** Freie Fläche zwischen den HUD-Elementen messen, damit das Feld genau dort hineinpasst. */
function updateInsets() {
  if (!R) return;
  const h = innerHeight, w = innerWidth;
  const r = (sel) => {
    const el = $(sel);
    if (!el || el.closest('[hidden]')) return null;
    const b = el.getBoundingClientRect();
    return b.width || b.height ? b : null;
  };
  const insets = { top: 64, bottom: 12, left: 0, right: 0 };
  const screen = screenName();
  if (isTvView()) {
    // beide Felder mittig zwischen Zug-Anzeige oben und Spielerkarten unten, mit Sicherheitsrand (Overscan)
    const banner = r('#turn-banner'), cards = r('#fleet-cards'), log = r('#log');
    insets.top = (banner ? banner.bottom : 120) + 10;
    const lowest = Math.min(cards ? cards.top : h, log && log.height ? log.top : h);
    insets.bottom = h - lowest + 10;
    insets.left = insets.right = Math.round(w * 0.03);
    return R.setInsets(insets);
  }
  if (screen === 'place') {
    const banner = r('.banner'), dock = r('.dock');
    if (banner) insets.top = banner.bottom + 4;
    if (dock) insets.bottom = h - dock.top + 4;
  } else if (screen === 'battle' || screen === 'over') {
    const banner = r('#turn-banner'), cards = r('#fleet-cards');
    if (banner) insets.top = banner.bottom + 4;
    if (cards) {
      if (w <= 760) insets.bottom = h - cards.top + 4;
      else if (currentFocus() !== 'all') insets.left = cards.right + 8;
    }
  }
  R.setInsets(insets);
}

// ------------------------------------------------------------------ Kleinkram

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3300);
}

function pop(text, kind) {
  const el = $('#pop');
  el.textContent = text;
  el.className = `pop ${kind}`;
  void el.offsetWidth; // Animation neu starten
  el.classList.add('show');
}

function vibrate(pattern) {
  if (touchUI && navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch { /* egal */ }
  }
}

async function shareLink() {
  if (!S) return;
  let url = `${location.origin}/?room=${S.code}`;
  try {
    const res = await fetch(`/api/join?room=${S.code}`);
    if (res.ok) url = (await res.json()).url;
  } catch { /* egal */ }
  if (touchUI && navigator.share) {
    try {
      await navigator.share({ title: 'Schiffe versenken', text: `Spiel mit mir Schiffe versenken! Code ${S.code}`, url });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Einladungslink kopiert – ab damit an deinen Freund! 📨');
  } catch {
    toast(`Code: ${S.code}`);
  }
}

function playerName() {
  const name = $('#in-name').value.trim();
  store.set('sv-name', name);
  return name;
}

function joinRoom() {
  const code = $('#in-code').value.replace(/\D/g, '');
  if (code.length !== 4) {
    toast('Der Code hat 4 Ziffern.', 'error');
    $('#in-code').focus();
    return;
  }
  send({ t: 'join', code, k: code === params.get('room') ? invite : undefined, name: playerName() });
}

function leave() {
  const fighting = S && S.phase === 'playing' && me && opponents().some((p) => !p.bot);
  if (fighting && !confirm('Wirklich aufgeben und den Raum verlassen?')) return;
  if (S?.tvHost && S.players.some((p) => !p.bot) && !confirm('Spiel am Fernseher beenden? Die Handys werden getrennt.')) return;
  send({ t: 'leave' });
}

// ------------------------------------------------------------------ Ereignisse

document.addEventListener('pointerdown', () => {
  sfx.unlock();
  sfx.setAmbience(true);
}, { passive: true });

$('#mode-pvp').onclick = () => send({ t: 'create', mode: 'pvp', name: playerName() });
$('#mode-bot').onclick = () => send({ t: 'create', mode: 'bot', name: playerName(), level });
$('#mode-demo').onclick = () => send({ t: 'create', mode: 'demo', level, level2: level === 'schwer' ? 'mittel' : 'schwer' });
$('#mode-tv').onclick = () => send({ t: 'create', mode: 'tv' });
$('#form-join').onsubmit = (e) => {
  e.preventDefault();
  joinRoom();
};
$('#in-code').oninput = (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  if (e.target.value.length === 4 && playerName()) joinRoom(); // 4 Ziffern + Name → direkt los
};
for (const sel of ['#level', '#tv-level']) {
  $(sel).onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    level = b.dataset.level;
    store.set('sv-level', level);
    render();
  };
}

$('#btn-copy').onclick = shareLink;
$('#room-chip').onclick = shareLink;
$('#btn-cancel').onclick = () => send({ t: 'leave' });
$('#btn-pad-leave').onclick = () => send({ t: 'leave' });
$('#btn-tv-back').onclick = leave;
$('#btn-tv-start').onclick = () => send({ t: 'start', level });
$('#tv-slots').onclick = (e) => {
  const b = e.target.closest('[data-kick]');
  if (b) send({ t: 'kick', id: b.dataset.kick });
};
$('#btn-leave').onclick = leave;
$('#brand').onclick = () => { if (S) leave(); };

// Einstellungen
$('#btn-settings').onclick = (e) => {
  e.stopPropagation();
  const open = $('#settings').hidden;
  $('#settings').hidden = !open;
  $('#btn-settings').setAttribute('aria-expanded', String(open));
};
document.addEventListener('click', (e) => {
  if (!$('#settings').hidden && !e.target.closest('#settings, #btn-settings')) $('#settings').hidden = true;
});
$('#set-theme').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  theme = b.dataset.v;
  store.set('sv-theme', theme);
  if (S?.controller && theme === '3d') toast('Am Handy als Controller bleibt die Papier-Ansicht – der Fernseher zeigt 3D.');
  applyTheme();
};
$('#set-quality').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  quality = b.dataset.v;
  store.set('sv-quality', quality);
  world3d?.setQuality(quality);
  renderSettings();
};
$('#set-sound').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  sfx.unlock();
  sfx.setMuted(b.dataset.v === 'off');
  renderSettings();
};
$('#btn-view').onclick = () => {
  overview = !overview;
  viewManual = false;
  render();
  toast(overview ? 'Übersicht: beide Felder' : 'Ansicht folgt dem Geschehen');
};

$('#ship-chips').onclick = (e) => {
  const b = e.target.closest('.ship-chip');
  if (!b || !canPlaceNow()) return;
  select(Number(b.dataset.i));
};
$('#btn-rotate').onclick = () => { if (touchUI) place.hover = null; rotate(); };
$('#btn-random').onclick = () => {
  if (!canPlaceNow()) return;
  place.placements = G.randomFleet();
  place.selected = null;
  sfx.play('place');
  renderPlace();
  renderBoards();
  updateGhost();
};
$('#btn-ready').onclick = () => {
  if (!S || !me) return;
  if (me.ready) return send({ t: 'unready' });
  if (!place.placements.every(Boolean)) return;
  send({ t: 'place', ships: place.placements });
};

$('#fleet-cards').onclick = (e) => {
  const c = e.target.closest('.pcard');
  if (!c) return;
  viewManual = true;
  overview = false;
  viewId = c.dataset.id;
  if (touchAim && touchAim.target !== viewId) touchAim = null;
  updateFocus();
  updateInteractive();
  renderFireButton();
  requestAnimationFrame(updateInsets);
};
$('#btn-fire').onclick = () => { if (touchAim && canFireNow()) fire(touchAim); };

$('#emotes').innerHTML = EMOTES.map((e, i) => `<button type="button" data-e="${i}" aria-label="Emote ${e}">${e}</button>`).join('');
$('#btn-emote').onclick = () => { $('#emotes').hidden = !$('#emotes').hidden; };
$('#emotes').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  send({ t: 'emote', e: Number(b.dataset.e) });
  $('#emotes').hidden = true;
};

$('#btn-again').onclick = () => send({ t: 'again' });
$('#btn-look').onclick = () => { resultCollapsed = true; render(); };
$('#btn-result').onclick = () => { resultCollapsed = false; render(); };
$('#btn-home').onclick = leave;

// TV-Demo: jede Taste, jeder Klick beendet den Bildschirmschoner (wie HitYear)
function wakeTv() {
  tvIdleSince = Date.now();
  if (S?.tvHost && S.demo) send({ t: 'demo', on: false });
}
document.addEventListener('keydown', (e) => {
  wakeTv();
  if (e.target.closest('input')) return;
  if (e.key === 'r' || e.key === 'R') rotate();
  if (e.key === 'Escape') { touchAim = null; renderFireButton(); }
});
document.addEventListener('pointerdown', wakeTv, { passive: true });
window.addEventListener('resize', () => requestAnimationFrame(updateInsets));

// Taktgeber: Zugtimer, 3-2-1-Countdown, Demo-Countdown, Bildschirmschoner
setInterval(() => {
  if (!S) return;
  const now = serverNow();
  // 3) synchroner Gefechtsbeginn
  const cd = $('#countdown');
  if (S.phase === 'playing' && S.startAt && now < S.startAt + 700) {
    const left = S.startAt - now;
    const label = left > 0 ? String(Math.ceil(left / 1000)) : 'Feuer frei!';
    if (label !== countdownShown) {
      countdownShown = label;
      cd.hidden = false;
      cd.textContent = label;
      cd.classList.remove('tick');
      void cd.offsetWidth;
      cd.classList.add('tick');
      if (left <= 0) { sfx.play('turn'); vibrate(40); }
      else sfx.play('place', { volume: 0.6 });
    }
  } else if (!cd.hidden) {
    cd.hidden = true;
    countdownShown = null;
  }
  // 5) Zugzeit (läuft erst nach dem Einschlag)
  if (S.phase === 'playing' && S.turnEndsAt) {
    const total = S.turnSeconds * 1000;
    const left = clamp(S.turnEndsAt - now, 0, total) / 1000;
    $('#timer-num').textContent = Math.ceil(left);
    $('#timer-bar').style.strokeDashoffset = String(119.4 * (1 - left / S.turnSeconds));
    $('#timer').classList.toggle('low', myTurn() && left <= 6);
    if (myTurn() && !$('#btn-fire').hidden && $('#btn-fire').disabled && canFireNow()) renderFireButton();
  }
  if (S.phase === 'over') {
    if (!$('#result-card').hidden !== (Date.now() >= resultReadyAt && !resultCollapsed)) renderOver();
    // 6) Demo-Neustart
    if (S.demo && S.nextRoundAt) $('#over-sub').textContent = `Nächste Runde in ${Math.max(0, Math.ceil((S.nextRoundAt - now) / 1000))} s …`;
  }
  // leere TV-Lobby → nach 5 min Demo als Bildschirmschoner
  if (S.tvHost && S.phase === 'lobby' && !S.players.length && Date.now() - tvIdleSince > TV_IDLE_DEMO_MS) {
    tvIdleSince = Date.now();
    send({ t: 'demo', on: true });
  }
}, 100);

// ------------------------------------------------------------------ Start

(async () => {
  await applyTheme();
  connect();
  // Per QR-Code gekommen (Raum + Schlüssel): mit gespeichertem Namen direkt beitreten
  if (params.get('room') && invite && !session.get()) {
    if (store.get('sv-name', '')) setTimeout(joinRoom, 300);
    else {
      $('#in-name').focus();
      toast('Fast geschafft: Namen eingeben und ➜ tippen.');
    }
  }
})();

// Für automatische Tests und Fehlersuche (keine Geheimnisse: nur, was dieses Gerät ohnehin sieht)
window.__sv = { state: () => S, renderer: () => R, serverNow, send };
