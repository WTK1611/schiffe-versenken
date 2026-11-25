// Papier-Theme: kariertes Blatt, mit Bleistift gezeichnet.
// Gleiche Schnittstelle wie die 3D-Welt (World), damit main.js beide nutzen kann.

const G = window.Game;
const N = G.SIZE;
const NS = 'http://www.w3.org/2000/svg';
const M = 8;            // Rand für die Beschriftung
const C = 10;           // Kantenlänge einer Zelle (SVG-Einheiten)
const VB = M + N * C + 2;
export const INK = ['#d6454a', '#c98a00', '#12936f', '#5a47d1'];
const HIT_INK = '#d6333a';
const PENCIL = '#3d4b5f';

const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};
const cx = (x) => M + x * C + C / 2;
const cy = (y) => M + y * C + C / 2;

// kleiner deterministischer Zufall, damit Striche bei jedem Neuzeichnen gleich wackeln
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Leicht zittrige Linie wie von Hand gezogen. */
function wobblyLine(x1, y1, x2, y2, r, amp = 0.35) {
  const mx = (x1 + x2) / 2 + (r() - 0.5) * amp * 2;
  const my = (y1 + y2) / 2 + (r() - 0.5) * amp * 2;
  return `M${x1 + (r() - 0.5) * amp} ${y1 + (r() - 0.5) * amp} Q${mx} ${my} ${x2 + (r() - 0.5) * amp} ${y2 + (r() - 0.5) * amp}`;
}

function starPath(x, y, rOuter, rInner, spikes, r) {
  let d = '';
  for (let i = 0; i < spikes * 2; i++) {
    const rad = (i % 2 ? rInner : rOuter) * (0.85 + r() * 0.3);
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
    d += `${i ? 'L' : 'M'}${(x + Math.cos(a) * rad).toFixed(2)} ${(y + Math.sin(a) * rad).toFixed(2)}`;
  }
  return d + 'Z';
}

function scribble(x1, y1, x2, y2, r) {
  // Zickzack quer über ein versenktes Schiff
  const steps = Math.max(4, Math.round(Math.hypot(x2 - x1, y2 - y1) / 3));
  let d = `M${x1} ${y1}`;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const px = x1 + (x2 - x1) * t, py = y1 + (y2 - y1) * t;
    const off = (i % 2 ? 1 : -1) * (2.6 + r() * 0.8);
    const horizontal = Math.abs(x2 - x1) > Math.abs(y2 - y1);
    d += ` L${(horizontal ? px : px + off).toFixed(2)} ${(horizontal ? py + off : py).toFixed(2)}`;
  }
  return d;
}

class PaperBoard {
  constructor(world, id) {
    this.world = world;
    this.id = id;
    this.pending = new Set();
    this.blocked = new Set();
    this.info = null;
    this.round = null;
    this.prevKeys = new Set();
    this.initialized = false;
    this.seed = [...id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7);

    this.el = document.createElement('div');
    this.el.className = 'pboard';
    this.el.dataset.id = id;
    this.head = document.createElement('div');
    this.head.className = 'pboard-head';
    this.el.appendChild(this.head);

    const svg = this.svg = svgEl('svg', { viewBox: `0 0 ${VB} ${VB}`, class: 'pboard-svg' });
    this.el.appendChild(svg);
    const r = rng(this.seed);

    // Kästchen
    const grid = svgEl('g', { class: 'p-grid' }, svg);
    for (let i = 0; i <= N; i++) {
      svgEl('path', { d: wobblyLine(M + i * C, M, M + i * C, M + N * C, r, 0.15) }, grid);
      svgEl('path', { d: wobblyLine(M, M + i * C, M + N * C, M + i * C, r, 0.15) }, grid);
    }
    // Bleistift-Rahmen, zweimal nachgezogen
    const frame = svgEl('g', { class: 'p-frame', filter: 'url(#p-pencil)' }, svg);
    for (let k = 0; k < 2; k++) {
      const a = M - 0.4 + r() * 0.3, b = M + N * C + 0.4 - r() * 0.3;
      svgEl('path', { d: [wobblyLine(a, a, b, a, r), wobblyLine(b, a, b, b, r), wobblyLine(b, b, a, b, r), wobblyLine(a, b, a, a, r)].join(' ') }, frame);
    }
    const labels = svgEl('g', { class: 'p-labels' }, svg);
    for (let i = 0; i < N; i++) {
      svgEl('text', { x: cx(i), y: M - 2.2, 'text-anchor': 'middle' }, labels).textContent = 'ABCDEFGHIJ'[i];
      svgEl('text', { x: M - 2, y: cy(i) + 1.8, 'text-anchor': 'end' }, labels).textContent = String(i + 1);
    }

    this.cells = svgEl('g', { class: 'p-cells' }, svg);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        svgEl('rect', { x: M + x * C, y: M + y * C, width: C, height: C, 'data-i': y * N + x, class: 'p-cell' }, this.cells);
      }
    }
    this.layerAround = svgEl('g', { class: 'p-around' }, svg);
    this.layerShips = svgEl('g', { class: 'p-ships', filter: 'url(#p-pencil)' }, svg);
    this.layerMarks = svgEl('g', { class: 'p-marks', filter: 'url(#p-pencil)' }, svg);
    this.layerGhost = svgEl('g', { class: 'p-ghost' }, svg);
    this.cross = this.makeCross('p-cross');
    this.remoteCross = this.makeCross('p-cross remote');
    this.layerFx = svgEl('g', { class: 'p-fx' }, svg);

    this.bindPointer();
  }

  makeCross(cls) {
    const g = svgEl('g', { class: cls, visibility: 'hidden' }, this.svg);
    const inner = svgEl('g', { class: 'p-cross-inner' }, g);
    svgEl('circle', { cx: 0, cy: 0, r: 3.6 }, inner);
    svgEl('path', { d: 'M-6 0 L-2 0 M2 0 L6 0 M0 -6 L0 -2 M0 2 L0 6' }, inner);
    return g;
  }

  placeCross(g, x, y, color) {
    g.setAttribute('visibility', 'visible');
    g.style.transform = `translate(${cx(x)}px, ${cy(y)}px)`;
    g.style.setProperty('--ink', color);
  }

  cellFromEvent(e) {
    const t = e.target.closest?.('.p-cell');
    if (t) {
      const i = Number(t.dataset.i);
      return { x: i % N, y: Math.floor(i / N) };
    }
    return null;
  }

  bindPointer() {
    const svg = this.svg;
    svg.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') this.world.hoverAt(this, this.cellFromEvent(e));
    });
    svg.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') this.world.hoverAt(this, null);
    });
    svg.addEventListener('pointerdown', (e) => {
      this.down = { x: e.clientX, y: e.clientY, button: e.button };
    });
    svg.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || d.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 14) return;
      const cell = this.cellFromEvent(e);
      if (!cell) return;
      const w = this.world;
      if (!w.interactive || w.interactive.id !== this.id) return;
      if (e.pointerType !== 'mouse') w.hoverAt(this, cell);
      w.handlers.onClick?.(this.id, cell, e.pointerType);
    });
    svg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.world.handlers.onContext?.();
    });
  }

  update(info, round) {
    if (round !== this.round) {
      this.round = round;
      this.pending.clear();
      this.prevKeys = new Set();
      this.initialized = false;
    }
    this.info = info;
    const ink = INK[info.color] || PENCIL;
    this.el.style.setProperty('--ink', ink);
    this.el.classList.toggle('turn', !!info.isTurn);
    this.el.classList.toggle('dead', !!info.eliminated);
    const status = info.eliminated ? '💀 versenkt' : !info.connected ? '📡 offline'
      : `⚓ ${info.board ? info.board.afloat : 5}/5`;
    this.head.innerHTML = `<span class="p-name">${info.winner ? '🏆 ' : info.bot ? '🤖 ' : ''}${escapeHtml(info.name)}${info.isMe ? ' <small>(Du)</small>' : ''}</span>`
      + `<span class="p-status">${info.isTurn ? '<b>✏️ am Zug</b> · ' : ''}${status}</span>`;

    const board = info.board || { shots: [], sunk: [], ships: null };
    const isPending = (x, y) => this.pending.has(G.key(x, y));
    const shots = board.shots.filter(([x, y]) => !isPending(x, y));
    const touchesPending = (s) => s.cells.some(([x, y]) => isPending(x, y));
    const known = info.ships || board.ships;
    const ships = known
      ? known.map((s) => (s.sunk && touchesPending(s) ? { ...s, sunk: false } : s))
      : board.sunk.filter((s) => !touchesPending(s)).map((s) => ({ ...s, sunk: true }));

    const around = new Map();
    for (const s of ships) if (s.sunk) for (const [x, y] of G.surroundings(s.cells)) around.set(G.key(x, y), [x, y]);
    const blocked = new Set([...board.shots.map(([x, y]) => G.key(x, y)), ...around.keys()]);
    for (const s of board.sunk) for (const [x, y] of G.surroundings(s.cells)) blocked.add(G.key(x, y));
    this.blocked = blocked;

    // Schiffe
    this.layerShips.replaceChildren();
    for (const s of ships) this.drawShip(s, ink);

    // Punkte rund um versenkte Schiffe
    this.layerAround.replaceChildren();
    const shotKeys = new Set(shots.map(([x, y]) => G.key(x, y)));
    for (const [k, [x, y]] of around) {
      if (!shotKeys.has(k)) svgEl('circle', { cx: cx(x), cy: cy(y), r: 0.7 }, this.layerAround);
    }

    // Treffer & Fehlschüsse
    this.layerMarks.replaceChildren();
    const keys = new Set();
    for (const [x, y, res] of shots) {
      const k = G.key(x, y);
      keys.add(k);
      const fresh = this.initialized && !this.prevKeys.has(k);
      if (res === 'miss') {
        svgEl('circle', { cx: cx(x), cy: cy(y), r: 1.4, class: `p-miss${fresh ? ' fresh' : ''}` }, this.layerMarks);
      } else {
        const g = svgEl('g', { class: `p-hit${fresh ? ' fresh' : ''}` }, this.layerMarks);
        const r = rng(this.seed + x * 13 + y * 7);
        const o = 3.2;
        svgEl('path', { d: wobblyLine(cx(x) - o, cy(y) - o, cx(x) + o, cy(y) + o, r, 0.6), pathLength: 1 }, g);
        svgEl('path', { d: wobblyLine(cx(x) + o, cy(y) - o, cx(x) - o, cy(y) + o, r, 0.6), pathLength: 1, class: 'second' }, g);
      }
    }
    this.prevKeys = keys;
    this.initialized = true;
  }

  drawShip(s, ink) {
    const [x0, y0] = s.cells[0];
    const [x1, y1] = s.cells[s.cells.length - 1];
    const pad = 1.3;
    const x = M + x0 * C + pad, y = M + y0 * C + pad;
    const w = (x1 - x0 + 1) * C - pad * 2, h = (y1 - y0 + 1) * C - pad * 2;
    const g = svgEl('g', { class: `p-ship${s.sunk ? ' sunk' : ''}${s.dim ? ' dim' : ''}` }, this.layerShips);
    svgEl('rect', { x, y, width: w, height: h, rx: Math.min(w, h) / 2, fill: `url(#p-hatch-${ink.slice(1)})`, stroke: ink }, g);
    // Bullaugen
    for (const [cx0, cy0] of s.cells) svgEl('circle', { cx: cx(cx0), cy: cy(cy0), r: 0.9, class: 'porthole', stroke: ink }, g);
    if (s.sunk) {
      const r = rng(this.seed + x0 * 3 + y0 * 5);
      const horizontal = s.dir === 'h';
      svgEl('path', {
        d: horizontal ? scribble(x + 1, y + h / 2, x + w - 1, y + h / 2, r) : scribble(x + w / 2, y + 1, x + w / 2, y + h - 1, r),
        class: 'p-scribble', pathLength: 1,
      }, g);
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export class PaperWorld {
  constructor(container, handlers = {}) {
    this.container = container;
    this.handlers = handlers;
    this.boards = new Map();
    this.order = [];
    this.focus = null;
    this.mode = 'menu';
    this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    this.interactive = null;
    this.hover = null;

    container.innerHTML = `
      <svg class="p-defs" width="0" height="0" aria-hidden="true">
        <defs>
          <filter id="p-pencil" x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="n"/>
            <feDisplacementMap in="SourceGraphic" in2="n" scale="0.9" xChannelSelector="R" yChannelSelector="G"/>
          </filter>
          ${INK.map((c) => `
          <pattern id="p-hatch-${c.slice(1)}" width="2.4" height="2.4" patternUnits="userSpaceOnUse" patternTransform="rotate(40)">
            <rect width="2.4" height="2.4" fill="${c}" fill-opacity="0.12"/>
            <line x1="0" y1="0" x2="0" y2="2.4" stroke="${c}" stroke-width="0.7" stroke-opacity="0.55"/>
          </pattern>`).join('')}
        </defs>
      </svg>
      <div class="p-doodles" aria-hidden="true">
        <svg viewBox="0 0 200 80" class="p-doodle-ship"><path d="M10 50 Q100 62 190 50 L172 68 Q100 76 28 68 Z"/><rect x="70" y="30" width="44" height="20" rx="4"/><rect x="84" y="14" width="10" height="16" rx="2"/><path d="M0 74 Q12 68 24 74 T48 74 T72 74 T96 74 T120 74 T144 74 T168 74 T192 74"/></svg>
      </div>
      <div class="p-stage"></div>`;
    this.stage = container.querySelector('.p-stage');
    this.onResize = () => this.layout();
    window.addEventListener('resize', this.onResize);
  }

  setMode(mode) {
    this.mode = mode;
    this.container.classList.toggle('menu', mode === 'menu');
  }

  setBoards(list, round) {
    const ids = list.map((b) => b.id);
    for (const [id, b] of this.boards) {
      if (!ids.includes(id)) {
        b.el.remove();
        this.boards.delete(id);
      }
    }
    list.forEach((info, i) => {
      let b = this.boards.get(info.id);
      if (!b) {
        b = new PaperBoard(this, info.id);
        this.boards.set(info.id, b);
      }
      if (this.stage.children[i] !== b.el) this.stage.insertBefore(b.el, this.stage.children[i] || null);
      b.update(info, round);
    });
    this.order = ids;
    if (this.interactive && !this.boards.has(this.interactive.id)) this.setInteractive(null);
    this.layout();
  }

  setFocus(target) {
    if (target === this.focus) return;
    this.focus = target;
    this.layout();
  }

  setInsets(insets) {
    this.insets = { top: 0, right: 0, bottom: 0, left: 0, ...insets };
    this.layout();
  }

  layout() {
    const ins = this.insets;
    Object.assign(this.stage.style, { top: `${ins.top}px`, bottom: `${ins.bottom}px`, left: `${ins.left}px`, right: `${ins.right}px` });
    const W = Math.max(160, window.innerWidth - ins.left - ins.right - 16);
    const H = Math.max(160, window.innerHeight - ins.top - ins.bottom - 8);
    const wide = W >= 620 && W > H * 1.2;
    let visible = this.order;
    if (!wide && this.focus && this.focus !== 'all' && this.order.includes(this.focus)) visible = [this.focus];
    const n = Math.max(1, visible.length);
    const head = 34, gap = 24;
    const size = Math.floor(Math.max(150, wide
      ? Math.min((W - gap * (n - 1)) / n, H - head)
      : Math.min(W, (H - head * n - gap * (n - 1)) / n)));
    this.stage.classList.toggle('wide', wide);
    for (const [id, b] of this.boards) {
      b.el.hidden = !visible.includes(id);
      b.el.style.width = `${size}px`;
      b.el.classList.toggle('focus', this.focus === id);
      b.el.classList.toggle('interactive', this.interactive?.id === id);
    }
  }

  setInteractive(opts) {
    const prev = this.interactive && this.boards.get(this.interactive.id);
    if (prev && (!opts || opts.id !== prev.id)) {
      prev.cross.setAttribute('visibility', 'hidden');
      prev.el.querySelector('.p-cell.hover')?.classList.remove('hover');
    }
    this.interactive = opts;
    this.hover = null;
    this.layout();
  }

  hoverAt(board, cell) {
    const it = this.interactive;
    if (!it || it.id !== board.id) return;
    const changed = (cell?.x ?? -1) !== (this.hover?.x ?? -1) || (cell?.y ?? -1) !== (this.hover?.y ?? -1);
    this.hover = cell;
    board.el.querySelector('.p-cell.hover')?.classList.remove('hover');
    const allowed = cell && (it.mode !== 'fire' || !board.blocked.has(G.key(cell.x, cell.y)));
    if (it.mode === 'fire' && allowed) {
      board.cells.children[cell.y * N + cell.x].classList.add('hover');
      board.placeCross(board.cross, cell.x, cell.y, INK[it.color]);
    } else board.cross.setAttribute('visibility', 'hidden');
    if (changed) this.handlers.onHover?.(it.id, cell);
  }

  setGhost(g) {
    for (const b of this.boards.values()) b.layerGhost.replaceChildren();
    if (!g) return;
    const b = this.boards.get(g.boardId);
    if (!b) return;
    const pad = 1.3;
    const w = (g.dir === 'h' ? g.len : 1) * C - pad * 2;
    const h = (g.dir === 'v' ? g.len : 1) * C - pad * 2;
    svgEl('rect', {
      x: M + g.x * C + pad, y: M + g.y * C + pad, width: w, height: h, rx: Math.min(w, h) / 2,
      class: g.ok ? 'ok' : 'bad',
    }, b.layerGhost);
  }

  setRemoteAim(boardId, x, y, color) {
    for (const b of this.boards.values()) {
      if (b.id === boardId) b.placeCross(b.remoteCross, x, y, INK[color ?? 0]);
      else b.remoteCross.setAttribute('visibility', 'hidden');
    }
  }

  /** "Bombe" fällt aufs Feld, dann Platsch / Bumm / Versenkt. */
  fireShot({ target, x, y, result, duration = 620 }) {
    const b = this.boards.get(target);
    if (!b) return Promise.resolve(false);
    b.pending.add(G.key(x, y));
    if (b.info) b.update(b.info, b.round);
    const px = cx(x), py = cy(y);
    const fx = b.layerFx;
    const bomb = svgEl('g', { class: 'p-bomb' }, fx);
    svgEl('circle', { cx: 0, cy: 0, r: 2.6 }, bomb);
    svgEl('path', { d: 'M1.6 -2 Q3.5 -5 5.5 -4.2' }, bomb);
    const trail = svgEl('path', { d: `M${px - 26} ${py - 46} Q${px - 14} ${py - 30} ${px} ${py}`, class: 'p-trail', pathLength: 1 }, fx);
    const anim = bomb.animate([
      { transform: `translate(${px - 26}px, ${py - 46}px) scale(1.8)`, opacity: 0 },
      { transform: `translate(${px - 18}px, ${py - 34}px) scale(1.5)`, opacity: 1, offset: 0.2 },
      { transform: `translate(${px}px, ${py}px) scale(0.9)`, opacity: 1 },
    ], { duration: Math.max(200, duration), easing: 'cubic-bezier(.45,0,.9,.6)' });
    return new Promise((resolve) => {
      anim.onfinish = () => {
        bomb.remove();
        trail.remove();
        b.pending.delete(G.key(x, y));
        if (b.info) b.update(b.info, b.round);
        this.impact(b, px, py, result);
        resolve(true);
      };
    });
  }

  impact(b, px, py, result) {
    const fx = b.layerFx;
    const r = rng(Math.floor(px * 7 + py * 11));
    const parts = [];
    const word = (text, cls, dy = -9) => {
      const t = svgEl('text', { x: px, y: py + dy, class: `p-word ${cls}`, 'text-anchor': 'middle' }, fx);
      t.textContent = text;
      parts.push(t);
    };
    if (result === 'miss') {
      for (let i = 0; i < 3; i++) {
        const c = svgEl('circle', { cx: px, cy: py, r: 2 + i * 2.2, class: 'p-ripple', style: `animation-delay:${i * 0.12}s` }, fx);
        parts.push(c);
      }
      word('platsch!', 'miss');
    } else {
      const big = result === 'sunk';
      const star = svgEl('path', { d: starPath(px, py, big ? 13 : 8.5, big ? 6 : 4, big ? 11 : 9, r), class: `p-boom${big ? ' big' : ''}` }, fx);
      parts.push(star);
      word(big ? 'VERSENKT!' : 'BUMM!', big ? 'sunk' : 'hit', big ? -15 : -11);
      b.el.classList.remove('shake');
      void b.el.offsetWidth;
      b.el.classList.add('shake');
    }
    setTimeout(() => parts.forEach((p) => p.remove()), 1500);
  }

  pause() { this.container.hidden = true; }
  resume() { this.container.hidden = false; this.layout(); }
}
