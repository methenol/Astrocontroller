import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { j2000ToOfDate, offsetFromCentre, ofDateToJ2000 } from '../astro/sky.js';

describe('J2000 ↔ JNow (the Seestar works in JNow)', () => {
  const when = new Date('2026-11-13T07:38:00Z');

  test('round trip', () => {
    const now = j2000ToOfDate(6.156561, 20.65958, when);
    const back = ofDateToJ2000(now.raHours, now.decDeg, when);
    assert.ok(Math.abs(back.raHours - 6.156561) < 1e-7 && Math.abs(back.decDeg - 20.65958) < 1e-6);
  });

  test('2026-11-13 NGC 2174: J2000 sent as JNow put the frame centre 22′ west of the target, as the stack solved', () => {
    // the processed stack (263 subs) plate-solved at RA 91.9529°, Dec 20.6428° (J2000): 22.2′ west of the target
    const landed = ofDateToJ2000(6.156561, 20.65958, when); // where J2000 numbers taken as JNow point
    const off = offsetFromCentre(6.156561, 20.65958, landed.raHours, landed.decDeg);
    assert.ok(off.eastArcmin > 21 && off.eastArcmin < 24, `target ${off.eastArcmin}′ east of centre`);
    assert.ok(Math.abs(off.northArcmin) < 2);
    // and the measured solve agrees with it to within a goto's tolerance
    const solved = offsetFromCentre(6.156561, 20.65958, 91.9529469805306 / 15, 20.6428483067842);
    assert.ok(Math.abs(solved.eastArcmin - off.eastArcmin) < 2, `${solved.eastArcmin} vs ${off.eastArcmin}`);
  });

  test('offsetFromCentre wraps RA through 0h', () => {
    const off = offsetFromCentre(0.01, 0, 23.99, 0);
    assert.ok(Math.abs(off.eastArcmin - 18) < 0.1);
  });
});
