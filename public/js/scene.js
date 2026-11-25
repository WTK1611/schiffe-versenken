// 3D-Welt: Meer, Spielfelder, Schiffe, Effekte, Kamera und Mauseingabe.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { makeShip, paintShip } from './ships.js';

const G = window.Game;
const N = G.SIZE;
// Spielerfarben aus der HitYear-Palette (Pink, Cyan, Gelb, Grün)
export const PLAYER_COLORS = ['#ff3d9a', '#3dd8ff', '#ffd93d', '#3dffb0'];

const TILE_Y = 0.1;
const SHIP_Y = -0.1;      // Schiffe liegen etwas im Wasser
const WRECK_DEPTH = 0.62; // so weit sinkt ein Wrack
const SINK_SECONDS = 2.8;
const FONT = '"Nunito", ui-rounded, system-ui, sans-serif';

const COL = {
  tile: new THREE.Color('#e6f4ff'),
  tileAlt: new THREE.Color('#cfe6ff'),
  miss: new THREE.Color('#4f7fc4'),
  hit: new THREE.Color('#ff7a59'),
  sunk: new THREE.Color('#2b3442'),
  around: new THREE.Color('#9fd0e4'),
  dead: new THREE.Color('#8a96a3'),
};

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpC = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const rand = (a, b) => a + Math.random() * (b - a);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export const cellLocal = (x, y, h = TILE_Y) => new THREE.Vector3(x - 4.5, h, y - 4.5);

// ------------------------------------------------------------------ Wellen
// Dieselbe Formel wie im Wasser-Shader, damit Schiffe auf den Wellen reiten.

function sdBoard(px, pz, b) {
  const dx = px - b.x, dz = pz - b.z;
  const c = Math.cos(b.a), s = Math.sin(b.a);
  const lx = c * dx - s * dz, lz = s * dx + c * dz;
  const qx = Math.abs(lx) - 5.5, qz = Math.abs(lz) - 5.5;
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
}

function waveHeight(x, z, t, boards) {
  const h = Math.sin(x * 0.32 + t * 1.1) * 0.16 + Math.sin(z * 0.41 + t * 0.9) * 0.14
    + Math.sin((x + z) * 0.9 + t * 1.8) * 0.05 + Math.sin((x - z * 0.7) * 1.6 + t * 2.3) * 0.025;
  let calm = 1;
  for (const b of boards) calm = Math.min(calm, smooth(1, 5, sdBoard(x, z, b)));
  return h * (0.18 + 0.82 * calm);
}

const WATER_VERT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uBoards[4];
  uniform int uBoardCount;
  varying vec3 vWorld;
  varying float vH;
  varying float vCalm;
  varying float vEdge;
  float sdBoard(vec2 p, vec3 b) {
    vec2 d = p - b.xy;
    float c = cos(b.z), s = sin(b.z);
    vec2 l = vec2(c * d.x - s * d.y, s * d.x + c * d.y);
    vec2 q = abs(l) - vec2(5.5);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  }
  float boardDist(vec2 p) {
    float d = 1e5;
    for (int i = 0; i < 4; i++) { if (i >= uBoardCount) break; d = min(d, sdBoard(p, uBoards[i])); }
    return d;
  }
  float waves(vec2 p, float t) {
    return sin(p.x * 0.32 + t * 1.1) * 0.16 + sin(p.y * 0.41 + t * 0.9) * 0.14
         + sin((p.x + p.y) * 0.9 + t * 1.8) * 0.05 + sin((p.x - p.y * 0.7) * 1.6 + t * 2.3) * 0.025;
  }
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    float d = boardDist(w.xz);
    float calm = smoothstep(1.0, 5.0, d);
    float h = waves(w.xz, uTime) * (0.18 + 0.82 * calm);
    w.y += h;
    vWorld = w.xyz; vH = h; vCalm = calm; vEdge = d;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const WATER_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uDeep, uShallow, uFoam, uLagoon, uSky, uFogColor, uSunDir;
  uniform float uFogNear, uFogFar;
  varying vec3 vWorld;
  varying float vH;
  varying float vCalm;
  varying float vEdge;
  void main() {
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (n.y < 0.0) n = -n;
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 col = mix(uDeep, uShallow, smoothstep(-0.3, 0.35, vH));
    float f = sin(vWorld.x * 0.8 + sin(vWorld.z * 0.55 + uTime * 0.7) * 1.8 + uTime * 0.6)
            * sin(vWorld.z * 0.7 + sin(vWorld.x * 0.4 - uTime * 0.5) * 1.6);
    col = mix(col, uFoam, smoothstep(0.9, 0.99, f) * 0.14);
    col = mix(col, uFoam, smoothstep(0.3, 0.4, vH) * 0.45);
    float inside = 1.0 - smoothstep(-0.3, 0.3, vEdge);
    col = mix(col, uLagoon, inside * 0.5);
    float ring = smoothstep(1.8, 0.0, vEdge) * (1.0 - inside);
    col = mix(col, uFoam, ring * (0.5 + 0.5 * sin(vEdge * 7.0 - uTime * 3.0)) * 0.5);
    vec3 R = reflect(-uSunDir, n);
    float spec = pow(max(dot(R, V), 0.0), 80.0);
    col += step(0.5, spec) * 0.5 + spec * 0.25;
    float fr = pow(1.0 - max(dot(n, V), 0.0), 4.0);
    col = mix(col, uSky, fr * 0.55);
    float dist = length(vWorld - cameraPosition);
    col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, dist));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ------------------------------------------------------------------ Hilfen

function canvasTexture(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { canvas, ctx: canvas.getContext('2d'), tex };
}

function glowTexture() {
  const { ctx, tex } = canvasTexture(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,240,200,0.9)');
  g.addColorStop(0.6, 'rgba(255,160,60,0.35)');
  g.addColorStop(1, 'rgba(255,120,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return tex;
}

/** Partikel als InstancedMesh – günstig auch bei vielen Effekten. */
class Particles {
  constructor(scene, count, material) {
    this.count = count;
    this.mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), material, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.items = Array.from({ length: count }, () => ({
      life: 0, max: 1, size: 1, grow: 0, grav: 0, drag: 0,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
    }));
    this.zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this.m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      this.mesh.setMatrixAt(i, this.zero);
      this.mesh.setColorAt(i, COL.tile);
    }
    this.next = 0;
    this.active = 0;
    scene.add(this.mesh);
  }

  spawn(pos, vel, { life = 1, size = 0.1, color = '#fff', grav = 0, drag = 0, grow = 0 } = {}) {
    const i = this.next;
    this.next = (this.next + 1) % this.count;
    const p = this.items[i];
    if (p.life <= 0) this.active++;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.life = p.max = life;
    p.size = size;
    p.grav = grav;
    p.drag = drag;
    p.grow = grow;
    this.mesh.setColorAt(i, tmpC.set(color));
    this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt) {
    if (!this.active) return;
    let alive = 0;
    for (let i = 0; i < this.count; i++) {
      const p = this.items[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        this.mesh.setMatrixAt(i, this.zero);
        continue;
      }
      alive++;
      p.vel.y -= p.grav * dt;
      p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.pos.addScaledVector(p.vel, dt);
      const age = 1 - p.life / p.max;
      const s = p.size * Math.min(1, age * 8) * Math.pow(1 - age, 0.6) * (1 + p.grow * age);
      this.m.makeScale(s, s, s).setPosition(p.pos);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.active = alive;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ Spielfeld

class Board {
  constructor(world, id) {
    this.world = world;
    this.id = id;
    this.group = new THREE.Group();
    this.root = new THREE.Group();
    this.group.add(this.root);
    this.angle = 0;
    this.phase = Math.random() * 10;
    this.round = null;
    this.info = null;
    this.pending = new Set();
    this.hover = -1;
    this.hoverColor = new THREE.Color();
    this.blocked = new Set();
    this.cellState = [];
    this.ships = new Map();   // id -> Object3D
    this.flames = [];
    this.markerKeys = new Set();
    this.nameKey = '';
    this.initialized = false;

    const { geo, mat } = world;
    this.frameMat = new THREE.MeshStandardMaterial({ color: '#888888', roughness: 0.45 });
    for (const [x, z, horizontal] of [[0, -5.3, true], [0, 5.3, true], [-5.3, 0, false], [5.3, 0, false]]) {
      const beam = new THREE.Mesh(horizontal ? geo.beamH : geo.beamV, this.frameMat);
      beam.position.set(x, 0.1, z);
      beam.castShadow = beam.receiveShadow = true;
      this.root.add(beam);
    }
    for (const [x, z] of [[-5.3, -5.3], [5.3, -5.3], [-5.3, 5.3], [5.3, 5.3]]) {
      const buoy = new THREE.Mesh(geo.buoy, mat.white);
      buoy.position.set(x, 0.28, z);
      buoy.castShadow = true;
      const band = new THREE.Mesh(geo.buoyBand, this.frameMat);
      band.position.set(x, 0.3, z);
      this.root.add(buoy, band);
    }

    // Beschriftung A–J / 1–10 auf dem Rahmen
    this.labels = canvasTexture(1024, 1024);
    this.drawLabels();
    const labelMesh = new THREE.Mesh(geo.labelPlane, new THREE.MeshBasicMaterial({
      map: this.labels.tex, transparent: true, depthWrite: false,
    }));
    labelMesh.rotation.x = -Math.PI / 2;
    labelMesh.position.y = 0.29;
    labelMesh.renderOrder = 2;
    this.root.add(labelMesh);

    // Glas-Kacheln (auch Ziel für Mausklicks)
    this.tiles = new THREE.InstancedMesh(geo.tile, mat.tile, N * N);
    const m = new THREE.Matrix4();
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        m.makeTranslation(x - 4.5, TILE_Y, y - 4.5);
        this.tiles.setMatrixAt(y * N + x, m);
        this.tiles.setColorAt(y * N + x, (x + y) % 2 ? COL.tileAlt : COL.tile);
      }
    }
    this.tiles.renderOrder = 1;
    this.root.add(this.tiles);

    this.markers = new THREE.Group();
    this.shipGroup = new THREE.Group();
    this.root.add(this.markers, this.shipGroup);

    this.name = canvasTexture(640, 200);
    this.nameSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.name.tex, transparent: true, depthWrite: false }));
    this.nameSprite.scale.set(5.6, 1.75, 1);
    this.nameSprite.position.set(0, 1.9, -6.6);
    this.nameSprite.renderOrder = 5;
    this.group.add(this.nameSprite);
  }

  drawLabels() {
    const { ctx, tex } = this.labels;
    const ppu = 1024 / 11.2;
    ctx.clearRect(0, 0, 1024, 1024);
    ctx.font = `800 34px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < N; i++) {
      const c = (i - 4.5 + 5.6) * ppu;
      ctx.fillText('ABCDEFGHIJ'[i], c, (5.6 - 5.3) * ppu);
      ctx.fillText(String(i + 1), (5.6 - 5.3) * ppu, c);
    }
    tex.needsUpdate = true;
  }

  drawName(info) {
    const key = [info.name, info.color, info.isTurn, info.eliminated, info.connected, info.board?.afloat, info.isMe, info.bot, info.winner].join('|');
    if (key === this.nameKey) return;
    this.nameKey = key;
    const { ctx, tex } = this.name;
    ctx.clearRect(0, 0, 640, 200);
    const col = info.eliminated ? '#7b8794' : PLAYER_COLORS[info.color];
    ctx.save();
    ctx.shadowColor = 'rgba(10,40,80,0.35)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.roundRect(30, 22, 580, 130, 65);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.roundRect(30, 22, 580, 130, 65);
    ctx.stroke();
    ctx.fillStyle = info.eliminated ? '#ffffff' : '#160c26';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const prefix = info.winner ? '🏆 ' : info.bot ? '🤖 ' : '';
    ctx.font = `900 52px ${FONT}`;
    let label = prefix + info.name + (info.isMe ? ' (Du)' : '');
    while (ctx.measureText(label).width > 520 && label.length > 4) label = label.slice(0, -2) + '…';
    ctx.fillText(label, 320, 72);
    ctx.font = `800 30px ${FONT}`;
    const sub = info.eliminated ? '💀 Flotte versenkt'
      : !info.connected ? 'Verbindung weg …'
      : `⚓ ${info.board ? info.board.afloat : 5} von 5 Schiffen`;
    ctx.fillText(sub, 320, 122);
    tex.needsUpdate = true;
  }

  /** info: { name, color, isMe, isTurn, eliminated, connected, bot, board, ships? } */
  update(info, round) {
    if (round !== this.round) this.reset(round);
    this.info = info;
    this.frameMat.color.set(info.eliminated ? '#7b8794' : PLAYER_COLORS[info.color]);
    this.drawName(info);

    const board = info.board || { shots: [], sunk: [], ships: null };
    const isPending = (x, y) => this.pending.has(G.key(x, y));
    const shots = board.shots.filter(([x, y]) => !isPending(x, y));
    const touchesPending = (s) => s.cells.some(([x, y]) => isPending(x, y));

    // Welche Schiffe sind sichtbar? Eigene/aufgedeckte oder nur versenkte.
    const known = info.ships || board.ships;
    let ships;
    if (known) ships = known.map((s) => (s.sunk && touchesPending(s) ? { ...s, sunk: false } : s));
    else ships = board.sunk.filter((s) => !touchesPending(s)).map((s) => ({ ...s, sunk: true }));

    const occ = new Map();
    for (const s of ships) s.cells.forEach(([x, y], k) => occ.set(G.key(x, y), { s, k }));
    const shotMap = new Map(shots.map(([x, y, r]) => [G.key(x, y), r]));
    const sunkCells = new Set();
    const around = new Set();
    for (const s of ships) {
      if (!s.sunk) continue;
      for (const [x, y] of s.cells) sunkCells.add(G.key(x, y));
      for (const [x, y] of G.surroundings(s.cells)) around.add(G.key(x, y));
    }
    // Nicht anklickbar: beschossen oder sicher Wasser neben versenkten Schiffen
    const blocked = new Set([...board.shots.map(([x, y]) => G.key(x, y)), ...around]);
    for (const s of board.sunk) for (const [x, y] of G.surroundings(s.cells)) blocked.add(G.key(x, y));
    this.blocked = blocked;

    this.cellState = [];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const k = G.key(x, y);
        this.cellState.push(sunkCells.has(k) ? 'sunk' : shotMap.get(k) || (around.has(k) ? 'around' : null));
      }
    }
    this.paintTiles();
    this.syncShips(ships, shots);
    this.syncMarkers(shots, occ);
    this.initialized = true;
  }

  reset(round) {
    this.round = round;
    this.pending.clear();
    for (const obj of this.ships.values()) this.shipGroup.remove(obj);
    this.ships.clear();
    this.markers.clear();
    this.flames = [];
    this.markerKeys = new Set();
    this.initialized = false;
  }

  paintTiles() {
    const dead = this.info?.eliminated;
    for (let i = 0; i < N * N; i++) {
      const x = i % N, y = Math.floor(i / N);
      const st = this.cellState[i];
      tmpC.copy(st ? COL[st] : (x + y) % 2 ? COL.tileAlt : COL.tile);
      if (dead) tmpC.lerp(COL.dead, 0.45);
      if (i === this.hover) tmpC.lerp(this.hoverColor, 0.7);
      this.tiles.setColorAt(i, tmpC);
    }
    this.tiles.instanceColor.needsUpdate = true;
  }

  setHover(i, color) {
    if (i === this.hover && (!color || this.hoverColor.equals(color))) return;
    this.hover = i;
    if (color) this.hoverColor.copy(color);
    this.paintTiles();
  }

  syncShips(ships, shots) {
    const color = PLAYER_COLORS[this.info.color];
    const seen = new Set();
    const hitCells = new Set(shots.filter((s) => s[2] === 'hit').map(([x, y]) => G.key(x, y)));
    for (const s of ships) {
      const id = `${s.name}|${s.cells[0]}|${s.dir}|${color}`;
      seen.add(id);
      let obj = this.ships.get(id);
      if (!obj) {
        obj = makeShip({ len: s.len, name: s.name, color });
        const [x0, y0] = s.cells[0];
        const [x1, y1] = s.cells[s.cells.length - 1];
        obj.position.set((x0 + x1) / 2 - 4.5, SHIP_Y, (y0 + y1) / 2 - 4.5);
        obj.rotation.y = s.dir === 'h' ? 0 : -Math.PI / 2;
        obj.userData.baseY = SHIP_Y;
        obj.userData.phase = Math.random() * 10;
        obj.userData.side = Math.random() < 0.5 ? -1 : 1;
        obj.userData.sinkT = -1;
        obj.userData.roll = 0;
        this.shipGroup.add(obj);
        this.ships.set(id, obj);
      }
      const ud = obj.userData;
      ud.cells = s.cells;
      ud.hits = s.cells.filter(([x, y]) => hitCells.has(G.key(x, y))).length;
      if (s.sunk && !ud.sunk) {
        ud.sunk = true;
        paintShip(obj, 'sunk');
        // Neu versenkt → Untergang animieren, sonst direkt als Wrack zeigen
        ud.sinkT = this.initialized ? 0 : 1;
      } else if (!s.sunk) {
        ud.sunk = false;
        ud.sinkT = -1;
        paintShip(obj, s.dim ? 'dim' : null);
      }
    }
    for (const [id, obj] of this.ships) {
      if (!seen.has(id)) {
        this.shipGroup.remove(obj);
        this.ships.delete(id);
      }
    }
  }

  syncMarkers(shots, occ) {
    const { geo, mat } = this.world;
    const keyNow = shots.map((s) => s.join()).join(';') + '#' + [...this.ships.keys()].join(';');
    if (keyNow === this.markerSig) return;
    this.markerSig = keyNow;
    // Flammen hängen teils an Schiffen → überall entfernen
    for (const f of this.flames) f.parent?.remove(f);
    this.flames = [];
    this.markers.clear();
    const prev = this.markerKeys;
    this.markerKeys = new Set();
    const now = this.world.time;

    for (const [x, y, r] of shots) {
      const k = G.key(x, y);
      this.markerKeys.add(k);
      const fresh = this.initialized && !prev.has(k);
      if (r === 'miss') {
        const peg = new THREE.Mesh(geo.peg, mat.pegWhite);
        peg.position.copy(cellLocal(x, y, 0.16));
        peg.userData = { born: fresh ? now : -10, base: 0.12, bob: Math.random() * 6 };
        this.markers.add(peg);
        continue;
      }
      const hit = occ.get(k);
      const ship = hit && [...this.ships.values()].find((o) => o.userData.cells === hit.s.cells);
      if (ship) {
        // Flamme sitzt auf dem Schiff und sinkt mit ihm
        const flame = this.makeFlame(0.75);
        flame.position.set(hit.k - (hit.s.len - 1) / 2, 0.62, 0);
        ship.add(flame);
        this.flames.push(flame);
      } else {
        const peg = new THREE.Mesh(geo.peg, mat.pegRed);
        peg.position.copy(cellLocal(x, y, 0.18));
        peg.userData = { born: fresh ? now : -10, base: 0.16, bob: Math.random() * 6 };
        this.markers.add(peg);
        for (let d = 0; d < 2; d++) {
          const debris = new THREE.Mesh(geo.debris, mat.debris);
          debris.position.copy(cellLocal(x + rand(-0.3, 0.3), y + rand(-0.3, 0.3), 0.08));
          debris.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
          this.markers.add(debris);
        }
        const flame = this.makeFlame(0.6);
        flame.position.copy(cellLocal(x, y, 0.45));
        this.markers.add(flame);
        this.flames.push(flame);
      }
    }
  }

  makeFlame(size) {
    const s = new THREE.Sprite(this.world.mat.flame);
    s.userData = { size, phase: Math.random() * 10 };
    s.scale.setScalar(size);
    s.renderOrder = 4;
    return s;
  }

  tick(t, dt) {
    const w = this.world;
    // sanftes Schaukeln des schwimmenden Rahmens
    const p = this.group.position;
    this.root.position.y = waveHeight(p.x, p.z, t, w.boardShapes) * 0.8;
    this.root.rotation.x = Math.sin(t * 0.9 + this.phase) * 0.012;
    this.root.rotation.z = Math.cos(t * 0.7 + this.phase) * 0.012;

    for (const obj of this.ships.values()) {
      const ud = obj.userData;
      if (ud.sinkT >= 0) {
        if (ud.sinkT < 1) {
          ud.sinkT = Math.min(1, ud.sinkT + dt / SINK_SECONDS);
          if (Math.random() < 0.6) w.bubbles(obj);
        }
        const e = easeInOut(ud.sinkT);
        const lurch = Math.sin(Math.min(1, ud.sinkT * 3) * Math.PI) * 0.12;
        obj.position.y = ud.baseY - WRECK_DEPTH * e + lurch;
        obj.rotation.z = -0.3 * e;
        obj.rotation.x = 0.38 * e * ud.side;
      } else {
        // Schlagseite wächst mit jedem Treffer
        const target = Math.min(0.2, ud.hits * 0.05) * ud.side;
        ud.roll += (target - ud.roll) * Math.min(1, dt * 2);
        obj.position.y = ud.baseY + Math.sin(t * 1.6 + ud.phase) * 0.025 - ud.hits * 0.02;
        obj.rotation.x = ud.roll + Math.sin(t * 1.3 + ud.phase) * 0.02;
        obj.rotation.z = Math.cos(t * 1.1 + ud.phase) * 0.015;
      }
    }

    for (const f of this.flames) {
      const u = f.userData;
      const k = 1 + Math.sin(t * 19 + u.phase) * 0.18 + Math.sin(t * 31 + u.phase * 2) * 0.1;
      f.scale.set(u.size * k, u.size * k * 1.25, 1);
    }

    for (const m of this.markers.children) {
      const u = m.userData;
      if (u.base === undefined) continue;
      const age = t - u.born;
      const pop = age < 0.5 ? 1 + Math.sin(age / 0.5 * Math.PI) * 0.8 : 1;
      m.scale.setScalar(Math.min(1, age * 6) * pop);
      m.position.y = u.base + Math.sin(t * 2 + u.bob) * 0.03;
    }

    if (this.info?.isTurn) {
      const s = 1 + Math.sin(t * 5) * 0.05;
      this.nameSprite.scale.set(5.6 * s, 1.75 * s, 1);
    } else this.nameSprite.scale.set(5.6, 1.75, 1);
  }

  cellWorld(x, y, h = TILE_Y) {
    return this.root.localToWorld(cellLocal(x, y, h));
  }
}

// ------------------------------------------------------------------ Welt

export class World {
  constructor(canvas, handlers = {}, quality = 'normal') {
    this.handlers = handlers;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.quality = quality;
    this.fxScale = 1;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
    this.time = 0;
    this.mode = 'menu';
    this.focus = null;
    this.boards = new Map();
    this.boardShapes = [];
    this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    this.camPos = new THREE.Vector3(0, 30, 50);
    this.camLook = new THREE.Vector3();
    this.camGoalPos = new THREE.Vector3();
    this.camGoalLook = new THREE.Vector3();
    this.shake = 0;
    this.projectiles = [];
    this.ripples = [];
    this.interactive = null; // { id, mode, color }
    this.hoverCell = null;

    this.buildEnvironment();
    this.buildShared();
    this.buildDecor();
    this.buildPointers();

    this.fx = new Particles(this.scene, 900, new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    this.puffs = new Particles(this.scene, 700, new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true, roughness: 1 }));
    this.flash = new THREE.PointLight('#ffb35c', 0, 14, 2);
    this.scene.add(this.flash);

    this.cross = this.makeCrosshair();
    this.remoteCross = this.makeCrosshair();
    this.ghost = null;

    window.addEventListener('resize', () => this.resize());
    this.setQuality(quality);
    this.clock = new THREE.Clock();
    this.running = true;
    this.renderer.setAnimationLoop(() => this.frame());
    document.fonts?.ready.then(() => {
      for (const b of this.boards.values()) {
        b.drawLabels();
        b.nameKey = '';
        if (b.info) b.drawName(b.info);
      }
    });
  }

  // ---------------------------------------------------------- Aufbau

  buildEnvironment() {
    const sky = canvasTexture(4, 512);
    const g = sky.ctx.createLinearGradient(0, 0, 0, 512);
    // Abendhimmel in den HitYear-Farben: Nachtviolett oben, pink-orangenes Glühen am Horizont
    g.addColorStop(0, '#0b0716');
    g.addColorStop(0.42, '#2a1458');
    g.addColorStop(0.72, '#8a2f8f');
    g.addColorStop(0.9, '#ff5f9e');
    g.addColorStop(1, '#ffa66b');
    sky.ctx.fillStyle = g;
    sky.ctx.fillRect(0, 0, 4, 512);
    this.scene.background = sky.tex;
    const fogColor = new THREE.Color('#b8508f');
    this.scene.fog = new THREE.Fog(fogColor, 60, 150);

    this.scene.add(new THREE.HemisphereLight('#c9b8ff', '#1a2a6b', 1.9));
    const sun = new THREE.DirectionalLight('#ffd0a8', 2.4);
    sun.position.set(-14, 26, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 90 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target);
    this.sun = sun;

    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(300, 300, 260, 260).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        vertexShader: WATER_VERT,
        fragmentShader: WATER_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uBoards: { value: [0, 1, 2, 3].map(() => new THREE.Vector3(1e4, 1e4, 0)) },
          uBoardCount: { value: 0 },
          uDeep: { value: new THREE.Color('#0c1a55') },
          uShallow: { value: new THREE.Color('#2465c9') },
          uFoam: { value: new THREE.Color('#ffffff') },
          uLagoon: { value: new THREE.Color('#3dd8ff') },
          uSky: { value: new THREE.Color('#ff8cc6') },
          uFogColor: { value: fogColor },
          uFogNear: { value: 60 },
          uFogFar: { value: 150 },
          uSunDir: { value: new THREE.Vector3(0.1, 0.35, -1).normalize() },
        },
      }),
    );
    this.scene.add(this.water);

    // verspielte Wölkchen
    this.clouds = new THREE.Group();
    const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffe3f2', flatShading: true, roughness: 1, fog: false, emissive: '#ff7ab8', emissiveIntensity: 0.28 });
    const puff = new THREE.IcosahedronGeometry(1, 1);
    for (let i = 0; i < 12; i++) {
      const c = new THREE.Group();
      const n = 4 + Math.floor(Math.random() * 3);
      for (let k = 0; k < n; k++) {
        const m = new THREE.Mesh(puff, cloudMat);
        m.position.set((k - n / 2) * 2.2 + rand(-0.5, 0.5), rand(-0.3, 0.8), rand(-1, 1));
        m.scale.setScalar(rand(1.8, 3.2));
        c.add(m);
      }
      const a = (i / 12) * Math.PI * 2 + rand(-0.2, 0.2);
      const r = rand(85, 110);
      c.position.set(Math.sin(a) * r, rand(22, 38), Math.cos(a) * r);
      c.lookAt(0, c.position.y, 0);
      this.clouds.add(c);
    }
    this.scene.add(this.clouds);

    // Sterne (nur in der erweiterten Qualität)
    const starGeo = new THREE.BufferGeometry();
    const pts = [];
    for (let i = 0; i < 500; i++) {
      const a = Math.random() * Math.PI * 2, e = 0.15 + Math.random() * 1.3;
      pts.push(Math.cos(a) * Math.cos(e) * 180, Math.sin(e) * 180, Math.sin(a) * Math.cos(e) * 180);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85 }));
    this.scene.add(this.stars);
  }

  // ---------------------------------------------------------- Qualität

  /** 'normal' – schlank für Handys; 'erweitert' – Schatten, Glühen (Bloom), Sterne, mehr Partikel. */
  setQuality(q) {
    this.quality = q === 'erweitert' ? 'erweitert' : 'normal';
    const hi = this.quality === 'erweitert';
    this.fxScale = hi ? 1 : 0.5;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, hi ? 2 : 1.25));
    this.renderer.shadowMap.enabled = hi;
    this.sun.castShadow = hi;
    this.scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
    this.stars.visible = hi;
    if (hi && !this.composer) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.5, 0.82);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }
    this.resize();
  }

  pause() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
    this.renderer.domElement.style.display = 'none';
  }

  resume() {
    if (this.running) return;
    this.running = true;
    this.renderer.domElement.style.display = '';
    this.clock.getDelta();
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  buildShared() {
    this.geo = {
      beamH: new RoundedBoxGeometry(11.2, 0.36, 0.6, 2, 0.14),
      beamV: new RoundedBoxGeometry(0.6, 0.36, 10.0, 2, 0.14),
      buoy: new THREE.SphereGeometry(0.42, 20, 14),
      buoyBand: new THREE.CylinderGeometry(0.435, 0.435, 0.16, 20),
      labelPlane: new THREE.PlaneGeometry(11.2, 11.2),
      tile: new THREE.BoxGeometry(0.9, 0.04, 0.9),
      peg: new THREE.SphereGeometry(0.14, 16, 12),
      debris: new THREE.BoxGeometry(0.16, 0.05, 0.1),
      ring: new THREE.RingGeometry(0.5, 0.62, 40).rotateX(-Math.PI / 2),
      shell: new THREE.CapsuleGeometry(0.09, 0.22, 4, 10),
    };
    this.mat = {
      white: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4 }),
      tile: new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthWrite: false }),
      pegWhite: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.3, emissive: '#bfe9ff', emissiveIntensity: 0.25 }),
      pegRed: new THREE.MeshStandardMaterial({ color: '#ff3b3b', roughness: 0.35, emissive: '#ff2a00', emissiveIntensity: 0.45 }),
      debris: new THREE.MeshStandardMaterial({ color: '#3b3f47', roughness: 1 }),
      flame: new THREE.SpriteMaterial({ map: glowTexture(), color: '#ffb347', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
      shell: new THREE.MeshStandardMaterial({ color: '#2b2f38', roughness: 0.4, metalness: 0.6, emissive: '#ff7b00', emissiveIntensity: 0.4 }),
    };
  }

  buildDecor() {
    // Schiffe, die im Menü übers Meer schippern
    this.decor = new THREE.Group();
    const fleet = [
      ['Flugzeugträger', 5, 0, 15], ['Schlachtschiff', 4, 1, 10], ['Kreuzer', 3, 2, 19],
      ['U-Boot', 3, 3, 7], ['Zerstörer', 2, 0, 13],
    ];
    fleet.forEach(([name, len, color, r], i) => {
      const ship = makeShip({ name, len, color: PLAYER_COLORS[color] });
      ship.scale.setScalar(1.5);
      ship.userData = { ...ship.userData, r, a: (i / fleet.length) * Math.PI * 2, speed: (0.06 + Math.random() * 0.04) * (i % 2 ? -1 : 1), phase: i };
      this.decor.add(ship);
    });
    this.scene.add(this.decor);
  }

  makeCrosshair() {
    const g = new THREE.Group();
    const m = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.95, depthWrite: false, depthTest: false });
    const ring = new THREE.Mesh(this.geo.ring, m);
    g.add(ring);
    for (let i = 0; i < 4; i++) {
      const tick = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.02, 0.26), m);
      const a = (i * Math.PI) / 2;
      tick.position.set(Math.sin(a) * 0.62, 0, Math.cos(a) * 0.62);
      tick.rotation.y = a;
      g.add(tick);
    }
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.08, 16).rotateX(-Math.PI / 2), m);
    g.add(dot);
    g.renderOrder = 10;
    g.traverse((o) => { o.renderOrder = 10; });
    g.visible = false;
    g.userData.mat = m;
    g.userData.goal = new THREE.Vector3();
    return g;
  }

  // ---------------------------------------------------------- Öffentliche API

  setMode(mode) {
    this.mode = mode;
    this.decor.visible = mode === 'menu';
  }

  /**
   * list: [{ id, name, color, isMe, isTurn, eliminated, connected, bot, winner, board, ships? }]
   * Reihenfolge = Anordnung. Bei zwei Feldern liegen sie nebeneinander.
   */
  setBoards(list, round) {
    const ids = new Set(list.map((b) => b.id));
    for (const [id, b] of this.boards) {
      if (!ids.has(id)) {
        this.scene.remove(b.group);
        this.boards.delete(id);
      }
    }
    const n = list.length;
    list.forEach((info, i) => {
      let b = this.boards.get(info.id);
      if (!b) {
        b = new Board(this, info.id);
        this.boards.set(info.id, b);
        this.scene.add(b.group);
      }
      if (n === 2) {
        b.group.position.set(i === 0 ? -7.2 : 7.2, 0, 0);
        b.angle = 0;
      } else {
        const R = [0, 0, 0, 10.2, 12.2][n] || 12;
        const a = (i / n) * Math.PI * 2;
        b.group.position.set(Math.sin(a) * R, 0, Math.cos(a) * R);
        b.angle = a;
      }
      b.group.rotation.y = b.angle;
      b.update(info, round);
    });
    this.boardShapes = [...this.boards.values()].map((b) => ({ x: b.group.position.x, z: b.group.position.z, a: b.angle }));
    const u = this.water.material.uniforms;
    u.uBoardCount.value = Math.min(4, this.boardShapes.length);
    this.boardShapes.slice(0, 4).forEach((s, i) => u.uBoards.value[i].set(s.x, s.z, s.a));
    if (this.interactive && !this.boards.has(this.interactive.id)) this.setInteractive(null);
  }

  /** 'all', eine Board-ID oder null (Menü-Kamera). */
  setFocus(target) {
    this.focus = target;
  }

  setInsets(insets) {
    this.insets = { top: 0, right: 0, bottom: 0, left: 0, ...insets };
    this.applyViewOffset();
  }

  /** Welches Feld reagiert auf die Maus: { id, mode: 'fire'|'place', color } oder null. */
  setInteractive(opts) {
    const prev = this.interactive && this.boards.get(this.interactive.id);
    if (prev && (!opts || opts.id !== this.interactive.id)) prev.setHover(-1);
    this.interactive = opts ? { ...opts, colorObj: new THREE.Color(PLAYER_COLORS[opts.color ?? 0]) } : null;
    if (!opts) {
      this.cross.visible = false;
      this.hoverCell = null;
    }
    this.refreshHover();
  }

  /** Vorschau beim Platzieren: { boardId, name, len, dir, x, y, ok } oder null. */
  setGhost(g) {
    if (!g) {
      if (this.ghost) this.ghost.obj.visible = false;
      return;
    }
    const board = this.boards.get(g.boardId);
    if (!board) return;
    if (!this.ghost || this.ghost.name !== g.name) {
      if (this.ghost) this.ghost.obj.parent?.remove(this.ghost.obj);
      const obj = makeShip({ len: g.len, name: g.name, color: '#ffffff' });
      obj.traverse((o) => { o.renderOrder = 6; });
      this.ghost = { name: g.name, obj, ok: null };
    }
    const { obj } = this.ghost;
    if (obj.parent !== board.root) board.root.add(obj);
    if (this.ghost.ok !== g.ok) {
      paintShip(obj, g.ok ? 'ghostOk' : 'ghostBad');
      this.ghost.ok = g.ok;
    }
    const cx = g.dir === 'h' ? g.x + (g.len - 1) / 2 : g.x;
    const cy = g.dir === 'v' ? g.y + (g.len - 1) / 2 : g.y;
    obj.position.set(cx - 4.5, 0.05, cy - 4.5);
    obj.rotation.y = g.dir === 'h' ? 0 : -Math.PI / 2;
    obj.visible = true;
  }

  /** Fadenkreuz eines anderen Spielers (Live-Zielen). */
  setRemoteAim(boardId, x, y, color) {
    const board = boardId && this.boards.get(boardId);
    const c = this.remoteCross;
    if (!board) {
      c.visible = false;
      return;
    }
    const goal = cellLocal(x, y, 0.2);
    if (c.parent !== board.root || !c.visible) {
      board.root.add(c);
      c.position.copy(goal);
    }
    c.userData.goal.copy(goal);
    c.userData.mat.color.set(PLAYER_COLORS[color ?? 0]);
    c.visible = true;
  }

  /** Granate fliegt vom Schützen zum Ziel. Promise löst bei Einschlag auf.
   *  duration (ms) kommt vom Server-Einschlagzeitpunkt, damit alle Geräte gleichzeitig einschlagen. */
  fireShot({ by, target, x, y, result, duration }) {
    const tb = this.boards.get(target);
    if (!tb) return Promise.resolve(false);
    const k = G.key(x, y);
    tb.pending.add(k);
    if (tb.info) tb.update(tb.info, tb.round);

    const sb = this.boards.get(by);
    const start = new THREE.Vector3();
    if (sb) {
      // Aus einem eigenen, noch schwimmenden Schiff feuern, wenn sichtbar
      const ships = [...sb.ships.values()].filter((o) => !o.userData.sunk);
      if (ships.length) ships[Math.floor(Math.random() * ships.length)].getWorldPosition(start);
      else sb.root.getWorldPosition(start);
      start.y += 0.7;
    } else start.set(0, 20, 30);
    const end = tb.cellWorld(x, y, 0.15);
    const dist = start.distanceTo(end);
    const ctrl = start.clone().lerp(end, 0.5);
    ctrl.y += 4 + dist * 0.35;

    // Mündungsfeuer
    for (let i = 0; i < 14; i++) {
      this.fx.spawn(start, tmpV.set(rand(-1, 1), rand(1, 3), rand(-1, 1)), { life: rand(0.2, 0.4), size: rand(0.08, 0.16), color: i % 2 ? '#ffd166' : '#ff8c42', drag: 3 });
    }
    for (let i = 0; i < 6; i++) {
      this.puffs.spawn(start, tmpV.set(rand(-0.5, 0.5), rand(0.5, 1.2), rand(-0.5, 0.5)), { life: rand(0.8, 1.3), size: rand(0.18, 0.3), color: '#e9eef3', grow: 1.5, drag: 1.5 });
    }

    const shell = new THREE.Mesh(this.geo.shell, this.mat.shell);
    shell.castShadow = true;
    this.scene.add(shell);
    return new Promise((resolve) => {
      this.projectiles.push({
        shell, start, ctrl, end, t: 0, dur: duration ? duration / 1000 : 0.95 + dist * 0.025, board: tb, key: k, result, resolve, trail: 0,
      });
    });
  }

  // ---------------------------------------------------------- Effekte

  splash(p, big = false) {
    const n = Math.round((big ? 50 : 30) * this.fxScale);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = rand(0.5, 1.6);
      this.fx.spawn(p, tmpV.set(Math.cos(a) * r, rand(3, big ? 7 : 5.5), Math.sin(a) * r), {
        life: rand(0.7, 1.1), size: rand(0.06, 0.14), color: i % 3 ? '#ffffff' : '#a6e7ff', grav: 11,
      });
    }
    for (let i = 0; i < 8; i++) {
      this.puffs.spawn(p, tmpV.set(rand(-0.6, 0.6), rand(0.4, 1.2), rand(-0.6, 0.6)), { life: rand(0.6, 1), size: rand(0.2, 0.35), color: '#ffffff', grow: 1, drag: 2 });
    }
    this.ripple(p, '#ffffff', 1.8);
  }

  explode(p, big = false) {
    const n = Math.round((big ? 90 : 48) * this.fxScale);
    const colors = ['#fff4b8', '#ffd166', '#ff9f1c', '#ff5d3b'];
    for (let i = 0; i < n; i++) {
      const v = tmpV.set(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).normalize().multiplyScalar(rand(2, big ? 8 : 6));
      v.y += 2;
      this.fx.spawn(p, v, { life: rand(0.4, 0.9), size: rand(0.1, big ? 0.32 : 0.24), color: colors[i % 4], grav: 5, drag: 1.8 });
    }
    for (let i = 0; i < (big ? 26 : 14) * this.fxScale; i++) {
      this.puffs.spawn(tmpV2.copy(p).add(tmpV.set(rand(-0.3, 0.3), rand(0, 0.4), rand(-0.3, 0.3))),
        tmpV.set(rand(-0.8, 0.8), rand(0.8, 2.2), rand(-0.8, 0.8)),
        { life: rand(1.2, 2.2), size: rand(0.25, big ? 0.6 : 0.45), color: i % 2 ? '#4d5058' : '#757984', grav: -0.6, drag: 1.2, grow: 1.4 });
    }
    // Trümmer
    for (let i = 0; i < (big ? 16 : 8); i++) {
      this.puffs.spawn(p, tmpV.set(rand(-3, 3), rand(3, 6), rand(-3, 3)), { life: rand(0.8, 1.2), size: rand(0.05, 0.1), color: '#2a2d33', grav: 12 });
    }
    this.flash.position.copy(p).add(tmpV.set(0, 0.8, 0));
    this.flash.intensity = big ? 220 : 120;
    this.ripple(p, '#ffb26b', big ? 3 : 2);
    this.shake = Math.max(this.shake, big ? 0.55 : 0.3);
  }

  bubbles(obj) {
    obj.getWorldPosition(tmpV2);
    tmpV2.x += rand(-1, 1);
    tmpV2.z += rand(-1, 1);
    tmpV2.y = 0.1;
    this.fx.spawn(tmpV2, tmpV.set(rand(-0.2, 0.2), rand(0.6, 1.4), rand(-0.2, 0.2)), { life: rand(0.4, 0.8), size: rand(0.05, 0.11), color: '#e8fbff', drag: 1 });
    if (Math.random() < 0.15) this.ripple(tmpV2, '#ffffff', 1.2);
  }

  ripple(p, color, scale) {
    const m = new THREE.Mesh(this.geo.ring, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false }));
    m.position.set(p.x, Math.max(0.12, p.y - 0.05), p.z);
    m.renderOrder = 3;
    this.scene.add(m);
    this.ripples.push({ m, t: 0, dur: 1.1, scale });
  }

  // ---------------------------------------------------------- Eingabe

  buildPointers() {
    const el = this.renderer.domElement;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pointerInside = false;

    const updateFrom = (e) => {
      const r = el.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.pointerInside = true;
      this.refreshHover();
    };
    el.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') updateFrom(e); });
    el.addEventListener('pointerdown', (e) => {
      this.down = { x: e.clientX, y: e.clientY, type: e.pointerType, button: e.button };
      updateFrom(e);
    });
    el.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || d.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12) return;
      updateFrom(e);
      if (this.interactive && this.hoverCell) {
        this.handlers.onClick?.(this.interactive.id, this.hoverCell, e.pointerType);
      }
    });
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.pointerInside = false;
      this.refreshHover();
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.handlers.onContext?.();
    });
  }

  refreshHover() {
    let cell = null;
    const it = this.interactive;
    const board = it && this.boards.get(it.id);
    if (board && this.pointerInside) {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = this.raycaster.intersectObject(board.tiles, false)[0];
      if (hit && hit.instanceId != null) cell = { x: hit.instanceId % N, y: Math.floor(hit.instanceId / N) };
    }
    const changed = (cell?.x ?? -1) !== (this.hoverCell?.x ?? -1) || (cell?.y ?? -1) !== (this.hoverCell?.y ?? -1);
    this.hoverCell = cell;
    if (board) {
      const allowed = cell && (it.mode !== 'fire' || !board.blocked.has(G.key(cell.x, cell.y)));
      board.setHover(allowed && it.mode === 'fire' ? cell.y * N + cell.x : -1, it.colorObj);
      if (it.mode === 'fire' && allowed) {
        if (this.cross.parent !== board.root) board.root.add(this.cross);
        this.cross.userData.goal.copy(cellLocal(cell.x, cell.y, 0.2));
        if (!this.cross.visible) this.cross.position.copy(this.cross.userData.goal);
        this.cross.userData.mat.color.copy(it.colorObj);
        this.cross.visible = true;
      } else this.cross.visible = false;
    }
    if (changed) this.handlers.onHover?.(it ? it.id : null, cell);
  }

  // ---------------------------------------------------------- Kamera

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
    this.camera.aspect = w / h;
    this.applyViewOffset();
  }

  applyViewOffset() {
    if (!this.size) return;
    const { w, h } = this.size;
    const i = this.insets;
    this.camera.setViewOffset(w, h, -(i.left - i.right) / 2, -(i.top - i.bottom) / 2, w, h);
    this.camera.updateProjectionMatrix();
  }

  fitDistance(width, depth, elev) {
    const { w, h } = this.size;
    const i = this.insets;
    const availW = Math.max(120, w - i.left - i.right);
    const availH = Math.max(120, h - i.top - i.bottom);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * (availH / h);
    const tanH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * (w / h) * (availW / w);
    return Math.max((width / 2) / tanH, (depth * Math.sin(elev) / 2 + 1.2) / tanV) * 1.08;
  }

  updateCameraGoal(t) {
    const boards = [...this.boards.values()];
    if (this.mode === 'menu' || !boards.length) {
      const a = t * 0.04;
      this.camGoalPos.set(Math.sin(a) * 36, 15, Math.cos(a) * 36);
      this.camGoalLook.set(0, 0, 0);
      return;
    }
    const elev = THREE.MathUtils.degToRad(56);
    const focusBoard = this.focus && this.focus !== 'all' && this.boards.get(this.focus);
    let center, width, depth, outward;
    if (focusBoard) {
      center = focusBoard.group.position.clone();
      outward = new THREE.Vector3(Math.sin(focusBoard.angle), 0, Math.cos(focusBoard.angle));
      width = 12.2;
      depth = 13.4;
    } else {
      center = new THREE.Vector3();
      boards.forEach((b) => center.add(b.group.position));
      center.divideScalar(boards.length);
      outward = new THREE.Vector3(0, 0, 1);
      const xs = boards.map((b) => b.group.position.x);
      width = Math.max(...xs) - Math.min(...xs) + 12.2;
      depth = boards.length > 2 ? width : 13.4;
    }
    const d = this.fitDistance(width, depth, elev);
    this.camGoalLook.copy(center).addScaledVector(outward, -0.4);
    this.camGoalPos.copy(center).addScaledVector(outward, Math.cos(elev) * d).addScaledVector(UP, Math.sin(elev) * d);
  }

  // ---------------------------------------------------------- Schleife

  frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = (this.time += dt);
    this.water.material.uniforms.uTime.value = t;
    this.clouds.rotation.y = t * 0.004;

    if (this.decor.visible) {
      for (const ship of this.decor.children) {
        const u = ship.userData;
        u.a += u.speed * dt;
        const x = Math.cos(u.a) * u.r, z = Math.sin(u.a) * u.r;
        const vx = -Math.sin(u.a) * Math.sign(u.speed), vz = Math.cos(u.a) * Math.sign(u.speed);
        ship.position.set(x, waveHeight(x, z, t, []) - 0.15, z);
        ship.rotation.set(Math.sin(t * 1.4 + u.phase) * 0.05, Math.atan2(-vz, vx), Math.cos(t * 1.1 + u.phase) * 0.04);
        if (Math.random() < 0.25) {
          tmpV2.set(x - vx * u.len * 0.75, 0.1, z - vz * u.len * 0.75);
          this.puffs.spawn(tmpV2, tmpV.set(rand(-0.2, 0.2), 0.2, rand(-0.2, 0.2)), { life: 1.4, size: rand(0.12, 0.22), color: '#ffffff', grow: 1 });
        }
      }
    }

    for (const b of this.boards.values()) b.tick(t, dt);

    // Kamera fliegt, Maus steht still: Feld unter dem Zeiger regelmäßig neu bestimmen
    if (this.interactive && this.pointerInside && !this.down && t - (this.lastHoverCheck || 0) > 0.12) {
      this.lastHoverCheck = t;
      this.refreshHover();
    }

    // Rauch aus brennenden Stellen
    this.smokeAcc = (this.smokeAcc || 0) + dt;
    if (this.smokeAcc > 0.06 / this.fxScale) {
      this.smokeAcc = 0;
      const flames = [];
      for (const b of this.boards.values()) flames.push(...b.flames);
      if (flames.length) {
        const f = flames[Math.floor(Math.random() * flames.length)];
        f.getWorldPosition(tmpV2);
        if (tmpV2.y > -0.1) {
          tmpV2.y += 0.2;
          this.puffs.spawn(tmpV2, tmpV.set(rand(-0.15, 0.15), rand(0.9, 1.5), rand(-0.15, 0.15)), {
            life: rand(1.4, 2.2), size: rand(0.12, 0.2), color: Math.random() < 0.5 ? '#5a5d66' : '#7d818b', grow: 2.4, drag: 0.6,
          });
        }
      }
    }

    // Projektile
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.t += dt / p.dur;
      const u = Math.min(1, p.t);
      const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
      const prev = p.shell.position.clone();
      p.shell.position.set(
        a * p.start.x + b * p.ctrl.x + c * p.end.x,
        a * p.start.y + b * p.ctrl.y + c * p.end.y,
        a * p.start.z + b * p.ctrl.z + c * p.end.z,
      );
      tmpV.subVectors(p.shell.position, prev);
      if (tmpV.lengthSq() > 1e-8) p.shell.quaternion.setFromUnitVectors(UP, tmpV.normalize());
      p.trail += dt;
      if (p.trail > 0.016 / this.fxScale) {
        p.trail = 0;
        this.fx.spawn(p.shell.position, tmpV.set(0, 0, 0), { life: 0.25, size: 0.1, color: '#ffc46b' });
        this.puffs.spawn(p.shell.position, tmpV.set(rand(-0.1, 0.1), 0.15, rand(-0.1, 0.1)), { life: 0.9, size: 0.1, color: '#f4f7fa', grow: 1.6 });
      }
      if (p.t >= 1) {
        this.scene.remove(p.shell);
        this.projectiles.splice(i, 1);
        p.board.pending.delete(p.key);
        if (p.board.info) p.board.update(p.board.info, p.board.round);
        if (p.result === 'miss') this.splash(p.end);
        else this.explode(p.end, p.result === 'sunk');
        if (p.result === 'sunk') this.splash(p.end, true);
        p.resolve(true);
      }
    }

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.t += dt / r.dur;
      const s = 0.3 + r.t * r.scale;
      r.m.scale.set(s, 1, s);
      r.m.material.opacity = 0.8 * (1 - r.t);
      if (r.t >= 1) {
        this.scene.remove(r.m);
        r.m.material.dispose();
        this.ripples.splice(i, 1);
      }
    }

    for (const c of [this.cross, this.remoteCross]) {
      if (!c.visible) continue;
      c.position.lerp(c.userData.goal, Math.min(1, dt * 14));
      c.rotation.y += dt * 1.4;
      const s = 1 + Math.sin(t * 6) * 0.06;
      c.scale.set(s, 1, s);
    }

    this.flash.intensity *= Math.exp(-dt * 7);
    this.fx.update(dt);
    this.puffs.update(dt);

    this.updateCameraGoal(t);
    const k = 1 - Math.exp(-dt * 2.6);
    this.camPos.lerp(this.camGoalPos, k);
    this.camLook.lerp(this.camGoalLook, k);
    this.camera.position.copy(this.camPos);
    if (this.shake > 0.001) {
      this.camera.position.add(tmpV.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(this.shake * 0.5));
      this.shake *= Math.exp(-dt * 6);
    }
    this.camera.lookAt(this.camLook);
    this.sun.position.set(this.camLook.x - 16, 30, this.camLook.z + 18);
    this.sun.target.position.copy(this.camLook);

    if (this.quality === 'erweitert' && this.composer) {
      this.stars.material.opacity = 0.6 + Math.sin(t * 2) * 0.15;
      this.composer.render(dt);
    } else this.renderer.render(this.scene, this.camera);
  }
}
