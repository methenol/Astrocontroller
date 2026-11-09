/**
 * Plan: tonight's schedule (blocks from the plan's start to its end, with the sky, the Moon and
 * each target's altitude under them), what to do now, the owner's program with its progress, the
 * holds of the night, and the plan settings. The server solves the plan (night/solver.ts) and
 * keeps it fresh; this screen shows it and edits what it is solved from.
 */
import { $, esc, toast, busy } from './dom.js';
import { api, apiToast, seg } from './api.js';
import { on } from './bus.js';
import { state, isPanelActive } from './state.js';
import { draft } from './chat.js';
import { imagingRequest } from './tonight.js';

const SLOT_MS = 10 * 60e3;
const RESIZE_MS = 150;
const RELOAD_MS = 1500;
const SEARCH_MS = 250;
const NOW_TICK_MS = 60e3;
const PRIORITIES = { 1: 'low', 2: 'below normal', 3: 'normal', 4: 'high', 5: 'top' };
const STATUS = {
  scheduled: ['done', 'tonight'],
  complete: ['done', 'goal met'],
  'not-up': ['', 'not up'],
  moon: ['waiting', 'Moon'],
  weather: ['waiting', 'weather'],
  held: ['waiting', 'held'],
  outcompeted: ['', 'not tonight'],
  disabled: ['', 'off'],
  waiting: ['', 'waiting'],
};

let last = null; // { plan, now, duty }
let program = [];
let selected = null; // block id
let seq = 0;

const tz = () => state.config?.observer?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
const hm = (t) => (t == null ? '–' : new Intl.DateTimeFormat('en-GB', { timeZone: tz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t));
const dur = (min) => {
  const m = Math.max(0, Math.round(min ?? 0));
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
};
const hours = (min) => `${Math.round((min / 60) * 10) / 10} h`;

/** A stable colour per target: the same target is the same colour on every night. */
function hue(key) {
  let h = 0;
  for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
const colour = (key, source) => (source === 'filler' ? `hsl(${hue(key)} 25% 55%)` : `hsl(${hue(key)} 70% 60%)`);
/** The Tonight tab's one-word verdict on what tonight's sky and glass make of a target. */
function verdict(bucket, reason) {
  if (bucket === 'EASY') return `<span class="badge done" title="${esc(reason ?? 'the sky brings this up on its own')}">easy</span>`;
  if (bucket === 'NEEDS_INTEG') return `<span class="badge waiting" title="${esc(reason ?? '')}">needs time</span>`;
  if (bucket === 'SKIP_TONIGHT') return `<span class="badge failed" title="${esc(reason ?? '')}">beyond tonight's sky</span>`;
  return '';
}
const subLine = (subS, range, subs) => (subS == null && !Array.isArray(range) ? '' : `${Array.isArray(range) ? `${range[0]}–${range[1]}` : subS}s × ${subs ?? '–'} subs`);
/** The acquisition planner's capture settings for a block: what to shoot with, the headroom, and why. */
function captureLine(a) {
  const head = `${a.filter} · gain ${a.gain} · ${a.subS}s × ${a.frames}`;
  const room = `sky ${a.backgroundPct}% of range${a.coreClips ? ' · core clips' : ''} · stars clip from mag ${a.starSaturationMag}${a.swamp != null ? ` · swamp ${a.swamp}× of ${a.swampWanted}, efficiency ${a.efficiencyPct}%` : ''}`;
  return `<div class="small"><b>Capture:</b> ${esc(head)} <span class="muted">(${esc(room)}; ${esc(a.hoursToGood)} h to a clean picture)</span></div>
      <div class="small muted">${esc(a.line)}</div>`;
}
const skyColour = (s) => (s == null ? '#1a2436' : s >= 60 ? '#14532d' : s >= 35 ? '#713f12' : '#7f1d1d');

// ---------------------------------------------------------------- loading

export async function loadPlan(replan = false) {
  const mine = ++seq;
  try {
    const r = replan ? await api('plan/replan', {}) : await api('plan/tonight');
    if (mine !== seq) return;
    last = { ...last, ...r, duty: r.duty ?? last?.duty ?? state.duty };
    render();
  } catch (e) {
    if (mine === seq) $('#np-head').innerHTML = `<span class="muted">${esc(e.message)}</span>`;
  }
  loadProgram();
}

async function loadProgram() {
  try {
    program = await api('plan/program');
    renderProgram();
  } catch (e) {
    $('#np-program').innerHTML = `<span class="muted">${esc(e.message)}</span>`;
  }
}

function render() {
  if (!last?.plan) return;
  renderHead();
  renderTimeline();
  renderDetail();
  renderHolds();
}

// ---------------------------------------------------------------- the head: the night, now, the duty

function renderHead() {
  const p = last.plan;
  const n = last.now;
  const duty = state.duty ?? last.duty;
  const onDuty = duty?.status === 'active';
  const running = onDuty && /night plan/i.test(duty?.objective ?? '');
  const t = p.totals;
  const l = p.learned;
  const notes = (p.notes ?? []).map((x) => `<div class="muted small">${esc(x)}</div>`).join('');
  $('#np-head').innerHTML = `
    <div class="row-head">
      <h3>Night of ${esc(p.night)}</h3>
      <span class="muted small">${esc(hm(p.window.start))} → ${esc(hm(p.window.end))} · Moon ${esc(p.moon.illumPct)}% ${esc(p.moon.phase)}</span>
      <span class="spacer"></span>
      <button type="button" class="ghost" id="np-replan" title="Solve the rest of the night again now">Re-plan</button>
      <button type="button" class="${running ? 'ghost' : 'primary'}" id="np-run" ${onDuty ? 'disabled' : ''} title="${onDuty ? `A duty is on: ${esc((duty.objective ?? '').split('\n')[0])}` : "Put the agent on duty to carry out tonight's plan until its end"}">${running ? 'Plan running' : onDuty ? 'Duty on' : 'Run tonight’s plan'}</button>
    </div>
    <div class="np-now ${n?.onPlan === false ? 'off' : ''}">${esc(n?.instruction ?? '')}</div>
    <div class="stack-stats">
      <span>program <b>${esc(dur(t.programMin))}</b></span>
      <span>fillers <b>${esc(dur(t.fillerMin))}</b></span>
      ${t.weatherMin ? `<span>weather-out <b>${esc(dur(t.weatherMin))}</b></span>` : ''}
      ${t.gapMin ? `<span>idle <b>${esc(dur(t.gapMin))}</b></span>` : ''}
      <span title="minutes a switch costs (GoTo, centring, focus), and the share of stacking time that becomes integration: ${l.samples ? `learned from ${l.samples} journal sessions` : 'defaults until the journal has enough sessions'}">switch ${esc(l.overheadMin)} min (${esc(l.overheadSource)}) · efficiency ${esc(Math.round(l.efficiency * 100))}% (${esc(l.efficiencySource)})</span>
      <span>solved ${esc(hm(p.generatedAt))} — ${esc(p.reason)}</span>
      ${p.forecast?.stale ? '<span class="stale">forecast cached (stale)</span>' : ''}
    </div>
    ${p.horizon ? `<div class="muted small">${esc(p.horizon)}</div>` : '<div class="muted small">no obstruction map: minimum altitude only (map_obstructions makes one)</div>'}
    ${notes}`;
  $('#np-replan').onclick = (e) => busy(e.target, () => loadPlan(true));
  $('#np-run').onclick = async (e) => {
    if (!confirm("Put the agent on duty to carry out tonight's plan until its end?")) return;
    const r = await busy(e.target, () => apiToast('plan/run', {}));
    if (r) toast('On duty: following the night plan');
  };
}

// ---------------------------------------------------------------- the timeline

const ROW = { axis: 18, sky: 12, moon: 8, gap: 6, blocks: 36, chart: 120 };

/** The timeline's time scale as last drawn (for dragging a block's edges). */
let scale = null;
/** A block being dragged by an edge (resize) or by its body (move): { id, edge: 'start' | 'end' | 'move', start, end, moved } */
let drag = null;

function renderTimeline() {
  if (drag) return; // the drag redraws its own block; the plan is drawn again when it lets go
  const p = last.plan;
  const el = $('#np-timeline');
  const W = Math.max(320, el.clientWidth || 600);
  const pad = { l: 30, r: 8 };
  const t0 = p.window.start;
  const t1 = p.window.end;
  const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const yAxis = 0;
  const ySky = yAxis + ROW.axis;
  const yMoon = ySky + ROW.sky + 2;
  const yBlocks = yMoon + ROW.moon + ROW.gap;
  const yChart = yBlocks + ROW.blocks + ROW.gap + 4;
  const H = yChart + ROW.chart + 14;
  const altY = (a) => yChart + ROW.chart - (Math.max(0, Math.min(90, a)) / 90) * ROW.chart;
  const parts = [];
  // hour ticks
  const first = Math.ceil(t0 / 3600e3) * 3600e3;
  for (let t = first; t <= t1; t += 3600e3) {
    parts.push(`<line class="np-grid" x1="${x(t)}" x2="${x(t)}" y1="${ySky}" y2="${H - 12}"/>`);
    parts.push(`<text class="np-tick" x="${x(t)}" y="${yAxis + 12}" text-anchor="middle">${esc(hm(t).slice(0, 2))}</text>`);
  }
  // the forecast and the Moon, slot by slot
  for (const s of p.slots) {
    const a = x(Math.max(s.t, t0));
    const b = x(Math.min(s.t + SLOT_MS, t1));
    parts.push(`<rect x="${a}" y="${ySky}" width="${Math.max(0.5, b - a)}" height="${ROW.sky}" fill="${skyColour(s.sky)}"><title>${esc(hm(s.t))}: ${s.sky == null ? 'no forecast' : `sky ${s.sky}/100`}${s.temperatureC != null ? `, ${s.temperatureC} °C` : ''}</title></rect>`);
    if (s.moonAlt > 0) parts.push(`<rect x="${a}" y="${yMoon}" width="${Math.max(0.5, b - a)}" height="${ROW.moon}" fill="#e5e7eb" opacity="${(0.15 + 0.6 * (p.moon.illumPct / 100)) * Math.min(1, s.moonAlt / 30 + 0.3)}"><title>${esc(hm(s.t))}: Moon up, alt ${s.moonAlt}°</title></rect>`);
  }
  parts.push(`<text class="np-lbl" x="2" y="${ySky + 10}">sky</text><text class="np-lbl" x="2" y="${yMoon + 8}">moon</text>`);
  // the blocks
  for (const b of p.blocks) {
    const a = x(b.start);
    const w = Math.max(1, x(b.end) - a);
    const cls = `np-block ${b.kind}${b.past ? ' past' : ''}${b.id === selected ? ' sel' : ''}${b.target?.source === 'filler' ? ' filler' : ''}${b.pinned ? ' pinned' : ''}`;
    const fill = b.kind === 'target' ? colour(b.target.key, b.target.source) : b.kind === 'weather' ? 'url(#np-hatch)' : '#111827';
    const label = b.kind === 'target' ? b.target.displayName : b.kind === 'weather' ? 'cloud' : '';
    const title = b.kind === 'target' ? `${b.target.displayName} ${hm(b.start)}–${hm(b.end)}${b.pinned ? ' (pinned)' : ''}: ~${b.expectedMin} min${b.clouds ? ` (clouds forecast ${b.clouds.sky}/100: advisory, check the sky)` : ''}` : `${hm(b.start)}–${hm(b.end)}: ${b.reason}`;
    // the forecast's cloudy slots shaded grey over the block: the target stays planned in case the sky is better than forecast
    const shade = b.kind === 'target' && b.clouds
      ? p.slots.filter((s) => s.cloudy && s.t + SLOT_MS > b.start && s.t < b.end).map((s) => {
          const sa = x(Math.max(s.t, b.start));
          return `<rect x="${sa}" y="${yBlocks}" width="${Math.max(0.5, x(Math.min(s.t + SLOT_MS, b.end)) - sa)}" height="${ROW.blocks}" class="np-cloud"/>`;
        }).join('')
      : '';
    parts.push(`<g class="${cls}" data-block="${esc(b.id)}" tabindex="0" role="button" aria-label="${esc(title)}"><rect x="${a}" y="${yBlocks}" width="${w}" height="${ROW.blocks}" rx="5" fill="${fill}"/>${b.overheadMin && b.kind === 'target' ? `<rect x="${a}" y="${yBlocks}" width="${Math.min(w, x(b.start + b.overheadMin * 60e3) - a)}" height="${ROW.blocks}" rx="5" class="np-ovh"/>` : ''}${shade}${w > 36 ? `<text x="${a + 6}" y="${yBlocks + 15}" class="np-btext">${esc(label)}</text><text x="${a + 6}" y="${yBlocks + 29}" class="np-bsub">${b.kind === 'target' ? esc(`${hm(b.start)} · ${dur(b.expectedMin)}${b.pinned ? ' · pinned' : ''}`) : ''}</text>` : ''}<title>${esc(title)}</title></g>`);
  }
  // the selected target block's edges: drag them to pin it to a longer (or shorter) time
  const sb = p.blocks.find((b) => b.id === selected && b.kind === 'target' && !b.past);
  if (sb) {
    const hy = yBlocks - 3;
    const hh = ROW.blocks + 6;
    for (const edge of ['start', 'end']) {
      const ex = x(edge === 'start' ? Math.max(sb.start, Date.now()) : sb.end);
      const label = edge === 'start' ? `Drag to start ${sb.target.displayName} earlier or later` : `Drag to end ${sb.target.displayName} earlier or later`;
      parts.push(`<g class="np-handle" data-handle="${edge}" data-hblock="${esc(sb.id)}" tabindex="0" role="slider" aria-label="${esc(label)}" aria-valuetext="${esc(hm(edge === 'start' ? sb.start : sb.end))}"><rect class="np-handle-hit" x="${ex - 9}" y="${hy}" width="18" height="${hh}"/><rect class="np-handle-bar" x="${ex - 2.5}" y="${hy}" width="5" height="${hh}" rx="2"/><title>${esc(label)} (10-minute steps)</title></g>`);
    }
  }
  // altitude: every scheduled or program target, bold where it is scheduled
  const minAlt = last.settings?.minAltitude ?? state.config?.minAltitude ?? 0;
  parts.push(`<line class="np-min" x1="${pad.l}" x2="${W - pad.r}" y1="${altY(minAlt)}" y2="${altY(minAlt)}"/>`);
  for (const a of [0, 30, 60, 90]) parts.push(`<text class="np-tick" x="${pad.l - 4}" y="${altY(a) + 4}" text-anchor="end">${a}°</text>`);
  const scheduled = new Map();
  for (const b of p.blocks) if (b.target) scheduled.set(b.target.key, [...(scheduled.get(b.target.key) ?? []), b]);
  for (const tr of p.tracks ?? []) {
    const pts = tr.alt.map((a, i) => `${x(p.slots[i].t + SLOT_MS / 2).toFixed(1)},${altY(a).toFixed(1)}`);
    const c = colour(tr.key, tr.source);
    const own = scheduled.get(tr.key) ?? [];
    parts.push(`<polyline class="np-track" points="${pts.join(' ')}" stroke="${c}"><title>${esc(tr.displayName)}</title></polyline>`);
    for (const b of own) {
      const seg = tr.alt.map((a, i) => ({ t: p.slots[i].t + SLOT_MS / 2, a })).filter((q) => q.t >= b.start && q.t <= b.end);
      if (seg.length > 1) parts.push(`<polyline class="np-track on" points="${seg.map((q) => `${x(q.t).toFixed(1)},${altY(q.a).toFixed(1)}`).join(' ')}" stroke="${c}"><title>${esc(tr.displayName)} ${hm(b.start)}–${hm(b.end)}</title></polyline>`);
    }
  }
  const now = Date.now();
  if (now >= t0 && now <= t1) parts.push(`<line class="np-nowline" x1="${x(now)}" x2="${x(now)}" y1="${ySky - 4}" y2="${H - 12}"/><text class="np-tick now" x="${x(now)}" y="${H - 2}" text-anchor="middle">now</text>`);
  scale = { t0, t1, W, l: pad.l, r: pad.r, yBlocks };
  el.innerHTML = `<svg class="np-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tonight's plan as a timeline"><defs><pattern id="np-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#1a2436"/><line x1="0" y1="0" x2="0" y2="6" stroke="#334155" stroke-width="3"/></pattern><pattern id="np-cloudhatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="rgba(148,163,184,.45)"/><line x1="0" y1="0" x2="0" y2="6" stroke="rgba(100,116,139,.7)" stroke-width="2"/></pattern></defs>${parts.join('')}</svg>`;
  const keys = [...scheduled.keys()];
  $('#np-legend').innerHTML = keys.length
    ? keys.map((k) => {
        const b = scheduled.get(k)[0];
        return `<span class="np-key"><i style="background:${colour(k, b.target.source)}"></i>${esc(b.target.displayName)}${b.target.source === 'filler' ? ' (filler)' : ''}</span>`;
      }).join('') + '<span class="np-key"><i class="ovh"></i>switch (GoTo, focus)</span>' + (p.blocks.some((b) => b.clouds) ? '<span class="np-key"><i class="cloud"></i>clouds forecast (advisory)</span>' : '')
    : '';
}

// ---------------------------------------------------------------- one block

function renderDetail() {
  const el = $('#np-detail');
  const b = last?.plan?.blocks.find((x) => x.id === selected);
  if (!b) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (b.kind !== 'target') {
    el.innerHTML = `<div class="row-head"><h3>${esc(hm(b.start))}–${esc(hm(b.end))}: ${b.kind === 'weather' ? 'weather' : 'nothing usable'}</h3><span class="spacer"></span><button class="ghost" data-close>Close</button></div><p class="small">${esc(b.reason)}</p>`;
    return;
  }
  const t = b.target;
  const pin = b.pinned ? pinFor(t.key) : null;
  const alts = b.alternates.length
    ? `<table class="plan-table"><tr><th>Instead</th><th>Where</th><th>Usable</th><th></th></tr>${b.alternates.map((a) => `<tr><td><b>${esc(a.displayName)}</b><small>${esc(a.source)}</small></td><td>${esc(a.quadrant)}, alt ${esc(a.alt)}°<small>az ${esc(a.az)}°</small></td><td>${esc(dur(a.usableMin))}</td><td><button class="ghost" data-pin="${esc(a.gotoName)}" data-from="${b.past ? '' : Math.max(b.start, Date.now())}" data-until="${b.end}" title="Put ${esc(a.displayName)} in this block instead">Use</button><button class="ghost" data-sky="${esc(a.gotoName)}" data-display="${esc(a.displayName)}" data-ra="${esc(a.raHours)}" data-dec="${esc(a.decDeg)}">Sky</button><button class="ghost" data-research="${esc(a.gotoName)}" data-display="${esc(a.displayName)}" data-ra="${esc(a.raHours)}" data-dec="${esc(a.decDeg)}" title="Ask the agent to research it: what it is, its discovery and history, reference images, when it is up tonight and through the year, and how to collect it with this telescope">Research</button></td></tr>`).join('')}</table>`
    : '<p class="muted small">No alternates usable for this whole block.</p>';
  el.innerHTML = `
    <div class="row-head"><h3>${esc(t.displayName)}</h3><span class="badge ${t.source === 'program' ? 'done' : ''}">${esc(t.source)}</span>${b.pinned ? `<span class="badge waiting" title="${esc(pin ? `pinned ${pinTimes(pin)}` : 'pinned')}">pinned${pin ? ` ${esc(pinTimes(pin))}` : ''}</span>` : ''}${b.past ? '<span class="badge">past</span>' : ''}<span class="spacer"></span><button class="ghost" data-close>Close</button></div>
    <div class="status-grid">
      <div><span>Time</span>${esc(hm(b.start))}–${esc(hm(b.end))} (${esc(dur((b.end - b.start) / 60e3))})</div>
      <div><span>Expected integration</span>${esc(dur(b.expectedMin))}${b.overheadMin ? ` after ${esc(b.overheadMin)} min switch` : ''}</div>
      <div><span>Altitude</span>${esc(Math.round(b.alt.start))}° → ${esc(Math.round(b.alt.end))}° (max ${esc(Math.round(b.alt.max))}°)</div>
      <div><span>Direction</span>${esc(b.quadrant)} · az ${esc(b.az.start)}°→${esc(b.az.end)}°</div>
      <div><span>Moon</span>${b.moon ? `up ${esc(b.moon.upMin)} min, ≥${esc(b.moon.sepDeg)}° away` : 'down'}</div>
      <div><span>Sky</span>${b.sky == null ? 'no forecast' : `${esc(b.sky)}/100`}${b.clouds ? ` <span class="badge waiting" title="${esc(b.clouds.advisory)}">clouds ${esc(dur(b.clouds.cloudyMin))}</span>` : ''}</div>
      <div><span>Filter</span>${esc(t.filter ?? 'auto')}</div>
      <div><span>GoTo name</span>${esc(t.gotoName)}</div>
    </div>
    ${t.advice ? `<div class="np-advice"><div>${verdict(t.advice.detect, t.advice.detectReason)} <span class="small">${esc(t.advice.detectReason)}${t.advice.surfaceBrightness != null ? ` (SB ${esc(t.advice.surfaceBrightness)} mag/arcsec²)` : ''}</span></div>
      <div class="small"><b>Framing:</b> ${esc(t.advice.framing)}</div>
      ${t.advice.acquisition ? captureLine(t.advice.acquisition) : t.advice.sub ? `<div class="small"><b>Subs:</b> ${esc(subLine(t.advice.sub.subS, t.advice.sub.rangeS, t.advice.sub.subs))} in this block — ${esc(t.advice.sub.line)}</div>` : ''}</div>` : ''}
    ${b.clouds ? `<p class="small np-cloudnote"><b>Clouds forecast (advisory):</b> ${esc(b.clouds.advisory)}</p>` : ''}
    <p class="small">${esc(b.reason)}</p>
    ${t.notes ? `<p class="small"><b>Note:</b> ${esc(t.notes)}</p>` : ''}
    <div class="ctl-row np-actions">
      ${pin ? `<button class="ghost" data-release="${esc(pin.id)}" data-unpin="${esc(t.displayName)}" title="Pinned ${esc(pinTimes(pin))}: unpin it and let the solver plan this time again">Unpin</button>` : ''}
      <button class="ghost" data-sky="${esc(t.gotoName)}" data-display="${esc(t.displayName)}" data-ra="${esc(t.raHours)}" data-dec="${esc(t.decDeg)}">Show in Stellarium</button>
      <button class="ghost" data-research="${esc(t.gotoName)}" data-display="${esc(t.displayName)}" data-ra="${esc(t.raHours)}" data-dec="${esc(t.decDeg)}" title="Ask the agent to research it: what it is, its discovery and history, reference images, when it is up tonight and through the year, and how to collect it with this telescope">Research</button>
      ${b.past ? '' : `<button class="ghost" data-obscured="${esc(t.gotoName)}" data-cause="obstruction" title="Blocked by a tree or building now: held until its path takes it clear (rising out of it in the east; for the night when it is setting behind it in the west)">Obstructed now</button>
      <button class="ghost" data-obscured="${esc(t.gotoName)}" data-cause="cloud" title="Clouded: held for 45 min, then tried again">Clouded</button>
      <button class="ghost" data-skip="${esc(t.gotoName)}">Skip tonight</button>
      ${t.source === 'filler' ? `<button class="ghost" data-rest="${esc(t.gotoName)}" data-role="snooze" title="Hold it back like a recent capture; it fades back in over the coming weeks">Snooze</button><button class="ghost" data-rest="${esc(t.gotoName)}" data-role="done" title="Never suggest it again (until lifted)">Don't suggest again</button><button class="ghost" data-add="${esc(t.gotoName)}" data-goal="" title="Make it a program target">Add to program</button>` : ''}
      <button class="ghost" data-image="${esc(t.gotoName)}">Ask the agent</button>`}
    </div>
    ${b.past ? '' : '<p class="muted small">Drag this block on the schedule to move it, or its left or right edge to make it longer or shorter: it is pinned to the new time (10-minute steps; arrow keys on the focused block or edge).</p>'}
    <h4 class="np-h4">Alternates for this block</h4>${alts}`;
}

// ---------------------------------------------------------------- holds

/** Tonight's pins that have not ended yet. */
const livePins = () => (last?.plan?.holds ?? []).filter((h) => h.kind === 'pin' && (h.until == null || h.until > Date.now()));
const pinFor = (key) => livePins().find((h) => h.target === key) ?? null;
const pinTimes = (h) => `${hm(h.from)}–${h.until ? hm(h.until) : 'end of night'}`;

/** The pins, right under the schedule: what is pinned when, and a way to unpin it. */
function renderPins() {
  const el = $('#np-pins');
  const pins = livePins();
  el.hidden = !pins.length;
  el.innerHTML = pins.length
    ? `<span class="muted">Pinned:</span> ${pins.map((h) => `<span class="np-pin"><b>${esc(h.displayName ?? h.target)}</b> ${esc(pinTimes(h))}${h.by === 'agent' ? ' <span class="muted">(agent)</span>' : ''}<button type="button" class="ghost" data-release="${esc(h.id)}" data-unpin="${esc(h.displayName ?? '')}" title="Unpin: the solver plans this time again">Unpin</button></span>`).join('')}`
    : '';
}

function renderHolds() {
  renderPins();
  const holds = (last?.plan?.holds ?? []).filter((h) => h.until == null || h.until > Date.now());
  $('#np-holds').innerHTML = holds.length
    ? [...holds].sort((a, b) => (a.kind === 'pin' ? 0 : 1) - (b.kind === 'pin' ? 0 : 1) || a.from - b.from).map((h) => {
        const pin = h.kind === 'pin';
        const when = pin ? `pinned ${pinTimes(h)}` : h.until ? `until ${hm(h.until)}` : 'for the night';
        return `<div class="sess"><span class="badge ${pin ? 'done' : 'waiting'}">${esc(h.kind === 'sky' ? `${h.quadrant} sky` : pin ? 'pinned' : h.kind)}</span><b>${esc(h.displayName ?? '')}</b><span class="muted small">${esc(when)} · ${esc(h.reason)}${h.note ? ` · ${esc(h.note)}` : ''} · ${esc(h.by)}</span><span class="spacer"></span><button class="ghost" data-release="${esc(h.id)}"${pin ? ` data-unpin="${esc(h.displayName ?? '')}"` : ''}>${pin ? 'Unpin' : 'Lift'}</button></div>`;
      }).join('')
    : '<p class="muted small">No holds: every target is available to the plan.</p>';
}

// ---------------------------------------------------------------- the program

function progressBar(t) {
  const goal = Math.max(1, t.goalMin);
  const done = Math.min(100, (t.collectedMin / goal) * 100);
  const tonight = Math.min(100 - done, ((t.tonight?.plannedMin ?? 0) / goal) * 100);
  return `<div class="np-prog" title="${esc(dur(t.collectedMin))} collected${t.journalOnlyMin ? ` (${dur(t.journalOnlyMin)} not transferred yet)` : ''} of ${esc(dur(t.goalMin))}; tonight's plan adds ~${esc(dur(t.tonight?.plannedMin ?? 0))}"><div class="done" style="width:${done}%"></div><div class="tonight" style="width:${tonight}%"></div></div>`;
}

function renderProgram() {
  const el = $('#np-program');
  const sum = program.reduce((a, t) => a + t.goalMin, 0);
  const got = program.reduce((a, t) => a + Math.min(t.collectedMin, t.goalMin), 0);
  $('#np-program-sum').textContent = program.length ? `${program.length} targets · ${hours(got)} of ${hours(sum)} collected` : '';
  if (!program.length) {
    el.innerHTML = '<p class="muted small">No targets yet. Add what you want collected and for how long: the plan works them into the nights that suit them best, and fills the rest of the night from the catalog.</p>';
    return;
  }
  el.innerHTML = `<table class="plan-table np-prog-table"><tr><th>Target</th><th>Priority</th><th>Goal</th><th>Progress</th><th>Tonight</th><th></th></tr>${program
    .map((t) => {
      const o = t.tonight;
      const [cls, word] = STATUS[o?.status] ?? ['', o?.status ?? '–'];
      const season = o?.season;
      const seasonLine = season ? `${season.endsAround ? `season to ~${season.endsAround}` : 'season ahead'}${season.nightsToGoal ? ` · ~${season.nightsToGoal} clear night${season.nightsToGoal === 1 ? '' : 's'} to go` : ''}` : '';
      return `<tr class="${t.enabled ? '' : 'gated'}" data-id="${esc(t.id)}">
        <td><b>${esc(t.displayName)}</b><small>${esc(t.gotoName !== t.displayName ? t.gotoName : t.name)}${t.filter && t.filter !== 'auto' ? ` · ${esc(t.filter)}` : ''}${t.minAltitude ? ` · ≥${esc(t.minAltitude)}°` : ''}</small>${t.notes ? `<small>${esc(t.notes)}</small>` : ''}</td>
        <td data-label="Priority"><select data-field="priority" aria-label="Priority">${[5, 4, 3, 2, 1].map((p) => `<option value="${p}" ${p === t.priority ? 'selected' : ''}>${p} ${PRIORITIES[p]}</option>`).join('')}</select></td>
        <td data-label="Goal"><input type="number" data-field="goalH" min="0" step="0.5" value="${esc(Math.round((t.goalMin / 60) * 10) / 10)}" inputmode="decimal" aria-label="Goal in hours"> h</td>
        <td data-label="Progress">${progressBar(t)}<small>${esc(dur(t.collectedMin))} of ${esc(dur(t.goalMin))}${t.nights ? ` · ${esc(t.nights)} night${t.nights === 1 ? '' : 's'}` : ''}</small>${seasonLine ? `<small>${esc(seasonLine)}</small>` : ''}</td>
        <td data-label="Tonight"><span class="badge ${cls}">${esc(word)}</span><small>${esc(o?.reason ?? '')}</small></td>
        <td><button class="ghost" data-edit="${esc(t.id)}" title="Filter, minimum altitude, notes, keep collecting">Edit</button><button class="ghost" data-toggle="${esc(t.id)}">${t.enabled ? 'Pause' : 'Resume'}</button><button class="ghost" data-remove="${esc(t.id)}" aria-label="Remove ${esc(t.displayName)}">✕</button></td></tr>`;
    })
    .join('')}</table>`;
}

const switchSelect = (name, v) => `<select name="${name}">${[['inherit', 'as the settings'], ['on', 'on'], ['off', 'off']].map(([k, l]) => `<option value="${k}" ${(v ?? 'inherit') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;

function editRow(t) {
  const tr = $(`#np-program tr[data-id="${CSS.escape(t.id)}"]`);
  if (!tr || tr.nextElementSibling?.classList.contains('np-edit')) return;
  const row = document.createElement('tr');
  row.className = 'np-edit';
  row.innerHTML = `<td colspan="6"><form class="duty-form-row np-edit-form">
    <label>filter <input name="filter" value="${esc(t.filter ?? 'auto')}" list="np-filters" size="10"></label>
    <label>min altitude <input name="minAltitude" type="number" min="0" max="85" value="${esc(t.minAltitude ?? '')}" placeholder="plan's"> °</label>
    <label>not before <input name="notBefore" type="date" value="${esc(t.notBefore ?? '')}"></label>
    <label><input name="keepCollecting" type="checkbox" ${t.keepCollecting ? 'checked' : ''}> keep collecting after the goal</label>
    <label title="Shoot it as a mosaic when it is too big for the frame; the goal is then per panel">mosaic ${switchSelect('mosaic', t.mosaic)}</label>
    <label title="Ask AstroPhoto Studio to crop to the target when it is small in the frame">crop to target ${switchSelect('roiCrop', t.roiCrop)}</label>
    <label class="np-notes">note for the agent <input name="notes" value="${esc(t.notes ?? '')}" placeholder="framing, mosaic, filter…"></label>
    <button class="primary" type="submit">Save</button><button class="ghost" type="button" data-cancel>Cancel</button></form></td>`;
  tr.after(row);
  const form = $('form', row);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const minAlt = f.get('minAltitude');
    const r = await apiToast(`plan/program/${seg(t.id)}`, {
      filter: String(f.get('filter') || 'auto'),
      minAltitude: minAlt === '' ? null : Number(minAlt),
      notBefore: f.get('notBefore') ? String(f.get('notBefore')) : null,
      keepCollecting: f.get('keepCollecting') === 'on',
      notes: String(f.get('notes') ?? ''),
      mosaic: String(f.get('mosaic')),
      roiCrop: String(f.get('roiCrop')),
    });
    if (r) {
      toast(`${t.displayName} saved`);
      loadProgram();
    }
  };
  $('[data-cancel]', row).onclick = () => row.remove();
}

// ---------------------------------------------------------------- settings

const SETTINGS = [
  ['Window', [
    ['windowStart', 'starts at', 'text', { list: 'np-starts', title: 'astro-dusk, nautical-dusk, sunset or a local HH:MM' }],
    ['startOffsetMin', 'start offset', 'number', { min: -180, max: 180, unit: 'min' }],
    ['windowEnd', 'ends at', 'text', { list: 'np-ends', title: 'astro-dawn, nautical-dawn, sunrise or a local HH:MM' }],
    ['endOffsetMin', 'end offset', 'number', { min: -180, max: 180, unit: 'min' }],
  ]],
  ['Targets', [
    ['minAltitude', 'minimum altitude', 'number', { min: 0, max: 80, unit: '°' }],
    ['useHorizon', 'obstruction map', 'checkbox', { title: "the site's mapped obstructions and tonight's blocked views" }],
    ['minBlockMin', 'shortest block', 'number', { min: 10, max: 240, step: 5, unit: 'min' }],
    ['maxBlockMin', 'longest block', 'number', { min: 0, max: 720, step: 15, unit: 'min (0 = none)' }],
    ['switchHysteresis', 'switch margin', 'number', { min: 0, max: 2, step: 0.05, title: 'how much better another target must be before the plan leaves the current one (0.2 = 20%)' }],
  ]],
  ['Rig', [
    ['overheadMin', 'switch overhead', 'number', { min: 0, max: 60, step: 0.5, unit: 'min', nullable: true, title: 'empty = learned from the journal' }],
    ['efficiency', 'stacking efficiency', 'number', { min: 0.1, max: 1, step: 0.05, nullable: true, title: 'share of stacking time that becomes integration; empty = learned from the journal' }],
  ]],
  ['Sky', [
    ['useForecast', 'use the forecast', 'checkbox', {}],
    ['weatherMinScore', 'forecast floor', 'number', { min: 0, max: 100, step: 5, unit: '/100' }],
    ['moonAvoidance', 'Moon avoidance', 'checkbox', {}],
    ['moonBroadband.distanceDeg', 'broadband: distance at full', 'number', { min: 0, max: 180, unit: '°' }],
    ['moonBroadband.widthDays', 'width', 'number', { min: 0.5, max: 30, step: 0.5, unit: 'days' }],
    ['moonNarrowband.distanceDeg', 'narrowband: distance at full', 'number', { min: 0, max: 180, unit: '°' }],
    ['moonNarrowband.widthDays', 'width', 'number', { min: 0.5, max: 30, step: 0.5, unit: 'days' }],
  ]],
  ['Mosaics & cropping', [
    ['mosaicEnabled', 'mosaics', 'checkbox', { title: 'shoot program targets too big for the frame as mosaics (each target can override it)' }],
    ['mosaicOverlapPct', 'panel overlap', 'number', { min: 5, max: 50, unit: '%' }],
    ['mosaicMaxPanels', 'most panels', 'number', { min: 2, max: 64 }],
    ['mosaicCameraAngleDeg', 'camera angle (EQ)', 'number', { min: -180, max: 180, step: 0.5, unit: '°', nullable: true, title: "the sensor's width axis on the sky, degrees from east through north; empty = not measured (panels are planned as squares)" }],
    ['mosaicAllowNative', "the scope's own mosaic", 'checkbox', { title: 'use the firmware mosaic when the target fits inside it; not confirmed on hardware. Off: always panel by panel' }],
    ['roiCropEnabled', 'crop to the target', 'checkbox', { title: 'ask AstroPhoto Studio to crop targets that are small in the frame (each target can override it)' }],
    ['roiCropMaxFillPct', 'crop targets up to', 'number', { min: 1, max: 95, unit: '% of the frame' }],
    ['roiCropMarginPct', 'room around the target', 'number', { min: 0, max: 200, unit: '%' }],
  ]],
  ['Fillers', [
    ['fillerWeight', 'filler value', 'number', { min: 0, max: 1, step: 0.05, title: "a filler's value next to a normal-priority program target (their filter: Find targets)" }],
  ]],
];

const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

async function loadSettings() {
  try {
    const { settings } = await api('plan/settings');
    renderSettings(settings);
    renderFilter(settings);
  } catch (e) {
    $('#np-settings').innerHTML = `<span class="muted">${esc(e.message)}</span>`;
  }
}

function renderSettings(s) {
  $('#np-settings').innerHTML = SETTINGS.map(([group, fields]) => `<fieldset class="np-fs"><legend>${esc(group)}</legend>${fields
    .map(([k, label, type, o]) => {
      const v = getPath(s, k);
      if (type === 'checkbox') return `<label title="${esc(o.title ?? '')}"><input type="checkbox" data-set="${esc(k)}" ${v ? 'checked' : ''}> ${esc(label)}</label>`;
      const val = o.csv ? (v ?? []).join(', ') : (v ?? '');
      const attrs = type === 'number' ? `type="number" min="${o.min}" max="${o.max}" step="${o.step ?? 1}" inputmode="decimal"` : `type="text" ${o.list ? `list="${o.list}"` : ''} size="11"`;
      return `<label title="${esc(o.title ?? '')}">${esc(label)} <input ${attrs} data-set="${esc(k)}" ${o.nullable ? 'data-nullable="1" placeholder="auto"' : ''} ${o.csv ? 'data-csv="1"' : ''} value="${esc(val)}">${o.unit ? ` ${esc(o.unit)}` : ''}</label>`;
    })
    .join('')}</fieldset>`).join('') + '<div class="ctl-row"><button type="button" class="ghost" id="np-reset">Reset to defaults</button></div>';
  $('#np-reset').onclick = async () => {
    if (!confirm('Reset every plan setting to its default?')) return;
    const r = await apiToast('plan/settings/reset', {});
    if (r) {
      renderSettings(r);
      toast('Plan settings reset');
    }
  };
}

async function saveSetting(el) {
  const k = el.dataset.set;
  let v;
  if (el.type === 'checkbox') v = el.checked;
  else if (el.dataset.csv) v = el.value.split(',').map((x) => x.trim()).filter(Boolean);
  else if (el.type === 'number') v = el.value === '' && el.dataset.nullable ? null : Number(el.value);
  else v = el.value.trim();
  let body;
  if (k.includes('.')) {
    const [a, b] = k.split('.');
    const { settings } = await api('plan/settings');
    body = { [a]: { ...settings[a], [b]: v } };
  } else body = { [k]: v };
  const r = await apiToast('plan/settings', body);
  if (r) toast('Plan setting saved: the plan is solved again');
  else loadSettings();
}

// ---------------------------------------------------------------- finding targets: the fillers' filter, and suggestions to add

function renderFilter(s) {
  $('#np-f-fillers').checked = !!s.fillers;
  for (const el of $('#np-f-types').querySelectorAll('input')) el.checked = (s.fillerTypes ?? []).includes(el.value);
  $('#np-f-fov').value = String(s.fillerMinFovPercent ?? 0);
  $('#np-f-mag').value = s.fillerMaxMagnitude == null ? '' : String(s.fillerMaxMagnitude);
  if (document.activeElement !== $('#np-f-min')) $('#np-f-min').value = s.fillerMinSizeArcmin ?? '';
  if (document.activeElement !== $('#np-f-max')) $('#np-f-max').value = s.fillerMaxSizeArcmin ?? '';
  loadSuggestions();
}

function filterNow() {
  const n = (v) => (v === '' || v == null ? null : Number(v));
  return {
    fillerTypes: [...$('#np-f-types').querySelectorAll('input:checked')].map((el) => el.value),
    fillerMinFovPercent: Number($('#np-f-fov').value) || 0,
    fillerMaxMagnitude: n($('#np-f-mag').value),
    fillerMinSizeArcmin: n($('#np-f-min').value),
    fillerMaxSizeArcmin: n($('#np-f-max').value),
  };
}

let suggestSeq = 0;
async function loadSuggestions() {
  const f = filterNow();
  const p = new URLSearchParams({ limit: '20', types: f.fillerTypes.join(','), minFovPercent: String(f.fillerMinFovPercent) });
  if (f.fillerMaxMagnitude != null) p.set('maxMagnitude', String(f.fillerMaxMagnitude));
  if (f.fillerMinSizeArcmin != null) p.set('minSizeArcmin', String(f.fillerMinSizeArcmin));
  if (f.fillerMaxSizeArcmin != null) p.set('maxSizeArcmin', String(f.fillerMaxSizeArcmin));
  const el = $('#np-suggest');
  el.innerHTML = '<span class="muted small">looking…</span>';
  const mine = ++suggestSeq;
  try {
    const r0 = await api(`plan/suggestions?${p}`);
    if (mine !== suggestSeq) return;
    const rows = r0.targets ?? [];
    const skyCls = (q) => (q == null ? '' : q >= 60 ? 'ok' : q >= 35 ? 'warn' : 'bad');
    const resting = (r0.resting ?? []).length
      ? `<p class="muted small">Held back by memory: ${r0.resting.map((x) => `<b>${esc(x.displayName ?? x.name)}</b> (${esc(x.reason)}) <button class="ghost np-mini" data-rest="${esc(x.name)}" data-role="none">lift</button>`).join(' · ')}</p>`
      : '';
    el.innerHTML = rows.length
      ? `<table class="plan-table"><tr><th>Target</th><th title="what tonight's plan makes of it, by the same scoring it schedules with">In tonight's plan</th><th>Sky</th><th>Fit / filter / subs</th><th></th></tr>${rows
          .map((r) => {
            const inPlan = r.scheduled?.length
              ? `<span class="badge done">scheduled</span><small>${r.scheduled.map((b) => `${esc(hm(b.start))}–${esc(hm(b.end))} (~${esc(dur(b.expectedMin))})`).join(', ')}</small>`
              : r.usableMin
                ? `${esc(dur(r.usableMin))} usable<small>best ${esc(hm(r.usableFrom))}–${esc(hm(r.usableUntil))} · merit ${esc(Math.round(r.merit * 100))}% · value ${esc(r.planValue)}</small>`
                : `<span class="muted">not usable</span><small>${esc(r.notUsable ?? '')}</small>`;
            const subs = r.capture ? `${r.capture.subS}s × ${r.capture.frames} · ${r.capture.hoursToGood} h to clean${r.capture.swamp != null ? ` · swamp ${r.capture.swamp}×` : ''}` : subLine(r.subSeconds, r.subRangeSeconds, r.subs);
            return `<tr class="${r.usableMin ? '' : 'gated'}"><td><b>${esc(r.displayName)}</b> ${verdict(r.detect, r.detectReason)}${r.obstructedNow ? ` <span class="badge waiting" title="behind the site's obstructions now${r.clearsAt ? `; clear at ${esc(r.clearsAt)}` : ''}">behind obstruction now</span>` : ''}<small>${esc(r.type)} in ${esc(r.constellation)}, ${esc(r.sizeArcmin)}′${r.magnitude != null ? `, mag ${esc(r.magnitude)}` : ''}${r.surfaceBrightness != null ? `, SB ${esc(r.surfaceBrightness)}` : ''}</small>${r.gated ? `<small>${esc(r.gateReason)}</small>` : ''}${r.restReason ? `<small>memory: ${esc(r.restReason)}</small>` : ''}</td>
            <td data-label="In tonight's plan">${inPlan}<small>max ${esc(Math.round(r.maxAltitude))}°</small></td>
            <td data-label="Sky">${r.sky != null ? `<b class="sky ${skyCls(r.sky)}">${esc(r.sky)}/100</b><small>while usable</small>` : '<small>no forecast</small>'}</td>
            <td data-label="Fit / filter / subs"><small>${esc(r.framing ?? (r.fillPercent != null ? `${r.fillPercent}% of the frame` : ''))}</small><small>${esc(r.capture?.filter ?? r.filter)}</small>${subs ? `<small title="${esc(r.exposureAdvice ?? '')}">${esc(subs)}</small>` : ''}</td>
            <td><button class="ghost" data-add="${esc(r.gotoName)}" data-goal="${esc(r.suggestedGoalMin)}" title="Add to the program with a goal of ${esc(dur(r.suggestedGoalMin))} (edit it after)">Add ${esc(hours(r.suggestedGoalMin))}</button><button class="ghost" data-sky="${esc(r.gotoName)}" data-display="${esc(r.displayName)}" data-ra="${esc(r.raHours)}" data-dec="${esc(r.decDeg)}">Sky</button><button class="ghost" data-research="${esc(r.gotoName)}" data-display="${esc(r.displayName)}" data-ra="${esc(r.raHours)}" data-dec="${esc(r.decDeg)}" title="Ask the agent to research it: what it is, its discovery and history, reference images, when it is up tonight and through the year, and how to collect it with this telescope">Research</button><button class="ghost" data-rest="${esc(r.gotoName)}" data-role="snooze" title="Hold it back like a recent capture; it fades back in over the coming weeks">Snooze</button><button class="ghost" data-rest="${esc(r.gotoName)}" data-role="done" title="Never suggest it again (until lifted)">Never</button></td></tr>`;
          })
          .join('')}</table>${resting}`
      : `<p class="muted small">Nothing up tonight matches this filter.</p>${resting}`;
  } catch (e) {
    if (mine === suggestSeq) el.innerHTML = `<span class="muted">${esc(e.message)}</span>`;
  }
}

let filterTimer = null;
$('#np-find-card').addEventListener('change', (e) => {
  if (e.target.id === 'np-f-fillers') {
    apiToast('plan/settings', { fillers: e.target.checked }).then((r) => r && toast(r.fillers ? 'Free time is filled from this filter' : 'No fillers: free time stays free'));
    return;
  }
  clearTimeout(filterTimer);
  filterTimer = setTimeout(async () => {
    // the filter is the fillers' too: saved first, so the list and the plan are drawn from one pool
    if (await apiToast('plan/settings', filterNow())) reloadSoon();
    loadSuggestions();
  }, 300);
});

// ---------------------------------------------------------------- the target memory (the Tonight tab's target rest, shared)

async function loadMemory() {
  try {
    const r = await api('rest');
    const s = r.settings ?? (await api('rest/settings'));
    if (document.activeElement !== $('#np-rest-goal')) $('#np-rest-goal').value = s.integrationTargetMin;
    if (document.activeElement !== $('#np-rest-days')) $('#np-rest-days').value = s.restDays;
    const held = r.held ?? [];
    $('#np-memory').innerHTML = held.length
      ? `<p class="muted small">Your own say: ${held.map((h) => `<b>${esc(h.displayName)}</b> ${h.role === 'done' ? "(don't suggest again)" : `(snoozed${h.state?.until ? ` until ${esc(h.state.until)}` : ''})`} <button class="ghost np-mini" data-rest="${esc(h.gotoName)}" data-role="none">lift</button>`).join(' · ')}</p>`
      : '<p class="muted small">A target the library already holds rests once its sessions reach the integration goal; Snooze and Never (suggestions, filler blocks) are your own say on top, and hold program targets back too.</p>';
  } catch (e) {
    $('#np-memory').innerHTML = `<span class="muted">${esc(e.message)}</span>`;
  }
}

async function saveRest(e) {
  const goal = Number($('#np-rest-goal').value);
  const days = Number($('#np-rest-days').value);
  if (!Number.isFinite(goal) || goal < 0 || !Number.isInteger(days) || days < 1) {
    toast('Integration goal must be 0 or more minutes and the rest a whole number of days (1 or more)', true);
    return loadMemory();
  }
  const r = await apiToast('rest/settings', e.target.id === 'np-rest-goal' ? { integrationTargetMin: goal } : { restDays: days });
  if (r) {
    toast(e.target.id === 'np-rest-goal' ? `Integration goal: ${r.integrationTargetMin} min` : `Rest: ${r.restDays} days`);
    loadSuggestions();
    reloadSoon();
  }
}
$('#np-rest-goal').onchange = saveRest;
$('#np-rest-days').onchange = saveRest;

// ---------------------------------------------------------------- adding targets

let searchTimer = null;
function searchTargets(q) {
  clearTimeout(searchTimer);
  if (q.trim().length < 2) return;
  searchTimer = setTimeout(async () => {
    try {
      const r = await api(`catalog/search?q=${encodeURIComponent(q)}&limit=12&sort=relevance`);
      $('#np-add-list').innerHTML = (r.items ?? []).map((o) => `<option value="${esc(o.name)}">${esc([o.id !== o.name ? o.id : '', o.typeName, o.constellation, o.maxAltitudeTonight != null ? `max ${o.maxAltitudeTonight}° tonight` : ''].filter(Boolean).join(' · '))}</option>`).join('');
    } catch {
      /* typing ahead of a slow search */
    }
  }, SEARCH_MS);
}

$('#np-add').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#np-add-name').value.trim();
  if (!name) return;
  const goalH = Number($('#np-add-goal').value);
  const r = await apiToast('plan/program', { name, goalMin: Math.round((Number.isFinite(goalH) ? goalH : 3) * 60), priority: Number($('#np-add-pri').value) });
  if (r) {
    toast(`${r.displayName}: ${dur(r.goalMin)} wanted, priority ${r.priority}`);
    $('#np-add-name').value = '';
    loadProgram();
    setTimeout(() => loadPlan(), 6000);
  }
};
$('#np-add-name').addEventListener('input', (e) => searchTargets(e.target.value));

// ---------------------------------------------------------------- drag a block's edges

const snap = (t) => Math.round(t / SLOT_MS) * SLOT_MS;

/** The time under the pointer, from the timeline as drawn (the SVG may be scaled to fit). */
function timeAt(svg, clientX) {
  const r = svg.getBoundingClientRect();
  const px = ((clientX - r.left) * scale.W) / (r.width || scale.W);
  return scale.t0 + ((px - scale.l) / (scale.W - scale.l - scale.r)) * (scale.t1 - scale.t0);
}

/** The range a dragged edge may take: inside tonight's window, never before now, at least one slot long. */
function dragged(t) {
  const now = Date.now();
  const lo = Math.max(scale.t0, snap(now) > now ? snap(now) - SLOT_MS : snap(now));
  if (drag.edge === 'move') {
    // the whole block slides: same length, inside the night, never starting before now
    const len = drag.orig.end - drag.orig.start;
    const start = Math.min(scale.t1 - len, Math.max(lo, snap(drag.orig.start + (t - drag.grabT))));
    return { start, end: start + len };
  }
  if (drag.edge === 'start') return { start: Math.min(drag.end - SLOT_MS, Math.max(lo, snap(t))), end: drag.end };
  return { start: drag.start, end: Math.max(Math.max(drag.start, now) + SLOT_MS, Math.min(scale.t1, snap(t))) };
}

/** Redraw only the dragged block and its handles, with the new times. */
function previewDrag() {
  const svg = $('#np-timeline svg');
  if (!svg) return;
  const x = (t) => scale.l + ((t - scale.t0) / (scale.t1 - scale.t0)) * (scale.W - scale.l - scale.r);
  const g = svg.querySelector(`[data-block="${CSS.escape(drag.id)}"]`);
  const box = g?.querySelector('rect');
  if (box) {
    box.setAttribute('x', x(drag.start));
    box.setAttribute('width', Math.max(1, x(drag.end) - x(drag.start)));
  }
  for (const t of g?.querySelectorAll('text') ?? []) t.setAttribute('x', x(drag.start) + 6);
  const sub = g?.querySelector('.np-bsub');
  if (sub) sub.textContent = `${hm(drag.start)}–${hm(drag.end)} · ${dur((drag.end - drag.start) / 60e3)}`;
  for (const h of svg.querySelectorAll('[data-handle]')) {
    const ex = x(h.dataset.handle === 'start' ? Math.max(drag.start, Date.now()) : drag.end);
    h.querySelector('.np-handle-hit').setAttribute('x', ex - 9);
    h.querySelector('.np-handle-bar').setAttribute('x', ex - 2.5);
  }
  $('#np-drag-tip').textContent = `${drag.name}: ${hm(drag.start)}–${hm(drag.end)} (${dur((drag.end - drag.start) / 60e3)}) — let go to pin it`;
  $('#np-drag-tip').hidden = false;
}

/** Pin the block's target to its new times; the rest of the night is solved around it. */
async function commitDrag(d) {
  const b = last?.plan?.blocks.find((x) => x.id === d.id);
  if (!b) return;
  if (d.start === b.start && d.end === b.end) return;
  const from = Math.max(d.start, Date.now());
  const r = await apiToast('plan/hold', { action: 'pin', target: b.target.gotoName, from, until: d.end });
  if (!r) return;
  toast(`${r.displayName ?? b.target.displayName} pinned ${hm(r.from ?? from)}–${hm(r.until ?? d.end)}: the rest of the night is solved around it`);
  await loadPlan();
  // block ids are positions in the plan: select the target's block that now holds the pin
  const nb = last?.plan?.blocks.find((x) => x.target?.key === b.target.key && x.start < d.end && x.end > from);
  selected = nb?.id ?? null;
  renderTimeline();
  renderDetail();
}

/** Pixels the pointer must travel before a press on the selected block becomes a move (a tap stays a tap). */
const MOVE_THRESHOLD_PX = 4;

$('#np-timeline').addEventListener('pointerdown', (e) => {
  if (!scale || e.button > 0) return;
  // the selected (not yet past) target block itself: slide it left or right
  const g = e.target.closest('[data-block]');
  if (g && !e.target.closest('[data-handle]')) {
    const b = last?.plan?.blocks.find((x) => x.id === g.dataset.block);
    if (!b || b.id !== selected || b.kind !== 'target' || b.past) return;
    const svg = $('#np-timeline svg');
    drag = { id: b.id, edge: 'move', start: b.start, end: b.end, orig: { start: b.start, end: b.end }, grabT: timeAt(svg, e.clientX), x0: e.clientX, armed: false, name: b.target.displayName, moved: false, pointer: e.pointerId };
    g.setPointerCapture(e.pointerId);
    return;
  }
  const h = e.target.closest('[data-handle]');
  if (!h) return;
  const b = last?.plan?.blocks.find((x) => x.id === h.dataset.hblock);
  if (!b) return;
  e.preventDefault();
  h.setPointerCapture(e.pointerId);
  drag = { id: b.id, edge: h.dataset.handle, start: b.start, end: b.end, name: b.target.displayName, moved: false, pointer: e.pointerId };
});
$('#np-timeline').addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointer) return;
  if (drag.edge === 'move' && !drag.armed) {
    if (Math.abs(e.clientX - drag.x0) < MOVE_THRESHOLD_PX) return;
    drag.armed = true;
    $('#np-timeline').classList.add('moving');
  }
  const svg = $('#np-timeline svg');
  const next = dragged(timeAt(svg, e.clientX));
  if (next.start === drag.start && next.end === drag.end) return;
  Object.assign(drag, next, { moved: true });
  previewDrag();
});
const endDrag = (e) => {
  if (!drag || e.pointerId !== drag.pointer) return;
  const d = drag;
  drag = null;
  $('#np-drag-tip').hidden = true;
  $('#np-timeline').classList.remove('moving');
  // a tap is left alone, so its click still selects or deselects the block
  if (!d.moved) return;
  if (e.type === 'pointercancel') return renderTimeline();
  // the click that follows a drag must not toggle the selection
  const swallow = (ev) => ev.stopPropagation();
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
  renderTimeline();
  commitDrag(d);
};
$('#np-timeline').addEventListener('pointerup', endDrag);
$('#np-timeline').addEventListener('pointercancel', endDrag);
// the keyboard: arrows move a focused edge by one slot
$('#np-timeline').addEventListener('keydown', (e) => {
  if (!scale || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const g = e.target.closest('[data-block]');
  if (g && g.dataset.block === selected) {
    const b = last?.plan?.blocks.find((x) => x.id === selected);
    if (!b || b.kind !== 'target' || b.past) return;
    e.preventDefault();
    drag = { id: b.id, edge: 'move', start: b.start, end: b.end, orig: { start: b.start, end: b.end }, grabT: 0 };
    const next = dragged(e.key === 'ArrowLeft' ? -SLOT_MS : SLOT_MS);
    drag = null;
    commitDrag({ id: b.id, ...next });
    return;
  }
  const h = e.target.closest('[data-handle]');
  if (!h) return;
  const b = last?.plan?.blocks.find((x) => x.id === h.dataset.hblock);
  if (!b) return;
  e.preventDefault();
  drag = { id: b.id, edge: h.dataset.handle, start: b.start, end: b.end };
  const cur = h.dataset.handle === 'start' ? b.start : b.end;
  const next = dragged(cur + (e.key === 'ArrowLeft' ? -SLOT_MS : SLOT_MS));
  drag = null;
  commitDrag({ id: b.id, ...next });
});

// ---------------------------------------------------------------- events

$('#panel-plan').addEventListener('click', async (e) => {
  const blk = e.target.closest('[data-block]');
  if (blk) {
    selected = selected === blk.dataset.block ? null : blk.dataset.block;
    renderTimeline();
    renderDetail();
    if (selected) $('#np-detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  if (d.close !== undefined) {
    selected = null;
    renderTimeline();
    renderDetail();
  } else if (d.image) draft(imagingRequest(d.image));
  else if (d.rest) {
    const role = d.role;
    const r = await busy(b, () => apiToast('rest', { name: d.rest, role }));
    if (r) {
      toast(role === 'none' ? `${d.rest}: back in the pool` : role === 'done' ? `${d.rest} will not be suggested again` : `${d.rest} snoozed${r.state?.until ? ` until ${r.state.until}` : ''}`);
      loadSuggestions();
      loadMemory();
      reloadSoon();
    }
  } else if (d.add) {
    const r = await busy(b, () => apiToast('plan/program', d.goal ? { name: d.add, goalMin: Number(d.goal) } : { name: d.add }));
    if (r) {
      toast(`${r.displayName} added: ${dur(r.goalMin)}, priority ${r.priority}`);
      loadProgram();
      loadSuggestions();
      setTimeout(() => loadPlan(), 6000);
    }
  }
  else if (d.obscured) {
    const h = await busy(b, () => apiToast('plan/hold', { action: 'obscured', target: d.obscured, cause: d.cause }));
    if (h) toast(`${h.displayName}: ${h.note ?? `held until ${h.until ? hm(h.until) : 'the end of the night'}`}`);
    loadPlan();
  } else if (d.skip) {
    if (await busy(b, () => apiToast('plan/hold', { action: 'skip', target: d.skip }))) toast(`${d.skip} skipped tonight`);
    loadPlan();
  } else if (d.pin) {
    const r = await busy(b, () => apiToast('plan/hold', { action: 'pin', target: d.pin, from: d.from ? Number(d.from) : undefined, until: Number(d.until) }));
    if (r) toast(`${r.displayName} pinned ${hm(r.from)}–${hm(r.until)}`);
    loadPlan();
  } else if (d.release) {
    if (await busy(b, () => apiToast('plan/hold', { action: 'release', id: d.release }))) toast(d.unpin !== undefined ? `${d.unpin || 'Target'} unpinned: the solver plans that time again` : 'Hold lifted');
    loadPlan();
  } else if (d.skyhold) {
    const min = Number(prompt(`Cloud in the ${d.skyhold}: keep the plan out of that part of the sky for how many minutes?`, '60'));
    if (!Number.isFinite(min) || min < 5) return;
    if (await apiToast('plan/hold', { action: 'sky', quadrant: d.skyhold, minutes: min })) toast(`${d.skyhold} sky held for ${min} min`);
    loadPlan();
  } else if (d.edit) {
    const t = program.find((x) => x.id === d.edit);
    if (t) editRow(t);
  } else if (d.toggle) {
    const t = program.find((x) => x.id === d.toggle);
    if (t && (await apiToast(`plan/program/${seg(t.id)}`, { enabled: !t.enabled }))) loadProgram();
  } else if (d.remove) {
    const t = program.find((x) => x.id === d.remove);
    if (!t || !confirm(`Remove ${t.displayName} from the program? What was collected stays in the library and the journal.`)) return;
    if (await apiToast(`plan/program/${seg(t.id)}`, undefined, 'DELETE')) {
      toast(`${t.displayName} removed`);
      loadProgram();
    }
  }
});

$('#panel-plan').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-block]')) {
    e.preventDefault();
    e.target.closest('[data-block]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
});

$('#np-program').addEventListener('change', async (e) => {
  const el = e.target.closest('[data-field]');
  if (!el) return;
  const id = el.closest('tr')?.dataset.id;
  if (!id) return;
  const body = el.dataset.field === 'priority' ? { priority: Number(el.value) } : { goalMin: Math.round(Number(el.value) * 60) };
  if (el.dataset.field === 'goalH' && !(Number(el.value) >= 0)) return toast('The goal is a number of hours', true);
  if (await apiToast(`plan/program/${seg(id)}`, body)) {
    toast('Saved: the plan is solved again');
    loadProgram();
  }
});

$('#np-settings').addEventListener('change', (e) => {
  const el = e.target.closest('[data-set]');
  if (el) saveSetting(el);
});

let reloadTimer = null;
const reloadSoon = () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => isPanelActive('plan') && loadPlan(), RELOAD_MS);
};
on('plan-changed', reloadSoon);
on('program-changed', () => isPanelActive('plan') && loadProgram());
on('duty', () => isPanelActive('plan') && last && renderHead());
on('tab', (name) => {
  if (name !== 'plan') return;
  loadPlan();
  loadSettings();
  loadMemory();
});
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => isPanelActive('plan') && last && renderTimeline(), RESIZE_MS);
});
// the now line and "what to do now" move with the clock
setInterval(() => {
  if (isPanelActive('plan') && last) api('plan/now').then((n) => {
    last.now = n;
    renderHead();
    renderTimeline();
  }).catch(() => {});
}, NOW_TICK_MS);
