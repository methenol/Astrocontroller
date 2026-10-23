import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import { SeestarRpc, SeestarRpcError, type SeestarEvent } from '../drivers/seestar/rpc.js';
import { handshake, signChallenge } from '../drivers/seestar/auth.js';
import { encodeHeader, FrameReader, frameImage, IMG_TYPE, parseHeader, rawStackPixels, SeestarImageStream, type Frame } from '../drivers/seestar/image-stream.js';
import { applyAppState, applyDeviceState, applyEvent, busyWith, fovFromOptics, initialState, isOuter } from '../drivers/seestar/state.js';
import { ZwoTunnel } from '../drivers/seestar/tunnel.js';
import { listDevices, login } from '../drivers/seestar/zwo-cloud.js';
import { toJpeg, type FloatImage } from '../media/images.js';
import { FakeSeestar, testKeys } from './fake-seestar.js';

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const ev = (e: Record<string, unknown>): SeestarEvent => ({ Event: String(e.Event), at: 1000, ...e }) as SeestarEvent;

describe('Seestar control link', () => {
  let fake: FakeSeestar;
  let rpc: SeestarRpc | null = null;
  afterEach(async () => {
    rpc?.stop();
    rpc = null;
    await fake?.close();
  });

  const link = (loadKey: () => string | null = () => null, extra = {}) => {
    rpc = new SeestarRpc({ host: '127.0.0.1', port: fake.port, loadKey, backoffMinMs: 50, ...extra });
    rpc.start();
    return rpc;
  };

  test('older firmware (get_verify_str unknown): no handshake, commands and replies match by id', async () => {
    fake = new FakeSeestar();
    fake.noHandshakeMethod = true;
    await fake.listen();
    fake.on('get_device_state', () => ({ result: { device: { name: 'S30' } } }));
    fake.on('scope_get_equ_coord', () => ({ result: { ra: 5.5, dec: 22 } }));
    const r = link();
    await until(() => r.usable);
    const [a, b] = await Promise.all([r.request('get_device_state'), r.request('scope_get_equ_coord')]);
    assert.deepEqual(a.result, { device: { name: 'S30' } });
    assert.deepEqual(b.result, { ra: 5.5, dec: 22 });
    assert.equal(r.health().authRequired, false);
  });

  test('firmware 7.18+: the challenge is signed with the key and verified by the scope', async () => {
    const keys = testKeys();
    fake = new FakeSeestar();
    fake.publicPem = keys.publicPem;
    await fake.listen();
    const r = link(() => keys.privatePem);
    await until(() => r.usable);
    assert.equal(fake.verified, 1);
    assert.deepEqual(r.health().authenticated, true);
    assert.deepEqual(fake.methods().slice(0, 3), ['get_verify_str', 'verify_client', 'pi_is_verified']);
  });

  test('a handshake without a key, or with the wrong key, is reported and the link never becomes usable', async () => {
    const keys = testKeys();
    fake = new FakeSeestar();
    fake.publicPem = keys.publicPem;
    await fake.listen();
    const failures: string[] = [];
    const r = link(() => null);
    r.on('authFailed', (m: string) => failures.push(m));
    await until(() => failures.length > 0);
    assert.match(failures[0], /SEESTAR_KEY_PATH/);
    assert.equal(r.usable, false);
    r.stop();
    const wrong = link(() => testKeys().privatePem);
    const f2: string[] = [];
    wrong.on('authFailed', (m: string) => f2.push(m));
    await until(() => f2.length > 0);
    assert.match(f2[0], /rejected the handshake/);
  });

  test('a non-zero code rejects with the code and the scope\'s error, unless allowError', async () => {
    fake = new FakeSeestar();
    await fake.listen();
    fake.on('iscope_start_view', () => ({ code: 207, error: 'fail to operate' }));
    const r = link();
    await until(() => r.usable);
    await assert.rejects(r.request('iscope_start_view'), (e: unknown) => e instanceof SeestarRpcError && e.code === 207 && /fail to operate/.test(e.message));
    const ok = await r.request('iscope_start_view', undefined, { allowError: true });
    assert.equal(ok.code, 207);
  });

  test('events are emitted with their name (Event or event), and a request without a reply times out', async () => {
    fake = new FakeSeestar();
    await fake.listen();
    fake.on('never', () => null);
    const r = link();
    const got: SeestarEvent[] = [];
    r.on('event', (e: SeestarEvent) => got.push(e));
    await until(() => r.usable);
    fake.event({ Event: 'PiStatus', battery_capacity: 80 });
    fake.event({ event: 'Stack', state: 'frame_complete', stacked_frame: 3 });
    await until(() => got.length === 2);
    assert.equal(got[0].Event, 'PiStatus');
    assert.equal(got[1].Event, 'Stack');
    assert.equal(got[1].stacked_frame, 3);
    await assert.rejects(r.request('never', undefined, { timeoutMs: 100 }), /no reply/);
  });

  test('the link reconnects after the scope drops it, and after silence', async () => {
    fake = new FakeSeestar();
    await fake.listen();
    const r = link(() => null, { heartbeatMs: 50, silentAfterMs: 300 });
    let downs = 0;
    r.on('disconnected', () => downs++);
    await until(() => r.usable);
    fake.kick();
    await until(() => downs === 1);
    await until(() => r.usable);
    fake.silent = true;
    await until(() => downs === 2);
    fake.silent = false;
    await until(() => r.usable);
    assert.ok(r.health().reconnects >= 2);
  });

  test('handshake: a challenge in result directly is signed too', async () => {
    const keys = testKeys();
    const sent: Array<[string, unknown]> = [];
    const send = async (m: string, p: unknown) => {
      sent.push([m, p]);
      return m === 'get_verify_str' ? { id: 1, code: 0, result: 'abc' } : { id: 2, code: 0 };
    };
    const r = await handshake(send, () => keys.privatePem);
    assert.deepEqual(r, { required: true, verified: true });
    assert.deepEqual(sent[1], ['verify_client', { sign: signChallenge(keys.privatePem, 'abc'), data: 'abc' }]);
  });
});

describe('Seestar image stream', () => {
  const frame = (imgType: number, payload: Buffer, w = 0, h = 0, imageId = 1) => Buffer.concat([encodeHeader({ imgType, length: payload.length, width: w, height: h, imageId }), payload]);

  test('the header round-trips', () => {
    const h = parseHeader(encodeHeader({ imgType: IMG_TYPE.rawStack, length: 1234, width: 1080, height: 1920, imageId: 7, hfd: 250 }))!;
    assert.equal(h.imgType, 5);
    assert.equal(h.length, 1234);
    assert.equal(h.width, 1080);
    assert.equal(h.height, 1920);
    assert.equal(h.imageId, 7);
    assert.equal(h.hfd, 250);
    assert.equal(h.headerSize, 80);
  });

  test('frames are split out of a byte stream with JSON lines and junk between them, in any chunking', () => {
    const p1 = Buffer.alloc(5000, 1);
    const p2 = Buffer.from([9, 9, 9]);
    const stream = Buffer.concat([Buffer.from('{"id":1,"code":0}\r\n'), frame(IMG_TYPE.ack, Buffer.alloc(0)), Buffer.from([0, 1, 2]), frame(IMG_TYPE.jpegStack, p1), Buffer.from('{"Event":"x"}\n'), frame(IMG_TYPE.preview, p2, 1, 1)]);
    for (const size of [1, 7, 100, stream.length]) {
      const frames: Frame[] = [];
      const json: unknown[] = [];
      const r = new FrameReader((f) => frames.push(f), (m) => json.push(m));
      for (let i = 0; i < stream.length; i += size) r.push(stream.subarray(i, i + size));
      assert.deepEqual(
        frames.map((f) => [f.header.imgType, f.payload.length]),
        [
          [0, 0],
          [4, 5000],
          [1, 3],
        ],
        `chunk ${size}`,
      );
      assert.equal(json.length, 2);
    }
  });

  test('raw stacks: plain RGB48, or wrapped in a streaming ZIP', async () => {
    const w = 4;
    const h = 2;
    const px = Buffer.alloc(w * h * 6);
    for (let i = 0; i < w * h * 3; i++) px.writeUInt16LE(i * 1000, i * 2);
    assert.equal(rawStackPixels(px, w, h), px);
    const name = Buffer.from('raw_data');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(name.length, 26);
    const zip = Buffer.concat([local, name, zlib.deflateRawSync(px)]);
    assert.deepEqual(rawStackPixels(zip, w, h), px);
    assert.throws(() => rawStackPixels(Buffer.alloc(10), w, h), /neither/);
    const img = await frameImage({ header: parseHeader(encodeHeader({ imgType: IMG_TYPE.rawStack, length: zip.length, width: w, height: h }))!, payload: zip, at: 5 }, 'tele');
    assert.equal(img.channels, 3);
    assert.equal(img.linear, true);
    assert.equal(img.camera, undefined);
    assert.ok(Math.abs(img.data[1] - 1000 / 65535) < 1e-6);
  });

  test('a preview sub is binned 2×2 to luminance; a JPEG stack decodes as display data', async () => {
    const w = 4;
    const h = 2;
    const px = Buffer.alloc(w * h * 2);
    for (let i = 0; i < w * h; i++) px.writeUInt16LE(i < 2 || (i >= 4 && i < 6) ? 65535 : 0, i * 2);
    const prev = await frameImage({ header: parseHeader(encodeHeader({ imgType: IMG_TYPE.preview, length: px.length, width: w, height: h }))!, payload: px, at: 5 }, 'tele');
    assert.deepEqual([prev.width, prev.height, prev.channels], [2, 1, 1]);
    assert.deepEqual([...prev.data].map((v) => +v.toFixed(3)), [1, 0]);
    const src: FloatImage = { width: 16, height: 8, channels: 1, data: new Float32Array(128).fill(0.5), linear: false, source: 't' };
    const jpeg = await toJpeg(src, 16);
    const img = await frameImage({ header: parseHeader(encodeHeader({ imgType: IMG_TYPE.jpegStack, length: jpeg.length }))!, payload: jpeg, at: 5 }, 'tele');
    assert.equal(img.width, 16);
    assert.equal(img.linear, false);
  });

  test('grab asks the image port for the stacked frame and skips the ack', async () => {
    const fake = new FakeSeestar();
    await fake.listen();
    const payload = Buffer.alloc(4 * 2 * 6, 0x10);
    fake.frames.stacked = Buffer.concat([frame(IMG_TYPE.ack, Buffer.alloc(0)), frame(IMG_TYPE.rawStack, payload, 4, 2, 42)]);
    const s = new SeestarImageStream('127.0.0.1', fake.imagePort, 'tele');
    try {
      const f = await s.grab('stacked', 2000);
      assert.equal(f.header.imageId, 42);
      assert.equal(f.payload.length, payload.length);
      assert.ok(fake.methods().includes('image:get_stacked_img'));
      await assert.rejects(s.grab('preview', 200), /no preview frame/);
    } finally {
      s.close();
      await fake.close();
    }
  });
});

describe('Seestar state', () => {
  test('the field of view comes from the reported optics', () => {
    const f = fovFromOptics([1080, 1920], 2.9, 150)!;
    assert.ok(Math.abs(f.h - 2.127) < 0.01, String(f.h));
    assert.ok(Math.abs(f.v - 1.196) < 0.01, String(f.v));
    assert.equal(fovFromOptics(undefined, 2.9, 150), null);
  });

  test('device state is folded in and kept in full, as sent', () => {
    const st = initialState('local');
    const r = {
      device: { name: 'Seestar S30', product_model: 'Seestar S30', sn: 'ABC', firmware_ver_string: '7.32', firmware_ver_int: 2732, focal_len: 150, fnumber: 5 },
      camera: { chip_size: [1080, 1920], pixel_size_um: 2.9 },
      mount: { tracking: true, equ_mode: false, close: false },
      focuser: { step: 1600, max_step: 2600 },
      pi_status: { battery_capacity: 77, charge_online: true, temp: 31.5 },
      storage: { storage_volume: [{ freeMB: 50_000, totalMB: 60_000 }] },
      ap: { ssid: 'S30_ABC', passwd: '12345678' },
    };
    applyDeviceState(st, r);
    assert.equal(st.device.model, 'Seestar S30');
    assert.equal(st.device.firmwareInt, 2732);
    assert.deepEqual(st.fov, fovFromOptics([1080, 1920], 2.9, 150));
    assert.equal(st.mount.tracking, true);
    assert.equal(st.focus.maxStep, 2600);
    assert.equal(st.power.batteryPct, 77);
    assert.equal(st.storage.freeMB, 50_000);
    assert.deepEqual((st.deviceState as typeof r).ap, { ssid: 'S30_ABC', passwd: '12345678' });
  });

  test('a step that ends is not the operation ending; the outer frame is', () => {
    const st = initialState('local');
    applyEvent(st, ev({ Event: 'AutoGoto', state: 'start', route: [] }));
    assert.equal(busyWith(st), 'goto');
    applyEvent(st, ev({ Event: 'AutoGoto', state: 'fail', page: 'preview', error: 'solve failed', code: 251 }));
    assert.equal(busyWith(st), 'goto');
    assert.equal(st.ops['AutoGoto.step'].error, 'solve failed');
    applyEvent(st, ev({ Event: 'AutoGoto', state: 'complete', lapse_ms: 50_000, route: [] }));
    assert.equal(busyWith(st), null);
    assert.equal(isOuter({ state: 'complete', lapse_ms: 1 }), true);
    assert.equal(isOuter({ state: 'complete', page: 'x', lapse_ms: 1 }), false);
  });

  test('stack frames, power, alerts and pointing; quiet events stay out of the recent list', () => {
    const st = initialState('zwo');
    applyEvent(st, ev({ Event: 'Stack', state: 'working' }));
    applyEvent(st, ev({ Event: 'Stack', state: 'frame_complete', stacked_frame: 12, dropped_frame: 1 }));
    assert.equal(st.stack.state, 'working');
    assert.equal(st.stack.stacked, 12);
    assert.equal(busyWith(st), 'stacking');
    applyEvent(st, ev({ Event: 'PiStatus', battery_capacity: 50, charger_status: 'Discharging' }));
    applyEvent(st, ev({ Event: 'ScopeGoto', state: 'working', cur_ra_dec: [10.5, 41.2] }));
    applyEvent(st, ev({ Event: 'Alert', error: 'low battery', code: 1 }));
    assert.equal(st.power.batteryPct, 50);
    assert.deepEqual([st.mount.raHours, st.mount.decDeg], [10.5, 41.2]);
    assert.equal(st.alert?.error, 'low battery');
    assert.ok(!st.recent.some((r) => r.name === 'PiStatus'));
    applyAppState(st, { View: { state: 'working', stage: 'Stack', target_name: 'M 81', Stack: { state: 'working', stacked_frame: 20, dropped_frame: 2 } } });
    assert.equal(st.view.target, 'M 81');
    assert.equal(st.stack.stacked, 20);
  });
});

describe('ZWO tunnel supervisor', () => {
  class FakeChild extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    exitCode: number | null = null;
    signals: string[] = [];
    kill(sig: string) {
      this.signals.push(sig);
      this.exitCode = 0;
      this.emit('exit', null, sig);
      return true;
    }
  }

  test('up only after the banner and an open port; restarted after it exits; SIGINT on stop', async () => {
    const children: FakeChild[] = [];
    let open = false;
    const t = new ZwoTunnel({
      host: '127.0.0.1',
      port: 4700,
      command: 'seestar-portfwd',
      readyTimeoutS: 60,
      env: { SEESTAR_USER: 'u' },
      spawnFn: ((_cmd: string, o: { env: Record<string, string> }) => {
        assert.equal(o.env.SEESTAR_USER, 'u');
        const c = new FakeChild();
        children.push(c);
        return c;
      }) as never,
      probeFn: async () => open,
    });
    const phases: string[] = [];
    t.on('status', (s: { phase: string }) => phases.push(s.phase));
    t.start();
    assert.equal(t.status().phase, 'starting');
    open = true; // Docker's proxy accepts at once
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.status().phase, 'starting');
    children[0].stdout.write('[*] forwarding 12 ports:\n[*] tunnel ready - press Ctrl-C to disconnect\n');
    await until(() => t.status().phase === 'up', 5000);
    assert.ok(t.status().output.some((l) => /tunnel ready/.test(l)));
    children[0].exitCode = 1;
    children[0].emit('exit', 1, null);
    assert.equal(t.status().phase, 'down');
    assert.equal(t.status().lastExit, 'exit code 1');
    t.stop();
    assert.equal(t.status().phase, 'stopped');
    t.start();
    t.stop();
    assert.deepEqual(children[1].signals, ['SIGINT']);
  });

  test('without a command the tunnel is the user\'s and only its port is watched', async () => {
    let open = false;
    const t = new ZwoTunnel({ host: '127.0.0.1', port: 4700, command: '', readyTimeoutS: 60, env: {}, probeFn: async () => open });
    t.start();
    assert.equal(t.status().phase, 'unmanaged');
    open = true;
    t.restart();
    await until(() => t.status().phase === 'up');
    t.stop();
  });
});

describe('ZWO account API', () => {
  test('logs in and lists the devices with their network state, detail merged in', async () => {
    const urls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      urls.push(url);
      const h = init.headers as Record<string, string>;
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (url.endsWith('/v1/user/login')) {
        assert.deepEqual(JSON.parse(String(init.body)), { authKey: 'me@example.com', password: 'pw', authType: 'email' });
        return json({ code: 0, data: { accessToken: 'TOKEN' } });
      }
      assert.equal(h.Authorization, 'TOKEN');
      assert.equal(h['x-service-platform'], 'seestar');
      if (url.includes('/my-device/detail')) return json({ data: { remoteMode: 1, address: 'Starfront' } });
      return json({ data: { list: [{ deviceSn: 'S30X', deviceModel: 'S30', deviceStatus: 3 }] } });
    }) as typeof fetch;
    const d = await listDevices({ user: 'me@example.com', password: 'pw', fetch: f });
    assert.equal(d.length, 1);
    assert.deepEqual([d[0].serial, d[0].status, d[0].remoteMode, d[0].address], ['S30X', 'shooting', 'relay', 'Starfront']);
    assert.equal(urls.length, 3);
    await assert.rejects(login('me@example.com', 'bad', (async () => new Response('{"msg":"wrong password"}', { status: 401 })) as typeof fetch), /HTTP 401 \(wrong password\)/);
    await assert.rejects(listDevices({ user: '', password: '' }), /SEESTAR_USER/);
  });
});
