/* NEXA Music — noyau : base locale, import, lecteur, bibliothèque, routeur.
   Tout est stocké sur l'appareil (IndexedDB) : aucun serveur, aucune connexion requise.
   Modules : meta.js (métadonnées), intel.js (recommandations), eq.js (égaliseur), pages.js (pages). */
(() => {
'use strict';

/* =====================================================================
   Utilitaires
   ===================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const fmtTotal = (s) => { const m = Math.round(s / 60); if (m < 1) return 'moins d’1 min'; return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
const icon = (n, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const coll = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
const uniq = (a) => [...new Set(a)];
const shuffled = (a) => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const LS = {
  get(k, d) { try { const v = localStorage.getItem('hlm:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hlm:' + k, JSON.stringify(v)); } catch { /* quota */ } }
};
const NEXA = window.NEXA;
const UNKNOWN_ARTIST = NEXA.UNKNOWN_ARTIST;
const UNKNOWN_ALBUM = NEXA.UNKNOWN_ALBUM;
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', weba: 'audio/webm', webm: 'audio/webm', wma: 'audio/x-ms-wma' };
const extOf = (n) => (n.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';

/* =====================================================================
   Base de données locale (IndexedDB)
   tracks    : métadonnées légères (titre, artiste, pochette…)
   files     : fichiers audio (Blob) — séparés pour garder la liste rapide
   playlists : listes de lecture
   ===================================================================== */
const DB = (() => {
  let db;
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open('hors-ligne-music', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('tracks', { keyPath: 'id' });
      d.createObjectStore('files');
      d.createObjectStore('playlists', { keyPath: 'id' });
    };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
  const all = (store) => new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const get = (store, key) => new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const put = (store, val, key) => new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).put(val, key);
    t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error);
  });
  const del = (store, key) => new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).delete(key);
    t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error);
  });
  const ser = (t) => { const { coverUrl, ...rest } = t; return rest; };
  const saveTrack = (t, blob) => new Promise((res, rej) => {
    const tx = db.transaction(['tracks', 'files'], 'readwrite');
    tx.objectStore('tracks').put(ser(t));
    tx.objectStore('files').put(blob, t.id);
    tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error);
  });
  const putTrack = (t) => put('tracks', ser(t));
  const removeTracks = (ids) => new Promise((res, rej) => {
    const tx = db.transaction(['tracks', 'files'], 'readwrite');
    ids.forEach((id) => { tx.objectStore('tracks').delete(id); tx.objectStore('files').delete(id); });
    tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error);
  });
  return { open, all, get, put, del, saveTrack, putTrack, removeTracks };
})();

/* =====================================================================
   État
   ===================================================================== */
const S = {
  tracks: new Map(),
  playlists: [],
  history: [],
  cur: null,
  base: [], queue: [], qi: -1,
  shuffle: false, repeat: 0,       // repeat : 0 = non, 1 = tout, 2 = un titre
  libTab: 'playlists', sort: 'recent',
  q: '', route: '', ios: []
};

const main = $('#main'), view = $('#view');
const audio = $('#audio');
const playerEl = $('#player'), npEl = $('#np'), queuePanel = $('#queue-panel');
const sheetWrap = $('#sheet-wrap'), sheetEl = $('.sheet', sheetWrap);
const toastEl = $('#toast');
const fileInput = $('#file-input'), folderInput = $('#folder-input');

/* =====================================================================
   Couleurs et pochettes
   ===================================================================== */
const hashColor = (s) => { let h = 0; for (const c of (s || 'x')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 55% 36%)`; };
const colorOf = (t) => t.color || hashColor((t.album || '') + (t.artist || ''));
const coverInner = (t) => t.coverUrl ? `<img src="${t.coverUrl}" alt="" loading="lazy" decoding="async">` : icon('note');
const coverHTML = (t, cls = '') => `<div class="cover ${cls}" style="--c:${colorOf(t)}">${coverInner(t)}</div>`;
const likedCover = (cls = '') => `<div class="cover ${cls} liked">${icon('heart')}</div>`;
function playlistCover(p, cls = '') {
  const ts = p.ids.map((id) => S.tracks.get(id)).filter(Boolean);
  const withCov = ts.filter((t) => t.coverUrl);
  if (withCov.length >= 4) {
    return `<div class="cover mosaic ${cls}">${withCov.slice(0, 4).map((t) => `<div style="--c:${colorOf(t)}"><img src="${t.coverUrl}" alt="" loading="lazy" decoding="async"></div>`).join('')}</div>`;
  }
  if (withCov.length) return coverHTML(withCov[0], cls);
  return `<div class="cover ${cls}" style="--c:${hashColor(p.name)}">${icon('note')}</div>`;
}
const firstWithCover = (ts) => ts.find((t) => t.coverUrl) || ts[0];

/* =====================================================================
   Notifications
   ===================================================================== */
let toastT;
function toast(msg, ms = 2400) {
  toastEl.classList.remove('prog'); $('.msg', toastEl).textContent = msg; toastEl.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { toastEl.hidden = true; }, ms);
}
function progressToast(msg, done, total) {
  clearTimeout(toastT); toastEl.classList.add('prog'); toastEl.hidden = false;
  $('.msg', toastEl).textContent = msg;
  $('.bar i', toastEl).style.width = (total ? (done / total) * 100 : 0) + '%';
}

/* =====================================================================
   Feuilles (menus, boîtes de dialogue)
   ===================================================================== */
function openSheet(html, bind) { sheetEl.innerHTML = html; sheetWrap.hidden = false; sheetEl.scrollTop = 0; bind && bind(sheetEl); }
function closeSheet() { sheetWrap.hidden = true; sheetEl.innerHTML = ''; }
function menuSheet(head, items) {
  const html = (head || '') + items.map((it, i) =>
    `<button class="s-item ${it.danger ? 'danger' : ''}" data-i="${i}">${icon(it.icon)}<span>${esc(it.label)}</span>${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}</button>`).join('');
  openSheet(html, (s) => $$('.s-item', s).forEach((b) => { b.onclick = () => { const it = items[+b.dataset.i]; closeSheet(); it.action(); }; }));
}
function promptSheet({ title, value = '', placeholder = '', ok = 'Valider' }, cb) {
  openSheet(`<div class="sheet-title">${esc(title)}</div><input class="s-input" maxlength="80" placeholder="${esc(placeholder)}" value="${esc(value)}" enterkeyhint="done"><div class="s-row"><button class="btn sec" data-c>Annuler</button><button class="btn" data-ok>${esc(ok)}</button></div>`, (s) => {
    const inp = $('input', s);
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
    const done = () => { const v = inp.value.trim(); if (!v) return; closeSheet(); cb(v); };
    $('[data-ok]', s).onclick = done; $('[data-c]', s).onclick = closeSheet;
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(); };
  });
}
function confirmSheet(msg, okLabel, cb) {
  openSheet(`<div class="sheet-title">Confirmation</div><p class="s-msg">${esc(msg)}</p><div class="s-row"><button class="btn sec" data-c>Annuler</button><button class="btn dng" data-ok>${esc(okLabel)}</button></div>`, (s) => {
    $('[data-ok]', s).onclick = () => { closeSheet(); cb(); };
    $('[data-c]', s).onclick = closeSheet;
  });
}
const trackHead = (t) => `<div class="sheet-head">${coverHTML(t, 'md')}<div style="min-width:0"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist)}</div></div></div>`;

/* =====================================================================
   Lecture des métadonnées (ID3) et import
   ===================================================================== */
function decodeText(d) {
  if (!d.length) return '';
  const enc = d[0]; let b = d.subarray(1), label = 'windows-1252';
  if (enc === 1) {
    if (b[0] === 0xff && b[1] === 0xfe) { label = 'utf-16le'; b = b.subarray(2); }
    else if (b[0] === 0xfe && b[1] === 0xff) { label = 'utf-16be'; b = b.subarray(2); }
    else label = 'utf-16le';
  } else if (enc === 2) label = 'utf-16be';
  else if (enc === 3) label = 'utf-8';
  let s = '';
  try { s = new TextDecoder(label).decode(b); } catch { /* ignore */ }
  return s.split('\0')[0].trim();
}
const syncsafe = (b, p) => (b[p] << 21) | (b[p + 1] << 14) | (b[p + 2] << 7) | b[p + 3];
function parseAPIC(d, v22) {
  const enc = d[0]; let p = 1;
  if (v22) p = 4; else { while (p < d.length && d[p] !== 0) p++; p++; }
  p++; // type d'image
  if (enc === 0 || enc === 3) { while (p < d.length && d[p] !== 0) p++; p++; }
  else { while (p + 1 < d.length && !(d[p] === 0 && d[p + 1] === 0)) p += 2; p += 2; }
  const img = d.subarray(p);
  let type = '';
  if (img[0] === 0xff && img[1] === 0xd8) type = 'image/jpeg';
  else if (img[0] === 0x89 && img[1] === 0x50) type = 'image/png';
  else if (img[0] === 0x47 && img[1] === 0x49) type = 'image/gif';
  else if (img[0] === 0x52 && img[1] === 0x49) type = 'image/webp';
  return type ? new Blob([img], { type }) : null;
}
async function readID3(file) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (String.fromCharCode(head[0], head[1], head[2]) !== 'ID3') return {};
  const ver = head[3];
  const size = syncsafe(head, 6);
  const buf = new Uint8Array(await file.slice(10, 10 + Math.min(size, 8 * 1024 * 1024)).arrayBuffer());
  const dv = new DataView(buf.buffer);
  const out = {};
  let p = 0, coverBlob = null;
  if (head[5] & 0x40) p += ver === 4 ? syncsafe(buf, 0) : dv.getUint32(0) + 4;
  const idLen = ver === 2 ? 3 : 4, hLen = ver === 2 ? 6 : 10;
  while (p + hLen <= buf.length) {
    const id = String.fromCharCode(...buf.subarray(p, p + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const fs = ver === 2 ? (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5] : ver === 4 ? syncsafe(buf, p + 4) : dv.getUint32(p + 4);
    const start = p + hLen, end = start + fs;
    if (fs <= 0 || end > buf.length) break;
    const data = buf.subarray(start, end);
    if (id === 'TIT2' || id === 'TT2') out.title = decodeText(data);
    else if (id === 'TPE1' || id === 'TP1') out.artist = decodeText(data);
    else if (id === 'TALB' || id === 'TAL') out.album = decodeText(data);
    else if (id === 'TRCK' || id === 'TRK') out.no = parseInt(decodeText(data), 10) || 0;
    else if (id === 'TCON' || id === 'TCO') out.genre = NEXA.meta.cleanGenre(decodeText(data));
    else if (id === 'TDRC' || id === 'TYER' || id === 'TYE') out.year = out.year || NEXA.meta.cleanYear(decodeText(data));
    else if ((id === 'APIC' || id === 'PIC') && !coverBlob) { try { coverBlob = parseAPIC(data, ver === 2); } catch { /* ignore */ } }
    p = end;
  }
  if (coverBlob) out.coverBlob = coverBlob;
  return out;
}
async function makeThumb(blob) {
  let bmp;
  try { bmp = await createImageBitmap(blob); }
  catch {
    bmp = await new Promise((res, rej) => { const i = new Image(); const u = URL.createObjectURL(blob); i.onload = () => { res(i); URL.revokeObjectURL(u); }; i.onerror = rej; i.src = u; });
  }
  const sw = bmp.width, sh = bmp.height, s = Math.min(1, 320 / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const cover = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  const c2 = document.createElement('canvas'); c2.width = c2.height = 16;
  const x2 = c2.getContext('2d'); x2.drawImage(c, 0, 0, 16, 16);
  const px = x2.getImageData(0, 0, 16, 16).data;
  let r = 0, g = 0, b = 0, ws = 0;
  for (let i = 0; i < px.length; i += 4) {
    const wgt = Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) + 12;
    r += px[i] * wgt; g += px[i + 1] * wgt; b += px[i + 2] * wgt; ws += wgt;
  }
  const k = 0.58;
  const color = `rgb(${Math.round((r / ws) * k)},${Math.round((g / ws) * k)},${Math.round((b / ws) * k)})`;
  return { cover, color };
}
function probeDuration(file) {
  return new Promise((res) => {
    const a = new Audio(); a.preload = 'metadata';
    const u = URL.createObjectURL(file);
    let ended = false;
    const done = (d) => { if (ended) return; ended = true; URL.revokeObjectURL(u); a.removeAttribute('src'); res(isFinite(d) && d > 0 ? d : 0); };
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 6000);
    a.src = u;
  });
}
async function readMeta(file) {
  let out = {};
  const ext = extOf(file.name), M = NEXA.meta;
  try {
    if (ext === 'mp3' || file.type === 'audio/mpeg') { out = await readID3(file); if (!out.title) out = { ...(await M.parseID3v1(file)), ...out }; }
    else if (ext === 'm4a' || ext === 'mp4' || ext === 'aac' || file.type === 'audio/mp4') out = await M.parseMP4(file);
    else if (ext === 'flac' || file.type === 'audio/flac') out = await M.parseFLAC(file);
  } catch { out = {}; }
  if (out.coverBlob) { try { Object.assign(out, await makeThumb(out.coverBlob)); } catch { /* pochette illisible */ } }
  delete out.coverBlob;
  if (!out.artist && out.albumArtist) out.artist = out.albumArtist;
  out.genre = M.cleanGenre(out.genre);
  const base = file.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/^\d{1,3}[\s.\-)]+(?=\D)/, '').trim();
  if (!out.title) {
    const m = base.match(/^(.+?)\s+-\s+(.+)$/);
    if (m) { if (!out.artist) out.artist = m[1].trim(); out.title = m[2].trim(); } else out.title = base || file.name;
  }
  out.artist = out.artist || UNKNOWN_ARTIST;
  out.album = out.album || UNKNOWN_ALBUM;
  return out;
}
function hydrate(t) {
  if (t.cover instanceof Blob) t.coverUrl = URL.createObjectURL(t.cover);
  if (!Array.isArray(t.hours)) t.hours = new Array(24).fill(0);
  t.genre = t.genre || ''; t.year = t.year || 0; t.skips = t.skips || 0; t.lastPlayed = t.lastPlayed || 0;
  return t;
}
const classifyAll = () => NEXA.intel.classify([...S.tracks.values()]);
let importing = false;
async function importFiles(list) {
  if (importing) { toast('Import déjà en cours…'); return; }
  const files = [...list].filter((f) => f.type.startsWith('audio/') || MIME[extOf(f.name)]);
  if (!files.length) { toast('Aucun fichier audio trouvé'); return; }
  importing = true;
  const sigs = new Set([...S.tracks.values()].map((t) => t.sig));
  let added = 0, dup = 0, failed = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    progressToast(`Import ${i + 1} / ${files.length}…`, i, files.length);
    const sig = f.name + '|' + f.size;
    if (sigs.has(sig)) { dup++; continue; }
    try {
      const type = f.type || MIME[extOf(f.name)] || 'audio/mpeg';
      const blob = f.type ? f : f.slice(0, f.size, type);
      const [meta, duration] = await Promise.all([readMeta(f), probeDuration(blob)]);
      const t = {
        id: uid(), sig, title: meta.title, artist: meta.artist, album: meta.album, genre: meta.genre || '', year: meta.year || 0, no: meta.no || 0,
        duration, cover: meta.cover || null, color: meta.color || '', addedAt: Date.now() + i, liked: false, plays: 0, skips: 0, lastPlayed: 0, hours: new Array(24).fill(0), size: f.size
      };
      await DB.saveTrack(t, blob);
      S.tracks.set(t.id, hydrate(t)); sigs.add(sig); added++;
    } catch (e) {
      if (e && e.name === 'QuotaExceededError') { toast('Stockage de l’appareil plein'); failed++; break; }
      console.error(e); failed++;
    }
    if (i % 4 === 3) await new Promise((r) => setTimeout(r));
  }
  importing = false; classifyAll();
  progressToast('Terminé', 1, 1);
  let msg = added ? `${plural(added, 'titre ajouté')}` : 'Aucun nouveau titre';
  if (dup) msg += ` · ${plural(dup, 'doublon ignoré').replace('doublons ignoré', 'doublons ignorés')}`;
  if (failed) msg += ` · ${failed} échec${failed > 1 ? 's' : ''}`;
  toast(msg, 3500);
  renderSide(); refreshView();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

/* =====================================================================
   Lecteur
   ===================================================================== */
let loadToken = 0, curUrl = null, missingStreak = 0;
const seeks = $$('.seek'), curTs = $$('.time.cur'), durTs = $$('.time.dur'), miniBar = $('.mini-progress i');
let seeking = false, lastPos = 0;

function persistQueue() { LS.set('state', { queue: S.queue, base: S.base, qi: S.qi }); }
const saveState = debounce(persistQueue, 400);
function savePos() { if (S.cur) LS.set('pos', { id: S.cur, t: audio.currentTime || 0 }); }

function play(ids, startId) {
  if (!ids.length) return;
  S.base = ids.slice();
  if (S.shuffle) { S.queue = [startId, ...shuffled(ids.filter((x) => x !== startId))]; S.qi = 0; }
  else { S.queue = ids.slice(); S.qi = Math.max(0, S.queue.indexOf(startId)); }
  missingStreak = 0;
  loadCurrent(true);
}
async function loadCurrent(autoplay = true, startAt = 0) {
  const id = S.queue[S.qi];
  const t = S.tracks.get(id);
  if (!t) return;
  S.cur = id;
  const token = ++loadToken;
  renderPlayer();
  let blob = null;
  try { blob = await DB.get('files', id); } catch { /* ignore */ }
  if (token !== loadToken) return;
  if (!blob) {
    toast(`Fichier introuvable : ${t.title}`);
    if (autoplay && ++missingStreak < 6) next(true); else audio.pause();
    return;
  }
  missingStreak = 0;
  if (curUrl) URL.revokeObjectURL(curUrl);
  curUrl = URL.createObjectURL(blob);
  audio.src = curUrl;
  if (startAt > 1) audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = startAt; } catch { /* ignore */ } }, { once: true });
  updateProgress();
  if (autoplay) {
    try { await audio.play(); } catch { /* lecture bloquée : l'utilisateur devra appuyer sur lecture */ }
  }
  counted = false; markStart(t);
  saveState();
}
/* Historique : un titre entre dans l'historique dès qu'il démarre ; il compte comme « écoute »
   après 30 s (ou la moitié du titre) ; un passage rapide au suivant compte comme un saut. */
let counted = false;
function markStart(t) {
  S.history = [t.id, ...S.history.filter((x) => x !== t.id)].slice(0, 60);
  LS.set('history', S.history);
}
function maybeCount() {
  if (counted || !S.cur || audio.paused) return;
  const t = S.tracks.get(S.cur); if (!t) return;
  const d = getDur(), need = d ? Math.min(30, d * 0.5) : 30;
  if (audio.currentTime < need) return;
  counted = true;
  t.plays = (t.plays || 0) + 1; t.lastPlayed = Date.now();
  t.hours[new Date().getHours()]++;
  DB.putTrack(t).catch(() => {});
}
function countSkip() {
  const t = S.tracks.get(S.cur);
  if (t && !counted && audio.currentTime < 10 && !audio.paused) { t.skips = (t.skips || 0) + 1; DB.putTrack(t).catch(() => {}); }
}
function toggle() {
  if (!S.queue.length) { const ids = [...S.tracks.keys()]; if (ids.length) play(ids, S.shuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[0]); return; }
  if (!audio.src) { loadCurrent(true); return; }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}
function next(auto = false) {
  if (!S.queue.length) return;
  if (!auto) countSkip();
  if (auto && S.repeat === 2) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  if (S.qi < S.queue.length - 1) { S.qi++; loadCurrent(true); }
  else if (S.repeat === 1 || !auto) {
    if (S.shuffle) S.queue = shuffled(S.base);
    S.qi = 0; loadCurrent(true);
  } else { audio.pause(); audio.currentTime = 0; }
  renderQueue();
}
function prev() {
  if (!S.queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (S.qi > 0) S.qi--;
  else if (S.repeat === 1) S.qi = S.queue.length - 1;
  else { audio.currentTime = 0; return; }
  loadCurrent(true); renderQueue();
}
function setShuffle(on) {
  S.shuffle = on;
  if (S.queue.length && S.cur) {
    if (on) { S.queue = [S.cur, ...shuffled(S.base.filter((x) => x !== S.cur))]; S.qi = 0; }
    else { S.queue = S.base.slice(); S.qi = Math.max(0, S.queue.indexOf(S.cur)); }
  }
  LS.set('shuffle', on); updateModes(); saveState(); renderQueue();
}
function cycleRepeat() { S.repeat = (S.repeat + 1) % 3; LS.set('repeat', S.repeat); updateModes(); }
function updateModes() {
  $$('[data-act=shuffle]').forEach((b) => b.classList.toggle('active', S.shuffle));
  $$('[data-act=repeat]').forEach((b) => { b.classList.toggle('active', S.repeat > 0); $('use', b).setAttribute('href', S.repeat === 2 ? '#i-repeat1' : '#i-repeat'); });
}
function queueNext(ids) {
  if (!S.queue.length) { play(ids, ids[0]); return; }
  S.queue.splice(S.qi + 1, 0, ...ids);
  const bi = S.base.indexOf(S.cur); S.base.splice(bi + 1, 0, ...ids);
  saveState(); renderQueue(); toast(ids.length > 1 ? `${plural(ids.length, 'titre')} lu${ids.length > 1 ? 's' : ''} ensuite` : 'Lecture ensuite');
}
function queueAdd(ids) {
  if (!S.queue.length) { play(ids, ids[0]); return; }
  S.queue.push(...ids); S.base.push(...ids);
  saveState(); renderQueue(); toast('Ajouté à la file d’attente');
}
function stopPlayback() {
  audio.pause(); audio.removeAttribute('src'); audio.load();
  if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null; }
  S.cur = null; S.queue = []; S.base = []; S.qi = -1; loadToken++;
  renderPlayer(); closeNP(); persistQueue();
}
function dropFromQueue(ids) {
  const set = new Set(ids);
  const curGone = set.has(S.cur);
  const before = S.queue.slice(0, Math.max(0, S.qi)).filter((x) => !set.has(x)).length;
  S.queue = S.queue.filter((x) => !set.has(x)); S.base = S.base.filter((x) => !set.has(x));
  if (curGone) {
    if (!S.queue.length) { stopPlayback(); return; }
    S.qi = Math.min(before, S.queue.length - 1); loadCurrent(!audio.paused);
  } else S.qi = before;
  saveState(); renderQueue();
}

/* Affichage du lecteur */
const getDur = () => (audio.duration && isFinite(audio.duration) ? audio.duration : (S.tracks.get(S.cur)?.duration || 0));
function setCover(el, t) { el.style.setProperty('--c', colorOf(t)); el.innerHTML = coverInner(t); }
function renderPlayer() {
  const t = S.tracks.get(S.cur);
  playerEl.classList.toggle('empty', !t);
  if (!t) { document.title = 'NEXA Music'; updatePlayState(); return; }
  $('#pl-title').textContent = t.title; $('#pl-artist').textContent = t.artist;
  $('#np-title').textContent = t.title; $('#np-artist').textContent = t.artist;
  setCover($('#pl-cover'), t); setCover($('#np-cover'), t);
  const c = colorOf(t);
  playerEl.style.setProperty('--pc', c); npEl.style.setProperty('--pc', c);
  document.title = `${t.title} · ${t.artist}`;
  const bg = $('#np-bg'); if (bg) { if (t.coverUrl) { bg.src = t.coverUrl; bg.style.display = ''; } else { bg.removeAttribute('src'); bg.style.display = 'none'; } }
  updateLike(); updatePlayState(); updateActiveRows(); updateMediaSession(t); updateNextUp();
}
function updateNextUp() {
  const el = $('#np-next'); if (!el) return;
  const n = S.tracks.get(S.queue[S.qi + 1]);
  el.hidden = !n; if (n) $('#np-next-t').textContent = `${n.title} — ${n.artist}`;
}
function updateLike() {
  const t = S.tracks.get(S.cur);
  $$('[data-act=like-current]').forEach((b) => b.classList.toggle('on', !!(t && t.liked)));
}
function updatePlayState() {
  const playing = !audio.paused && !!audio.src;
  document.body.classList.toggle('is-playing', playing);
  $$('[data-act=toggle] use').forEach((u) => u.setAttribute('href', playing ? '#i-pause' : '#i-play'));
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}
function updateActiveRows() {
  $$('.row.active').forEach((r) => r.classList.remove('active'));
  if (S.cur) $$(`.row[data-id="${S.cur}"]`).forEach((r) => r.classList.add('active'));
}
function updateProgress() {
  maybeCount();
  if (seeking || document.hidden) return;
  const d = getDur(), c = audio.currentTime || 0;
  const p = d ? Math.min(1000, (c / d) * 1000) : 0;
  seeks.forEach((r) => { r.value = p; r.style.setProperty('--p', p / 10 + '%'); });
  curTs.forEach((e) => { e.textContent = fmt(c); });
  durTs.forEach((e) => { e.textContent = fmt(d); });
  miniBar.style.width = p / 10 + '%';
  const now = Date.now();
  if (now - lastPos > 1000 && 'mediaSession' in navigator && navigator.mediaSession.setPositionState && d) {
    lastPos = now;
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(c, d), playbackRate: audio.playbackRate || 1 }); } catch { /* ignore */ }
  }
}
seeks.forEach((r) => {
  r.addEventListener('input', () => {
    seeking = true;
    const d = getDur();
    seeks.forEach((x) => { x.value = r.value; x.style.setProperty('--p', r.value / 10 + '%'); });
    curTs.forEach((e) => { e.textContent = fmt((r.value / 1000) * d); });
  });
  r.addEventListener('change', () => {
    const d = getDur();
    if (d) audio.currentTime = (r.value / 1000) * d;
    seeking = false; updateProgress();
  });
});
audio.addEventListener('timeupdate', updateProgress);
audio.addEventListener('loadedmetadata', () => {
  const t = S.tracks.get(S.cur);
  if (t && !t.duration && isFinite(audio.duration)) { t.duration = audio.duration; DB.putTrack(t).catch(() => {}); }
  updateProgress();
});
audio.addEventListener('play', updatePlayState);
audio.addEventListener('pause', () => { updatePlayState(); savePos(); });
audio.addEventListener('ended', () => next(true));
audio.addEventListener('error', () => { if (audio.src) toast('Format audio non pris en charge par ce navigateur'); });
setInterval(() => { if (!audio.paused && !document.hidden) savePos(); }, 10000);
document.addEventListener('visibilitychange', () => { if (document.hidden) { savePos(); persistQueue(); } else updateProgress(); });
window.addEventListener('pagehide', () => { savePos(); persistQueue(); });

/* Volume */
const vol = $('#vol');
function setVolume(v) { audio.volume = v / 100; vol.value = v; vol.style.setProperty('--p', v + '%'); LS.set('vol', v); updateMute(); }
function updateMute() { $$('[data-act=mute] use').forEach((u) => u.setAttribute('href', audio.muted || audio.volume === 0 ? '#i-mute' : '#i-volume')); }
vol.addEventListener('input', () => { audio.muted = false; setVolume(+vol.value); });

/* Commandes du système (écran verrouillé, casque, notification) */
function initMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* non supporté */ } };
  set('play', () => audio.play().catch(() => {}));
  set('pause', () => audio.pause());
  set('previoustrack', prev);
  set('nexttrack', () => next(false));
  set('seekbackward', (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d?.seekOffset || 10)); });
  set('seekforward', (d) => { audio.currentTime = Math.min(getDur(), audio.currentTime + (d?.seekOffset || 10)); });
  set('seekto', (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
  set('stop', () => audio.pause());
}
function updateMediaSession(t) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist, album: t.album === UNKNOWN_ALBUM ? '' : t.album,
    artwork: t.coverUrl ? [{ src: t.coverUrl, sizes: '320x320', type: 'image/jpeg' }] : [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }]
  });
}

/* Plein écran + file d'attente */
function openNP() {
  if (!S.cur || npEl.classList.contains('open')) return;
  npEl.classList.add('open'); history.pushState({ np: 1 }, '');
}
function closeNP(fromPop) {
  if (!npEl.classList.contains('open')) return;
  npEl.classList.remove('open'); queuePanel.classList.remove('open');
  if (!fromPop && history.state && history.state.np) history.back();
}
window.addEventListener('popstate', () => { if (npEl.classList.contains('open')) closeNP(true); });
function toggleQueue() {
  if (!npEl.classList.contains('open')) openNP();
  queuePanel.classList.toggle('open'); renderQueue();
}
function qRow(t, i, cur) {
  return `<div class="q-row${cur ? ' active' : ''}" data-qi="${i}">${coverHTML(t, 'sm')}<div style="min-width:0"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist)}</div></div>${cur ? '<span></span>' : `<button class="icon-btn" data-qrm="${i}" aria-label="Retirer">${icon('x')}</button>`}</div>`;
}
function renderQueue() {
  updateNextUp();
  if (!queuePanel.classList.contains('open')) return;
  const cur = S.tracks.get(S.cur);
  const nxt = S.queue.slice(S.qi + 1, S.qi + 151).map((id, k) => [S.tracks.get(id), S.qi + 1 + k]).filter(([t]) => t);
  $('#queue-list').innerHTML =
    (cur ? `<h3>En cours de lecture</h3>${qRow(cur, S.qi, true)}` : '') +
    (nxt.length ? `<h3>À suivre</h3>${nxt.map(([t, i]) => qRow(t, i, false)).join('')}` : '<p class="muted" style="padding:16px 8px">Rien à suivre pour le moment.</p>');
}
$('#queue-list').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-qrm]');
  if (rm) {
    const i = +rm.dataset.qrm; const [id] = S.queue.splice(i, 1);
    const bi = S.base.indexOf(id); if (bi >= 0) S.base.splice(bi, 1);
    saveState(); renderQueue(); return;
  }
  const row = e.target.closest('.q-row');
  if (row && +row.dataset.qi !== S.qi) { S.qi = +row.dataset.qi; loadCurrent(true); renderQueue(); }
});

/* =====================================================================
   Favoris, playlists, suppression
   ===================================================================== */
async function toggleLike(id) {
  const t = S.tracks.get(id); if (!t) return;
  t.liked = !t.liked; t.likedAt = t.liked ? Date.now() : 0;
  await DB.putTrack(t).catch(() => {});
  updateLike();
  $$(`.row[data-id="${id}"] .like`).forEach((b) => b.classList.toggle('on', t.liked));
  renderSide();
  toast(t.liked ? 'Ajouté à vos titres likés' : 'Retiré de vos titres likés', 1600);
}
async function savePlaylist(p) { await DB.put('playlists', p); renderSide(); }
async function createPlaylist(name, ids = []) {
  const p = { id: uid(), name, ids: uniq(ids), created: Date.now() };
  S.playlists.push(p); await savePlaylist(p); return p;
}
function newPlaylistFlow(ids = [], after) {
  promptSheet({ title: 'Nouvelle playlist', placeholder: `Ma playlist n°${S.playlists.length + 1}`, value: '', ok: 'Créer' }, async (name) => {
    const p = await createPlaylist(name, ids);
    toast(ids.length ? `Playlist « ${name} » créée` : 'Playlist créée');
    if (after) after(p); else if (!ids.length) location.hash = '#/playlist/' + p.id; else refreshView();
  });
}
function pickPlaylist(ids) {
  const items = [{ icon: 'plus', label: 'Nouvelle playlist', action: () => newPlaylistFlow(ids) }];
  S.playlists.forEach((p) => items.push({
    icon: 'note', label: p.name, sub: plural(p.ids.length, 'titre'),
    action: async () => {
      const before = p.ids.length; p.ids = uniq([...p.ids, ...ids]);
      await savePlaylist(p); refreshView();
      toast(p.ids.length > before ? `Ajouté à « ${p.name} »` : `Déjà dans « ${p.name} »`);
    }
  }));
  menuSheet(`<div class="sheet-title">Ajouter à une playlist</div>`, items);
}
async function removeFromPlaylist(pid, id) {
  const p = S.playlists.find((x) => x.id === pid); if (!p) return;
  p.ids = p.ids.filter((x) => x !== id); await savePlaylist(p); refreshView(); toast('Retiré de la playlist');
}
async function deletePlaylist(pid) {
  S.playlists = S.playlists.filter((p) => p.id !== pid);
  await DB.del('playlists', pid).catch(() => {}); renderSide();
  location.hash = '#/library'; toast('Playlist supprimée');
}
async function deleteTracks(ids) {
  const set = new Set(ids);
  try { await DB.removeTracks(ids); } catch { toast('Suppression impossible'); return; }
  ids.forEach((id) => { const t = S.tracks.get(id); if (t && t.coverUrl) URL.revokeObjectURL(t.coverUrl); S.tracks.delete(id); });
  for (const p of S.playlists) { if (p.ids.some((x) => set.has(x))) { p.ids = p.ids.filter((x) => !set.has(x)); await DB.put('playlists', p).catch(() => {}); } }
  S.history = S.history.filter((x) => !set.has(x)); LS.set('history', S.history);
  dropFromQueue(ids);
  renderSide(); refreshView();
  toast(ids.length > 1 ? `${ids.length} titres supprimés` : 'Titre supprimé');
}
function openTrackMenu(id, opts = {}) {
  const t = S.tracks.get(id); if (!t) return;
  const items = [
    { icon: 'heart', label: t.liked ? 'Retirer des titres likés' : 'Ajouter aux titres likés', action: () => toggleLike(id) },
    { icon: 'queue', label: 'Lire ensuite', action: () => queueNext([id]) },
    { icon: 'plus', label: 'Ajouter à la file d’attente', action: () => queueAdd([id]) },
    { icon: 'note', label: 'Ajouter à une playlist', action: () => pickPlaylist([id]) }
  ];
  if (opts.playlistId) items.push({ icon: 'x', label: 'Retirer de cette playlist', action: () => removeFromPlaylist(opts.playlistId, id) });
  items.push({ icon: 'user', label: 'Voir l’artiste', action: () => { closeNP(); location.hash = '#/artist/' + encodeURIComponent(t.artist); } });
  if (t.album !== UNKNOWN_ALBUM) items.push({ icon: 'disc', label: 'Voir l’album', action: () => { closeNP(); location.hash = '#/album/' + encodeURIComponent(t.album); } });
  items.push({ icon: 'trash', label: 'Supprimer de l’appareil', danger: true, action: () => confirmSheet(`Supprimer « ${t.title} » de votre bibliothèque ? Le fichier sera effacé de l’application.`, 'Supprimer', () => deleteTracks([id])) });
  menuSheet(trackHead(t), items);
}

/* =====================================================================
   Listes de titres (rendu progressif pour rester fluide)
   ===================================================================== */
function rowHTML(t, i) {
  return `<div class="row${t.id === S.cur ? ' active' : ''}" data-id="${t.id}">
    <div class="idx"><span class="n">${i + 1}</span><span class="eq"><i></i><i></i><i></i></span></div>
    ${coverHTML(t, 'sm')}
    <div class="meta"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist)}</div></div>
    <div class="alb">${esc(t.album === UNKNOWN_ALBUM ? '' : t.album)}</div>
    <button class="icon-btn like like-btn${t.liked ? ' on' : ''}" aria-label="J’aime">${icon('heart')}</button>
    <div class="dur">${fmt(t.duration)}</div>
    <button class="icon-btn more" aria-label="Plus d’options">${icon('more', 'f')}</button>
  </div>`;
}
function cleanupLists() { S.ios.forEach((o) => o.disconnect()); S.ios = []; }
function mountTrackList(el, tracks, opts = {}) {
  el._tracks = tracks; el._opts = opts;
  const STEP = 60; let shown = 0;
  const sentinel = document.createElement('div'); sentinel.className = 'sentinel';
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) more(); }, { root: main, rootMargin: '900px' });
  S.ios.push(io);
  function more() {
    io.unobserve(sentinel); sentinel.remove();
    const end = Math.min(shown + STEP, tracks.length);
    el.insertAdjacentHTML('beforeend', tracks.slice(shown, end).map((t, k) => rowHTML(t, shown + k)).join(''));
    shown = end;
    if (shown < tracks.length) { el.appendChild(sentinel); io.observe(sentinel); }
  }
  el.innerHTML = '';
  more();
  if (!el._bound) {
    el._bound = true;
    el.addEventListener('click', (e) => {
      const row = e.target.closest('.row'); if (!row) return;
      const id = row.dataset.id;
      if (e.target.closest('.like')) { toggleLike(id); return; }
      if (e.target.closest('.more')) { openTrackMenu(id, el._opts); return; }
      play(el._tracks.map((t) => t.id), id);
    });
  }
}

/* =====================================================================
   Vues
   ===================================================================== */
const V = {};
const allTracks = () => [...S.tracks.values()];
const byRecent = (a, b) => b.addedAt - a.addedAt;
function groupBy(tracks, key) {
  const m = new Map();
  for (const t of tracks) { const k = t[key] || '?'; if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
  return m;
}
const listHead = '<div class="list-head"><span>#</span><span></span><span>Titre</span><span>Album</span><span></span><span>Durée</span><span></span></div>';

function emptyHTML() {
  return `<div class="empty-state">
    <img src="logo.png" alt="">
    <h2>Bienvenue sur NEXA</h2>
    <p>Ajoutez des fichiers audio depuis votre appareil. Ils restent dans l’application et se lisent partout, même sans internet.</p>
    <button class="btn" data-act="import">${icon('upload')}Ajouter de la musique</button>
    <button class="chip" data-act="import-folder">${icon('folder')}Scanner un dossier</button>
  </div>`;
}

V.search = () => {
  view.innerHTML = `<div class="search-box"><label>${icon('search')}<input id="q" type="search" placeholder="Que souhaitez-vous écouter ?" value="${esc(S.q)}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"></label></div><div id="search-out"></div>`;
  const out = $('#search-out'), inp = $('#q');
  inp.addEventListener('input', debounce(() => { S.q = inp.value; renderSearch(out, S.q); }, 60));
  renderSearch(out, S.q);
};
function renderSearch(out, raw) {
  cleanupLists();
  const q = norm(raw.trim()), all = allTracks();
  if (!all.length) { out.innerHTML = '<p class="muted">Ajoutez de la musique pour pouvoir la rechercher.</p>'; return; }
  if (!q) {
    const groups = [...groupBy(all, 'artist')].sort((a, b) => b[1].length - a[1].length).slice(0, 30);
    const fl = NEXA.intel.families(all).filter((f) => f.name !== NEXA.intel.NONE);
    out.innerHTML = (fl.length ? `<h2 class="sec" style="margin-top:6px">Parcourir les genres</h2><div class="tiles">${fl.map((f) => `<div class="tile gtile" style="--g1:${f.g[0]};--g2:${f.g[1]}" data-go="#/genre/${encodeURIComponent(f.name)}">${esc(f.name)}<small>${plural(f.n, 'titre')}</small></div>`).join('')}</div>` : '') + `<h2 class="sec">Parcourir vos artistes</h2><div class="tiles">${groups.map(([n, ts]) => { const f = firstWithCover(ts); return `<div class="tile" style="--c:${colorOf(f)}" data-go="#/artist/${encodeURIComponent(n)}">${esc(n)}<small>${plural(ts.length, 'titre')}</small>${f.coverUrl ? coverHTML(f) : ''}</div>`; }).join('')}</div>`;
    return;
  }
  const res = all.filter((t) => (t._h || (t._h = norm(`${t.title} ${t.artist} ${t.album} ${t.genre || ''} ${t.fam || ''} ${t.year || ''}`))).includes(q))
    .sort((a, b) => (norm(b.title).startsWith(q) - norm(a.title).startsWith(q)) || coll.compare(a.title, b.title));
  const arts = [...groupBy(res.length ? all : [], 'artist')].filter(([n]) => norm(n).includes(q)).slice(0, 10);
  const fams = NEXA.intel.families(all).filter((f) => norm(f.name).includes(q)).slice(0, 6);
  let html = '';
  if (fams.length) html += `<h2 class="sec" style="margin-top:6px">Genres</h2><div class="tabs-row">${fams.map((f) => `<button class="chip" data-go="#/genre/${encodeURIComponent(f.name)}">${icon(f.icon)}${esc(f.name)}</button>`).join('')}</div>`;
  if (arts.length) html += `<h2 class="sec">Artistes</h2><div class="shelf">${arts.map(([n, ts]) => `<div class="card artist" data-go="#/artist/${encodeURIComponent(n)}">${coverHTML(firstWithCover(ts), 'round')}<div class="t">${esc(n)}</div><div class="a">${plural(ts.length, 'titre')}</div></div>`).join('')}</div>`;
  if (res.length) html += `<h2 class="sec">Titres</h2><div class="tracklist" id="res-list"></div>`;
  else if (!fams.length) html = `<p class="muted" style="padding:24px 4px">Aucun résultat pour « ${esc(raw.trim())} ».</p>`;
  out.innerHTML = html;
  if (res.length) mountTrackList($('#res-list'), res);
}

V.library = () => {
  const tabs = [['playlists', 'Playlists'], ['tracks', 'Titres'], ['artists', 'Artistes'], ['albums', 'Albums'], ['genres', 'Genres']];
  view.innerHTML = `
    <div class="page-head"><h1>Bibliothèque</h1><div class="head-actions">
      <button class="icon-btn" data-act="import" title="Ajouter de la musique">${icon('upload')}</button>
      <button class="icon-btn" data-act="new-playlist" title="Nouvelle playlist">${icon('plus')}</button></div></div>
    <div class="tabs-row">${tabs.map(([k, l]) => `<button class="chip${S.libTab === k ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="lib-body"></div><p class="muted" id="storage-info" style="margin-top:28px;font-size:13px"></p>`;
  $('.tabs-row', view).addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    S.libTab = b.dataset.tab; LS.set('libTab', S.libTab);
    $$('.tabs-row .chip', view).forEach((c) => c.classList.toggle('on', c === b));
    renderLibBody();
  });
  renderLibBody(); showStorage();
};
function renderLibBody() {
  cleanupLists();
  const body = $('#lib-body'); if (!body) return;
  const all = allTracks();
  const plainRow = (go, cover, t, a) => `<div class="row plain" data-go="${go}">${cover}<div class="meta"><div class="t">${esc(t)}</div><div class="a">${esc(a)}</div></div></div>`;
  if (S.libTab === 'playlists') {
    const likedN = all.filter((t) => t.liked).length;
    body.innerHTML = plainRow('#/liked', likedCover('sm'), 'Titres likés', `Playlist · ${plural(likedN, 'titre')}`) +
      S.playlists.slice().reverse().map((p) => plainRow('#/playlist/' + p.id, playlistCover(p, 'sm'), p.name, `Playlist · ${plural(p.ids.length, 'titre')}`)).join('') +
      (S.playlists.length ? '' : `<p class="muted" style="padding:18px 4px">Créez votre première playlist avec le bouton +.</p>`);
  } else if (S.libTab === 'tracks') {
    if (!all.length) { body.innerHTML = emptyHTML(); return; }
    const sorts = [['recent', 'Récents'], ['az', 'A–Z'], ['artist', 'Artiste']];
    body.innerHTML = `<div class="tabs-row" id="sort-row">${sorts.map(([k, l]) => `<button class="chip${S.sort === k ? ' on' : ''}" data-sort="${k}">${l}</button>`).join('')}<span class="muted" style="align-self:center;margin-left:auto;font-size:13px;white-space:nowrap">${plural(all.length, 'titre')}</span></div>${listHead}<div class="tracklist" id="lib-list"></div>`;
    const fill = () => {
      const arr = all.slice();
      if (S.sort === 'az') arr.sort((a, b) => coll.compare(a.title, b.title));
      else if (S.sort === 'artist') arr.sort((a, b) => coll.compare(a.artist, b.artist) || coll.compare(a.album, b.album) || (a.no - b.no) || coll.compare(a.title, b.title));
      else arr.sort(byRecent);
      cleanupLists(); mountTrackList($('#lib-list'), arr);
    };
    $('#sort-row').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sort]'); if (!b) return;
      S.sort = b.dataset.sort; LS.set('sort', S.sort);
      $$('#sort-row .chip').forEach((c) => c.classList.toggle('on', c === b)); fill();
    });
    fill();
  } else if (S.libTab === 'artists') {
    const groups = [...groupBy(all, 'artist')].sort((a, b) => coll.compare(a[0], b[0]));
    body.innerHTML = groups.length ? groups.map(([n, ts]) => plainRow('#/artist/' + encodeURIComponent(n), coverHTML(firstWithCover(ts), 'sm round'), n, `Artiste · ${plural(ts.length, 'titre')}`)).join('') : emptyHTML();
  } else if (S.libTab === 'genres') {
    const fl = NEXA.intel.families(all);
    body.innerHTML = fl.length ? fl.map((f) => `<div class="row plain" data-go="#/genre/${encodeURIComponent(f.name)}"><div class="cover sm mixcover" style="--g1:${f.g[0]};--g2:${f.g[1]}">${icon(f.icon)}</div><div class="meta"><div class="t">${esc(f.name)}</div><div class="a">${plural(f.n, 'titre')}${f.name === NEXA.intel.NONE ? ' · sans genre dans les fichiers' : ''}</div></div></div>`).join('') : emptyHTML();
  } else {
    const groups = [...groupBy(all.filter((t) => t.album !== UNKNOWN_ALBUM), 'album')].sort((a, b) => coll.compare(a[0], b[0]));
    body.innerHTML = groups.length ? groups.map(([n, ts]) => plainRow('#/album/' + encodeURIComponent(n), coverHTML(firstWithCover(ts), 'sm'), n, `${ts[0].artist} · ${plural(ts.length, 'titre')}`)).join('') : '<p class="muted" style="padding:18px 4px">Aucun album détecté. Les albums apparaissent quand vos fichiers contiennent des informations (tags).</p>';
  }
}
async function showStorage() {
  const el = $('#storage-info'); if (!el) return;
  let txt = `${plural(S.tracks.size, 'titre')} sur cet appareil`;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      const mo = (usage / 1048576);
      txt += ` · ${mo >= 1024 ? (mo / 1024).toFixed(1) + ' Go' : Math.round(mo) + ' Mo'} utilisés`;
      if (quota) txt += ` sur ${(quota / 1073741824).toFixed(0)} Go disponibles`;
    }
  } catch { /* ignore */ }
  if ($('#storage-info')) el.textContent = txt;
}

/* Vue détaillée d'une collection (playlist, favoris, artiste, album) */
function collectionView(o) {
  const tracks = o.tracks;
  const total = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  if (o.color) main.style.setProperty('--hc', o.color);
  view._ctx = { ids: tracks.map((t) => t.id), playlistId: o.playlistId, kind: o.kind, name: o.name };
  view.innerHTML = `
    <button class="icon-btn back-btn" data-act="back" aria-label="Retour">${icon('left')}</button>
    <div class="col-head">${o.cover}<div style="min-width:0"><div class="kind">${esc(o.kind)}</div><h1>${esc(o.name)}</h1><div class="sub">${esc(o.sub || '')}${tracks.length ? `${o.sub ? ' · ' : ''}${plural(tracks.length, 'titre')}${total ? ', ' + fmtTotal(total) : ''}` : ''}</div></div></div>
    ${tracks.length ? `<div class="col-actions">
      <button class="play-btn fab" data-act="play-all" aria-label="Lire">${icon('play', 'f')}</button>
      <button class="icon-btn big" data-act="shuffle-all" aria-label="Lecture aléatoire">${icon('shuffle')}</button>
      <button class="icon-btn big" data-act="col-menu" aria-label="Plus d’options">${icon('more', 'f')}</button></div>${listHead}
    <div class="tracklist" id="col-list"></div>` : `<div class="col-actions"><button class="icon-btn big" data-act="col-menu" aria-label="Plus d’options">${icon('more', 'f')}</button></div><p class="muted" style="padding:18px 4px">${esc(o.empty || 'Aucun titre pour le moment.')}</p>`}`;
  if (tracks.length) mountTrackList($('#col-list'), tracks, { playlistId: o.playlistId });
}
V.liked = () => {
  const ts = allTracks().filter((t) => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
  collectionView({ kind: 'Playlist', name: 'Titres likés', cover: likedCover(), tracks: ts, color: '#3a3f9c', empty: 'Touchez le cœur d’un titre pour le retrouver ici.' });
};
V.playlist = (id) => {
  const p = S.playlists.find((x) => x.id === id);
  if (!p) { location.hash = '#/library'; return; }
  const ts = p.ids.map((x) => S.tracks.get(x)).filter(Boolean);
  const f = firstWithCover(ts);
  collectionView({ kind: 'Playlist', name: p.name, cover: playlistCover(p), tracks: ts, playlistId: p.id, color: f ? colorOf(f) : hashColor(p.name), empty: 'Cette playlist est vide. Ajoutez des titres depuis le menu ⋯ de chaque titre.' });
};
V.artist = (name) => {
  const ts = allTracks().filter((t) => t.artist === name).sort((a, b) => coll.compare(a.album, b.album) || (a.no - b.no) || coll.compare(a.title, b.title));
  if (!ts.length) { location.hash = '#/library'; return; }
  const f = firstWithCover(ts);
  collectionView({ kind: 'Artiste', name, cover: coverHTML(f, 'round'), tracks: ts, color: colorOf(f) });
};
V.album = (name) => {
  const ts = allTracks().filter((t) => t.album === name).sort((a, b) => (a.no - b.no) || coll.compare(a.title, b.title));
  if (!ts.length) { location.hash = '#/library'; return; }
  const f = firstWithCover(ts);
  collectionView({ kind: 'Album', name, sub: ts[0].artist, cover: coverHTML(f), tracks: ts, color: colorOf(f) });
};

/* Routeur */
function setNav(name) {
  const map = { home: 'home', explore: 'explore', genre: 'explore', mix: 'explore', search: 'search', profile: 'profile', history: 'profile', library: 'library', liked: 'library', playlist: 'library', artist: 'library', album: 'library' };
  $$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === (map[name] || 'home')));
}
function route() {
  const h = location.hash.replace(/^#\/?/, '') || 'home';
  const [name, ...rest] = h.split('/');
  let arg = rest.join('/'); try { arg = decodeURIComponent(arg); } catch { /* ignore */ }
  cleanupLists();
  main.style.removeProperty('--hc');
  view._lists = {}; view._ctx = null;
  setNav(name);
  S.route = h;
  if (NEXA.views[name]) NEXA.views[name](core, arg); else (V[name] || NEXA.views.home)(arg);
  updateActiveRows();
  main.scrollTop = 0;
}
function refreshView() { const st = main.scrollTop; if (S.route.startsWith('search')) { const o = $('#search-out'); if (o) { renderSearch(o, S.q); return; } } route(); main.scrollTop = st; }
window.addEventListener('hashchange', route);

async function clearHistory() {
  S.history = []; LS.set('history', []);
  for (const t of S.tracks.values()) { t.plays = 0; t.skips = 0; t.lastPlayed = 0; t.hours = new Array(24).fill(0); await DB.putTrack(t).catch(() => {}); }
  LS.set('since', Date.now()); toast('Historique effacé'); route();
}

/* Interface commune offerte aux pages (pages.js) */
const core = {
  S, LS, view, main, $, $$, esc, icon, plural, fmt, fmtTotal, coll, byRecent, groupBy, allTracks, uniq,
  coverHTML, likedCover, playlistCover, firstWithCover, colorOf, hashColor,
  emptyHTML, collectionView, play, queueAdd, queueNext, toggleLike, toast, openSheet, closeSheet, promptSheet, confirmSheet,
  syncInstallButtons: () => syncInstallButtons(), showStorage: () => showStorage(), audio
};

/* Barre latérale */
function renderSide() {
  const likedN = allTracks().filter((t) => t.liked).length;
  $('#side-list').innerHTML =
    `<div class="side-item" data-go="#/liked">${likedCover('md')}<div style="min-width:0"><div class="t">Titres likés</div><div class="a">Playlist · ${plural(likedN, 'titre')}</div></div></div>` +
    S.playlists.slice().reverse().map((p) => `<div class="side-item" data-go="#/playlist/${p.id}">${playlistCover(p, 'md')}<div style="min-width:0"><div class="t">${esc(p.name)}</div><div class="a">Playlist · ${plural(p.ids.length, 'titre')}</div></div></div>`).join('');
}

/* =====================================================================
   Actions (clics)
   ===================================================================== */
let installEvt = null;
function syncInstallButtons() { $$('.install').forEach((b) => { b.hidden = !installEvt; }); }
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; syncInstallButtons(); });
window.addEventListener('appinstalled', () => { installEvt = null; syncInstallButtons(); toast('Application installée'); });

const ACT = {
  toggle, prev,
  next: () => next(false),
  shuffle: () => setShuffle(!S.shuffle),
  repeat: cycleRepeat,
  'like-current': () => { if (S.cur) toggleLike(S.cur); },
  'open-np': openNP,
  'close-np': () => closeNP(),
  'np-more': () => { if (S.cur) openTrackMenu(S.cur, {}); },
  queue: toggleQueue,
  mute: () => { audio.muted = !audio.muted; updateMute(); },
  import: () => fileInput.click(),
  'import-folder': () => folderInput.click(),
  install: async () => { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch { /* ignore */ } installEvt = null; syncInstallButtons(); },
  'new-playlist': () => newPlaylistFlow([]),
  eq: () => NEXA.ui.openEQ(core),
  similar: () => NEXA.ui.showSimilar(core),
  'set-name': () => promptSheet({ title: 'Votre prénom', value: LS.get('name', ''), placeholder: 'Prénom', ok: 'Enregistrer' }, (n) => { LS.set('name', n); route(); }),
  'clear-history': () => confirmSheet('Effacer l’historique et les statistiques d’écoute ? Vos titres et playlists restent intacts.', 'Effacer', clearHistory),
  'close-sheet': closeSheet,
  back: () => { if (history.length > 1) history.back(); else location.hash = '#/library'; },
  'play-all': () => { const c = view._ctx; if (c && c.ids.length) play(c.ids, c.ids[0]); },
  'shuffle-all': () => {
    const c = view._ctx; if (!c || !c.ids.length) return;
    S.shuffle = true; LS.set('shuffle', true); updateModes();
    play(c.ids, c.ids[Math.floor(Math.random() * c.ids.length)]);
  },
  'col-menu': () => {
    const c = view._ctx; if (!c) return;
    const items = [];
    if (c.ids.length) {
      items.push({ icon: 'queue', label: 'Lire ensuite', action: () => queueNext(c.ids) });
      items.push({ icon: 'plus', label: 'Ajouter à la file d’attente', action: () => queueAdd(c.ids) });
    }
    if (c.playlistId) {
      const p = S.playlists.find((x) => x.id === c.playlistId);
      items.push({ icon: 'edit', label: 'Renommer la playlist', action: () => promptSheet({ title: 'Renommer la playlist', value: p.name, ok: 'Enregistrer' }, async (n) => { p.name = n; await savePlaylist(p); refreshView(); }) });
      items.push({ icon: 'trash', label: 'Supprimer la playlist', danger: true, action: () => confirmSheet(`Supprimer la playlist « ${p.name} » ? Les titres restent dans votre bibliothèque.`, 'Supprimer', () => deletePlaylist(p.id)) });
    } else if (c.ids.length) {
      items.push({ icon: 'note', label: 'Créer une playlist avec ces titres', action: () => newPlaylistFlow(c.ids, (p) => { location.hash = '#/playlist/' + p.id; }) });
    }
    if (items.length) menuSheet(`<div class="sheet-title">${esc(c.name)}</div>`, items);
  }
};
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act],[data-go],[data-shelf]');
  if (!t) return;
  if (t.dataset.go) { location.hash = t.dataset.go; return; }
  if (t.dataset.shelf) { const l = view._lists && view._lists[t.dataset.shelf]; if (l) play(l, t.dataset.id); return; }
  const f = ACT[t.dataset.act]; if (f) f(t, e);
});
fileInput.addEventListener('change', () => { importFiles(fileInput.files); fileInput.value = ''; });
folderInput.addEventListener('change', () => { importFiles(folderInput.files); folderInput.value = ''; });

/* Glisser-déposer de fichiers (ordinateur) */
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) importFiles(e.dataTransfer.files); });

/* Raccourcis clavier */
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (e.key === 'Escape') { if (!sheetWrap.hidden) closeSheet(); else if (queuePanel.classList.contains('open')) queuePanel.classList.remove('open'); else closeNP(); return; }
  if (tag === 'input' && e.target.type !== 'range' || tag === 'textarea' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === ' ') { e.preventDefault(); toggle(); }
  else if (e.key === 'ArrowRight') { e.shiftKey ? next(false) : (audio.currentTime = Math.min(getDur(), audio.currentTime + 5)); }
  else if (e.key === 'ArrowLeft') { e.shiftKey ? prev() : (audio.currentTime = Math.max(0, audio.currentTime - 5)); }
  else if (e.key === 'ArrowUp' && tag !== 'input') { e.preventDefault(); setVolume(Math.min(100, Math.round(audio.volume * 100) + 5)); }
  else if (e.key === 'ArrowDown' && tag !== 'input') { e.preventDefault(); setVolume(Math.max(0, Math.round(audio.volume * 100) - 5)); }
  else if (e.key.toLowerCase() === 'm') ACT.mute();
  else if (e.key.toLowerCase() === 's') ACT.shuffle();
});

/* =====================================================================
   Démarrage
   ===================================================================== */
async function init() {
  try { await DB.open(); }
  catch (e) {
    view.innerHTML = '<div class="empty-state"><h2>Stockage indisponible</h2><p>Votre navigateur bloque le stockage local (navigation privée ?). Ouvrez l’application dans une fenêtre normale.</p></div>';
    return;
  }
  const [tracks, pls] = await Promise.all([DB.all('tracks'), DB.all('playlists')]);
  tracks.forEach((t) => S.tracks.set(t.id, hydrate(t)));
  S.playlists = pls.sort((a, b) => a.created - b.created);
  S.history = LS.get('history', []).filter((id) => S.tracks.has(id));
  S.libTab = LS.get('libTab', 'playlists'); S.sort = LS.get('sort', 'recent');
  S.shuffle = LS.get('shuffle', false); S.repeat = LS.get('repeat', 0);
  setVolume(LS.get('vol', 85)); updateModes();
  if (!LS.get('since', 0)) LS.set('since', Date.now());
  NEXA.eq.init(audio, LS.get('eq', null));
  $$('.np-wave').forEach((w) => { w.innerHTML = Array.from({ length: 7 }, (_, i) => `<i style="--d:${(i * 0.13).toFixed(2)}s;--m:${(0.35 + ((i * 37) % 60) / 100).toFixed(2)}"></i>`).join(''); });
  initMediaSession();
  classifyAll(); renderSide(); route();

  // Reprise de la dernière lecture (en pause)
  const st = LS.get('state', null);
  if (st && Array.isArray(st.queue) && st.queue.length) {
    const curId = st.queue[st.qi];
    S.queue = st.queue.filter((id) => S.tracks.has(id));
    S.base = (st.base || st.queue).filter((id) => S.tracks.has(id));
    S.qi = Math.max(0, S.queue.indexOf(curId));
    if (S.queue.length) {
      const pos = LS.get('pos', null);
      loadCurrent(false, pos && pos.id === S.queue[S.qi] ? pos.t : 0);
    }
  }
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
})();
