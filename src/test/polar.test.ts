import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { correctionText, dwarfCorrection, polarSummary, seestarCorrection } from '../astro/polar.js';

describe('polar alignment corrections', () => {
  test('DWARF: aziErr > 0 rotates clockwise, altErr > 0 pitches up (the DWARFLAB app)', () => {
    assert.equal(correctionText(dwarfCorrection(3, 1)), 'pitch up 1.0°, rotate 3.0° clockwise');
    assert.equal(correctionText(dwarfCorrection(-3, -1)), 'pitch down 1.0°, rotate 3.0° counter-clockwise');
  });

  test('Seestar: x ≥ 0 (right arrow) rotates clockwise, y ≥ 0 (up arrow) pitches up', () => {
    assert.equal(correctionText(seestarCorrection(2.5, 0.4)), 'pitch up 0.4°, rotate 2.5° clockwise');
    assert.equal(correctionText(seestarCorrection(-2.5, -0.4)), 'pitch down 0.4°, rotate 2.5° counter-clockwise');
  });

  test('an axis that rounds to 0.0° is left out', () => {
    assert.equal(correctionText(dwarfCorrection(0.02, 1.5)), 'pitch up 1.5°');
    assert.equal(correctionText(seestarCorrection(0, 0)), 'no adjustment needed');
    assert.equal(polarSummary(dwarfCorrection(0, 0)), 'Polar alignment error 0.0°: No adjustment needed.');
  });
});
