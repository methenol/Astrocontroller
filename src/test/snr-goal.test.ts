import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generalGoalMin, goalForSnr, levelIntegration, minutesForSnr, noteRigFacts, resetSnrGoals, snrAfter, snrLevel, snrRate, SNR_GOAL_DEFAULT, SNR_GOAL_LEVELS } from '../astro/acquisition/snr-goal.js';
import { SNR_TIERS } from '../astro/acquisition/advise.js';
import { addTarget, loadProgram, removeTarget, setEstimatedGoal, updateTarget } from '../night/program.js';
import { REST_DEFAULTS, saveRestSettings } from '../astro/rest.js';

const SITE = { lat: 40, lon: -75, elev: 100 };
const TODAY = '2026-11-18';

describe('an SNR goal as integration minutes', () => {
  afterEach(() => {
    resetSnrGoals();
    saveRestSettings(REST_DEFAULTS);
    for (const t of loadProgram()) removeTarget(t.id);
  });

  test('SNR grows with the square root of the integration: twice the SNR is four times the minutes', () => {
    const rate = { snrPerSqrtMin: 2 };
    assert.equal(minutesForSnr(rate, 20), 100);
    assert.equal(minutesForSnr(rate, 40), 400);
    assert.equal(snrAfter(rate, 100), 20);
    // whole minutes, never zero
    assert.equal(minutesForSnr({ snrPerSqrtMin: 100 }, 1), 1);
  });

  test("the levels are the planner's own scale: 3 a detection, 10 a clean picture, 20 a deep one", () => {
    const at = (label: string) => SNR_GOAL_LEVELS.find((l) => l.label === label)!.min;
    assert.equal(at('Detection'), SNR_TIERS.detect);
    assert.equal(at('Clean'), SNR_TIERS.good);
    assert.equal(at('Deep'), SNR_TIERS.deep);
    assert.equal(SNR_GOAL_DEFAULT, SNR_TIERS.good);
    // contiguous: each level starts where the one before it ends
    for (let i = 1; i < SNR_GOAL_LEVELS.length; i++) assert.equal(SNR_GOAL_LEVELS[i].min, SNR_GOAL_LEVELS[i - 1].max);
    assert.equal(snrLevel(2), 'below detection');
    assert.equal(snrLevel(4), 'Detection');
    assert.equal(snrLevel(10), 'Clean');
    assert.equal(snrLevel(25), 'Deep');
    assert.equal(snrLevel(80), 'Ultra-deep');
    // the integration is relative to Clean and goes with SNR²
    assert.equal(levelIntegration(SNR_GOAL_LEVELS.find((l) => l.label === 'Deep')!), '4–9× the time to Clean');
  });

  test('a bright compact nebula needs far less time for the same SNR than a faint galaxy', () => {
    noteRigFacts({ driver: 'seestar' });
    const bright = goalForSnr(SITE, { name: 'M 27' }, 25);
    const faint = goalForSnr(SITE, { name: 'M 101' }, 25);
    assert.ok(bright && faint, 'both rated');
    assert.ok(bright.goalMin * 10 < faint.goalMin, `${bright.goalMin} vs ${faint.goalMin} min`);
    assert.match(bright.rate.basis, /dark moonless/);
  });

  test('the rate does not depend on the night: the same answer twice, whatever the date', () => {
    noteRigFacts({ driver: 'dwarf' });
    const a = snrRate(SITE, { name: 'M 42' });
    resetSnrGoals();
    noteRigFacts({ driver: 'dwarf' });
    const b = snrRate(SITE, { name: 'M 42' });
    assert.ok(a && b);
    assert.equal(a.snrPerSqrtMin, b.snrPerSqrtMin);
  });

  test('a target that never clears the horizon has no rate', () => {
    noteRigFacts({ driver: 'seestar' });
    assert.equal(snrRate(SITE, { name: 'Deep south', raHours: 5, decDeg: -80 }), null);
  });

  test('a program target added with an SNR is in SNR mode; hours put it back in time mode and keep the SNR', () => {
    const t = addTarget({ name: 'M 27', snrGoal: 30 }, TODAY);
    assert.equal(t.goalMode, 'snr');
    assert.equal(t.snrGoal, 30);
    // the service's estimate lands in goalMin, and only for an SNR target
    assert.equal(setEstimatedGoal(t.id, 42)?.goalMin, 42);
    const timed = updateTarget(t.id, { goalMin: 240 });
    assert.equal(timed.goalMode, 'time');
    assert.equal(timed.goalMin, 240);
    assert.equal(timed.snrGoal, 30);
    assert.equal(setEstimatedGoal(t.id, 42)?.goalMin, 240, 'an hours goal is the owner\'s, never overwritten');
    assert.equal(updateTarget(t.id, { goalMode: 'snr' }).goalMode, 'snr');
  });

  test('a new target without a goal of its own takes the general goal\'s mode', () => {
    saveRestSettings({ goalMode: 'snr', snrTarget: 40 });
    const t = addTarget({ name: 'M 42' }, TODAY);
    assert.equal(t.goalMode, 'snr');
    assert.equal(t.snrGoal, 40);
    saveRestSettings({ goalMode: 'time', integrationTargetMin: 90 });
    const u = addTarget({ name: 'M 45' }, TODAY);
    assert.equal(u.goalMode, 'time');
    assert.equal(u.goalMin, 90);
  });

  test('the general goal: the owner\'s minutes, or each target\'s minutes for the owner\'s SNR', () => {
    noteRigFacts({ driver: 'seestar' });
    saveRestSettings({ goalMode: 'time', integrationTargetMin: 120 });
    assert.equal(generalGoalMin(SITE, 'M 27'), 120);
    saveRestSettings({ goalMode: 'snr', snrTarget: 20 });
    const m27 = generalGoalMin(SITE, 'M 27');
    assert.equal(m27, goalForSnr(SITE, { name: 'M 27' }, 20)!.goalMin);
    assert.ok(generalGoalMin(SITE, 'M 101') > m27);
    // a name the catalog does not know, with no position: the minutes stand
    assert.equal(generalGoalMin(SITE, 'my own field'), 120);
  });
});
