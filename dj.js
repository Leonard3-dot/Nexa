/* NEXA DJ — gérer l'ambiance, 100 % hors ligne.
   1. ANALYSE DU SON (réelle) : pour chaque titre, on décode un extrait avec Web Audio et on mesure
      l'énergie (volume moyen), le tempo (BPM, par autocorrélation des attaques) et la brillance. Résultat gardé dans la base.
   2. AMBIANCES : Énergie, Soirée, Détente, Concentration, Nuit, Sport. Chaque ambiance vise une zone d'énergie et de tempo ;
      sans analyse, on se rabat sur le genre. Le curseur « Plus calme ↔ Plus intense » déplace la cible.
   3. ENCHAÎNEMENT : la liste est ordonnée titre à titre (tempos voisins, énergie qui évolue en douceur), avec artistes variés.
   Limite assumée : le passage d'un titre à l'autre est un fondu (sortie puis entrée), pas un mixage avec chevauchement. */
(function (g) {
'use strict';
const NEXA = g.NEXA = g.NEXA || {};

const MOODS = [
  { id: 'energie', name: 'Énergie', desc: 'Rythmé, punchy', icon: 'bolt', g: ['#38BDF8', '#2563EB'], e: [.62, 1], b: [112, 180], fam: ['Hip-Hop', 'Électro', 'Rock', 'Afro', 'Latino', 'Pop'] },
  { id: 'soiree', name: 'Soirée', desc: 'Dansant, festif', icon: 'sparkle', g: ['#4FB3F5', '#3B6FE0'], e: [.5, .9], b: [96, 135], fam: ['Afro', 'Latino', 'Hip-Hop', 'Pop', 'Électro', 'R&B / Soul', 'Reggae'] },
  { id: 'detente', name: 'Détente', desc: 'Doux, posé', icon: 'leaf', g: ['#5B9BF0', '#2F62D8'], e: [.12, .5], b: [55, 105], fam: ['Jazz & Blues', 'R&B / Soul', 'Folk & Country', 'Chanson', 'Classique', 'Reggae'] },
  { id: 'focus', name: 'Concentration', desc: 'Calme, sans distraction', icon: 'wave', g: ['#38BDF8', '#0369A1'], e: [.08, .42], b: [55, 118], fam: ['Classique', 'Jazz & Blues', 'Électro', 'Folk & Country'], avoid: ['Hip-Hop', 'Rock'] },
  { id: 'nuit', name: 'Nuit', desc: 'Très calme', icon: 'moon', g: ['#1E3A8A', '#38BDF8'], e: [0, .3], b: [45, 90], fam: ['Classique', 'Jazz & Blues', 'R&B / Soul', 'Folk & Country'], avoid: ['Rock', 'Hip-Hop', 'Électro'] },
  { id: 'sport', name: 'Sport', desc: 'Intense, tempo élevé', icon: 'flame', g: ['#0EA5E9', '#1D4ED8'], e: [.7, 1], b: [124, 185], fam: ['Hip-Hop', 'Électro', 'Rock', 'Afro', 'Latino'] }
];
const PRIOR = { Classique: .2, 'Jazz & Blues': .35, 'Folk & Country': .35, Religieux: .3, Chanson: .45, 'R&B / Soul': .5, Reggae: .5, Pop: .6, Latino: .65, 'Hip-Hop': .7, Afro: .7, 'Électro': .75, Rock: .8 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= Analyse du signal ================= */
function features(data, sr) {
  // énergie par fenêtre de 1024 échantillons, pas de 512
  const W = 1024, H = 512, n = Math.floor((data.length - W) / H);
  if (n < 200) return null;
  const env = new Float32Array(n);
  let sum = 0, zc = 0;
  for (let i = 0; i < n; i++) {
    let e = 0; const o = i * H;
    for (let j = 0; j < W; j++) { const v = data[o + j]; e += v * v; }
    env[i] = Math.sqrt(e / W); sum += e / W;
  }
  for (let i = 1; i < data.length; i += 4) if ((data[i] >= 0) !== (data[i - 4 < 0 ? 0 : i - 4] >= 0)) zc++;
  const rms = Math.sqrt(sum / n);
  const energy = clamp((20 * Math.log10(rms + 1e-6) + 36) / 30, 0, 1);       // -36 dB → 0 ; -6 dB → 1
  const bright = clamp(zc / (data.length / 4) / 0.35, 0, 1);
  // attaques : différences positives de l'enveloppe, puis autocorrélation
  const on = new Float32Array(n); let m = 0;
  for (let i = 1; i < n; i++) { on[i] = Math.max(0, env[i] - env[i - 1]); m += on[i]; }
  m /= n; for (let i = 0; i < n; i++) on[i] = Math.max(0, on[i] - m);
  const fps = sr / H, lagMin = Math.floor(fps * 60 / 185), lagMax = Math.ceil(fps * 60 / 55);
  let best = 0, bl = 0; const ac = [];
  for (let l = lagMin; l <= lagMax; l++) {
    let s = 0; for (let i = l; i < n; i++) s += on[i] * on[i - l];
    s /= (n - l); ac[l] = s; if (s > best) { best = s; bl = l; }
  }
  let r0 = 0; for (let i = 0; i < n; i++) r0 += on[i] * on[i]; r0 /= n;
  let bpm = 0;
  const conf = r0 > 1e-12 ? best / r0 : 0;
  if (bl && conf > 0.2 && m > 0.0015) {              // rythme assez net et régulier pour se fier au tempo
    // le pic le plus fort est parfois à 2× la période (tempo divisé par 2) : si la moitié de la période est presque aussi forte, on la préfère
    const h0 = Math.round(bl / 2); let h = 0, hv = 0;
    for (let k = h0 - 1; k <= h0 + 1; k++) if (k >= lagMin && ac[k] !== undefined && ac[k] > hv) { hv = ac[k]; h = k; }
    if (h && hv > best * 0.6) bl = h;
    bpm = 60 * fps / bl;
    while (bpm < 70) bpm *= 2; while (bpm > 175) bpm /= 2;
    bpm = Math.round(bpm);
  }
  return { energy: +energy.toFixed(2), bpm, bright: +bright.toFixed(2), conf: +conf.toFixed(2), m };
}

async function analyseBlob(blob, isMp3) {
  const MAX_FULL = 12e6;
  let part = blob;
  if (isMp3 && blob.size > 1.6e6) { const o = Math.floor(blob.size * 0.3); part = blob.slice(o, o + 1.5e6); }   // milieu du titre
  else if (blob.size > MAX_FULL) return null;                                                                   // trop gros à décoder
  const Ctx = g.OfflineAudioContext || g.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 44100, 44100);
  const buf = await ctx.decodeAudioData(await part.arrayBuffer());
  let ch = buf.getChannelData(0);
  const sr = buf.sampleRate, maxN = Math.floor(sr * 45);
  if (ch.length > maxN) { const o = Math.floor((ch.length - maxN) / 2); ch = ch.subarray(o, o + maxN); }
  return features(ch, sr);
}

NEXA.defineModule((c) => {
  const { S, LS } = c;
  const all = () => [...S.tracks.values()];
  const eff = (t) => (typeof t.energy === 'number' ? t.energy : (PRIOR[t.fam] ?? .5));
  const done = (t) => t.analysed === 1;
  let running = false, stop = false, session = LS.get('djSession', null), listener = null;

  /* ---------- analyse en arrière-plan ---------- */
  async function analyseAll(onTick) {
    if (running) return; running = true; stop = false;
    const todo = all().filter((t) => !done(t));
    let i = 0;
    for (const t of todo) {
      if (stop) break;
      try {
        const blob = await c.DB.get('files', t.id);
        const isMp3 = /mpeg|mp3/.test(blob && blob.type || '') || /\.mp3$/i.test(t.sig || '');
        const f = blob ? await analyseBlob(blob, isMp3) : null;
        if (f) { t.energy = f.energy; t.bpm = f.bpm; t.bright = f.bright; }
      } catch (e) { /* format non décodable : on garde le genre */ }
      t.analysed = 1; c.DB.putTrack(t).catch(() => {});
      i++; onTick && onTick(i, todo.length);
      await sleep(40);               // laisse respirer l'interface et la lecture
    }
    running = false; onTick && onTick(i, todo.length, true);
  }

  /* ---------- sélection et enchaînement ---------- */
  const fit = (v, [lo, hi]) => (v >= lo && v <= hi ? 1 : 1 - Math.min(1, (v < lo ? lo - v : v - hi) / ((hi - lo) || 1) * 2.4));
  function build(mood, level, exclude, n = 36) {
    const shift = (level - 50) / 50 * 0.25;             // curseur : -0.25 … +0.25 sur l'énergie visée
    const eT = [clamp(mood.e[0] + shift, 0, 1), clamp(mood.e[1] + shift, 0, 1)];
    const bShift = (level - 50) / 50 * 12;
    const bT = [mood.b[0] + bShift, mood.b[1] + bShift];
    const now = Date.now();
    const sc = all().filter((t) => !(exclude && exclude.has(t.id))).map((t) => {
      let s = 0.6 * fit(eff(t), eT);
      s += t.bpm ? 0.25 * fit(t.bpm, bT) : 0.12;
      if (mood.fam.includes(t.fam)) s += 0.15;
      if (mood.avoid && mood.avoid.includes(t.fam)) s -= 0.3;
      if (t.liked) s += 0.06;
      s -= Math.min(0.25, (t.skips || 0) * 0.07);
      if (t.lastPlayed && now - t.lastPlayed < 3 * 36e5) s -= 0.2;
      return [t, s + Math.random() * 0.08];
    }).sort((a, b) => b[1] - a[1]);
    // artistes variés : 3 titres max par artiste
    const good = sc.filter((x) => x[1] >= 0.5), src = good.length >= 3 ? good : sc;     // on n'ajoute pas de titres hors ambiance s'il y en a assez
    const cnt = new Map(), pool = [];
    for (const [t, s] of src) { const k = t.artist; const q = cnt.get(k) || 0; if (t.artist === c.UNKNOWN_ARTIST || q < 3) { pool.push(t); cnt.set(k, q + 1); } if (pool.length >= n) break; }
    // ordre : on part d'un titre posé de la zone, puis voisin le plus proche (tempo + énergie), l'énergie dérivant vers le centre de la cible
    if (!pool.length) return [];
    const center = (eT[0] + eT[1]) / 2, left = pool.slice(), out = [];
    const s0 = eT[0] + (eT[1] - eT[0]) * 0.25;                  // on démarre dans le bas de la zone visée, puis on monte
    left.sort((a, b) => Math.abs(eff(a) - s0) - Math.abs(eff(b) - s0)); out.push(left.splice(0, 1)[0]);
    while (left.length) {
      const p = out[out.length - 1], goal = clamp(eff(p) + (center - eff(p)) * 0.35 + (out.length < n * 0.6 ? 0.03 : -0.03), 0, 1);
      let bi = 0, bd = 9;
      left.forEach((t, i) => {
        const d = Math.abs(eff(t) - goal) * 1.2 + (p.bpm && t.bpm ? Math.min(60, Math.abs(p.bpm - t.bpm)) / 60 : 0.15) + (t.artist === p.artist ? 0.25 : 0);
        if (d < bd) { bd = d; bi = i; }
      });
      out.push(left.splice(bi, 1)[0]);
    }
    return out;
  }

  function start(mood, level) {
    const list = build(mood, level);
    if (list.length < 3) { c.toast('Pas assez de titres pour cette ambiance'); return false; }
    c.setShuffle(false);                  // l'ordre du DJ ne doit pas être mélangé
    c.play(list.map((t) => t.id), list[0].id);
    session = { mood: mood.id, level, at: Date.now() }; LS.set('djSession', session);
    c.toast(`Ambiance ${mood.name} · ${list.length} titres`);
    return true;
  }
  /* Remplace la suite de la file (titre en cours conservé) selon le curseur */
  function regen(level) {
    const mood = MOODS.find((m) => m.id === (session && session.mood)); if (!mood) return false;
    const keep = S.queue.slice(0, S.qi + 1), list = build(mood, level, new Set(keep));
    if (!list.length) return false;
    S.queue = keep.concat(list.map((t) => t.id)); S.base = S.queue.slice();
    session.level = level; LS.set('djSession', session);
    c.saveState(); c.renderQueue(); c.toast('Suite de l’ambiance mise à jour');
    return true;
  }
  const suggested = () => {
    const h = new Date().getHours();
    return h < 5 ? 'nuit' : h < 9 ? 'detente' : h < 12 ? 'focus' : h < 17 ? 'focus' : h < 20 ? 'energie' : h < 23 ? 'soiree' : 'nuit';
  };

  /* ---------- fenêtre « DJ » ---------- */
  function openDJ() {
    const n = S.tracks.size;
    if (!n) { c.toast('Ajoutez d’abord de la musique'); return; }
    const sug = suggested(), cur = session && MOODS.find((m) => m.id === session.mood);
    const tiles = MOODS.map((m) => `<button class="dj-tile${m.id === sug ? ' sug' : ''}" data-m="${m.id}" style="--g1:${m.g[0]};--g2:${m.g[1]}">
        ${c.icon(m.icon)}<b>${m.name}</b><span>${m.desc}</span>${m.id === sug ? '<em>Suggéré maintenant</em>' : ''}</button>`).join('');
    const nAn = all().filter(done).length;
    c.openSheet(`<div class="sheet-title">DJ · Ambiance</div>
      <p class="s-msg">Choisissez une ambiance : NEXA compose et enchaîne les titres de votre bibliothèque.</p>
      <div class="dj-grid">${tiles}</div>
      <div class="dj-lv"><span>Plus calme</span><input type="range" class="slider" id="dj-lv" min="0" max="100" value="${session ? session.level : 50}"><span>Plus intense</span></div>
      ${cur ? `<div class="s-row"><button class="btn sec" id="dj-regen">Régénérer la suite (${cur.name})</button></div>` : ''}
      <label class="eq-top"><span>Enchaînement en fondu<small class="sub-l">Sortie douce puis entrée du titre suivant (6 s)</small></span><input type="checkbox" class="switch" id="dj-fade"${NEXA.fx && NEXA.fx.fade >= 4 ? ' checked' : ''}></label>
      <p class="s-msg" id="dj-an">${nAn} / ${n} titres analysés (énergie et tempo). Sans analyse, l’ambiance se base sur le genre.</p>
      <div class="s-row"><button class="btn sec" id="dj-analyse" ${nAn >= n ? 'disabled' : ''}>Analyser mes titres</button></div>
      <div class="s-row"><button class="btn" data-done>Terminé</button></div>`, (s) => {
      const lv = () => +s.querySelector('#dj-lv').value;
      const sl = s.querySelector('#dj-lv'), paint = () => sl.style.setProperty('--p', sl.value + '%'); sl.oninput = paint; paint();
      s.querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => { if (start(MOODS.find((m) => m.id === b.dataset.m), lv())) c.closeSheet(); }; });
      const rg = s.querySelector('#dj-regen'); if (rg) rg.onclick = () => { if (regen(lv())) c.closeSheet(); else c.toast('Rien à régénérer'); };
      s.querySelector('#dj-fade').onchange = (e) => { if (NEXA.fx && NEXA.fx.setFade) NEXA.fx.setFade(e.target.checked ? 6 : 0); };
      const info = s.querySelector('#dj-an'), btn = s.querySelector('#dj-analyse');
      const tick = (i, tot, end) => {
        if (!s.isConnected) return;
        info.textContent = end ? `${all().filter(done).length} / ${S.tracks.size} titres analysés.` : `Analyse… ${i} / ${tot}`;
        btn.textContent = end ? 'Analyser mes titres' : 'Arrêter'; if (end) btn.disabled = all().every(done);
      };
      btn.onclick = () => { if (running) { stop = true; btn.textContent = 'Arrêt…'; } else { btn.textContent = 'Arrêter'; analyseAll(tick); } };
      if (running) btn.textContent = 'Arrêter';
      s.querySelector('[data-done]').onclick = c.closeSheet;
    });
  }

  NEXA.actions.dj = openDJ;
  NEXA.dj = { moods: MOODS, features, analyseBlob, build, start, regen, analyseAll };
});
})(typeof window !== 'undefined' ? window : globalThis);
