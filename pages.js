/* NEXA — pages et panneaux (Accueil, Explorer, Profil, genres, mixes, historique, égaliseur, similaires).
   Chaque page est une fonction (core, argument) enregistrée avec NEXA.defineView.
   Le noyau (app.js) fournit « core » : état, lecteur, base de données, composants communs. */
(function (g) {
'use strict';
const NEXA = g.NEXA = g.NEXA || {};
NEXA.views = NEXA.views || {};
NEXA.defineView = (name, fn) => { NEXA.views[name] = fn; };
const I = () => NEXA.intel;

const mixCover = (c, m, cls = '') => `<div class="cover mixcover ${cls}" style="--g1:${m.g[0]};--g2:${m.g[1]}">${c.icon(m.icon || 'note')}</div>`;
const greeting = () => { const h = new Date().getHours(); return h < 5 || h >= 18 ? 'Bonsoir' : h < 12 ? 'Bonjour' : 'Bon après-midi'; };
const PERIOD_TXT = { nuit: 'la nuit', matin: 'le matin', 'après-midi': 'l’après-midi', soir: 'le soir' };

function head(c, title, sub) {
  return `<header class="pg-head"><div><h1 class="grad">${title}</h1>${sub ? `<p class="muted">${sub}</p>` : ''}</div>
    <div class="head-actions"><button class="icon-btn glass" data-go="#/search" aria-label="Rechercher">${c.icon('search')}</button></div></header>`;
}
function recRow(c, t, list) {
  return `<div class="rec-row" data-shelf="${list}" data-id="${t.id}">${c.coverHTML(t, 'sm')}
    <div class="meta"><div class="t">${c.esc(t.title)}</div><div class="a">${c.esc(t.artist)}</div></div>
    <button class="icon-btn like-btn${t.liked ? ' on' : ''}" data-like="${t.id}" aria-label="J’aime">${c.icon('heart')}</button>
    <span class="pbtn">${c.icon('play', 'f')}</span></div>`;
}
function bindLikes(c, root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-like]'); if (!b) return;
    e.stopPropagation();
    c.toggleLike(b.dataset.like).then(() => { const t = c.S.tracks.get(b.dataset.like); $$all(root, `[data-like="${b.dataset.like}"]`).forEach((x) => x.classList.toggle('on', !!(t && t.liked))); });
  }, true);
}
const $$all = (r, s) => [...r.querySelectorAll(s)];
const mixCard = (c, m) => `<div class="card mixcard" data-go="#/mix/${encodeURIComponent(m.id)}">${mixCover(c, m)}<div class="t">${c.esc(m.name)}</div><div class="a">${c.plural(m.ids.length, 'titre')}</div></div>`;
const trackCard = (c, t, list) => `<div class="card" data-shelf="${list}" data-id="${t.id}">${c.coverHTML(t)}<span class="pbtn over">${c.icon('play', 'f')}</span><div class="t">${c.esc(t.title)}</div><div class="a">${c.esc(t.artist)}</div></div>`;

/* ===================== ACCUEIL ===================== */
const albumCard = (c, n, ts) => `<div class="card" data-go="#/album/${encodeURIComponent(n)}">${c.coverHTML(c.firstWithCover(ts))}<div class="t">${c.esc(n)}</div><div class="a">${c.esc(ts[0].artist)}</div></div>`;
function resumeCard(c) {
  const cur = c.S.cur && c.S.tracks.get(c.S.cur);
  if (!cur) return '';
  const d = c.getDur(), pos = c.audio.currentTime || ((c.LS.get('pos', null) || {}).t || 0);
  const pct = d ? Math.max(0, Math.min(100, (pos / d) * 100)) : 0;
  const playing = !c.audio.paused && !!c.audio.src;
  return `<div class="resume glass" data-act="open-np">${c.coverHTML(cur, 'md')}
    <div class="meta"><span class="kicker">${playing ? 'En cours de lecture' : 'Reprendre la lecture'}</span><div class="t">${c.esc(cur.title)}</div><div class="a">${c.esc(cur.artist)}</div>
    <div class="rbar"><i style="width:${pct.toFixed(1)}%"></i></div></div>
    <button class="play-btn" data-act="resume" aria-label="Lecture / pause">${c.icon(playing ? 'pause' : 'play', 'f')}</button></div>`;
}
NEXA.defineView('home', (c) => {
  const { view, esc, icon, plural } = c;
  const all = c.allTracks(), now = Date.now();
  const name = c.LS.get('name', '');
  const top = `<header class="home-head"><div class="brand-mini"><img src="logo.png" alt="" width="40" height="40"><div class="wm"><b>NEXA</b><small>Feel the music</small></div></div>
    <div class="head-actions"><button class="icon-btn install glass" data-act="install" aria-label="Installer l’application" hidden>${icon('download')}</button>
    <button class="icon-btn glass" data-act="import" aria-label="Ajouter de la musique">${icon('upload')}</button>
    <button class="icon-btn glass" data-go="#/profile" aria-label="Profil">${icon('user')}</button></div></header>`;
  if (!all.length) { view.innerHTML = top + c.emptyHTML(); c.syncInstallButtons(); return; }

  const mixes = I().mixes(all, now);
  const lists = {}; mixes.forEach((m) => { lists['mix:' + m.id] = m.ids; });
  // 4. Sélection recommandée
  let heroes = mixes.filter((m) => ['moment', 'recs', 'top'].includes(m.id)).slice(0, 3);
  if (!heroes.length) { const ids = all.slice().sort(c.byRecent).map((t) => t.id); heroes = [{ id: 'recent', name: 'Votre musique', sub: 'Ajoutée récemment', ids, g: ['#4d7cff', '#a24bff'], icon: 'note' }]; lists['mix:recent'] = ids; }
  // 5. Écoutés récemment
  const recent = [...new Set(c.S.history)].map((id) => c.S.tracks.get(id)).filter(Boolean).slice(0, 20);
  const fresh = all.filter((t) => now - t.addedAt < 7 * 864e5).sort(c.byRecent).slice(0, 16);
  // 6-7. Artistes et albums
  const artists = [...c.groupBy(all, 'artist')].filter(([n]) => n !== NEXA.UNKNOWN_ARTIST).sort((a, b) => b[1].length - a[1].length).slice(0, 14);
  const albums = [...c.groupBy(all.filter((t) => t.album !== NEXA.UNKNOWN_ALBUM), 'album')].sort((a, b) => b[1].length - a[1].length).slice(0, 14);
  // 9. Découvertes : titres jamais écoutés, sinon ceux à redécouvrir
  const disc = mixes.find((m) => m.id === 'discover') || mixes.find((m) => m.id === 'forgotten');
  const discTracks = disc ? disc.ids.slice(0, 4).map((id) => c.S.tracks.get(id)).filter(Boolean) : [];
  lists.recent = recent.map((t) => t.id); lists.fresh = fresh.map((t) => t.id); lists.disc = disc ? disc.ids : [];
  view._lists = lists;
  // 10. Statistiques
  const h = I().habits(all, now, c.LS.get('since', now));

  const hero = (m, i) => {
    const first = c.S.tracks.get(m.ids[0]);
    return `<article class="hero" style="--g1:${m.g[0]};--g2:${m.g[1]}" data-go="#/mix/${encodeURIComponent(m.id)}">
      <div class="hero-tx"><span class="tag">${i === 0 ? 'Pour vous' : i === 1 ? 'Sélection' : 'À écouter'}</span><h2>${esc(m.name)}</h2><p>${esc(m.sub)} · ${plural(m.ids.length, 'titre')}</p>
        <button class="hero-play" data-shelf="mix:${m.id}" data-id="${m.ids[0]}">${icon('play', 'f')}<span>Lire</span></button></div>
      <div class="hero-art">${first ? c.coverHTML(first, 'hero-cover') : mixCover(c, m, 'hero-cover')}</div></article>`;
  };
  const likedN = all.filter((t) => t.liked).length;
  const plCards = `<div class="card" data-go="#/liked">${c.likedCover()}<div class="t">Titres likés</div><div class="a">${plural(likedN, 'titre')}</div></div>` +
    c.S.playlists.slice().reverse().map((p) => `<div class="card" data-go="#/playlist/${p.id}">${c.playlistCover(p)}<div class="t">${esc(p.name)}</div><div class="a">${plural(p.ids.length, 'titre')}</div></div>`).join('') +
    `<div class="card newpl" data-act="new-playlist"><div class="cover">${icon('plus')}</div><div class="t">Nouvelle playlist</div><div class="a">Créer</div></div>`;
  const stat = (v, l) => `<div><b>${v}</b><span>${l}</span></div>`;

  view.innerHTML = top + `
    <div class="greet"><h1>${greeting()}${name ? `, <span class="grad">${esc(name)}</span>` : ''}</h1><p class="muted">Ressentez chaque note.</p></div>
    ${resumeCard(c)}
    <div class="sec-row"><h2 class="sec">Sélection recommandée</h2><button class="link" data-go="#/explore">Explorer</button></div>
    <div class="hero-row">${heroes.map(hero).join('')}</div>
    ${fresh.length ? `<div class="sec-row"><h2 class="sec">Ajoutés récemment</h2></div><div class="shelf">${fresh.map((t) => trackCard(c, t, 'fresh')).join('')}</div>` : ''}
    ${recent.length ? `<div class="sec-row"><h2 class="sec">Écoutés récemment</h2><button class="link" data-go="#/history">Voir tout</button></div><div class="shelf">${recent.map((t) => trackCard(c, t, 'recent')).join('')}</div>` : ''}
    ${artists.length ? `<div class="sec-row"><h2 class="sec">Vos artistes</h2><button class="link" data-go="#/library/artists">Voir tout</button></div><div class="shelf">${artists.map(([n, ts]) => `<div class="card artist" data-go="#/artist/${encodeURIComponent(n)}">${c.coverHTML(c.firstWithCover(ts), 'round')}<div class="t">${esc(n)}</div><div class="a">${plural(ts.length, 'titre')}</div></div>`).join('')}</div>` : ''}
    ${albums.length ? `<div class="sec-row"><h2 class="sec">Vos albums</h2><button class="link" data-go="#/library/albums">Voir tout</button></div><div class="shelf">${albums.map(([n, ts]) => albumCard(c, n, ts)).join('')}</div>` : ''}
    <div class="sec-row"><h2 class="sec">Vos playlists</h2><button class="link" data-go="#/library/playlists">Voir tout</button></div><div class="shelf">${plCards}</div>
    ${discTracks.length ? `<div class="sec-row"><h2 class="sec">${disc.id === 'discover' ? 'Découvertes musicales' : 'À redécouvrir'}</h2><button class="link" data-go="#/mix/${disc.id}">Voir tout</button></div><div class="rec-list">${discTracks.map((t) => recRow(c, t, 'disc')).join('')}</div>` : ''}
    <div class="sec-row"><h2 class="sec">Statistiques d’écoute</h2><button class="link" data-go="#/profile">Détails</button></div>
    <div class="home-stats glass" data-go="#/profile">
      <div class="hs-grid">${stat(h.plays, 'écoutes')}${stat(h.seconds ? c.fmtTotal(h.seconds) : '0 min', 'd’écoute')}${stat(h.liked, 'favoris')}</div>
      <p class="habit">${h.plays ? `Vous écoutez surtout <b>${PERIOD_TXT[h.period] || 'le soir'}</b>${h.topArtist ? `, souvent <b>${esc(h.topArtist.name)}</b>` : ''}.` : 'Écoutez quelques titres : NEXA apprendra vos habitudes, sans rien envoyer en ligne.'}</p>
    </div>`;
  bindLikes(c, view);
  c.syncInstallButtons();
});

/* ===================== EXPLORER ===================== */
NEXA.defineView('explore', (c) => {
  const { view, esc, icon, plural } = c;
  const all = c.allTracks(), now = Date.now();
  if (!all.length) { view.innerHTML = head(c, 'Explorer', 'Découvrez votre musique autrement') + c.emptyHTML(); return; }
  const fams = I().families(all), decs = I().decades(all), mixes = I().mixes(all, now);
  const trend = all.some((t) => t.plays > 0) ? all.filter((t) => t.plays > 0).sort((a, b) => b.plays - a.plays).slice(0, 6) : all.slice().sort(c.byRecent).slice(0, 6);
  const lists = {}; lists.trend = trend.map((t) => t.id); view._lists = lists;
  const gen = (f) => `<button class="gen" data-go="#/genre/${encodeURIComponent(f.name)}" style="--g1:${f.g[0]};--g2:${f.g[1]}"><span class="gi">${icon(f.icon)}</span><span class="gn">${esc(f.name)}</span><small>${plural(f.n, 'titre')}</small></button>`;
  view.innerHTML = head(c, 'Explorer', 'Classé automatiquement selon vos fichiers') + `
    <div class="gen-row">${fams.map(gen).join('')}</div>
    <div class="sec-row"><h2 class="sec">${all.some((t) => t.plays > 0) ? 'Tendances chez vous' : 'Pour commencer'}</h2></div>
    <div class="rec-list">${trend.map((t) => recRow(c, t, 'trend')).join('')}</div>
    ${mixes.length ? `<h2 class="sec">Faits pour vous</h2><div class="shelf">${mixes.map((m) => mixCard(c, m)).join('')}</div>` : ''}
    ${decs.length ? `<h2 class="sec">Par décennie</h2><div class="tiles">${decs.map((d) => `<div class="tile dec" data-go="#/mix/${encodeURIComponent('dec:' + d.decade)}">${d.decade >= 2000 ? d.decade : 'Années ' + String(d.decade).slice(2)}<small>${plural(d.n, 'titre')}</small></div>`).join('')}</div>` : ''}`;
  bindLikes(c, view);
});

/* ===================== GENRE / MIX / HISTORIQUE ===================== */
NEXA.defineView('genre', (c, name) => {
  const ts = c.allTracks().filter((t) => t.fam === name).sort((a, b) => (b.plays || 0) - (a.plays || 0) || c.coll.compare(a.title, b.title));
  if (!ts.length) { location.hash = '#/explore'; return; }
  const fi = I().famInfo(name);
  c.collectionView({ kind: 'Genre', name, cover: mixCover(c, { g: fi.g, icon: fi.icon }), tracks: ts, color: fi.g[0] });
});
NEXA.defineView('mix', (c, id) => {
  const all = c.allTracks(), m = I().mixById(id, all, Date.now());
  const ts = m ? m.ids.map((x) => c.S.tracks.get(x)).filter(Boolean) : [];
  if (!m || !ts.length) { location.hash = '#/explore'; return; }
  c.collectionView({ kind: 'Mix', name: m.name, sub: m.sub, cover: mixCover(c, m), tracks: ts, color: m.g[0] });
});
NEXA.defineView('history', (c) => {
  const ts = [...new Set(c.S.history)].map((id) => c.S.tracks.get(id)).filter(Boolean);
  c.collectionView({ kind: 'Historique', name: 'Écoutés récemment', cover: mixCover(c, { g: ['#4d7cff', '#a24bff'], icon: 'clock' }), tracks: ts, color: '#4d7cff', empty: 'Votre historique d’écoute apparaîtra ici.' });
});

/* ===================== PROFIL ===================== */
NEXA.defineView('profile', (c) => {
  const { view, esc, icon, plural } = c;
  const all = c.allTracks(), now = Date.now();
  const h = I().habits(all, now, c.LS.get('since', now));
  const name = c.LS.get('name', '');
  const max = Math.max(1, ...h.hours), curH = new Date().getHours();
  const bars = h.hours.map((v, i) => `<i class="${i === curH ? 'now' : ''}" style="--h:${Math.max(4, Math.round((v / max) * 100))}%" title="${i} h : ${v}"></i>`).join('');
  const stat = (v, l) => `<div class="stat glass"><b>${v}</b><span>${l}</span></div>`;
  const item = (ic, label, attrs, sub) => `<button class="s-item pf-item" ${attrs}>${icon(ic)}<span>${label}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</button>`;
  view.innerHTML = `
    <header class="pf-head"><div class="avatar big"><img src="logo.png" alt=""></div>
      <div><h1>${name ? esc(name) : 'Votre profil'}</h1><p class="muted">Auditeur NEXA</p></div></header>
    <div class="stats">${stat(h.plays, plural(h.plays, 'écoute').replace(/^\d+ /, ''))}${stat(h.seconds ? c.fmtTotal(h.seconds) : '0 min', 'd’écoute')}${stat(all.length, 'titres')}${stat(h.liked, 'favoris')}</div>
    <h2 class="sec">Vos habitudes</h2>
    <div class="glass panel">
      <p class="habit">${h.plays ? `Vous écoutez surtout <b>${PERIOD_TXT[h.period] || 'le soir'}</b>${h.topFamily ? `, avec une préférence pour le <b>${esc(h.topFamily.name)}</b>` : ''}.` : 'Écoutez quelques titres : NEXA apprendra vos habitudes, sans rien envoyer en ligne.'}</p>
      <div class="hours" aria-label="Écoutes par heure">${bars}</div>
      <div class="hours-ax"><span>0 h</span><span>6 h</span><span>12 h</span><span>18 h</span><span>24 h</span></div>
      ${h.topArtist ? `<div class="pf-tags"><span class="chip on-grad">${icon('user')}${esc(h.topArtist.name)}</span>${h.topFamily ? `<span class="chip on-grad">${icon('disc')}${esc(h.topFamily.name)}</span>` : ''}<span class="chip on-grad">${icon('clock')}${Math.round(h.perDay * 10) / 10} / jour</span></div>` : ''}
    </div>
    <h2 class="sec">Réglages</h2>
    <div class="glass panel list">
      ${item('palette', 'Apparence et thèmes', 'data-act="theme"', NEXA.themes ? esc(NEXA.themes.current.name) : '')}
      ${NEXA.native && NEXA.native.available ? item('shield', 'Autorisations et arrière-plan', 'data-act="perms"', '') : ''}
      ${item('image', 'Pochettes en ligne', 'data-act="covers"', c.LS.get('onlineCovers', false) ? 'Activé' : 'Désactivé')}
      ${item('sliders', 'Égaliseur', 'data-act="eq"', NEXA.eq.state.on ? NEXA.eq.state.preset : 'Désactivé')}
      ${item('wave', 'Réglages de lecture', 'data-act="playback-settings"', NEXA.fx ? NEXA.fx.summary() : '')}
      ${item('timer', 'Minuteur de sommeil', 'data-act="sleep"')}
      ${item('clock', 'Historique d’écoute', 'data-go="#/history"')}
      ${item('upload', 'Ajouter de la musique', 'data-act="import"')}
      ${item('folder', 'Scanner un dossier', 'data-act="import-folder"')}
      ${item('edit', 'Modifier mon prénom', 'data-act="set-name"', esc(name))}
      <button class="s-item pf-item install" data-act="install" hidden>${icon('download')}<span>Installer l’application</span></button>
      ${item('trash', 'Effacer l’historique d’écoute', 'data-act="clear-history"')}
    </div>
    <p class="muted fine" id="storage-info"></p>
    <p class="muted fine">NEXA lit uniquement les fichiers que vous choisissez : aucun accès au reste du téléphone, aucune donnée envoyée sur Internet. Pour ajouter toute votre musique d’un coup, utilisez « Scanner un dossier ».</p>`;
  c.syncInstallButtons(); c.showStorage();
});

/* ===================== ÉGALISEUR ===================== */
function openEQ(c) {
  const eq = NEXA.eq, st = eq.state;
  if (!eq.supported()) { c.toast('Égaliseur non pris en charge par ce navigateur'); return; }
  const fmtDb = (v) => (v > 0 ? '+' : '') + v + ' dB';
  const html = `<div class="sheet-title">Égaliseur</div>
    <label class="eq-top"><span>Activer l’égaliseur</span><input type="checkbox" class="switch" id="eq-on"${st.on ? ' checked' : ''}></label>
    <div class="eq-presets">${Object.keys(eq.PRESETS).map((p) => `<button class="chip${st.preset === p ? ' on' : ''}" data-p="${p}">${p}</button>`).join('')}</div>
    <div class="eq-bands">${eq.BANDS.map((f, i) => `<div class="eq-band"><span class="f">${eq.LABELS[i]}</span><input type="range" min="-12" max="12" step="1" value="${st.gains[i]}" data-b="${i}" style="--p:${((st.gains[i] + 12) / 24) * 100}%"><span class="v">${fmtDb(st.gains[i])}</span></div>`).join('')}</div>
    <div class="s-row"><button class="btn" data-done>Terminé</button></div>`;
  c.openSheet(html, (s) => {
    const save = () => c.LS.set('eq', eq.snapshot());
    const sync = () => {
      s.querySelectorAll('[data-b]').forEach((r) => { const i = +r.dataset.b; r.value = st.gains[i]; r.style.setProperty('--p', ((st.gains[i] + 12) / 24) * 100 + '%'); r.nextElementSibling.textContent = fmtDb(st.gains[i]); });
      s.querySelectorAll('[data-p]').forEach((b) => b.classList.toggle('on', b.dataset.p === st.preset));
    };
    s.querySelector('#eq-on').onchange = (e) => { if (!eq.setOn(e.target.checked)) { e.target.checked = false; c.toast('Égaliseur indisponible'); } save(); };
    s.querySelectorAll('[data-p]').forEach((b) => { b.onclick = () => { if (!st.on) { s.querySelector('#eq-on').checked = true; eq.setOn(true); } eq.setPreset(b.dataset.p); sync(); save(); }; });
    s.querySelectorAll('[data-b]').forEach((r) => {
      r.oninput = () => { if (!st.on) { s.querySelector('#eq-on').checked = true; eq.setOn(true); } eq.setBand(+r.dataset.b, +r.value); sync(); };
      r.onchange = save;
    });
    s.querySelector('[data-done]').onclick = c.closeSheet;
  });
}

/* ===================== TITRES SIMILAIRES ===================== */
function showSimilar(c) {
  const cur = c.S.tracks.get(c.S.cur);
  if (!cur) { c.toast('Lancez d’abord un titre'); return; }
  const list = I().similar(cur, c.allTracks(), 20);
  if (!list.length) { c.toast('Pas encore de titre similaire'); return; }
  const rows = list.map((t) => `<button class="s-item sim" data-id="${t.id}">${c.coverHTML(t, 'sm')}<span class="sx"><b>${c.esc(t.title)}</b><small>${c.esc(t.artist)}${t.fam && t.fam !== I().NONE ? ' · ' + c.esc(t.fam) : ''}</small></span></button>`).join('');
  c.openSheet(`<div class="sheet-title">Similaires à « ${c.esc(cur.title)} »</div>
    <div class="s-row" style="margin-bottom:8px"><button class="btn" data-all>${c.icon('play', 'f')}Lire</button><button class="btn sec" data-q>Ajouter à la file</button></div>${rows}`, (s) => {
    s.querySelector('[data-all]').onclick = () => { c.closeSheet(); c.play(list.map((t) => t.id), list[0].id); };
    s.querySelector('[data-q]').onclick = () => { c.closeSheet(); c.queueAdd(list.map((t) => t.id)); };
    s.querySelectorAll('.sim').forEach((b) => { b.onclick = () => { c.closeSheet(); c.play([b.dataset.id, ...list.map((t) => t.id).filter((x) => x !== b.dataset.id)], b.dataset.id); }; });
  });
}

NEXA.ui = { openEQ, showSimilar, resumeHTML: resumeCard };
})(typeof window !== 'undefined' ? window : globalThis);
