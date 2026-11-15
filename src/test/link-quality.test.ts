import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LinkQualityTracker } from '../drivers/link-quality.js';

describe('link quality: round trip and loss from the keepalives', () => {
  const fill = (t: LinkQualityTracker, rtts: Array<number | null>) => {
    for (const v of rtts) {
      if (v === null) t.missed();
      else t.answered(v);
    }
    return t.snapshot();
  };

  test('no grade until three keepalives; then the median, the jitter and the loss', () => {
    const t = new LinkQualityTracker();
    assert.equal(fill(t, [20, 30]).grade, null);
    const q = fill(t, [25, 200, null]);
    assert.equal(q.samples, 5);
    assert.equal(q.rttMs, 30);
    assert.equal(q.jitterMs, 170, 'p90 200 less the median 30');
    assert.equal(q.lossPct, 20);
    assert.equal(q.lastRttMs, 200);
  });

  test('on Wi-Fi a few tens of ms is good, a few hundred is poor; loss pulls the grade down whatever the latency', () => {
    assert.equal(fill(new LinkQualityTracker('lan'), [12, 15, 18, 14]).grade, 'good');
    assert.equal(fill(new LinkQualityTracker('lan'), [180, 220, 250]).grade, 'fair');
    assert.equal(fill(new LinkQualityTracker('lan'), [600, 700, 650]).grade, 'poor');
    assert.equal(fill(new LinkQualityTracker('lan'), [3000, 2500, 4000]).grade, 'bad');
    // fast replies, but one in five never comes back
    assert.equal(fill(new LinkQualityTracker('lan'), [10, 10, 10, 10, null]).grade, 'poor');
    assert.equal(fill(new LinkQualityTracker('lan'), [null, null, null]).grade, 'bad');
  });

  test('through the ZWO relay a few hundred ms is a healthy link', () => {
    assert.equal(fill(new LinkQualityTracker('remote'), [320, 410, 380]).grade, 'good');
    assert.equal(fill(new LinkQualityTracker('lan'), [320, 410, 380]).grade, 'poor');
    assert.equal(fill(new LinkQualityTracker('remote'), [900, 1100, 1000]).grade, 'fair');
    assert.equal(new LinkQualityTracker('remote').snapshot().path, 'remote');
  });

  test('the window keeps the last thirty: an old outage ages out', () => {
    const t = new LinkQualityTracker();
    fill(t, [null, null, null, null, null]);
    const q = fill(t, Array(30).fill(20));
    assert.equal(q.lossPct, 0);
    assert.equal(q.samples, 30);
    assert.equal(q.grade, 'good');
  });

  test('a new connection starts over', () => {
    const t = new LinkQualityTracker();
    fill(t, [900, 900, 900]);
    t.reset();
    assert.deepEqual([t.snapshot().samples, t.snapshot().grade, t.snapshot().lastRttMs], [0, null, null]);
  });

  test('only a change the UI would show is published', () => {
    const a = fill(new LinkQualityTracker(), [20, 21, 22]);
    assert.equal(LinkQualityTracker.differs(null, a), true);
    assert.equal(LinkQualityTracker.differs(a, { ...a, rttMs: 21.4, lastRttMs: 30 }), false);
    assert.equal(LinkQualityTracker.differs(a, { ...a, rttMs: 35 }), true);
    assert.equal(LinkQualityTracker.differs(a, { ...a, lossPct: 3 }), true);
  });
});
