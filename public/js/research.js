/**
 * Research: "I see something interesting, or do not know what this is". Any [data-research] button
 * (Database, Plan, Tonight, Stellarium) asks the agent for a target package: what it is, its
 * discovery and history, reference images, when it is up tonight and through the year, and the
 * filter, gain and sub length to collect it with on this telescope. Sent straight away; while the
 * agent is busy it waits for the turn to end, so a duty in progress is not interrupted.
 */
import { toast } from './dom.js';
import { api } from './api.js';
import { showScreen } from './shell.js';

const fmtRa = (h) => {
  const s = Math.round((((h % 24) + 24) % 24) * 3600);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m${String(s % 60).padStart(2, '0')}s`;
};
const fmtDec = (d) => {
  const s = Math.round(Math.abs(d) * 3600);
  return `${d < 0 ? '−' : '+'}${String(Math.floor(s / 3600)).padStart(2, '0')}°${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}′${String(s % 60).padStart(2, '0')}″`;
};

/** The request: a name, a position, or both (a position alone for a spot picked on the sky map). */
export function researchRequest({ name, display, raHours, decDeg }) {
  const pos = Number.isFinite(raHours) && Number.isFinite(decDeg) ? `RA ${fmtRa(raHours)} Dec ${fmtDec(decDeg)} (J2000)` : '';
  const label = name ? `${display && display !== name ? `${display} (${name})` : name}${pos ? ` at ${pos}` : ''}` : `the object at ${pos}`;
  const coords = !name && pos ? ` Use ra_hours=${raHours.toFixed(5)} dec_deg=${decDeg.toFixed(4)} with the tools.` : '';
  return `Read the target-research skill then research ${label} and put together a target package (you MUST read the target-research skill): what it is, when and by whom it was discovered and its history, reference imagery (a survey plate framed to this scope and the best published photo), when it is up tonight and through the year (seasonality), and the filter, gain, sub length and integration you recommend for this telescope. Respond with the full report and images embedded, not a summary of the report. This is a look-up: do not move the telescope or change the program.${coords}`;
}

let sending = false;
export async function askResearch(target, btn) {
  if (sending) return;
  if (!target.name && !(Number.isFinite(target.raHours) && Number.isFinite(target.decDeg))) return toast('Nothing to research: no name or position', true);
  sending = true;
  btn?.classList.add('busy');
  if (btn) btn.disabled = true;
  try {
    await api('agent/prompt', { text: researchRequest(target), images: [], mode: 'followUp' });
    toast(`Researching ${target.display || target.name || 'the selection'}: the package arrives in the chat`);
    showScreen('chat');
  } catch (e) {
    toast(`Research: ${e.message}`, true);
  } finally {
    sending = false;
    btn?.classList.remove('busy');
    if (btn) btn.disabled = false;
  }
}

const num = (v) => (v === undefined || v === '' ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);

// every [data-research] button carries the name, and the position when it has one
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-research]');
  if (!b) return;
  e.preventDefault();
  askResearch({ name: b.dataset.research || '', display: b.dataset.display || '', raHours: num(b.dataset.ra), decDeg: num(b.dataset.dec) }, b);
});
