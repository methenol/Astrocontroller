/**
 * The app shell. A phone shows one screen at a time and the bottom bar drives it; at desk widths
 * the live view is always up-left and the section stack sits on the right. Opening a tab sets the
 * .active classes, tells the screen to load its data ('tab'), and mirrors the result onto both
 * navs, <body data-screen>, the menus and the video subscription ('screen').
 */
import { $, $$, store } from './dom.js';
import { emit } from './bus.js';

const WIDE_MQ = window.matchMedia('(min-width: 1000px)');
const MORE_SCREENS = new Set(['database', 'library', 'skills', 'log']);
const KEYBOARD_SHRINK_PX = 60;
const COMPOSER_MAX_VH = 0.34;
const ORIENTATION_SETTLE_MS = 250;

export const isWide = () => WIDE_MQ.matches;
export const viewOnScreen = () => isWide() || $('#panel-view').classList.contains('active');
const screenName = () => ($$('.panel').find((p) => p.classList.contains('active') && p.id !== 'panel-view') || { id: 'panel-view' }).id.slice(6);

// At desk widths the live view is a fixed column that stays up whatever section is showing, and
// the View tab (bottom bar only) leaves the section alone.
function applyTabSelection(name) {
  const wide = isWide();
  for (const p of $$('.panel')) {
    if (p.id === 'panel-view') p.classList.toggle('active', name === 'view' || wide);
    else if (!(name === 'view' && wide)) p.classList.toggle('active', p.id === `panel-${name}`);
  }
}

function reflectScreen() {
  const name = screenName();
  document.body.dataset.screen = name;
  for (const t of $$('#tabbar .tab')) {
    t.classList.toggle('active', t.dataset.tab === name || (t.id === 'btn-more' && MORE_SCREENS.has(name)));
    t.setAttribute('aria-selected', String(t.dataset.tab === name));
  }
  for (const t of $$('.tabs-top .tab')) {
    t.classList.toggle('active', t.dataset.tab === name);
    t.setAttribute('aria-selected', String(t.dataset.tab === name));
  }
  for (const t of $$('.sheet-item')) t.classList.toggle('active', t.dataset.tab === name);
  if (name !== 'view') store.set('screen', name);
  emit('screen', name);
}

/** Opens a screen as if its tab was tapped (which loads its data). */
export function showScreen(name) {
  applyTabSelection(name);
  closeOverlays();
  emit('tab', name);
  reflectScreen();
}

function setMenu(open) {
  $('#menu').classList.toggle('open', open);
  $('#btn-menu').setAttribute('aria-expanded', String(open));
}
function setSheet(open) {
  $('#sheet-more').hidden = !open;
  $('#btn-more').setAttribute('aria-expanded', String(open));
}
function closeOverlays() {
  setMenu(false);
  setSheet(false);
}

for (const t of $$('.tab')) {
  // the More chip looks like a tab but opens a sheet
  if (t.dataset.tab) t.addEventListener('click', () => showScreen(t.dataset.tab));
}
$('#btn-menu').onclick = (e) => {
  e.stopPropagation();
  setSheet(false);
  setMenu(!$('#menu').classList.contains('open'));
};
// picking an action dismisses the popover: on a phone it covers the screen it came from
$('#menu').onclick = (e) => {
  if (e.target.closest('button')) setMenu(false);
};
$('#btn-more').onclick = (e) => {
  e.stopPropagation(); // the document handler closes overlays on any tap; this one owns the sheet
  const show = $('#sheet-more').hidden;
  closeOverlays();
  setSheet(show);
};
$('#sheet-more').onclick = (e) => {
  if (e.target.closest('[data-close]')) closeOverlays();
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#btn-menu, #menu')) setMenu(false);
});

// Night mode (red-on-black), remembered per browser.
$('#btn-night').onclick = () => {
  const on = document.body.classList.toggle('night');
  store.set('night', on ? '1' : '');
};
if (store.get('night')) document.body.classList.add('night');

// ---- the keyboard and the composer
const vv = window.visualViewport;
function fitViewport() {
  // iOS keeps the layout viewport full height when the keyboard opens, which would push the
  // composer under it; Chrome shrinks the layout viewport itself, so only correct the delta.
  const shrink = window.innerHeight - (vv ? vv.height : window.innerHeight);
  document.documentElement.style.setProperty('--vh', vv && shrink > KEYBOARD_SHRINK_PX ? `${Math.round(vv.height + vv.offsetTop)}px` : '');
}
if (vv) {
  vv.addEventListener('resize', fitViewport);
  vv.addEventListener('scroll', fitViewport);
}

/** Grows a textarea with its content, up to a third of the screen. */
export function grow(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight + 2, Math.round(window.innerHeight * COMPOSER_MAX_VH))}px`;
}

/** Opens the remembered screen (or a sensible one for the width). */
export function layoutBoot() {
  if (isWide()) for (const g of $$('.group')) g.open = true;
  const saved = store.get('screen');
  const remembered = saved && saved !== 'view' && document.getElementById(`panel-${saved}`) ? saved : null;
  if (isWide()) {
    if (screenName() === 'view') showScreen(remembered ?? 'chat');
    else reflectScreen();
  } else showScreen(remembered ?? 'view');
}
/** A width change or a rotation keeps the screen that is up (the remembered one is for a fresh load). */
function relayout() {
  const name = screenName();
  if (isWide()) {
    for (const g of $$('.group')) g.open = true;
    if (name === 'view') showScreen(store.get('screen') && document.getElementById(`panel-${store.get('screen')}`) ? store.get('screen') : 'chat');
    else showScreen(name);
  } else showScreen(name);
}
WIDE_MQ.addEventListener('change', relayout);
window.addEventListener('orientationchange', () => setTimeout(relayout, ORIENTATION_SETTLE_MS));
fitViewport();
