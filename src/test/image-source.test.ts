import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadImage } from '../media/images.js';
import type { StreamHub } from '../media/streams.js';

/** A hub whose camera and telescope only say which path loadImage took. */
function hub(phase: string, stacking: 'idle' | 'running' = 'idle') {
  return {
    lastMotionAt: () => 0,
    camera: () => ({
      status: () => ({ phase }),
      snapshot: async () => {
        throw new Error('LIVE FRAME');
      },
    }),
    dwarf: {
      state: { shootingMode: { id: 2, name: 'DSO' }, stacking: { tele: { state: stacking }, wide: { state: 'idle' } } },
      exposureSeconds: async () => null,
      takePhoto: async () => {
        throw new Error('STILL');
      },
    },
  } as unknown as StreamHub;
}

describe('where a camera image comes from', () => {
  test('the tele in DSO mode with no stack (no video there, 2026-10-12): a still, not a 30 s wait for frames that never come', async () => {
    await assert.rejects(loadImage('tele', hub('preview')), /^Error: STILL$/);
  });

  test('while a stack runs the preview carries it: a frame from the stream', async () => {
    await assert.rejects(loadImage('tele', hub('preview', 'running')), /LIVE FRAME/);
  });

  test('live video: a frame from the stream', async () => {
    await assert.rejects(loadImage('tele', hub('live')), /LIVE FRAME/);
  });

  test('the stream still settling after a restart in DSO mode: a still too', async () => {
    await assert.rejects(loadImage('tele', hub('backoff')), /^Error: STILL$/);
  });

  test('the wide always has video: a frame from the stream', async () => {
    await assert.rejects(loadImage('wide', hub('backoff')), /LIVE FRAME/);
  });
});
