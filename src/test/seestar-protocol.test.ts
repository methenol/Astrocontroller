import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import { SeestarLink, SeestarRpcError, type SeestarEvent } from '../drivers/seestar/link.js';
import { handshake, signChallenge } from '../drivers/seestar/auth.js';
import { encodeHeader, FrameReader, frameImage, IMG_TYPE, parseHeader, rawStackPixels, type Frame } from '../drivers/seestar/frames.js';
import { SeestarImageLink } from '../drivers/seestar/image-link.js';
import { applyAppState, applyDeviceState, applyEvent, busyWith, fovFromOptics, initialState, isOuter, reconcileLostOps } from '../drivers/seestar/model.js';
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ev = (e: Record<string, unknown>): SeestarEvent => ({ Event: String(e.Event), at: 1000, ...e }) as SeestarEvent;
const noKey = (): string => {
  throw new Error('SEESTAR_KEY_PATH is not set: the Seestar refuses every request until the app key signs its challenge');
};

describe('Seestar control link', () => {
  let fake: FakeSeestar;
  let rpc: SeestarLink | null = null;
  afterEach(async () => {
    rpc?.stop();
    rpc = null;
    await fake?.close();
  });

  const link = (loadKey: () => string = noKey, extra = {}) => {
    rpc = new SeestarLink({ host: '127.0.0.1', port: fake.port, loadKey, backoffMinMs: 50, ...extra });
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
    const r = link(noKey);
    r.on('authFailed', (m: string) => failures.push(m));
    await until(() => failures.length > 0);
    assert.match(failures[0]!, /SEESTAR_KEY_PATH/);
    assert.equal(r.usable, false);
    r.stop();
    const wrong = link(() => testKeys().privatePem);
    const f2: string[] = [];
    wrong.on('authFailed', (m: string) => f2.push(m));
    await until(() => f2.length > 0);
    assert.match(f2[0]!, /rejected the handshake/);
  });

  test("a non-zero code rejects with the code and the scope's error, unless allowError", async () => {
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
    assert.equal(got[0]!.Event, 'PiStatus');
    assert.equal(got[1]!.Event, 'Stack');
    assert.equal(got[1]!.stacked_frame, 3);
    await assert.rejects(r.request('never', undefined, { timeoutMs: 100 }), /never: no reply from the Seestar/);
  });

  test('over the tunnel a stall shorter than the silence allowance keeps the link, and a request waits at least the floor', async () => {
    fake = new FakeSeestar();
    await fake.listen();
    fake.on('never', () => null);
    const r = link(noKey, { heartbeatMs: 50, silentAfterMs: 600, minRequestTimeoutMs: 400 });
    let downs = 0;
    r.on('disconnected', () => downs++);
    await until(() => r.usable);
    fake.silent = true;
    await wait(300);
    fake.silent = false;
    await wait(200);
    assert.equal(downs, 0);
    assert.equal(r.usable, true);
    const t0 = Date.now();
    await assert.rejects(r.request('never', undefined, { timeoutMs: 50 }), /never: no reply from the Seestar/);
    assert.ok(Date.now() - t0 >= 380, 'the request was given the floor, not its own 50 ms');
  });

  test('the link reconnects after the scope drops it, and after silence; a request in flight fails with the reason', async () => {
    fake = new FakeSeestar();
    await fake.listen();
    fake.on('slow', () => null);
    const r = link(noKey, { heartbeatMs: 50, silentAfterMs: 300 });
    let downs = 0;
    r.on('disconnected', () => downs++);
    await until(() => r.usable);
    const inFlight = r.request('slow', undefined, { timeoutMs: 5000 });
    await wait(20);
    fake.kick();
    await assert.rejects(inFlight, /slow: the connection to the Seestar closed/);
    await until(() => downs === 1);
    await until(() => r.usable);
    fake.silent = true;
    await until(() => downs === 2);
    fake.silent = false;
    await until(() => r.usable);
    assert.ok(r.health().reconnects >= 2);
    const lines = r.wireLines(10);
    assert.ok(lines.length > 0 && lines.length <= 10);
  });

  test('handshake: a challenge in result.str is signed', async () => {
    const keys = testKeys();
    const sent: Array<[string, unknown]> = [];
    const send = async (m: string, p: unknown) => {
      sent.push([m, p]);
      return m === 'get_verify_str' ? { id: 1, code: 0, result: { str: 'abc' } } : { id: 2, code: 0 };
    };
    const r = await handshake(send, () => keys.privatePem);
    assert.deepEqual(r, { required: true, verified: true });
    assert.deepEqual(sent[1], ['verify_client', { sign: signChallenge(keys.privatePem, 'abc'), data: 'abc' }]);
  });
});

describe('Seestar picture frames', () => {
  const frame = (imgType: number, payload: Buffer, w = 0, h = 0, imageId = 1) => Buffer.concat([encodeHeader({ imgType, length: payload.length, width: w, height: h, imageId }), payload]);

  test('the header round-trips', () => {
    const h = parseHeader(encodeHeader({ imgType: IMG_TYPE.rawStack, length: 1234, width: 1080, height: 1920, imageId: 7, hfdValue: 250 }));
    assert.equal(h.imgType, 5);
    assert.equal(h.length, 1234);
    assert.equal(h.width, 1080);
    assert.equal(h.height, 1920);
    assert.equal(h.imageId, 7);
    assert.equal(h.hfdValue, 250);
    assert.equal(h.headerSize, 80);
  });

  test('frames are split out of a byte stream with JSON lines and junk between them, in any chunking', () => {
    const p1 = Buffer.alloc(5000, 1);
    const p2 = Buffer.from([9, 9, 9]);
    const stream = Buffer.concat([Buffer.from('{"id":1,"code":0}\r\n'), frame(IMG_TYPE.ack, Buffer.alloc(0)), Buffer.from([0, 1, 2]), frame(IMG_TYPE.jpegStack, p1), Buffer.from('{"Event":"x"}\n'), frame(IMG_TYPE.preview, p2, 1, 1)]);
    for (const size of [1, 7, 100, stream.length]) {
      const frames: Frame[] = [];
      const json: unknown[] = [];
      const r = new FrameReader(
        (f) => frames.push(f),
        (m) => json.push(m),
      );
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
    const plain = rawStackPixels(px, w, h, 'x');
    assert.ok(Math.abs(plain[1]! - 1000 / 65535) < 1e-6);
    const name = Buffer.from('raw_data');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(name.length, 26);
    const zip = Buffer.concat([local, name, zlib.deflateRawSync(px)]);
    assert.deepEqual(rawStackPixels(zip, w, h, 'x'), plain);
    assert.throws(() => rawStackPixels(Buffer.alloc(10), w, h, 'x'), /neither/);
    const img = await frameImage({ header: parseHeader(encodeHeader({ imgType: IMG_TYPE.rawStack, length: zip.length, width: w, height: h })), payload: zip, at: 5 }, 'tele');
    assert.equal(img.channels, 3);
    assert.equal(img.linear, true);
    assert.equal(img.camera, undefined);
    assert.ok(Math.abs(img.data[1]! - 1000 / 65535) < 1e-6);
  });

  test('a preview sub is debayered GRBG 2×2 to half-size colour; a JPEG stack decodes as display data', async () => {
    const w = 4;
    const h = 2;
    const px = Buffer.alloc(w * h * 2);
    // left cell: G=0 R=65535 / B=32768 G=16384 -> (1, 0.125, 0.5); right cell dark
    const vals = [0, 65535, 0, 0, 32768, 16384, 0, 0];
    vals.forEach((v, i) => px.writeUInt16LE(v, i * 2));
    const prev = await frameImage({ header: parseHeader(encodeHeader({ imgType: IMG_TYPE.preview, length: px.length, width: w, height: h })), payload: px, at: 5 }, 'tele');
    assert.deepEqual([prev.width, prev.height, prev.channels], [2, 1, 3]);
    assert.deepEqual([...prev.data].map((v) => +v.toFixed(3)), [1, 0.125, 0.5, 0, 0, 0]);
    assert.equal(prev.header?.binned, 2);
    const src: FloatImage = { width: 16, height: 8, channels: 1, data: new Float32Array(128).fill(0.5), linear: false, source: 't' };
    const jpeg = await toJpeg(src, 16);
    const img = await frameImage({ header: parseHeader(encodeHeader({ imgType: IMG_TYPE.jpegStack, length: jpeg.length })), payload: jpeg, at: 5 }, 'tele');
    assert.equal(img.width, 16);
    assert.equal(img.linear, false);
  });
});

describe('Seestar picture socket', () => {
  const frame = (imgType: number, payload: Buffer, w = 0, h = 0, imageId = 1) => Buffer.concat([encodeHeader({ imgType, length: payload.length, width: w, height: h, imageId }), payload]);

  test('a grab asks the socket for the stacked frame and skips the ack; a preview needs the stream', async () => {
    const fake = new FakeSeestar();
    await fake.listen();
    const payload = Buffer.alloc(4 * 2 * 6, 0x10);
    fake.frames.stacked = Buffer.concat([frame(IMG_TYPE.ack, Buffer.alloc(0)), frame(IMG_TYPE.rawStack, payload, 4, 2, 42)]);
    const s = new SeestarImageLink('127.0.0.1', fake.imagePort, 'tele');
    try {
      await assert.rejects(s.grab('stacked', 200), /picture socket is not connected/);
      s.open();
      await until(() => s.connected);
      const f = await s.grab('stacked', 2000);
      assert.equal(f.header.imageId, 42);
      assert.equal(f.payload.length, payload.length);
      assert.ok(fake.methods().includes('image:get_stacked_img'));
      await assert.rejects(s.grab('preview', 200), /no frame from the tele camera/);
      assert.equal(s.streaming, false);
    } finally {
      s.close();
      await fake.close();
    }
  });

  test('the stream: begin_streaming once, frames as they come, the socket kept and a heartbeat on it', async () => {
    const fake = new FakeSeestar();
    await fake.listen();
    const payload = Buffer.alloc(4 * 2 * 2, 0x20);
    fake.frames.widePreview = frame(IMG_TYPE.preview, payload, 4, 2, 65535);
    const s = new SeestarImageLink('127.0.0.1', fake.wideImagePort, 'wide');
    try {
      s.startStream(); // asked before the socket is up: remembered
      s.open();
      await until(() => s.connected && s.streaming);
      const [a, b] = await Promise.all([s.grab('preview', 2000), s.grab('preview', 2000)]);
      assert.equal(a.header.imageId, 65535);
      assert.equal(a, b, 'two callers waiting at once share the one exposure');
      assert.equal(fake.methods().filter((m) => m === 'wide:begin_streaming').length, 1);
      assert.ok(!fake.methods().includes('wide:get_current_img'), 'the cached frame was asked for');
      let pushed = 0;
      s.on('frame', (_f: unknown, kind: string | null) => kind === null && pushed++);
      await wait(450);
      assert.ok(pushed >= 3, `pushed ${pushed}`);
      assert.ok(s.liveFrames >= 3);
      assert.ok(!fake.methods().includes('wide:stop_streaming'), 'the stream was stopped');
      assert.equal(fake.imageConnections, 1, "the connection is the session's: one socket, kept");
      s.stopStream();
      await until(() => fake.methods().includes('wide:stop_streaming'));
      assert.ok(s.connected);
      assert.deepEqual(s.status().camera, 'wide');
    } finally {
      s.close();
      await fake.close();
    }
  });

  test('firmware 9.75 in Jpg mode pushes the live frames as JPEGs with their own running ids: still live, still the preview', async () => {
    const fake = new FakeSeestar();
    await fake.listen();
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(30, 0x11)]);
    fake.frames.preview = frame(IMG_TYPE.jpegStack, jpeg, 0, 0, 24761);
    const s = new SeestarImageLink('127.0.0.1', fake.imagePort, 'tele');
    try {
      s.open();
      s.startStream();
      await until(() => s.connected && s.streaming);
      let stackedError: Error | null = null;
      const stacked = s.grab('stacked', 800).catch((e: Error) => {
        stackedError = e;
      });
      const live = await s.grab('preview', 2000);
      assert.equal(live.header.imageId, 24761);
      assert.equal(live.header.imgType, IMG_TYPE.jpegStack);
      await wait(350);
      assert.ok(s.liveFrames >= 3, `live frames ${s.liveFrames}`);
      assert.equal(stackedError, null, 'a pushed JPEG was taken for the stacked image');
      await stacked;
      assert.match(String(stackedError), /no stacked image/);
    } finally {
      s.close();
      await fake.close();
    }
  });

  test('a live frame landing leaves a waiting stacked grab alone; a drop fails it and redials', async () => {
    const fake = new FakeSeestar();
    await fake.listen();
    fake.frames.stacked = undefined; // a stack with no frame yet answers with nothing at all
    fake.frames.preview = frame(IMG_TYPE.preview, Buffer.alloc(16, 0x20), 4, 2, 65535);
    const s = new SeestarImageLink('127.0.0.1', fake.imagePort, 'tele');
    try {
      s.open();
      s.startStream();
      await until(() => s.connected);
      let stackedError: Error | null = null;
      const stacked = s.grab('stacked', 1200).catch((e: Error) => {
        stackedError = e;
      });
      const live = await s.grab('preview', 2000);
      assert.equal(live.header.imageId, 65535);
      await wait(300);
      assert.equal(stackedError, null, 'the stacked grab was failed by the live grab finishing');
      await stacked;
      assert.match(String(stackedError), /no stacked image from the tele camera/);
      const again = s.grab('stacked', 5000);
      const next = s.grab('preview', 5000);
      await wait(20);
      fake.kick();
      await assert.rejects(again, /picture socket closed/);
      await until(() => s.connected && s.streaming, 5000);
      assert.equal((await next).header.imageId, 65535, 'the wait for a live frame carries over the redial');
    } finally {
      s.close();
      await fake.close();
    }
  });
});

describe('Seestar model', () => {
  test('the field of view comes from the reported optics', () => {
    // chip_size is [width, height] as the frames are read (an S50 Pro: [2160, 3840], FITS NAXIS1 = 2160)
    const f = fovFromOptics([1080, 1920], 2.9, 150)!;
    assert.ok(Math.abs(f.h - 1.196) < 0.01, String(f.h));
    assert.ok(Math.abs(f.v - 2.127) < 0.01, String(f.v));
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

  test('an operation whose closing event was lost with the link ends on the reconnect resync', () => {
    const st = initialState('zwo');
    applyEvent(st, ev({ Event: 'AutoFocus', state: 'working', route: [] }));
    assert.equal(busyWith(st), 'autofocus');
    // the link drops; AutoFocus complete is sent meanwhile and lost. After the reconnect the scope's
    // app state shows the tele back on its continuous exposure: the autofocus no longer runs
    applyAppState(st, { View: { state: 'working', mode: 'star', stage: 'ContinuousExposure' } });
    assert.deepEqual(reconcileLostOps(st), ['AutoFocus']);
    assert.equal(st.ops['AutoFocus']!.state, 'ended');
    assert.equal(busyWith(st), null);
  });

  test('an operation the scope still shows as its stage keeps running across the reconnect', () => {
    const st = initialState('zwo');
    applyEvent(st, ev({ Event: 'AutoFocus', state: 'working', route: [] }));
    applyAppState(st, { View: { state: 'working', mode: 'star', stage: 'AutoFocus' } });
    assert.deepEqual(reconcileLostOps(st), []);
    assert.equal(busyWith(st), 'autofocus');
  });

  test('a step that ends is not the operation ending; the outer frame is', () => {
    const st = initialState('local');
    applyEvent(st, ev({ Event: 'AutoGoto', state: 'start', route: [] }));
    assert.equal(busyWith(st), 'goto');
    applyEvent(st, ev({ Event: 'AutoGoto', state: 'fail', page: 'preview', error: 'solve failed', code: 251 }));
    assert.equal(busyWith(st), 'goto');
    assert.equal(st.ops['AutoGoto.step']!.error, 'solve failed');
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
    assert.ok(!st.recent.some((r) => r.event === 'PiStatus'));
    applyAppState(st, { View: { state: 'working', stage: 'Stack', target_name: 'M 81', Stack: { state: 'working', stacked_frame: 20, dropped_frame: 2 } } });
    assert.equal(st.view.target, 'M 81');
    assert.equal(st.stack.stacked, 20);
  });

  test('the two views: the second view is the wide camera, and the selected camera follows the app state', () => {
    const st = initialState('local');
    applyAppState(st, { View: { state: 'working', stage: 'ContinuousExposure', mode: 'star' }, SecondView: { state: 'working', stage: 'Sleep', mode: 'star' }, selected_cam: 'SecondView' });
    assert.equal(st.view.stage, 'ContinuousExposure');
    assert.equal(st.secondView.stage, 'Sleep');
    assert.equal(st.camera, 'wide');
    applyEvent(st, ev({ Event: 'SecondView', state: 'working', stage: 'ContinuousExposure', mode: 'star' }));
    assert.equal(st.secondView.stage, 'ContinuousExposure');
    applyEvent(st, ev({ Event: 'SelectCamera', selected_cam: 'View' }));
    assert.equal(st.camera, 'tele');
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
    await wait(20);
    assert.equal(t.status().phase, 'starting');
    children[0]!.stdout.write('[*] forwarding 12 ports:\n[*] tunnel ready - press Ctrl-C to disconnect\n');
    await until(() => t.status().phase === 'up', 5000);
    assert.ok(t.status().output.some((l) => /tunnel ready/.test(l)));
    children[0]!.exitCode = 1;
    children[0]!.emit('exit', 1, null);
    assert.equal(t.status().phase, 'down');
    assert.equal(t.status().lastExit, 'exit code 1');
    t.stop();
    assert.equal(t.status().phase, 'stopped');
    t.start();
    t.stop();
    assert.deepEqual(children[1]!.signals, ['SIGINT']);
  });

  test("without a command the tunnel is the user's and only its port is watched", async () => {
    let open = false;
    const t = new ZwoTunnel({ host: '127.0.0.1', port: 4700, command: '', readyTimeoutS: 60, env: {}, probeFn: async () => open });
    t.start();
    assert.equal(t.status().phase, 'unmanaged');
    open = true;
    t.restart();
    await until(() => t.status().phase === 'up');
    t.stop();
  });

  /** the JSON the supervisor inside the tunnel container answers on GET /status */
  const supState = (over: Record<string, unknown> = {}) => ({
    phase: 'idle',
    desired: 'disconnected',
    attempts: 0,
    reconnects: 0,
    lastError: null,
    lastExit: null,
    device: null,
    session: null,
    portOpen: false,
    mode: null,
    upSince: null,
    leaseSeconds: null,
    leaseExpiresAt: null,
    backoffSeconds: 1,
    stopping: false,
    output: [],
    ...over,
  });

  const supervisorTunnel = (fetchFn: typeof fetch, probeFn: () => Promise<boolean>, supervisor: { host: string; port: number; token?: string; leaseS: number }) =>
    new ZwoTunnel({ host: '127.0.0.1', port: 4700, command: '', readyTimeoutS: 60, env: {}, probeMs: 20, probeFn, fetchFn, supervisor });

  test('Connect asks the container for the telescope and Disconnect releases it', async () => {
    const sent: { url: string; body: Record<string, unknown>; auth: string }[] = [];
    let state = supState();
    const fetchFn = (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : {}, auth: String((init.headers as Record<string, string>).authorization ?? '') });
      if (String(url).endsWith('/connect')) state = supState({ phase: 'connected', desired: 'connected', attempts: 1, mode: 'P2P (direct)', device: { sn: 'S50-1', model: 'Seestar S50 Pro', status: 'ONLINE' }, session: { sn: 'S50-1', conId: 'CON123…' }, output: ['[*] mode P2P (direct), remote 1.2.3.4', '[*] tunnel ready - press Ctrl-C to disconnect'] });
      if (String(url).endsWith('/disconnect')) state = supState({ phase: 'idle', lastExit: 'exit code 0' });
      return new Response(JSON.stringify(state), { status: 200 });
    }) as typeof fetch;
    const t = supervisorTunnel(fetchFn, async () => true, { host: 'seestar-portfwd', port: 4710, token: 'sekret', leaseS: 180 });
    assert.equal(t.status().managed, true, 'the container tunnel is ours to drive');
    t.start();
    const connect = sent.find((r) => r.url.endsWith('/connect'));
    assert.ok(connect, 'Connect takes the scope from the container');
    assert.equal(connect.body.leaseS, 180, 'and only while we keep refreshing it');
    assert.equal(connect.auth, 'Bearer sekret');
    await until(() => t.status().phase === 'up');
    const st = t.status();
    assert.equal(st.supervisor?.phase, 'connected');
    assert.equal(st.supervisor?.device?.status, 'ONLINE', 'what the scope itself reports travels with it');
    assert.deepEqual(st.output.slice(-1), ['[*] tunnel ready - press Ctrl-C to disconnect'], "the container's tunnel lines reach the agent");
    assert.equal(st.detail, null);
    t.stop();
    assert.equal(t.status().phase, 'stopped');
    t.restart();
    assert.equal(sent.filter((r) => r.url.endsWith('/disconnect')).length, 2, 'a restart releases the session and takes it again');
    await until(() => t.status().phase === 'up');
    t.stop();
    await t.flush(300);
  });

  test('the supervisor phase becomes the tunnel phase, its reason the reason in the UI', async () => {
    let state = supState({ phase: 'connecting', desired: 'connected' });
    const fetchFn = (async () => new Response(JSON.stringify(state), { status: 200 })) as typeof fetch;
    const t = supervisorTunnel(fetchFn, async () => false, { host: 'seestar-portfwd', port: 4710, leaseS: 0 });
    t.start();
    await until(() => t.status().phase === 'starting');
    state = supState({ phase: 'backoff', desired: 'connected', lastError: 'online-link failed: Connect_Ex failed: -42' });
    await until(() => t.status().phase === 'starting' && (t.status().detail ?? '').includes('-42'));
    state = supState({ phase: 'releasing', desired: 'disconnected' });
    await until(() => t.status().phase === 'releasing');
    state = supState({ phase: 'connected', desired: 'connected' });
    await until(() => t.status().phase === 'up' && t.status().detail === null);
    state = supState({ phase: 'failed', desired: 'disconnected', lastError: 'config: SEESTAR_USER is not set' });
    await until(() => t.status().phase === 'failed');
    t.stop();
  });

  test('a tunnel container with no supervisor is watched by port alone, and says so', async () => {
    const fetchFn = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:4710');
    }) as typeof fetch;
    let open = false;
    const t = supervisorTunnel(fetchFn, async () => open, { host: '127.0.0.1', port: 4710, leaseS: 0 });
    t.start();
    await until(() => (t.status().detail ?? '').includes('ECONNREFUSED'));
    assert.notEqual(t.status().phase, 'up', 'a port nobody supervises is not proof of a session');
    open = true;
    await until(() => t.status().phase === 'up');
    assert.match(t.status().detail ?? '', /ECONNREFUSED/, 'the degraded mode is said out loud');
    t.stop();
    await t.flush(300);
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
      return json({ data: { list: [{ deviceSn: 'S30X', deviceModel: 'S30', status: 3 }] } });
    }) as typeof fetch;
    const d = await listDevices({ user: 'me@example.com', password: 'pw', fetch: f });
    assert.equal(d.length, 1);
    assert.deepEqual([d[0]!.serial, d[0]!.status, d[0]!.remoteMode, d[0]!.address], ['S30X', 'shooting', 'relay', 'Starfront']);
    assert.equal(urls.length, 3);
    await assert.rejects(login('me@example.com', 'bad', (async () => new Response('{"msg":"wrong password"}', { status: 401 })) as typeof fetch), /HTTP 401 \(wrong password\)/);
    await assert.rejects(listDevices({ user: '', password: '' }), /SEESTAR_USER/);
  });
});
