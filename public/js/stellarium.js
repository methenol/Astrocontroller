/**
 * The Stellarium tab: Stellarium Web Engine (vendor/stellarium, AGPL-3.0) with the observer at the
 * site in .env and the clock on real time, shown in the site's time zone. Pick anything on the
 * sky (or search, or come here from Tonight / Database / the agent) to GoTo it or ask the agent to
 * image it. The tele frame is drawn as a dashed rectangle, oriented like the mount (horizon-level
 * in alt-az, north-up in EQ); Frame mode pins it to the middle of the view so a shot can be
 * composed by panning the sky, and GoTo then goes to the frame's centre. The telescope's own frame
 * (from its last GoTo) is drawn while it tracks, with the site's obstruction map and the plan.
 *
 * The engine loads on the first visit: 1.3 MB of WebAssembly that most visits to the app never need.
 */
import { $, $$, esc, store, toast } from './dom.js';
import { api, control } from './api.js';
import { on } from './bus.js';
import { state, isPanelActive } from './state.js';
import { showScreen } from './shell.js';
import { draft } from './chat.js';
import { imagingRequest } from './tonight.js';
import { askResearch } from './research.js';
import { findInProgram, programFormHtml, wireProgramForms } from './program-add.js';

const VENDOR = 'vendor/stellarium';
const SKY = `${VENDOR}/skydata`;
/** the planet textures data.stellarium.org serves (surveys/<name>) */
const PLANET_TEXTURES = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'io', 'europa', 'ganymede', 'callisto'];
/** the nominal tele and wide fields of view (degrees) until the telescope reports its own */
const TELE_FOV = { h: 2.95, v: 1.66 };
const WIDE_FOV = { h: 45, v: 25.3 };
/** GoTo from the UI refuses targets lower than this, as the server does */
const GOTO_MIN_ALT = 5;
/** a name from the engine counts as the object we were sent to only this close to the position given */
const SAME_PLACE_DEG = 0.5;
/** the clock reads "live" while the sky's time is this close to now */
const LIVE_MS = 5000;
const TICK_MS = 250;
const CARD_MS = 1000;
const DASHES = 14;
const START_FOV_DEG = 90;
const TARGET_FOV_FACTOR = 3;
const OPTS_KEY = 'sky-opts';
const DEFAULT_OPTS = { constellations: true, atmosphere: true, ground: 'zero', azGrid: false, eqGrid: false, dsos: true, dss: true, plan: true, night: true, scope: true, mask: true, tele: true, wide: false };
// catalog designations the server's database knows, preferred as the name sent with GoTo
const CATALOG_NAME = /^(M|NGC|IC|C|Sh ?2-|Abell|Arp|LDN|LBN|B|vdB|Cr|Mel|Stock|Tr|UGC|PGC|PN|Ced|RCW|Gum|Hickson|HCG)\s?\d/i;

const COLORS = {
  frame: '#93c5fd',
  wide: '#a78bfa',
  scope: '#4ade80',
  mask: '#7f1d1d',
  minAlt: '#f87171',
  plan: [0.58, 0.77, 0.99, 0.12],
  planBorder: [0.58, 0.77, 0.99, 0.9],
  night: [0.18, 0.83, 0.75, 0.14],
  nightBorder: [0.18, 0.83, 0.75, 0.95],
  nightLine: '#2dd4bf',
  pick: [0.98, 0.75, 0.14, 0.12],
  pickBorder: [0.98, 0.75, 0.14, 1],
};

let opts = { ...DEFAULT_OPTS, ...readOpts() };
let enginePromise = null;
let stel = null;
let overlay = null; // the frames: a geojson in ICRF
/** the obstruction map is drawn in pieces at most this wide (degrees of azimuth) */
const MASK_PIECE_DEG = 20;
let maskObj = null; // obstructions and the minimum altitude: a geojson in the observed frame
let maskFeatures = []; // what it shows while the option is on (the engine ignores `visible` on a geojson)
let layer = null;
/** the plan's circles and the one dropped for a target the engine does not know: obj pointer → target */
const markers = new Map();
let pickMarker = null;
/** the night plan's target blocks, in order: {start, end, display, vec} (drawn as the night's path and the frame at the sky's time) */
let nightBlocks = [];
/** what is selected: {name, display, raHours, decDeg, type, vmag, body, obj} */
let sel = null;
/** Frame mode: the frame stays in the middle of the view; frameCenter is that centre (ICRF) */
let framing = false;
let frameCenter = null;
let lastObserved = null;
let lastCard = 0;
let tickTimer = null;
let pendingView = null;

function readOpts() {
  try {
    return JSON.parse(store.get(OPTS_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
const saveOpts = () => store.set(OPTS_KEY, JSON.stringify(opts));
const cfg = () => state.config?.stellarium ?? null;
const tz = () => cfg()?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

// ---------------------------------------------------------------- vectors and frames

const norm = (v) => {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sepDeg = (a, b) => (Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) * 180) / Math.PI;

/** J2000 RA (hours) / Dec (degrees) → an ICRF unit vector. */
const raDecVec = (raH, decDeg) => stel.s2c(raH * 15 * stel.D2R, decDeg * stel.D2R);
/** An ICRF vector → J2000 RA hours / Dec degrees. */
function vecRaDec(v) {
  const [ra, dec] = stel.c2s(norm(v));
  return { raHours: (stel.anp(ra) * stel.R2D) / 15, decDeg: stel.anpm(dec) * stel.R2D };
}
/** An ICRF vector → azimuth / apparent altitude in degrees, now (the sky's time). */
function vecAltAz(v) {
  const [az, alt] = stel.c2s(stel.convertFrame(stel.core.observer, 'ICRF', 'OBSERVED', norm(v)));
  return { az: stel.anp(az) * stel.R2D, alt: stel.anpm(alt) * stel.R2D };
}
/** The middle of the view, as an ICRF unit vector. */
const viewCenter = () => norm(stel.convertFrame(stel.core.observer, 'VIEW', 'ICRF', [0, 0, -1, 0]));
const viewObserved = () => norm(stel.convertFrame(stel.core.observer, 'VIEW', 'OBSERVED', [0, 0, -1, 0]));
const observedOf = (v) => norm(stel.convertFrame(stel.core.observer, 'ICRF', 'OBSERVED', v));
/** Turn the view to an ICRF direction (the engine's lookAt takes the mount's frame). */
const lookAtSky = (v, s) => stel.lookAt(norm(stel.convertFrame(stel.core.observer, 'ICRF', 'MOUNT', v)), s);

/**
 * The camera's frame round an ICRF direction as a closed ring of ICRF vectors: its long side along
 * the horizon on an alt-az mount, along RA on an EQ one. w, h in degrees.
 */
function frameCorners(center, w, h) {
  const eq = state.telescope?.bodyMode === 'eq';
  const obs = stel.core.observer;
  // the frame's "up": the celestial pole in EQ, the zenith in alt-az
  const c = eq ? center : norm(stel.convertFrame(obs, 'ICRF', 'OBSERVED', center));
  const pole = [0, 0, 1];
  let right = cross(pole, c);
  if (Math.hypot(...right) < 1e-9) right = [1, 0, 0];
  right = norm(right);
  const up = norm(cross(c, right));
  const tw = Math.tan((w / 2) * (Math.PI / 180));
  const th = Math.tan((h / 2) * (Math.PI / 180));
  const corner = (sx, sy) => {
    const p = norm(add(add(c, right, sx * tw), up, sy * th));
    return eq ? p : norm(stel.convertFrame(obs, 'OBSERVED', 'ICRF', p));
  };
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
}

/** Interpolate along a great circle between two unit vectors. */
function slerp(a, b, t) {
  return norm(add(a, add(b, a, -1), t));
}
const lonLat = (v) => {
  const [lon, lat] = stel.c2s(v);
  return [stel.anp(lon) * stel.R2D, stel.anpm(lat) * stel.R2D];
};

/** A rectangle as GeoJSON line features (the engine reads no MultiLineString): dashed, or solid. */
function rectFeatures(corners, color, { dashed, width = 1.5, title } = {}) {
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    if (!dashed) {
      lines.push([0, 0.25, 0.5, 0.75, 1].map((t) => lonLat(slerp(a, b, t))));
      continue;
    }
    for (let k = 0; k < DASHES; k++) lines.push([k / DASHES, (k + 0.55) / DASHES].map((t) => lonLat(slerp(a, b, t))));
  }
  const properties = { stroke: color, 'stroke-width': width, 'stroke-opacity': 0.95 };
  const features = lines.map((coordinates) => ({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates } }));
  if (title) features.push({ type: 'Feature', properties: { title, 'text-anchor': 'bottom-left', stroke: color, fill: color }, geometry: { type: 'Point', coordinates: lonLat(corners[3]) } });
  return features;
}

// ---------------------------------------------------------------- loading

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('the Stellarium engine did not load'));
    document.head.appendChild(s);
  });
}

function ensureEngine() {
  if (enginePromise) return enginePromise;
  $('#sky-status').textContent = 'loading the sky…';
  enginePromise = loadScript(`${VENDOR}/stellarium-web-engine.js`)
    .then(
      () =>
        new Promise((resolve) => {
          window.StelWebEngine({
            wasmFile: new URL(`${VENDOR}/stellarium-web-engine.wasm`, location.href).href,
            canvas: $('#sky-canvas'),
            translateFn: (_domain, str) => str,
            onReady: resolve,
          });
        }),
    )
    .then((s) => {
      stel = s;
      setup();
      $('#sky-status').textContent = '';
      return s;
    })
    .catch((e) => {
      enginePromise = null;
      $('#sky-status').textContent = e.message;
      throw e;
    });
  return enginePromise;
}

const abs = (p) => new URL(p, location.href).href.replace(/\/$/, '');

function addSources() {
  const core = stel.core;
  const c = cfg();
  const stream = !!c?.stream;
  const remote = (c?.dataUrl || 'https://data.stellarium.org').replace(/\/+$/, '');
  core.stars.addDataSource({ url: abs(`${SKY}/stars`) });
  core.skycultures.addDataSource({ url: abs(`${SKY}/skycultures/western`), key: 'western' });
  // the full deep-sky catalog when streaming; the bundled bright ones otherwise (both together would draw each twice)
  core.dsos.addDataSource({ url: stream ? `${remote}/surveys/dso` : abs(`${SKY}/dso`) });
  core.landscapes.addDataSource({ url: abs(`${SKY}/landscapes/zero`), key: 'zero' });
  core.landscapes.addDataSource({ url: abs(`${SKY}/landscapes/guereins`), key: 'guereins' });
  core.milkyway.addDataSource({ url: abs(`${SKY}/surveys/milkyway`) });
  core.minor_planets.addDataSource({ url: abs(`${SKY}/mpcorb.dat`), key: 'mpc_asteroids' });
  core.planets.addDataSource({ url: stream ? `${remote}/surveys/moon` : abs(`${SKY}/surveys/sso/moon`), key: 'moon' });
  core.planets.addDataSource({ url: stream ? `${remote}/surveys/sun` : abs(`${SKY}/surveys/sso/sun`), key: 'sun' });
  core.planets.addDataSource({ url: abs(`${SKY}/surveys/sso/moon`), key: 'default' });
  core.comets.addDataSource({ url: stream ? `${remote}/mpc/CometEls.txt` : abs(`${SKY}/CometEls.txt`), key: 'mpc_comets' });
  // no satellites: the bundled orbits are from 2020 and would put every one in the wrong place
  if (!stream) return;
  core.dss.addDataSource({ url: `${remote}/surveys/dss` });
  // Gaia's properties need a line the data server's copy lacks: Astrocontroller serves them and redirects the tiles
  core.stars.addDataSource({ url: abs('api/stellarium/gaia'), key: 'gaia' });
  core.planets.addDataSource({ url: `${remote}/surveys/moon-normal`, key: 'moon-normal' });
  for (const p of PLANET_TEXTURES) core.planets.addDataSource({ url: `${remote}/surveys/${p}`, key: p });
}

function setup() {
  const core = stel.core;
  stel.setFont('regular', `${VENDOR}/fonts/Roboto-Regular.ttf`).catch(() => {});
  stel.setFont('bold', `${VENDOR}/fonts/Roboto-Bold.ttf`).catch(() => {});
  addSources();
  applySite();
  setNow();
  core.time_speed = 1;
  layer = stel.createLayer({ id: 'astrocontroller', z: 7, visible: true });
  maskObj = stel.createObj('geojson', { frame: stel.FRAME_OBSERVED });
  maskObj.frame = stel.FRAME_OBSERVED;
  layer.add(maskObj);
  overlay = stel.createObj('geojson', {});
  layer.add(overlay);
  applyOpts();
  // start facing south (north from the southern hemisphere), a third of the way up
  const south = (cfg()?.site?.lat ?? 0) >= 0 ? 180 : 0;
  stel.lookAt(stel.s2c(south * stel.D2R, 30 * stel.D2R), 0);
  core.fov = START_FOV_DEG * stel.D2R;
  stel.change((_obj, attr) => {
    if (attr === 'selection') onSelection();
  });
  // the obstruction map and the plan load with the tab ('tab' below), which is what brought the engine up
  if (pendingView) {
    const v = pendingView;
    pendingView = null;
    show(v);
  }
  startTick();
}

function applySite() {
  const s = cfg()?.site;
  if (!stel || !s) {
    $('#sky-site').textContent = s ? '' : 'no site: set OBSERVER_LATITUDE / OBSERVER_LONGITUDE in .env';
    return;
  }
  const obs = stel.core.observer;
  obs.latitude = s.lat * stel.D2R;
  obs.longitude = s.lon * stel.D2R;
  obs.elevation = s.elev ?? 0;
  $('#sky-site').textContent = `${s.lat.toFixed(3)}°, ${s.lon.toFixed(3)}° · ${tz()}`;
}

function applyOpts() {
  if (!stel) return;
  const core = stel.core;
  core.constellations.lines_visible = opts.constellations;
  core.constellations.labels_visible = opts.constellations;
  core.atmosphere.visible = opts.atmosphere;
  core.landscapes.visible = opts.ground !== 'none';
  if (opts.ground !== 'none') core.landscapes.current_id = opts.ground;
  core.lines.azimuthal.visible = opts.azGrid;
  core.lines.equatorial.visible = opts.eqGrid;
  core.dsos.visible = opts.dsos;
  if (core.dss) core.dss.visible = opts.dss && !!cfg()?.stream;
  renderMask();
  for (const el of $$('#sky-opts [data-opt]')) {
    const k = el.dataset.opt;
    if (el.type === 'checkbox') el.checked = !!opts[k];
    else el.value = opts[k];
  }
  $('#sky-opt-dss').hidden = !cfg()?.stream;
}

// ---------------------------------------------------------------- time, in the site's zone

/** Milliseconds the zone is ahead of UTC at an instant. */
function zoneOffsetMs(t, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(t).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}
/** "YYYY-MM-DDTHH:MM" on the site's wall clock → an instant. */
function fromSiteWall(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let t = wall - zoneOffsetMs(wall, tz());
  t = wall - zoneOffsetMs(t, tz());
  return t;
}
/** An instant → "YYYY-MM-DDTHH:MM" on the site's wall clock, for the datetime input. */
function toSiteWall(t) {
  return new Date(t + zoneOffsetMs(t, tz())).toISOString().slice(0, 16);
}

const skyTime = () => stel.MJD2date(stel.core.observer.utc).getTime();
function setTime(t) {
  stel.core.observer.utc = stel.date2MJD(t);
  renderClock(true);
}
const setNow = () => setTime(Date.now());

function renderClock(force) {
  const t = skyTime();
  const live = Math.abs(t - Date.now()) < LIVE_MS;
  const f = new Intl.DateTimeFormat([], { timeZone: tz(), weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('#sky-clock').textContent = f.format(t);
  $('#sky-live').hidden = !live;
  $('#sky-now').classList.toggle('primary', !live);
  const input = $('#sky-time');
  if (force || document.activeElement !== input) input.value = toSiteWall(t);
}

// ---------------------------------------------------------------- the overlay: frames, telescope

const teleFov = () => state.telescope?.fov?.tele ?? TELE_FOV;
const wideFov = () => state.telescope?.fov?.wide ?? WIDE_FOV;

/** Where the telescope is pointed, as an ICRF vector, while it is tracking or slewing to its last GoTo. */
function scopeVector() {
  const t = state.telescope;
  const p = t?.pointing;
  if (!p) return null;
  const active = t.tracking?.state === 'running' || ['running', 'plate_solving'].includes(t.goto?.state) || /goto/i.test(t.operation ?? '');
  if (!active) return null;
  if (p.body) {
    const o = stel.getObj(`NAME ${p.body[0].toUpperCase()}${p.body.slice(1)}`);
    const v = o?.getInfo('radec');
    return v ? norm(v) : null;
  }
  return Number.isFinite(p.raHours) && Number.isFinite(p.decDeg) ? raDecVec(p.raHours, p.decDeg) : null;
}

/** Where the frame is drawn: the view's middle in Frame mode, the selection otherwise. */
function frameVector() {
  if (framing) return frameCenter;
  return sel ? selVector() : null;
}
function selVector() {
  if (!sel) return null;
  // planets move, and the engine knows where they are now
  const v = sel.obj && !sel.marker ? sel.obj.getInfo('radec') : null;
  return v ? norm(v) : raDecVec(sel.raHours, sel.decDeg);
}

function renderOverlay() {
  const features = [];
  const f = frameVector();
  if (f && opts.tele) {
    const fov = teleFov();
    features.push(...rectFeatures(frameCorners(f, fov.h, fov.v), COLORS.frame, { dashed: true, title: framing ? 'frame' : undefined }));
  }
  if (f && opts.wide) {
    const fov = wideFov();
    features.push(...rectFeatures(frameCorners(f, fov.h, fov.v), COLORS.wide, { dashed: true, width: 1 }));
  }
  if (opts.night && nightBlocks.length) features.push(...nightFeatures());
  const s = opts.scope ? scopeVector() : null;
  if (s) {
    const fov = teleFov();
    features.push(...rectFeatures(frameCorners(s, fov.h, fov.v), COLORS.scope, { width: 2, title: `telescope · ${state.telescope.pointing.target}` }));
  }
  overlay.data = { type: 'FeatureCollection', features };
}

/** Frame mode follows the user's panning but holds the frame on the sky while the Earth turns. */
function trackFrame() {
  if (!framing) return;
  // the user moved the view since the last tick: the frame goes where they put it
  if (!frameCenter || !lastObserved || sepDeg(viewObserved(), lastObserved) > 1e-3) frameCenter = viewCenter();
  // otherwise only the sky turned: turn the view with it
  else lookAtSky(frameCenter, 0);
  lastObserved = observedOf(frameCenter);
}

function tick() {
  if (!stel || !isPanelActive('stellarium')) return;
  trackFrame();
  renderOverlay();
  renderClock(false);
  const now = Date.now();
  if (now - lastCard > CARD_MS) {
    lastCard = now;
    renderCard();
  }
}
function startTick() {
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, TICK_MS);
}

// ---------------------------------------------------------------- the obstruction map and the plan

async function loadMask() {
  if (!stel) return;
  const features = [];
  try {
    const r = await api('horizon');
    const prof = Array.isArray(r.mask?.profile) ? r.mask.profile : [];
    let run = null;
    const runs = [];
    prof.forEach((v, k) => {
      if (v == null || v <= 0) return void (run = null);
      if (!run) runs.push((run = []));
      run.push([k, v], [k + 1, v]);
    });
    // Every edge is drawn as a great circle, so a long one cuts across the sky (a run 200° wide closed by
    // one horizon edge went over the zenith and painted the open sky). Short pieces with the horizon
    // walked in 1° steps keep every edge where the map has it.
    const pieces = runs.flatMap((r) => {
      const out = [];
      for (let i = 0; i < r.length; i += MASK_PIECE_DEG * 2) out.push(r.slice(i, i + MASK_PIECE_DEG * 2));
      return out;
    });
    for (const top of pieces) {
      const from = top[0][0];
      const to = top[top.length - 1][0];
      // the engine fills the side of a ring its winding puts inside: this order (along the horizon,
      // back along the obstruction's top) is the obstruction itself, not the open sky
      const ring = [];
      for (let az = from; az <= to; az++) ring.push([az, -1]);
      ring.push(...top.slice().reverse(), [from, -1]);
      features.push({ type: 'Feature', properties: { fill: COLORS.mask, 'fill-opacity': 0.55, stroke: COLORS.minAlt, 'stroke-width': 1, 'stroke-opacity': 0.6 }, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
  } catch {
    // no site or no map: the minimum-altitude line alone
  }
  const min = state.config?.minAltitude;
  if (Number.isFinite(min) && min > 0) {
    const line = [];
    for (let az = 0; az <= 360; az += 5) line.push([az, min]);
    features.push({ type: 'Feature', properties: { stroke: COLORS.minAlt, 'stroke-width': 1, 'stroke-opacity': 0.55 }, geometry: { type: 'LineString', coordinates: line } });
  }
  maskFeatures = features;
  renderMask();
}

function renderMask() {
  if (!maskObj) return;
  maskObj.frame = stel.FRAME_OBSERVED;
  maskObj.data = { type: 'FeatureCollection', features: opts.mask ? maskFeatures : [] };
}

let planSeq = 0;
async function loadPlanMarkers() {
  if (!stel || !layer) return;
  const mine = ++planSeq;
  for (const [, m] of markers) if (m.kind === 'plan') layer.remove(m.obj);
  for (const [k, m] of [...markers]) if (m.kind === 'plan') markers.delete(k);
  if (!opts.plan) return;
  try {
    const r = await api('plan');
    if (mine !== planSeq) return;
    for (const t of (r.targets ?? []).filter((x) => !x.gated && Number.isFinite(x.raHours))) {
      const size = Math.max(0.3, (Number(t.sizeArcmin) || 0) / 60) * stel.D2R;
      const obj = layer.add('circle', { pos: [...raDecVec(t.raHours, t.decDeg), 0], frame: stel.FRAME_ICRF, size: [size, size], color: COLORS.plan, border_color: COLORS.planBorder, label: t.displayName ?? t.name });
      markers.set(obj.v, { kind: 'plan', obj, target: { name: t.gotoName ?? t.name, display: t.displayName ?? t.name, raHours: t.raHours, decDeg: t.decDeg, type: t.type, note: t.bestTime ? `best ${t.bestTime}` : '' } });
    }
  } catch {
    // the plan needs the site; without it there is nothing to mark
  }
}

const hhmm = (t) => new Intl.DateTimeFormat([], { timeZone: tz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);

/**
 * The night plan (Plan tab): each scheduled target as a circle labelled with its blocks' times,
 * the order of the night as a path from one to the next, and (in renderOverlay) the tele frame on
 * whichever target the plan has at the sky's time — move the clock to watch the night play out.
 */
let nightSeq = 0;
export async function loadNightPlan() {
  if (!stel || !layer) return;
  const mine = ++nightSeq;
  let blocks = [];
  if (opts.night) {
    try {
      const r = await api('plan/tonight');
      blocks = (r.plan?.blocks ?? []).filter((b) => b.kind === 'target' && b.target && Number.isFinite(b.target.raHours));
    } catch {
      // no site, or no plan: nothing to draw
    }
  }
  if (mine !== nightSeq) return;
  for (const [k, m] of [...markers]) {
    if (m.kind !== 'night') continue;
    layer.remove(m.obj);
    markers.delete(k);
  }
  nightBlocks = blocks.map((b) => ({ start: b.start, end: b.end, display: b.target.displayName, vec: raDecVec(b.target.raHours, b.target.decDeg), past: !!b.past }));
  const byTarget = new Map();
  for (const b of blocks) {
    const g = byTarget.get(b.target.key) ?? { t: b.target, times: [] };
    g.times.push(`${hhmm(b.start)}–${hhmm(b.end)}`);
    byTarget.set(b.target.key, g);
  }
  const size = Math.max(teleFov().h, teleFov().v) * stel.D2R;
  for (const { t, times } of byTarget.values()) {
    const obj = layer.add('circle', { pos: [...raDecVec(t.raHours, t.decDeg), 0], frame: stel.FRAME_ICRF, size: [size, size], color: COLORS.night, border_color: COLORS.nightBorder, label: `${t.displayName} · ${times.join(', ')}` });
    markers.set(obj.v, { kind: 'night', obj, target: { name: t.gotoName, display: t.displayName, raHours: t.raHours, decDeg: t.decDeg, note: `night plan ${times.join(', ')}${t.source === 'filler' ? ' (filler)' : ''}` } });
  }
}

function nightFeatures() {
  const out = [];
  const props = { stroke: COLORS.nightLine, 'stroke-width': 1.2, 'stroke-opacity': 0.7 };
  for (let i = 1; i < nightBlocks.length; i++) {
    const a = nightBlocks[i - 1].vec;
    const b = nightBlocks[i].vec;
    if (sepDeg(a, b) < 0.05) continue;
    out.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: Array.from({ length: 13 }, (_, k) => lonLat(slerp(a, b, k / 12))) } });
  }
  const t = skyTime();
  const now = nightBlocks.find((b) => b.start <= t && b.end > t);
  if (now) {
    const fov = teleFov();
    out.push(...rectFeatures(frameCorners(now.vec, fov.h, fov.v), COLORS.nightLine, { width: 2, title: `plan ${hhmm(t)} · ${now.display}` }));
  }
  return out;
}

/** A marker for a target the engine's catalogs do not hold (Sh2, LDN, a bare position…). */
function dropPick(t) {
  if (pickMarker) {
    layer.remove(pickMarker.obj);
    markers.delete(pickMarker.obj.v);
  }
  const size = 0.4 * stel.D2R;
  const obj = layer.add('circle', { pos: [...raDecVec(t.raHours, t.decDeg), 0], frame: stel.FRAME_ICRF, size: [size, size], color: COLORS.pick, border_color: COLORS.pickBorder, label: t.display ?? t.name ?? '' });
  pickMarker = { kind: 'pick', obj, target: t };
  markers.set(obj.v, pickMarker);
  return obj;
}

// ---------------------------------------------------------------- the selection

const clean = (d) => {
  try {
    return stel.designationCleanup(d, 1);
  } catch {
    return d.replace(/^NAME /, '');
  }
};

function describe(obj) {
  const m = markers.get(obj.v);
  if (m) return { ...m.target, obj, marker: true };
  const v = obj.getInfo('radec');
  if (!v) return null;
  const des = (obj.designations?.() ?? []).filter((d) => !d.startsWith('CON '));
  const named = des.find((d) => d.startsWith('NAME '));
  const catalog = des.find((d) => CATALOG_NAME.test(d));
  const display = named ? clean(named) : des[0] ? clean(des[0]) : 'Selected point';
  let type = '';
  try {
    type = stel.otypeToStr(obj.type) || '';
  } catch {
    // no type for this object
  }
  const vmag = obj.getInfo('vmag');
  const pos = vecRaDec(v);
  // the Sun, the Moon, planets, asteroids and comets move: no fixed position for the program
  const moving = SOLAR_SYSTEM.test(String(obj.type ?? ''));
  return { name: catalog ?? (named ? clean(named) : des[0] ? clean(des[0]) : ''), display, aka: catalog && named ? clean(catalog) : '', type, vmag: Number.isFinite(vmag) ? vmag : null, moving, ...pos, obj };
}

/** Stellarium Web Engine's object types for solar-system bodies (Sun, Moon, planets, minor planets, comets). */
const SOLAR_SYSTEM = /^(Sun|Moo|Pla|MPl|Com|SSO|Ast)$/;

function onSelection() {
  const obj = stel.core.selection;
  sel = obj ? describe(obj) : framing ? sel : null;
  lastCard = 0;
  renderCard();
  closeProgramForm();
}

// ---------------------------------------------------------------- add to program

/** What the program gets: the composed frame's centre in Frame mode (when off the object), otherwise the selection. */
function programTarget() {
  const a = aim();
  if (!a) return null;
  const custom = framing && (!a.name || a.offset > 0.05);
  return { name: a.name, display: a.display, raHours: a.raHours, decDeg: a.decDeg, custom };
}

function closeProgramForm() {
  const box = $('#sky-prog');
  box.hidden = true;
  box.replaceChildren();
  $('#sky-prog-btn').setAttribute('aria-expanded', 'false');
}

async function openProgramForm() {
  const box = $('#sky-prog');
  const t = programTarget();
  if (!t) return;
  $('#sky-prog-btn').setAttribute('aria-expanded', 'true');
  box.hidden = false;
  box.innerHTML = '<span class="muted small">checking the program…</span>';
  const entry = t.custom ? null : await findInProgram(t.name, t.display);
  if (box.hidden) return; // closed while it looked
  const why = sel?.moving && !framing ? `${sel.display} moves across the sky: the program plans fixed positions (ask the agent to image it instead)` : '';
  box.innerHTML = `${t.custom ? `<span class="muted small">A custom target at the frame centre${t.name ? ` (named ${esc(t.name)})` : ''}.</span>` : ''}${why ? `<span class="muted small">${esc(why)}</span>` : ''}${programFormHtml(entry, { disabled: why, compact: true })}`;
}

wireProgramForms($('#sky-prog'), () => programTarget(), () => openProgramForm());

const fmtRa = (h) => {
  const s = Math.round((((h % 24) + 24) % 24) * 3600);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m${String(s % 60).padStart(2, '0')}s`;
};
const fmtDec = (d) => {
  const s = Math.round(Math.abs(d) * 3600);
  return `${d < 0 ? '−' : '+'}${String(Math.floor(s / 3600)).padStart(2, '0')}°${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}′${String(s % 60).padStart(2, '0')}″`;
};

/** What GoTo and the agent get: the frame's centre in Frame mode, otherwise the selection. */
function aim() {
  if (framing && frameCenter) {
    const p = vecRaDec(frameCenter);
    const offset = sel ? sepDeg(frameCenter, selVector()) : null;
    return { name: sel && offset < 2 ? sel.name : '', display: sel && offset < 2 ? sel.display : 'Frame centre', ...p, offset, vec: frameCenter };
  }
  if (!sel) return null;
  const v = selVector();
  return { name: sel.name, display: sel.display, ...vecRaDec(v), offset: 0, vec: v };
}

function renderCard() {
  const card = $('#sky-card');
  const a = stel ? aim() : null;
  if (!a) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const { alt, az } = vecAltAz(a.vec);
  const low = alt < GOTO_MIN_ALT;
  const meta = sel ? [sel.type, sel.vmag != null ? `mag ${sel.vmag.toFixed(1)}` : '', sel.aka, sel.note].filter(Boolean).join(' · ') : '';
  const framed = framing && a.offset != null && sel ? `<div class="small">frame centre ${a.offset < 0.01 ? 'on' : `${(a.offset * 60).toFixed(0)}′ from`} ${esc(sel.display)}</div>` : '';
  $('#sky-card-body').innerHTML = `<b>${esc(framing && !a.name ? 'Frame centre' : a.display)}</b>${meta ? `<div class="muted small">${esc(meta)}</div>` : ''}
    <div class="small">RA ${fmtRa(a.raHours)} · Dec ${fmtDec(a.decDeg)} <span class="muted">J2000</span></div>
    <div class="small${low ? ' sky-low' : ''}">alt ${alt.toFixed(1)}° · az ${az.toFixed(1)}°${low ? ' · below the horizon' : ''}</div>${framed}`;
  const go = $('#sky-goto');
  go.disabled = low;
  go.title = low ? 'below the horizon' : framing ? 'GoTo the frame centre' : 'GoTo the selection';
  go.textContent = framing ? 'GoTo frame' : 'GoTo';
}

// ---------------------------------------------------------------- actions

async function gotoAim(btn) {
  const a = aim();
  if (!a) return;
  const label = a.name || a.display;
  const where = framing ? ` framed at RA ${fmtRa(a.raHours)} Dec ${fmtDec(a.decDeg)}` : '';
  if (!confirm(`Slew the telescope to ${label}${where}? (calibrates first, then GoTo and tracking)`)) return;
  btn.disabled = true;
  btn.classList.add('busy');
  toast(`GoTo ${label}: calibrating and slewing…`);
  try {
    // a planet goes by name (it moves); everything else by the position picked, with its name for the session folder
    await control({ action: 'goto_sky', name: a.name || undefined, raHours: a.raHours, decDeg: a.decDeg }, `GoTo ${label}`);
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}

function askAgent() {
  const a = aim();
  if (!a) return;
  const pos = `RA ${fmtRa(a.raHours)} Dec ${fmtDec(a.decDeg)} (J2000)`;
  if (framing && a.offset > 0.05) {
    return draft(`${imagingRequest(a.name || pos)} Frame it as I composed it in the Stellarium tab: centre the tele frame at ${pos}${a.name ? `, ${(a.offset * 60).toFixed(0)}′ off ${a.name}` : ''} (goto_target with ra_hours/dec_deg and name="${a.name || 'Custom'}").`);
  }
  draft(imagingRequest(a.name ? (sel?.marker || !sel?.obj ? `${a.name} (${pos})` : a.name) : pos));
}

function setFraming(on) {
  framing = on;
  $('#sky-frame').classList.toggle('primary', on);
  $('#sky-frame').setAttribute('aria-pressed', String(on));
  $('#sky-canvas-wrap').classList.toggle('framing', on);
  if (on) {
    // point at the selection without locking on it, so the view can be panned to compose
    const v = selVector();
    if (v) lookAtSky(v, 0);
    frameCenter = v ?? null;
    lastObserved = null;
    const fov = teleFov();
    stel.zoomTo(Math.max(fov.h, fov.v) * TARGET_FOV_FACTOR * 0.6 * stel.D2R, 0.5);
  }
  renderCard();
}

/** Select, centre and frame a target; a target the engine does not know gets a marker. */
function show(t) {
  let obj = null;
  for (const q of [t.name, t.name && `NAME ${t.name}`].filter(Boolean)) {
    const o = stel.getObj(q);
    const v = o?.getInfo('radec');
    // the engine's search is loose: a name that lands far from the position given is a different object
    if (o && v && (!Number.isFinite(t.raHours) || sepDeg(v, raDecVec(t.raHours, t.decDeg)) < SAME_PLACE_DEG)) {
      obj = o;
      break;
    }
  }
  if (!obj && Number.isFinite(t.raHours) && Number.isFinite(t.decDeg)) obj = dropPick({ name: t.name ?? '', display: t.display ?? t.name ?? 'Target', raHours: t.raHours, decDeg: t.decDeg, type: t.type ?? '' });
  if (!obj) {
    toast(`${t.name}: not found in the sky`, true);
    return;
  }
  if (framing) setFraming(false);
  stel.core.selection = obj;
  stel.pointAndLock(obj, 1);
  const fov = Number.isFinite(t.fovDeg) ? t.fovDeg : Math.max(teleFov().h, teleFov().v) * TARGET_FOV_FACTOR;
  stel.zoomTo(fov * stel.D2R, 1);
}

/** Opens the Stellarium tab on a target: {name, raHours?, decDeg?, display?, time?, fovDeg?}. */
export async function viewInStellarium(t) {
  showScreen('stellarium');
  if (!stel) {
    pendingView = t;
    try {
      await ensureEngine();
    } catch (e) {
      toast(e.message, true);
    }
    return;
  }
  if (t.time) setTime(new Date(t.time).getTime());
  show(t);
}

async function search(q) {
  q = q.trim();
  if (!q) return;
  await ensureEngine();
  for (const n of [q, `NAME ${q}`]) {
    const o = stel.getObj(n);
    if (o?.getInfo('radec')) return show({ name: n });
  }
  try {
    const d = await api(`catalog/object?id=${encodeURIComponent(q)}`);
    show({ name: d.gotoName ?? d.id, display: d.gotoName ?? d.id, raHours: d.raHours, decDeg: d.decDeg, type: d.typeName });
  } catch {
    toast(`"${q}" is not in the sky or the database`, true);
  }
}

function centerOnScope() {
  const v = scopeVector();
  if (!v) return toast('The telescope is not tracking a GoTo target', true);
  if (framing) setFraming(false);
  lookAtSky(v, 1);
}

// ---------------------------------------------------------------- wiring

$('#sky-search').addEventListener('submit', (e) => {
  e.preventDefault();
  search($('#sky-q').value);
});
$('#sky-now').onclick = () => stel && setNow();
$('#sky-time').onchange = (e) => {
  const t = fromSiteWall(e.target.value);
  if (stel && t != null) setTime(t);
};
for (const [id, h] of [['#sky-back', -1], ['#sky-fwd', 1]]) $(id).onclick = () => stel && setTime(skyTime() + h * 3600_000);
$('#sky-goto').onclick = (e) => gotoAim(e.currentTarget);
$('#sky-agent').onclick = askAgent;
// the selection, or the frame centre (by its position) when Frame mode is off it
$('#sky-research').onclick = (e) => {
  const a = aim();
  if (a) askResearch({ name: a.name, display: a.display, raHours: a.raHours, decDeg: a.decDeg }, e.currentTarget);
};
$('#sky-prog-btn').onclick = () => ($('#sky-prog').hidden ? openProgramForm() : closeProgramForm());
$('#sky-frame').onclick = () => stel && setFraming(!framing);
$('#sky-scope').onclick = () => stel && centerOnScope();
$('#sky-card-close').onclick = () => {
  closeProgramForm();
  if (framing) setFraming(false);
  if (stel) stel.core.selection = null;
  sel = null;
  renderCard();
};
$('#sky-opts').addEventListener('change', (e) => {
  const el = e.target.closest('[data-opt]');
  if (!el) return;
  opts[el.dataset.opt] = el.type === 'checkbox' ? el.checked : el.value;
  saveOpts();
  if (el.dataset.opt === 'plan') loadPlanMarkers();
  if (el.dataset.opt === 'night') loadNightPlan();
  applyOpts();
});

// Tonight's plan and the Database open targets here: any [data-sky] button carries name, ra and dec.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sky]');
  if (!b) return;
  const ra = Number(b.dataset.ra);
  const dec = Number(b.dataset.dec);
  viewInStellarium({ name: b.dataset.sky, display: b.dataset.display || b.dataset.sky, raHours: Number.isFinite(ra) && b.dataset.ra !== '' ? ra : undefined, decDeg: Number.isFinite(dec) && b.dataset.dec !== '' ? dec : undefined });
});

on('tab', (name) => {
  if (name !== 'stellarium') return;
  ensureEngine()
    .then(() => {
      loadMask();
      loadPlanMarkers();
      loadNightPlan();
    })
    .catch(() => {});
});
// the plan was solved again: the overlay follows it
on('plan-changed', () => {
  if (stel && isPanelActive('stellarium')) loadNightPlan();
});
on('config', () => {
  applySite();
  if (stel) applyOpts();
});

/** The agent's show_in_stellarium. */
export function onStellariumMessage(m) {
  viewInStellarium({ name: m.name, raHours: m.raHours, decDeg: m.decDeg, time: m.time, fovDeg: m.fovDeg });
}
