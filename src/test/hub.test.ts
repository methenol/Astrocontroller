import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childEnv, editorSettings, ProfileInput as ProfileInputSchema, seestarKeyProblem, legacyProfile, ownedVar, ProfileStore, publicProfile, slugFor, type HubPaths, type ProfileInput } from '../hub/profiles.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { proxyRequest, splitPrefixed, type ProxyTarget } from '../hub/proxy.js';
import { settingProblems } from '../config/settings.js';
import { Instance, type InstanceStatus } from '../hub/instances.js';
import { moveOffLibraryRoot, usesLibraryRoot } from '../hub/library-migration.js';

const tmpPaths = (): HubPaths => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  return { data: path.join(root, 'data'), library: path.join(root, 'library') };
};

const site = { latitude: 31.47, longitude: -98.95, elevationM: 400, timezone: 'America/Chicago' };
const zwoInput = (over: Partial<ProfileInput['seestar']> = {}): ProfileInput => ({
  name: 'Starfront S50',
  driver: 'seestar',
  host: '',
  location: site,
  seestar: { zwo: true, user: 'me@example.com', password: 'pw', serial: 'SN1', country: 'US', starfront: true, building: 3, ...over },
  env: { PLAN_DEVICE: 'seestar-s50' },
});

describe('profile store', () => {
  test('slots start at 1, ids are unique slugs, the file is private', () => {
    const paths = tmpPaths();
    const s = new ProfileStore(paths);
    const a = s.create(zwoInput());
    const b = s.create(zwoInput());
    assert.equal(a.id, 'starfront-s50');
    assert.equal(b.id, 'starfront-s50-2');
    assert.deepEqual([a.slot, b.slot], [1, 2]);
    assert.equal(a.active, false);
    assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
    const again = new ProfileStore(paths);
    assert.equal(again.load().length, 2);
  });

  test('a blank password on an edit keeps the saved one; the UI never sees it', () => {
    const paths = tmpPaths();
    const s = new ProfileStore(paths);
    const p = s.create(zwoInput());
    const q = s.update(p.id, zwoInput({ password: undefined, building: 5 }));
    assert.equal(q.seestar.password, 'pw');
    assert.equal(q.seestar.building, 5);
    const pub = publicProfile(q, paths);
    assert.equal(pub.seestar.hasPassword, true);
    assert.ok(!JSON.stringify(pub).includes('"pw"'));
  });

  test('Starfront needs ZWO, ZWO needs the Seestar, ZWO needs the account', () => {
    const s = new ProfileStore(tmpPaths());
    const p = s.create(zwoInput());
    const dwarf = s.update(p.id, { ...zwoInput(), driver: 'dwarf' });
    assert.equal(dwarf.seestar.zwo, false);
    assert.equal(dwarf.seestar.starfront, false);
    assert.throws(() => s.create(zwoInput({ password: '' })), /account e-mail and password/);
    assert.throws(() => s.create({ ...zwoInput(), location: { ...site, longitude: null } }), /both latitude and longitude/);
  });

  test('slugs survive odd names', () => {
    assert.equal(slugFor('Café Dwarf #2', new Set()), 'cafe-dwarf-2');
    assert.equal(slugFor('★★', new Set()), 'scope');
  });
});

describe('profile process environment', () => {
  const base = {
    PATH: '/bin',
    LLM_MODEL: 'qwen',
    ASTROPHOTO_URL: 'http://gpu:8000',
    DWARF_HOST: '10.0.0.5',
    SEESTAR_USER: 'env@example.com',
    OBSERVER_LATITUDE: '1',
    PLAN_BORTLE: '7',
    MCP_URL: 'http://elsewhere/mcp',
    SEESTAR_KEY_PATH: '/keys/seestar.pem',
  };

  test('shared settings pass through; the telescope ones are the profile\'s', () => {
    const paths = tmpPaths();
    const p = new ProfileStore(paths).create(zwoInput());
    const env = childEnv(p, base, { paths, port: 18101, tunnelHost: 'seestar-portfwd' });
    assert.equal(env.LLM_MODEL, 'qwen');
    assert.equal(env.ASTROPHOTO_URL, 'http://gpu:8000');
    assert.equal(env.SEESTAR_KEY_PATH, '/keys/seestar.pem');
    assert.equal(env.DWARF_HOST, undefined);
    assert.equal(env.MCP_URL, undefined);
    assert.equal(env.PLAN_BORTLE, undefined);
    assert.equal(env.PLAN_DEVICE, 'seestar-s50');
    assert.equal(env.SEESTAR_USER, 'me@example.com');
    assert.equal(env.OBSERVER_LATITUDE, '31.47');
    assert.equal(env.TZ, 'America/Chicago');
    assert.equal(env.DATA_DIR, path.join(paths.data, 'profiles', p.id));
    assert.equal(env.LIBRARY_DIR, path.join(paths.library, p.id));
    assert.equal(env.WEB_BIND, '127.0.0.1');
    assert.equal(env.WEB_PORT, '18101');
  });

  test('a ZWO profile reaches its own tunnel slot: every port moved by slot*1000', () => {
    const paths = tmpPaths();
    const s = new ProfileStore(paths);
    s.create(zwoInput());
    const p = s.create(zwoInput());
    const env = childEnv(p, base, { paths, port: 18102, tunnelHost: 'seestar-portfwd' });
    assert.equal(p.slot, 2);
    assert.equal(env.SEESTAR_CONNECTION, 'zwo');
    assert.equal(env.SEESTAR_TUNNEL_HOST, 'seestar-portfwd');
    assert.equal(env.SEESTAR_RPC_PORT, '6700');
    assert.equal(env.SEESTAR_HTTP_PORT, '2080');
    assert.equal(env.SEESTAR_TUNNEL_CONTROL_PORT, '6710');
    assert.equal(env.STARFRONT_REMOTE_ZWO, 'true');
    assert.equal(env.STARFRONT_BUILDING, '3');
  });

  test('the slots\' port sets never overlap', () => {
    const ports = [4700, 4350, 80, 4801, 4800, 4804, 4554, 4555, 4361, 445, 22, 32323, 4710, 4709];
    const seen = new Set<number>();
    for (let slot = 0; slot <= 33; slot++)
      for (const p of ports) {
        if (p === 4709 && slot > 0) continue; // the manager is in slot 0 only
        const local = p + slot * 1000;
        assert.ok(local < 65536);
        assert.ok(!seen.has(local), `port ${local} twice`);
        seen.add(local);
      }
  });

  test('owned variables', () => {
    for (const k of ['TELESCOPE_DRIVER', 'OBSERVER_TIMEZONE', 'PLAN_DEVICE', 'SEESTAR_PASSWORD', 'STARFRONT_BUILDING']) assert.ok(ownedVar(k), k);
    for (const k of ['LLM_BASE_URL', 'SEESTAR_TUNNEL_HOST', 'SEESTAR_KEY_PATH', 'UNITS']) assert.ok(!ownedVar(k), k);
  });
});

describe('profile settings', () => {
  const input = (env: Record<string, string>) => ProfileInputSchema.safeParse({ name: 'Backyard', driver: 'dwarf', host: '', location: site, env });

  test('a fractional Bortle class is a valid setting', () => {
    assert.deepEqual(settingProblems({ PLAN_BORTLE: '6.6' }), []);
    assert.ok(input({ PLAN_BORTLE: '6.6' }).success);
  });

  test('a value the process would refuse is refused when the profile is saved', () => {
    for (const env of <Array<Record<string, string>>>[{ PLAN_BORTLE: 'abc' }, { PLAN_BORTLE: '12' }, { PLAN_MOUNT: 'dobsonian' }, { PLAN_GUIDED: 'maybe' }, { DUTY_INTERVAL_S: '5' }]) {
      const r = input(env);
      assert.ok(!r.success, JSON.stringify(env));
      assert.match(r.error.issues[0].message, new RegExp(Object.keys(env)[0]));
    }
    assert.ok(input({ SOMETHING_ELSE: 'whatever', PLAN_FILTERS: 'Astro,Duo-Band' }).success, 'variables without a field pass as they are');
  });

  test('the editor gets each field with what an empty one inherits', () => {
    const byKey = new Map(editorSettings({ PLAN_BORTLE: '7', LLM_MODEL: 'big-model', DUTY_INTERVAL_S: ' ' }).map((s) => [s.key, s]));
    const bortle = byKey.get('PLAN_BORTLE')!;
    assert.equal(bortle.inherited, '5', "the hub never hands its own PLAN_ values to a profile: an empty field is the built-in default");
    assert.equal(bortle.fromEnv, '7', 'a new profile is filled out with the .env value');
    assert.equal(byKey.get('LLM_MODEL')!.inherited, 'big-model', 'a shared variable follows .env');
    assert.equal(byKey.get('LLM_MODEL')!.fromEnv, null);
    assert.equal(byKey.get('DUTY_INTERVAL_S')!.inherited, '300', 'a blank .env value is no value');
    assert.equal(byKey.get('PLAN_APERTURE_MM')!.inherited, '', 'no default: not set');
  });
});

describe('the Seestar handshake key', () => {
  const pemDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-key-'));
  const shared = path.join(pemDir, 'seestar.pem');
  fs.writeFileSync(shared, '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n');

  test('every ZWO profile gets the one shared key, made absolute; a LAN Seestar gets none', () => {
    const paths = tmpPaths();
    const s = new ProfileStore(paths);
    const zwo = s.create(zwoInput());
    const lan = s.create({ ...zwoInput({ zwo: false, starfront: false }), host: '10.0.0.9' });
    const base = { SEESTAR_KEY_PATH: 'seestar.pem' };
    assert.equal(childEnv(zwo, base, { paths, port: 1, tunnelHost: 't', cwd: pemDir }).SEESTAR_KEY_PATH, shared);
    assert.equal(childEnv(lan, base, { paths, port: 1, tunnelHost: 't', cwd: pemDir }).SEESTAR_KEY_PATH, undefined);
    assert.equal(seestarKeyProblem(zwo, { SEESTAR_KEY_PATH: shared }), null);
    assert.equal(seestarKeyProblem(lan, {}), null);
  });

  test("a profile's own variables cannot swap the key", () => {
    const paths = tmpPaths();
    const p = new ProfileStore(paths).create({ ...zwoInput(), env: { SEESTAR_KEY_PATH: '/elsewhere.pem' } });
    assert.equal(childEnv(p, { SEESTAR_KEY_PATH: shared }, { paths, port: 1, tunnelHost: 't' }).SEESTAR_KEY_PATH, shared);
  });

  test('a missing, unreadable or wrong key is reported; the Dwarf and the LAN need none', () => {
    const s = new ProfileStore(tmpPaths());
    const p = s.create(zwoInput());
    assert.match(seestarKeyProblem(p, {}) ?? '', /no ZWO handshake key/);
    assert.match(seestarKeyProblem(p, { SEESTAR_KEY_PATH: path.join(pemDir, 'nope.pem') }) ?? '', /cannot be read/);
    fs.writeFileSync(path.join(pemDir, 'cert.pem'), '-----BEGIN CERTIFICATE-----\n');
    assert.match(seestarKeyProblem(p, { SEESTAR_KEY_PATH: path.join(pemDir, 'cert.pem') }) ?? '', /not a PEM private key/);
    assert.equal(seestarKeyProblem(s.create({ ...zwoInput(), driver: 'dwarf' }), {}), null);
    assert.equal(childEnv(s.create({ ...zwoInput(), driver: 'dwarf' }), { SEESTAR_KEY_PATH: shared }, { paths: tmpPaths(), port: 1, tunnelHost: 't' }).SEESTAR_KEY_PATH, undefined);
  });

  test('the real key in ./keys is a PEM private key', { skip: !fs.existsSync('keys/seestar.pem') }, () => {
    assert.equal(seestarKeyProblem(new ProfileStore(tmpPaths()).create(zwoInput()), { SEESTAR_KEY_PATH: 'keys/seestar.pem' }), null);
  });
});

describe('migration of the single-telescope setup', () => {
  test('keeps its data and library folders, its site and its PLAN_ settings, in slot 0', () => {
    const paths = { data: '/data', library: '/library' };
    const p = legacyProfile(
      { TELESCOPE_DRIVER: 'seestar', SEESTAR_CONNECTION: 'zwo', SEESTAR_USER: 'u@x', SEESTAR_PASSWORD: 'pw', STARFRONT_REMOTE_ZWO: 'true', STARFRONT_BUILDING: '2', DATA_DIR: '/data', LIBRARY_DIR: '/library', OBSERVER_LATITUDE: '31', OBSERVER_LONGITUDE: '-99', OBSERVER_TIMEZONE: 'America/Chicago', PLAN_BORTLE: '3' },
      paths,
    );
    assert.equal(p.slot, 0);
    assert.equal(p.active, true);
    assert.equal(p.legacy, true);
    assert.equal(p.dataDir, '/data');
    assert.equal(p.libraryDir, '/library');
    assert.deepEqual([p.seestar.zwo, p.seestar.starfront, p.seestar.building], [true, true, 2]);
    assert.equal(p.env.PLAN_BORTLE, '3');
    const env = childEnv(p, {}, { paths, port: 18100, tunnelHost: 'seestar-portfwd' });
    assert.equal(env.SEESTAR_RPC_PORT, '4700');
    assert.equal(env.DATA_DIR, '/data');
  });

  test('its library moves off the shared root into its own folder; the other profiles\' folders stay', () => {
    const paths = tmpPaths();
    const root = paths.library;
    const data = path.join(paths.data);
    const S = 'DWARF_RAW_TELE_M 31_EXP_60_GAIN_60_2026-10-12-23-35-37-855';
    for (const d of [S, 'CALI_FRAME/dark/cam_0', '_photos/2026-10-01', 'dwarf-mini/X', 'sam-s-s50-pro/Y']) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, S, 'a.fits'), '');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'jobs.json'), JSON.stringify({ jobs: [{ destination: path.join(root, S), note: root + 'x' }] }));
    fs.writeFileSync(path.join(data, 'processing.json'), JSON.stringify({ items: [{ outputs: [path.join(root, S, 'processed', 'o.jpg')] }] }));
    const store = new ProfileStore(paths);
    const p = store.adopt({ ...legacyProfile({ TELESCOPE_DRIVER: 'dwarf', DATA_DIR: data, LIBRARY_DIR: root }, paths), name: 'Dwarf 3' });
    assert.ok(usesLibraryRoot(p, paths));
    const r = moveOffLibraryRoot(p, paths, ['dwarf-mini', 'sam-s-s50-pro'])!;
    const own = path.join(root, 'dwarf-3');
    assert.equal(r.to, own, 'named after the profile, not its id');
    assert.equal(r.moved, 3);
    assert.deepEqual(fs.readdirSync(root).sort(), ['dwarf-3', 'dwarf-mini', 'sam-s-s50-pro']);
    assert.ok(fs.existsSync(path.join(own, S, 'a.fits')));
    assert.ok(fs.existsSync(path.join(own, 'CALI_FRAME', 'dark', 'cam_0')));
    const jobs = JSON.parse(fs.readFileSync(path.join(data, 'jobs.json'), 'utf8'));
    assert.equal(jobs.jobs[0].destination, path.join(own, S));
    assert.equal(jobs.jobs[0].note, root + 'x', 'only paths under the root are repointed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'processing.json'), 'utf8')).items[0].outputs[0], path.join(own, S, 'processed', 'o.jpg'));
    const after = store.setLibraryDir(p.id, r.to);
    assert.equal(usesLibraryRoot(after, paths), false);
    assert.equal(moveOffLibraryRoot(after, paths, []), null, 'once only');
    const env = childEnv(after, { ASTROPHOTO_LIBRARY_PATH: '' }, { paths, port: 18100, tunnelHost: 'x' });
    assert.equal(env.LIBRARY_DIR, own);
    assert.equal(env.ASTROPHOTO_LIBRARY_PATH, 'dwarf-3', 'Studio sees the root: the profile\'s sessions are in its folder there');
  });
});

describe('proxy paths', () => {
  test('splitPrefixed', () => {
    assert.deepEqual(splitPrefixed('/p/dwarf/api/state?x=1'), { id: 'dwarf', rest: '/api/state?x=1' });
    assert.deepEqual(splitPrefixed('/p/dwarf'), { id: 'dwarf', rest: '/' });
    assert.equal(splitPrefixed('/hub/api/profiles'), null);
    assert.equal(splitPrefixed('/p/../etc'), null);
  });
});

describe('proxy requests', () => {
  const listen = (s: http.Server): Promise<number> => new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
  const close = (s: http.Server): Promise<void> => new Promise((r) => (s.closeAllConnections(), s.close(() => r())));
  /** A hub in front of `target`; returns its port and the failures it reported. */
  async function hub(target: () => ProxyTarget) {
    const failures: string[] = [];
    const server = http.createServer((req, res) => proxyRequest(req, res, target(), req.url ?? '/', (_t, r, rest, err, n) => failures.push(`${r.method} ${rest} ${err.code} ${n}`)));
    return { server, port: await listen(server), failures };
  }
  const get = async (port: number, init: RequestInit = {}, p = '/x') => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, init);
    return { status: r.status, type: r.headers.get('content-type') ?? '', body: await r.text() };
  };

  test('a GET whose connection the child resets before answering is sent again, and answered', async () => {
    let seen = 0;
    const child = http.createServer((req, res) => (++seen === 1 ? req.socket.destroy() : res.end('ok')));
    const port = await listen(child);
    const h = await hub(() => ({ port, name: 'T', active: true, running: true }));
    try {
      assert.deepEqual(await get(h.port).then((r) => [r.status, r.body]), [200, 'ok']);
      assert.equal(seen, 2);
      assert.deepEqual(h.failures, []);
    } finally {
      await close(h.server);
      await close(child);
    }
  });

  test('a POST is never sent twice', async () => {
    let seen = 0;
    const child = http.createServer((req) => (seen++, req.socket.destroy()));
    const port = await listen(child);
    const h = await hub(() => ({ port, name: 'T', active: true, running: true }));
    try {
      const r = await get(h.port, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      assert.equal(r.status, 502);
      assert.equal(seen, 1);
      assert.equal(h.failures.length, 1);
    } finally {
      await close(h.server);
      await close(child);
    }
  });

  test('a script, image or API call that fails gets a JSON error, never the reloading HTML page; a page load gets the page', async () => {
    const dead = http.createServer();
    const port = await listen(dead);
    await close(dead); // nothing listens there now
    const h = await hub(() => ({ port, name: 'T', active: true, running: true }));
    try {
      const script = await get(h.port, { headers: { 'sec-fetch-dest': 'script' } });
      assert.equal(script.status, 502);
      assert.match(script.type, /application\/json/);
      assert.match(JSON.parse(script.body).error, /T: Not answering/);
      const page = await get(h.port, { headers: { 'sec-fetch-dest': 'iframe', accept: 'text/html' } });
      assert.equal(page.status, 502);
      assert.match(page.body, /astro-hub-wait/);
      assert.match(page.body, /location\.reload/);
      // GETs are tried twice before they count as failed
      assert.deepEqual(h.failures.map((f) => f.split(' ').at(-1)), ['2', '2']);
    } finally {
      await close(h.server);
    }
  });

  test('a profile that is not running answers 503: JSON for an asset, the waiting page for a page', async () => {
    const h = await hub(() => ({ port: 1, name: 'T', active: true, running: false }));
    try {
      const asset = await get(h.port, { headers: { accept: '*/*' } });
      assert.equal(asset.status, 503);
      assert.match(JSON.parse(asset.body).error, /Starting/);
      const page = await get(h.port, { headers: { accept: 'text/html' } });
      assert.equal(page.status, 503);
      assert.match(page.body, /Starting… This page reloads by itself/);
      assert.deepEqual(h.failures, []);
    } finally {
      await close(h.server);
    }
  });
});

describe('profile process', () => {
  const node = (code: string, port = 1) => ({ id: 't', name: 'test', port, env: { PATH: process.env.PATH ?? '' }, code });
  const make = (code: string, probe = async () => true) => new Instance({ ...node(code) }, { command: process.execPath, args: ['-e', code], cwd: process.cwd(), probe, restartMinMs: 20 });
  const until = async (inst: Instance, phase: InstanceStatus['phase'], ms = 5000) => {
    const end = Date.now() + ms;
    while (inst.status().phase !== phase) {
      if (Date.now() > end) throw new Error(`still ${inst.status().phase}, wanted ${phase}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  test('runs, stops and stays stopped', async () => {
    const inst = make('setInterval(() => {}, 1000)');
    inst.start();
    await until(inst, 'running');
    await inst.stop();
    assert.equal(inst.status().phase, 'stopped');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(inst.status().phase, 'stopped');
  });

  test('a process that keeps dying at start is given up on, with its output', async () => {
    const inst = make('console.error("configuration problems: X"); process.exit(1)', async () => false);
    inst.start();
    await until(inst, 'failed', 10_000);
    assert.ok(inst.status().restarts >= 4);
    assert.match(inst.output().join('\n'), /configuration problems/);
  });

  test('a crash while running is restarted', async () => {
    const flag = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-')), 'once');
    const inst = make(`const fs=require('fs'); if (!fs.existsSync(${JSON.stringify(flag)})) { fs.writeFileSync(${JSON.stringify(flag)}, '1'); setTimeout(() => process.exit(9), 50); } else setInterval(() => {}, 1000)`);
    const phases: string[] = [];
    inst.on('status', (st: InstanceStatus) => phases.push(st.phase));
    inst.start();
    const end = Date.now() + 5000;
    while (!(inst.status().restarts === 1 && inst.status().phase === 'running') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.equal(inst.status().restarts, 1);
    assert.ok(phases.includes('restarting'), phases.join(','));
    assert.equal(inst.status().phase, 'running');
    await inst.stop();
  });
});
