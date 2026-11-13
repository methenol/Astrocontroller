---
name: acquisition-calibration
description: Measure this Dwarf's sensor and the site's sky from its own raw frames (acquisition_measure) so acquisition_plan's exposure/gain/filter advice runs on measured numbers instead of spec-sheet guesses. Once per gain in use, and a sky cohort on clear moonless nights.
---
# Acquisition calibration (Dwarf)

`acquisition_plan action=device` lists what is still a guess under `missing` and, per number, where it comes from (`spec`, `device`, `measured`, `env`). Measure the missing ones in this order; each step is deterministic (robust statistics on one green phase of the raw mosaic) and stored for good.

## 1. Black level and dark current (once per gain, after a firmware update)
The Dwarf only keeps dark *masters* (CALI_FRAME), which give levels but not read noise.
1. `dark_frames action=list` → the masters' file names.
2. `transfer_files` the masters of ONE gain, two exposure lengths if there are (e.g. 15 s and 60 s at gain 60), into the library.
3. `acquisition_measure action=sensor files=[<both master paths>]` → offset (bias) and dark current from the two levels. Read noise stays the spec's (masters average it away); that is acceptable — the conversion gain below only needs it where the sky is faint.

## 2. Conversion gain, clip level, the site's sky and the stars (any clear night)
After the first ~6 subs of a normal target, with the Moon down and the target above 35°:
`acquisition_measure action=sky session=latest` (reads the newest subs off the SD card). It stores:
- e⁻/ADU by photon transfer — only when the black is measured (step 1) and the sky is bright enough against the read noise; otherwise `ePerAduNote` says why not;
- the clip level the files show (saturated star cores);
- a sky sample; with three trusted ones the site's measured zenith sky replaces PLAN_BORTLE (a sky-meter value in PLAN_SKY_SQM still wins);
- the stars' FWHM (replaces the forecast-seeing estimate once three exist).
Repeat on two more nights for the site's sky. Moonlit or low cohorts are recorded but do not count toward the site.

## 3. During a capture
`acquisition_measure action=check session=latest` after the first cohort: SHORTEN / LENGTHEN / REFOCUS are acted on now, early in the stack, never midway through it (system prompt P2 step 8); report the change and the measurement behind it with `journal action=note`. It records sky and seeing samples too.

## 4. Sub length (once per filter and gain in use; again when the sky or the season changes)
`sub_length action=analyze session=latest` runs Deep Sky Detail's Sub Length Calculator on the newest sub: it fetches the dark master of the sub's exposure and gain from CALI_FRAME itself (two `_stack_1` single darks, when the scope has them, also give the read noise by their pair difference; a master gives the offset only and the read noise is the stored one — the result says which). Read:
- `swamp.measured` against `swamp.wanted` (PLAN_SWAMP_FACTOR, 10): how many times the read noise's variance the sky already buries at this sub;
- `efficiency.pct` (≥ 95% excellent) and `efficiency.extraIntegration` (what a lower one costs);
- `swamp.minSubS` / `swamp.offeredSubS`: the shortest sub that reaches the factor and the device's sub at or past it; `recommendation` puts it in words.
The result is stored per filter and gain; `acquisition_plan` then scales its sky-noise term by it and quotes `subLength` (swamp, efficiency, the minimum sub) with every recommendation. Through the Duo-Band it runs in narrowband mode (the background is the nebula); pass `narrowband=false` for a frame of empty sky. `sub_length action=show` lists what is stored; `action=forget` drops it.

## Rules
- Measure only frames taken with the light path as stated (darks dark, lights on sky): a wrong cohort teaches wrong numbers. `acquisition_measure action=forget forget=gain gain=<g>` drops a bad one.
- Never edit the shipped device files. A correction to the spec (a new exposure list after a firmware update) goes into `<data>/devices/dwarf-3.json` (a copy with the same id) — only on the owner's request.
