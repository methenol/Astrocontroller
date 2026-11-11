/**
 * The Research tab: browse the target packages the agent writes (workspace/research/*.md, see the
 * target-research skill), search them by name or designation, and read one with its reference
 * images. The server does the matching, catalog aliases included ("Triangulum" finds M-33).
 */
import { $, $$, esc, md, lightbox, store, toast } from './dom.js';
import { api, seg } from './api.js';
import { on } from './bus.js';

const SEARCH_DEBOUNCE_MS = 150;
let current = store.get('research') || null;
let seq = 0;
let timer = 0;

const fmtDate = (e) => e.date || new Date(e.updatedAt).toISOString().slice(0, 10);

async function loadList() {
  const q = $('#rs-q').value.trim();
  const my = ++seq;
  try {
    const list = await api(`research${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (my !== seq) return; // a newer search answered first
    const items = Array.isArray(list) ? list : [];
    $('#rs-count').textContent = q ? `${items.length} match${items.length === 1 ? '' : 'es'} for “${q}”` : `${items.length} package${items.length === 1 ? '' : 's'}`;
    $('#rs-list').innerHTML =
      items
        .map(
          (e) =>
            `<li data-research-doc="${esc(e.name)}" class="${e.name === current ? 'active' : ''}" tabindex="0">${e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy">` : '<span class="rs-noimg" aria-hidden="true"></span>'}<span class="rs-text"><b>${esc(e.title)}</b><small>${esc(fmtDate(e))}${e.aliases.length ? ` · ${esc(e.aliases.slice(0, 4).join(' · '))}` : ''}</small></span></li>`,
        )
        .join('') || `<li class="muted">${q ? 'no package matches that name' : 'no research yet: press Research on a target and the agent writes one'}</li>`;
    if (current && !$('#rs-doc .rs-body') && items.some((e) => e.name === current)) openDoc(current);
  } catch (e) {
    if (my === seq) toast(`Research: ${e.message}`, true);
  }
}

async function openDoc(name) {
  try {
    const d = await api(`research/${seg(name)}`);
    current = name;
    store.set('research', name);
    $('#rs-doc').innerHTML = `<div class="row-head"><span class="muted small">research/${esc(name)}.md · ${esc(fmtDate(d))}</span><span class="spacer"></span><button type="button" class="ghost mini" id="rs-close" aria-label="Back to the list">✕</button></div><div class="rs-body">${md(d.content ?? '')}</div>`;
    $('#rs-doc').scrollTop = 0;
    for (const li of $$('#rs-list li')) li.classList.toggle('active', li.dataset.researchDoc === name);
    $('.research-layout').classList.add('reading');
  } catch (e) {
    // a package that was removed since: forget it rather than toasting on every visit
    if (current === name) {
      current = null;
      store.set('research', '');
    }
    toast(`Research: ${e.message}`, true);
  }
}

function closeDoc() {
  $('.research-layout').classList.remove('reading');
}

$('#rs-q').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(loadList, SEARCH_DEBOUNCE_MS);
});
$('#rs-list').addEventListener('click', (e) => {
  const li = e.target.closest('[data-research-doc]');
  if (li) openDoc(li.dataset.researchDoc);
});
$('#rs-list').addEventListener('keydown', (e) => {
  const li = e.target.closest('[data-research-doc]');
  if (li && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openDoc(li.dataset.researchDoc);
  }
});
$('#rs-doc').addEventListener('click', (e) => {
  if (e.target.closest('#rs-close')) return closeDoc();
  const img = e.target.closest('.rs-body img');
  if (img) lightbox(img.src, img.alt);
});

on('tab', (name) => {
  if (name === 'research') loadList();
});
