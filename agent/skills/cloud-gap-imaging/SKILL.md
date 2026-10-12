---
name: cloud-gap-imaging
description: Imaging on partly cloudy nights — watching the forecast and the wide camera for clear gaps, starting and pausing stacking as clouds come and go.
---
# Cloud-gap imaging

Goal: collect clean subs in the clear gaps without filling the stack with cloudy frames or losing pointing.

## Before starting
- `weather_forecast` → hours with the best scores and cloud layers. **High** cloud (thin cirrus) still lets bright targets through; **low/mid** cloud blocks everything.
- Pick a target that is high (> 45°) during the hoped-for gaps, and bright. Emission nebulae with Duo-Band tolerate haze better than galaxies.
- Waiting for gaps leaves the scope idle, and the Dwarf may **auto-power-off** when idle. `autoShutdown` is a device-wide setting (shown under `deviceSettings` in `get_camera_settings`). Turn it off yourself: `set_camera_setting camera=tele setting=autoShutdown value=false`; the tool reads it back and reports "verified on device". Restore it (`value=true`) at the end of the session.

## Is the sky clear right now?
- **`sky_check`** (one call: wide still at 2.5 s / gain 60, camera settings restored afterwards) → verdict, star count, background, image. Point above ~60° altitude (pitch > 150) first. This is the clear-sky meter; don't hand-set wide exposure/gain for it. Note the star count on a known-clear moment in `NOTES.md` to calibrate ("clear ≈ N stars").
  - Many stars, roundness fine → clear. Stars dropping toward 0 with a brighter, flatter background → cloud. Few stars everywhere with a dark background → dew on the lens or wrong exposure.
- `view_camera source=wide stretch=true` to see cloud structure and which way it's moving.

## Loop
1. When clear: `goto_target` (calibration needs stars, so only attempt in a gap), `focus_position action=infinity`, then astro autofocus if time allows, then `live_stacking action=start`.
2. Run it as a duty (`duty action=start`); on each sample: `stacking_status`. If `rejected` rises quickly or the stack stops growing, check the wide view.
3. Cloud arriving: `live_stacking action=stop` (normal stop keeps the stack so far). Don't move the scope. The pointing stays valid if the mount isn't disturbed.
4. Between gaps: on every sample sweep with `sky_check` toward the targets' part of the sky (several directions, not one patch), with a short `duty action=next_check in_s=60` so the next sweep comes soon. Start the moment stars show (~10+): GoTo + stacking in the same turn. Cloudy subs get rejected anyway.
5. Gap returns: start stacking again. If stars look shifted or the target isn't centred, re-run `goto_target` first. Each start creates a new session folder on the SD card. That's fine: the user can stack them together later from the library.
6. End of window: stop, summarise (clear minutes, frames stacked/rejected per segment), and offer `transfer_session` for each segment.

Record what worked in "Learned" below (e.g. the clear-sky star count, how long gaps lasted, reject rates).

## Learned
- *nothing yet*
