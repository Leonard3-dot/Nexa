/* NEXA — lecteur avancé : visualiseur audio réel, paroles (synchronisées ou non), minuteur de sommeil, fondu entre les titres.
   Module chargé après pages.js ; il reçoit « core » (état, base de données, lecteur) au démarrage.
   Aucune fonction simulée : si le navigateur ne sait pas faire quelque chose, le bouton ou l'effet disparaît. */
(function (g) {
'use strict';
const NEXA = g.NEXA = g.NEXA || {};
const fx = NEXA.fx = { fade: 0, viz: true, summary: () => '' };

/* ---------- Paroles : lecture des formats LRC / texte brut (sans DOM, testable seul) ---------- */
function parseLyrics(text) {
  text = String(text || '').replace(/^﻿/, '');
  const stamp = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const lines = []; let offset = 0;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*((?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/);
    if (m) {
      const txt = m[2].replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, '').trim();   // minutage par mot (LRC étendu) ignoré
      for (const tm of m[1].matchAll(stamp)) {
        const t = (+tm[1]) * 60 + (+tm[2]) + (tm[3] ? (+tm[3]) / Math.pow(10, tm[3].length) : 0);
        lines.push({ t, text: txt });
      }
    } else { const o = raw.match(/^\s*\[offset:\s*(-?\d+)\s*\]/i); if (o) offset = (+o[1]) / 1000; }
  }
  if (lines.length >= 2) {
    lines.sort((a, b) => a.t - b.t); lines.forEach((l) => { l.t = Math.max(0, l.t + offset); });
    return { synced: true, lines };
  }
  const plain = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => !/^\[[a-z]{2,8}:.*\]$/i.test(l));
  const out = []; plain.forEach((l) => { if (l || (out.length && out[out.length - 1].text)) out.push({ t: null, text: l }); });
  while (out.length && !out[out.length - 1].text) out.pop();
  return { synced: false, lines: out };
}
fx.parseLyrics = parseLyrics;

NEXA.defineModule((c) => {
  const { audio, S, LS, hooks, gains, DB, esc, icon, toast, openSheet, closeSheet, menuSheet, npEl } = c;
  const $ = (s, r = document) => r.querySelector(s);
  const npOpen = () => npEl.classList.contains('open');
  const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };

  /* =====================================================================
     1. Visualiseur audio RÉEL
     Les barres lisent le spectre du son (AnalyserNode). Pour ne rien changer au chemin de lecture
     (donc ne jamais risquer la lecture en arrière-plan), on « écoute » une copie du flux avec
     captureStream() ; si l'égaliseur est actif, on lit directement sa sortie.
     La boucle ne tourne que si le lecteur plein écran est ouvert, visible et en lecture.
     ===================================================================== */
  fx.viz = LS.get('viz', true);
  const wave = $('.np-wave', npEl);
  const bars = wave ? [...wave.querySelectorAll('i')] : [];
  const canCapture = typeof audio.captureStream === 'function';
  const AC = g.AudioContext || g.webkitAudioContext;
  const viz = { ctx: null, an: null, node: null, data: null, raf: 0, lv: new Float32Array(Math.max(1, bars.length)), live: false };
  const EDGES = [1, 3, 6, 12, 24, 48, 96, 180];   // limites des bandes (en « cases » de la FFT)

  function analyserNow() {
    const eqAn = NEXA.eq && NEXA.eq.analyser && NEXA.eq.analyser();
    if (eqAn) return eqAn;
    return viz.an;
  }
  function connectCapture() {
    if (!fx.viz || !canCapture || !AC) return false;
    if (NEXA.eq && NEXA.eq.analyser && NEXA.eq.analyser()) return true;   // l'égaliseur fournit déjà le spectre
    try {
      if (!viz.ctx) {
        viz.ctx = new AC(); viz.an = viz.ctx.createAnalyser();
        viz.an.fftSize = 512; viz.an.smoothingTimeConstant = 0.55; viz.data = new Uint8Array(viz.an.frequencyBinCount);
      }
      if (viz.ctx.state === 'suspended') viz.ctx.resume().catch(() => {});
      const stream = audio.captureStream();
      if (!stream.getAudioTracks().length) return false;
      if (viz.node) { try { viz.node.disconnect(); } catch { /* ignore */ } }
      viz.node = viz.ctx.createMediaStreamSource(stream);
      viz.node.connect(viz.an);   // volontairement NON relié à la sortie : aucun son en double
      return true;
    } catch { return false; }
  }
  function setBars(levels) {
    for (let i = 0; i < bars.length; i++) bars[i].style.setProperty('--s', (0.12 + 0.88 * (levels[i] || 0)).toFixed(3));
  }
  function idleBars() {
    // Au repos : silhouette fixe, aucune animation (économie de batterie)
    bars.forEach((b, i) => b.style.setProperty('--s', (0.14 + 0.12 * ((i * 37) % 7) / 6).toFixed(3)));
    npEl.style.setProperty('--beat', '0'); wave && wave.classList.remove('live');
  }
  function frame() {
    viz.raf = 0;
    const an = analyserNow();
    if (!an || audio.paused || document.hidden || !npOpen() || !fx.viz) { idleBars(); return; }
    const data = an === viz.an ? viz.data : (viz.eqData && viz.eqData.length === an.frequencyBinCount ? viz.eqData : (viz.eqData = new Uint8Array(an.frequencyBinCount)));
    an.getByteFrequencyData(data);
    const scale = data.length / 256, n = bars.length;
    let bass = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.floor(EDGES[Math.min(i, EDGES.length - 2)] * scale), b = Math.max(a + 1, Math.floor(EDGES[Math.min(i + 1, EDGES.length - 1)] * scale));
      let sum = 0; for (let k = a; k < b && k < data.length; k++) sum += data[k];
      const raw = Math.pow(sum / ((b - a) * 255), 1.35) * 1.5;
      viz.lv[i] = Math.max(Math.min(1, raw), viz.lv[i] * 0.84);     // montée immédiate, descente douce
      if (i < 2) bass += viz.lv[i] / 2;
    }
    setBars(viz.lv);
    npEl.style.setProperty('--beat', bass.toFixed(3));              // lueur de la pochette synchronisée
    wave.classList.add('live');
    viz.raf = requestAnimationFrame(frame);
  }
  function syncViz() {
    if (!wave) return;
    const supported = fx.viz && (canCapture || (NEXA.eq && NEXA.eq.analyser && NEXA.eq.analyser()));
    wave.classList.toggle('no-viz', !supported);
    if (!supported || !npOpen() || audio.paused || document.hidden) { if (viz.raf) { cancelAnimationFrame(viz.raf); viz.raf = 0; } idleBars(); return; }
    if (!analyserNow() || !viz.live) viz.live = connectCapture() || !!analyserNow();
    if (!viz.raf) viz.raf = requestAnimationFrame(frame);
  }
  audio.addEventListener('playing', () => { viz.live = false; syncViz(); });   // nouveau flux à chaque titre : on se rebranche
  audio.addEventListener('pause', syncViz);
  document.addEventListener('visibilitychange', syncViz);
  new MutationObserver(syncViz).observe(npEl, { attributes: true, attributeFilter: ['class'] });
  idleBars(); syncViz();

  /* =====================================================================
     2. Paroles
     ===================================================================== */
  const panel = document.createElement('div');
  panel.id = 'lyrics-panel';
  panel.innerHTML = `<div class="q-head"><b>Paroles</b><div class="ly-tools"><button class="icon-btn" data-ly="menu" aria-label="Options des paroles">${icon('more')}</button><button class="icon-btn" data-act="lyrics" aria-label="Fermer">${icon('x')}</button></div></div><div id="ly-title"></div><div id="ly-body" tabindex="-1"></div>`;
  npEl.appendChild(panel);
  const body = $('#ly-body', panel);
  const lyIn = document.createElement('input'); lyIn.type = 'file'; lyIn.accept = '.lrc,.txt,text/plain'; lyIn.hidden = true; document.body.appendChild(lyIn);
  const ly = { id: null, rec: null, lines: [], synced: false, idx: -1, hold: 0 };
  const lyOpen = () => panel.classList.contains('open');

  async function loadLyrics() {
    const id = S.cur; ly.id = id; ly.idx = -1;
    let rec = null;
    try { rec = id ? await DB.get('lyrics', id) : null; } catch { rec = null; }
    if (ly.id !== id) return;
    ly.rec = rec;
    const p = rec && rec.text ? parseLyrics(rec.text) : { synced: false, lines: [] };
    ly.lines = p.lines; ly.synced = p.synced;
    renderLyrics();
  }
  function renderLyrics() {
    const t = S.tracks.get(S.cur);
    $('#ly-title', panel).textContent = t ? `${t.title} — ${t.artist}` : '';
    if (!ly.lines.length) {
      body.innerHTML = `<div class="ly-empty">${icon('lyrics')}<p>Pas de paroles pour ce titre.</p>
        <p class="muted">Importez un fichier <b>.lrc</b> (paroles synchronisées) ou <b>.txt</b>, ou collez le texte.</p>
        <button class="btn" data-ly="import">Importer un fichier</button><button class="btn sec" data-ly="paste">Coller des paroles</button></div>`;
      return;
    }
    body.innerHTML = `<div class="ly-pad"></div>${ly.lines.map((l, i) => `<p class="ly${ly.synced ? ' sy' : ''}${l.text ? '' : ' gap'}" data-i="${i}">${esc(l.text) || '&nbsp;'}</p>`).join('')}<div class="ly-pad"></div>
      ${ly.synced ? '' : '<p class="ly-note">Paroles non synchronisées : ajoutez un fichier .lrc pour qu’elles défilent avec la musique.</p>'}`;
    body.scrollTop = 0;
    if (ly.synced) updateActive(true);
  }
  function updateActive(force) {
    if (!lyOpen() || !ly.synced || !ly.lines.length) return;
    const ct = (audio.currentTime || 0) + 0.2;
    let lo = 0, hi = ly.lines.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (ly.lines[mid].t <= ct) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    if (idx === ly.idx && !force) return;
    const prev = body.querySelector('.ly.on'); if (prev) prev.classList.remove('on');
    ly.idx = idx;
    const el = idx >= 0 ? body.querySelector(`.ly[data-i="${idx}"]`) : null;
    if (!el) return;
    el.classList.add('on');
    if (Date.now() > ly.hold) body.scrollTo({ top: Math.max(0, el.offsetTop - body.clientHeight / 2 + el.offsetHeight / 2), behavior: force ? 'auto' : 'smooth' });
  }
  const holdScroll = () => { ly.hold = Date.now() + 3500; };
  body.addEventListener('touchstart', holdScroll, { passive: true });
  body.addEventListener('wheel', holdScroll, { passive: true });
  audio.addEventListener('timeupdate', () => { if (lyOpen() && !document.hidden) updateActive(false); });

  async function saveLyrics(text, src) {
    text = String(text || '').trim();
    if (!S.cur) return;
    if (!text) { await DB.del('lyrics', S.cur).catch(() => {}); toast('Paroles supprimées'); }
    else { await DB.put('lyrics', { text, synced: parseLyrics(text).synced, src }, S.cur).catch(() => toast('Enregistrement impossible')); toast('Paroles enregistrées'); }
    await loadLyrics();
  }
  function pasteSheet() {
    openSheet(`<div class="sheet-title">Coller des paroles</div>
      <textarea class="s-input ly-area" placeholder="Collez ici le texte, ou des lignes au format [01:23.45] paroles…" spellcheck="false">${esc(ly.rec ? ly.rec.text : '')}</textarea>
      <div class="s-row"><button class="btn sec" data-c>Annuler</button><button class="btn" data-ok>Enregistrer</button></div>`, (s) => {
      const ta = $('textarea', s);
      $('[data-c]', s).onclick = closeSheet;
      $('[data-ok]', s).onclick = () => { const v = ta.value; closeSheet(); saveLyrics(v, 'manual'); };
    });
  }
  lyIn.addEventListener('change', async () => {
    const f = lyIn.files[0]; lyIn.value = '';
    if (!f) return;
    try { await saveLyrics(await f.text(), 'file'); } catch { toast('Fichier illisible'); }
  });
  panel.addEventListener('click', (e) => {
    const line = e.target.closest('.ly.sy');
    if (line) { const l = ly.lines[+line.dataset.i]; if (l && l.t != null) { audio.currentTime = l.t; ly.hold = 0; updateActive(true); } return; }
    const b = e.target.closest('[data-ly]'); if (!b) return;
    const k = b.dataset.ly;
    if (k === 'import') lyIn.click();
    else if (k === 'paste') pasteSheet();
    else if (k === 'menu') {
      menuSheet(`<div class="sheet-title">Paroles</div>`, [
        { icon: 'upload', label: 'Importer un fichier .lrc / .txt', action: () => lyIn.click() },
        { icon: 'edit', label: ly.lines.length ? 'Modifier les paroles' : 'Coller des paroles', action: pasteSheet },
        ...(ly.lines.length ? [{ icon: 'trash', label: 'Supprimer les paroles', danger: true, action: () => saveLyrics('', 'manual') }] : [])
      ]);
    }
  });
  NEXA.actions.lyrics = () => {
    if (!S.cur) { toast('Lancez d’abord un titre'); return; }
    if (!npOpen()) return;
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) loadLyrics();
  };
  // Le panneau de paroles se ferme avec le lecteur
  new MutationObserver(() => { if (!npOpen()) panel.classList.remove('open'); }).observe(npEl, { attributes: true, attributeFilter: ['class'] });

  /* =====================================================================
     3. Minuteur de sommeil
     ===================================================================== */
  const sleep = { end: 0, atTrackEnd: false, iv: 0 };
  const chipLabel = $('#sleep-chip span');
  const chip = $('#sleep-chip');
  const mmss = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function sleepReset() {
    clearInterval(sleep.iv); sleep.iv = 0; sleep.end = 0; sleep.atTrackEnd = false;
    delete gains.sleep; c.applyVolume();
    if (chipLabel) chipLabel.textContent = 'Minuteur'; if (chip) chip.classList.remove('on');
  }
  function sleepTick() {
    if (!sleep.end) return;
    const left = (sleep.end - Date.now()) / 1000;
    if (left <= 0) { sleepReset(); audio.pause(); toast('Minuteur terminé · bonne nuit'); return; }
    if (left < 20) { gains.sleep = smooth(left / 20); c.applyVolume(); }   // le volume descend doucement pendant les 20 dernières secondes
    if (chipLabel) chipLabel.textContent = mmss(left);
  }
  function sleepStart(min) {
    sleepReset(); sleep.end = Date.now() + min * 60000;
    sleep.iv = setInterval(sleepTick, 500); sleepTick();
    if (chip) chip.classList.add('on');
    toast(`Minuteur réglé : ${min} min`);
  }
  function sleepAtEnd() {
    sleepReset(); sleep.atTrackEnd = true;
    if (chipLabel) chipLabel.textContent = 'Fin du titre'; if (chip) chip.classList.add('on');
    toast('La lecture s’arrêtera à la fin du titre');
  }
  hooks.stopAtEnd = () => { if (!sleep.atTrackEnd) return false; sleepReset(); toast('Minuteur terminé · bonne nuit'); return true; };
  NEXA.actions.sleep = () => {
    const active = sleep.end || sleep.atTrackEnd;
    const items = [5, 10, 15, 30, 45, 60, 90].map((m) => ({ icon: 'timer', label: m >= 60 ? `${m / 60 === 1 ? '1 heure' : '1 h 30'}` : `${m} minutes`, action: () => sleepStart(m) }));
    items.push({ icon: 'note', label: 'À la fin du titre en cours', action: sleepAtEnd });
    if (active) items.push({ icon: 'x', label: 'Désactiver le minuteur', danger: true, action: () => { sleepReset(); toast('Minuteur désactivé'); } });
    menuSheet(`<div class="sheet-title">Minuteur de sommeil</div>${active ? `<p class="s-msg">${sleep.end ? `Arrêt dans ${mmss((sleep.end - Date.now()) / 1000)}` : 'Arrêt à la fin du titre'}</p>` : ''}`, items);
  };

  /* =====================================================================
     4. Fondu entre les titres
     Le volume baisse sur les dernières secondes d'un titre et remonte au début du suivant.
     (Ce n'est PAS un chevauchement des deux titres : le navigateur ne lit qu'un fichier à la fois.)
     ===================================================================== */
  fx.fade = LS.get('fade', 0);
  let fadeIv = 0;
  function fadeTick() {
    const f = fx.fade;
    if (!f || audio.paused || S.repeat === 2) { if (gains.fade != null) { delete gains.fade; c.applyVolume(); } return; }
    const d = c.getDur(), t = audio.currentTime || 0;
    let gain = 1;
    if (t < f) gain = Math.min(gain, smooth(t / f));                                   // entrée progressive
    const hasNext = S.qi < S.queue.length - 1 || S.repeat === 1;
    if (d && hasNext && d - t < f) gain = Math.min(gain, smooth((d - t) / f));         // sortie progressive
    if (gain >= 0.999) { if (gains.fade != null) { delete gains.fade; c.applyVolume(); } }
    else { gains.fade = gain; c.applyVolume(); }
  }
  function fadeSync() {
    clearInterval(fadeIv); fadeIv = 0;
    if (fx.fade && !audio.paused) fadeIv = setInterval(fadeTick, 120);
    else if (gains.fade != null) { delete gains.fade; c.applyVolume(); }
  }
  audio.addEventListener('play', fadeSync); audio.addEventListener('pause', fadeSync);

  /* =====================================================================
     5. Réglages de lecture (Profil)
     ===================================================================== */
  fx.summary = () => (fx.fade ? `Fondu ${fx.fade} s` : '') + (!fx.viz ? (fx.fade ? ' · ' : '') + 'Visualiseur coupé' : '');
  NEXA.actions['playback-settings'] = () => {
    const opts = [0, 2, 4, 6, 8, 10];
    openSheet(`<div class="sheet-title">Réglages de lecture</div>
      <label class="eq-top"><span>Visualiseur audio<small class="sub-l">Les barres du lecteur suivent le son</small></span><input type="checkbox" class="switch" id="viz-on"${fx.viz ? ' checked' : ''}></label>
      <div class="sheet-sub">Fondu entre les titres</div>
      <div class="eq-presets" id="fade-opts">${opts.map((o) => `<button class="chip${fx.fade === o ? ' on' : ''}" data-f="${o}">${o ? o + ' s' : 'Désactivé'}</button>`).join('')}</div>
      <p class="s-msg">Le volume descend à la fin d’un titre et remonte au début du suivant. Les deux titres ne se chevauchent pas.</p>
      <div class="s-row"><button class="btn" data-done>Terminé</button></div>`, (s) => {
      $('#viz-on', s).onchange = (e) => { fx.viz = e.target.checked; LS.set('viz', fx.viz); viz.live = false; syncViz(); if (NEXA.refreshProfile) NEXA.refreshProfile(); };
      s.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => {
        fx.fade = +b.dataset.f; LS.set('fade', fx.fade); fadeSync();
        s.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === b));
      }; });
      $('[data-done]', s).onclick = () => { closeSheet(); c.refreshView(); };
    });
  };
  fadeSync();

  /* =====================================================================
     6. Accueil : la carte « Reprendre la lecture » suit la lecture
     ===================================================================== */
  const onHome = () => S.route === 'home' || S.route === '';
  function refreshResume() {
    if (!onHome() || !NEXA.ui || !NEXA.ui.resumeHTML) return;
    const html = NEXA.ui.resumeHTML(c), el = $('#view .resume');
    if (el) { if (html) el.outerHTML = html; else el.remove(); }
    else if (html) { const gr = $('#view .greet'); if (gr) gr.insertAdjacentHTML('afterend', html); }
  }
  hooks.onTrack.push(() => { refreshResume(); if (lyOpen()) loadLyrics(); });
  audio.addEventListener('play', refreshResume); audio.addEventListener('pause', refreshResume);
  audio.addEventListener('timeupdate', () => {
    if (!onHome() || document.hidden) return;
    const bar = $('#view .resume .rbar i'), d = c.getDur();
    if (bar && d) bar.style.width = Math.min(100, (audio.currentTime / d) * 100).toFixed(1) + '%';
  });
});

if (typeof module !== 'undefined') module.exports = NEXA;
})(typeof window !== 'undefined' ? window : globalThis);
