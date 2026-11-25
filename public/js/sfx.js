// Soundeffekte (mit ElevenLabs generiert, siehe public/sfx/).
// Varianten werden zufällig gewählt und leicht in der Tonhöhe variiert,
// damit Wiederholungen nicht eintönig klingen.

const SOUNDS = {
  fire: { files: 4, volume: 0.5 },
  splash: { files: 4, volume: 0.65 },
  hit: { files: 4, volume: 0.75 },
  sunk: { files: 2, volume: 0.85 },
  win: { files: 2, volume: 0.75 },
  lose: { files: 2, volume: 0.75 },
  turn: { files: 2, volume: 0.45 },
  place: { files: 2, volume: 0.5 },
};
const AMBIENCE_VOLUME = 0.22;

let ctx = null;
let master = null;
let muted = false;
const buffers = new Map(); // name -> AudioBuffer[]
let loading = null;
let ambience = null;
let ambienceWanted = false;

try { muted = localStorage.getItem('sv-muted') === '1'; } catch { /* privat */ }

async function load(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url);
  return ctx.decodeAudioData(await res.arrayBuffer());
}

function loadAll() {
  if (loading) return loading;
  const jobs = [];
  for (const [name, { files }] of Object.entries(SOUNDS)) {
    const list = [];
    buffers.set(name, list);
    for (let i = 1; i <= files; i++) {
      jobs.push(load(`/sfx/${name}-${i}.mp3`).then((b) => list.push(b)).catch(() => {}));
    }
  }
  jobs.push(load('/sfx/ocean.mp3').then((b) => buffers.set('ocean', [b])).catch(() => {}));
  loading = Promise.all(jobs).then(() => { if (ambienceWanted) startAmbience(); });
  return loading;
}

/** Muss in einer Nutzer-Geste aufgerufen werden (Browser-Autoplay-Regeln). */
export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
    loadAll();
  }
  if (ctx.state === 'suspended') ctx.resume();
}

export function play(name, { volume = 1, delay = 0 } = {}) {
  if (!ctx || muted) return;
  const list = buffers.get(name);
  if (!list || !list.length) return;
  const src = ctx.createBufferSource();
  src.buffer = list[Math.floor(Math.random() * list.length)];
  src.playbackRate.value = 0.94 + Math.random() * 0.12;
  const gain = ctx.createGain();
  gain.gain.value = SOUNDS[name].volume * volume;
  src.connect(gain).connect(master);
  src.start(ctx.currentTime + delay);
}

function startAmbience() {
  if (ambience || !ctx) return;
  const buf = buffers.get('ocean')?.[0];
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.gain.linearRampToValueAtTime(AMBIENCE_VOLUME, ctx.currentTime + 2);
  src.connect(gain).connect(master);
  src.start();
  ambience = { src, gain };
}

export function setAmbience(on) {
  ambienceWanted = on;
  if (on) startAmbience();
  else if (ambience) {
    const { src, gain } = ambience;
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1);
    src.stop(ctx.currentTime + 1.1);
    ambience = null;
  }
}

export function isMuted() {
  return muted;
}

export function setMuted(m) {
  muted = m;
  try { localStorage.setItem('sv-muted', m ? '1' : '0'); } catch { /* privat */ }
  if (master) master.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.05);
}
