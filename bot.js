'use strict';
/*
 * Bot-KI. Sieht nur, was ein menschlicher Spieler auch sieht:
 * Schüsse auf das Zielfeld und die bereits versenkten Schiffe.
 *
 *  leicht  – zufällig, verfolgt Treffer nur manchmal
 *  mittel  – Jagen & Zielen mit Schachbrettmuster
 *  schwer  – Wahrscheinlichkeitskarte über alle noch möglichen Schiffslagen
 */
const G = require('./shared/game.js');

const N = G.SIZE;
const UNKNOWN = 0, MISS = 1, HIT = 2, SUNK = 3, BLOCKED = 4;
const LEVELS = ['leicht', 'mittel', 'schwer'];

// Lustige militärische Namen – der Dienstgrad verrät die Stärke.
const NAMES = {
  leicht: [
    'Gefreiter Gummiboot', 'Matrose Blubberbacke', 'Schiffsjunge Schwimmflügel',
    'Leichtmatrose Luftmatratze', 'Obermaat Orientierungslos', 'Rekrut Rettungsring',
    'Kadett Kompasslos', 'Gefreiter Gurkenglas',
  ],
  mittel: [
    'Kapitän Kanonenkugel', 'Leutnant Löchrig', 'Korvettenkapitän Krabbe',
    'Bootsmann Bumm', 'Major Muschel', 'Oberleutnant Ostseekrabbe',
    'Kapitänleutnant Kielwasser', 'Hauptmann Heringsdose',
  ],
  schwer: [
    'Großadmiral Gnadenlos', 'Admiral Unversenkbar', 'Vizeadmiral Volltreffer',
    'Konteradmiral Kielholer', 'Kommodore Kaltblut', 'Flottenadmiral Fischstäbchen',
    'Admiralin Abrissbirne', 'Generaladmiral Granate',
  ],
};

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

function analyze(view, level) {
  const cells = new Array(N * N).fill(UNKNOWN);
  for (const [x, y, r] of view.shots) cells[y * N + x] = r === 'miss' ? MISS : HIT;
  for (const s of view.sunk) {
    for (const [x, y] of s.cells) cells[y * N + x] = SUNK;
    if (level === 'leicht') continue; // der Gefreite kennt die Abstandsregel noch nicht
    for (const [x, y] of G.surroundings(s.cells)) if (cells[y * N + x] === UNKNOWN) cells[y * N + x] = BLOCKED;
  }
  const hits = [];
  cells.forEach((v, i) => { if (v === HIT) hits.push(i); });
  if (level !== 'leicht') {
    // Schiffe sind gerade und berühren sich nicht: diagonal neben einem Treffer ist Wasser.
    for (const i of hits) {
      const x = i % N, y = Math.floor(i / N);
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const nx = x + dx, ny = y + dy;
        if (G.inBounds(nx, ny) && cells[ny * N + nx] === UNKNOWN) cells[ny * N + nx] = BLOCKED;
      }
    }
  }
  const sunkNames = new Set(view.sunk.map((s) => s.name));
  const remaining = G.FLEET.filter((f) => !sunkNames.has(f.name)).map((f) => f.len);
  return { cells, hits, remaining };
}

const free = (cells) => cells.reduce((out, v, i) => (v === UNKNOWN ? (out.push(i), out) : out), []);

function neighbours(i, cells, axis) {
  const x = i % N, y = Math.floor(i / N);
  const dirs = axis === 'h' ? [[-1, 0], [1, 0]] : axis === 'v' ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const out = [];
  for (const [dx, dy] of dirs) {
    // in Linienrichtung über bereits getroffene Felder hinweg weitergehen
    let nx = x + dx, ny = y + dy;
    while (axis && G.inBounds(nx, ny) && cells[ny * N + nx] === HIT) { nx += dx; ny += dy; }
    if (G.inBounds(nx, ny) && cells[ny * N + nx] === UNKNOWN) out.push(ny * N + nx);
  }
  return out;
}

function axisOf(i, cells) {
  const x = i % N, y = Math.floor(i / N);
  const isHit = (nx, ny) => G.inBounds(nx, ny) && cells[ny * N + nx] === HIT;
  if (isHit(x - 1, y) || isHit(x + 1, y)) return 'h';
  if (isHit(x, y - 1) || isHit(x, y + 1)) return 'v';
  return null;
}

function targetCandidates(cells, hits) {
  let out = [];
  for (const h of hits) out.push(...neighbours(h, cells, axisOf(h, cells)));
  if (!out.length) for (const h of hits) out.push(...neighbours(h, cells, null));
  return [...new Set(out)];
}

function density(cells, hits, remaining) {
  const score = new Array(N * N).fill(0);
  for (const len of remaining) {
    for (const dir of ['h', 'v']) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const span = G.cellsOf({ x, y, dir }, len);
          let ok = true, covered = 0;
          for (const [cx, cy] of span) {
            if (!G.inBounds(cx, cy)) { ok = false; break; }
            const v = cells[cy * N + cx];
            if (v === HIT) covered++;
            else if (v !== UNKNOWN) { ok = false; break; }
          }
          if (!ok) continue;
          // Gibt es offene Treffer, zählen nur Lagen, die sie erklären.
          const w = hits.length ? (covered ? Math.pow(40, covered) : 0) : 1;
          if (!w) continue;
          for (const [cx, cy] of span) if (cells[cy * N + cx] === UNKNOWN) score[cy * N + cx] += w;
        }
      }
    }
  }
  return score;
}

/** Wählt ein Feld auf dem Zielbrett. view = { shots, sunk } wie im öffentlichen Zustand. */
function chooseShot(view, level = 'mittel', rng = Math.random) {
  const { cells, hits, remaining } = analyze(view, level);
  let options = free(cells);
  if (!options.length) {
    // Sicherheitsnetz: irgendein noch nicht beschossenes Feld
    const shot = new Set(view.shots.map(([x, y]) => y * N + x));
    options = [...Array(N * N).keys()].filter((i) => !shot.has(i));
  }
  let choice;

  if (level === 'leicht') {
    const t = hits.length && rng() < 0.35 ? targetCandidates(cells, hits) : [];
    choice = pick(t.length ? t : options, rng);
  } else if (level === 'mittel') {
    const t = hits.length ? targetCandidates(cells, hits) : [];
    if (t.length) choice = pick(t, rng);
    else {
      const parity = options.filter((i) => ((i % N) + Math.floor(i / N)) % 2 === 0);
      choice = pick(parity.length ? parity : options, rng);
    }
  } else {
    const score = density(cells, hits, remaining);
    let best = -1, bestCells = [];
    for (const i of options) {
      const s = score[i] + rng() * 0.01; // leichtes Rauschen gegen Vorhersehbarkeit
      if (s > best + 1e-9) { best = s; bestCells = [i]; }
      else if (Math.abs(s - best) < 1e-9) bestCells.push(i);
    }
    choice = best > 0.02 ? pick(bestCells, rng) : pick(options, rng);
  }
  return { x: choice % N, y: Math.floor(choice / N) };
}

function botName(level, taken, rng = Math.random) {
  const list = NAMES[level] || NAMES.mittel;
  const freeNames = list.filter((n) => !taken.includes(n));
  return pick(freeNames.length ? freeNames : list, rng);
}

module.exports = { chooseShot, botName, LEVELS };
