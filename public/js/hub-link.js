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
const send = (msg) => window.parent.postMessage({ source: 'astro-app', night: night(), ...msg }, location.origin);

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
    if (e.data.type === 'profile') show(e.data);
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
