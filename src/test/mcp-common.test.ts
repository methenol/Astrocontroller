import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { exposureArgSeconds, text } from '../mcp/tools/common.js';
import { withAstroBusyRecovery } from '../mcp/tools/astro.js';
import type { Dwarf } from '../drivers/dwarf/device.js';

describe('tool helpers', () => {
  test('exposure text parses fractions, seconds and plain numbers; anything else is NaN', () => {
    assert.equal(exposureArgSeconds('1/500'), 1 / 500);
    assert.equal(exposureArgSeconds('0.5'), 0.5);
    assert.equal(exposureArgSeconds('15s'), 15);
    assert.equal(exposureArgSeconds(' 2 / 4 '), 0.5);
    assert.equal(exposureArgSeconds(30), 30);
    for (const bad of ['', 'auto', '1/2/3', '/', 's', '-1', '1/0', Number.POSITIVE_INFINITY]) assert.ok(Number.isNaN(exposureArgSeconds(bad)), String(bad));
  });

  test('a result with 64-bit fields (BigInt) is written out instead of throwing', () => {
    const r = text({ id: 12345678901234567890n, ok: true });
    assert.equal(r.content[0].type, 'text');
    assert.match((r.content[0] as { text: string }).text, /"12345678901234567890"/);
  });
});

describe('astro-service recovery', () => {
  const stub = () => {
    const published: unknown[] = [];
    let recoveries = 0;
    const dwarf = {
      state: { astroRecovery: { at: 0, steps: [] } as Record<string, unknown> | undefined },
      isBusy: () => false,
      publishState: (p: unknown) => published.push(p),
      recoverAstroService: async () => {
        recoveries++;
        return { steps: ['stop astro'] };
      },
    };
    return { dwarf: dwarf as unknown as Dwarf, published, recoveries: () => recoveries };
  };

  test('a different error after a recovery is reported as itself, not as a stuck service', async () => {
    const s = stub();
    let calls = 0;
    await assert.rejects(
      withAstroBusyRecovery(s.dwarf, 'GoTo', async () => {
        calls++;
        throw new Error(calls === 1 ? 'code -11501 ASTRO_FUNCTION_BUSY' : 'code -11504 plate solving failed');
      }),
      (err: Error) => /-11504/.test(err.message) && !/power-cycle/.test(err.message),
    );
    assert.equal(s.recoveries(), 1);
    assert.deepEqual(s.published.at(-1), { astroRecovery: { at: 0, steps: [], ok: false } });
  });

  test('an error that is not -11501 never triggers a recovery', async () => {
    const s = stub();
    await assert.rejects(withAstroBusyRecovery(s.dwarf, 'GoTo', async () => Promise.reject(new Error('code -11504'))), /-11504/);
    assert.equal(s.recoveries(), 0);
    assert.equal(s.published.length, 0);
  });
});
