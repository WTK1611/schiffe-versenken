/*
 * Gemeinsame Spiellogik für Server (Node) und Browser.
 * Koordinaten: x = Spalte (0–9, A–J), y = Zeile (0–9, 1–10).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Game = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 10;
  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 2;
  const FLEET = [
    { name: 'Flugzeugträger', len: 5 },
    { name: 'Schlachtschiff', len: 4 },
    { name: 'Kreuzer', len: 3 },
    { name: 'U-Boot', len: 3 },
    { name: 'Zerstörer', len: 2 },
  ];

  const key = (x, y) => x + ',' + y;

  function inBounds(x, y) {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < SIZE && y < SIZE;
  }

  function cellsOf(p, len) {
    const out = [];
    for (let k = 0; k < len; k++) out.push(p.dir === 'h' ? [p.x + k, p.y] : [p.x, p.y + k]);
    return out;
  }

  /** Belegungsraster: Index des Schiffs pro Zelle oder -1. */
  function buildGrid(placements) {
    const grid = new Array(SIZE * SIZE).fill(-1);
    placements.forEach((p, i) => {
      if (!p) return;
      for (const [x, y] of cellsOf(p, FLEET[i].len)) if (inBounds(x, y)) grid[y * SIZE + x] = i;
    });
    return grid;
  }

  /**
   * Prüft, ob ein Schiff an p passt: im Feld, keine Überlappung und keine
   * Berührung (auch diagonal) mit anderen Schiffen. Schiff `ignore` zählt nicht.
   */
  function canPlace(grid, p, len, ignore) {
    for (const [x, y] of cellsOf(p, len)) {
      if (!inBounds(x, y)) return false;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const nx = x + dx, ny = y + dy;
          if (!inBounds(nx, ny)) continue;
          const v = grid[ny * SIZE + nx];
          if (v !== -1 && v !== ignore) return false;
        }
      }
    }
    return true;
  }

  function validateFleet(placements) {
    if (!Array.isArray(placements) || placements.length !== FLEET.length) {
      return { ok: false, error: 'Die Flotte ist unvollständig.' };
    }
    const grid = new Array(SIZE * SIZE).fill(-1);
    for (let i = 0; i < FLEET.length; i++) {
      const p = placements[i];
      if (!p || typeof p !== 'object' || (p.dir !== 'h' && p.dir !== 'v') || !inBounds(p.x, p.y)) {
        return { ok: false, error: 'Ungültige Schiffsposition.' };
      }
      if (!canPlace(grid, p, FLEET[i].len, -2)) {
        return { ok: false, error: 'Schiffe dürfen sich nicht überlappen oder berühren.' };
      }
      for (const [x, y] of cellsOf(p, FLEET[i].len)) grid[y * SIZE + x] = i;
    }
    return { ok: true };
  }

  function randomFleet(rng = Math.random) {
    for (let attempt = 0; attempt < 500; attempt++) {
      const grid = new Array(SIZE * SIZE).fill(-1);
      const out = [];
      for (let i = 0; i < FLEET.length; i++) {
        const len = FLEET[i].len;
        let placed = null;
        for (let t = 0; t < 200 && !placed; t++) {
          const dir = rng() < 0.5 ? 'h' : 'v';
          const p = {
            x: Math.floor(rng() * (dir === 'h' ? SIZE - len + 1 : SIZE)),
            y: Math.floor(rng() * (dir === 'v' ? SIZE - len + 1 : SIZE)),
            dir,
          };
          if (canPlace(grid, p, len, -2)) placed = p;
        }
        if (!placed) break;
        out.push(placed);
        for (const [x, y] of cellsOf(placed, len)) grid[y * SIZE + x] = i;
      }
      if (out.length === FLEET.length) return out;
    }
    throw new Error('Konnte keine zufällige Flotte erzeugen');
  }

  function createShips(placements) {
    return placements.map((p, i) => ({
      name: FLEET[i].name,
      len: FLEET[i].len,
      dir: p.dir,
      cells: cellsOf(p, FLEET[i].len),
      hits: new Array(FLEET[i].len).fill(false),
    }));
  }

  const isSunk = (s) => s.hits.every(Boolean);
  const allSunk = (ships) => ships.every(isSunk);

  /** Schuss auf eine Flotte. Ergebnis: 'miss' | 'hit' | 'sunk'. */
  function fire(ships, x, y) {
    for (const s of ships) {
      const k = s.cells.findIndex(([cx, cy]) => cx === x && cy === y);
      if (k >= 0) {
        s.hits[k] = true;
        return { result: isSunk(s) ? 'sunk' : 'hit', ship: s };
      }
    }
    return { result: 'miss', ship: null };
  }

  /** Zellen rund um ein Schiff (dort kann wegen der Abstandsregel nichts sein). */
  function surroundings(cells) {
    const own = new Set(cells.map(([x, y]) => key(x, y)));
    const out = new Map();
    for (const [x, y] of cells) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const nx = x + dx, ny = y + dy, k = key(nx, ny);
          if (inBounds(nx, ny) && !own.has(k)) out.set(k, [nx, ny]);
        }
      }
    }
    return [...out.values()];
  }

  return {
    SIZE, FLEET, MIN_PLAYERS, MAX_PLAYERS,
    key, inBounds, cellsOf, buildGrid, canPlace, validateFleet, randomFleet,
    createShips, isSunk, allSunk, fire, surroundings,
  };
});
