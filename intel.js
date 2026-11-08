/* NEXA — intelligence locale (sans IA externe, sans réseau).
   Classement automatique, habitudes d'écoute, recommandations, titres similaires, mixes.
   Module pur : il ne touche ni au DOM ni au stockage, donc simple à tester et à faire évoluer. */
(function (g) {
'use strict';
const NEXA = g.NEXA = g.NEXA || {};
const DAY = 864e5, HOUR = 36e5;
const UNK_ARTIST = 'Artiste inconnu', UNK_ALBUM = 'Album inconnu', NONE = 'Non classé', OTHER = 'Autre';

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/* Familles de genres : nom, motif de reconnaissance, dégradé, icône */
const FAMS = [
  { name: 'Afro',          re: /afro|coupe|decale|zouk|highlife|makossa|rumba|soukous|mbalax|amapiano|kizomba|mandingue|griot|african|gnawa|raï|rai\b/, g: ['#ff9a1f', '#ff3d6e'], icon: 'sun' },
  { name: 'Reggae',        re: /reggae|dancehall|\bska\b|\bdub\b|ragga/, g: ['#2fd36b', '#e8c21a'], icon: 'leaf' },
  { name: 'Hip-Hop',       re: /hip|rap\b|trap|drill|grime/, g: ['#ff4d6d', '#8a2cff'], icon: 'flame' },
  { name: 'Latino',        re: /latin|salsa|reggaeton|bachata|merengue|cumbia|tango/, g: ['#ff7a3d', '#e91e8c'], icon: 'sun' },
  { name: 'Jazz & Blues',  re: /jazz|blues|swing|bossa/, g: ['#4d7cff', '#1b2a6b'], icon: 'moon' },
  { name: 'Classique',     re: /classi|opera|symph|orchestra|baroque|piano|soundtrack|score|instrumental/, g: ['#b6a4ff', '#4c3aa8'], icon: 'disc' },
  { name: 'Électro',       re: /electro|house|techno|trance|edm|dubstep|drum|dnb|ambient|chill|lounge|club|dance|disco|synth|rave|lo-?fi/, g: ['#19e0ff', '#7a3dff'], icon: 'wave' },
  { name: 'R&B / Soul',    re: /r&b|rnb|soul|funk|motown|gospel/, g: ['#ff5fa8', '#7b2cff'], icon: 'heart' },
  { name: 'Rock',          re: /rock|metal|punk|grunge|indie|alternative|hard|emo/, g: ['#ff4040', '#3a1c71'], icon: 'bolt' },
  { name: 'Folk & Country', re: /folk|country|acoustic|singer|bluegrass/, g: ['#d9a441', '#6b3f1d'], icon: 'leaf' },
  { name: 'Religieux',     re: /religio|worship|christian|islam|nasheed|quran|coran|louange/, g: ['#7fd1ff', '#3d5afe'], icon: 'star' },
  { name: 'Chanson',       re: /chanson|variet|french|francais|francophone/, g: ['#f06292', '#512da8'], icon: 'note' },
  { name: 'Pop',           re: /pop|k-?pop|j-?pop|top 40/, g: ['#ff4fd8', '#3d7bff'], icon: 'star' }
];
const FAM_OTHER = { name: OTHER, g: ['#5b6cff', '#251a5e'], icon: 'note' };
const FAM_NONE = { name: NONE, g: ['#3a4a6b', '#141a2c'], icon: 'disc' };
const famInfo = (name) => FAMS.find((f) => f.name === name) || (name === NONE ? FAM_NONE : FAM_OTHER);

function family(genre) {
  if (!genre) return NONE;
  const s = norm(genre);
  for (const f of FAMS) if (f.re.test(s)) return f.name;
  return OTHER;
}

/** Classe automatiquement les titres. Sans genre, on déduit la famille depuis le même artiste ou le même album. */
function classify(tracks) {
  const byKey = new Map();
  const bump = (k, fam) => { let m = byKey.get(k); if (!m) byKey.set(k, m = new Map()); m.set(fam, (m.get(fam) || 0) + 1); };
  for (const t of tracks) {
    t.fam = family(t.genre); t.famGuess = false;
    if (t.genre && t.fam !== NONE) { if (t.artist !== UNK_ARTIST) bump('a:' + t.artist, t.fam); if (t.album !== UNK_ALBUM) bump('b:' + t.album, t.fam); }
  }
  const best = (k) => { const m = byKey.get(k); if (!m) return null; let b = null, n = 0; m.forEach((c, f) => { if (c > n) { n = c; b = f; } }); return b; };
  for (const t of tracks) {
    if (t.genre) continue;
    const f = (t.artist !== UNK_ARTIST && best('a:' + t.artist)) || (t.album !== UNK_ALBUM && best('b:' + t.album));
    if (f) { t.fam = f; t.famGuess = true; }
  }
  return tracks;
}

const periodOfHour = (h) => (h < 5 ? 'nuit' : h < 12 ? 'matin' : h < 18 ? 'après-midi' : 'soir');
const PERIOD_RANGE = { nuit: [0, 5], matin: [5, 12], 'après-midi': [12, 18], soir: [18, 24] };
const decadeOf = (t) => (t.year ? Math.floor(t.year / 10) * 10 : 0);

function rng(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}
const dayKey = (now) => new Date(now).toISOString().slice(0, 10);
const sum = (a) => (a || []).reduce((s, v) => s + v, 0);

/** Profil de goûts : poids normalisés par artiste / famille / album (récence + favoris − sauts). */
function buildProfile(tracks, now) {
  const artist = new Map(), fam = new Map(), album = new Map();
  const add = (m, k, w) => m.set(k, (m.get(k) || 0) + w);
  for (const t of tracks) {
    const p = t.plays || 0; let w = 0;
    if (p > 0) { const age = Math.max(0, now - (t.lastPlayed || t.addedAt || now)); w += Math.log2(1 + p) * (0.35 + 0.65 * Math.pow(0.5, age / (14 * DAY))); }
    if (t.liked) w += 2;
    w -= Math.min(1, (t.skips || 0) * 0.25);
    if (w <= 0) continue;
    if (t.artist !== UNK_ARTIST) add(artist, t.artist, w);
    add(fam, t.fam || NONE, w);
    if (t.album !== UNK_ALBUM) add(album, t.album, w);
  }
  const nz = (m) => { let mx = 0; m.forEach((v) => { if (v > mx) mx = v; }); const r = new Map(); m.forEach((v, k) => r.set(k, mx ? v / mx : 0)); return r; };
  return { artist: nz(artist), fam: nz(fam), album: nz(album), has: artist.size + fam.size > 0 };
}

function periodShare(t, period) {
  const tot = sum(t.hours); if (!tot) return 0;
  const [a, b] = PERIOD_RANGE[period]; let s = 0;
  for (let h = a; h < b; h++) s += t.hours[h] || 0;
  return s / tot;
}

function scoreTrack(t, prof, now, rand) {
  let s = 0;
  if (prof.has) s += 0.5 * (prof.artist.get(t.artist) || 0) + 0.3 * (prof.fam.get(t.fam) || 0) + 0.1 * (prof.album.get(t.album) || 0);
  if (!(t.plays > 0)) s += 0.12;
  if (t.lastPlayed && now - t.lastPlayed < 6 * HOUR) s -= 0.35;
  s -= Math.min(0.3, (t.skips || 0) * 0.08);
  if (t.liked) s += 0.08;
  s += 0.15 * periodShare(t, periodOfHour(new Date(now).getHours()));
  return s + 0.1 * rand();
}

/** Limite le nombre de titres d'un même artiste pour garder de la variété. */
function diversify(sorted, n, perArtist) {
  const out = [], cnt = new Map(), rest = [];
  for (const t of sorted) {
    const c = cnt.get(t.artist) || 0;
    if (t.artist === UNK_ARTIST || c < perArtist) { out.push(t); cnt.set(t.artist, c + 1); } else rest.push(t);
    if (out.length >= n) return out;
  }
  return out.concat(rest).slice(0, n);
}

/** Recommandations personnalisées à partir de l'historique (stables sur la journée). */
function recommend(tracks, opts = {}) {
  const now = opts.now || Date.now(), n = opts.n || 20, ex = opts.exclude;
  const prof = buildProfile(tracks, now), rand = rng('rec' + dayKey(now));
  const scored = tracks.filter((t) => !(ex && ex.has(t.id))).map((t) => [t, scoreTrack(t, prof, now, rand)]);
  scored.sort((a, b) => b[1] - a[1]);
  return diversify(scored.map((x) => x[0]), n, Math.max(2, Math.ceil(n / 4)));
}

/** Titres proches d'un titre donné, d'après les métadonnées uniquement. */
function similar(t, tracks, n = 25) {
  const rand = rng('sim' + t.id);
  const nz = norm(t.genre);
  const scored = [];
  for (const u of tracks) {
    if (u.id === t.id) continue;
    let s = 0;
    if (t.artist !== UNK_ARTIST && u.artist === t.artist) s += 3;
    if (t.album !== UNK_ALBUM && u.album === t.album) s += 2;
    if (nz && norm(u.genre) === nz) s += 2.2; else if (t.fam !== NONE && u.fam === t.fam) s += 1.5;
    if (t.year && u.year) { const d = Math.abs(t.year - u.year); s += d <= 2 ? 1 : d <= 5 ? 0.6 : d <= 10 ? 0.25 : 0; }
    if (t.duration && u.duration) s += 0.3 * (Math.min(t.duration, u.duration) / Math.max(t.duration, u.duration));
    if (u.liked) s += 0.2;
    scored.push([u, s + 0.05 * rand()]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.filter((x) => x[1] > 0.3).slice(0, n).map((x) => x[0]);
}

/** Statistiques d'habitudes d'écoute. */
function habits(tracks, now, sinceTs) {
  const hours = new Array(24).fill(0);
  let plays = 0, secs = 0, played = 0;
  const art = new Map(), fam = new Map();
  for (const t of tracks) {
    const p = t.plays || 0; if (!p) continue;
    played++; plays += p; secs += p * (t.duration || 0);
    if (t.hours) for (let h = 0; h < 24; h++) hours[h] += t.hours[h] || 0;
    if (t.artist !== UNK_ARTIST) art.set(t.artist, (art.get(t.artist) || 0) + p);
    if (t.fam && t.fam !== NONE) fam.set(t.fam, (fam.get(t.fam) || 0) + p);
  }
  const top = (m) => { let b = null, n = 0; m.forEach((v, k) => { if (v > n) { n = v; b = k; } }); return b ? { name: b, count: n } : null; };
  const per = {}; for (const k of Object.keys(PERIOD_RANGE)) per[k] = sum(hours.slice(PERIOD_RANGE[k][0], PERIOD_RANGE[k][1]));
  let peak = null, pn = 0; for (const k in per) if (per[k] > pn) { pn = per[k]; peak = k; }
  const days = Math.max(1, Math.ceil((now - (sinceTs || now)) / DAY));
  return { plays, seconds: secs, played, hours, period: peak, topArtist: top(art), topFamily: top(fam), perDay: plays / days, liked: tracks.filter((t) => t.liked).length };
}

/* ---------- Mixes automatiques ---------- */
const MOMENT_NAME = { nuit: 'Mix de la nuit', matin: 'Mix du matin', 'après-midi': 'Mix de l’après-midi', soir: 'Mix du soir' };
const take = (arr, n) => arr.slice(0, n).map((t) => t.id);

function buildMix(kind, arg, tracks, now) {
  const rand = rng(kind + (arg || '') + dayKey(now));
  const shuf = (a) => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
  switch (kind) {
    case 'moment': {
      const per = periodOfHour(new Date(now).getHours()), prof = buildProfile(tracks, now);
      let ids = tracks.map((t) => [t, periodShare(t, per) * Math.log2(2 + (t.plays || 0)) + 0.5 * ((prof.artist.get(t.artist) || 0) * 0.6 + (prof.fam.get(t.fam) || 0) * 0.4) + 0.1 * rand()])
        .filter((x) => x[1] > 0.12).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
      if (ids.length < 8) ids = ids.concat(recommend(tracks, { now, n: 30 }).filter((t) => !ids.includes(t))).slice(0, 30);
      return { id: 'moment', name: MOMENT_NAME[per], sub: 'Selon vos habitudes d’écoute', ids: take(ids, 30), g: ['#4d7cff', '#a24bff'], icon: per === 'matin' ? 'sun' : per === 'nuit' ? 'moon' : 'wave' };
    }
    case 'recs': return { id: 'recs', name: 'Recommandé pour vous', sub: 'Choisi d’après votre historique', ids: take(recommend(tracks, { now, n: 30 }), 30), g: ['#00b3ff', '#7b2cff'], icon: 'sparkle' };
    case 'discover': {
      const ids = shuf(tracks.filter((t) => !(t.plays > 0)));
      return { id: 'discover', name: 'Découvertes', sub: 'Titres que vous n’avez pas encore écoutés', ids: take(ids, 30), g: ['#19e0ff', '#2f5bff'], icon: 'sparkle' };
    }
    case 'top': {
      const ids = tracks.filter((t) => t.plays > 0).sort((a, b) => b.plays - a.plays || (b.lastPlayed || 0) - (a.lastPlayed || 0));
      return { id: 'top', name: 'Vos plus écoutés', sub: 'Vos titres numéro un', ids: take(ids, 40), g: ['#ff3df2', '#7b2cff'], icon: 'flame' };
    }
    case 'forgotten': {
      const ids = shuf(tracks.filter((t) => (t.plays > 0 || t.liked) && now - (t.lastPlayed || 0) > 21 * DAY));
      return { id: 'forgotten', name: 'À redécouvrir', sub: 'Des titres que vous aimiez', ids: take(ids, 30), g: ['#a24bff', '#2563ff'], icon: 'clock' };
    }
    case 'fam': {
      const ids = tracks.filter((t) => t.fam === arg).sort((a, b) => (b.plays || 0) - (a.plays || 0) || (b.liked | 0) - (a.liked | 0));
      const fi = famInfo(arg);
      return { id: 'fam:' + arg, name: 'Mix ' + arg, sub: 'Classé automatiquement', ids: take(shuf(ids.slice(0, 80)), 40), g: fi.g, icon: fi.icon };
    }
    case 'dec': {
      const d = +arg, ids = tracks.filter((t) => decadeOf(t) === d);
      return { id: 'dec:' + d, name: 'Années ' + (d >= 2000 ? d : String(d).slice(2)), sub: 'Votre musique de ' + d + ' à ' + (d + 9), ids: take(shuf(ids), 40), g: ['#7a3dff', '#19e0ff'], icon: 'clock' };
    }
    default: return null;
  }
}
function mixById(id, tracks, now) { const [k, ...r] = String(id).split(':'); return buildMix(k, r.join(':'), tracks, now || Date.now()); }

function mixes(tracks, now) {
  now = now || Date.now();
  const out = [], push = (m, min) => { if (m && m.ids.length >= (min || 3)) out.push(m); };
  if (!tracks.length) return out;
  push(buildMix('moment', '', tracks, now), 5);
  push(buildMix('recs', '', tracks, now), 5);
  push(buildMix('top', '', tracks, now));
  push(buildMix('discover', '', tracks, now));
  push(buildMix('forgotten', '', tracks, now));
  const fams = new Map(); tracks.forEach((t) => { if (t.fam && t.fam !== NONE) fams.set(t.fam, (fams.get(t.fam) || 0) + 1); });
  [...fams].sort((a, b) => b[1] - a[1]).forEach(([f, n]) => { if (n >= 4) push(buildMix('fam', f, tracks, now)); });
  const decs = new Map(); tracks.forEach((t) => { const d = decadeOf(t); if (d) decs.set(d, (decs.get(d) || 0) + 1); });
  [...decs].sort((a, b) => b[0] - a[0]).forEach(([d, n]) => { if (n >= 4) push(buildMix('dec', String(d), tracks, now)); });
  return out;
}

/** Familles présentes avec effectifs, triées. */
function families(tracks) {
  const m = new Map(); tracks.forEach((t) => { const f = t.fam || NONE; m.set(f, (m.get(f) || 0) + 1); });
  return [...m].sort((a, b) => (a[0] === NONE) - (b[0] === NONE) || b[1] - a[1]).map(([name, n]) => ({ name, n, ...famInfo(name) }));
}
function decades(tracks) {
  const m = new Map(); tracks.forEach((t) => { const d = decadeOf(t); if (d) m.set(d, (m.get(d) || 0) + 1); });
  return [...m].sort((a, b) => b[0] - a[0]).map(([d, n]) => ({ decade: d, n }));
}

NEXA.UNKNOWN_ARTIST = UNK_ARTIST; NEXA.UNKNOWN_ALBUM = UNK_ALBUM;
NEXA.intel = { family, famInfo, classify, families, decades, decadeOf, buildProfile, recommend, similar, habits, mixes, mixById, periodOfHour, NONE, OTHER };
if (typeof module !== 'undefined') module.exports = NEXA;
})(typeof window !== 'undefined' ? window : globalThis);
