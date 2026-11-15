/* NEXA DJ STUDIO — deux platines réelles, hors ligne.
   Chaque platine : lecture, CUE, 3 points repères, boucles au temps, tempo ±12 % (verrou de tonalité), SYNC (tempo + calage sur le temps),
   nudge, égaliseur 3 bandes, filtre, gain ; entre les deux : crossfader à puissance constante.
   Auto-DJ : enchaîne une ambiance avec de vrais mixages (chevauchement, tempos synchronisés, échange des basses).
   La grille rythmique est calculée en décodant le titre et en cherchant le pas de grille (BPM précis) et la phase qui collent le mieux aux
   attaques de grosse caisse. Précision de calage : de l'ordre de 30 ms (nudge pour affiner). Sans grille fiable (titre sans rythme marqué),
   seule la synchronisation de tempo est proposée. */
(function (g) {
'use strict';
const NEXA = g.NEXA = g.NEXA || {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const frac = (x) => x - Math.floor(x);
const fmtT = (s) => { s = Math.max(0, s | 0); return (s / 60 | 0) + ':' + String(s % 60).padStart(2, '0'); };

/* ================= Analyse : forme d'onde + grille rythmique ================= */
async function decodeFull(blob) {
  if (blob.size > 30e6) return null;
  const Ctx = g.OfflineAudioContext || g.webkitOfflineAudioContext;
  const buf = await new Ctx(1, 44100, 44100).decodeAudioData(await blob.arrayBuffer());
  const n = buf.length, out = new Float32Array(n), chs = buf.numberOfChannels;
  for (let c = 0; c < chs; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / chs; }
  return { data: out, sr: buf.sampleRate };
}
function peaksOf(data, n = 640) {
  const step = Math.max(1, Math.floor(data.length / n)), p = new Float32Array(n);
  for (let i = 0; i < n; i++) { let m = 0; const o = i * step, e = Math.min(data.length, o + step); for (let j = o; j < e; j += 8) { const v = Math.abs(data[j]); if (v > m) m = v; } p[i] = m; }
  const mx = Math.max(...p) || 1; return p.map((v) => v / mx);
}
/** Grille : { P (s par temps), anchor (s, 1er temps), conf (0-1) } ou null */
function beatGrid(data, sr) {
  const H = 512, n = Math.floor(data.length / H);
  if (n < 400) return null;
  // énergie des basses (filtre passe-bas simple ≈ 150 Hz), compressée en log
  const a = Math.exp(-2 * Math.PI * 150 / sr); let y = 0; const e = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; const o = i * H; for (let j = 0; j < H; j++) { y = (1 - a) * data[o + j] + a * y; s += y * y; } e[i] = Math.log(1 + 3000 * s / H); }
  const fl = new Float32Array(n); let mean = 0;
  for (let i = 1; i < n; i++) { fl[i] = Math.max(0, e[i] - e[i - 1]); mean += fl[i]; } mean /= n;
  for (let i = 0; i < n; i++) fl[i] = Math.max(0, fl[i] - mean);
  const fps = sr / H, lmin = Math.floor(fps * 60 / 185), lmax = Math.ceil(fps * 60 / 60);
  let best = 0, bl = 0, r0 = 0; const ac = [];
  for (let i = 0; i < n; i++) r0 += fl[i] * fl[i]; r0 /= n;
  const lim = Math.min(n, Math.floor(fps * 90));                 // 90 premières secondes suffisent pour estimer
  for (let l = lmin; l <= lmax; l++) { let s = 0; for (let i = l; i < lim; i++) s += fl[i] * fl[i - l]; s /= (lim - l); ac[l] = s; if (s > best) { best = s; bl = l; } }
  if (!bl || r0 < 1e-9 || best / r0 < 0.2) return null;
  const h0 = Math.round(bl / 2); let h = 0, hv = 0;
  for (let k = h0 - 1; k <= h0 + 1; k++) if (k >= lmin && ac[k] > hv) { hv = ac[k]; h = k; }
  if (h && hv > best * 0.6) bl = h;
  while (60 * fps / bl < 75) bl *= 0.5;     // ramené dans 75–175 BPM
  while (60 * fps / bl > 175) bl *= 2;
  // recherche fine : pas P' (±1,5 %) et phase φ maximisant la somme des attaques tombant sur la grille
  let bs = -1, bP = bl, bPh = 0;
  for (let k = -30; k <= 30; k++) {
    const P = bl * (1 + k * 0.0005);
    for (let ph = 0; ph < P; ph += 0.5) {
      let s = 0; for (let t = ph; t < n - 1; t += P) { const i = Math.round(t); s += fl[i] + 0.5 * (fl[i - 1] || 0) + 0.5 * (fl[i + 1] || 0); }
      if (s > bs) { bs = s; bP = P; bPh = ph; }
    }
  }
  let tot = 0; for (let i = 0; i < n; i++) tot += fl[i];
  const conf = clamp(bs / (2 * tot), 0, 1);                       // part des attaques qui tombent sur la grille
  return { P: bP * H / sr, anchor: bPh * H / sr, conf: +conf.toFixed(2) };
}

/* ================= Platine ================= */
class Deck {
  constructor(eng, id) {
    const ctx = eng.ctx; this.eng = eng; this.id = id;
    const a = this.a = new Audio(); a.preload = 'auto'; a.preservesPitch = a.webkitPreservesPitch = true;
    this.src = ctx.createMediaElementSource(a);
    this.trim = ctx.createGain();
    const bq = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; return b; };
    this.lo = bq('lowshelf', 250); this.mid = bq('peaking', 1200, 0.8); this.hi = bq('highshelf', 3500); this.flt = bq('allpass', 1000);
    this.xf = ctx.createGain();
    this.src.connect(this.trim); this.trim.connect(this.lo); this.lo.connect(this.mid); this.mid.connect(this.hi); this.hi.connect(this.flt); this.vol = ctx.createGain(); this.flt.connect(this.vol); this.vol.connect(this.xf); this.xf.connect(eng.master);
    this.vu = ctx.createAnalyser(); this.vu.fftSize = 512; this.vu.smoothingTimeConstant = 0.6; this.vol.connect(this.vu);
    this.t = null; this.url = null; this.grid = null; this.peaks = null; this.cue = 0; this.hot = [null, null, null]; this.loop = null; this.rate = 1; this.nudge = 0;
  }
  get loaded() { return !!this.t; }
  get playing() { return !this.a.paused; }
  get dur() { return this.a.duration || (this.t && this.t.duration) || 0; }
  get bpm() { return this.grid ? 60 / this.grid.P : (this.t && this.t.bpm) || 0; }
  get cur() { return this.a.currentTime; }
  setRate(r) { this.rate = clamp(r, 0.84, 1.16); this.a.playbackRate = this.rate * (1 + this.nudge); }
  setEQ(low, mid, high) { const t = this.eng.ctx.currentTime; this.lo.gain.setTargetAtTime(low, t, .015); this.mid.gain.setTargetAtTime(mid, t, .015); this.hi.gain.setTargetAtTime(high, t, .015); }
  setFilter(v) {                 // -1 passe-bas … 0 neutre … +1 passe-haut
    const f = this.flt, t = this.eng.ctx.currentTime;
    if (Math.abs(v) < 0.04) { f.type = 'allpass'; return; }
    if (v < 0) { f.type = 'lowpass'; f.frequency.setTargetAtTime(20000 * Math.pow(0.012, -v), t, .02); }
    else { f.type = 'highpass'; f.frequency.setTargetAtTime(30 * Math.pow(100, v), t, .02); }
    f.Q.value = 1.1;
  }
  phase(t = this.cur) { return this.grid ? frac((t - this.grid.anchor) / this.grid.P) : 0; }
  /** secondes (horloge murale) avant le prochain temps */
  nextBeatIn() { return this.grid ? (1 - this.phase()) * this.grid.P / this.a.playbackRate : 0; }
  async load(track) {
    this.a.pause(); this.loop = null; this.hot = [null, null, null];
    if (this.url) URL.revokeObjectURL(this.url);
    const blob = await this.eng.c.DB.get('files', track.id);
    if (!blob) throw new Error('fichier introuvable');
    this.t = track; this.url = URL.createObjectURL(blob); this.a.src = this.url; this.grid = null; this.peaks = null;
    this.setRate(1); this.nudge = 0;
    await new Promise((res) => { const ok = () => { this.a.removeEventListener('loadedmetadata', ok); res(); }; this.a.addEventListener('loadedmetadata', ok); this.a.load(); setTimeout(res, 4000); });
    try {
      const d = await decodeFull(blob);
      if (d) { this.peaks = peaksOf(d.data); const gr = beatGrid(d.data, d.sr); this.grid = gr && gr.conf >= 0.1 ? gr : null; this.gridConf = gr ? gr.conf : 0; }
    } catch (e) { /* titre non décodable en entier : lecture possible, sans forme d'onde ni grille */ }
    this.cue = this.grid ? this.grid.anchor : 0; this.a.currentTime = this.cue;
  }
  play() { this.eng.ctx.resume(); return this.a.play(); }
  pause() { this.a.pause(); }
  seek(t) { this.a.currentTime = clamp(t, 0, Math.max(0, this.dur - 0.05)); }
  beatLoop(n) {
    if (!this.grid) return false;
    const P = this.grid.P, s = this.grid.anchor + Math.floor((this.cur - this.grid.anchor) / P) * P;
    this.loop = { a: Math.max(0, s), b: Math.max(0, s) + n * P, n }; return true;
  }
  tickLoop() { const l = this.loop; if (l && this.playing && this.cur >= l.b - 0.004) this.a.currentTime = l.a + (this.cur - l.b); }
}

/* ================= Moteur ================= */
const eng = { ctx: null, master: null, decks: [], xf: -1, c: null, auto: null };
function ensure(c) {
  if (eng.ctx) return;
  eng.c = c;
  const ctx = eng.ctx = new (g.AudioContext || g.webkitAudioContext)();
  eng.master = ctx.createGain(); eng.master.gain.value = 0.9;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -9; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
  eng.master.connect(comp); comp.connect(ctx.destination);
  eng.mvu = ctx.createAnalyser(); eng.mvu.fftSize = 512; eng.mvu.smoothingTimeConstant = 0.6; comp.connect(eng.mvu);
  eng.decks = [new Deck(eng, 'A'), new Deck(eng, 'B')];
  setXf(-1);
}
function setXf(v) {                       // puissance constante
  eng.xf = clamp(v, -1, 1);
  const x = (eng.xf + 1) / 2, t = eng.ctx.currentTime;
  eng.decks[0].xf.gain.setTargetAtTime(Math.cos(x * Math.PI / 2), t, .01);
  eng.decks[1].xf.gain.setTargetAtTime(Math.sin(x * Math.PI / 2), t, .01);
}
/** Cale le tempo de dst sur celui de src. Retourne false si impossible. */
function matchTempo(dst, src) {
  if (!dst.grid || !src.grid) {
    if (!dst.bpm || !src.bpm) return false;
    const r = (src.bpm * src.rate) / dst.bpm;
    for (const k of [1, 2, 0.5]) if (r * k >= 0.84 && r * k <= 1.16) { dst.setRate(r * k); return true; } return false;
  }
  const r = (dst.grid.P * src.rate) / src.grid.P;           // même durée de temps à l'écoute
  for (const k of [1, 2, 0.5]) if (r * k >= 0.84 && r * k <= 1.16) { dst.setRate(r * k); return true; }
  return false;
}
/** Cale la phase : ramène les temps de dst sur ceux de src (±demi-temps). Retourne l'écart appliqué (ms). */
function alignPhase(dst, src) {
  if (!dst.grid || !src.grid) return null;
  const Wd = dst.grid.P / dst.a.playbackRate, Ws = src.grid.P / src.a.playbackRate;
  let d = dst.nextBeatIn() - src.nextBeatIn();
  const W = Ws; d = d - Math.round(d / W) * W;               // ramené dans ]-W/2 ; W/2]
  dst.seek(dst.cur + d * dst.a.playbackRate);
  return Math.round(d * 1000);
}
async function launchSynced(dst, src) {
  matchTempo(dst, src);
  if (src.grid && dst.grid) { await sleep(Math.max(0, src.nextBeatIn() * 1000 - 40)); }
  await dst.play();
  if (src.grid && dst.grid) { await sleep(300); alignPhase(dst, src); await sleep(700); alignPhase(dst, src); }
}
/** Transition de from vers to : crossfade sur `sec` secondes, basses échangées. */
async function transition(from, to, sec, onStep) {
  const dir = to === eng.decks[1] ? 1 : -1;
  if (!to.loaded) return false;
  if (!to.playing) await launchSynced(to, from);
  const t0 = performance.now(), x0 = dir === 1 ? -1 : 1;
  const ease = (p) => p;                                      // la puissance constante est déjà dans le crossfader
  return new Promise((res) => {
    const iv = setInterval(() => {
      const p = clamp((performance.now() - t0) / (sec * 1000), 0, 1);
      setXf(x0 + dir * 2 * ease(p));
      // échange des basses : sortante coupée de 30 % à 70 %, entrante ouverte de 30 % à 70 %
      const k = clamp((p - 0.3) / 0.4, 0, 1);
      from.setEQ(-26 * k, 0, 0); to.setEQ(-26 * (1 - k), 0, 0);
      onStep && onStep(p);
      if (p >= 1) { clearInterval(iv); from.pause(); from.setEQ(0, 0, 0); to.setEQ(0, 0, 0); res(true); }
    }, 40);
  });
}

/* ================= Interface : console de DJ ================= */
const STAGE_W = 880, STAGE_H = 452;
const level = (an) => { const b = new Uint8Array(an.fftSize); an.getByteTimeDomainData(b); let m = 0; for (let i = 0; i < b.length; i++) m += (b[i] - 128) * (b[i] - 128); return Math.min(1, Math.sqrt(m / b.length) / 64 * 1.6); };

NEXA.defineModule((c) => {
  const { S, esc } = c;
  let root = null, stage = null, raf = 0, loopIv = 0, scale = 1, rotated = false, ui = {};
  const q = (s) => root.querySelector(s);
  const toStage = (dx, dy) => (rotated ? { x: dy / scale, y: -dx / scale } : { x: dx / scale, y: dy / scale });

  /* ---------- composants : bouton rotatif et fader ---------- */
  function knob(label, min, max, value, def, onInput, cls = '') {
    const el = document.createElement('div'); el.className = 'kn ' + cls;
    el.innerHTML = `<div class="kn-dial"><i></i></div><span>${label}</span>`;
    const dial = el.querySelector('.kn-dial'); let v = value;
    const draw = () => { dial.style.setProperty('--a', (-135 + (v - min) / (max - min) * 270) + 'deg'); };
    const set = (nv, fire) => { v = clamp(nv, min, max); draw(); fire && onInput(v); };
    let y0 = 0, x0 = 0, v0 = 0, last = 0;
    const move = (e) => { const d = toStage(e.clientX - x0, e.clientY - y0); set(v0 - d.y / 110 * (max - min), true); };
    const up = () => { g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up); };
    dial.addEventListener('pointerdown', (e) => { y0 = e.clientY; x0 = e.clientX; v0 = v;
      const now = performance.now(); if (now - last < 320) { set(def, true); v0 = v; } last = now;
      g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up); });
    el.set = (nv) => set(nv, false); el.get = () => v; draw(); return el;
  }
  function fader(min, max, value, onInput, cls = '', horizontal = false) {
    const el = document.createElement('div'); el.className = 'fd ' + cls + (horizontal ? ' h' : '');
    el.innerHTML = '<div class="fd-rail"></div><div class="fd-cap"></div>'; const cap = el.querySelector('.fd-cap'); let v = value;
    const draw = () => { const p = (v - min) / (max - min); if (horizontal) cap.style.left = `calc((100% - 30px) * ${p})`; else cap.style.top = `calc((100% - 26px) * ${1 - p})`; };
    const fromEvent = (e) => { const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, d = toStage(e.clientX - cx, e.clientY - cy);
      const len = horizontal ? el.offsetWidth : el.offsetHeight, pos = horizontal ? d.x : d.y;
      const p = 0.5 + (horizontal ? pos : -pos) / (len - (horizontal ? 30 : 26)); v = clamp(min + clamp(p, 0, 1) * (max - min), min, max); draw(); onInput(v); };
    const mv = (e) => fromEvent(e), fin = () => { g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', fin); g.removeEventListener('pointercancel', fin); };
    el.addEventListener('pointerdown', (e) => { fromEvent(e); g.addEventListener('pointermove', mv); g.addEventListener('pointerup', fin); g.addEventListener('pointercancel', fin); });
    el.set = (nv) => { v = clamp(nv, min, max); draw(); }; el.get = () => v; draw(); return el;
  }

  /* ---------- construction ---------- */
  function deckPanel(id) {
    const d = eng.decks[id === 'A' ? 0 : 1], u = ui[id] = {};
    const el = document.createElement('section'); el.className = 'dkp ' + (id === 'A' ? 'left' : 'right'); el.dataset.d = id;
    el.innerHTML = `
      <div class="dkp-jogrow"><div class="dkp-pitch"></div><canvas class="jog" width="420" height="420"></canvas>
        <div class="dkp-side"><button class="pad small" data-a="load">CHARGER</button><button class="pad small" data-a="key" title="Verrou de tonalité">KEY</button>
          <button class="pad small" data-a="nm">−</button><button class="pad small" data-a="np">+</button></div></div>
      <div class="dkp-trans"><button class="pad cue" data-a="cue">CUE</button><button class="pad play" data-a="play">${c.icon('play')}</button><button class="pad sync" data-a="sync">SYNC</button></div>
      <div class="dkp-pads"><button class="pad hot" data-a="hot" data-i="0">1</button><button class="pad hot" data-a="hot" data-i="1">2</button><button class="pad hot" data-a="hot" data-i="2">3</button><button class="pad del" data-a="clr">EFFACER</button>
        ${[1, 2, 4, 8].map((n) => `<button class="pad loop" data-a="loop" data-n="${n}">${n}</button>`).join('')}</div>`;
    const pf = fader(-12, 12, 0, (v) => { d.setRate(1 + v / 100); }, 'pitch'); u.pitch = pf; el.querySelector('.dkp-pitch').appendChild(pf);
    const pr = document.createElement('div'); pr.className = 'pitch-val'; el.querySelector('.dkp-pitch').appendChild(pr); u.pv = pr;
    u.jog = el.querySelector('.jog'); u.el = el; u.clear = false; u.img = null;
    jogEvents(d, u);
    return el;
  }
  function strip(id) {
    const d = eng.decks[id === 'A' ? 0 : 1], u = ui[id], el = document.createElement('div'); el.className = 'ch';
    el.innerHTML = `<b class="ch-id">${id}</b><div class="ch-knobs"></div><div class="ch-fd"><canvas class="vu" width="20" height="200"></canvas></div>`;
    const kb = el.querySelector('.ch-knobs'), eq = { low: 0, mid: 0, high: 0 };
    const upd = () => d.setEQ(eq.low, eq.mid, eq.high);
    kb.append(
      knob('GAIN', 0, 1.5, 1, 1, (v) => { d.trim.gain.value = v; }),
      knob('AIGUS', -26, 6, 0, 0, (v) => { eq.high = v; upd(); }, 'k-hi'),
      knob('MÉD', -26, 6, 0, 0, (v) => { eq.mid = v; upd(); }, 'k-mid'),
      knob('GRAVES', -26, 6, 0, 0, (v) => { eq.low = v; upd(); }, 'k-lo'),
      knob('FILTRE', -1, 1, 0, 0, (v) => d.setFilter(v), 'k-fl'));
    u.eqKnobs = [...kb.children]; u.eq = eq;
    const vf = fader(0, 1, 1, (v) => { d.vol.gain.setTargetAtTime(v, eng.ctx.currentTime, .01); }, 'vol'); el.querySelector('.ch-fd').prepend(vf); u.vf = vf; u.vu = el.querySelector('.vu');
    return el;
  }

  function open() {
    if (!S.tracks.size) { c.toast('Ajoutez d’abord de la musique'); return; }
    c.audio.pause(); ensure(c); eng.ctx.resume(); c.closeSheet(); ui = {};
    root = document.createElement('div'); root.id = 'dj-studio';
    stage = document.createElement('div'); stage.className = 'stage'; root.appendChild(stage);
    stage.innerHTML = `
      <div class="bar"><button class="pad small" data-a="close">${c.icon('down')} QUITTER</button><h2>DJ STUDIO</h2>
        <button class="pad small" data-a="mixAB">MIX A→B</button><button class="pad small" data-a="mixBA">MIX B→A</button>
        <select class="dj-sel" data-k="tsec"><option value="4">4 s</option><option value="8" selected>8 s</option><option value="12">12 s</option><option value="16">16 s</option></select>
        <select class="dj-sel" data-k="mood">${NEXA.dj.moods.map((m) => `<option value="${m.id}">${m.name}</option>`).join('')}</select>
        <button class="pad small auto" data-a="auto">AUTO-DJ ▶</button><span class="bar-info" id="dj-auto-info">Auto-DJ arrêté</span><span class="bar-mv"></span></div>
      <div class="waves"><canvas class="wv" data-d="A" height="40"></canvas><canvas class="wv" data-d="B" height="40"></canvas></div>
      <div class="console"></div>`;
    const cons = stage.querySelector('.console');
    const A = deckPanel('A'), B = deckPanel('B');
    const mix = document.createElement('section'); mix.className = 'mixer';
    mix.innerHTML = '<div class="mx-ch"></div><div class="mx-xf"></div>';
    mix.querySelector('.mx-ch').append(strip('A'), strip('B'));
    const xf = fader(-1, 1, eng.xf, (v) => setXf(v), 'xf', true); ui.xf = xf; mix.querySelector('.mx-xf').append(Object.assign(document.createElement('span'), { textContent: 'A' }), xf, Object.assign(document.createElement('span'), { textContent: 'B' }));
    cons.append(A, mix, B);
    const mv = knob('MASTER', 0, 1, 0.9, 0.9, (v) => { eng.master.gain.value = v; }, 'k-m'); stage.querySelector('.bar-mv').append(mv);
    ui.mvu = Object.assign(document.createElement('canvas'), { width: 80, height: 14, className: 'mvu' }); stage.querySelector('.bar-mv').append(ui.mvu);
    document.body.appendChild(root);
    ui.wave = { A: q('.wv[data-d=A]'), B: q('.wv[data-d=B]') };
    bind(); fit(); g.addEventListener('resize', fit);
    try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {}); screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {}); } catch (e) { /* facultatif */ }
    drawLoop(); loopIv = setInterval(() => eng.decks.forEach((d) => d.tickLoop()), 8);
  }
  function fit() {
    if (!root) return;
    const vw = g.innerWidth, vh = g.innerHeight; rotated = vh > vw;
    scale = rotated ? Math.min(vh / STAGE_W, vw / STAGE_H) : Math.min(vw / STAGE_W, vh / STAGE_H);
    stage.style.transform = `translate(${vw / 2}px, ${vh / 2}px) ${rotated ? 'rotate(90deg) ' : ''}scale(${scale}) translate(${-STAGE_W / 2}px, ${-STAGE_H / 2}px)`;
  }
  function close() {
    stopAuto(); clearInterval(loopIv); cancelAnimationFrame(raf); g.removeEventListener('resize', fit);
    eng.decks.forEach((d) => d.pause());
    try { document.fullscreenElement && document.exitFullscreen(); screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch (e) { /* facultatif */ }
    root && root.remove(); root = null; eng.ctx && eng.ctx.suspend();
  }

  const D = (el) => eng.decks[el.closest('[data-d]').dataset.d === 'A' ? 0 : 1];
  const other = (d) => eng.decks[d === eng.decks[0] ? 1 : 0];

  /* ---------- molette (jog) : tourne avec le disque, toucher = scratch ---------- */
  function jogEvents(d, u) {
    let s = null;
    const ang = (e) => { const r = u.jog.getBoundingClientRect(), v = toStage(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)); return Math.atan2(v.y, v.x) * 180 / Math.PI; };
    u.jog.addEventListener('pointerdown', (e) => { if (!d.loaded) return; u.jog.setPointerCapture(e.pointerId);
      s = { a: ang(e), was: d.playing, tm: 0 }; d.pause(); });
    u.jog.addEventListener('pointermove', (e) => { if (!s) return; const a = ang(e); let da = a - s.a; if (da > 180) da -= 360; if (da < -180) da += 360; s.a = a;
      d.seek(d.cur + da / 360 * 1.8);                                  // 1 tour = 1,8 s (33 tours/min)
      d.a.play().catch(() => {}); clearTimeout(s.tm); s.tm = setTimeout(() => d.a.pause(), 70); });     // courte rafale de son : effet scratch
    const end = () => { if (!s) return; clearTimeout(s.tm); const was = s.was; s = null; if (was) d.play(); else d.pause(); };
    u.jog.addEventListener('pointerup', end); u.jog.addEventListener('pointercancel', end);
  }

  function bind() {
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
      try {
        if (a === 'close') return close();
        if (a === 'mixAB' || a === 'mixBA') {
          const f = eng.decks[a === 'mixAB' ? 0 : 1], t = other(f);
          if (!t.loaded) return c.toast('Chargez un titre sur l’autre platine');
          if (!f.playing) await f.play();
          if (!matchTempo(t, f)) c.toast('Tempos trop éloignés : mixage sans synchronisation');
          setXf(a === 'mixAB' ? -1 : 1);
          return transition(f, t, +q('[data-k=tsec]').value);
        }
        if (a === 'auto') return eng.auto ? stopAuto() : startAuto(NEXA.dj.moods.find((m) => m.id === q('[data-k=mood]').value));
        const d = D(b), u = ui[d.id];
        if (a === 'load') return pickTrack(d);
        if (a === 'play') { if (!d.loaded) return c.toast('Chargez un titre'); return d.playing ? d.pause() : d.play(); }
        if (a === 'cue') { if (!d.loaded) return; if (d.playing) { d.pause(); d.seek(d.cue); } else d.cue = d.cur; return; }
        if (a === 'key') { d.a.preservesPitch = d.a.webkitPreservesPitch = !d.a.preservesPitch; return; }
        if (a === 'sync') {
          const o = other(d); if (!d.loaded || !o.loaded) return c.toast('Chargez les deux platines');
          if (!matchTempo(d, o)) return c.toast('Tempo inconnu ou trop éloigné');
          const ms = o.playing && d.playing ? alignPhase(d, o) : null;
          return c.toast(ms === null ? 'Tempo synchronisé' : `Synchronisé (écart corrigé : ${ms} ms)`);
        }
        if (a === 'clr') { u.clear = !u.clear; return; }
        if (a === 'loop') { const n = +b.dataset.n; if (d.loop && d.loop.n === n) d.loop = null; else if (!d.beatLoop(n)) c.toast('Pas de grille rythmique fiable sur ce titre'); return; }
        if (a === 'hot') { const i = +b.dataset.i; if (u.clear) { d.hot[i] = null; u.clear = false; } else if (d.hot[i] == null) d.hot[i] = d.cur; else d.seek(d.hot[i]); return; }
      } catch (err) { console.error(err); c.toast('Action impossible'); }
    });
    // nudge : vitesse ±4 % tant que le doigt reste appuyé
    root.addEventListener('pointerdown', (e) => { const b = e.target.closest('[data-a=nm],[data-a=np]'); if (b) { const d = D(b); d.nudge = b.dataset.a === 'np' ? 0.04 : -0.04; d.setRate(d.rate); }
      const h = e.target.closest('[data-a=hot]'); if (h) { const d = D(h), i = +h.dataset.i; h._t = setTimeout(() => { d.hot[i] = null; h._cl = true; c.toast('Repère effacé'); }, 700); } });
    const up = () => { eng.decks.forEach((d) => { if (d.nudge) { d.nudge = 0; d.setRate(d.rate); } }); root.querySelectorAll('[data-a=hot]').forEach((h) => clearTimeout(h._t)); };
    root.addEventListener('pointerup', up); root.addEventListener('pointercancel', up);
    root.addEventListener('click', (e) => { const h = e.target.closest('[data-a=hot]'); if (h && h._cl) { h._cl = false; e.stopImmediatePropagation(); } }, true);
    // forme d'onde : toucher = aller à cet endroit
    root.addEventListener('pointerdown', (e) => { const cv = e.target.closest('.wv'); if (!cv) return; const d = eng.decks[cv.dataset.d === 'A' ? 0 : 1]; if (!d.loaded) return;
      const r = cv.getBoundingClientRect(), v = toStage(e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2); d.seek((0.5 + v.x / (cv.offsetWidth)) * d.dur); });
  }

  /* ---------- choix du titre ---------- */
  function pickTrack(d) {
    const all = [...S.tracks.values()].sort((a, b) => a.title.localeCompare(b.title));
    const item = (t) => `<button class="s-item dj-pick" data-id="${t.id}"><div class="si-tx"><b>${esc(t.title)}</b><small>${esc(t.artist)}${t.bpm ? ' · ' + t.bpm + ' BPM' : ''}</small></div></button>`;
    c.openSheet(`<div class="sheet-title">Charger sur la platine ${d.id}</div><input class="s-input" id="dj-q" placeholder="Rechercher un titre…" autocomplete="off"><div id="dj-list" class="dj-list">${all.slice(0, 80).map(item).join('')}</div>`, (s) => {
      const list = s.querySelector('#dj-list');
      s.querySelector('#dj-q').oninput = (e) => { const k = c.norm(e.target.value); list.innerHTML = all.filter((t) => !k || c.norm(t.title + ' ' + t.artist).includes(k)).slice(0, 80).map(item).join(''); };
      list.onclick = async (e) => { const b = e.target.closest('[data-id]'); if (!b) return; c.closeSheet(); await loadInto(d, S.tracks.get(b.dataset.id)); };
    });
  }
  async function loadInto(d, t) {
    const u = ui[d.id]; if (!u) return; u.title = 'Analyse…'; u.busy = true;
    try { await d.load(t); } catch (e) { c.toast('Chargement impossible'); }
    u.busy = false; u.title = t.title; u.artist = t.artist; u.img = null;
    if (t.coverUrl) { const im = new Image(); im.onload = () => { u.img = im; }; im.src = t.coverUrl; }
  }

  /* ---------- dessin ---------- */
  function drawJog(d, u, cs) {
    const cv = u.jog, x = cv.getContext('2d'), W = cv.width, R = W / 2, ac = cs.ac;
    x.clearRect(0, 0, W, W); x.save(); x.translate(R, R);
    // couronne : progression dans le titre + diodes de temps
    x.lineWidth = 10; x.strokeStyle = 'rgba(255,255,255,.08)'; x.beginPath(); x.arc(0, 0, R - 8, 0, Math.PI * 2); x.stroke();
    if (d.loaded) { x.strokeStyle = ac; x.beginPath(); x.arc(0, 0, R - 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (d.cur / (d.dur || 1))); x.stroke(); }
    const ph = d.loaded && d.grid ? d.phase() : 1;
    x.fillStyle = ph < 0.15 ? '#fff' : 'rgba(255,255,255,.18)'; x.beginPath(); x.arc(0, -(R - 8), 7, 0, Math.PI * 2); x.fill();
    // disque
    const angle = d.loaded ? d.cur / 1.8 * Math.PI * 2 : 0; x.rotate(angle);
    const g1 = x.createRadialGradient(0, 0, 10, 0, 0, R - 22); g1.addColorStop(0, '#1b1f27'); g1.addColorStop(1, '#07090d');
    x.fillStyle = g1; x.beginPath(); x.arc(0, 0, R - 22, 0, Math.PI * 2); x.fill();
    x.strokeStyle = 'rgba(255,255,255,.05)'; x.lineWidth = 1; for (let r = 70; r < R - 26; r += 7) { x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2); x.stroke(); }
    x.fillStyle = 'rgba(255,255,255,.05)'; x.beginPath(); x.moveTo(0, 0); x.arc(0, 0, R - 24, -0.25, 0.25); x.fill();      // reflet
    x.save(); x.beginPath(); x.arc(0, 0, 62, 0, Math.PI * 2); x.clip();
    if (u.img) x.drawImage(u.img, -62, -62, 124, 124); else { x.fillStyle = ac; x.globalAlpha = .35; x.fillRect(-62, -62, 124, 124); x.globalAlpha = 1; }
    x.restore();
    x.strokeStyle = ac; x.lineWidth = 3; x.beginPath(); x.moveTo(0, -R + 26); x.lineTo(0, -66); x.stroke();                // repère
    x.fillStyle = '#05070a'; x.beginPath(); x.arc(0, 0, 6, 0, Math.PI * 2); x.fill();
    x.restore();
  }
  function drawWave(d, cv, cs, id) {
    const h = 40, W = cv.offsetWidth, dpr = scale * (g.devicePixelRatio || 1), want = Math.max(1, Math.round(W * dpr));
    if (cv.width !== want) { cv.width = want; cv.height = Math.max(1, Math.round(h * dpr)); }
    const x = cv.getContext('2d'); x.setTransform(cv.width / W, 0, 0, cv.height / h, 0, 0); x.clearRect(0, 0, W, h);
    x.fillStyle = cs.mu; x.font = '700 11px sans-serif';
    if (!d.loaded) { x.globalAlpha = .6; x.fillText(`${id} · platine vide`, 10, 24); x.globalAlpha = 1; return; }
    const dur = d.dur || 1, P = d.peaks;
    if (P) { const bw = W / P.length; x.globalAlpha = .6; for (let i = 0; i < P.length; i++) { const v = Math.max(1, P[i] * (h - 6)); x.fillRect(i * bw, (h - v) / 2, Math.max(1, bw - .5), v); } x.globalAlpha = 1; }
    if (d.grid) { x.strokeStyle = 'rgba(255,255,255,.14)'; x.beginPath(); for (let t = d.grid.anchor; t < dur; t += d.grid.P * 4) { const px = Math.round(t / dur * W) + .5; x.moveTo(px, 0); x.lineTo(px, h); } x.stroke(); }
    if (d.loop) { x.fillStyle = cs.ac; x.globalAlpha = .3; x.fillRect(d.loop.a / dur * W, 0, (d.loop.b - d.loop.a) / dur * W, h); x.globalAlpha = 1; }
    x.fillStyle = '#ffb347'; d.hot.forEach((t) => { if (t != null) x.fillRect(t / dur * W - 1, 0, 2, h); });
    x.fillStyle = cs.ac; x.fillRect(d.cur / dur * W - 1, 0, 2, h);
    x.fillStyle = '#fff'; x.shadowColor = '#000'; x.shadowBlur = 4;
    const u = ui[id]; x.fillText(`${id}  ${u.title || ''} · ${d.bpm ? (d.bpm * d.a.playbackRate).toFixed(1) + ' BPM' : 'BPM ?'} · ${fmtT(d.cur)} / ${fmtT(dur)}${d.grid ? '' : ' · sans grille'}`, 10, 14); x.shadowBlur = 0;
  }
  function drawVU(cv, lv) {
    const x = cv.getContext('2d'), H = cv.height, n = 14, gap = 2, sh = (H - gap * (n - 1)) / n; x.clearRect(0, 0, cv.width, H);
    for (let i = 0; i < n; i++) { const on = lv * n > i; x.fillStyle = !on ? 'rgba(255,255,255,.08)' : i > n - 3 ? '#ff4d4d' : i > n - 6 ? '#ffb347' : '#34d399'; x.fillRect(0, H - (i + 1) * sh - i * gap, cv.width, sh); }
  }
  function drawLoop() {
    raf = requestAnimationFrame(drawLoop); if (!root) return;
    const st = getComputedStyle(root), cs = { ac: st.getPropertyValue('--ac').trim() || '#38bdf8', mu: st.getPropertyValue('--mu').trim() || '#888' };
    for (const d of eng.decks) {
      const u = ui[d.id]; drawJog(d, u, cs); drawWave(d, ui.wave[d.id], cs, d.id);
      const pc = (d.rate - 1) * 100; u.pitch.set(pc); u.pv.textContent = (pc >= 0 ? '+' : '') + pc.toFixed(1).replace('.', ',') + '%';
      const el = u.el;
      el.classList.toggle('on', d.playing);
      el.querySelector('.play').innerHTML = c.icon(d.playing ? 'pause' : 'play');
      el.querySelectorAll('[data-a=loop]').forEach((b) => b.classList.toggle('on', !!d.loop && d.loop.n === +b.dataset.n));
      el.querySelectorAll('[data-a=hot]').forEach((b) => b.classList.toggle('on', d.hot[+b.dataset.i] != null));
      el.querySelector('[data-a=clr]').classList.toggle('on', !!u.clear);
      el.querySelector('[data-a=key]').classList.toggle('on', d.a.preservesPitch);
      drawVU(u.vu, d.playing ? level(d.vu) : 0);
    }
    ui.xf.set(eng.xf);
    const cx = ui.mvu.getContext('2d'); cx.clearRect(0, 0, 80, 14); const l = level(eng.mvu); cx.fillStyle = l > .85 ? '#ff4d4d' : cs.ac; cx.fillRect(0, 2, 80 * l, 10);
    const ab = q('[data-a=auto]'); if (ab) ab.textContent = eng.auto ? 'AUTO-DJ ■' : 'AUTO-DJ ▶';
  }

  /* ---------- Auto-DJ ---------- */
  async function startAuto(mood) {
    stopAuto();
    const list = NEXA.dj.build(mood, 50, null, 30);
    if (list.length < 3) return c.toast('Pas assez de titres pour cette ambiance');
    const st = eng.auto = { list, i: 0, run: true, mood };
    const info = (m) => { const e = root && q('#dj-auto-info'); if (e) e.textContent = m; };
    let cur = eng.decks[0], nxt = eng.decks[1];
    try {
      info('Préparation…'); await loadInto(cur, list[0]); setXf(-1); await cur.play();
      while (st.run && st.i < list.length - 1) {
        const next = list[st.i + 1]; await loadInto(nxt, next); if (!st.run) break;
        const sec = +q('[data-k=tsec]').value;
        while (st.run && cur.playing && cur.dur - cur.cur > sec + 2) { info(`Suivant : ${next.title} · mixage dans ${fmtT(cur.dur - cur.cur - sec - 2)}`); await sleep(500); }
        if (!st.run) break;
        info(`Mixage vers : ${next.title}`); setXf(cur === eng.decks[0] ? -1 : 1);
        await transition(cur, nxt, sec); [cur, nxt] = [nxt, cur]; st.i++;
      }
      if (st.run) info('Ambiance terminée');
    } catch (e) { console.error(e); info('Auto-DJ interrompu'); }
    if (eng.auto === st) eng.auto = null;
  }
  function stopAuto() { if (eng.auto) { eng.auto.run = false; eng.auto = null; } const e = root && q('#dj-auto-info'); if (e) e.textContent = 'Auto-DJ arrêté'; }

  NEXA.actions.djstudio = open;
  NEXA.djstudio = { S, eng, ensure: () => ensure(c), Deck, beatGrid, matchTempo, alignPhase, setXf, transition, launchSynced, decodeFull, loadInto, open, ui: () => ui };
});
})(typeof window !== 'undefined' ? window : globalThis);
