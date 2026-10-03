---
name: acquisition-profiles
description: Which exposure / gain / filter to capture with on the Dwarf 3 (a small fixed set of profiles with matching darks), chosen by mount mode, target and conditions, so the raw subs suit AstroPhoto Studio's ImageMM / Noise2Noise processing. Read before every deep-sky capture.
---
# Acquisition profiles

## The rule
Capture only with a **qualified profile** from the table below. Do not invent a new exposure or gain mid-session because a target is faint or the preview looks dark. Gain is a noise / dynamic-range setting, not a brightness knob, and every new exposure/gain pair needs its own dark master. Darks need the ND filter fitted by hand (see **dark-library**). New profiles come only from a planned A/B test (**acquisition-experiments**).

## Qualified profiles (tele camera, bin 1 = 3840×2160)
| Profile | Mount | Exposure | Gain | Dark master on the scope | Use |
|---|---|---|---|---|---|
| **ALTAZ-15** | Alt-Az | 15 s | 60 | 15 s / g60, 27 °C, stack 3 | default: everything in Alt-Az |
| **EQ-30** | EQ (polar aligned) | 30 s | 60 | 30 s / g60, 28 °C, stack 1 (weak) | EQ: small targets, galaxies, globulars, imperfect tracking |
| **EQ-60** | EQ (polar aligned) | 60 s | 60 | 60 s / g60, 28 °C, stack 1 (weak) | EQ: faint emission with Duo-Band, stable tracking |

Masters as of 2026-10-03, from the firmware. Check the current list with `dark_frames action=list`. The stack-1 masters need recapturing (see dark-library) before EQ-30/EQ-60 are used seriously.

Filter is not part of the profile, so the same darks serve every filter. Duo-Band for emission nebulae; Astro for galaxies, clusters and reflection nebulae (see deep-sky-imaging).

## Why these limits
- **Alt-Az ⇒ 15 s.** DWARFLAB's manual: "a recent update has now made it mandatory to be in EQ mode for anything 30 seconds and higher". Field rotation is the physical reason. It is not tracked within a sub, so stars trail around the frame centre. Worst-case trail at the frame corners at this site (lat 40°), target due south:

  | Altitude | 15 s | 30 s | 60 s |
  |---|---|---|---|
  | 30° | 2.4 px | 4.9 px | 9.8 px |
  | 45° | 3.0 px | 6.0 px | 12 px |
  | 60° | 4.2 px | 8.4 px | 17 px |
  | 70° | 6.2 px | 12 px | 25 px |

  Rotation is zero due east/west and largest on the meridian. 15 s keeps the corners usable up to ~60° altitude. Above ~70° even 15 s trails the edges, so plan targets in the 30–65° band rather than shortening exposures (there is no 10 s dark). AstroPhoto Studio measures each sub's PSF across the field and rejects trailed subs. Trails still cost resolution at the edges, and in rejected frames.
- **Gain 60.** The only gain with darks. DWARFLAB recommends 60–80 and limits deep-sky tele gain to ≥ 40: lower gains cause vertical banding in stacks. A different base gain needs dark masters first and an experiment showing an end-to-end gain.
- **Many short subs suit the processing.**
  - ImageMM fits one sky image to every sub with that sub's own PSF, variance and masks, so more independent subs is better.
  - Noise2Noise trains on two half-stacks, so it needs enough subs for both halves (≳ 30; fewer than ~15 subs switches the stacker to demosaic).
  - The scope dithers every 6 frames below 60 s and every 10 frames at 60 s+, and frames taken during a dither are discarded, so missing frame numbers are normal. Shorter subs give more dither positions per hour, which decorrelates fixed-pattern noise.
  - In EQ prefer **EQ-30** for detail work. Use **EQ-60** only when tracking is stable and the target is faint emission through Duo-Band, where read noise matters more.
- **No HDR cohort with a different exposure/gain.** AstroPhoto Studio stacks one dataset with one dark, chosen by the median exposure and gain of all its subs. It does not fuse exposures. Mixing a 15 s / g40 run into a target's pool would get the wrong dark and be averaged in. Saturated star cores are masked and handed back by the restoration anyway. If a target's core clips at the base profile, note it in NOTES.md; that is a question for an experiment, not a mid-session change.
- **One pool, one profile.** Nights of a target are pooled by name (`process_session target=…`). Pool only nights with the same exposure, gain and filter.

## Choosing, every target
1. Mount mode (`telescope_status.bodyMode`): Alt-Az → ALTAZ-15. EQ → EQ-30, or EQ-60 for faint Duo-Band emission with good tracking.
2. Filter by target type. With a bright Moon, prefer emission targets with Duo-Band.
3. Plan the slot so the target stays at 30–65° altitude.
4. Start: `live_stacking action=start exposure=<s> gain=60 filter=<…> frames=999`.
5. Run **session-qc** on the first cohort (12 subs < 60 s, 20 subs at 60 s: two dither blocks).

## Allowed adaptation during a session
- EQ-60 → EQ-30 if trailing or rejection is high.
- Stop / pause for clouds (keep the settings; do not touch gain).
- Refocus.

Nothing else. Write what happened in `session-log.jsonl` (see session-qc), so experiments can use it later.
