/* NEXA — pochettes manquantes : recherche en ligne FACULTATIVE.
   - Activée par défaut (demande de l'utilisateur), désactivable dans Profil → Pochettes en ligne. Sans connexion, rien n'est envoyé et l'application fonctionne normalement.
   - Sources : iTunes Search (Apple), puis MusicBrainz / Cover Art Archive en repli. Gratuit, sans clé. Seuls « artiste + album/titre » sont envoyés.
   - Ne touche jamais un titre qui a déjà une pochette. L'image trouvée est enregistrée dans l'application (hors ligne ensuite). */
(function (g) {
'use strict';
const NEXA = g.NEXA = g.NEXA || {};
const GAP = 3200;   // l'API tolère ~20 requêtes/minute : on reste en dessous

NEXA.defineModule((c) => {
  const { S, LS, norm } = c;
  const enabled = () => LS.get('onlineCovers', true) !== false;   // activé par défaut (demande de l'utilisateur) ; désactivable dans Profil
  const missing = () => [...S.tracks.values()].filter((t) => !t.coverUrl);
  const known = (v) => v && v !== c.UNKNOWN_ARTIST && v !== c.UNKNOWN_ALBUM;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let busy = false, stop = false;

  /* iTunes n'envoie pas toujours les en-têtes CORS : on l'interroge en JSONP (balise <script>), qui marche partout. */
  const jsonp = (url) => new Promise((res, rej) => {
    const cb = '_nx' + Math.random().toString(36).slice(2), s = document.createElement('script');
    const end = (fn, v) => { clearTimeout(tm); delete g[cb]; s.remove(); fn(v); };
    const tm = setTimeout(() => end(rej, new Error('timeout')), 10000);
    g[cb] = (d) => end(res, d);
    s.onerror = () => end(rej, new Error('réseau'));
    s.src = url + '&callback=' + cb;
    document.head.appendChild(s);
  });
  /* Image → Blob : fetch d'abord ; sinon <img crossorigin> + canvas (si le serveur l'autorise). */
  /* Dans l'APK, CapacitorHttp fait la requête côté Android : aucune restriction CORS. */
  async function nativeBlob(url) {
    const H = g.Capacitor && g.Capacitor.Plugins && g.Capacitor.Plugins.CapacitorHttp;
    if (!H) return null;
    try {
      const r = await H.request({ url, method: 'GET', responseType: 'blob', connectTimeout: 10000, readTimeout: 15000 });
      if (r.status !== 200 || typeof r.data !== 'string') return null;
      const bin = atob(r.data), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const ct = (r.headers && (r.headers['Content-Type'] || r.headers['content-type'])) || 'image/jpeg';
      return new Blob([u8], { type: ct.startsWith('image/') ? ct : 'image/jpeg' });
    } catch { return null; }
  }
  async function imageBlob(url) {
    const nb = await nativeBlob(url); if (nb) return nb;
    try { const r = await fetch(url); if (r.ok) { const b = await r.blob(); if (b.type.startsWith('image/')) return b; } } catch { /* repli ci-dessous */ }
    return new Promise((res) => {
      const i = new Image(); i.crossOrigin = 'anonymous';
      i.onload = () => { try { const cv = document.createElement('canvas'); cv.width = i.naturalWidth; cv.height = i.naturalHeight; cv.getContext('2d').drawImage(i, 0, 0); cv.toBlob((b) => res(b), 'image/jpeg', .9); } catch { res(null); } };
      i.onerror = () => res(null);
      i.src = url;
    });
  }
  const sameArtist = (a, b) => { a = norm(a || ''); b = norm(b || ''); return !!a && !!b && (a.includes(b) || b.includes(a)); };

  async function fromItunes({ artist, album, title }, album_, a) {
    const q = [a ? artist : '', album_ ? album : title].join(' ').trim();
    const d = await jsonp('https://itunes.apple.com/search?media=music&limit=8&entity=' + (album_ ? 'album' : 'song') + '&term=' + encodeURIComponent(q));
    const hit = (d.results || []).find((r) => r.artworkUrl100 && (a ? sameArtist(r.artistName, artist) : norm(r.trackName || r.collectionName || '') === norm(album_ ? album : title)));
    return hit ? imageBlob(hit.artworkUrl100.replace(/\d+x\d+bb/, '600x600bb')) : null;
  }
  /* Repli : MusicBrainz + Cover Art Archive (bases ouvertes, CORS autorisé) */
  async function fromMusicBrainz({ artist, album }, album_, a) {
    if (!album_) return null;
    const q = `release:"${album.replace(/"/g, '')}"` + (a ? ` AND artist:"${artist.replace(/"/g, '')}"` : '');
    const r = await fetch('https://musicbrainz.org/ws/2/release/?fmt=json&limit=5&query=' + encodeURIComponent(q));
    if (!r.ok) return null;
    const hit = ((await r.json()).releases || []).find((x) => x.score >= 90 && (!a || (x['artist-credit'] || []).some((ac) => sameArtist(ac.name, artist))));
    return hit ? imageBlob('https://coverartarchive.org/release/' + hit.id + '/front-500') : null;
  }

  /* Cherche une pochette pour {artist, album, title}. Retourne un Blob ou null. */
  async function find(t) {
    const album_ = known(t.album), a = known(t.artist);
    if (!a && !album_ && !t.title) return null;
    let blob = null, err = null;
    try { blob = await fromItunes(t, album_, a); } catch (e) { err = e; }
    if (!blob) { try { blob = await fromMusicBrainz(t, album_, a); } catch (e) { err = err || e; } }
    if (!blob && err) throw err;      // les deux sources ont échoué (réseau) ≠ « pas de pochette trouvée »
    return blob;
  }

  /* Un « groupe » = même artiste + même album : une seule requête pour tout l'album. */
  function groups(list) {
    const m = new Map();
    for (const t of list) {
      const k = known(t.album) ? norm(t.artist) + '|' + norm(t.album) : 'solo|' + t.id;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t);
    }
    return [...m.values()];
  }

  async function run(list, onProgress) {
    if (busy) return { found: 0, tried: 0 };
    busy = true; stop = false;
    const gs = groups(list.filter((t) => !t.coverUrl && !t.coverTried));
    let found = 0, tried = 0, errs = 0;
    for (const grp of gs) {
      if (stop || !navigator.onLine) break;
      onProgress && onProgress(tried, gs.length, found);
      const t0 = grp[0];
      try {
        const blob = await find(t0);
        if (blob) { await c.setTrackCover(grp.map((t) => t.id), blob, true); found += grp.length; }
        else for (const t of grp) { t.coverTried = Date.now(); c.DB.putTrack(t).catch(() => {}); }
        errs = 0;
      } catch (e) { if (++errs >= 3) break; }          // réseau coupé / limite atteinte : on s'arrête proprement
      tried++;
      await sleep(GAP);
    }
    busy = false;
    onProgress && onProgress(tried, gs.length, found, true);
    return { found, tried, total: gs.length, aborted: stop };
  }

  /* Recherche automatique quand on lance un titre sans pochette (si l'option est activée) */
  c.hooks.onTrack.push((t) => {
    if (!enabled() || busy || t.coverUrl || t.coverTried || !navigator.onLine) return;
    run([t]).then((r) => { if (r.found) c.toast('Pochette trouvée'); });
  });

  /* Recherche automatique en arrière-plan : après un import, au démarrage et au retour de la connexion */
  let autoTimer = 0;
  const auto = () => {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      if (!enabled() || busy || !navigator.onLine || !missing().some((t) => !t.coverTried)) return;
      run(missing()).then((r) => { if (r.found) { c.toast(`${r.found} pochette(s) trouvée(s) en ligne`); } });
    }, 2500);
  };
  c.hooks.onImport.push(auto);
  g.addEventListener('online', auto);
  auto();

  function openSheet() {
    const n = missing().length;
    c.openSheet(`<div class="sheet-title">Pochettes en ligne</div>
      <p class="s-msg">Quand un titre n’a pas de pochette, NEXA peut la chercher sur internet (iTunes) et la garder ensuite hors ligne.
      Seuls l’artiste et l’album sont envoyés. Activé par défaut ; vous pouvez le couper ici.</p>
      <label class="eq-top"><span>Chercher les pochettes manquantes</span><input type="checkbox" class="switch" id="cv-on"${enabled() ? ' checked' : ''}></label>
      <p class="s-msg" id="cv-info">${n ? `${n} titre(s) sans pochette.` : 'Tous vos titres ont une pochette.'}</p>
      <div class="s-row"><button class="btn sec" id="cv-go" ${n ? '' : 'disabled'}>Chercher maintenant</button></div>
      <div class="s-row"><button class="btn" data-done>Terminé</button></div>`, (s) => {
      s.querySelector('#cv-on').onchange = (e) => LS.set('onlineCovers', e.target.checked);
      const go = s.querySelector('#cv-go'), info = s.querySelector('#cv-info');
      go.onclick = async () => {
        if (busy) { stop = true; go.textContent = 'Arrêt…'; return; }
        if (!navigator.onLine) { info.textContent = 'Aucune connexion internet.'; return; }
        go.textContent = 'Arrêter';
        const r = await run(missing(), (i, tot, f, end) => { if (!end) info.textContent = `Recherche… ${i} / ${tot} albums · ${f} pochette(s) trouvée(s)`; });
        go.textContent = 'Chercher maintenant';
        info.textContent = `${r.found} titre(s) ont reçu une pochette` + (r.aborted ? ' (arrêté)' : r.tried < r.total ? ' (interrompu : connexion ou limite)' : '') + '.';
      };
      s.querySelector('[data-done]').onclick = () => { stop = true; c.closeSheet(); };
    });
  }
  NEXA.actions.covers = openSheet;
  NEXA.covers = { find, run, missing };
});
})(typeof window !== 'undefined' ? window : globalThis);
