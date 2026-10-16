/** DOM and formatting helpers shared by every screen. */
import { isSafeUrl } from './safe-url.js';

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escapes anything for HTML text or a quoted attribute; null and undefined become ''. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** "1h 5m", "3m 20s", "12s"; "–" for null. Rounded to whole units first, so 119.7 s is "2m 0s", never "1m 60s". */
export function fmtDur(s) {
  if (s == null || !Number.isFinite(s)) return '–';
  const secs = Math.max(0, Math.round(s));
  if (secs >= 3600) {
    const mins = Math.round(secs / 60);
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
}
/** Milliseconds as "12s" or "3m 4s". */
export const fmtSecs = (ms) => {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
};
/** "21:05" in the browser's locale; '' for nothing. */
export const fmtClock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
/** The time part of the server's "Mon 12 Oct, 21:05" labels. */
export const timePart = (label) => String(label ?? '').split(', ').pop();
/** A number to `d` decimals, or a dash. */
export const fixed = (n, d, dash = '–') => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : dash);

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch { /* not remembered */ }
  },
};

const TOAST_MS = 2500;
const TOAST_ERROR_MS = 6000;
let toastTimer;
export function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${err ? ' err' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? TOAST_ERROR_MS : TOAST_MS);
}

export function lightbox(src, caption = '') {
  const lb = $('#lightbox');
  $('img', lb).src = src;
  $('.lb-caption', lb).textContent = caption;
  lb.hidden = false;
}
export const lightboxOpen = () => !$('#lightbox').hidden;
export const closeLightbox = () => ($('#lightbox').hidden = true);
$('#lightbox').onclick = closeLightbox;

let markedReady = false;
/** Markdown from the model; raw HTML in it is shown as text, never rendered. */
export function md(text) {
  const marked = window.marked;
  if (!marked) return `<p>${esc(text)}</p>`;
  if (!markedReady) {
    marked.use({
      renderer: { html: (t) => esc(t.text ?? t.raw ?? '') },
      // marked keeps any scheme: a javascript: or data: link from the model must never become clickable
      walkTokens: (t) => {
        if ((t.type === 'link' || t.type === 'image') && !isSafeUrl(t.href)) t.href = '#';
      },
    });
    markedReady = true;
  }
  return marked.parse(text, { breaks: true, gfm: true });
}

/** Disables `btn` (with a busy look) while `fn` runs. */
export async function busy(btn, fn) {
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}

/** The file name of a path. */
export const baseName = (p) => String(p ?? '').split('/').pop();
