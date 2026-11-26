/**
 * The Pointing group's own behaviour on top of its tool forms: the Sun asked about before any
 * tool points at it, an object to follow picked by drawing a box round it on the main view, and
 * the Plan tab's next mosaic panel sent to GoTo under its own name.
 */
import { $, toast } from './dom.js';
import { on } from './bus.js';
import { state } from './state.js';
import { beforeRun, runTool } from './tools.js';

const SUN_ASK = 'Is the solar filter fitted on the tele lens?\n\nPointing at the Sun without it destroys the camera sensor and can start a fire.';

beforeRun('track_sun_moon', (a) => {
  if (a.action !== 'start' || a.body !== 'sun') return true;
  if (!confirm(SUN_ASK)) return false;
  a.solar_filter_confirmed = true;
  return true;
});
beforeRun('goto_target', (a) => {
  if (!a.name && (a.ra_hours === undefined || a.dec_deg === undefined)) {
    toast('GoTo: give a target name, or RA and Dec', true);
    return false;
  }
  if (!/^\s*(the\s+)?sun\s*$/i.test(a.name ?? '')) return true;
  if (!confirm(SUN_ASK)) return false;
  a.solar_filter_confirmed = true;
  return true;
});

// ---- track an object: a box drawn on the main view, in the 1920×1080 frame the telescope tracks in

const FRAME_W = 1920;
const FRAME_H = 1080;
const MIN_BOX_PX = 12;
const fig = $('#view-main');
let layer = null;

function endPick() {
  layer?.remove();
  layer = null;
  fig.classList.remove('picking');
}

/** A point on the screen in frame pixels, through the image's letterbox (object-fit: contain) and any zoom. */
function framePoint(img, x, y) {
  const r = img.getBoundingClientRect();
  const nw = img.naturalWidth || FRAME_W;
  const nh = img.naturalHeight || FRAME_H;
  const k = Math.min(r.width / nw, r.height / nh);
  const left = r.left + (r.width - nw * k) / 2;
  const top = r.top + (r.height - nh * k) / 2;
  const fx = ((x - left) / (nw * k)) * FRAME_W;
  const fy = ((y - top) / (nh * k)) * FRAME_H;
  return { x: Math.max(0, Math.min(FRAME_W, fx)), y: Math.max(0, Math.min(FRAME_H, fy)) };
}

function startPick() {
  const cam = state.mainSrc;
  if (cam !== 'tele' && cam !== 'wide') return toast('Show the tele or the wide in the main view, then draw the box on it', true);
  if (!$('#img-main').getAttribute('src')) return toast('No picture in the main view yet', true);
  endPick();
  fig.classList.add('picking');
  layer = document.createElement('div');
  layer.className = 'pick-layer';
  layer.innerHTML = '<div class="pick-hint">Drag a box round the object · Esc cancels</div><div class="pick-box" hidden></div>';
  fig.append(layer);
  fig.scrollIntoView?.({ block: 'nearest' });
  const box = $('.pick-box', layer);
  let start = null;
  // the view's own gestures (tap to enlarge, pinch) never see the drawing
  const stop = (e) => {
    e.stopPropagation();
    e.preventDefault();
  };
  layer.addEventListener('pointerdown', (e) => {
    stop(e);
    try {
      layer.setPointerCapture(e.pointerId);
    } catch {
      // best effort
    }
    const lr = layer.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, lx: lr.left, ly: lr.top };
    Object.assign(box.style, { left: `${e.clientX - lr.left}px`, top: `${e.clientY - lr.top}px`, width: '0px', height: '0px' });
    box.hidden = false;
  });
  layer.addEventListener('pointermove', (e) => {
    if (!start) return;
    stop(e);
    Object.assign(box.style, {
      left: `${Math.min(start.x, e.clientX) - start.lx}px`,
      top: `${Math.min(start.y, e.clientY) - start.ly}px`,
      width: `${Math.abs(e.clientX - start.x)}px`,
      height: `${Math.abs(e.clientY - start.y)}px`,
    });
  });
  const lift = async (e) => {
    if (!start) return;
    stop(e);
    const s = start;
    start = null;
    if (e.type === 'pointercancel' || Math.abs(e.clientX - s.x) < MIN_BOX_PX || Math.abs(e.clientY - s.y) < MIN_BOX_PX) {
      box.hidden = true;
      return;
    }
    // the main view changed camera under the box: it means nothing now
    if (state.mainSrc !== cam) {
      endPick();
      return toast('The main view changed camera: draw the box again', true);
    }
    const img = $('#img-main');
    const a = framePoint(img, Math.min(s.x, e.clientX), Math.min(s.y, e.clientY));
    const b = framePoint(img, Math.max(s.x, e.clientX), Math.max(s.y, e.clientY));
    endPick();
    const args = { action: 'start', camera: cam, x: Math.round(a.x), y: Math.round(a.y), width: Math.max(1, Math.round(b.x - a.x)), height: Math.max(1, Math.round(b.y - a.y)) };
    await runTool('track_object', args, { label: `Track object (${cam})`, button: $('#btn-track-pick'), quiet: true });
  };
  layer.addEventListener('pointerup', lift);
  layer.addEventListener('pointercancel', lift);
  for (const t of ['click', 'dblclick']) layer.addEventListener(t, stop);
}

$('#btn-track-pick').onclick = startPick;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && layer) endPick();
});

// ---- the next mosaic panel, to GoTo by its own name (how its sessions are counted)

let panel = null;
on('tool-done', ({ name, result }) => {
  if (name !== 'get_next_mosaic_panel') return;
  const g = result?.json?.goto;
  panel = g && typeof g.ra_hours === 'number' && typeof g.dec_deg === 'number' && g.name ? { name: g.name, ra: g.ra_hours, dec: g.dec_deg } : null;
  const b = $('#btn-mosaic-goto');
  b.hidden = !panel;
  if (panel) b.textContent = `GoTo ${panel.name}`;
});
$('#btn-mosaic-goto').onclick = (e) => {
  if (!panel || !confirm(`GoTo the panel ${panel.name}?`)) return;
  void runTool('goto_target', { name: panel.name, ra_hours: panel.ra, dec_deg: panel.dec }, { button: e.currentTarget, label: `GoTo ${panel.name}` });
};
