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
if (!P) return;

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
      }).catch((e) => console.error(e));
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
      <div class="s-row"><button class="btn sec" data-scan ${s.audio === 'granted' ? '' : 'disabled'}>Importer depuis le téléphone</button></div>
      <div class="s-row"><button class="btn" data-done>Terminé</button></div>`, (sh) => {
      sh.querySelectorAll('[data-ask]').forEach((b) => { b.onclick = async () => {
        const kind = b.dataset.ask, cur = (last || {})[kind];
        if (cur === 'denied') { await P.openAppSettings(); c.toast('Activez l’autorisation puis revenez dans NEXA'); return; }
        await request(kind); openPerms();
      }; });
      const bat = sh.querySelector('[data-bat]'); if (bat) bat.onclick = () => P.openBatterySettings();
      const sc = sh.querySelector('[data-scan]'); if (sc) sc.onclick = () => { c.closeSheet(); scan(); };
      sh.querySelector('[data-done]').onclick = c.closeSheet;
    });
  }
  // au retour dans l'app (après les réglages Android), on rafraîchit l'état
  document.addEventListener('visibilitychange', () => { if (!document.hidden) status(); });

  /* ---- Import depuis la mémoire du téléphone (MediaStore) ---- */
  async function scan() {
    let r;
    try { r = await P.scanAudio(); } catch (e) { c.toast(e && e.message === 'permission' ? 'Autorisation « Fichiers audio » requise' : 'Analyse impossible'); return; }
    const files = r.files || [];
    if (!files.length) { c.toast('Aucune musique trouvée sur le téléphone'); return; }
    const known = new Set([...c.S.tracks.values()].map((t) => t.sig));
    const fresh = files.filter((f) => !known.has(f.name + '|' + f.size));
    if (!fresh.length) { c.toast('Tout est déjà importé'); return; }
    c.confirmSheet(`${fresh.length} nouveau(x) titre(s) trouvé(s) sur le téléphone. Les importer dans NEXA ?`, 'Importer', async () => {
      let ok = 0, ko = 0;
      for (let i = 0; i < fresh.length; i += 20) {            // par lots : mémoire maîtrisée
        const batch = [];
        for (const f of fresh.slice(i, i + 20)) {
          try {
            const res = await fetch(cap.convertFileSrc('file://' + f.path));
            if (!res.ok) throw new Error(res.status);
            const folder = f.path.split('/').slice(-2, -1)[0] || '';
            const file = new File([await res.blob()], f.name, { type: f.mime || '' });
            try { Object.defineProperty(file, 'webkitRelativePath', { value: folder + '/' + f.name }); } catch { /* ignoré */ }
            batch.push(file);
          } catch { ko++; }
        }
        if (batch.length) { await c.importFiles(batch); ok += batch.length; }
      }
      c.toast(ko ? `${ok} importés, ${ko} illisibles` : `${ok} titres importés`);
    });
  }

  NEXA.actions.perms = openPerms;
  status();
});
})(typeof window !== 'undefined' ? window : globalThis);
