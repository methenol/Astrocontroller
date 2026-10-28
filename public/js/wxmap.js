/**
 * A small slippy-map view for weather imagery, without a map library: a square of Web Mercator
 * tiles centred on the site, a base map under a stack of overlay frames (radar or satellite times)
 * that play as a loop, and labels on top. Every layer is positioned in percent, so the view scales
 * with its box and needs no resize handling.
 */

const TILE = 256;
/** The view spans this many world pixels across at its zoom: two tiles. */
const SPAN = 512;
const FRAME_MS = 450;
const LAST_FRAME_HOLD = 4;

// Esri's dark canvas needs no key (CARTO's basemaps now watermark every tile without one); note z/y/x order.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const BASE = (z, x, y) => `${ESRI}/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`;
const LABELS = (z, x, y) => `${ESRI}/World_Dark_Gray_Reference/MapServer/tile/${z}/${y}/${x}`;

/** The site in world pixels at zoom z. */
function worldPx(z, lat, lon) {
  const n = TILE * 2 ** z;
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
}

/** One layer of tiles for the view: a div of <img>s placed in percent. */
function tileLayer(z, lat, lon, url, cls) {
  const div = document.createElement('div');
  div.className = `wx-layer ${cls ?? ''}`;
  const c = worldPx(z, lat, lon);
  const left = c.x - SPAN / 2;
  const top = c.y - SPAN / 2;
  const n = 2 ** z;
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + SPAN - 1) / TILE); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + SPAN - 1) / TILE); tx++) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.style.left = `${((tx * TILE - left) / SPAN) * 100}%`;
      img.style.top = `${((ty * TILE - top) / SPAN) * 100}%`;
      img.style.width = img.style.height = `${(TILE / SPAN) * 100}%`;
      // a missing tile (no coverage, a frame the server skipped) shows the map under it, not a broken icon
      img.onerror = () => (img.style.visibility = 'hidden');
      img.src = url(z, ((tx % n) + n) % n, ty);
      div.append(img);
    }
  }
  return div;
}

export class WxMap {
  /** @param fig the <figure> with a .wx-map-view and a [data-time] caption */
  constructor(fig, { minZoom, maxZoom, zoom }) {
    this.fig = fig;
    this.view = fig.querySelector('.wx-map-view');
    this.timeEl = fig.querySelector('[data-time]');
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
    this.zoom = zoom;
    this.site = null;
    this.frames = [];
    this.layers = [];
    this.index = 0;
    this.hold = 0;
    this.timer = null;
    this.playing = true;
    for (const b of fig.querySelectorAll('[data-zoom]')) b.onclick = () => this.setZoom(this.zoom + Number(b.dataset.zoom));
  }

  /** frames: [{ label, url(z, x, y) }], oldest first; the last one is shown when paused. */
  show(site, frames, note = '') {
    this.site = site;
    this.frames = frames;
    this.note = note;
    this.render();
  }

  setZoom(z) {
    const next = Math.max(this.minZoom, Math.min(this.maxZoom, z));
    if (next === this.zoom) return;
    this.zoom = next;
    this.render();
  }

  message(text) {
    this.stop();
    for (const el of [...this.view.querySelectorAll('.wx-layer, .wx-map-msg')]) el.remove();
    const m = document.createElement('div');
    m.className = 'wx-map-msg muted small';
    m.textContent = text;
    this.view.append(m);
    this.timeEl.textContent = '–';
  }

  render() {
    this.stop();
    for (const el of [...this.view.querySelectorAll('.wx-layer, .wx-map-msg')]) el.remove();
    if (!this.site) return;
    const { lat, lon } = this.site;
    const pin = this.view.querySelector('.wx-pin');
    this.view.insertBefore(tileLayer(this.zoom, lat, lon, BASE, 'base'), pin);
    this.layers = this.frames.map((f) => {
      const l = tileLayer(this.zoom, lat, lon, f.url, 'frame');
      l.hidden = true;
      this.view.insertBefore(l, pin);
      return l;
    });
    this.view.insertBefore(tileLayer(this.zoom, lat, lon, LABELS, 'labels'), pin);
    for (const b of this.fig.querySelectorAll('[data-zoom]')) b.disabled = this.zoom + Number(b.dataset.zoom) < this.minZoom || this.zoom + Number(b.dataset.zoom) > this.maxZoom;
    if (!this.frames.length) {
      this.timeEl.textContent = this.note || 'no imagery';
      return;
    }
    this.index = this.frames.length - 1;
    this.paint();
    this.play(this.playing);
  }

  paint() {
    this.layers.forEach((l, i) => (l.hidden = i !== this.index));
    const f = this.frames[this.index];
    this.timeEl.textContent = `${f?.label ?? ''}${this.index === this.frames.length - 1 ? ' (latest)' : ''}${this.note ? ` · ${this.note}` : ''}`;
  }

  play(on) {
    this.playing = on;
    this.stop();
    if (!on || this.frames.length < 2) {
      if (!on && this.frames.length) {
        this.index = this.frames.length - 1;
        this.paint();
      }
      return;
    }
    this.timer = setInterval(() => {
      // linger on the latest frame so the loop reads as "this is now"
      if (this.index === this.frames.length - 1 && this.hold++ < LAST_FRAME_HOLD) return;
      this.hold = 0;
      this.index = (this.index + 1) % this.frames.length;
      this.paint();
    }, FRAME_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
