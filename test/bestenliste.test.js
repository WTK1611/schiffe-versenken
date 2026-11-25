'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Leaderboard, gamePoints } = require('../bestenliste.js');

test('Punkte: Sieg, versenkte Schiffe, Trefferquote, Gewichtung nach Gegner', () => {
  assert.equal(gamePoints({ won: true, sunk: 5, shots: 34, hits: 17, opponent: 'mittel' }), 100 + 50 + 25);
  assert.equal(gamePoints({ won: true, sunk: 5, shots: 34, hits: 17, opponent: 'mensch' }), Math.round(175 * 1.5));
  assert.equal(gamePoints({ won: false, sunk: 2, shots: 0, hits: 0, opponent: 'leicht' }), 10);
});

test('Namen ohne Groß-/Kleinschreibung zusammengefasst, sortiert, gespeichert und wieder geladen', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-')), 'bestenliste.json');
  const lb = new Leaderboard(file);
  lb.record({ name: 'Anna', won: true, sunk: 5, shots: 20, hits: 17, opponent: 'schwer' });
  lb.record({ name: '  anna ', won: false, sunk: 1, shots: 10, hits: 2, opponent: 'mittel' });
  lb.record({ name: 'Ben', won: true, sunk: 5, shots: 40, hits: 17, opponent: 'leicht' });
  lb.save();
  const again = new Leaderboard(file);
  const top = again.top(5);
  assert.equal(top.length, 2);
  assert.equal(top[0].name, 'anna');
  assert.equal(top[0].games, 2);
  assert.equal(top[0].wins, 1);
  assert.equal(top[0].accuracy, Math.round((19 / 30) * 100));
  assert.equal(again.rankOf('BEN'), 2);
});
