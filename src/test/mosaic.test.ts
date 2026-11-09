import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { config } from '../config.js';
import { chooseExecution, layoutMosaic, offsetToSky, panelCount, targetFootprint, type Footprint } from '../astro/mosaic.js';
import { roiCropPercent, roiForTarget, setFrameField } from '../processing/roi.js';
import { addTarget, effectiveSwitch, loadSettings, saveSettings, updateTarget, PLAN_DEFAULTS } from '../night/program.js';
import { applyStudioReport, ensureProject, findProject, manifestFor, mosaicProgress, nextPanel, panelName, panelOf, parentKey } from '../night/mosaics.js';
import { targetKey } from '../astro/rest.js';
import { ProcessingQueue } from '../processing/queue.js';
import { deviceById } from '../astro/acquisition/devices.js';

const fp = (w: number, h: number, raHours = 12, decDeg = 0): Footprint => ({ w, h, raHours, decDeg, angleDeg: 0, source: 'override' });
const eq = { overlap: 0.2, mount: 'eq', cameraAngleDeg: 0 } as const;
const field = { w: 177, h: 100 };
const ctx = (settings = PLAN_DEFAULTS) => ({ field, mount: 'eq' as const, settings: { ...settings, mosaicCameraAngleDeg: 0 } });
const got = (m: Record<string, number>) => new Map(Object.entries(m).map(([k, totalMin]) => [targetKey(k), { totalMin }]));

test('the panel count of the worked example: 2.0° × 1.2° with a 1.3° × 0.75° frame at 20 % is 2 × 2', () => {
  const l = layoutMosaic(fp(120, 72), { w: 78, h: 45 }, eq);
  assert.deepEqual([l.nx, l.ny, l.panels.length, l.needed], [2, 2, 4, true]);
  assert.equal(panelCount(100, 100, 0.2), 1);
  assert.equal(panelCount(50, 100, 0.2), 1);
  assert.equal(panelCount(180, 100, 0.2), 2);
  assert.equal(panelCount(181, 100, 0.2), 3);
});

test('a target that fits is one frame', () => {
  assert.equal(layoutMosaic(fp(60, 40), field, eq).needed, false);
});

test('panel centres straddle the footprint and neighbours follow the serpentine', () => {
  const l = layoutMosaic(fp(300, 170), field, eq);
  assert.deepEqual([l.nx, l.ny], [2, 2]);
  const ra = l.panels.map((p) => p.raHours);
  assert.ok(Math.abs((ra[0] + ra[1]) / 2 - 12) < 1e-9);
  assert.deepEqual(l.panels.map((p) => p.id + p.ix + p.iy), ['P100', 'P210', 'P311', 'P401']);
});

test('RA steps widen with declination on the tangent plane', () => {
  const eqr = offsetToSky(6, 0, 60, 0).raHours - 6;
  const high = offsetToSky(6, 60, 60, 0).raHours - 6;
  assert.ok(Math.abs(high / eqr - 2) < 0.01, `ratio ${high / eqr}`);
  assert.ok(Math.abs(offsetToSky(23.99, 0, 60, 0).raHours - (23.99 + eqr - 24)) < 1e-9, 'wraps at 24 h');
});

test('alt-az and unknown orientation plan square panels; alt-az widens the overlap', () => {
  const az = layoutMosaic(fp(300, 170), field, { overlap: 0.2, mount: 'altaz', cameraAngleDeg: null });
  assert.deepEqual([az.orientation, az.panelField.w, az.overlap > 0.29], ['rotating', 100, true]);
  const unknown = layoutMosaic(fp(300, 170), field, { overlap: 0.2, mount: 'eq', cameraAngleDeg: null });
  assert.deepEqual([unknown.orientation, unknown.panelField.h], ['unknown', 100]);
});

test('the footprint uses the catalog size, widened more for nebulae, and the position angle only when the camera angle is known', () => {
  const galaxy = targetFootprint({ major: 100, minor: 20, posAngle: 90, type: 'G', raHours: 1, decDeg: 2 }, 0)!;
  assert.ok(Math.abs(galaxy.w - 110) < 1e-6 && Math.abs(galaxy.h - 22) < 1e-6, JSON.stringify(galaxy));
  const noAngle = targetFootprint({ major: 100, minor: 20, type: 'HII', raHours: 1, decDeg: 2 }, null)!;
  assert.deepEqual([noAngle.w, noAngle.h], [125, 125]);
  assert.equal(targetFootprint({ raHours: 1, decDeg: 2 }, 0), null);
});

test('native only when allowed, inside its limits and in the mode it needs', () => {
  const n = { maxScaleX: 1.8, maxScaleY: 1.8, requiresEq: true, verified: false };
  const l = { footprint: fp(250, 100) };
  assert.equal(chooseExecution(l, field, n, { allowNative: false, eqMode: true }).execution, 'panels');
  assert.equal(chooseExecution(l, field, n, { allowNative: true, eqMode: false }).execution, 'panels');
  assert.equal(chooseExecution(l, field, n, { allowNative: true, eqMode: true }).execution, 'native');
  assert.equal(chooseExecution({ footprint: fp(400, 100) }, field, n, { allowNative: true, eqMode: true }).execution, 'panels');
  assert.equal(chooseExecution(l, field, undefined, { allowNative: true, eqMode: true }).execution, 'panels');
});

test('the shipped Dwarf 3 and Seestar S50 declare their native mosaics', () => {
  const dwarf = deviceById('dwarf-3')!.mosaic!.native;
  assert.deepEqual([dwarf.maxScaleX, dwarf.requiresEq, dwarf.verified], [1.8, true, false]);
  assert.ok(deviceById('seestar-s50')!.mosaic!.native);
  assert.equal(deviceById('dwarf-mini')!.mosaic, undefined);
});

test('a target setting beats the global one, inherit follows it', () => {
  assert.equal(effectiveSwitch(false, undefined), false);
  assert.equal(effectiveSwitch(true, undefined), true);
  assert.equal(effectiveSwitch(false, 'inherit'), false);
  assert.equal(effectiveSwitch(false, 'on'), true);
  assert.equal(effectiveSwitch(true, 'off'), false);
});

test('crop percentage: a target at 10 % of the frame gets a crop just outside what it needs', () => {
  const opts = { maxFillPct: 25, marginPct: 20 };
  assert.deepEqual(roiCropPercent(17.7, field, opts), { percent: 22, recommendedPercent: 17.7, fillPct: 10 });
  assert.equal(roiCropPercent(120, field, opts), null, 'fills the frame already');
  assert.equal(roiCropPercent(undefined, field, opts), null, 'no size in the catalog');
  assert.equal(roiCropPercent(44, { w: 177, h: 45 }, opts), null, 'a crop of 100 % or more is none');
});

test('crop request: off by default, on globally or per target, and only from the catalog', () => {
  setFrameField(() => field);
  saveSettings({ roiCropEnabled: false });
  addTarget({ name: 'M 27', goalMin: 60 }, '2026-11-09');
  assert.equal(roiForTarget('M 27'), undefined);
  updateTarget('M 27', { roiCrop: 'on' });
  assert.ok(roiForTarget('M 27')! > 0 && roiForTarget('M 27')! < 40, `got ${roiForTarget('M 27')}`);
  updateTarget('M 27', { roiCrop: 'off' });
  saveSettings({ roiCropEnabled: true });
  assert.equal(roiForTarget('M 27'), undefined, 'the target wins over the global switch');
  updateTarget('M 27', { roiCrop: 'inherit' });
  assert.ok(roiForTarget('M 27')! > 0);
  assert.equal(roiForTarget('not a catalog object at all'), undefined);
  saveSettings({ roiCropEnabled: false });
});

test('a mosaic project is fixed once made, and tracked per panel across nights', () => {
  const t = addTarget({ name: 'NGC 7000', goalMin: 120 }, '2026-11-09');
  const p = ensureProject(t, ctx(), '2026-11-09')!;
  assert.ok(p.panels.length > 1, 'bigger than the frame');
  assert.equal(p.goalPerPanelS, 7200);
  assert.deepEqual(ensureProject({ ...t, goalMin: 999 }, ctx({ ...PLAN_DEFAULTS, mosaicOverlapPct: 40 }), '2026-11-10')!.panels, p.panels, 'later nights keep the panels');
  assert.equal(findProject('NGC 7000')!.id, p.id);
  const [a, b] = p.panels;
  assert.equal(a.name, panelName(t.gotoName, 'P1'));
  assert.equal(parentKey(a.name), targetKey('NGC 7000'));
  assert.equal(panelOf(b.name)!.panel.id, 'P2');
  assert.equal(panelOf('M 42'), null);
  const m = mosaicProgress(p, got({ [a.name]: 120, [b.name]: 38 }));
  assert.equal(m.panels[0].done, true);
  assert.equal(m.panels[1].remainingS, 82 * 60, 'an hour scheduled with 38 min usable leaves the rest in the plan');
  assert.equal(m.goalS, 7200 * p.panels.length);
  assert.equal(m.acceptedS, (120 + 38) * 60);
  assert.equal(m.complete, false);
  assert.equal(m.panels.reduce((n, x) => n + Number(x.done), 0), 1);
  const over = mosaicProgress(p, got({ [a.name]: 500 }));
  assert.equal(over.acceptedS, 7200, 'surplus on one panel does not finish another');
});

test('a target that fits one frame gets no project', () => {
  const t = addTarget({ name: 'M 57', goalMin: 60 }, '2026-11-09');
  assert.equal(ensureProject(t, ctx(), '2026-11-09'), null);
});

test('the next panel balances the panels without hopping', () => {
  const t = addTarget({ name: 'M 31', goalMin: 120 }, '2026-11-09');
  const p = ensureProject(t, ctx(), '2026-11-09')!;
  const [a, b] = p.panels;
  const fresh = nextPanel(mosaicProgress(p, got({})))!;
  assert.equal(fresh.panel.id, a.id);
  assert.equal(fresh.stackMinutes, 30);
  assert.equal(nextPanel(mosaicProgress(p, got({ [a.name]: 25 })), { currentId: a.id })!.panel.id, a.id, 'stays for its chunk');
  assert.notEqual(nextPanel(mosaicProgress(p, got({ [a.name]: 30 })), { currentId: a.id })!.panel.id, a.id, 'moves on after it');
  assert.equal(nextPanel(mosaicProgress(p, got(Object.fromEntries(p.panels.map((x) => [x.name, 120]))))), null, 'complete');
  void b;
});

test("Studio's report corrects the integration and sends panels back", () => {
  const t = addTarget({ name: 'Sh2-240', goalMin: 60, raHours: 5.65, decDeg: 28 }, '2026-11-09');
  const p = ensureProject(t, { ...ctx(), override: { w: 400, h: 150 } }, '2026-11-09')!;
  const [a, b] = p.panels;
  applyStudioReport(p.id, { panels: [{ id: a.id, accepted_sec: 3000, input_sec: 3600, offset_arcmin: 1.2 }], coverage: { percent: 91, revisit: [b.id] } }, { jobId: 'j1', outputs: ['x.jpg'] });
  const after = findProject(p.id)!;
  assert.equal(after.studio!.coveragePct, 91);
  const m = mosaicProgress(after, got({ [a.name]: 60, [b.name]: 60 }));
  assert.equal(m.panels[0].acceptedS, 3000);
  assert.equal(m.panels[0].remainingS, 600, 'frames Studio refused are shot again');
  assert.equal(m.panels[1].done, false, 'a hole keeps the panel open whatever its integration');
  assert.equal(nextPanel(m)!.panel.id, b.id, 'holes first');
  assert.equal(m.integrated, false);
});

test('the projects survive a corrupt file by setting it aside', () => {
  const f = path.join(config.paths.data, 'plan', 'mosaics.json');
  const before = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, '{nope');
  assert.equal(findProject('NGC 7000'), undefined);
  assert.ok(fs.readdirSync(path.dirname(f)).some((x) => x.startsWith('mosaics.json.bad-')));
  fs.writeFileSync(f, before);
});

function queue() {
  const sent: Array<Record<string, unknown>> = [];
  const job = { id: 'j', kind: 'all', folders: [], state: 'queued' as const, progress: 0, outputs: [] };
  const studio = {
    health: async () => ({ ok: true, version: 't', busy: false, queued: 0 }),
    resolve: async () => ({ folders: [], exists: true, n_fits: 99 }),
    submit: async (b: Record<string, unknown>) => (sent.push({ via: 'jobs', ...b }), job),
    submitMosaic: async (b: Record<string, unknown>) => (sent.push({ via: 'mosaics', ...b }), job),
    job: async () => job,
    cancel: async () => job,
    uploads: async () => ({ root: '/u', files: [] }),
    uploadFile: async () => undefined,
    download: async () => undefined,
  };
  return { sent, q: new ProcessingQueue(studio, () => path.join(config.paths.data, `proc-${Math.random()}.json`)) };
}

function withLibrary(names: string[]) {
  for (const n of names) {
    const d = path.join(config.paths.library, n);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'a_0001.fits'), 'x');
  }
}

async function send(q: ProcessingQueue, it: { sent: unknown[] }, o: Parameters<ProcessingQueue['enqueue']>[0]) {
  const url = config.studio.url;
  (config.studio as { url: string }).url = 'http://studio';
  try {
    q.enqueue(o);
    q.start();
    await new Promise((r) => setTimeout(r, 50));
    await q.settled();
    q.stop();
  } finally {
    (config.studio as { url: string }).url = url;
  }
  return it.sent;
}

test('the crop percentage is in the processing request, and absent without one', async () => {
  withLibrary(['DWARF_RAW_TELE_M 27_EXP_60_GAIN_60_2026-11-01-22-00-00-000']);
  const a = queue();
  await send(a.q, a, { sessions: ['DWARF_RAW_TELE_M 27_EXP_60_GAIN_60_2026-11-01-22-00-00-000'], target: 'M 27', roiCropPercent: 18 });
  assert.equal(a.sent[0].via, 'jobs');
  assert.equal(a.sent[0].roi_crop_percent, 18);
  const b = queue();
  await send(b.q, b, { sessions: ['DWARF_RAW_TELE_M 27_EXP_60_GAIN_60_2026-11-01-22-00-00-000'], target: 'M 27' });
  assert.equal('roi_crop_percent' in b.sent[0], false);
});

test('a mosaic goes to Studio as one job with each panel\'s sessions', async () => {
  const p = findProject('NGC 7000')!;
  const folder = `DWARF_RAW_TELE_${p.panels[0].name}_EXP_60_GAIN_60_2026-11-02-22-00-00-000`;
  withLibrary([folder]);
  const manifest = manifestFor(p);
  assert.deepEqual(manifest.panels[0].sessions, [folder]);
  assert.deepEqual(manifest.panels[1].sessions, []);
  assert.equal(manifest.footprint.ra_deg, p.footprint.raHours * 15);
  const a = queue();
  await send(a.q, a, { sessions: [folder], target: p.displayName, kind: 'mosaic', mosaic: manifest });
  const s = a.sent[0] as { via: string; project_id: string; panels: Array<{ id: string; paths: string[]; sessions?: unknown }> };
  assert.equal(s.via, 'mosaics');
  assert.equal(s.project_id, p.id);
  assert.equal(s.panels[0].paths.length, 1);
  assert.ok(s.panels[0].paths[0].endsWith(folder));
  assert.equal(s.panels[0].sessions, undefined);
});

test('settings default to off so existing programs behave as before', () => {
  assert.equal(PLAN_DEFAULTS.mosaicEnabled, false);
  assert.equal(PLAN_DEFAULTS.roiCropEnabled, false);
  assert.equal(loadSettings().mosaicAllowNative, false);
});
