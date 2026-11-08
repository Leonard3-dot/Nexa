/* NEXA — lecture des métadonnées M4A/MP4, FLAC, ID3v1 et normalisation des genres.
   Module autonome (aucun accès au DOM). Tout fonctionne hors ligne. */
(function (g) {
'use strict';
const NEXA = g.NEXA = g.NEXA || {};

const ID3V1_GENRES = ['Blues','Classic Rock','Country','Dance','Disco','Funk','Grunge','Hip-Hop','Jazz','Metal','New Age','Oldies','Other','Pop','R&B','Rap','Reggae','Rock','Techno','Industrial','Alternative','Ska','Death Metal','Pranks','Soundtrack','Euro-Techno','Ambient','Trip-Hop','Vocal','Jazz+Funk','Fusion','Trance','Classical','Instrumental','Acid','House','Game','Sound Clip','Gospel','Noise','Alternative Rock','Bass','Soul','Punk','Space','Meditative','Instrumental Pop','Instrumental Rock','Ethnic','Gothic','Darkwave','Techno-Industrial','Electronic','Pop-Folk','Eurodance','Dream','Southern Rock','Comedy','Cult','Gangsta','Top 40','Christian Rap','Pop/Funk','Jungle','Native American','Cabaret','New Wave','Psychedelic','Rave','Showtunes','Trailer','Lo-Fi','Tribal','Acid Punk','Acid Jazz','Polka','Retro','Musical','Rock & Roll','Hard Rock'];

/** Nettoie un genre brut : "(17)", "17", "rock;pop", "ROCK"… */
function cleanGenre(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\0/g, ';').trim();
  const m = s.match(/^\((\d{1,3})\)\s*(.*)$/);
  if (m) s = m[2] || ID3V1_GENRES[+m[1]] || '';
  else if (/^\d{1,3}$/.test(s)) s = ID3V1_GENRES[+s] || '';
  s = s.split(';')[0].trim();
  if (!s) return '';
  if (s === s.toLowerCase() || s === s.toUpperCase()) s = s.toLowerCase().replace(/(^|[\s\-/])([a-zà-ÿ])/g, (_, a, b) => a + b.toUpperCase());
  return s.slice(0, 40);
}
/** Extrait une année plausible d'un texte ("2019-05-02", "2019"). */
function cleanYear(raw) {
  const m = String(raw || '').match(/(19|20)\d{2}/);
  return m ? +m[0] : 0;
}

const slice = async (file, a, b) => new Uint8Array(await file.slice(a, b).arrayBuffer());
const latin = (u8, a, b) => { let s = ''; for (let i = a; i < b; i++) s += String.fromCharCode(u8[i]); return s; };
const utf8 = (u8, a, b) => { try { return new TextDecoder('utf-8').decode(u8.subarray(a, b)); } catch { return ''; } };
const sniffImg = (u8) => (u8[0] === 0xff && u8[1] === 0xd8 ? 'image/jpeg' : u8[0] === 0x89 && u8[1] === 0x50 ? 'image/png' : u8[0] === 0x52 && u8[1] === 0x49 ? 'image/webp' : u8[0] === 0x47 && u8[1] === 0x49 ? 'image/gif' : '');

/* ---------- ID3v1 (fin de fichier MP3) ---------- */
async function parseID3v1(file) {
  if (file.size < 128) return {};
  const b = await slice(file, file.size - 128, file.size);
  if (latin(b, 0, 3) !== 'TAG') return {};
  const txt = (a, z) => latin(b, a, z).replace(/\0.*$/s, '').trim();
  const out = { title: txt(3, 33), artist: txt(33, 63), album: txt(63, 93), year: cleanYear(txt(93, 97)) };
  const gi = b[127]; if (gi < ID3V1_GENRES.length) out.genre = ID3V1_GENRES[gi];
  if (b[125] === 0 && b[126] > 0) out.no = b[126];
  return out;
}

/* ---------- MP4 / M4A ---------- */
const CONTAINERS = new Set(['moov', 'udta', 'ilst']);
async function parseMP4(file) {
  const out = {};
  const len = file.size;
  let pos = 0, guard = 0;
  while (pos + 8 <= len && guard++ < 64) {
    const h = new DataView((await slice(file, pos, pos + 16)).buffer);
    let size = h.getUint32(0); const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    if (size === 1) size = Number(h.getBigUint64(8)); else if (size === 0) size = len - pos;
    if (size < 8) break;
    if (type === 'moov') {
      if (size > 48 * 1048576) break;
      const buf = await slice(file, pos, pos + size);
      walkMP4(buf, 8, buf.length, out);
      break;
    }
    pos += size;
  }
  return out;
}
function walkMP4(u8, s, e, out) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = s;
  while (p + 8 <= e) {
    const size = dv.getUint32(p); const type = latin(u8, p + 4, p + 8);
    if (size < 8 || p + size > e) break;
    if (CONTAINERS.has(type)) walkMP4(u8, p + 8, p + size, out);
    else if (type === 'meta') walkMP4(u8, p + 12, p + size, out);
    else if (type[0] === '©' || type === 'aART' || type === 'covr' || type === 'trkn' || type === 'gnre') readItem(u8, dv, p, p + size, type, out);
    p += size;
  }
}
function readItem(u8, dv, s, e, type, out) {
  let p = s + 8;
  while (p + 16 <= e) {
    const size = dv.getUint32(p);
    if (size < 16 || p + size > e) break;
    if (latin(u8, p + 4, p + 8) === 'data') {
      const flags = dv.getUint32(p + 8) & 0xffffff, a = p + 16, z = p + size;
      if (type === 'covr') { const t = sniffImg(u8.subarray(a, z)) || (flags === 14 ? 'image/png' : 'image/jpeg'); if (!out.coverBlob) out.coverBlob = new Blob([u8.slice(a, z)], { type: t }); }
      else if (type === 'trkn') { if (z - a >= 4) out.no = dv.getUint16(a + 2); }
      else if (type === 'gnre') { if (z - a >= 2 && !out.genre) out.genre = ID3V1_GENRES[dv.getUint16(a) - 1] || ''; }
      else {
        const v = utf8(u8, a, z).trim();
        if (type === '©nam') out.title = v;
        else if (type === '©ART') out.artist = v;
        else if (type === 'aART') out.albumArtist = v;
        else if (type === '©alb') out.album = v;
        else if (type === '©gen') out.genre = v;
        else if (type === '©day') out.year = cleanYear(v);
      }
      return;
    }
    p += size;
  }
}

/* ---------- FLAC ---------- */
async function parseFLAC(file) {
  const out = {};
  const head = await slice(file, 0, 4);
  if (latin(head, 0, 4) !== 'fLaC') return out;
  let pos = 4, guard = 0;
  while (pos + 4 <= file.size && guard++ < 64) {
    const h = await slice(file, pos, pos + 4);
    const last = h[0] & 0x80, type = h[0] & 0x7f, size = (h[1] << 16) | (h[2] << 8) | h[3];
    pos += 4;
    if (size > 16 * 1048576) { pos += size; if (last) break; continue; }
    if (type === 4 || (type === 6 && !out.coverBlob)) {
      const b = await slice(file, pos, pos + size); const dv = new DataView(b.buffer);
      if (type === 4) {
        let p = 0; const vl = dv.getUint32(p, true); p += 4 + vl;
        const n = dv.getUint32(p, true); p += 4;
        for (let i = 0; i < n && p + 4 <= b.length; i++) {
          const l = dv.getUint32(p, true); p += 4;
          const s = utf8(b, p, p + l); p += l;
          const k = s.indexOf('='); if (k < 0) continue;
          const key = s.slice(0, k).toUpperCase(), val = s.slice(k + 1).trim();
          if (key === 'TITLE') out.title = val; else if (key === 'ARTIST') out.artist = val; else if (key === 'ALBUMARTIST') out.albumArtist = val;
          else if (key === 'ALBUM') out.album = val; else if (key === 'GENRE') out.genre = val;
          else if (key === 'DATE' || key === 'YEAR') out.year = cleanYear(val);
          else if (key === 'TRACKNUMBER') out.no = parseInt(val, 10) || 0;
        }
      } else {
        let p = 4; const ml = dv.getUint32(p); p += 4 + ml;
        const dl = dv.getUint32(p); p += 4 + dl + 16;
        const il = dv.getUint32(p); p += 4;
        const img = b.slice(p, p + il); out.coverBlob = new Blob([img], { type: sniffImg(img) || 'image/jpeg' });
      }
    }
    pos += size;
    if (last) break;
  }
  return out;
}

NEXA.meta = { cleanGenre, cleanYear, parseID3v1, parseMP4, parseFLAC, ID3V1_GENRES };
})(typeof window !== 'undefined' ? window : globalThis);
