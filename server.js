'use strict';
/*
 * Schiffe versenken – Multiplayer-Server.
 * HTTP für die statischen Dateien + WebSocket (/ws) für das Spiel.
 *
 * Modi:
 *   pvp   – zwei Menschen, jeder am eigenen Gerät (Beitritt per Code oder QR)
 *   bot   – Mensch gegen Bot
 *   demo  – zwei Bots spielen gegeneinander, Menschen schauen zu
 *   tv    – ein Fernseher ist Gastgeber und zeigt das Spiel, Handys sind die Controller
 *
 * Raum-, Beitritts- und Setup-Logik folgen HitYear: Host-Sitzung, Spieler-Sitzungen,
 * Einladungsschlüssel im QR-Code, Grenzen je IP, Bots füllen freie Plätze, Demo als Bildschirmschoner.
 *
 * Zeitliche Abgleiche (alle Zeitpunkte sind Serveruhr):
 *   1. Uhrabgleich: Geräte messen per "time"-Ping ihren Versatz (schnellste von 5 Messungen)
 *   2. Stand-Nummern: jede Sendung zählt hoch; Geräte melden ihren Stand ("sync"), Verpasstes kommt sofort
 *   3. startAt: Gefecht beginnt überall gleichzeitig nach einem 3-2-1-Countdown
 *   4. impactAt: Einschlag eines Schusses auf allen Geräten im selben Moment
 *   5. turnEndsAt: Zugzeit läuft erst nach dem Einschlag, für alle gleich
 *   6. nextRoundAt: Neustart der Demo
 *
 * Der Server ist autoritativ: Schiffspositionen verlassen ihn erst, wenn ein Schiff versenkt
 * wurde oder das Spiel vorbei ist (Zuschauer der Demo sehen alles).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const G = require('./shared/game.js');
const Bot = require('./bot.js');
const { Leaderboard } = require('./bestenliste.js');

const env = (k, d) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const TURN_SECONDS = env('TURN_SECONDS', 30);
const OFFLINE_TURN_SECONDS = 8;               // Zugzeit, wenn der Spieler offline ist (Autopilot)
const START_DELAY_MS = env('START_DELAY_MS', 3500); // 3-2-1 vor dem ersten Schuss
const FLIGHT_MS = env('FLIGHT_MS', 1150);     // Flugzeit einer Granate bis zum Einschlag
const OVER_DELAY_MS = env('OVER_DELAY_MS', 900); // nach dem letzten Einschlag bis zum Ergebnis
const DEMO_RESTART_MS = env('DEMO_RESTART_MS', 9000);
const BOT_SPEED = env('BOT_SPEED', 1);        // >1 = schneller (Tests)
const LOBBY_GRACE_MS = 120_000;               // Lobby/Platzieren: so lange bleibt ein Platz frei
const HOUR = 3_600_000;
const MAX_ROOMS = 500;
const EMOTE_COUNT = 6;
const MODES = ['pvp', 'bot', 'demo', 'tv'];

// Bestenliste: JSON-Datei auf dem Server (LEADERBOARD_FILE="" → nur im Speicher, z. B. für Tests)
const LEADERBOARD_FILE = process.env.LEADERBOARD_FILE ?? path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'bestenliste.json');
const leaderboard = new Leaderboard(LEADERBOARD_FILE);

// ---------------------------------------------------------------- HTTP

const ROOT = __dirname;
const STATIC = [
  // [URL-Präfix, Verzeichnis] – der erste passende Eintrag gewinnt
  ['/vendor/three/', path.join(ROOT, 'node_modules', 'three')],
  ['/shared/', path.join(ROOT, 'shared')],
  ['/', path.join(ROOT, 'public')],
];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || '?';
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (urlPath === '/api/join') return serveJoin(req, res).catch(() => { res.writeHead(500); res.end(); });
  if (urlPath === '/api/bestenliste') {
    const n = Math.max(1, Math.min(50, Number(new URL(req.url, 'http://localhost').searchParams.get('n')) || 10));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ top: leaderboard.top(n), total: leaderboard.entries.size }));
  }
  // Kurzlink aus dem QR-Code: /s/1234.einladung → Startseite mit Raum und Schlüssel
  const short = urlPath.match(/^\/s\/(\d{4})\.([A-Za-z0-9_-]{4,16})$/);
  if (short) {
    res.writeHead(302, { Location: `/?room=${short[1]}&k=${short[2]}` });
    return res.end();
  }
  if (urlPath === '/') urlPath = '/index.html';
  const [prefix, dir] = STATIC.find(([p]) => urlPath.startsWith(p));
  const file = path.normalize(path.join(dir, urlPath.slice(prefix.length)));
  if (!file.startsWith(dir + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nicht gefunden');
    }
    const longCache = prefix === '/vendor/three/' || /\.(mp3|woff2)$/.test(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': longCache ? 'public, max-age=86400' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

/** LAN-Adresse, damit Handys den Fernseher auch erreichen, wenn dieser "localhost" nutzt. */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

/** Beitritts-Link mit Einladungsschlüssel + QR-Code (SVG). */
async function serveJoin(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const code = String(url.searchParams.get('room') || '').replace(/\D/g, '').slice(0, 4);
  const room = rooms.get(code);
  if (!room) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Raum nicht gefunden.' }));
  }
  const proto = req.headers['x-forwarded-proto'] || 'http';
  let host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const [hostname, port] = host.split(':');
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    const lan = lanAddress();
    if (lan) host = port ? `${lan}:${port}` : lan;
  }
  const base = process.env.BASE_URL || `${proto}://${host}`;
  const link = `${base}/s/${code}.${room.invite}`; // kurz → grobes, leicht scanbares Raster
  const svg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'L', color: { dark: '#160c26', light: '#ffffff' } });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ url: link, display: base.replace(/^https?:\/\//, ''), svg }));
}

// ---------------------------------------------------------------- Grenzen je IP (wie HitYear)

const counters = new Map(); // "art|ip" → Zeitpunkte
function allowed(kind, ip, max, windowMs) {
  if (process.env.NO_RATE_LIMIT === '1') return true; // nur für Tests
  const k = `${kind}|${ip}`;
  const now = Date.now();
  const list = (counters.get(k) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) {
    counters.set(k, list);
    return false;
  }
  list.push(now);
  counters.set(k, list);
  return true;
}

// ---------------------------------------------------------------- Räume

const rooms = new Map();

function newCode() {
  // 4 Ziffern – leicht am Handy oder mit der TV-Fernbedienung einzugeben
  let code;
  do code = String(crypto.randomInt(10000)).padStart(4, '0');
  while (rooms.has(code));
  return code;
}

const token = () => crypto.randomBytes(16).toString('base64url');
const inviteToken = () => crypto.randomBytes(6).toString('base64url');

function cleanName(raw, room) {
  let name = String(raw ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Kapitän';
  if (room) {
    const base = name;
    let n = 2;
    while (room.players.some((p) => p.name === name)) name = `${base} ${n++}`;
  }
  return name;
}

function newPlayer(room, { name, ws = null, bot = null }) {
  const used = new Set(room.players.map((p) => p.color));
  return {
    id: crypto.randomBytes(4).toString('hex'),
    token: token(),
    name: bot ? Bot.botName(bot.level, room.players.map((p) => p.name)) : cleanName(name, room),
    bot, // null oder { level }
    color: [0, 1, 2, 3].find((c) => !used.has(c)),
    ws,
    connected: true,
    lastSeen: Date.now(),
    wins: 0,
    ships: null,
    shots: new Map(), // Schüsse AUF dieses Feld: "x,y" -> { r: 'hit'|'miss', by }
    eliminated: false,
    lastAim: 0,
    lastEmote: 0,
  };
}

function newRoom(mode) {
  const room = {
    code: newCode(), mode, invite: inviteToken(), players: [], spectators: [], hostId: null, hostToken: null,
    phase: 'lobby', round: 0, seq: 0, demo: mode === 'demo',
    turnId: null, turnEndsAt: null, startAt: null, readyAt: 0, winnerId: null, lastShot: null, nextRoundAt: null,
    timer: null, botTimers: [], restartTimer: null, finishTimer: null, changed: Date.now(), results: null,
  };
  rooms.set(room.code, room);
  return room;
}

function clearTimers(room) {
  clearTimeout(room.timer);
  clearTimeout(room.restartTimer);
  clearTimeout(room.finishTimer);
  room.botTimers.forEach(clearTimeout);
  room.botTimers = [];
}

function destroyRoom(room, reason) {
  clearTimers(room);
  rooms.delete(room.code);
  if (reason) {
    for (const t of [...room.players, ...room.spectators]) {
      if (t.ws) {
        send(t.ws, { t: 'closed', msg: reason });
        t.ws.room = null;
        t.ws.player = null;
        t.ws.spectator = null;
      }
    }
  }
}

const humanPlayers = (room) => room.players.filter((p) => !p.bot);
const hasHumans = (room) => humanPlayers(room).length > 0 || room.spectators.length > 0;
const anyoneConnected = (room) => room.players.some((p) => !p.bot && p.connected) || room.spectators.some((s) => s.connected);
const alive = (room) => room.players.filter((p) => p.ships && !p.eliminated);
const byId = (room, id) => room.players.find((p) => p.id === id);
const isHost = (room, ws) => !!ws.spectator && ws.spectator.token === room.hostToken;

function resetBoards(room) {
  for (const p of room.players) {
    p.ships = null;
    p.shots = new Map();
    p.eliminated = false;
  }
  clearTimers(room);
  Object.assign(room, { lastShot: null, winnerId: null, turnId: null, turnEndsAt: null, startAt: null, readyAt: 0, nextRoundAt: null, results: null });
}

/** Neue Runde: alle platzieren neu, Bots sofort. */
function startRound(room) {
  resetBoards(room);
  room.phase = 'placing';
  room.round++;
  for (const p of room.players) if (p.bot) p.ships = G.createShips(G.randomFleet());
  if (room.players.every((p) => p.ships)) startBattle(room);
}

function backToLobby(room) {
  room.players = room.players.filter((p) => !p.bot);
  room.demo = room.mode === 'demo';
  resetBoards(room);
  room.phase = 'lobby';
}

// ---------------------------------------------------------------- Ansichten

function shipView(s) {
  return { name: s.name, len: s.len, dir: s.dir, cells: s.cells, sunk: G.isSunk(s) };
}

function boardView(p, reveal) {
  return {
    shots: [...p.shots].map(([k, v]) => {
      const [x, y] = k.split(',').map(Number);
      return [x, y, v.r, v.by];
    }),
    sunk: p.ships ? p.ships.filter(G.isSunk).map(shipView) : [],
    ships: reveal && p.ships ? p.ships.map(shipView) : null,
    afloat: p.ships ? p.ships.filter((s) => !G.isSunk(s)).length : G.FLEET.length,
  };
}

/** Zustand aus Sicht eines Spielers (me) oder eines Zuschauers (spectator). */
function view(room, me, spectator) {
  const over = room.phase === 'over';
  // Zuschauer einer Demo sehen alles; der Fernseher im echten Spiel nur das Öffentliche
  const seeAll = over || (!!spectator && room.demo);
  return {
    t: 'state',
    seq: room.seq,
    sentAt: Date.now(),
    code: room.code,
    mode: room.mode,
    demo: room.demo,
    you: me ? me.id : null,
    spectator: !!spectator,
    tvHost: !!spectator && spectator.token === room.hostToken,
    controller: !!me && room.mode === 'tv',
    token: me ? me.token : spectator.token,
    hostId: room.hostId,
    phase: room.phase,
    round: room.round,
    turnId: room.turnId,
    turnEndsAt: room.turnEndsAt,
    turnSeconds: TURN_SECONDS,
    startAt: room.startAt,
    readyAt: room.readyAt,
    winnerId: room.winnerId,
    lastShot: room.lastShot,
    nextRoundAt: room.nextRoundAt,
    // Bestenliste nur auf dem Ergebnisbildschirm (wie HitYear)
    results: over ? room.results : null,
    leaderboard: over ? leaderboard.top(5) : null,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      bot: p.bot ? p.bot.level : null,
      color: p.color,
      connected: p.connected,
      ready: !!p.ships,
      eliminated: p.eliminated,
      wins: p.wins,
      board: boardView(p, p === me || seeAll),
    })),
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room) {
  room.seq++;
  room.changed = Date.now();
  for (const p of room.players) if (p.connected && p.ws) send(p.ws, view(room, p, null));
  for (const s of room.spectators) if (s.connected) send(s.ws, view(room, null, s));
}

function viewFor(room, ws) {
  return ws.player ? view(room, ws.player, null) : view(room, null, ws.spectator);
}

function relay(room, msg, exceptWs) {
  const data = JSON.stringify(msg);
  for (const t of [...room.players, ...room.spectators]) {
    if (t.ws && t.ws !== exceptWs && t.connected && t.ws.readyState === 1) t.ws.send(data);
  }
}

const notice = (room, msg, exceptWs) => relay(room, { t: 'notice', msg }, exceptWs);

// ---------------------------------------------------------------- Spielablauf

function startBattle(room) {
  room.phase = 'playing';
  room.startAt = Date.now() + START_DELAY_MS; // Countdown 3-2-1 auf allen Geräten
  room.readyAt = room.startAt;
  const order = alive(room);
  setTurn(room, order[crypto.randomInt(order.length)].id, room.startAt);
}

/** Zug vergeben; die Zugzeit läuft ab `from` (Serveruhr), z. B. erst nach dem Einschlag. */
function setTurn(room, id, from = Date.now()) {
  clearTimeout(room.timer);
  room.botTimers.forEach(clearTimeout);
  room.botTimers = [];
  if (rooms.get(room.code) !== room) return; // Raum wurde inzwischen aufgelöst
  room.turnId = id;
  const p = byId(room, id);
  const secs = p && (p.connected || p.bot) ? TURN_SECONDS : OFFLINE_TURN_SECONDS;
  room.turnEndsAt = from + secs * 1000;
  room.timer = setTimeout(() => autoShot(room), Math.max(0, room.turnEndsAt - Date.now()));
  if (p && p.bot) scheduleBot(room, p, from);
}

function nextAliveFrom(room, index) {
  const n = room.players.length;
  for (let k = 0; k < n; k++) {
    const p = room.players[(index + k) % n];
    if (p.ships && !p.eliminated) return p;
  }
  return null;
}

/** Regulär beendetes Spiel (alle Schiffe versenkt) einmalig in die Bestenliste eintragen. */
function recordResults(room, winner) {
  if (room.demo || room.results) return;
  room.results = {};
  for (const p of room.players) {
    if (p.bot) continue; // Bots kommen nicht in die Bestenliste
    const opp = room.players.find((q) => q !== p);
    if (!opp || !opp.ships) continue;
    let shots = 0, hits = 0;
    for (const v of opp.shots.values()) {
      if (v.by !== p.id) continue;
      shots++;
      if (v.r === 'hit') hits++;
    }
    const points = leaderboard.record({
      name: p.name, won: p === winner, sunk: opp.ships.filter(G.isSunk).length, shots, hits,
      opponent: opp.bot ? opp.bot.level : 'mensch',
    });
    room.results[p.id] = { points, shots, hits, rank: null };
  }
  leaderboard.save();
  for (const p of room.players) if (room.results[p.id]) room.results[p.id].rank = leaderboard.rankOf(p.name);
}

function finish(room, winner, regular = false) {
  clearTimers(room);
  if (regular && winner) recordResults(room, winner);
  room.phase = 'over';
  room.turnId = null;
  room.turnEndsAt = null;
  room.winnerId = winner ? winner.id : null;
  if (winner) winner.wins++;
  if (room.demo) {
    room.nextRoundAt = Date.now() + DEMO_RESTART_MS;
    room.restartTimer = setTimeout(() => {
      if (rooms.get(room.code) !== room || room.phase !== 'over' || !room.demo) return;
      startRound(room);
      broadcast(room);
    }, DEMO_RESTART_MS);
  }
}

function shoot(room, shooter, target, x, y, auto = false) {
  const { result, ship } = G.fire(target.ships, x, y);
  target.shots.set(G.key(x, y), { r: result === 'miss' ? 'miss' : 'hit', by: shooter.id });
  const impactAt = Date.now() + FLIGHT_MS;
  room.readyAt = impactAt;
  room.lastShot = {
    seq: (room.lastShot?.seq || 0) + 1,
    by: shooter.id,
    target: target.id,
    x, y, result,
    ship: result === 'sunk' ? ship.name : null,
    eliminated: false,
    auto,
    firedAt: Date.now(),
    impactAt,
  };
  if (result === 'sunk' && G.allSunk(target.ships)) {
    target.eliminated = true;
    room.lastShot.eliminated = true;
  }
  const left = alive(room);
  if (left.length <= 1) {
    // Ergebnis erst nach dem Einschlag – auf allen Geräten gleichzeitig
    clearTimeout(room.timer);
    room.turnId = null;
    room.turnEndsAt = null;
    room.finishTimer = setTimeout(() => {
      if (rooms.get(room.code) !== room || room.phase !== 'playing') return;
      finish(room, left[0], true);
      broadcast(room);
    }, FLIGHT_MS + OVER_DELAY_MS);
  } else if (result === 'miss') {
    const i = room.players.indexOf(shooter);
    setTurn(room, nextAliveFrom(room, i + 1).id, impactAt);
  } else {
    setTurn(room, shooter.id, impactAt); // Treffer: nochmal schießen
  }
  broadcast(room);
}

function freeCells(target) {
  const out = [];
  for (let y = 0; y < G.SIZE; y++) {
    for (let x = 0; x < G.SIZE; x++) if (!target.shots.has(G.key(x, y))) out.push([x, y]);
  }
  return out;
}

function autoShot(room) {
  if (rooms.get(room.code) !== room || room.phase !== 'playing' || !room.turnId) return;
  const shooter = byId(room, room.turnId);
  if (!shooter) return;
  const targets = alive(room).filter((p) => p !== shooter);
  if (!targets.length) return;
  const target = targets[crypto.randomInt(targets.length)];
  const free = freeCells(target);
  const [x, y] = free[crypto.randomInt(free.length)];
  shoot(room, shooter, target, x, y, true);
}

/** Bot "denkt", bewegt sichtbar sein Fadenkreuz und schießt dann – ab `from` (nach dem Einschlag). */
function scheduleBot(room, bot, from) {
  const targets = alive(room).filter((p) => p !== bot);
  if (!targets.length) return;
  const target = targets[crypto.randomInt(targets.length)];
  const shot = Bot.chooseShot(boardView(target, false), bot.bot.level);
  const k = (room.demo ? 0.75 : 1) / BOT_SPEED;
  const clampCell = (v) => Math.max(0, Math.min(G.SIZE - 1, v));
  const first = { x: clampCell(shot.x + crypto.randomInt(7) - 3), y: clampCell(shot.y + crypto.randomInt(7) - 3) };
  const path = [first, { x: Math.round((first.x + shot.x) / 2), y: Math.round((first.y + shot.y) / 2) }, shot];

  let t = Math.max(0, from - Date.now()) + (500 + Math.random() * 500) * k;
  for (const c of path) {
    room.botTimers.push(setTimeout(() => relay(room, { t: 'aim', by: bot.id, target: target.id, x: c.x, y: c.y }), t));
    t += (260 + Math.random() * 260) * k;
  }
  room.botTimers.push(setTimeout(() => {
    if (room.phase !== 'playing' || room.turnId !== bot.id || target.eliminated) return;
    if (target.shots.has(G.key(shot.x, shot.y))) return autoShot(room);
    shoot(room, bot, target, shot.x, shot.y);
  }, t + 250 * k));
}

function removePlayer(room, p, reason) {
  const index = room.players.indexOf(p);
  if (index < 0) return;
  const wasTurn = room.turnId === p.id;
  room.players.splice(index, 1);
  if (p.ws) {
    p.ws.room = null;
    p.ws.player = null;
  }
  if (!hasHumans(room)) return destroyRoom(room);
  if (room.mode === 'bot') return destroyRoom(room); // ohne den Menschen ergibt ein Bot-Raum keinen Sinn

  const msg = reason === 'timeout' ? `${p.name} ist nicht zurückgekommen.`
    : reason === 'kicked' ? `${p.name} wurde vom Fernseher entfernt.` : `${p.name} hat den Raum verlassen.`;
  notice(room, msg);

  if (room.mode === 'tv' && !humanPlayers(room).length) {
    backToLobby(room); // kein Handy mehr → Bots raus, zurück in den Warteraum am Fernseher
    return broadcast(room);
  }
  if (room.hostId === p.id) room.hostId = room.players.find((q) => !q.bot)?.id || null;
  if (room.players.length < G.MIN_PLAYERS && room.phase !== 'over') {
    backToLobby(room);
  } else if (room.phase === 'placing') {
    if (room.players.every((q) => q.ships)) startBattle(room);
  } else if (room.phase === 'playing') {
    const left = alive(room);
    if (left.length <= 1) finish(room, left[0]);
    else if (wasTurn) setTurn(room, nextAliveFrom(room, index % room.players.length).id);
  }
  broadcast(room);
}

function removeSpectator(room, s) {
  room.spectators = room.spectators.filter((q) => q !== s);
  if (s.ws) {
    s.ws.room = null;
    s.ws.spectator = null;
  }
  if (!hasHumans(room)) destroyRoom(room);
}

/** Demo am Fernseher (Bildschirmschoner): zwei Bots spielen, bis ein Handy beitritt. */
function startTvDemo(room) {
  backToLobby(room);
  room.demo = true;
  for (const level of ['mittel', 'schwer']) room.players.push(newPlayer(room, { bot: { level } }));
  startRound(room);
}

// ---------------------------------------------------------------- Nachrichten

function unbindOld(entity, ws) {
  if (entity.ws && entity.ws !== ws) {
    entity.ws.room = null;
    entity.ws.player = null;
    entity.ws.spectator = null;
    try { entity.ws.close(4000, 'Woanders verbunden'); } catch { /* egal */ }
  }
}

function bindPlayer(ws, room, player) {
  unbindOld(player, ws);
  Object.assign(player, { ws, connected: true, lastSeen: Date.now() });
  ws.room = room;
  ws.player = player;
  ws.spectator = null;
}

function bindSpectator(ws, room, s) {
  unbindOld(s, ws);
  Object.assign(s, { ws, connected: true, lastSeen: Date.now() });
  ws.room = room;
  ws.player = null;
  ws.spectator = s;
}

function leaveCurrent(ws) {
  if (!ws.room) return;
  if (ws.player) removePlayer(ws.room, ws.player, 'left');
  else if (ws.spectator) {
    const room = ws.room;
    if (isHost(room, ws) && room.mode === 'tv') return destroyRoom(room, 'Der Fernseher hat das Spiel beendet.');
    removeSpectator(room, ws.spectator);
  }
}

const newSpectator = (ws) => ({ token: token(), ws, connected: true, lastSeen: Date.now() });

const handlers = {
  // --- Zeit & Abgleich -------------------------------------------------
  time(ws, m) {
    send(ws, { t: 'time', id: m.id, now: Date.now() });
  },

  sync(ws, m) {
    send(ws, { t: 'pong' }); // Lebenszeichen: bleibt es aus, baut das Gerät neu auf
    if (ws.room && Number(m.seq) !== ws.room.seq) send(ws, viewFor(ws.room, ws));
  },

  // --- Raum anlegen / beitreten ---------------------------------------
  create(ws, m) {
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', msg: 'Gerade sind zu viele Spiele offen. Bitte gleich nochmal versuchen.' });
    if (!allowed('create', ws.ip, 10, 10 * 60_000)) return send(ws, { t: 'error', msg: 'Zu viele neue Spiele. Bitte in ein paar Minuten nochmal.' });
    leaveCurrent(ws);
    const mode = MODES.includes(m.mode) ? m.mode : 'pvp';
    const level = Bot.LEVELS.includes(m.level) ? m.level : 'mittel';
    const room = newRoom(mode);

    if (mode === 'tv') {
      const s = newSpectator(ws);
      room.spectators.push(s);
      room.hostToken = s.token; // Host-Sitzung des Fernsehers
      bindSpectator(ws, room, s);
    } else if (mode === 'demo') {
      const levels = [m.level, m.level2].map((l) => (Bot.LEVELS.includes(l) ? l : 'mittel'));
      for (const l of levels) room.players.push(newPlayer(room, { bot: { level: l } }));
      const s = newSpectator(ws);
      room.spectators.push(s);
      room.hostToken = s.token;
      bindSpectator(ws, room, s);
      startRound(room);
    } else {
      const p = newPlayer(room, { name: m.name, ws });
      room.players.push(p);
      room.hostId = p.id;
      bindPlayer(ws, room, p);
      if (mode === 'bot') {
        room.players.push(newPlayer(room, { bot: { level } }));
        startRound(room);
      }
    }
    broadcast(room);
  },

  join(ws, m) {
    const room = rooms.get(String(m.code || '').replace(/\D/g, ''));
    const keyOk = room && typeof m.k === 'string' && m.k === room.invite;
    if (!room) {
      // falsche Codes zählen: so lassen sich fremde Räume nicht durchprobieren
      if (!allowed('code', ws.ip, 20, 10 * 60_000)) return send(ws, { t: 'error', msg: 'Zu viele falsche Codes. Bitte in 10 Minuten nochmal.' });
      return send(ws, { t: 'error', msg: 'Diesen Raum gibt es nicht. Stimmt der Code?', code: 'not-found' });
    }
    if (ws.room === room) return;
    if (!keyOk && !allowed('join', ws.ip, 30, 10 * 60_000)) return send(ws, { t: 'error', msg: 'Zu viele Beitritte. Bitte in ein paar Minuten nochmal.' });

    if (room.mode === 'demo') {
      leaveCurrent(ws);
      const s = newSpectator(ws);
      room.spectators.push(s);
      bindSpectator(ws, room, s);
      return broadcast(room);
    }
    if (room.mode === 'bot') return send(ws, { t: 'error', msg: 'In diesem Raum spielt jemand gegen einen Bot.' });
    if (room.mode === 'tv' && room.demo) backToLobby(room); // Handy kommt → Bildschirmschoner endet
    if (room.phase !== 'lobby') return send(ws, { t: 'error', msg: 'In diesem Raum läuft schon ein Spiel.' });
    if (room.players.length >= G.MAX_PLAYERS) return send(ws, { t: 'error', msg: 'Der Raum ist schon voll.' });
    leaveCurrent(ws);
    const p = newPlayer(room, { name: m.name, ws });
    room.players.push(p);
    bindPlayer(ws, room, p);
    notice(room, `${p.name} ist an Bord gekommen!`, ws);
    if (room.mode === 'pvp' && room.players.length === G.MAX_PLAYERS) startRound(room); // voll → los geht's
    broadcast(room);
  },

  resume(ws, m) {
    const room = rooms.get(String(m.code || '').replace(/\D/g, ''));
    if (!room) return send(ws, { t: 'resume-failed' });
    const p = room.players.find((q) => !q.bot && q.token === m.token);
    if (p) {
      bindPlayer(ws, room, p);
      // volle Zugzeit nach Reconnect (aber nie vor dem Einschlag)
      if (room.phase === 'playing' && room.turnId === p.id) setTurn(room, p.id, Math.max(Date.now(), room.readyAt));
      return broadcast(room);
    }
    const s = room.spectators.find((q) => q.token === m.token);
    if (s) {
      bindSpectator(ws, room, s);
      return send(ws, viewFor(room, ws));
    }
    send(ws, { t: 'resume-failed' });
  },

  // --- Host (Fernseher bzw. Ersteller) ---------------------------------
  start(ws, m) {
    const { room, player } = ws;
    if (!room || room.phase !== 'lobby') return;
    if (room.mode === 'tv') {
      if (!isHost(room, ws)) return send(ws, { t: 'error', msg: 'Nur der Fernseher kann starten.' });
      if (!humanPlayers(room).length) return send(ws, { t: 'error', msg: 'Erst muss mindestens ein Handy beitreten.' });
      // freie Plätze übernehmen Bots – genau wie in der Lobby angekündigt
      const level = Bot.LEVELS.includes(m.level) ? m.level : 'mittel';
      while (room.players.length < G.MAX_PLAYERS) room.players.push(newPlayer(room, { bot: { level } }));
      startRound(room);
      return broadcast(room);
    }
    if (!player || room.hostId !== player.id) return send(ws, { t: 'error', msg: 'Nur der Gastgeber kann starten.' });
    if (room.players.length < G.MIN_PLAYERS) return send(ws, { t: 'error', msg: 'Ihr braucht mindestens 2 Spieler.' });
    startRound(room);
    broadcast(room);
  },

  kick(ws, m) {
    const { room } = ws;
    if (!room || !isHost(room, ws)) return;
    const p = byId(room, m.id);
    if (!p || p.bot) return;
    const pws = p.ws;
    removePlayer(room, p, 'kicked');
    send(pws, { t: 'kicked', msg: 'Der Fernseher hat dich aus dem Spiel genommen.' });
  },

  demo(ws, m) {
    const { room } = ws;
    if (!room || room.mode !== 'tv' || !isHost(room, ws)) return;
    if (m.on) {
      if (room.phase !== 'lobby' || humanPlayers(room).length) return;
      startTvDemo(room);
    } else if (room.demo) backToLobby(room);
    broadcast(room);
  },

  again(ws) {
    const { room, player } = ws;
    if (!room || room.phase !== 'over') return;
    const ok = room.mode === 'demo' || isHost(room, ws)
      || (room.mode === 'tv' && !!player) || (player && room.hostId === player.id);
    if (!ok) return send(ws, { t: 'error', msg: 'Nur der Gastgeber kann eine neue Runde starten.' });
    if (room.players.length >= G.MIN_PLAYERS) startRound(room);
    else backToLobby(room);
    broadcast(room);
  },

  // --- Spieler ----------------------------------------------------------
  place(ws, m) {
    const { room, player } = ws;
    if (!room || !player || room.phase !== 'placing' || player.ships) return;
    const placements = Array.isArray(m.ships) ? m.ships.map((p) => p && { x: p.x, y: p.y, dir: p.dir }) : null;
    const check = G.validateFleet(placements);
    if (!check.ok) return send(ws, { t: 'error', msg: check.error });
    player.ships = G.createShips(placements);
    if (room.players.every((p) => p.ships)) startBattle(room);
    broadcast(room);
  },

  unready(ws) {
    const { room, player } = ws;
    if (!room || !player || room.phase !== 'placing' || !player.ships) return;
    player.ships = null;
    broadcast(room);
  },

  fire(ws, m) {
    const { room, player } = ws;
    if (!room || !player || room.phase !== 'playing') return;
    if (room.turnId !== player.id) return send(ws, { t: 'error', msg: 'Du bist gerade nicht dran.' });
    if (Date.now() < room.readyAt - 60) return send(ws, { t: 'error', msg: 'Moment – der letzte Schuss ist noch unterwegs.', quiet: true });
    const target = byId(room, m.target);
    if (!target || target === player || !target.ships || target.eliminated) {
      return send(ws, { t: 'error', msg: 'Dieses Ziel gibt es nicht.' });
    }
    if (!G.inBounds(m.x, m.y)) return;
    if (target.shots.has(G.key(m.x, m.y))) return send(ws, { t: 'error', msg: 'Da wurde schon hingeschossen.' });
    shoot(room, player, target, m.x, m.y);
  },

  aim(ws, m) {
    const { room, player } = ws;
    if (!room || !player || room.phase !== 'playing' || room.turnId !== player.id) return;
    const now = Date.now();
    if (now - player.lastAim < 40) return;
    player.lastAim = now;
    const ok = typeof m.target === 'string' && G.inBounds(m.x, m.y);
    relay(room, { t: 'aim', by: player.id, target: ok ? m.target : null, x: ok ? m.x : 0, y: ok ? m.y : 0 }, ws);
  },

  emote(ws, m) {
    const { room, player, spectator } = ws;
    const who = player || spectator;
    if (!room || !who || !Number.isInteger(m.e) || m.e < 0 || m.e >= EMOTE_COUNT) return;
    const now = Date.now();
    if (now - (who.lastEmote || 0) < 1000) return;
    who.lastEmote = now;
    relay(room, { t: 'emote', by: player ? player.id : 'spectator', e: m.e });
  },

  leave(ws) {
    leaveCurrent(ws);
    send(ws, { t: 'left' });
  },
};

// ---------------------------------------------------------------- Start

function start(port = Number(process.env.PORT) || 3000) {
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });

  wss.on('connection', (ws, req) => {
    ws.ip = clientIp(req);
    ws.isAlive = true;
    let budget = 40; // einfache Drosselung: höchstens ~40 Nachrichten pro Sekunde
    const refill = setInterval(() => { budget = Math.min(40, budget + 20); }, 500);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      if (--budget < 0) return;
      let m;
      try { m = JSON.parse(data); } catch { return; }
      const fn = m && typeof m.t === 'string' && Object.hasOwn(handlers, m.t) && handlers[m.t];
      if (!fn) return;
      if (ws.player) ws.player.lastSeen = Date.now();
      try { fn(ws, m); } catch (err) {
        console.error('Fehler bei', m.t, err);
        send(ws, { t: 'error', msg: 'Interner Fehler.' });
      }
    });
    ws.on('close', () => {
      clearInterval(refill);
      const { room } = ws;
      const who = ws.player || ws.spectator;
      if (!room || !who || who.ws !== ws || rooms.get(room.code) !== room) return;
      who.connected = false;
      who.lastSeen = Date.now();
      if (ws.player) {
        // offline während des eigenen Zugs → Autopilot nach kurzer Zeit
        if (room.phase === 'playing' && room.turnId === ws.player.id) setTurn(room, ws.player.id, Math.max(Date.now(), room.readyAt));
        broadcast(room);
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      // Lobby/Platzieren: Platz wird nach der Gnadenfrist frei. Im laufenden Spiel bleibt er (Autopilot).
      if (room.phase === 'lobby' || room.phase === 'placing') {
        for (const p of [...room.players]) {
          if (!p.bot && !p.connected && now - p.lastSeen > LOBBY_GRACE_MS && rooms.has(room.code)) removePlayer(room, p, 'timeout');
        }
      }
      if (!rooms.has(room.code)) continue;
      for (const s of [...room.spectators]) {
        if (!s.connected && s.token !== room.hostToken && now - s.lastSeen > LOBBY_GRACE_MS) removeSpectator(room, s);
      }
      // verlassene Räume (wie HitYear): Lobby/Ende nach 2 h, laufende Spiele nach 2 Tagen
      if (rooms.has(room.code) && !anyoneConnected(room)) {
        const quiet = now - room.changed;
        if (quiet > 48 * HOUR || ((room.phase === 'lobby' || room.phase === 'over') && quiet > 2 * HOUR)) destroyRoom(room);
      }
    }
  }, 15_000);
  heartbeat.unref();

  server.on('close', () => {
    clearInterval(heartbeat);
    for (const room of rooms.values()) clearTimers(room);
    rooms.clear();
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, wss, port: server.address().port }));
  });
}

if (require.main === module) {
  start().then(({ port }) => {
    const lan = lanAddress();
    console.log(`⚓ Schiffe versenken läuft auf http://localhost:${port}${lan ? `  (im WLAN: http://${lan}:${port})` : ''}`);
  });
}

module.exports = { start, rooms, leaderboard };
