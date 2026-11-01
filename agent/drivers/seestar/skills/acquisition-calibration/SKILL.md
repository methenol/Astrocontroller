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
`acquisition_measure action=check session=latest` after ~5 subs: SHORTEN (set the shorter sub, `start_stacking restart=true`) and REFOCUS act now; LENGTHEN only with the owner's leave. It records sky and seeing samples too.

## Rules
- Measure only frames taken with the light path as stated: a wrong cohort teaches wrong numbers. `acquisition_measure action=forget forget=gain gain=<g>` drops a bad one.
- The stack gain is the firmware's: never change it to "test" something.
- Never edit the shipped device files. A correction goes into `<data>/devices/<id>.json` (a copy with the same id) — only on the owner's request.
