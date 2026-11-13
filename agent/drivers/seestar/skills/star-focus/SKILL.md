---
name: star-focus
description: The fine focus tune before every stack (star_focus). Mandatory on every target, after autofocus and before start_stacking: sweep +/- 10 focus steps from the autofocus position with a step of 1, and land on the sharpest measured value. Focus is critical on all targets.
---
# Star focus (fine tune)

Focus decides the whole image. This tune runs on **every target, every time**, never skipped, never shortened, never merged with autofocus — including after a refocus while a stack runs. Only the owner can authorize skipping it, for exactly what they said and as long as they said it.

## Position in the procedure

`goto_target` → `autofocus` → **`star_focus`** → `start_stacking`.

## The sweep — exact parameters

Read the `position` the `autofocus` result reports, and choose the sweep's centre (below), then:

```
star_focus center=<the chosen centre> range=10 step=1
```

- `center`: Choose the centre by what is logical. The autofocus result is one data point, not the answer: compare it with the **last confirmed sharpest position tonight** (the previous target's final `star_focus` `finalPosition`, from the journal or the previous sweep's result). Focus barely moves between targets on one night, while the Seestar's autofocus can land far off; a sweep started on a bad autofocus value spends a long time stepping back toward where focus already was. When the two agree (within the sweep's ±10), centre on the autofocus result; when they disagree, centre on the one that makes more sense — normally the confirmed position, unless something changed that moves focus (a large temperature change, a filter change, the scope touched). Say in one line which centre you chose and why. Both values come from tool results (the autofocus result, the journal, the previous sweep's result), never from memory or the stored `focal_pos`.
- `range` = **10** (10 focus steps either side of the autofocus value).
- `step` = **1** (a sample at every single focus step across the sweep).
- `apply` stays on: the focuser is left on the best position.

Always pass `range=10 step=1` explicitly (they are also the tool's defaults). Never widen the range, coarsen the step, sample fewer points, or stop early; never reuse an earlier sweep's result for this target.

## Landing

The focuser must end on the sharpest measured position — the sweep's `best`/`finalPosition` (the fit is `fittedPosition`). A "close" value is a violation. Check the verdict says `Focused:` and that `finalPosition` equals `best.position`. If `bestAtEdge` is true the peak sits on the edge of the sweep and the sharpest focus may lie beyond it: run the sweep again with `center=` the sweep's `best.position`, `range=10 step=1`, and repeat until the peak lies inside the sweep. The goal is the absolute sharpest focus; never stack on a peak at the edge.

Judge the sweep on `hfrPx`/`score` and their uncertainties; a sample whose `cautions` warn the scope was far from focus or the stars disagree (wide HFR error) is a transient frame, not a focus reading — the landing still comes from the fit, and if the final reading is much worse than the best sample's, measure `star_sharpness` once and report it.

## Verification before stacking

After the sweep, confirm with the tool result (not memory) that the focuser is at `best.position` and the peak is inside the sweep, then `start_stacking`. During the stack, a `refocus due` line or grown stars in `analyze_subs`: `stop_stacking` → `autofocus` → this same sweep (`center=` chosen the same way: the new autofocus result against this target's confirmed position, `range=10`, `step=1`, again until the peak is inside) → `start_stacking` (no restart: the same stack continues).
