---
name: image-assessment
description: Judging focus, tracking, exposure and data quality from live views, stacks, photos and FITS subframes using star_sharpness, view_image/analyze_image.
---
# Image assessment

Use both your eyes (`view_camera`, `view_image`) and the numbers (`analyze_image`).

| Metric | Meaning | Good | Act when |
|---|---|---|---|
| `stars.medianHfrPx` | star size (focus/seeing) | ≲ 2.5 (1280 preview), ≲ 3.5 (full-res FITS superpixel) | rising over the night → refocus |
| `stars.medianRoundness` | minor/major axis | > 0.8 | < 0.7 → trailing (wind, field rotation, polar alignment) |
| `stars.count` | detection | dozens–hundreds | near 0 in a sky frame → clouds, dew, wrong pointing |
| `saturatedPercent` | clipping | < 0.5% (astro), ~0 (Moon/planets) | Moon/planets/daytime: shorter exposure. Deep-sky subs: keep the profile (bright star cores clip harmlessly; see acquisition-profiles) |
| `stats.median` (non-linear JPEG) | background brightness | 0.05–0.25 at night | > 0.4 → twilight, Moon glow, light pollution |
| `sharpness` | Laplacian variance of a stretched image | compare relative between shots | daytime/manual focus only: maximise it. Never compare it across exposures |
| `colorMeans` | channel balance | — | strong cast → white balance (daytime) |

**Night focus has one number: `star_sharpness`.** It measures the median star half-flux radius (HFR — the radius holding half a star's flux) from up to 60 isolated stars, each against its own local sky, and reports it in px and arcsec, with `score` = 1000 ÷ HFR(arcsec): higher is sharper, ~250-450 is sharp on the tele, < 120 is soft. Because it is flux-weighted per star it does not move with exposure, gain, cloud thickness, sky glow or the camera's tone curve — two readings taken minutes apart are comparable, which `analyze_image`'s `sharpness` is not. It also returns the 1σ spread between the stars (`hfrUncertaintyPx`): never act on a difference smaller than that.
Order: `autofocus mode=astro` finds focus (whole range) → `star_focus` tunes it (fine sweep, moves the focuser to the sharpest) → `star_sharpness` confirms and becomes the night's baseline. Read `cautions` before believing a reading: an elongated frame (roundness < 0.7) is mixing trailing into the number, and clipped cores bias HFR small.

Tips
- Zoom with `crop` (fractions). Check corners (`x:0,y:0,width:0.25,height:0.25`) for tilt or coma, and the centre for focus.
- FITS subframes: `view_image source=device:/DWARF3/Astronomy/<session>/<file>.fits` (auto-debayered and stretched). The header shows exposure, gain, temperature.
- Compare a fresh frame with an earlier one to detect clouds (star count drop) or drift (stars moved).
- Daytime/terrestrial focus: `analyze_image source=tele crop=<subject>` `sharpness`, `focus_step`, repeat, keep the best — stars are not in the frame, so `star_sharpness` has nothing to measure.
