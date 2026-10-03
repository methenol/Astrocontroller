---
name: image-assessment
description: Judging focus, tracking, exposure and data quality from live views, stacks, photos and FITS subframes using view_image/analyze_image.
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
| `sharpness` | Laplacian variance | compare relative between shots | for manual/daytime focus, maximise it |
| `colorMeans` | channel balance | — | strong cast → white balance (daytime) |

Tips
- Zoom with `crop` (fractions). Check corners (`x:0,y:0,width:0.25,height:0.25`) for tilt or coma, and the centre for focus.
- FITS subframes: `view_image source=device:/DWARF3/Astronomy/<session>/<file>.fits` (auto-debayered and stretched). The header shows exposure, gain, temperature.
- Compare a fresh frame with an earlier one to detect clouds (star count drop) or drift (stars moved).
- Daytime focus: take `analyze_image source=tele crop=<subject>` sharpness, `focus_step`, and repeat. Keep the best.
