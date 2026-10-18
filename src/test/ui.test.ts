import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { bootUi, route, calls, stateSocket, videoSocket, tick, answerConfirm, type Ui } from './ui-harness.js';

let ui: Ui;
const lastSubscription = () => {
  const s = videoSocket().sent.map((d) => JSON.parse(d)).filter((m) => m.type === 'subscribe');
  return s.at(-1)?.sources as string[] | undefined;
};
/** Waits (at most `ms`) for the page to settle into `cond`. */
async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const text = (s: string) => ui.$(s).textContent ?? '';
const toastText = () => (ui.$('#toast').hidden ? '' : text('#toast'));
function pointer(el: Element, type: string, pointerId = 1): void {
  const w = ui.window as unknown as { PointerEvent?: typeof MouseEvent; MouseEvent: typeof MouseEvent };
  const Ctor = w.PointerEvent ?? w.MouseEvent;
  const ev = new Ctor(type, { bubbles: true, cancelable: true });
  if (!('pointerId' in ev) || (ev as unknown as { pointerId: number }).pointerId !== pointerId) Object.defineProperty(ev, 'pointerId', { value: pointerId });
  el.dispatchEvent(ev);
}
const click = (s: string) => ui.$(s).dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
const openTab = (name: string) => click(`#tabbar [data-tab="${name}"], .tabs-top [data-tab="${name}"]`);

before(async () => {
  ui = await bootUi();
});

test('boot opens the state socket and the video socket next to the page', () => {
  assert.equal(stateSocket().url, 'ws://localhost:8080/ws');
  assert.equal(videoSocket().url, 'ws://localhost:8080/ws/video');
  // a phone boots on the live view
  assert.ok(ui.$('#panel-view').classList.contains('active'));
  assert.equal(ui.document.body.dataset.screen, 'view');
});

test('the video subscription is the views on screen, without the stack until a stack runs', () => {
  stateSocket().open();
  videoSocket().open();
  assert.deepEqual(lastSubscription(), ['tele', 'wide']);
});

test('a hello renders the chips, the chat history and the transfers', () => {
  stateSocket().push({
    type: 'hello',
    config: { observer: { lat: 51.5, lon: -0.1 } },
    telescope: { connected: true, device: { name: 'DWARF3', firmware: '1.2' }, battery: 80, charging: true, shootingMode: { name: 'photo' } },
    agent: { ready: true, busy: false, model: 'test-model' },
    duty: { status: 'off', wakes: 0 },
    history: [{ kind: 'user', id: 'u1', text: 'hello there', at: Date.now() }],
    jobs: [{ id: 'j1', description: 'M 31 session', status: 'running', startedAt: 1, progress: { bytesDone: 50, bytesTotal: 100, filesDone: 1, filesTotal: 2 } }],
    processing: [],
    logs: [{ ts: Date.now(), level: 'info', scope: 'web', msg: 'listening' }],
  });
  assert.equal(text('#chip-conn span'), 'DWARF3');
  assert.ok(ui.$('#chip-conn').classList.contains('ok'));
  assert.equal(text('#chip-battery'), '🔋 80% ⚡');
  assert.equal(text('#agent-status'), 'test-model');
  assert.equal(ui.$('#chat-inner').children.length, 1);
  assert.equal(text('#chat-inner .msg.user'), 'hello there');
  assert.ok(ui.$('#chat-empty').hidden);
  assert.match(text('#jobs'), /M 31 session — running 50% \(1\/2 files\)/);
  assert.match(text('#log'), /INFO \[web\] listening/);
  assert.match(text('#status-grid'), /Observer51\.500, -0\.100/);
});

test('a frame that is not JSON, or names no handler of the page, is ignored and the next one still lands', () => {
  const s = stateSocket();
  const before = ui.$('#log').children.length;
  s.push('not json {');
  for (const type of ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'nope']) s.push({ type });
  s.push(null);
  s.push({ type: 'log', entry: { ts: Date.now(), level: 'warn', scope: 'x', msg: 'after the junk' } });
  assert.equal(ui.$('#log').children.length, before + 1);
  assert.match(ui.$('#log').lastElementChild!.textContent!, /WARN \[x\] after the junk/);
});

test('one handler that throws never stops the messages after it', () => {
  const s = stateSocket();
  // a job without an id is dropped; a telescope state the renderers cannot read must not throw past dispatch
  s.push({ type: 'telescope', state: { connected: true, motors: null, stacking: 'bogus', capture: 5 } });
  s.push({ type: 'duty', duty: { status: 'active', untilLabel: '05:00', nextWakeAt: null, wakes: 1, pendingEvents: 2 } });
  assert.equal(text('#duty-state'), 'On duty');
  assert.equal(text('#duty-text'), 'until 05:00 · next sample after this turn · 1 wake · 2 event(s) waiting');
  assert.equal(text('#btn-duty'), 'Stop duty');
  assert.equal(ui.$('#btn-duty-wake').hidden, false);
  s.push({ type: 'duty', duty: { status: 'off', wakes: 3, endedReason: 'reached 05:00' } });
  assert.equal(text('#duty-state'), 'Duty off');
  assert.equal(text('#duty-text'), 'last: reached 05:00');
  assert.equal(ui.$('#btn-duty-pause').hidden, true);
});

test('live stacking shows the stack bar and subscribes to the stack feed; its end unsubscribes', () => {
  const s = stateSocket();
  s.push({ type: 'telescope', state: { connected: true, device: { name: 'DWARF3' }, stacking: { tele: { state: 'running', target: 'M 31', currentCount: 5, stackedCount: 4, totalCount: 10, stackedTimeS: 40, shootingTimeS: 75 } } } });
  assert.equal(ui.$('#stackbar').hidden, false);
  assert.equal(text('#stack-target'), 'Stacking · M 31');
  assert.equal(text('#stack-text'), '4 stacked / 5 taken of 10');
  assert.equal(ui.$('#stack-progress').style.width, '50%');
  assert.match(text('#stack-stats'), /integration 40s.*elapsed 1m 15s.*rejected 1/);
  assert.deepEqual(lastSubscription(), ['tele', 'wide', 'stack']);
  // open-ended: no fraction
  s.push({ type: 'telescope', state: { connected: true, stacking: { tele: { state: 'running', currentCount: 5, stackedCount: 5, totalCount: 999 } } } });
  assert.equal(ui.$('#stack-progress').style.width, '0%');
  assert.equal(text('#stack-text'), '5 stacked / 5 taken');
  s.push({ type: 'telescope', state: { connected: true, stacking: { tele: { state: 'idle' } } } });
  assert.equal(ui.$('#stackbar').hidden, true);
  assert.deepEqual(lastSubscription(), ['tele', 'wide']);
});

test('a camera stuck in a photo is told once, with the reboot that clears it', async () => {
  const s = stateSocket();
  ui.$('#toast').hidden = true;
  s.push({ type: 'telescope', state: { connected: true, photoStuckSince: { tele: 1 } } });
  await until(() => /tele camera is stuck in a photo.*reboot the telescope/.test(toastText()), 'the stuck toast');
  ui.$('#toast').hidden = true;
  s.push({ type: 'telescope', state: { connected: true, photoStuckSince: { tele: 1 } } });
  await tick();
  assert.equal(toastText(), '', 'not again for the same episode');
  s.push({ type: 'telescope', state: { connected: true } });
});

test('a video frame lands in the view showing its source; a short or unknown one is dropped', () => {
  const v = videoSocket();
  ui.$('#img-a').removeAttribute('src');
  v.frame(1);
  assert.match(ui.$('#img-a').getAttribute('src') ?? '', /^blob:/);
  assert.equal(ui.$('#img-a').style.visibility, 'visible');
  const main = ui.$('#img-main').getAttribute('src');
  v.frame(7);
  v.onmessage?.({ data: new ArrayBuffer(9) });
  v.onmessage?.({ data: 'text' });
  assert.equal(ui.$('#img-main').getAttribute('src'), main);
});

test('a running tool without a start time shows no timer rather than NaN', () => {
  stateSocket().push({ type: 'agent', event: { kind: 'entry', entry: { kind: 'tool', id: 't1', name: 'goto_target', status: 'running', args: { name: 'M 31' } } } });
  const st = ui.$('#e-t1 .tstate.running');
  assert.doesNotMatch(st.textContent ?? '', /NaN/);
  assert.equal(st.textContent, '');
  stateSocket().push({ type: 'agent', event: { kind: 'entry', entry: { kind: 'tool', id: 't2', name: 'goto_target', status: 'running', at: Date.now() - 3000 } } });
  assert.equal(text('#e-t2 .tstate.running'), '3s');
});

test('streamed deltas render the reasoning and the answer as markdown', async () => {
  const s = stateSocket();
  s.push({ type: 'agent', event: { kind: 'delta', id: 'a1', channel: 'thinking', delta: 'Considering ' } });
  s.push({ type: 'agent', event: { kind: 'delta', id: 'a1', channel: 'thinking', delta: 'the sky.' } });
  s.push({ type: 'agent', event: { kind: 'delta', id: 'a1', channel: 'text', delta: 'M 31 is **up**' } });
  await until(() => !!ui.document.querySelector('#e-a1 .content strong'), 'the streamed answer');
  assert.equal(text('#e-a1 .t-body'), 'Considering the sky.');
  assert.equal(ui.$('#e-a1 details.thinking').hidden, false);
  assert.equal(text('#e-a1 .content strong'), 'up');
  assert.ok(ui.$('#e-a1').classList.contains('typing'));
});

test('markdown from the model never makes a script link or renders raw HTML', () => {
  stateSocket().push({ type: 'agent', event: { kind: 'entry', entry: { kind: 'assistant', id: 'a2', at: Date.now(), text: '[click](javascript:alert(1)) [ok](https://example.org/x) ![i](data:text/html,x)\n\n<img src=x onerror="alert(1)"><script>alert(2)</script>' } } });
  const content = ui.$('#e-a2 .content');
  const hrefs = [...content.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  assert.deepEqual(hrefs, ['#', 'https://example.org/x']);
  assert.ok([...content.querySelectorAll('img')].every((i) => i.getAttribute('src') === '#'));
  assert.equal(content.querySelector('script'), null);
  assert.equal(content.querySelector('img[onerror]'), null);
  assert.match(content.textContent ?? '', /<img src=x onerror="alert\(1\)">/);
});

test('the library shows the newest captures first, at most 60', async () => {
  const caps = Array.from({ length: 65 }, (_, i) => ({ path: `agent/c${String(i).padStart(2, '0')}.jpg`, name: `c${i}` }));
  route('GET library', () => ({ root: '/data/library', targets: [{ target: 'M 31', sessions: [{ name: 's1', camera: 'tele', lights: 10 }, { name: 's2', camera: 'tele', lights: 12 }] }] }));
  route('GET captures', () => caps);
  route('GET processing', () => ({ items: [], server: { ok: true, url: 'http://studio', version: '1' }, queue: { running: [], queued: [] } }));
  openTab('library');
  await until(() => ui.$('#captures').children.length === 60, 'the captures strip');
  const shown = [...ui.$('#captures').children].map((c) => (c as HTMLElement).dataset.cap);
  assert.equal(shown[0], 'agent/c64.jpg');
  assert.equal(shown.at(-1), 'agent/c05.jpg');
  assert.match(text('#library'), /Process all 2 tele nights/);
  // one the agent just looked at goes in front, and the strip stays at 60
  stateSocket().push({ type: 'capture', path: 'agent/new #1.jpg', label: 'new' });
  assert.equal((ui.$('#captures').firstElementChild as HTMLElement).dataset.cap, 'agent/new #1.jpg');
  assert.equal(ui.$('#captures').firstElementChild!.getAttribute('src'), 'captures/agent/new%20%231.jpg');
  assert.equal(ui.$('#captures').children.length, 60);
});

test('a capture opens in the lightbox and Escape closes it', () => {
  click('#captures img');
  assert.equal(ui.$('#lightbox').hidden, false);
  assert.equal(text('#lightbox .lb-caption'), 'agent/new #1.jpg');
  ui.document.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(ui.$('#lightbox').hidden, true);
});

test('processing a library session posts it and cancelling a transfer posts its id', async () => {
  route('POST processing', () => ({ id: 'p1' }));
  route('POST jobs/j1/cancel', () => ({ ok: true }));
  calls.length = 0;
  click('#library [data-process="s1"]');
  click('#jobs [data-cancel="j1"]');
  await until(() => calls.some((c) => c.method === 'POST' && c.path === 'processing') && calls.some((c) => c.path === 'jobs/j1/cancel'), 'the posts');
  assert.deepEqual(calls.find((c) => c.method === 'POST' && c.path === 'processing')!.body, { session: 's1' });
});

test('the album disables Next on a short page and keeps it on a full one', async () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ filePath: `/DWARF3/Astronomy/x${i}.jpg`, mediaType: 1 }));
  let n = 3;
  route('GET album', () => ({ counts: [{ mediaType: 1, count: 23 }], items: items(n), pageSize: 20 }));
  openTab('album');
  await until(() => ui.document.querySelectorAll('#album .tile').length === 3, 'the album');
  assert.equal((ui.$('#album-next') as HTMLButtonElement).disabled, true);
  assert.equal((ui.$('#album-prev') as HTMLButtonElement).disabled, true);
  assert.equal(text('#album-counts'), 'photos: 23');
  n = 20;
  ui.$('#sel-album').dispatchEvent(new ui.window.Event('change'));
  await until(() => ui.document.querySelectorAll('#album .tile').length === 20, 'a full page');
  assert.equal((ui.$('#album-next') as HTMLButtonElement).disabled, false);
});

test('deleting an album tile confirms and posts the album delete; refusing posts nothing', async () => {
  const items = [
    { filePath: '/DWARF3/Normal_Photos/DWARF_TELE_2026-10-11.jpg', mediaType: 1 },
    { filePath: '/DWARF3/Astronomy/DWARF_RAW_TELE_M 31_EXP_15_GAIN_60_2026-10-12-22-00-00-000/stacked.jpg', mediaType: 4, astroTargetName: 'M 31', astroImageDetails: { srcDir: '/Astronomy/DWARF_RAW_TELE_M 31_EXP_15_GAIN_60_2026-10-12-22-00-00-000/' } },
  ];
  route('GET album', () => ({ counts: [], items, pageSize: 20 }));
  openTab('album');
  await until(() => ui.document.querySelectorAll('#album .tile').length === 2, 'the album');
  const photoDel = ui.document.querySelector('#album .tile [data-del]') as HTMLElement;
  assert.equal(photoDel.dataset.astro, '0', 'the photo tile is not flagged astro');
  calls.length = 0;
  answerConfirm(false);
  photoDel.click();
  await tick();
  assert.equal(calls.filter((c) => c.path === 'album/delete').length, 0, 'refusing the confirm deletes nothing');
  answerConfirm(true);
  route('POST album/delete', () => ({ outcomes: [{ filePath: items[0].filePath, deleted: true }] }));
  photoDel.click();
  await until(() => calls.some((c) => c.path === 'album/delete'), 'the delete post');
  assert.deepEqual(calls.find((c) => c.path === 'album/delete')!.body, { paths: [items[0].filePath] });
  // an astro tile says the whole session goes
  await until(() => !!ui.document.querySelector('#album [data-astro="1"]'), 'the reloaded album');
});

test('the sessions card deletes transferred sessions from the card and keeps the library', async () => {
  const F = 'DWARF_RAW_TELE_M 31_EXP_15_GAIN_60_2026-10-12-22-00-00-000';
  const sessions = [
    { folder: F, target: 'M 31', camera: 'tele', exposureS: 15, gain: 60, fitsCount: 40, sizeMB: 640, transferred: true },
    { folder: 'DWARF_RAW_WIDE_Moon_EXP_1_GAIN_1_2026-10-12-20-00-00-000', target: 'Moon', camera: 'wide', exposureS: 1, gain: 1, fitsCount: 3, sizeMB: 12, transferred: false },
  ];
  route('GET sessions', () => ({ sessions }));
  route('POST sessions/delete', () => ({ outcomes: [{ folder: F, deleted: true }] }));
  openTab('library');
  calls.length = 0;
  click('#btn-sessions');
  await until(() => ui.document.querySelectorAll('#sessions .sess').length === 2, 'the session list');
  const bulk = ui.$('#btn-sessions-del') as HTMLButtonElement;
  assert.equal(bulk.disabled, false, 'one transferred session makes the bulk delete available');
  assert.deepEqual(JSON.parse(bulk.dataset.folders ?? '[]'), [F], 'only transferred sessions are offered for bulk delete');
  answerConfirm(true);
  click('#btn-sessions-del');
  await until(() => calls.some((c) => c.path === 'sessions/delete'), 'the bulk delete post');
  assert.deepEqual(calls.find((c) => c.path === 'sessions/delete')!.body, { folders: [F], force: false });
  // a single transferred session deletes without force
  await until(() => !!ui.document.querySelector('#sessions [data-transferred="1"]'), 'the reloaded session list');
  answerConfirm(true);
  (ui.document.querySelector('#sessions [data-transferred="1"]') as HTMLElement).click();
  await until(() => calls.filter((c) => c.path === 'sessions/delete').length >= 2, 'the single delete post');
  assert.deepEqual(calls.filter((c) => c.path === 'sessions/delete').at(-1)!.body, { folders: [F], force: false });
  // a not-transferred session is deleted with force (its confirm warns it is not in the library)
  await until(() => !!ui.document.querySelector('#sessions [data-transferred="0"]'), 'the reloaded session list');
  answerConfirm(true);
  (ui.document.querySelector('#sessions [data-transferred="0"]') as HTMLElement).click();
  await until(() => calls.filter((c) => c.path === 'sessions/delete').length >= 3, 'the forced delete post');
  assert.deepEqual(calls.filter((c) => c.path === 'sessions/delete').at(-1)!.body, { folders: [sessions[1].folder], force: true });
});

test('the database fills its filters once however often it is opened', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  route('GET catalog/meta', async () => {
    await gate;
    return { total: 2, types: [{ type: 'galaxy', count: 2 }], catalogs: [{ id: 'messier', title: 'Messier', count: 2 }], constellations: [{ abbr: 'And', name: 'Andromeda', count: 2 }], sources: [] };
  });
  route('GET catalog/search', () => ({ items: [], total: 0 }));
  calls.length = 0;
  openTab('database');
  openTab('album');
  openTab('database');
  release();
  await until(() => /0 objects/.test(text('#db-count')), 'the search');
  assert.equal(calls.filter((c) => c.path === 'catalog/meta').length, 1);
  const andromeda = [...ui.document.querySelectorAll('option')].filter((o) => o.value === 'And');
  assert.equal(andromeda.length, 1);
});

test('the planner and the database can filter by a minimum percent of the tele frame width', async () => {
  route('GET plan', () => ({ window: { start: '20:00', end: '04:00', hours: 8 }, moon: { illuminationPercent: 10, phase: 'waxing crescent' }, minAltitude: 20, weather: 'clear', targets: [] }));
  calls.length = 0;
  openTab('tonight');
  await until(() => calls.some((c) => c.path.startsWith('plan')), 'the plan');
  const sel = ui.$('#sel-plan-fov') as HTMLSelectElement;
  sel.value = '25';
  sel.dispatchEvent(new ui.window.Event('change'));
  await until(() => /fills ≥25% of the tele frame/.test(text('#plan')), 'the plan with the frame filter');
  assert.ok(calls.some((c) => c.path.startsWith('plan?') && c.path.includes('minFovPercent=25')), 'the plan request carries the filter');

  let searchPath = '';
  route('GET catalog/search', (path) => {
    searchPath = path;
    return { items: [], total: 0 };
  });
  openTab('database');
  await until(() => !!searchPath, 'the database search');
  const input = ui.$('#db-minfov') as HTMLInputElement;
  input.value = '40';
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  await until(() => searchPath.includes('minFovPercent=40'), 'the search with the frame filter');
});

test('a held nudge arrow nudges at once, and the stop on release reaches the server after that nudge', async () => {
  openTab('view');
  let answer!: () => void;
  const held = new Promise<void>((r) => (answer = r));
  route('POST control', async (_p, { body }) => {
    if ((body as { action: string }).action === 'nudge') await held;
    return { ok: true };
  });
  calls.length = 0;
  const arrow = ui.$('[data-nudge]');
  pointer(arrow, 'pointerdown', 7);
  await tick();
  const nudges = calls.filter((c) => (c.body as { action?: string })?.action === 'nudge');
  assert.equal(nudges.length, 1);
  assert.deepEqual(nudges[0].body, { action: 'nudge', angle: Number(arrow.dataset.nudge), speed: 0.4, ms: 700 });
  // another pointer's release is not this press ending
  pointer(arrow, 'pointerup', 8);
  pointer(arrow, 'pointerup', 7);
  await tick();
  assert.equal(calls.filter((c) => (c.body as { action?: string })?.action === 'stop').length, 0, 'the stop waits for the nudge on the wire');
  answer();
  await until(() => calls.some((c) => (c.body as { action?: string })?.action === 'stop'), 'the stop');
  const order = calls.map((c) => (c.body as { action?: string })?.action);
  assert.ok(order.lastIndexOf('nudge') < order.indexOf('stop'));
  assert.equal(order.filter((a) => a === 'stop').length, 1);
});

test('attachments: at most 8, images only, and one can be removed', async () => {
  openTab('chat');
  const w = ui.window;
  const input = ui.$('#file') as HTMLInputElement;
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const pick = (files: File[]) => {
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new w.Event('change'));
  };
  pick([new w.File(['hello'], 'notes.txt', { type: 'text/plain' })]);
  await until(() => /notes\.txt: only JPEG, PNG, WebP and GIF/.test(toastText()), 'the type refusal');
  assert.equal(ui.$('#attach-list').children.length, 0);
  pick(Array.from({ length: 9 }, (_, i) => new w.File([png], `p${i}.png`, { type: 'image/png' })));
  await until(() => ui.$('#attach-list').children.length === 8, 'eight attachments');
  await until(() => /at most 8 images per message/.test(toastText()), 'the count refusal');
  (ui.$('#attach-list img[data-i="0"]') as HTMLElement).click();
  assert.equal(ui.$('#attach-list').children.length, 7);
});

test('sending a prompt posts the text and the attachments once, then clears the composer', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  route('POST agent/prompt', async () => {
    await gate;
    return { ok: true };
  });
  calls.length = 0;
  const prompt = ui.$('#prompt') as HTMLTextAreaElement;
  prompt.value = '  What is up tonight?  ';
  const enter = () => prompt.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  enter();
  enter();
  await tick();
  release();
  await until(() => prompt.value === '', 'the composer to clear');
  const sent = calls.filter((c) => c.path === 'agent/prompt');
  assert.equal(sent.length, 1);
  const body = sent[0].body as { text: string; images: unknown[]; mode: string };
  assert.equal(body.text, 'What is up tonight?');
  assert.equal(body.mode, 'steer');
  assert.equal(body.images.length, 7);
  assert.equal(ui.$('#attach-list').children.length, 0);
});

test('a refused control action toasts the server error', async () => {
  route('POST control', () => {
    throw new Error('the telescope is busy calibrating');
  });
  openTab('view');
  const b = ui.document.querySelector('[data-act]') as HTMLButtonElement;
  b.click();
  await until(() => /the telescope is busy calibrating/.test(toastText()), 'the error toast');
  assert.ok(ui.$('#toast').classList.contains('err'));
  await until(() => !b.disabled, 'the button to come back');
});

test('the state socket reconnects after it drops and says the UI is disconnected', async () => {
  const first = stateSocket();
  first.close();
  assert.equal(text('#chip-conn span'), 'UI disconnected');
  await until(() => stateSocket() !== first, 'a new socket');
  assert.equal(stateSocket().url, 'ws://localhost:8080/ws');
});
