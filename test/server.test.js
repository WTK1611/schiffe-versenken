'use strict';
process.env.BOT_SPEED = '25'; // Bots im Test schnell spielen lassen
process.env.START_DELAY_MS = '0';
process.env.FLIGHT_MS = '0';
process.env.OVER_DELAY_MS = '0';
process.env.DEMO_RESTART_MS = '60000';
process.env.NO_RATE_LIMIT = '1';
process.env.LEADERBOARD_FILE = ''; // Bestenliste nur im Speicher
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');
const G = require('../shared/game.js');
const { start } = require('../server.js');

async function withServer(fn) {
  const { server, wss, port } = await start(0);
  const clients = [];
  const client = () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const c = { ws, state: null, waiters: [] };
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (process.env.DEBUG_WS && m.t !== 'aim') console.log('<<', m.t, m.phase || '', m.demo ?? '', m.players?.length ?? '', m.msg || '');
      if (m.t === 'state') c.state = m;
      c.waiters = c.waiters.filter((w) => !(w.pred(m) && (w.resolve(m), true)));
    });
    c.send = (m) => ws.send(JSON.stringify(m));
    c.wait = (pred, ms = 3000) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout beim Warten')), ms);
      c.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
    c.open = new Promise((r) => ws.on('open', r));
    clients.push(c);
    return c;
  };
  try {
    await fn({ client, port });
  } finally {
    for (const c of clients) c.ws.terminate();
    for (const ws of wss.clients) ws.terminate();
    server.closeAllConnections(); // Keep-Alive-Verbindungen (Node 22) sonst offen
    await new Promise((r) => server.close(r));
  }
}

const row = (y) => ({ x: 0, y, dir: 'h' });
const FLEET_ROWS = [row(0), row(2), row(4), row(6), row(8)];

test('Zwei Menschen: Beitritt startet, Flotten geheim, Spiel bis zum Sieg', () => withServer(async ({ client, port }) => {
  const a = client(), b = client();
  await Promise.all([a.open, b.open]);
  a.send({ t: 'create', mode: 'pvp', name: 'Anna' });
  const s0 = await a.wait((m) => m.t === 'state');
  assert.match(s0.code, /^\d{4}$/, 'vierstelliger Zahlencode');
  assert.equal(s0.phase, 'lobby');

  b.send({ t: 'join', code: s0.code, name: 'Anna' });
  await a.wait((m) => m.t === 'state' && m.phase === 'placing');
  assert.equal(b.state?.players[1].name || (await b.wait((m) => m.t === 'state')).players[1].name, 'Anna 2');

  const fleets = new Map([[a, G.randomFleet()], [b, G.randomFleet()]]);
  a.send({ t: 'place', ships: fleets.get(a) });
  b.send({ t: 'place', ships: fleets.get(b) });
  const st = await a.wait((m) => m.t === 'state' && m.phase === 'playing');
  const mine = st.players.find((p) => p.id === st.you);
  const theirs = st.players.find((p) => p.id !== st.you);
  assert.equal(mine.board.ships.length, 5);
  assert.equal(theirs.board.ships, null, 'gegnerische Schiffe bleiben geheim');

  const byId = new Map([[a.state.you, a], [b.state.you, b]]);
  for (let guard = 0; a.state.phase === 'playing' && guard < 300; guard++) {
    const s = a.state;
    if (!s.turnId) { await a.wait((m) => m.t === 'state' && m.phase === 'over'); break; }
    const shooter = byId.get(s.turnId);
    const target = s.players.find((p) => p.id !== s.turnId);
    const shot = new Set(target.board.shots.map(([x, y]) => `${x},${y}`));
    const cell = G.createShips(fleets.get(byId.get(target.id))).flatMap((x) => x.cells).find(([x, y]) => !shot.has(`${x},${y}`));
    const seq = s.lastShot?.seq || 0;
    shooter.send({ t: 'fire', target: target.id, x: cell[0], y: cell[1] });
    await a.wait((m) => m.t === 'state' && m.lastShot?.seq > seq);
  }
  assert.equal(a.state.phase, 'over');
  for (const p of a.state.players) assert.equal(p.board.ships.length, 5, 'am Ende wird alles aufgedeckt');
  assert.equal(a.state.players.find((p) => p.id === a.state.winnerId).wins, 1);
  // Bestenliste: beide Menschen eingetragen, Sieger mit mehr Punkten
  const res = a.state.results;
  assert.ok(res[a.state.winnerId].points > 0);
  assert.equal(Object.keys(res).length, 2);
  assert.ok(a.state.leaderboard.some((e) => e.name === 'Anna'));
  const api = await new Promise((resolve) => http.get(`http://localhost:${port}/api/bestenliste`, (r) => {
    let d = '';
    r.on('data', (c) => { d += c; });
    r.on('end', () => resolve(JSON.parse(d)));
  }));
  assert.ok(api.top.find((e) => e.name === 'Anna 2'));

  a.send({ t: 'again' });
  await b.wait((m) => m.t === 'state' && m.phase === 'placing' && m.round === 2);
  b.send({ t: 'leave' });
  const back = await a.wait((m) => m.t === 'state' && m.players.length === 1);
  assert.equal(back.phase, 'lobby', 'allein zurück im Warteraum');
}));

test('Fehlschuss wechselt den Zug, Treffer nicht; Zielen wird live weitergeleitet', () => withServer(async ({ client }) => {
  const a = client(), b = client();
  await Promise.all([a.open, b.open]);
  a.send({ t: 'create', mode: 'pvp', name: 'A' });
  const s0 = await a.wait((m) => m.t === 'state');
  b.send({ t: 'join', code: s0.code, name: 'B' });
  await a.wait((m) => m.phase === 'placing');
  a.send({ t: 'place', ships: FLEET_ROWS });
  b.send({ t: 'place', ships: FLEET_ROWS });
  const s = await a.wait((m) => m.phase === 'playing');
  const cl = s.turnId === s.you ? a : b;
  const other = cl === a ? b : a;
  const targetId = s.players.find((p) => p.id !== s.turnId).id;

  cl.send({ t: 'aim', target: targetId, x: 3, y: 4 });
  const aim = await other.wait((m) => m.t === 'aim');
  assert.deepEqual([aim.x, aim.y], [3, 4]);

  cl.send({ t: 'fire', target: targetId, x: 0, y: 0 });
  let st = await a.wait((m) => m.lastShot?.seq === 1);
  assert.equal(st.lastShot.result, 'hit');
  assert.equal(st.turnId, s.turnId);
  cl.send({ t: 'fire', target: targetId, x: 0, y: 0 });
  await cl.wait((m) => m.t === 'error');
  cl.send({ t: 'fire', target: targetId, x: 9, y: 9 });
  st = await a.wait((m) => m.lastShot?.seq === 2);
  assert.equal(st.lastShot.result, 'miss');
  assert.equal(st.turnId, targetId);
}));

test('Gegen Bot: Bot hat einen Dienstgrad-Namen und schießt zurück', () => withServer(async ({ client }) => {
  const a = client();
  await a.open;
  a.send({ t: 'create', mode: 'bot', name: 'Mensch', level: 'schwer' });
  const s0 = await a.wait((m) => m.t === 'state' && m.phase === 'placing');
  const bot = s0.players.find((p) => p.bot);
  assert.equal(bot.bot, 'schwer');
  assert.ok(bot.ready, 'Bot hat sofort platziert');
  assert.match(bot.name, /admiral|Kommodore/i);
  const botShot = a.wait((m) => m.t === 'state' && m.lastShot?.by === bot.id, 8000);
  a.send({ t: 'place', ships: FLEET_ROWS });
  await a.wait((m) => m.phase === 'playing');
  // solange der Mensch dran ist (Treffer = nochmal), der Reihe nach schießen
  for (let i = 0; i < 100 && a.state.turnId === a.state.you; i++) {
    const seq = a.state.lastShot?.seq || 0;
    a.send({ t: 'fire', target: bot.id, x: i % 10, y: Math.floor(i / 10) });
    await a.wait((m) => m.t === 'state' && (m.lastShot?.seq || 0) > seq);
  }
  const shot = await botShot;
  assert.equal(shot.lastShot.target, a.state.you);
}));

test('Demo: zwei Bots spielen allein zu Ende, Zuschauer sieht alles', () => withServer(async ({ client }) => {
  const a = client();
  await a.open;
  a.send({ t: 'create', mode: 'demo', level: 'mittel', level2: 'schwer' });
  const s0 = await a.wait((m) => m.t === 'state');
  assert.equal(s0.spectator, true);
  assert.ok(s0.players.every((p) => p.bot && p.board.ships.length === 5));
  const over = await a.wait((m) => m.t === 'state' && m.phase === 'over', 40000);
  assert.ok(over.winnerId);
  assert.ok(over.nextRoundAt > over.sentAt, 'nächste Runde ist geplant');
  assert.equal(over.results, null, 'Demos kommen nicht in die Bestenliste');
}));

test('TV-Modus: Fernseher richtet ein, Handy steuert, TV zeigt nur Öffentliches', () => withServer(async ({ client, port }) => {
  const tv = client(), phone = client();
  await Promise.all([tv.open, phone.open]);
  tv.send({ t: 'create', mode: 'tv' });
  const s0 = await tv.wait((m) => m.t === 'state');
  assert.equal(s0.tvHost, true);
  assert.equal(s0.players.length, 0);

  tv.send({ t: 'start', level: 'leicht' });
  await tv.wait((m) => m.t === 'error');

  phone.send({ t: 'join', code: s0.code, name: 'Handy' });
  const ps = await phone.wait((m) => m.t === 'state');
  assert.equal(ps.controller, true);
  tv.send({ t: 'start', level: 'leicht' });
  const tvState = await tv.wait((m) => m.t === 'state' && m.phase === 'placing');
  const bot = tvState.players.find((p) => p.bot);
  assert.equal(bot.bot, 'leicht');
  assert.equal(bot.board.ships, null, 'Fernseher verrät keine Schiffe');

  phone.send({ t: 'place', ships: FLEET_ROWS });
  const playing = await tv.wait((m) => m.t === 'state' && m.phase === 'playing');
  assert.ok(playing.players.every((p) => p.board.ships === null));

  // QR-Code + Link
  const body = await new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}/api/join?room=${s0.code}`, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  assert.match(body.url, new RegExp(`/s/${s0.code}\\.[A-Za-z0-9_-]+$`), 'Kurzlink mit Einladungsschlüssel');
  assert.match(body.svg, /^<svg/);

  phone.send({ t: 'leave' });
  const lobby = await tv.wait((m) => m.t === 'state' && m.phase === 'lobby');
  assert.equal(lobby.players.length, 0, 'ohne Handy: Bot wieder raus, zurück zum Warteraum');
}));

test('Zeitabgleich: time-Ping, Stand-Nummern und Nachsenden verpasster Zustände', () => withServer(async ({ client }) => {
  const a = client();
  await a.open;
  a.send({ t: 'time', id: 7 });
  const tm = await a.wait((m) => m.t === 'time');
  assert.equal(tm.id, 7);
  assert.ok(Math.abs(tm.now - Date.now()) < 1000);

  a.send({ t: 'create', mode: 'bot', name: 'A' });
  await a.wait((m) => m.t === 'state');
  a.send({ t: 'place', ships: FLEET_ROWS });
  const s0 = await a.wait((m) => m.t === 'state' && m.phase === 'playing');
  assert.ok(s0.seq > 0);
  assert.equal(typeof s0.startAt, 'number', 'Gefechtsbeginn als Serverzeit');
  await new Promise((r) => setTimeout(r, 50));
  const cur = a.state;
  const pongP = a.wait((m) => m.t === 'pong');
  const againP = a.wait((m) => m.t === 'state');
  a.send({ t: 'sync', seq: -1 }); // „verpasst“ → aktueller Stand kommt sofort
  const [, again] = await Promise.all([pongP, againP]);
  assert.ok(again.seq >= cur.seq);
}));

test('Schuss trägt Einschlagzeit, Zugzeit beginnt erst danach', () => withServer(async ({ client }) => {
  const a = client(), b = client();
  await Promise.all([a.open, b.open]);
  a.send({ t: 'create', mode: 'pvp', name: 'A' });
  const s0 = await a.wait((m) => m.t === 'state');
  b.send({ t: 'join', code: s0.code, name: 'B' });
  await a.wait((m) => m.phase === 'placing');
  a.send({ t: 'place', ships: FLEET_ROWS });
  b.send({ t: 'place', ships: FLEET_ROWS });
  const s = await a.wait((m) => m.phase === 'playing');
  const cl = s.turnId === s.you ? a : b;
  const target = s.players.find((p) => p.id !== s.turnId).id;
  cl.send({ t: 'fire', target, x: 9, y: 9 });
  const st = await a.wait((m) => m.lastShot?.seq === 1);
  assert.ok(st.lastShot.impactAt >= st.lastShot.firedAt);
  assert.equal(st.turnEndsAt, st.lastShot.impactAt + st.turnSeconds * 1000);
}));

test('QR-Einladung, Rauswurf durch den Fernseher und Demo als Bildschirmschoner', () => withServer(async ({ client, port }) => {
  const tv = client(), phone = client();
  await Promise.all([tv.open, phone.open]);
  tv.send({ t: 'create', mode: 'tv' });
  const s0 = await tv.wait((m) => m.t === 'state');

  // Bildschirmschoner: Bots spielen, TV sieht dabei alles
  tv.send({ t: 'demo', on: true });
  const demo = await tv.wait((m) => m.t === 'state' && m.demo && m.phase === 'playing');
  assert.ok(demo.players.every((p) => p.bot && p.board.ships));

  // Kurzlink aus dem QR-Code leitet mit Schlüssel weiter
  const { url } = await new Promise((resolve) => http.get(`http://localhost:${port}/api/join?room=${s0.code}`, (res) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => resolve(JSON.parse(d)));
  }));
  const short = new URL(url).pathname;
  const loc = await new Promise((resolve) => http.get(`http://localhost:${port}${short}`, (res) => resolve(res.headers.location)));
  const k = new URL(loc, 'http://x').searchParams.get('k');
  assert.ok(k);

  // Handy tritt bei → Demo endet, Handy sitzt in der Lobby
  phone.send({ t: 'join', code: s0.code, k, name: 'Handy' });
  const lobby = await tv.wait((m) => m.t === 'state' && !m.demo && m.phase === 'lobby' && m.players.length === 1);
  assert.equal(lobby.players[0].name, 'Handy');

  const kickedP = phone.wait((m) => m.t === 'kicked');
  const emptyP = tv.wait((m) => m.t === 'state' && m.players.length === 0);
  tv.send({ t: 'kick', id: lobby.players[0].id });
  const [kicked, empty] = await Promise.all([kickedP, emptyP]);
  assert.match(kicked.msg, /Fernseher/);
  assert.equal(empty.phase, 'lobby');

  // Fernseher beendet → Raum ist weg
  tv.send({ t: 'leave' });
  await tv.wait((m) => m.t === 'left');
  phone.send({ t: 'join', code: s0.code, name: 'X' });
  const err = await phone.wait((m) => m.t === 'error');
  assert.equal(err.code, 'not-found');
}));

test('Grenzen je IP: falsche Codes werden gebremst', () => withServer(async ({ client }) => {
  process.env.NO_RATE_LIMIT = '0';
  try {
    const a = client();
    await a.open;
    let last;
    for (let i = 0; i < 21; i++) {
      a.send({ t: 'join', code: '0000', name: 'X' });
      last = await a.wait((m) => m.t === 'error');
    }
    assert.match(last.msg, /Zu viele falsche Codes/);
  } finally {
    process.env.NO_RATE_LIMIT = '1';
  }
}));
