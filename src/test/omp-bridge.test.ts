import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { AgentBridge } from '../agent/omp.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-omp.js');

async function until(what: string, cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe('AgentBridge against a fake omp process', () => {
  let dir: string;
  let bridge: AgentBridge;
  const command = config.agent.command;

  /** a wrapper script standing in for the omp binary */
  const install = (name: string, env: Record<string, string> = {}) => {
    const p = path.join(dir, name);
    const vars = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)} `).join('');
    fs.writeFileSync(p, `#!/bin/sh\nexec env ${vars}"${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
    return p;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-omp-'));
    bridge = new AgentBridge();
    bridge.timing.checkEveryMs = 0;
  });

  afterEach(async () => {
    bridge.stop();
    config.agent.command = command;
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a turn runs: busy on agent_start, idle on agent_end', async () => {
    config.agent.command = install('omp');
    await bridge.start('http://127.0.0.1:1/mcp');
    await until('ready', () => bridge.ready);
    await bridge.prompt('hello');
    await until('busy', () => bridge.busy);
    await until('idle', () => !bridge.busy);
  });

  test('a resumed session is rebuilt: image counts, tool names and their results', async () => {
    config.agent.command = install('omp', { FAKE_OMP_HISTORY: '1' });
    await bridge.start('http://127.0.0.1:1/mcp');
    await until('ready', () => bridge.ready);
    const [user, answer, tool] = bridge.history;
    assert.deepEqual(user && user.kind === 'user' && [user.text, user.images], ['look at this', 1]);
    assert.equal(answer?.kind === 'assistant' && answer.text, 'checking');
    assert.deepEqual(tool && tool.kind === 'tool' && [tool.name, tool.status, tool.images], ['telescope_status', 'ok', ['agent/x.jpg']]);
  });

  test('a command that cannot be started is reported, and is retried (it starts once it exists)', async () => {
    const p = path.join(dir, 'omp-later');
    config.agent.command = p;
    await bridge.start('http://127.0.0.1:1/mcp');
    await until('the start error', () => /cannot start/.test(bridge.status().error ?? ''));
    assert.equal(bridge.ready, false);
    // nothing to talk to: fails at once, not after the command timeout
    const t0 = Date.now();
    await assert.rejects(bridge.prompt('hello'), /cannot start|not ready/);
    assert.ok(Date.now() - t0 < 100);
    fs.renameSync(install('omp-tmp'), p);
    await until('ready after the retry', () => bridge.ready, 6000);
  });

  test('a busy turn whose end event was lost is marked idle by the stall check', async () => {
    config.agent.command = install('omp', { FAKE_OMP_MODE: 'lost-end' });
    bridge.timing.stallMs = 150;
    await bridge.start('http://127.0.0.1:1/mcp');
    await until('ready', () => bridge.ready);
    await bridge.prompt('hello');
    await until('busy', () => bridge.busy);
    await bridge.checkStall();
    assert.equal(bridge.busy, true, 'not before the stall time');
    await sleep(200);
    await bridge.checkStall();
    assert.equal(bridge.busy, false);
    assert.ok(bridge.history.some((h) => h.kind === 'notice' && /ended without an end event/.test(h.text)));
  });

  test('an agent that stops answering mid-turn is killed and restarted', async () => {
    config.agent.command = install('omp', { FAKE_OMP_MODE: 'hang', FAKE_OMP_ONCE: path.join(dir, 'once') });
    Object.assign(bridge.timing, { stallMs: 100, stateTimeoutMs: 300 });
    await bridge.start('http://127.0.0.1:1/mcp');
    await until('ready', () => bridge.ready);
    const firstPid = Number(fs.readFileSync(path.join(dir, 'once'), 'utf8'));
    await bridge.prompt('hello');
    await until('busy', () => bridge.busy);
    await sleep(150);
    await bridge.checkStall();
    await until('the hung process to end', () => !bridge.ready);
    assert.equal(bridge.busy, false);
    assert.throws(() => process.kill(firstPid, 0), 'the hung process is gone');
    await until('ready again', () => bridge.ready, 6000);
  });

  test('stop() cancels a pending restart', async () => {
    config.agent.command = path.join(dir, 'missing');
    await bridge.start('http://127.0.0.1:1/mcp');
    await until('the start error', () => /cannot start/.test(bridge.status().error ?? ''));
    bridge.stop();
    fs.renameSync(install('omp-tmp'), path.join(dir, 'missing'));
    await sleep(2500);
    assert.equal(bridge.ready, false, 'no process was started after stop()');
  });
});
