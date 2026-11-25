// Verspielte Low-Poly-Schiffe aus einfachen Grundformen.
// Jedes Schiff zeigt mit dem Bug in +x-Richtung, die Mitte liegt im Ursprung,
// die Wasserlinie (Unterkante) bei y = 0. Länge ≈ len Felder.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const geoCache = new Map();
const matCache = new Map();

function geo(key, make) {
  if (!geoCache.has(key)) geoCache.set(key, make());
  return geoCache.get(key);
}

export function mat(color, extra = {}) {
  const k = color + JSON.stringify(extra);
  if (!matCache.has(k)) {
    matCache.set(k, new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, ...extra }));
  }
  return matCache.get(k);
}

const OVERRIDES = {
  sunk: () => mat('#4a4d57', { roughness: 0.9 }),
  sunkDark: () => mat('#2f3037', { roughness: 1 }),
  dim: () => mat('#ffffff', { transparent: true, opacity: 0.35, depthWrite: false }),
  ghostOk: () => mat('#5dffb0', { transparent: true, opacity: 0.6, emissive: '#1fbf73', emissiveIntensity: 0.6, depthWrite: false }),
  ghostBad: () => mat('#ff5f6d', { transparent: true, opacity: 0.6, emissive: '#c0202f', emissiveIntensity: 0.6, depthWrite: false }),
};

function hullShape(L, W, bow) {
  const s = new THREE.Shape();
  s.moveTo(-L, -W * 0.7);
  s.quadraticCurveTo(-L, -W, -L + 0.18, -W);
  s.lineTo(L - bow, -W);
  s.quadraticCurveTo(L - 0.08, -W * 0.75, L, 0);
  s.quadraticCurveTo(L - 0.08, W * 0.75, L - bow, W);
  s.lineTo(-L + 0.18, W);
  s.quadraticCurveTo(-L, W, -L, W * 0.7);
  s.closePath();
  return s;
}

function extrude(shape, depth, bevel) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 10,
  });
  g.rotateX(-Math.PI / 2); // Umriss liegt jetzt in der xz-Ebene, Höhe entlang +y
  g.translate(0, bevel, 0);
  return g;
}

function mesh(g, m, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.castShadow = true;
  o.receiveShadow = true;
  return o;
}

function addTurret(group, x, y, color) {
  const base = mesh(geo('turret', () => new THREE.CylinderGeometry(0.15, 0.17, 0.1, 14)), mat('#8e9bb0'), x, y, 0);
  const dome = mesh(geo('dome', () => new THREE.SphereGeometry(0.12, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2)), mat(color), x, y + 0.05, 0);
  const barrel = mesh(
    geo('barrel', () => new THREE.CylinderGeometry(0.03, 0.035, 0.36, 8).rotateZ(Math.PI / 2)),
    mat('#5b6577'), x + 0.2, y + 0.08, 0,
  );
  group.add(base, dome, barrel);
}

export function makeShip({ len, name, color }) {
  const group = new THREE.Group();
  const L = len * 0.47 - 0.1;
  const W = 0.26;
  const hullMat = mat(color);
  const white = mat('#fffaf0');
  const dark = mat('#2d3a4f');

  if (name === 'U-Boot') {
    const body = mesh(
      geo('sub' + len, () => new THREE.CapsuleGeometry(0.25, len - 0.75, 6, 16).rotateZ(Math.PI / 2)),
      hullMat, 0, 0.2, 0,
    );
    body.scale.set(1, 0.8, 1);
    const tower = mesh(geo('subTower', () => new RoundedBoxGeometry(0.55, 0.34, 0.26, 3, 0.1)), hullMat, -0.15, 0.47, 0);
    const stripe = mesh(geo('subStripe', () => new RoundedBoxGeometry(0.57, 0.06, 0.28, 2, 0.03)), white, -0.15, 0.55, 0);
    const scope = mesh(geo('scope', () => new THREE.CylinderGeometry(0.025, 0.025, 0.32, 6)), dark, -0.05, 0.75, 0);
    const scopeTop = mesh(geo('scopeTop', () => new THREE.BoxGeometry(0.12, 0.05, 0.05)), dark, 0.0, 0.9, 0);
    const fin = mesh(geo('fin', () => new THREE.BoxGeometry(0.22, 0.16, 0.04)), hullMat, -L + 0.15, 0.32, 0);
    group.add(body, tower, stripe, scope, scopeTop, fin);
    return finalize(group, name, len);
  }

  const hull = mesh(geo(`hull${len}`, () => extrude(hullShape(L, W, 0.55), 0.2, 0.06)), hullMat);
  const stripe = mesh(geo(`stripe${len}`, () => extrude(hullShape(L + 0.01, W + 0.01, 0.55), 0.04, 0.06)), white, 0, 0.12, 0);
  group.add(hull, stripe);

  if (name === 'Flugzeugträger') {
    const deck = mesh(geo('carrierDeck', () => new RoundedBoxGeometry(L * 2 - 0.1, 0.06, W * 2 + 0.16, 2, 0.03)), mat('#66748a'), -0.05, 0.36, 0);
    const line = mesh(geo('carrierLine', () => new THREE.BoxGeometry(L * 1.6, 0.012, 0.04)), white, 0, 0.395, 0.03);
    const island = mesh(geo('island', () => new RoundedBoxGeometry(0.62, 0.42, 0.2, 3, 0.06)), white, -0.35, 0.6, -W + 0.02);
    const islandTop = mesh(geo('islandTop', () => new RoundedBoxGeometry(0.4, 0.12, 0.22, 2, 0.04)), hullMat, -0.35, 0.86, -W + 0.02);
    const mast = mesh(geo('mast', () => new THREE.CylinderGeometry(0.02, 0.02, 0.35, 6)), dark, -0.35, 1.08, -W + 0.02);
    // ein kleines Flugzeug an Deck
    const plane = new THREE.Group();
    plane.add(
      mesh(geo('planeBody', () => new RoundedBoxGeometry(0.34, 0.07, 0.08, 2, 0.03)), white),
      mesh(geo('planeWing', () => new RoundedBoxGeometry(0.1, 0.03, 0.4, 2, 0.012)), hullMat, 0.02, 0, 0),
      mesh(geo('planeTail', () => new RoundedBoxGeometry(0.06, 0.03, 0.18, 2, 0.012)), hullMat, -0.14, 0.02, 0),
    );
    plane.position.set(0.9, 0.43, 0.08);
    plane.rotation.y = 0.25;
    group.add(deck, line, island, islandTop, mast, plane);
    return finalize(group, name, len);
  }

  const deck = mesh(geo(`deck${len}`, () => extrude(hullShape(L - 0.07, W - 0.07, 0.45), 0.03, 0.02)), mat('#f3e6cf'), 0, 0.3, 0);
  const cabinLen = Math.min(0.9, 0.35 + len * 0.12);
  const cx = -L * 0.35;
  const cabin = mesh(geo(`cabin${len}`, () => new RoundedBoxGeometry(cabinLen, 0.3, 0.4, 3, 0.08)), white, cx, 0.5, 0);
  const windows = mesh(geo(`win${len}`, () => new RoundedBoxGeometry(0.06, 0.08, 0.34, 2, 0.02)), dark, cx + cabinLen / 2, 0.55, 0);
  const chimney = mesh(geo('chimney', () => new THREE.CylinderGeometry(0.09, 0.11, 0.32, 14)), hullMat, cx - cabinLen * 0.15, 0.8, 0);
  const cap = mesh(geo('cap', () => new THREE.CylinderGeometry(0.095, 0.095, 0.06, 14)), dark, cx - cabinLen * 0.15, 0.97, 0);
  group.add(deck, cabin, windows, chimney, cap);

  if (len >= 3) addTurret(group, L * 0.45, 0.36, color);
  if (len >= 4) addTurret(group, L * 0.05 + 0.05, 0.36, color);
  if (len === 2) {
    const flag = mesh(geo('flag', () => new THREE.BoxGeometry(0.16, 0.1, 0.01)), hullMat, cx - 0.25, 1.02, 0);
    const pole = mesh(geo('pole', () => new THREE.CylinderGeometry(0.012, 0.012, 0.3, 5)), dark, cx - 0.33, 0.95, 0);
    group.add(pole, flag);
  }
  return finalize(group, name, len);
}

function finalize(group, name, len) {
  group.userData = { name, len, originals: new Map() };
  group.traverse((o) => { if (o.isMesh) group.userData.originals.set(o, o.material); });
  return group;
}

/** Materialien austauschen: 'sunk' | 'dim' | 'ghostOk' | 'ghostBad' | null (Original). */
export function paintShip(group, style) {
  group.userData.originals.forEach((orig, m) => {
    if (!style) m.material = orig;
    else if (style === 'sunk') m.material = orig.color && orig.color.getHSL({}).l > 0.6 ? OVERRIDES.sunk() : OVERRIDES.sunkDark();
    else m.material = OVERRIDES[style]();
    m.castShadow = style !== 'dim' && style !== 'ghostOk' && style !== 'ghostBad';
  });
}
