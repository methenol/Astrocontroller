import { execFileSync } from 'node:child_process';
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { estop, EStopError } from '../safety/estop.js';
import { assertCommandAllowed } from '../drivers/dwarf/gate.js';
import { READ_ONLY_RPC } from '../drivers/seestar/link.js';
import { controlRoutes } from '../web/routes/control.js';
import { estopRoutes } from '../web/routes/estop.js';
import type { WebContext } from '../web/context.js';

afterEach(() => estop.reset());

async function withRoutes(fn: (post: (p: string, b: unknown) => Promise<{ status: number; body: Record<string, unknown> }>, calls: string[]) => Promise<void>, halt: () => Promise<string[]> = async () => []) {
  const calls: string[] = [];
  const ctx = {
    scope: {
      capabilities: { home: true },
      control: async () => calls.push('control'),
      emergencyHalt: async () => {
        calls.push('halt');
        // the halt's own commands pass the lock; nothing else does
        estop.assertClear();
        return halt();
      },
    },
    agent: { abort: async () => calls.push('agent abort') },
    duty: { event: () => undefined, pause: () => calls.push('duty pause') },
  } as unknown as WebContext;
  const app = express();
  app.use(express.json());
  app.use('/api', estopRoutes(ctx), controlRoutes(ctx));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    await fn(async (p, b) => {
      const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }, calls);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe('E-Stop', () => {
  test('pressing it halts, pauses the duty and aborts the agent, then control is refused until it is cleared', async () => {
    await withRoutes(async (post, calls) => {
      assert.equal((await post('/control', { action: 'home' })).status, 200);
      calls.length = 0;
      const r = await post('/estop', { engaged: true });
      assert.equal(r.body.engaged, true);
      assert.deepEqual(calls.sort(), ['agent abort', 'duty pause', 'halt']);
      calls.length = 0;
      const refused = await post('/control', { action: 'home' });
      assert.equal(refused.status, 423);
      assert.match(String(refused.body.error), /E-Stop/);
      assert.deepEqual(calls, []);
      assert.equal((await post('/estop', { engaged: false })).body.engaged, false);
      assert.equal((await post('/control', { action: 'home' })).status, 200);
      assert.deepEqual(calls, ['control']);
    });
  });

  test('a halt that fails is reported and control stays locked out', async () => {
    await withRoutes(async (post) => {
      const r = await post('/estop', { engaged: true });
      assert.deepEqual(r.body.haltFailed, ['motors: no reply']);
      assert.equal(estop.engaged, true);
    }, async () => ['motors: no reply']);
  });

  test('a press during the start-up lock still halts; a second press does not', async () => {
    await withRoutes(async (post, calls) => {
      estop.engage('startup');
      assert.equal((await post('/estop', { engaged: true })).body.source, 'user');
      assert.equal(calls.filter((c) => c === 'halt').length, 1);
      await post('/estop', { engaged: true });
      assert.equal(calls.filter((c) => c === 'halt').length, 1);
    });
  });

  test('catalog search still answers while engaged', async () => {
    await withRoutes(async (post) => {
      await post('/estop', { engaged: true });
      assert.notEqual((await post('/control', { action: 'find', name: 'M31' })).status, 423);
    });
  });

  test('the Dwarf gate lets reads and link upkeep through and refuses the rest, known or not', () => {
    estop.engage('user');
    for (const name of ['TASK_GET_DEVICE_STATE_INFO', 'STEP_MOTOR_GET_POSITION', 'CAMERA_TELE_GET_ALL_PARAMS', 'SYSTEM_SET_MASTER', 'TASK_MANAGER_ENTER_CAMERA']) assert.doesNotThrow(() => assertCommandAllowed(name));
    for (const name of ['ASTRO_START_GOTO_DSO', 'STEP_MOTOR_RUN_TO', 'STEP_MOTOR_SERVICE_JOYSTICK', 'PARAM_SET_GAIN', 'SYSTEM_SET_TIME', '13505']) assert.throws(() => assertCommandAllowed(name), EStopError);
  });

  test('the Seestar allows reads only', () => {
    for (const m of ['get_setting', 'scope_get_equ_coord', 'iscope_get_app_state', 'test_connection', 'verify_client', 'pi_is_verified']) assert.match(m, READ_ONLY_RPC);
    for (const m of ['scope_goto', 'scope_speed_move', 'set_setting', 'iscope_start_stack', 'pi_set_time', 'delete_image', 'get']) assert.doesNotMatch(m, READ_ONLY_RPC);
  });

  test('commands sent from inside the halt pass; the same command outside it is refused', async () => {
    estop.engage('user');
    await estop.runHalt(async () => {
      await Promise.resolve();
      assert.doesNotThrow(() => assertCommandAllowed('STEP_MOTOR_STOP'));
    });
    assert.throws(() => assertCommandAllowed('STEP_MOTOR_STOP'), EStopError);
  });

  test('CONTROL_ENABLED_ON_STARTUP=false starts engaged; true or unset does not', () => {
    const module = new URL('../safety/estop.js', import.meta.url).href;
    const run = (value?: string) => {
      const env = { ...process.env };
      delete env.CONTROL_ENABLED_ON_STARTUP;
      if (value !== undefined) env.CONTROL_ENABLED_ON_STARTUP = value;
      return execFileSync(process.execPath, ['--input-type=module', '-e', `const { estop } = await import(${JSON.stringify(module)}); process.stdout.write(JSON.stringify([estop.engaged, estop.status().source]));`], { env, encoding: 'utf8' });
    };
    assert.equal(run('false'), '[true,"startup"]');
    assert.equal(run('true'), '[false,null]');
    assert.equal(run(), '[false,null]');
  });
});
