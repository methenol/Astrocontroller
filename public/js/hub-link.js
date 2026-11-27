/**
 * Inside the profile hub (this app in the hub's frame) the top bar carries the telescope switcher in
 * place of the brand. The hub draws the profile list over the frame and does the switching,
 * activating and deactivating; this side shows which profile is up and asks it to open the list.
 * Run on its own (no hub) nothing here shows.
 */
import { $ } from './dom.js';

const btn = $('#btn-profile');
const inFrame = window.parent !== window;
const night = () => document.body.classList.contains('night');
/** The profile this page is, from its own URL (/p/<id>/): never the hub's word for it. */
const myId = decodeURIComponent(location.pathname.match(/\/p\/([^/]+)\//)?.[1] ?? '');
const send = (msg) => window.parent.postMessage({ source: 'astro-app', id: myId, night: night(), ...msg }, location.origin);

function show(p) {
  $('#brand').hidden = true;
  btn.hidden = false;
  $('#btn-profiles').hidden = false;
  $('#btn-profiles-menu').hidden = false;
  $('#profile-name').textContent = p.name;
  $('#profile-sub').textContent = p.sub ?? '';
  $('#profile-dot').className = `pdot ${p.phase ?? ''}`;
  btn.title = `${p.name}: switch telescope`;
  btn.setAttribute('aria-label', `Telescope: ${p.name}. Switch telescope`);
}

if (inFrame && btn) {
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== location.origin || e.data?.source !== 'astro-hub') return;
    if (e.data.type === 'profile') {
      // the hub has moved on to another profile while this page is still in its frame (the new one
      // not loaded yet, or stalled): wearing that name would pass this telescope's UI off as the other's
      // (2026-11-26: the Dwarf 3's SD-card sessions under the Dwarf Mini's name)
      if (myId && e.data.id && e.data.id !== myId) return send({ type: 'stale' });
      show(e.data);
    }
    else if (e.data.type === 'switcher-closed') {
      btn.setAttribute('aria-expanded', 'false');
      if (e.data.refocus) btn.focus();
    }
  });
  btn.onclick = () => {
    const r = btn.getBoundingClientRect();
    btn.setAttribute('aria-expanded', 'true');
    send({ type: 'open-switcher', rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
  };
  const manage = () => send({ type: 'manage' });
  $('#btn-profiles').onclick = manage;
  $('#btn-profiles-menu').onclick = manage;
  send({ type: 'hello' });
}
