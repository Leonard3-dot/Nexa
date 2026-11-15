/* NEXA — pont avec Android (application APK Capacitor).
   Dans un navigateur ce fichier ne fait rien : NEXA.native.available vaut false et rien n'est affiché.
   Dans l'APK il :
     1. envoie le titre / la pochette / l'état de lecture au service Android (notification + écran verrouillé),
     2. reçoit les commandes (lecture, pause, suivant, précédent, aller à…) et les interruptions audio
        (appel téléphonique, autre lecteur, casque débranché, notification sonore) et les applique au lecteur,
     3. gère les autorisations (fichiers audio, notifications, batterie) et l'import depuis la mémoire du téléphone. */
(function (g) {
'use strict';
const NEXA = g.NEXA = g.NEXA || {};
const cap = g.Capacitor;
const available = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
let P = null;
if (available) { try { P = cap.registerPlugin('NexaMedia'); } catch (e) { console.error(e); } }
NEXA.native = { available: !!P, status: async () => null, request: async () => null };
NEXA.actions = NEXA.actions || {};
if (!P) {   // site web / PWA : on le dit clairement au lieu de ne rien faire
  NEXA.defineModule((c) => { NEXA.actions.scanphone = () => {
    c.openSheet(`<div class="sheet-title">Scanner le téléphone</div>
      <p class="s-msg">Vous êtes sur le <b>site web</b>, pas dans l'application Android. Un site n'a pas le droit de parcourir tout le téléphone, ni d'afficher une notification de lecture.<br><br>
      Installez l'<b>APK NEXA</b> (GitHub → Actions → dernière exécution → Artifacts) : le bouton « Scanner tout le téléphone » y importe toute votre musique en un geste.<br><br>
      En attendant, « Scanner un dossier » importe un dossier entier d'un coup.</p>
      <div class="s-row"><button class="btn" data-act="import-folder">Scanner un dossier</button></div>
      <div class="s-row"><button class="btn sec" data-done>Fermer</button></div>`, (sh) => { sh.querySelector('[data-done]').onclick = c.closeSheet; });
  }; });
  return;
}

const LABEL = { granted: 'Autorisé', denied: 'Refusé', prompt: 'Non demandé', 'prompt-with-rationale': 'Non demandé' };
let last = null;
const status = async () => { try { last = await P.getStatus(); } catch (e) { console.error(e); } return last; };
const request = async (kind) => { try { last = await P.request({ kind }); } catch (e) { console.error(e); } return last; };
NEXA.native = { available: true, status, request, get last() { return last; } };

NEXA.defineModule((c) => {
  const audio = c.audio;
  let timer = 0, artKey = '', artData = '';

  /* ---- pochette réduite (JPEG 256 px) pour la notification ---- */
  async function artwork(t) {
    if (!t || !t.coverUrl) return '';
    if (artKey === t.id) return artData;
    try {
      const bmp = await createImageBitmap(await (await fetch(t.coverUrl)).blob());
      const s = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      artKey = t.id; artData = cv.toDataURL('image/jpeg', .82);
    } catch { artKey = t.id; artData = ''; }
    return artData;
  }

  /* ---- état → Android (regroupé pour ne pas inonder le pont) ---- */
  function push() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const t = c.S.tracks.get(c.S.cur);
      if (!t) { P.stopService().catch(() => {}); return; }
      const playing = !audio.paused && !!audio.src;
      P.updateState({
        title: t.title, artist: t.artist, album: t.album === c.UNKNOWN_ALBUM ? '' : t.album,
        playing, position: audio.currentTime || 0, duration: c.getDur() || 0, artwork: await artwork(t)
      }).catch((e) => { console.error(e); if (!push.warned) { push.warned = 1; c.toast('Notification de lecture indisponible : ' + ((e && e.message) || 'erreur')); } });
    }, 80);
  }
  ['play', 'pause', 'seeked', 'loadedmetadata', 'ratechange'].forEach((ev) => audio.addEventListener(ev, push));
  c.hooks.onTrack.push(push);

  /* ---- commandes et interruptions : Android → lecteur ---- */
  P.addListener('mediaAction', (e) => {
    switch (e.action) {
      case 'play': audio.play().catch(() => {}); break;
      case 'pause': audio.pause(); break;
      case 'next': c.next(); break;
      case 'previous': c.prev(); break;
      case 'seekTo': audio.currentTime = e.value; break;
      case 'duck':       // une notification sonore parle par-dessus : volume réduit, puis rétabli
        if (e.value) c.gains.duck = 0.3; else delete c.gains.duck;
        c.applyVolume(); break;
    }
  });

  /* ---- Autorisations ---- */
  const chip = (s) => `<span class="perm-chip ${s === 'granted' ? 'ok' : 'no'}">${LABEL[s] || s}</span>`;
  function row(icon, title, desc, state, btn) {
    return `<div class="perm-row">${c.icon(icon)}<div class="perm-tx"><b>${title}</b><small>${desc}</small></div>
      <div class="perm-act">${chip(state)}${btn || ''}</div></div>`;
  }
  async function openPerms() {
    const s = await status() || {};
    const audioBtn = s.audio === 'granted' ? '' : `<button class="btn mini" data-ask="audio">${s.audio === 'denied' ? 'Réglages' : 'Autoriser'}</button>`;
    const notifBtn = s.notifications === 'granted' ? '' : `<button class="btn mini" data-ask="notifications">${s.notifications === 'denied' ? 'Réglages' : 'Autoriser'}</button>`;
    c.openSheet(`<div class="sheet-title">Autorisations</div>
      <p class="s-msg">Pour que la musique continue écran éteint et que les commandes apparaissent sur l’écran verrouillé.</p>
      <div class="perm-list">
        ${row('bell', 'Notifications', 'Lecteur persistant avec précédent / pause / suivant', s.notifications, notifBtn)}
        ${row('battery', 'Batterie', s.batteryUnrestricted ? 'NEXA n’est pas limitée en arrière-plan' : 'Recommandé : retirer la limite pour éviter les coupures', s.batteryUnrestricted ? 'granted' : 'prompt',
              s.batteryUnrestricted ? '' : '<button class="btn mini" data-bat>Réglages</button>')}
        ${row('folder', 'Fichiers audio', 'Nécessaire seulement pour « Importer depuis le téléphone »', s.audio, audioBtn)}
      </div>
      <div class="s-row"><button class="btn sec" data-scan>Scanner tout le téléphone</button></div>
      <div class="s-row"><button class="btn sec" data-test>Tester la carte multimédia</button></div>
      <div class="s-row"><button class="btn" data-done>Terminé</button></div>`, (sh) => {
      sh.querySelectorAll('[data-ask]').forEach((b) => { b.onclick = async () => {
        const kind = b.dataset.ask, cur = (last || {})[kind];
        if (cur === 'denied') { await P.openAppSettings(); c.toast('Activez l’autorisation puis revenez dans NEXA'); return; }
        await request(kind); openPerms();
      }; });
      const bat = sh.querySelector('[data-bat]'); if (bat) bat.onclick = () => P.openBatterySettings();
      sh.querySelector('[data-test]').onclick = async () => {
        try {
          await P.updateState({ title: 'Test NEXA', artist: 'Carte multimédia', album: '', playing: true, position: 0, duration: 60, artwork: '' });
          c.toast('Baissez le panneau rapide : la carte NEXA doit apparaître');
          setTimeout(() => push(), 8000);
        } catch (e) { c.toast('Échec : ' + ((e && e.message) || 'plugin indisponible')); }
      };
      const sc = sh.querySelector('[data-scan]'); if (sc) sc.onclick = () => { c.closeSheet(); scan(); };
      sh.querySelector('[data-done]').onclick = c.closeSheet;
    });
  }
  // au retour dans l'app (après les réglages Android), on rafraîchit l'état
  document.addEventListener('visibilitychange', () => { if (!document.hidden) status(); });

  /* ---- Import de TOUT le téléphone en un geste (MediaStore) ---- */
  let scanning = false;
  async function scan() {
    if (scanning) { c.toast('Analyse déjà en cours…'); return; }
    scanning = true;
    try {
      let s = await status() || {};
      if (s.audio !== 'granted') {
        s = await request('audio') || {};
        if (s.audio !== 'granted') {
          c.toast('Autorisation « Fichiers audio » refusée : ouvrez les réglages de NEXA');
          if (s.audio === 'denied') P.openAppSettings().catch(() => {});
          return;
        }
      }
      c.toast('Recherche de la musique du téléphone…');
      let r;
      try { r = await P.scanAudio(); } catch (e) { c.toast('Analyse impossible : ' + ((e && e.message) || 'erreur')); return; }
      const files = r.files || [];
      if (!files.length) { c.toast('Aucune musique trouvée sur le téléphone'); return; }
      const known = new Set([...c.S.tracks.values()].map((t) => t.sig));
      const fresh = files.filter((f) => !known.has(f.name + '|' + f.size));
      if (!fresh.length) { c.toast(`Tout est déjà importé (${files.length} titres)`); return; }
      let ok = 0, ko = 0;
      const read = async (f) => {
        const urls = [];
        if (f.uri) urls.push(cap.convertFileSrc(f.uri));
        if (f.path) urls.push(cap.convertFileSrc('file://' + f.path));
        for (const u of urls) {
          try { const res = await fetch(u); if (res.ok) return await res.blob(); } catch { /* source suivante */ }
        }
        return null;
      };
      for (let i = 0; i < fresh.length; i += 12) {            // par lots : mémoire maîtrisée
        const batch = [];
        for (const f of fresh.slice(i, i + 12)) {
          const blob = await read(f);
          if (!blob || !blob.size) { ko++; continue; }
          const folder = (f.path || '').split('/').slice(-2, -1)[0] || '';
          const file = new File([blob], f.name, { type: f.mime || blob.type || '' });
          try { Object.defineProperty(file, 'webkitRelativePath', { value: folder + '/' + f.name }); } catch { /* ignoré */ }
          batch.push(file);
        }
        if (batch.length) { await c.importFiles(batch); ok += batch.length; }
        c.toast(`Import… ${Math.min(i + 12, fresh.length)} / ${fresh.length}`);
      }
      c.toast(ko ? `${ok} titres importés, ${ko} illisibles` : `${ok} titres importés depuis le téléphone`);
    } finally { scanning = false; }
  }

  /* Première ouverture : on demande tout de suite les autorisations utiles (sinon rien ne réagit) */
  async function firstRun() {
    if (c.LS.get('permAsked', false)) return;
    const s = await status() || {};
    if (s.audio === 'granted' && s.notifications === 'granted') { c.LS.set('permAsked', true); return; }
    c.LS.set('permAsked', true);
    openPerms();
  }
  setTimeout(firstRun, 1500);

  NEXA.actions.perms = openPerms;
  NEXA.actions.scanphone = scan;
  status();
});
})(typeof window !== 'undefined' ? window : globalThis);
