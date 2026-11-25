'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../shared/game.js');

test('Zufallsflotten sind immer gültig', () => {
  for (let i = 0; i < 300; i++) assert.equal(G.validateFleet(G.randomFleet()).ok, true);
});

test('Überlappung, Berührung und Rand werden abgelehnt', () => {
  const base = [
    { x: 0, y: 0, dir: 'h' }, { x: 0, y: 2, dir: 'h' }, { x: 0, y: 4, dir: 'h' },
    { x: 0, y: 6, dir: 'h' }, { x: 0, y: 8, dir: 'h' },
  ];
  assert.equal(G.validateFleet(base).ok, true);
  assert.equal(G.validateFleet(base.map((p, i) => (i === 4 ? { x: 0, y: 7, dir: 'h' } : p))).ok, false, 'berührt');
  assert.equal(G.validateFleet(base.map((p, i) => (i === 0 ? { x: 6, y: 0, dir: 'h' } : p))).ok, false, 'Rand');
  assert.equal(G.validateFleet(base.map((p, i) => (i === 1 ? { x: 5, y: 1, dir: 'v' } : p))).ok, false, 'diagonal');
  assert.equal(G.validateFleet(base.slice(0, 4)).ok, false, 'unvollständig');
  assert.equal(G.validateFleet([...base.slice(0, 4), { x: 'a', y: 0, dir: 'h' }]).ok, false, 'Typ');
});

test('Treffer, Versenkt und Flottenende', () => {
  const ships = G.createShips([
    { x: 0, y: 0, dir: 'h' }, { x: 0, y: 2, dir: 'h' }, { x: 0, y: 4, dir: 'h' },
    { x: 0, y: 6, dir: 'h' }, { x: 0, y: 8, dir: 'h' },
  ]);
  assert.equal(G.fire(ships, 9, 9).result, 'miss');
  assert.equal(G.fire(ships, 0, 8).result, 'hit');
  assert.equal(G.fire(ships, 1, 8).result, 'sunk');
  assert.equal(G.allSunk(ships), false);
  for (const s of ships) for (const [x, y] of s.cells) G.fire(ships, x, y);
  assert.equal(G.allSunk(ships), true);
});

test('Umgebung eines Schiffs', () => {
  const around = G.surroundings([[0, 0], [1, 0]]);
  assert.equal(around.length, 4); // (2,0) (0,1) (1,1) (2,1)
});
