/** Mount motion and focus. */
import { z } from 'zod';
import { FOCUS_MAX } from '../../dwarf/device.js';
import { Cmd } from '../../dwarf/protocol.js';
import { measureTele, starFocusSweep } from '../../media/focus.js';
import { capturedLine, cropArg, displayJpeg, saveCapture, text, withImage, type ToolContext, type ToolFn } from './common.js';

const MAX_RELATIVE_DEG = 60;
/** tele_visibility: a sky frame at infinity focus shows at least this many measurable stars, no softer than this (sharp here is ~2 px; a roof at infinity focus measured 20 px). */
const VISIBLE_MIN_STARS = 20;
const VISIBLE_MAX_HFR_PX = 6;
const NUDGE_ANGLES: Record<string, number> = { up: 0, 'up-right': 45, right: 90, 'down-right': 135, down: 180, 'down-left': 225, left: 270, 'up-left': 315 };

export function registerMotionTools(tool: ToolFn, { dwarf, hub }: ToolContext): void {
  tool(
    'motors_home',
    "Home (reset) both motor axes against their reference switches. Needed after power-on (error -14520 means \"no reference\"); move_motors also does it by itself when needed. Returns when the telescope reports both axes homed (usually under a minute; from a far starting position it continues past the firmware's own time limit, up to several minutes). The scope ends pointing down.",
    {},
    async () => text(await dwarf.homeMotors()),
  );

  tool('motor_position', 'Read the rotation (azimuth axis) and pitch (altitude axis) motor angles.', {}, async () => text(await dwarf.readMotorPositions()));

  tool(
    'move_motors',
    'Move the motors. Returns when the telescope reports the move finished. If the motors have no reference (after power-on, while tracking after a GoTo, or after a failed astro routine), it stops tracking and homes them first by itself. Absolute: pitch ~2.5 parked/down, ~90 level (Alt-Az: altitude ≈ pitch − 90, so 135 ≈ 45° up); rotation ~159 after homing is the centre of travel. relative=true moves BY the given degrees instead. Directions (verified): rotation DEcreasing pans the view RIGHT; pitch increasing tilts UP. To centre a subject at pixel offset (dx right, dy down) from frame centre: rotation_deg = −dx·scale, pitch_deg = −dy·scale, with scale ≈ 0.0235°/px (wide) or 0.0015°/px (tele) for a 1920-px-wide frame (scale by 1920/width for smaller frames). speed 0.1-30 °/s (default 10). Waits until the motion completes.',
    { rotation_deg: z.number().optional(), pitch_deg: z.number().optional(), relative: z.boolean().optional(), speed: z.number().min(0.1).max(30).optional() },
    async ({ rotation_deg, pitch_deg, relative, speed }) => {
      if (rotation_deg === undefined && pitch_deg === undefined) throw new Error('give rotation_deg and/or pitch_deg. Nothing was moved.');
      if (!relative) return text(await dwarf.moveTo({ rotationDeg: rotation_deg, pitchDeg: pitch_deg }, speed));
      for (const [axis, d] of [['rotation_deg', rotation_deg], ['pitch_deg', pitch_deg]] as const) {
        if (d !== undefined && Math.abs(d) > MAX_RELATIVE_DEG) {
          throw new Error(`relative ${axis}=${d}° is too large for a relative nudge (max ±${MAX_RELATIVE_DEG}°). Did you mean an absolute move? Call again without relative. Nothing was moved.`);
        }
      }
      const p = await dwarf.readMotorPositions();
      if (!p.homed || p.rotationDeg === undefined || p.pitchDeg === undefined) {
        throw new Error(
          'the motors report no position (no reference: while tracking, after power-on or a failed astro routine), so a relative move cannot be computed. Give an absolute move instead (it homes first by itself), or call motors_home. Nothing was moved.',
        );
      }
      const res = await dwarf.moveTo(
        { rotationDeg: rotation_deg !== undefined ? p.rotationDeg + rotation_deg : undefined, pitchDeg: pitch_deg !== undefined ? p.pitchDeg + pitch_deg : undefined },
        speed,
      );
      return text(`relative move (Δrotation ${rotation_deg ?? 0}°, Δpitch ${pitch_deg ?? 0}°): ${res}`);
    },
  );

  tool(
    'nudge',
    'Joystick-style slew for framing/following (daytime targets, centring). direction: up/down/left/right/up-left/… or angle_deg (0 = up, 90 = right). speed 0.01-1 (fraction of max). seconds 0.1-30.',
    {
      direction: z.enum(['up', 'down', 'left', 'right', 'up-left', 'up-right', 'down-left', 'down-right']).optional(),
      angle_deg: z.number().optional(),
      speed: z.number().min(0.01).max(1).optional(),
      seconds: z.number().min(0.1).max(30),
    },
    async ({ direction, angle_deg, speed, seconds }) => {
      const angle = angle_deg ?? (direction ? NUDGE_ANGLES[direction] : undefined);
      if (angle === undefined) throw new Error('give direction or angle_deg');
      await dwarf.nudge(angle, speed ?? 0.5, seconds * 1000);
      const p = await dwarf.readMotorPositions().catch(() => null);
      return text(`nudged ${direction ?? `${angle}°`} for ${seconds}s${p ? `; now rotation ${p.rotationDeg}°, pitch ${p.pitchDeg}°` : ''}`);
    },
  );

  tool('stop_motion', 'Immediately stop all motor motion.', {}, async () => {
    await dwarf.stopMotion();
    return text('motion stopped');
  });

  // ---- focus ---------------------------------------------------------------

  tool(
    'autofocus',
    "Run the telescope's own autofocus. normal = contrast AF for daytime/Moon/planets at a point (x,y in 1920×1080 tele frame, default centre). astro = star-based AF for deep sky (needs stars in view, takes ~1-3 min). Returns when the telescope reports AF finished, with the focus position before → after. It is an ERROR when the AF ends without moving the focuser (the telescope gave up: focus unchanged and unverified) or never reports its end (it is then stopped). This is the FINDER: it searches the whole range and gets you close. At night, run it first, then tune what it found with star_focus (a fine search around the result) and check the number with star_sharpness.",
    { mode: z.enum(['normal', 'astro']), x: z.number().min(0).max(1920).optional(), y: z.number().min(0).max(1080).optional() },
    async ({ mode, x, y }) => text(await dwarf.autofocus(mode, x, y)),
  );

  tool(
    'star_sharpness',
    "Measure how sharp the stars are in one tele frame and get the focus number: median star half-flux radius (HFR) in px and arcsec, and `score` = 1000 ÷ HFR(arcsec), higher = sharper (on this scope ~250-450 is sharp, <120 is soft). Every part of it is flux-weighted per star against that star's own local sky, so it does not move with exposure, gain, cloud thickness, sky glow or the camera's tone curve — two scores from minutes apart are comparable, which is what makes it usable as a trend. It only measures; it does not focus. Order of work: autofocus (the finder) → star_focus (a fine sweep that also moves the focuser) → star_sharpness to confirm; or focus_step + this to nudge by hand. Run it after autofocus, between focus_step moves, and once per target as the night's baseline. By default it takes the reading from a snapshot whose exposure suits the filter (0.5 s VIS, 1 s Astro, 4 s Duo-Band: through a narrowband filter a short frame shows too few stars and the reading is noise), then puts the setting back. Raise gain if the stars are too faint to measure.",
    {
      exposure_s: z.number().min(0.05).max(60).optional().describe('take the ONE still at this exposure instead of the default short snapshot; the camera setting is restored afterwards either way'),
      gain: z.number().min(0).max(240).optional().describe('gain for that still, restored afterwards'),
      crop: cropArg.describe('measure one region (fractions 0..1); give every frame you compare the same region'),
    },
    async ({ exposure_s, gain, crop }) => {
      const { img, sharp } = await measureTele({ dwarf, hub }, { exposureS: exposure_s, gain, crop });
      const jpeg = await displayJpeg(img, 1024);
      const saved = saveCapture(jpeg, 'star_sharpness');
      const report = { focusPosition: dwarf.state.focusPosition, captured: capturedLine(img) || undefined, ...sharp, image: `captures/${saved}` };
      return withImage(jpeg, JSON.stringify(report, null, 1));
    },
  );

  tool(
    'tele_visibility',
    'THE test for "is the target visible in the tele frame" after a GoTo — the one answer to trust, not the wide view or a star count. Drives the focuser to the stored infinity position, takes one tele still and measures its stars. At infinity focus anything near the scope (a roof, a dock, a pole, branches) is a large blur while stars are points, so: VISIBLE = at least 20 measurable stars with a median HFR at most 6 px; anything else is BLOCKED (obstruction, cloud or dew). Refuses while the tele camera is stacking. Leaves the focuser at infinity (the starting point for autofocus).',
    {},
    async () => {
      const inf = await dwarf.infinityFocusPosition();
      const at = await dwarf.focusTo(inf);
      const { img, sharp } = await measureTele({ dwarf, hub });
      const jpeg = await displayJpeg(img, 1024);
      const saved = saveCapture(jpeg, 'tele_visibility');
      const visible = sharp.ok && sharp.starsUsed >= VISIBLE_MIN_STARS && sharp.hfrPx <= VISIBLE_MAX_HFR_PX;
      const why = !sharp.ok
        ? sharp.blocking
        : sharp.starsUsed < VISIBLE_MIN_STARS
          ? `only ${sharp.starsUsed} measurable stars`
          : `median HFR ${sharp.hfrPx.toFixed(1)} px at infinity focus: blurred near structure, not stars`;
      const report = {
        verdict: visible ? 'VISIBLE' : 'BLOCKED',
        next: visible ? 'continue on this target (autofocus, then star focus)' : 'the target is NOT visible: do not focus or stack here — choose another target',
        reason: visible ? `${sharp.starsUsed} stars, median HFR ${sharp.hfrPx.toFixed(1)} px` : why,
        focusPosition: at,
        captured: capturedLine(img) || undefined,
        image: `captures/${saved}`,
      };
      return withImage(jpeg, JSON.stringify(report, null, 1));
    },
  );

  tool(
    'star_focus',
    'Fine-tune the tele focus on the stars. Sweeps the focuser up and down around its current position, takes a tele still at every position, scores its stars (the star_sharpness measurement) and leaves the focuser on the sharpest position, refined by fitting the curve through the samples around the best one. Run autofocus (mode=astro) FIRST to get close — autofocus is the whole-range finder, this is the narrow-range tuner; with no stars in view at all start from focus_position action=infinity instead. Use it after autofocus, after >5 °C of cooling, and whenever star_sharpness or analyze_subs says the HFR has grown. Camera exposure/gain are restored afterwards. Each frame is a full tele still downloaded over Wi-Fi: ~20-25 s a frame, so positions × repeats × ~22 s (default 13 positions ≈ 5 min); a sweep is capped at 30 min and then drops the outermost positions — keep repeats at 1 unless the sky is unsteady. Refuses while live stacking, a GoTo or calibration runs.',
    {
      center: z.number().int().min(0).max(FOCUS_MAX).optional().describe("focus units to centre the search on; default the focuser's current position"),
      range: z.number().int().min(5).max(400).optional().describe('focus units to cover on each side of the centre (default 30)'),
      step: z.number().int().min(1).max(50).optional().describe('focus units between samples (default 5)'),
      exposure_s: z.number().min(0.05).max(15).optional().describe("exposure of the measurement stills; leave it out: the default suits the filter (0.5 s VIS, 1 s Astro, 4 s Duo-Band — a narrowband filter at 0.5 s shows too few stars and the reading is noise)"),
      gain: z.number().min(0).max(240).optional().describe('gain for the measurement stills, restored afterwards'),
      crop: cropArg.describe('score only this region of every frame; the same region for all samples'),
      repeats: z.number().int().min(1).max(3).optional().describe('frames averaged per position when the sky is unsteady (default 1)'),
      apply: z.boolean().optional().describe('false = measure only: the focuser goes back to the centre of the range it searched (where the sweep started); default leaves it on the sharpest position'),
    },
    async ({ center, range, step, exposure_s, gain, crop, repeats, apply }) => {
      const r = await starFocusSweep({ dwarf, hub }, { center, range, step, exposureS: exposure_s, gain, crop, repeats, apply });
      const hfr = (s: { hfrArcsec?: number; hfrPx?: number }) => `${s.hfrArcsec ?? s.hfrPx}${s.hfrArcsec ? '″' : 'px'}`;
      const table = r.samples
        .map((s) =>
          `${String(s.position).padStart(4)}  ${s.error ? `FAILED: ${s.error}` : `score ${String(s.score).padStart(4)}  HFR ${hfr(s).padStart(6)} ±${s.hfrUncertaintyPx}  ${String(s.stars).padStart(3)} stars  ${s.seconds}s`}`,
        )
        .join('\n');
      const lines = [
        r.verdict,
        ...r.notes.map((x) => `note: ${x}`),
        '',
        `settings: ${r.settings}`,
        r.final ? `final position ${r.finalPosition}: HFR ${hfr(r.final)}, score ${r.final.score}` : '',
        `samples (${r.elapsedS} s):`,
        table,
      ];
      const cautions = [...new Set([r.best, r.final].flatMap((s) => s?.cautions ?? []))];
      if (cautions.length) lines.push('', `cautions: ${cautions.join(' | ')}`);
      let jpeg: Buffer | undefined;
      if (r.finalImage) {
        jpeg = await displayJpeg(r.finalImage, 1024);
        lines.push(`final frame: captures/${saveCapture(jpeg, `star_focus_${r.finalPosition}`)}`);
      }
      return withImage(jpeg, lines.join('\n'));
    },
  );

  tool(
    'focus_step',
    'Move the tele focuser manually. direction near (closer objects) or far (towards infinity); steps 1-200. Check the effect with star_sharpness (the star focus number) between moves — for stars that is the right meter, not analyze_image sharpness. For a whole search in one call use star_focus instead.',
    { direction: z.enum(['near', 'far']), steps: z.number().int().min(1).max(200) },
    async ({ direction, steps }) => text(await dwarf.focusStep(direction, steps)),
  );

  tool(
    'focus_position',
    'Absolute focuser control. action get: current and stored infinity positions. action infinity: drive to the stored infinity position (instant starting point for sky work without stars; temperature drift means astro autofocus still refines it). action goto: drive to `position`. action save_infinity: store the current position as the new infinity reference (only after a verified-good astro focus). Note: in Normal mode realtime AF may move focus again; use DSO/Moon/Planet modes for sky work.',
    { action: z.enum(['get', 'infinity', 'goto', 'save_infinity']), position: z.number().int().min(0).max(FOCUS_MAX).optional() },
    async ({ action, position }) => {
      if (action === 'goto') {
        if (position === undefined) throw new Error('position required for goto');
        return text(`focuser at ${await dwarf.focusTo(position)} (target ${position})`);
      }
      const inf = await dwarf.infinityFocusPosition();
      if (action === 'get') return text({ current: await dwarf.settledFocusPosition(), infinity: inf, note: 'higher = farther; 0 = near limit' });
      if (action === 'infinity') return text(`focuser at ${await dwarf.focusTo(inf)} (target ${inf}, stored infinity)`);
      dwarf.assertNoOperation('saving the infinity focus position');
      const cur = await dwarf.settledFocusPosition();
      await dwarf.request(Cmd.FOCUS_SET_USER_INFINITY_POS, { pos: cur }, { timeout: 5000 });
      return text(`saved ${cur} as the infinity position (was ${inf})`);
    },
  );
}
