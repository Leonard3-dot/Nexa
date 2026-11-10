/* NEXA — pochettes manquantes : recherche en ligne FACULTATIVE.
   - Désactivée par défaut : l'application reste 100 % hors ligne tant que vous ne l'activez pas.
   - Source : iTunes Search API (Apple, gratuite, sans clé). Seuls « artiste + album/titre » sont envoyés.
   - Ne touche jamais un titre qui a déjà une pochette. L'image trouvée est enregistrée dans l'application (hors ligne ensuite). */
(function (g) {
'use strict';
const NEXA = g.NEXA = g.NEXA || {};
const GAP = 3200;   // l'API tolère ~20 requêtes/minute : on reste en dessous

NEXA.defineModule((c) => {
  const { S, LS, norm } = c;
  const enabled = () => !!LS.get('onlineCovers', false);
  const missing = () => [...S.tracks.values()].filter((t) => !t.coverUrl);
  const known = (v) => v && v !== c.UNKNOWN_ARTIST && v !== c.UNKNOWN_ALBUM;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let busy = false, stop = false;

  /* Cherche une pochette pour {artist, album, title}. Retourne un Blob ou null. */
  async function find({ artist, album, title }) {
    const album_ = known(album), q = [known(artist) ? artist : '', album_ ? album : title].join(' ').trim();
    if (!q) return null;
    const url = 'https://itunes.apple.com/search?media=music&limit=8&entity=' + (album_ ? 'album' : 'song') + '&term=' + encodeURIComponent(q);
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const list = (await res.json()).results || [];
    const a = norm(known(artist) ? artist : '');
    // on exige que l'artiste corresponde (évite une mauvaise pochette) ; sans artiste connu, on exige le titre
    const hit = list.find((r) => r.artworkUrl100 && (a ? norm(r.artistName || '').includes(a) || a.includes(norm(r.artistName || '')) :
      norm(r.trackName || r.collectionName || '') === norm(album_ ? album : title)));
    if (!hit) return null;
    const img = await fetch(hit.artworkUrl100.replace(/\d+x\d+bb/, '600x600bb'));
    if (!img.ok) return null;
    const blob = await img.blob();
    return blob.type.startsWith('image/') ? blob : null;
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

  function openSheet() {
    const n = missing().length;
    c.openSheet(`<div class="sheet-title">Pochettes en ligne</div>
      <p class="s-msg">Quand un titre n’a pas de pochette, NEXA peut la chercher sur internet (iTunes) et la garder ensuite hors ligne.
      Seuls l’artiste et l’album sont envoyés. Désactivé par défaut.</p>
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
