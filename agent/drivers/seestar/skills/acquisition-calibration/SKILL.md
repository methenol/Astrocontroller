---
name: acquisition-calibration
description: Measure this Seestar's sensor and the site's sky from its own raw frames (acquisition_measure) so acquisition_plan's sub-length/filter advice runs on measured numbers instead of spec-sheet guesses. Once after setup, then a sky cohort on clear moonless nights.
---
# Acquisition calibration (Seestar)

`acquisition_plan action=device` lists what is still a guess under `missing` and, per number, where it comes from (`spec`, `device`, `measured`, `env`). Measure in this order; each step is deterministic (robust statistics on one green phase of the raw mosaic) and stored for good. The Seestar's raw subs carry a BIAS card (the offset), so the black level is known from every sub.

## 1. Read noise (once; again after a firmware update)
1. `get_camera_settings` → the stack gain (`gain`, 200 on an S50 Pro). The live view runs at another gain for plate solving, so: `set_gain gain=<the stack gain>`.
2. `set_camera_setting setting=filter value=dark` (the wheel's dark slot: no light reaches the sensor).
3. `take_photo raw=true` three times (each saves a raw FITS of the live exposure under _photos, with its EXPTIME and GAIN; the result gives its path).
4. `set_camera_setting setting=filter value=IRCUT` — always put the wheel back.
5. `acquisition_measure action=sensor files=[<the three .fit paths>]` → read noise from the pair differences. Check that the result's `gain` is the stack gain: a measurement at another gain is stored under that gain and does not touch the stack's numbers. (The live exposure is short, so the dark current barely adds to the read noise.)

## 2. Conversion gain, clip level, the site's sky and the stars (any clear night)
After ~6 subs of a normal target, with the Moon down and the target above 35°:
`acquisition_measure action=sky session=latest` (reads the newest subs off the scope; ~16 MB each over the tunnel, so the default 4 is enough). It stores e⁻/ADU by photon transfer, the clip level, a sky sample (three trusted ones replace PLAN_BORTLE with the measured zenith sky; PLAN_SKY_SQM still wins) and the stars' FWHM. Repeat on two more nights. It also reports the session's cadence (seconds between subs, the dither interval and cost) — if they differ from the device file's, tell the owner.

## 3. During a capture
`acquisition_measure action=check session=latest` after ~5 subs: SHORTEN / LENGTHEN (stop_stacking, set the sub, `start_stacking restart=true`) and REFOCUS are acted on now, early in the stack, never midway through it (system prompt P3 step 7); report the change and the measurement behind it with `journal action=note`. It records sky and seeing samples too.

## 4. Sub length (once per filter in use; again after the sky or the season changes)
`sub_length action=analyze session=latest` runs Deep Sky Detail's Sub Length Calculator on the newest sub: it fetches the dark master of the sub's exposure from the scope's darklibrary itself (its level is the offset; the read noise is the one measured in step 1, else the spec's — the result says which). To run it the exact DSD way, give bias frames: the three dark-filter `take_photo raw=true` frames of step 1 as `reference=[…]` (their scatter is the read noise, and it is stored for the gain). Read `swamp.measured` against `swamp.wanted` (PLAN_SWAMP_FACTOR, 10), `efficiency.pct` (≥ 95% excellent) with `efficiency.extraIntegration`, and `swamp.minSubS` / `swamp.offeredSubS` — `recommendation` puts it in words (in alt-az the 30 s ceiling usually wins; in EQ it says whether 60/90/120 s pay). Stored per filter and gain, it becomes part of every later `acquisition_plan` answer (`subLength`). Through the LP filter it runs in narrowband mode; pass `narrowband=false` for empty sky. `action=show` lists what is stored; `action=forget` drops it.

## Rules
- Measure only frames taken with the light path as stated: a wrong cohort teaches wrong numbers. `acquisition_measure action=forget forget=gain gain=<g>` drops a bad one.
- The stack gain is the firmware's: never change it to "test" something.
- Never edit the shipped device files. A correction goes into `<data>/devices/<id>.json` (a copy with the same id) — only on the owner's request.
