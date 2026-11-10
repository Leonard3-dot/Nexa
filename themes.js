/* NEXA — thèmes. Ce fichier ne contient que la LISTE des palettes et la logique de choix ;
   les couleurs elles-mêmes sont dans themes.css (variables CSS par thème).
   Le thème choisi est mémorisé (clé « hlm:theme ») et appliqué avant l'affichage par un petit script dans index.html (aucun flash). */
(function (g) {
'use strict';
const NEXA = g.NEXA = g.NEXA || {};
const KEY = 'hlm:theme';
const DEFAULT = 'nexa';

/* bar = couleur de la barre d'état Android/Chrome. p = aperçu dans le sélecteur. */
const THEMES = [
  { id: 'matte', name: 'Cyberpunk Mât', desc: 'Noir mat, acier bleuté, aucune lueur', bar: '#0B0D10', light: false, sober: true,
    p: { bg: '#0B0D10', card: '#13171C', grad: 'linear-gradient(135deg,#6AA6D6,#9CC6E8 60%,#E6EBF1)', tx: '#E6EBF1' } },
  { id: 'deepice', name: 'Deep Ice', desc: 'Abysses glacés, bleu glace, verre fin', bar: '#06121C', light: false, sober: true,
    p: { bg: '#06121C', card: '#0C1D2C', grad: 'linear-gradient(135deg,#7CC4E6,#B9E3F5 70%,#F0FAFF)', tx: '#EAF6FD' } },
  { id: 'navyexec', name: 'Dark Navy Executive', desc: 'Bleu marine sobre, bleu acier', bar: '#0A1224', light: false, sober: true,
    p: { bg: '#0A1224', card: '#111B33', grad: 'linear-gradient(135deg,#4F7FC8,#9DB9E6)', tx: '#E8EEF8' } },
  { id: 'midnightaurora', name: 'Midnight Aurora', desc: 'Nuit bleue, dégradé bleu → bleu ciel', bar: '#070D1F', light: false, sober: true,
    p: { bg: '#070D1F', card: '#0F1830', grad: 'linear-gradient(135deg,#3B6FD8,#5AA9E6 50%,#8FD3F4)', tx: '#EAF1FC' } },
  { id: 'monocyan', name: 'Monochrome & Cyan Soft', desc: 'Noir et blanc, une touche de cyan doux', bar: '#0A0A0B', light: false, sober: true,
    p: { bg: '#0A0A0B', card: '#141416', grad: 'linear-gradient(135deg,#F5F5F6,#A5DDF0 55%,#67C7E8)', tx: '#F5F5F6' } },
  { id: 'stealth', name: 'Stealth Tech', desc: 'Noir pur, lignes fines, bleu discret', bar: '#000000', light: false, sober: true,
    p: { bg: '#000000', card: '#0B0C0E', grad: 'linear-gradient(135deg,#8CB4D4,#B3CDE3)', tx: '#DDE3EA' } },
  { id: 'frostyslate', name: 'Frosty Slate', desc: 'Clair : ardoise givrée, bleu acier', bar: '#E6ECF3', light: true, sober: true,
    p: { bg: '#E6ECF3', card: '#F4F7FB', grad: 'linear-gradient(135deg,#2F6F9F,#5FA3CF)', tx: '#1B2736' } },
  { id: 'polar', name: 'Polar Light', desc: 'Clair : blanc polaire, bleu ciel lumineux', bar: '#EEF8FF', light: true, sober: true,
    p: { bg: '#EEF8FF', card: '#FFFFFF', grad: 'linear-gradient(135deg,#38BDF8,#0369A1)', tx: '#0C2438' } },
  { id: 'nexa',     name: 'NEXA Nuit',       desc: 'Noir profond, bleu électrique, violet néon', bar: '#05060d', light: false,
    p: { bg: '#05060d', card: '#161a3a', grad: 'linear-gradient(135deg,#19b8ff,#5b6bff 48%,#b04bff)', tx: '#fff' } },
  { id: 'frozen', sober: true,   name: 'Frozen Cyan',     desc: 'Navy profond, bleu ciel lumineux, blanc pur', bar: '#0A0F1D', light: false,
    p: { bg: '#0A0F1D', card: '#1e293b', grad: 'linear-gradient(135deg,#38BDF8,#7DD3FC 55%,#fff)', tx: '#fff' } },
  { id: 'cloud', sober: true,    name: 'Cloud & Ocean',   desc: 'Mode clair : blanc cassé, bleu ciel profond', bar: '#F8FAFC', light: true,
    p: { bg: '#F8FAFC', card: '#ffffff', grad: 'linear-gradient(135deg,#0284C7,#38BDF8)', tx: '#0F172A' } },
  { id: 'arctic', sober: true,   name: 'Electric Arctic', desc: 'Néon et verre dépoli, cyan électrique', bar: '#030712', light: false,
    p: { bg: '#030712', card: '#08182c', grad: 'linear-gradient(135deg,#00F0FF,#7DFAFF 55%,#F0F9FF)', tx: '#F0F9FF' } },
  { id: 'sapphire', sober: true, name: 'Sapphire & Cloud', desc: 'Bleu nuit abyssal, cartes ciel → blanc glacé', bar: '#0B132B', light: false,
    p: { bg: '#0B132B', card: 'linear-gradient(135deg,#7DD3FC,#E0F2FE)', grad: 'linear-gradient(135deg,#7DD3FC,#E0F2FE)', tx: '#0B132B' } },
  { id: 'aurora',   name: 'Northern Lights', desc: 'Deep Space, dégradé bleu ciel → menthe', bar: '#0D1117', light: false,
    p: { bg: '#0D1117', card: '#161b22', grad: 'linear-gradient(135deg,#38BDF8,#34D399)', tx: '#F0F6FC' } }
];
const byId = (id) => THEMES.find((t) => t.id === id) || THEMES[0];

function stored() { try { const v = JSON.parse(localStorage.getItem(KEY)); return THEMES.some((t) => t.id === v) ? v : DEFAULT; } catch { return DEFAULT; } }
let current = stored();

function apply(id, save) {
  const t = byId(id); current = t.id;
  const root = document.documentElement;
  root.setAttribute('data-theme', t.id);
  let m = document.querySelector('meta[name=theme-color]');
  if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); }
  m.setAttribute('content', t.bar);
  if (save) { try { localStorage.setItem(KEY, JSON.stringify(t.id)); } catch { /* stockage plein ou bloqué */ } }
  document.dispatchEvent(new CustomEvent('nexa-theme', { detail: t }));
  return t;
}

NEXA.themes = { list: THEMES, get current() { return byId(current); }, apply: (id) => apply(id, true), byId };
apply(current, false);

/* ---------- Sélecteur « Apparence » ---------- */
function previewHTML(t) {
  const p = t.p;
  return `<div class="th-prev" style="background:${p.bg}">
    <i style="left:8px;top:8px;width:46%;height:8px;border-radius:4px;background:${p.tx};opacity:.9"></i>
    <i style="left:8px;top:22px;width:30%;height:6px;border-radius:3px;background:${p.tx};opacity:.4"></i>
    <i style="left:8px;right:8px;bottom:8px;height:22px;border-radius:9px;background:${p.card};border:1px solid rgba(128,128,128,.28)"></i>
    <i style="right:14px;bottom:12px;width:14px;height:14px;border-radius:50%;background:${p.grad}"></i>
    <i style="right:8px;top:8px;width:28%;height:8px;border-radius:4px;background:${p.grad}"></i>
  </div>`;
}
function openPicker(c) {
  const card = (t) => `<button class="th-card${t.id === current ? ' on' : ''}" data-th="${t.id}" aria-pressed="${t.id === current}">
      ${previewHTML(t)}<b>${t.name}</b><span>${t.desc}</span><div class="th-ok">${c.icon('check')}</div></button>`;
  const cards = '<h3 class="th-h">Noir, blanc & bleus</h3><div class="th-grid">' + THEMES.filter((t) => t.sober).map(card).join('') +
    '</div><h3 class="th-h">Colorés</h3><div class="th-grid">' + THEMES.filter((t) => !t.sober).map(card).join('') + '</div>';
  c.openSheet(`<div class="sheet-title">Apparence</div><p class="s-msg">Touchez un thème pour l’appliquer tout de suite.</p>
    ${cards}<div class="s-row"><button class="btn" data-done>Terminé</button></div>`, (s) => {
    s.querySelectorAll('[data-th]').forEach((b) => { b.onclick = () => {
      apply(b.dataset.th, true);
      s.querySelectorAll('[data-th]').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
    }; });
    s.querySelector('[data-done]').onclick = () => { c.closeSheet(); c.refreshView(); };
  });
}

NEXA.defineModule((c) => { NEXA.actions.theme = () => openPicker(c); });
})(typeof window !== 'undefined' ? window : globalThis);
