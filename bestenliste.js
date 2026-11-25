'use strict';
/*
 * Bestenliste über alle Spiele (wie bei HitYear): je Name – ohne Groß-/Kleinschreibung –
 * werden Punkte, Spiele, Siege, Schüsse und Treffer aufsummiert. Bots und Demos zählen nicht.
 *
 * Punkte eines Spiels:
 *   Sieg 100 + je versenktem gegnerischem Schiff 10 + Trefferquote × 50,
 *   gewichtet nach Gegner: Mensch ×1,5 · Bot leicht ×0,5 · mittel ×1 · schwer ×1,5.
 *
 * Gespeichert wird als JSON-Datei auf dem Server (atomar: erst temporäre Datei, dann umbenennen).
 */
const fs = require('fs');
const path = require('path');

const FACTOR = { mensch: 1.5, leicht: 0.5, mittel: 1, schwer: 1.5 };
const MAX_ENTRIES = 1000;

const key = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');

function gamePoints({ won, sunk, shots, hits, opponent }) {
  const accuracy = shots ? hits / shots : 0;
  const raw = (won ? 100 : 0) + sunk * 10 + Math.round(accuracy * 50);
  return Math.round(raw * (FACTOR[opponent] ?? 1));
}

class Leaderboard {
  constructor(file) {
    this.file = file;
    this.entries = new Map();
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const list = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const e of list) if (e && e.name) this.entries.set(key(e.name), e);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Bestenliste nicht lesbar:', err.message);
    }
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.entries.values()]));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Bestenliste nicht speicherbar:', err.message);
    }
  }

  /** Ergebnis eines Spielers eintragen; gibt die vergebenen Punkte zurück. */
  record({ name, won, sunk, shots, hits, opponent }) {
    const k = key(name);
    if (!k) return 0;
    const points = gamePoints({ won, sunk, shots, hits, opponent });
    const e = this.entries.get(k) || { name: name.trim(), points: 0, games: 0, wins: 0, shots: 0, hits: 0, best: 0, changed: 0 };
    Object.assign(e, {
      name: name.trim(),
      points: e.points + points,
      games: e.games + 1,
      wins: e.wins + (won ? 1 : 0),
      shots: e.shots + shots,
      hits: e.hits + hits,
      best: Math.max(e.best, points),
      changed: Date.now(),
    });
    this.entries.set(k, e);
    this.prune();
    return points;
  }

  prune() {
    if (this.entries.size <= MAX_ENTRIES) return;
    const keep = this.sorted().slice(0, MAX_ENTRIES);
    this.entries = new Map(keep.map((e) => [key(e.name), e]));
  }

  sorted() {
    return [...this.entries.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || a.games - b.games || a.name.localeCompare(b.name, 'de'));
  }

  top(n = 10) {
    return this.sorted().slice(0, n).map((e, i) => ({
      rank: i + 1,
      name: e.name,
      points: e.points,
      games: e.games,
      wins: e.wins,
      accuracy: e.shots ? Math.round((e.hits / e.shots) * 100) : 0,
    }));
  }

  /** Platz eines Namens (auch außerhalb der Top-Liste), sonst null. */
  rankOf(name) {
    const k = key(name);
    const i = this.sorted().findIndex((e) => key(e.name) === k);
    return i < 0 ? null : i + 1;
  }
}

module.exports = { Leaderboard, gamePoints, key };
