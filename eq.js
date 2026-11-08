/* NEXA — égaliseur 5 bandes (Web Audio). Le graphe audio n'est créé qu'à la première activation :
   tant que l'égaliseur n'est pas utilisé, la lecture reste directe (zéro surcoût batterie). */
(function (g) {
'use strict';
const NEXA = g.NEXA = g.NEXA || {};
const BANDS = [60, 230, 910, 3600, 14000];
const LABELS = ['60 Hz', '230 Hz', '910 Hz', '3,6 kHz', '14 kHz'];
const PRESETS = {
  'Normal': [0, 0, 0, 0, 0], 'Basses+': [7, 5, 1, -1, -2], 'Voix': [-2, 0, 4, 4, 1], 'Aigus+': [-1, 0, 1, 5, 7],
  'Rock': [5, 3, -2, 3, 5], 'Pop': [-1, 2, 4, 2, -1], 'Jazz': [3, 2, -2, 2, 4], 'Électro': [6, 4, 0, 3, 5], 'Acoustique': [3, 3, 2, 3, 2]
};
let ctx = null, filters = [], pre = null, audioEl = null;
const state = { on: false, preset: 'Normal', gains: [0, 0, 0, 0, 0] };
const supported = () => !!(g.AudioContext || g.webkitAudioContext);

function ensureGraph() {
  if (ctx || !audioEl || !supported()) return !!ctx;
  try {
    const AC = g.AudioContext || g.webkitAudioContext;
    ctx = new AC();
    const src = ctx.createMediaElementSource(audioEl);
    filters = BANDS.map((f, i) => { const b = ctx.createBiquadFilter(); b.type = i === 0 ? 'lowshelf' : i === 4 ? 'highshelf' : 'peaking'; b.frequency.value = f; b.Q.value = 1; b.gain.value = 0; return b; });
    pre = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -4; comp.knee.value = 6; comp.ratio.value = 6; comp.attack.value = 0.005; comp.release.value = 0.2;
    let node = src; filters.forEach((f) => { node.connect(f); node = f; });
    node.connect(pre); pre.connect(comp); comp.connect(ctx.destination);
    ctx.addEventListener('statechange', () => { if (ctx.state === 'suspended' && audioEl && !audioEl.paused) ctx.resume().catch(() => {}); });
    return true;
  } catch (e) { ctx = null; return false; }
}
function apply() {
  if (!ctx) return;
  const gains = state.on ? state.gains : [0, 0, 0, 0, 0];
  const t = ctx.currentTime;
  filters.forEach((f, i) => f.gain.setTargetAtTime(gains[i], t, 0.02));
  pre.gain.setTargetAtTime(Math.pow(10, -(Math.max(0, ...gains) * 0.5) / 20), t, 0.02);
}
function resume() { if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); }

NEXA.eq = {
  BANDS, LABELS, PRESETS, state, supported,
  init(audio, saved) {
    audioEl = audio;
    if (saved && Array.isArray(saved.gains) && saved.gains.length === 5) { state.on = !!saved.on; state.preset = saved.preset || 'Normal'; state.gains = saved.gains.map((v) => Math.max(-12, Math.min(12, +v || 0))); }
    audio.addEventListener('play', () => { if (state.on) { ensureGraph(); apply(); } resume(); });
  },
  setOn(on) { state.on = !!on; if (on && !ensureGraph()) { state.on = false; return false; } resume(); apply(); return true; },
  setBand(i, v) { state.gains[i] = Math.max(-12, Math.min(12, +v)); state.preset = 'Perso'; apply(); },
  setPreset(name) { if (!PRESETS[name]) return; state.preset = name; state.gains = PRESETS[name].slice(); apply(); },
  snapshot() { return { on: state.on, preset: state.preset, gains: state.gains.slice() }; }
};
})(typeof window !== 'undefined' ? window : globalThis);
