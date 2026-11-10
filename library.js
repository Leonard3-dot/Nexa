/* NEXA — Bibliothèque intelligente, recherche et dossiers.
   Pages enregistrées avec NEXA.defineView : elles remplacent les anciennes pages « library » et « search » du noyau
   (qui restent en secours). Tout est calculé sur l'appareil. */
(function (g) {
'use strict';
const NEXA = g.NEXA = g.NEXA || {};
const I = () => NEXA.intel;

/* ---------- Onglets et critères de tri ---------- */
const TABS = [['tracks', 'Titres'], ['albums', 'Albums'], ['artists', 'Artistes'], ['playlists', 'Playlists'], ['favorites', 'Favoris'], ['history', 'Historique'], ['folders', 'Dossiers'], ['genres', 'Genres']];
const SORTS = {
  tracks: [['recent', 'Ajoutés récemment'], ['az', 'Titre (A–Z)'], ['artist', 'Artiste'], ['album', 'Album'], ['plays', 'Plus écoutés'], ['dur', 'Durée']],
  albums: [['az', 'Nom (A–Z)'], ['artist', 'Artiste'], ['count', 'Nombre de titres'], ['recent', 'Ajoutés récemment']],
  artists: [['az', 'Nom (A–Z)'], ['count', 'Nombre de titres'], ['plays', 'Plus écoutés']],
  playlists: [['recent', 'Plus récentes'], ['az', 'Nom (A–Z)'], ['count', 'Nombre de titres']],
  favorites: [['liked', 'Aimés récemment'], ['az', 'Titre (A–Z)'], ['artist', 'Artiste']],
  folders: [['az', 'Nom (A–Z)'], ['count', 'Nombre de titres']]
};
const NOFOLDER = '\u0000sans-dossier';

const folderName = (p) => (p === NOFOLDER ? 'Sans dossier' : p.split('/').pop() || p);
const folderParent = (p) => (p === NOFOLDER ? 'Fichiers ajoutés un par un' : p.split('/').slice(0, -1).join(' › '));
const folderCover = (c, cls = '') => `<div class="cover mixcover ${cls}" style="--g1:#4d7cff;--g2:#8a4bff">${c.icon('folder')}</div>`;

function folders(c, all) {
  const m = c.groupBy(all, 'folder');
  const out = [];
  m.forEach((ts, k) => { out.push([k === '' || k === '?' ? NOFOLDER : k, ts]); });
  return out;
}
const hay = (c, t) => t._h || (t._h = c.norm(`${t.title} ${t.artist} ${t.album} ${t.genre || ''} ${t.fam || ''} ${t.year || ''} ${t.folder || ''}`));
const words = (c, q) => c.norm(q.trim()).split(/\s+/).filter(Boolean);
const matches = (hs, ws) => ws.every((w) => hs.includes(w));

/* =====================================================================
   BIBLIOTHÈQUE
   ===================================================================== */
NEXA.defineView('library', (c, arg) => {
  const { view, S, LS, esc, icon, plural, coll } = c;
  const valid = TABS.map((t) => t[0]);
  let tab = valid.includes(arg) ? arg : LS.get('libTab2', 'tracks');
  if (!valid.includes(tab)) tab = 'tracks';
  LS.set('libTab2', tab);
  let q = '';
  const sortOf = () => { const k = LS.get('lsort:' + tab, null); const list = SORTS[tab]; return list && list.some((s) => s[0] === k) ? k : list ? list[0][0] : ''; };

  view.innerHTML = `
    <div class="page-head"><h1>Bibliothèque</h1><div class="head-actions">
      <button class="icon-btn" data-act="import" title="Ajouter de la musique" aria-label="Ajouter de la musique">${icon('upload')}</button>
      <button class="icon-btn" data-act="import-folder" title="Scanner un dossier" aria-label="Scanner un dossier">${icon('folder')}</button>
      <button class="icon-btn" data-act="new-playlist" title="Nouvelle playlist" aria-label="Nouvelle playlist">${icon('plus')}</button></div></div>
    <div class="tabs-row" id="lib-tabs">${TABS.map(([k, l]) => `<button class="chip${tab === k ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div class="lib-tools" id="lib-tools"></div>
    <div id="lib-body"></div><p class="muted" id="storage-info" style="margin-top:28px;font-size:13px"></p>`;
  const body = view.querySelector('#lib-body'), tools = view.querySelector('#lib-tools'), tabsEl = view.querySelector('#lib-tabs');

  const plain = (go, cover, t, a) => `<div class="row plain" data-go="${go}">${cover}<div class="meta"><div class="t">${esc(t)}</div><div class="a">${esc(a)}</div></div></div>`;
  const hint = (txt) => `<p class="muted" style="padding:18px 4px">${txt}</p>`;

  function renderTools(count) {
    const hasSort = !!SORTS[tab], hasFilter = tab !== 'genres' && tab !== 'history';
    const sl = hasSort ? (SORTS[tab].find((s) => s[0] === sortOf()) || [])[1] : '';
    tools.innerHTML = `${hasFilter ? `<label class="lib-filter">${icon('search')}<input type="search" id="lib-q" placeholder="Filtrer…" value="${esc(q)}" autocomplete="off" spellcheck="false" enterkeyhint="search"></label>` : ''}
      ${hasSort ? `<button class="chip" data-sortbtn>${icon('sliders')}<span>${esc(sl)}</span></button>` : ''}<span class="lib-count">${count}</span>`;
    const inp = tools.querySelector('#lib-q');
    if (inp) inp.addEventListener('input', c.debounce(() => { q = inp.value; renderBody(true); }, 90));
  }
  function sortMenu() {
    const cur = sortOf();
    c.menuSheet(`<div class="sheet-title">Trier par</div>`, SORTS[tab].map(([k, l]) => ({ icon: k === cur ? 'check' : 'note', label: l, action: () => { LS.set('lsort:' + tab, k); renderBody(false); } })));
  }

  function renderBody(keepFocus) {
    c.cleanupLists();
    const all = c.allTracks(), ws = words(c, q), sort = sortOf();
    const pass = (t) => !ws.length || matches(hay(c, t), ws);
    const none = (msg) => { body.innerHTML = all.length ? hint(msg) : c.emptyHTML(); };
    let count = '';
    if (tab === 'tracks') {
      const arr = all.filter(pass);
      const A = (a, b) => coll.compare(a.title, b.title);
      if (sort === 'az') arr.sort(A);
      else if (sort === 'artist') arr.sort((a, b) => coll.compare(a.artist, b.artist) || coll.compare(a.album, b.album) || (a.no - b.no) || A(a, b));
      else if (sort === 'album') arr.sort((a, b) => coll.compare(a.album, b.album) || (a.no - b.no) || A(a, b));
      else if (sort === 'plays') arr.sort((a, b) => (b.plays || 0) - (a.plays || 0) || (b.lastPlayed || 0) - (a.lastPlayed || 0) || A(a, b));
      else if (sort === 'dur') arr.sort((a, b) => (b.duration || 0) - (a.duration || 0));
      else arr.sort(c.byRecent);
      count = plural(arr.length, 'titre');
      if (!arr.length) none('Aucun titre ne correspond.');
      else { body.innerHTML = `${c.listHead}<div class="tracklist" id="lib-list"></div>`; c.mountTrackList(body.querySelector('#lib-list'), arr); }
    } else if (tab === 'albums') {
      let groups = [...c.groupBy(all.filter((t) => t.album !== c.UNKNOWN_ALBUM), 'album')].filter(([n, ts]) => !ws.length || matches(c.norm(n + ' ' + ts[0].artist), ws));
      const newest = (ts) => Math.max(...ts.map((t) => t.addedAt));
      if (sort === 'artist') groups.sort((a, b) => coll.compare(a[1][0].artist, b[1][0].artist) || coll.compare(a[0], b[0]));
      else if (sort === 'count') groups.sort((a, b) => b[1].length - a[1].length || coll.compare(a[0], b[0]));
      else if (sort === 'recent') groups.sort((a, b) => newest(b[1]) - newest(a[1]));
      else groups.sort((a, b) => coll.compare(a[0], b[0]));
      count = plural(groups.length, 'album');
      body.innerHTML = groups.length ? groups.map(([n, ts]) => plain('#/album/' + encodeURIComponent(n), c.coverHTML(c.firstWithCover(ts), 'sm'), n, `${ts[0].artist} · ${plural(ts.length, 'titre')}`)).join('')
        : hint(all.length ? 'Aucun album ne correspond. Les albums apparaissent quand vos fichiers contiennent des informations (tags).' : '') || c.emptyHTML();
      if (!all.length) body.innerHTML = c.emptyHTML();
    } else if (tab === 'artists') {
      let groups = [...c.groupBy(all, 'artist')].filter(([n]) => !ws.length || matches(c.norm(n), ws));
      const plays = (ts) => ts.reduce((s, t) => s + (t.plays || 0), 0);
      if (sort === 'count') groups.sort((a, b) => b[1].length - a[1].length || coll.compare(a[0], b[0]));
      else if (sort === 'plays') groups.sort((a, b) => plays(b[1]) - plays(a[1]) || coll.compare(a[0], b[0]));
      else groups.sort((a, b) => coll.compare(a[0], b[0]));
      count = plural(groups.length, 'artiste');
      body.innerHTML = groups.length ? groups.map(([n, ts]) => plain('#/artist/' + encodeURIComponent(n), c.coverHTML(c.firstWithCover(ts), 'sm round'), n, `Artiste · ${plural(ts.length, 'titre')}`)).join('') : (all.length ? hint('Aucun artiste ne correspond.') : c.emptyHTML());
    } else if (tab === 'playlists') {
      let pls = S.playlists.filter((p) => !ws.length || matches(c.norm(p.name), ws));
      if (sort === 'az') pls = pls.slice().sort((a, b) => coll.compare(a.name, b.name));
      else if (sort === 'count') pls = pls.slice().sort((a, b) => b.ids.length - a.ids.length);
      else pls = pls.slice().reverse();
      const likedN = all.filter((t) => t.liked).length;
      count = plural(pls.length + 1, 'playlist');
      body.innerHTML = `<div class="row plain newpl-row" data-act="new-playlist"><div class="cover sm newpl-c">${icon('plus')}</div><div class="meta"><div class="t">Nouvelle playlist</div><div class="a">Créer une liste de lecture</div></div></div>` +
        (!ws.length || matches('titres likes favoris', ws) ? plain('#/liked', c.likedCover('sm'), 'Titres likés', `Playlist · ${plural(likedN, 'titre')}`) : '') +
        pls.map((p) => plain('#/playlist/' + p.id, c.playlistCover(p, 'sm'), p.name, `Playlist · ${plural(p.ids.length, 'titre')}`)).join('') +
        (S.playlists.length ? '' : hint('Créez votre première playlist, puis ajoutez des titres depuis le menu ⋯ de chaque titre.'));
    } else if (tab === 'favorites') {
      const arr = all.filter((t) => t.liked && pass(t));
      if (sort === 'az') arr.sort((a, b) => coll.compare(a.title, b.title));
      else if (sort === 'artist') arr.sort((a, b) => coll.compare(a.artist, b.artist) || coll.compare(a.title, b.title));
      else arr.sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
      count = plural(arr.length, 'titre');
      if (!arr.length) body.innerHTML = hint(all.some((t) => t.liked) ? 'Aucun favori ne correspond.' : 'Touchez le cœur d’un titre pour le retrouver ici.');
      else { body.innerHTML = `${c.listHead}<div class="tracklist" id="lib-list"></div>`; c.mountTrackList(body.querySelector('#lib-list'), arr); }
    } else if (tab === 'history') {
      const arr = [...new Set(S.history)].map((id) => S.tracks.get(id)).filter(Boolean);
      count = plural(arr.length, 'titre');
      if (!arr.length) body.innerHTML = hint('Votre historique d’écoute apparaîtra ici.');
      else { body.innerHTML = `${c.listHead}<div class="tracklist" id="lib-list"></div><div class="s-row" style="justify-content:flex-start;margin-top:16px"><button class="btn sec" data-act="clear-history">${icon('trash')}Effacer l’historique</button></div>`; c.mountTrackList(body.querySelector('#lib-list'), arr); }
    } else if (tab === 'folders') {
      let groups = folders(c, all);
      const anyFolder = groups.some(([k]) => k !== NOFOLDER);
      groups = groups.filter(([k, ts]) => !ws.length || matches(c.norm(folderName(k) + ' ' + folderParent(k)), ws));
      if (sort === 'count') groups.sort((a, b) => b[1].length - a[1].length || coll.compare(a[0], b[0]));
      else groups.sort((a, b) => (a[0] === NOFOLDER) - (b[0] === NOFOLDER) || coll.compare(folderName(a[0]), folderName(b[0])));
      count = plural(groups.length, 'dossier');
      body.innerHTML = (anyFolder || !all.length ? '' : `<div class="note-card glass">${icon('folder')}<div><b>Classement par dossiers</b><p class="muted">Vos titres ont été ajoutés un par un, donc NEXA ne connaît pas leur dossier. Touchez « Scanner un dossier » et choisissez votre dossier de musique : les titres déjà présents seront classés sans être dupliqués.</p></div></div><div class="s-row" style="justify-content:flex-start;margin:0 0 12px"><button class="btn" data-act="import-folder">${icon('folder')}Scanner un dossier</button></div>`) +
        (groups.length ? groups.map(([k, ts]) => plain('#/folder/' + encodeURIComponent(k === NOFOLDER ? '' : k), folderCover(c, 'sm'), folderName(k), `${folderParent(k) ? folderParent(k) + ' · ' : ''}${plural(ts.length, 'titre')}`)).join('') : (all.length ? hint('Aucun dossier ne correspond.') : c.emptyHTML()));
    } else {
      const fl = I().families(all);
      count = plural(fl.length, 'genre');
      body.innerHTML = fl.length ? fl.map((f) => `<div class="row plain" data-go="#/genre/${encodeURIComponent(f.name)}"><div class="cover sm mixcover" style="--g1:${f.g[0]};--g2:${f.g[1]}">${icon(f.icon)}</div><div class="meta"><div class="t">${esc(f.name)}</div><div class="a">${plural(f.n, 'titre')}${f.name === I().NONE ? ' · sans genre dans les fichiers' : ''}</div></div></div>`).join('') : c.emptyHTML();
    }
    const had = keepFocus && document.activeElement && document.activeElement.id === 'lib-q';
    const pos = had ? document.activeElement.selectionStart : 0;
    renderTools(count);
    if (had) { const inp = tools.querySelector('#lib-q'); if (inp) { inp.focus(); try { inp.setSelectionRange(pos, pos); } catch { /* ignore */ } } }
  }

  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]'); if (!b || b.dataset.tab === tab) return;
    tab = b.dataset.tab; LS.set('libTab2', tab); q = '';
    tabsEl.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b));
    renderBody(false);
    b.scrollIntoView({ block: 'nearest', inline: 'center' });
  });
  tools.addEventListener('click', (e) => { if (e.target.closest('[data-sortbtn]')) sortMenu(); });
  renderBody(false); c.showStorage();
  const on = tabsEl.querySelector('.chip.on'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' });
});

/* ===================== DOSSIER ===================== */
NEXA.defineView('folder', (c, arg) => {
  const key = arg || '';
  const ts = c.allTracks().filter((t) => (t.folder || '') === key).sort((a, b) => (a.no - b.no) || c.coll.compare(a.title, b.title));
  if (!ts.length) { location.hash = '#/library/folders'; return; }
  const p = key || NOFOLDER;
  c.collectionView({ kind: 'Dossier', name: folderName(p), sub: folderParent(p), cover: folderCover(c), tracks: ts, color: '#4d7cff' });
});

/* =====================================================================
   RECHERCHE
   ===================================================================== */
NEXA.defineView('search', (c) => {
  const { view, S, LS, esc, icon, plural } = c;
  const FILTERS = [['all', 'Tout'], ['tracks', 'Titres'], ['artists', 'Artistes'], ['albums', 'Albums'], ['playlists', 'Playlists'], ['genres', 'Genres'], ['folders', 'Dossiers']];
  let filter = 'all';
  view.innerHTML = `<div class="search-box"><label>${icon('search')}<input id="q" type="search" placeholder="Titre, artiste, album, genre, dossier…" value="${esc(S.q)}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"></label></div>
    <div class="tabs-row" id="s-filters">${FILTERS.map(([k, l]) => `<button class="chip${filter === k ? ' on' : ''}" data-sf="${k}">${l}</button>`).join('')}</div>
    <div id="search-out"></div>`;
  const out = view.querySelector('#search-out'), inp = view.querySelector('#q'), fl = view.querySelector('#s-filters');

  const recents = () => LS.get('recents', []);
  function saveRecent(q) {
    q = (q || '').trim(); if (q.length < 2) return;
    const list = [q, ...recents().filter((r) => c.norm(r) !== c.norm(q))].slice(0, 10);
    LS.set('recents', list);
  }
  const chip = (q, icn) => `<button class="chip" data-sq="${esc(q)}">${icn ? icon(icn) : ''}${esc(q)}</button>`;

  function suggestions(all) {
    const arts = [...c.groupBy(all, 'artist')].filter(([n]) => n !== c.UNKNOWN_ARTIST).sort((a, b) => b[1].length - a[1].length).slice(0, 6).map(([n]) => n);
    const gens = I().families(all).filter((f) => f.name !== I().NONE).slice(0, 5).map((f) => f.name);
    const albs = [...c.groupBy(all.filter((t) => t.album !== c.UNKNOWN_ALBUM), 'album')].sort((a, b) => b[1].length - a[1].length).slice(0, 4).map(([n]) => n);
    return { arts, gens, albs };
  }

  function render() {
    c.cleanupLists();
    const raw = inp.value, ws = words(c, raw), all = c.allTracks();
    if (!all.length) { out.innerHTML = '<p class="muted" style="padding:12px 4px">Ajoutez de la musique pour pouvoir la rechercher.</p>'; return; }
    if (!ws.length) {
      const rc = recents(), sg = suggestions(all);
      const fam = I().families(all).filter((f) => f.name !== I().NONE);
      const groups = [...c.groupBy(all, 'artist')].sort((a, b) => b[1].length - a[1].length).slice(0, 30);
      out.innerHTML =
        (rc.length ? `<div class="sec-row"><h2 class="sec">Recherches récentes</h2><button class="link" data-clear-recents>Effacer</button></div><div class="chips-wrap">${rc.map((r) => `<span class="chip rc">${`<button class="rc-t" data-sq="${esc(r)}">${icon('clock')}${esc(r)}</button><button class="rc-x" data-rm-recent="${esc(r)}" aria-label="Retirer">${icon('x')}</button>`}</span>`).join('')}</div>` : '') +
        `<h2 class="sec"${rc.length ? '' : ' style="margin-top:6px"'}>Suggestions</h2><div class="chips-wrap">${sg.arts.map((n) => chip(n, 'user')).join('')}${sg.gens.map((n) => chip(n, 'disc')).join('')}${sg.albs.map((n) => chip(n, 'note')).join('')}</div>` +
        (fam.length ? `<h2 class="sec">Parcourir les genres</h2><div class="tiles">${fam.map((f) => `<div class="tile gtile" style="--g1:${f.g[0]};--g2:${f.g[1]}" data-go="#/genre/${encodeURIComponent(f.name)}">${esc(f.name)}<small>${plural(f.n, 'titre')}</small></div>`).join('')}</div>` : '') +
        `<h2 class="sec">Parcourir vos artistes</h2><div class="tiles">${groups.map(([n, ts]) => { const f = c.firstWithCover(ts); return `<div class="tile" style="--c:${c.colorOf(f)}" data-go="#/artist/${encodeURIComponent(n)}">${esc(n)}<small>${plural(ts.length, 'titre')}</small>${f.coverUrl ? c.coverHTML(f) : ''}</div>`; }).join('')}</div>`;
      return;
    }
    const want = (k) => filter === 'all' || filter === k;
    const starts = (s) => c.norm(s).startsWith(ws[0]);
    // Titres
    const res = want('tracks') ? all.filter((t) => matches(hay(c, t), ws)).sort((a, b) => (starts(b.title) - starts(a.title)) || c.coll.compare(a.title, b.title)) : [];
    // Artistes / albums / dossiers / playlists / genres : on cherche dans tous les titres, pas seulement les résultats
    const arts = want('artists') ? [...c.groupBy(all, 'artist')].filter(([n]) => matches(c.norm(n), ws)).sort((a, b) => (starts(b[0]) - starts(a[0])) || b[1].length - a[1].length).slice(0, 12) : [];
    const albs = want('albums') ? [...c.groupBy(all.filter((t) => t.album !== c.UNKNOWN_ALBUM), 'album')].filter(([n, ts]) => matches(c.norm(n + ' ' + ts[0].artist), ws)).slice(0, 12) : [];
    const pls = want('playlists') ? S.playlists.filter((p) => matches(c.norm(p.name), ws)) : [];
    const fams = want('genres') ? I().families(all).filter((f) => matches(c.norm(f.name), ws)).slice(0, 8) : [];
    const fols = want('folders') ? folders(c, all).filter(([k]) => k !== NOFOLDER && matches(c.norm(folderName(k) + ' ' + folderParent(k)), ws)).slice(0, 10) : [];
    let html = '';
    if (fams.length) html += `<h2 class="sec" style="margin-top:6px">Genres</h2><div class="tabs-row">${fams.map((f) => `<button class="chip" data-go="#/genre/${encodeURIComponent(f.name)}">${icon(f.icon)}${esc(f.name)}</button>`).join('')}</div>`;
    if (arts.length) html += `<h2 class="sec">Artistes</h2><div class="shelf">${arts.map(([n, ts]) => `<div class="card artist" data-go="#/artist/${encodeURIComponent(n)}">${c.coverHTML(c.firstWithCover(ts), 'round')}<div class="t">${esc(n)}</div><div class="a">${plural(ts.length, 'titre')}</div></div>`).join('')}</div>`;
    if (albs.length) html += `<h2 class="sec">Albums</h2><div class="shelf">${albs.map(([n, ts]) => `<div class="card" data-go="#/album/${encodeURIComponent(n)}">${c.coverHTML(c.firstWithCover(ts))}<div class="t">${esc(n)}</div><div class="a">${esc(ts[0].artist)}</div></div>`).join('')}</div>`;
    if (pls.length) html += `<h2 class="sec">Playlists</h2>${pls.map((p) => `<div class="row plain" data-go="#/playlist/${p.id}">${c.playlistCover(p, 'sm')}<div class="meta"><div class="t">${esc(p.name)}</div><div class="a">Playlist · ${plural(p.ids.length, 'titre')}</div></div></div>`).join('')}`;
    if (fols.length) html += `<h2 class="sec">Dossiers</h2>${fols.map(([k, ts]) => `<div class="row plain" data-go="#/folder/${encodeURIComponent(k)}">${folderCover(c, 'sm')}<div class="meta"><div class="t">${esc(folderName(k))}</div><div class="a">${esc(folderParent(k))}${folderParent(k) ? ' · ' : ''}${plural(ts.length, 'titre')}</div></div></div>`).join('')}`;
    if (res.length) html += `<h2 class="sec">Titres · ${res.length}</h2><div class="tracklist" id="res-list"></div>`;
    if (!html) html = `<p class="muted" style="padding:24px 4px">Aucun résultat pour « ${esc(raw.trim())} ».</p>`;
    out.innerHTML = html;
    if (res.length) c.mountTrackList(out.querySelector('#res-list'), res);
  }

  inp.addEventListener('input', c.debounce(() => { S.q = inp.value; render(); }, 60));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { saveRecent(inp.value); inp.blur(); } });
  fl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sf]'); if (!b) return;
    filter = b.dataset.sf; fl.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b)); render();
  });
  out.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm-recent]');
    if (rm) { LS.set('recents', recents().filter((r) => r !== rm.dataset.rmRecent)); render(); return; }
    if (e.target.closest('[data-clear-recents]')) { LS.set('recents', []); render(); return; }
    const sq = e.target.closest('[data-sq]');
    if (sq) { inp.value = sq.dataset.sq; S.q = inp.value; saveRecent(inp.value); render(); return; }
    // toucher un résultat mémorise la recherche
    if (e.target.closest('.row, .card, .chip')) saveRecent(inp.value);
  }, true);
  render();
});

if (typeof module !== 'undefined') module.exports = NEXA;
})(typeof window !== 'undefined' ? window : globalThis);
