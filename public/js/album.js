/** The telescope's album (read from its SD card): browse, download into the library, delete to free space, ask the agent. */
import { $, esc, lightbox, toast, baseName } from './dom.js';
import { api } from './api.js';
import { on } from './bus.js';
import { state, isPanelActive } from './state.js';
import { draft } from './chat.js';

const TYPE_NAMES = { 0: 'all', 1: 'photos', 2: 'videos', 3: 'burst', 4: 'astro', 5: 'panorama' };
let page = 0;
let seq = 0;

const deviceFile = (p) => `api/device-file?path=${encodeURIComponent(p)}`;

function tile(m) {
  const file = String(m.filePath ?? '');
  const thumb = m.thumbnailPath || file;
  const label = m.astroTargetName || baseName(file);
  const a = m.astroImageDetails;
  const sub = a ? `${a.shotsStacked ?? '?'}×${a.params?.exp ?? '?'}s · ${a.params?.filter ?? ''}` : m.modificationTime ? new Date(m.modificationTime * 1000).toLocaleString() : '';
  const folder = a?.srcDir ? baseName(String(a.srcDir).replace(/\/$/, '')) : '';
  return `<div class="tile"><img loading="lazy" src="${esc(deviceFile(thumb))}" data-full="${esc(file)}" alt=""><div class="cap"><b title="${esc(label)}">${esc(label)}</b><span class="muted">${esc(sub)}</span><br>
    ${folder ? `<button data-session="${esc(folder)}">⇩ session</button>` : `<button data-file="${esc(file)}">⇩ library</button>`}
    <button data-ask="${esc(file)}">ask agent</button>
    <button class="warn" data-del="${esc(file)}" data-astro="${a || folder ? 1 : 0}" title="Delete from the telescope's SD card">delete</button></div></div>`;
}

export async function loadAlbum() {
  const mine = ++seq;
  const type = $('#sel-album').value;
  $('#album-page').textContent = String(page + 1);
  $('#album-prev').disabled = page === 0;
  // the telescope can take ~10 s to answer; an empty grid reads as broken
  $('#album').innerHTML = '<p class="muted">loading…</p>';
  try {
    const { counts = [], items = [], pageSize } = await api(`album?type=${encodeURIComponent(type)}&page=${page}`);
    if (mine !== seq) return;
    $('#album-counts').textContent = counts.filter((c) => c.count).map((c) => `${TYPE_NAMES[c.mediaType] ?? c.mediaType}: ${c.count}`).join(' · ');
    // a page shorter than a full one is the last
    $('#album-next').disabled = !items.length || (Number(pageSize) > 0 && items.length < Number(pageSize));
    $('#album').innerHTML = items.filter((m) => m && m.filePath).map(tile).join('')
      || (page > 0
        ? '<p class="muted">No more items: this is past the end of the album.</p>'
        : '<p class="muted">Nothing captured yet. Take a Photo from the View screen, or ask the agent for a target.</p>');
  } catch (e) {
    if (mine !== seq) return;
    $('#album').innerHTML = `<p class="muted">${state.telescope?.connected ? esc(e.message) : 'the telescope is offline — reconnect it to read the album'}</p>`;
  }
}

$('#sel-album').onchange = () => {
  page = 0;
  loadAlbum();
};
$('#album-prev').onclick = () => {
  page = Math.max(0, page - 1);
  loadAlbum();
};
$('#album-next').onclick = () => {
  page++;
  loadAlbum();
};

async function transfer(body, done) {
  try {
    await api('transfer', body);
    toast(done);
  } catch (err) {
    toast(err.message, true);
  }
}

/** Delete album items from the SD card (the device's own delete: an astro item takes its whole session). */
async function deleteAlbumItems(paths, astro) {
  const what = paths.length === 1 ? baseName(paths[0]) : `${paths.length} items`;
  // the device deletes an astro/burst/panorama capture as its whole package (all frames + stack)
  const extra = astro ? '\n\nThis is a capture session: the whole package goes with it — every raw frame and the stack, not just this image. Transfer it to the library first if you want to keep it.' : '';
  if (!confirm(`Delete ${what} from the telescope's SD card?${extra}\n\nThis cannot be undone.`)) return;
  try {
    const { outcomes = [] } = await api('album/delete', { paths });
    const failed = outcomes.filter((o) => !o.deleted);
    toast(failed.length ? `${outcomes.length - failed.length} of ${outcomes.length} deleted: ${failed[0].note ?? 'the telescope refused'}` : 'deleted from the card', failed.length > 0);
  } catch (err) {
    toast(err.message, true);
  }
  loadAlbum();
}

$('#album').addEventListener('click', (e) => {
  const t = e.target.closest('[data-full], [data-session], [data-file], [data-ask], [data-del]');
  if (!t) return;
  if (t.dataset.full) lightbox(deviceFile(t.dataset.full), t.dataset.full);
  else if (t.dataset.session) transfer({ session: t.dataset.session }, 'transfer queued — see Library tab');
  else if (t.dataset.file) transfer({ paths: [t.dataset.file] }, 'transfer queued');
  else if (t.dataset.ask) draft(`Look at device:${t.dataset.ask} and assess it (focus, tracking, noise, framing). Suggest improvements for next time.`);
  else if (t.dataset.del) deleteAlbumItems([t.dataset.del], t.dataset.astro === '1');
});

on('tab', (name) => {
  if (name === 'album') loadAlbum();
});
// new captures show up while the album is open
on('album-changed', () => {
  if (isPanelActive('album')) loadAlbum();
});
