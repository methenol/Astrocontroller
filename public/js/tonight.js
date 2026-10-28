/** Tonight: sky conditions, the observing plan and the weather forecast. */
import { $, esc, toast } from './dom.js';
import { api, apiToast } from './api.js';
import { on } from './bus.js';
import { draft } from './chat.js';
import { temp, delta, speedN, speedUnit, precip, precipUnit } from './units.js';
import { loadHorizon, onHorizonChange } from './horizon.js';

const DARK_SUN_ALT = -18;
const SKY_OK = 60;
const SKY_WARN = 35;
const RAIN_HIGH = 50;
const RAIN_MID = 25;
const WEATHER_FIRST_MS = 1500;
// Polled faster than the server refetches the forecast (15 min): such a poll is a cache hit and
// costs nothing upstream, and a refresh that failed is tried again within five minutes.
const WEATHER_POLL_MS = 5 * 60 * 1000;

export const imagingRequest = (name) => `Plan and capture ${name} tonight: check visibility and conditions, choose filter/exposure/gain, then calibrate, GoTo, focus and start live stacking. Keep me posted on progress.`;

// a reply to an older request must not overwrite a newer one (fast tab switches, filter changes)
let conditionsSeq = 0;
let planSeq = 0;

async function loadConditions() {
  const el = $('#conditions');
  const mine = ++conditionsSeq;
  try {
    const c = await api('conditions');
    if (mine !== conditionsSeq) return;
    const sun = c.sunAltitude;
    const moon = c.moon ?? {};
    const night = c.night ?? {};
    el.innerHTML = `<h3>Conditions</h3>
      <div class="status-grid">
        <div><span>Sun altitude</span>${esc(sun)}° ${sun < DARK_SUN_ALT ? '(dark)' : sun < 0 ? '(twilight)' : '(day)'}</div>
        <div><span>Sunset</span>${esc(night.sunset ?? '–')}</div>
        <div><span>Astro dusk</span>${esc(night.astroDusk ?? '–')}</div>
        <div><span>Astro dawn</span>${esc(night.astroDawn ?? '–')}</div>
        <div><span>Moon</span>${esc(moon.illuminationPercent)}% ${esc(moon.phase)}</div>
        <div><span>Moon now</span>${moon.altitude > 0 ? `up, alt ${esc(moon.altitude)}°` : 'below horizon'}</div>
      </div>`;
  } catch (e) {
    if (mine === conditionsSeq) el.innerHTML = `<span class="muted">${esc(e.message)}</span>`;
  }
}

const skyCls = (q) => (q == null ? '' : q >= SKY_OK ? 'ok' : q >= SKY_WARN ? 'warn' : 'bad');

/** What the sky and the glass say about this target, as the one word the user scans for. */
function verdictTag(t) {
  if (t.gated) {
    return t.detectBucket === 'SKIP_TONIGHT'
      ? `<span class="badge failed" title="${esc(t.gateReason ?? '')}">beyond tonight's sky</span>`
      : `<span class="badge waiting" title="${esc(t.gateReason ?? '')}">poor fit</span>`;
  }
  if (t.detectBucket === 'EASY') return '<span class="badge done" title="the sky brings this up on its own">easy</span>';
  if (t.detectBucket === 'NEEDS_INTEG') return `<span class="badge waiting" title="${esc(t.detectReason ?? '')}">needs time</span>`;
  return '';
}

function planRow(t) {
  const names = [t.name, ...(t.aliases ?? [])].filter((a, i, arr) => a && arr.indexOf(a) === i).slice(0, 3);
  const filter = String(t.suggestedFilter ?? '').split(' (')[0];
  const sky = t.skyAtBest != null ? ` · <span class="sky ${skyCls(t.skyAtBest)}">sky ${esc(t.skyAtBest)}</span>` : '';
  const weather = t.weatherAlignment != null
    ? `<b class="sky ${skyCls(t.weatherAlignment)}">${esc(t.weatherAlignment)}/100</b><small>${esc(t.clearHours)} clear / ${esc(t.hoursAboveMin)} h up</small>`
    : `${esc(t.hoursAboveMin)} h`;
  // The best run that is simultaneously up, forecast-clear and moon-workable — the hours to actually point at.
  const clear = t.bestClearMinutes >= 5 && t.bestClearFrom
    ? `<small title="the longest run simultaneously up, forecast-clear and moon-workable">clear ${esc(t.bestClearFrom)}–${esc(t.bestClearUntil)} (${esc(t.bestClearMinutes)} min)</small>`
    : '';
  const range = Array.isArray(t.subRangeSeconds) ? `${t.subRangeSeconds[0]}–${t.subRangeSeconds[1]}s` : `${t.subSeconds}s`;
  const sub = (t.subSeconds != null || Array.isArray(t.subRangeSeconds)) && t.exposureAdvice
    ? `<small title="${esc(t.exposureAdvice)}">${esc(range)} × ${esc(t.subs ?? '–')} subs</small>`
    : '';
  const behind = t.obstructedNow ? ` <span class="badge waiting" title="above the minimum altitude, but behind the site's mapped obstructions right now (az ${esc(t.azimuthNow)}°, alt ${esc(t.altitudeNow)}°)">behind obstruction now</span>` : '';
  return `<tr${t.gated ? ' class="gated"' : ''}><td><b>${esc(t.displayName ?? t.name)}</b> ${verdictTag(t)}${behind}<small>${esc(names.join(' · '))}</small><small>${esc(t.type)}, ${esc(t.sizeArcmin)}′, mag ${esc(t.magnitude ?? '–')}</small>${t.gated && t.gateReason ? `<small>${esc(t.gateReason)}</small>` : ''}</td>
    <td data-label="Best time">${esc(t.bestTime ?? '')}<small>max ${esc(t.maxAltitude)}°${sky}</small>${clear}</td>
    <td data-label="${t.weatherAlignment != null ? 'Weather' : 'Hours above minimum'}">${weather}</td>
    <td data-label="Framing &amp; filter"><small>${esc(t.framing)}</small><small>${esc(filter)}</small>${sub}</td>
    <td><button class="ghost" data-image="${esc(t.gotoName ?? t.name)}">Image</button><button class="ghost" data-sky="${esc(t.gotoName ?? t.name)}" data-display="${esc(t.displayName ?? t.name)}" data-ra="${esc(t.raHours ?? '')}" data-dec="${esc(t.decDeg ?? '')}" title="Show it in the Stellarium tab">Sky</button></td></tr>`;
}

async function loadPlan() {
  const el = $('#plan');
  el.textContent = 'planning…';
  const mine = ++planSeq;
  try {
    const type = $('#sel-plan-type').value;
    const fov = $('#sel-plan-fov').value;
    const p = new URLSearchParams();
    if (type) p.set('types', type);
    if (fov) p.set('minFovPercent', fov);
    const qs = p.toString();
    const r = await api(`plan${qs ? `?${qs}` : ''}`);
    if (mine !== planSeq) return;
    const targets = Array.isArray(r.targets) ? r.targets : [];
    const wx = targets.some((t) => t.weatherAlignment != null);
    const hoursTitle = wx ? `weather = forecast quality during the target\'s own best hours (weighted toward its peak); clear / up = forecast-weighted hours / hours above the minimum altitude` : 'hours above the minimum altitude';
    const sizeFilter = fov ? ` · fills ≥${esc(fov)}% of the tele frame` : '';
    const skyGlass = r.sky ? ` · Bortle ${esc(r.sky.bortle)} (SQM ${esc(r.sky.sqm)}) · ${esc(r.sky.filter === 'none' ? 'no filter' : r.sky.filter)}` : '';
    // The one thing to start with, and the season the list was read off. When every row is gated
    // there is no hero, and saying so is more use than quietly printing the best of the bad.
    const hero = r.hero
      ? `<p class="plan-hero">Start with <b>${esc(r.hero)}</b>${r.season?.label && r.season.label !== '—' ? ` <span class="muted">— ${esc(r.season.label)}</span>` : ''}</p>`
      : `<p class="plan-hero muted">${targets.length ? 'Nothing here is shootable as it stands — each row says why.' : 'No targets match this filter.'}</p>`;
    const resting = Array.isArray(r.resting) && r.resting.length
      ? `<p class="muted small">Held back by memory: ${r.resting.map((x) => `<b>${esc(x.displayName ?? x.name)}</b> (${esc(x.reason)})`).join(' · ')}</p>`
      : '';
    el.innerHTML = `${hero}
      <p class="muted small">${esc(r.window?.start)} → ${esc(r.window?.end)} (${esc(r.window?.hours)} h) · min altitude ${esc(r.minAltitude)}°${r.horizon ? ' + site obstructions' : ''}${sizeFilter} · Moon ${esc(r.moon?.illuminationPercent)}%${skyGlass} · ${esc(r.weather ?? '')}</p>
      <table class="plan-table"><tr><th>Target</th><th>Best</th><th title="${esc(hoursTitle)}">${wx ? 'Weather' : 'Hours'}</th><th>Fit / filter</th><th></th></tr>
      ${targets.map(planRow).join('')}</table>${resting}`;
  } catch (e) {
    if (mine === planSeq) el.innerHTML = `<span class="muted">${esc(e.message)}</span>`;
  }
}

async function loadRestSettings() {
  try {
    const r = await api('rest/settings');
    // a field being edited keeps what the user is typing
    if (document.activeElement !== $('#rest-goal')) $('#rest-goal').value = r.integrationTargetMin;
    if (document.activeElement !== $('#rest-days')) $('#rest-days').value = r.restDays;
  } catch (e) {
    toast(`Target rest: ${e.message}`, true);
  }
}

async function saveRestSettings(e) {
  const goal = Number($('#rest-goal').value);
  const days = Number($('#rest-days').value);
  if (!Number.isFinite(goal) || goal < 0 || !Number.isInteger(days) || days < 1) {
    toast('Integration goal must be 0 or more minutes and the rest a whole number of days (1 or more)', true);
    return loadRestSettings();
  }
  const r = await apiToast('rest/settings', e.target.id === 'rest-goal' ? { integrationTargetMin: goal } : { restDays: days });
  if (r) {
    toast(e.target.id === 'rest-goal' ? `Integration goal: ${r.integrationTargetMin} min` : `Rest: ${r.restDays} days`);
    loadPlan();
  }
}

export function loadTonight() {
  loadConditions();
  loadPlan();
  loadHorizon();
  loadRestSettings();
}
// a new or cleared obstruction map changes what the plan can offer
onHorizonChange(loadPlan);
$('#sel-plan-type').onchange = loadPlan;
$('#sel-plan-fov').onchange = loadPlan;
$('#rest-goal').onchange = saveRestSettings;
$('#rest-days').onchange = saveRestSettings;
$('#plan').addEventListener('click', (e) => {
  const b = e.target.closest('[data-image]');
  if (b) draft(imagingRequest(b.dataset.image));
});

// The last forecast that rendered. A failed refresh must not blank the card: the server holds the
// last forecast it fetched and serves it flagged stale, and if even that is gone the numbers on
// screen stay there, with the reason for the failure next to them.
let wxLast = null;
// the server's Rating values, which the stylesheet colours
const RATINGS = new Set(['excellent', 'good', 'fair', 'poor']);

function wxHour(h) {
  const rain = h.precipProbability ?? 0;
  const mm = typeof h.precipMm === 'number' ? h.precipMm : 0;
  const issues = Array.isArray(h.issues) ? h.issues : [];
  const title = `${h.local}: ${issues.join('; ') || 'clear'}${h.seeing ? ` · seeing ${h.seeing}, transparency ${h.transparency}` : ''}`;
  const rating = RATINGS.has(h.rating) ? h.rating : '';
  return `<div class="wx-h ${rating}" title="${esc(title)}">
    <div>${esc(String(h.local ?? '').split(', ')[1] ?? h.local)}</div><div class="sc">${esc(h.score)}</div><div>☁${esc(h.cloudTotal)}</div><div class="rain ${rain >= RAIN_HIGH ? 'high' : rain >= RAIN_MID ? 'mid' : ''}" title="${esc(`rain chance ${rain}% · expected ${precip(mm)}`)}">🌧${esc(rain)}%${mm >= 0.1 ? `<br>${esc(precip(mm, 1).replace(' ', ''))}` : ''}</div><div>💧${esc(delta(h.dewSpreadC))}</div><div>🌬${esc(speedN(h.gustKmh ?? 0))}</div></div>`;
}

function renderWeather(w, refreshError) {
  const c = w.current ?? {};
  const issues = Array.isArray(w.commonIssues) ? w.commonIssues : [];
  // one amber note says it all: a reload that just failed is the fresher fact
  const age = w.stale ? `<span class="wx-age"> · cached ${esc(w.ageMin)} min ago${w.staleError && !refreshError ? ' — the refresh since has failed' : ''}</span>` : '';
  const why = refreshError ? `<span class="wx-age"> · not reloaded: ${esc(refreshError)}</span>` : '';
  $('#chip-wx').textContent = `☁ ${c.cloudCover ?? '–'}% · tonight ${w.averageScore ?? '–'}/100`;
  $('#chip-wx').title = w.verdict ?? '';
  $('#weather').innerHTML = `<h3>Weather & observability</h3>
    <div class="wx-verdict">${esc(w.verdict)}</div>
    <div class="muted small">now: ${esc(c.cloudCover)}% cloud · ${esc(temp(c.temperatureC))} · RH ${esc(c.humidity)}% · dew point ${esc(temp(c.dewPointC))} · wind ${esc(speedN(c.windKmh))}/${esc(speedN(c.gustKmh))} ${esc(speedUnit())}${issues.length ? ` · watch: ${esc(issues.slice(0, 4).join(', '))}` : ''}${age}${why}</div>
    <div class="wx-strip">${(Array.isArray(w.hours) ? w.hours : []).map(wxHour).join('')}</div>
    <div class="muted small">score 0–100 · ☁ cloud % · 🌧 rain chance (and ${esc(precipUnit())} expected) · 💧 dew-point spread · 🌬 gusts ${esc(speedUnit())} · Open-Meteo + 7Timer</div>`;
}

let wxBusy = false;
export async function loadWeather() {
  // the poll and a tab switch can both ask: one request at a time is enough
  if (wxBusy) return;
  wxBusy = true;
  try {
    const w = await api('weather');
    wxLast = w;
    renderWeather(w);
  } catch (e) {
    // only when the server has no forecast at all: keep what is up, and say it is not current
    if (wxLast) renderWeather(wxLast, e.message);
    else $('#weather').innerHTML = `<span class="muted">weather unavailable: ${esc(e.message)}</span>`;
  } finally {
    wxBusy = false;
  }
}

on('tab', (name) => {
  if (name !== 'tonight') return;
  loadTonight();
  loadWeather();
});

export function startWeather() {
  setTimeout(loadWeather, WEATHER_FIRST_MS);
  setInterval(loadWeather, WEATHER_POLL_MS);
}

