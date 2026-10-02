---
name: daytime-wildlife
description: Daytime use — finding, framing, focusing, tracking and photographing birds/animals and other terrestrial subjects with both cameras.
---
# Daytime & wildlife

## Safety
- `find_target name=Sun` first to get the Sun's altitude/azimuth. Never point within ~30° of it. The tele has no solar filter by default.

## Setup
- `set_shooting_mode mode=Normal` for photos/video/burst, or `mode="Auto Tracking"` for subject tracking.
- Tele filter → **VIS**: `set_camera_setting camera=tele setting=filter value=VIS`.
- Exposure: moving subjects need **≤ 1/500 s** (birds in flight 1/1000+). Keep gain as low as the light allows. Or use `exposure=auto` and check `analyze_image` saturation/brightness.

## Find & frame
1. `view_camera source=wide` to spot the subject. The tele's field is the rectangle `telescope_status.teleInWide`: **x,y = top-left corner**, plus width/height, in wide 1920×1080 pixels (verified 2026-10-02, about 126×70 px). To put a subject in the tele, move so the subject lands inside that box, not the frame centre.
2. Centre with relative moves: wide ≈ **0.0235°/px**, tele ≈ **0.0015°/px** (1920-wide frames; × 1920/width for the 1280-px previews). For a subject `dx` px right and `dy` px below centre: `move_motors relative=true rotation_deg=<−dx·scale> pitch_deg=<−dy·scale>`.
3. For small adjustments use `nudge` (speed 0.1–0.3, 0.3–1 s).
4. `autofocus mode=normal x=<px> y=<px>` on the subject (tele frame coordinates, 1920×1080).

## Track & capture
- `track_object action=start camera=tele x y width height` with the subject's box from the tele view (or `camera=wide` if the subject is only visible there). Results appear in `telescope_status.trackResult`.
- `sentry_mode action=start object_type=2` (birds) / 4 (animals) to wait for subjects automatically.
- Capture: `take_photo camera=tele count=10` (burst) or `video_recording`. Review with `view_image source=device:<path>` and `analyze_image` (sharpness) and keep the best.

## Learned conventions
- 2026-10-02 (verified): rotation angle **decreasing = view pans right**; pitch increasing = tilts up. `nudge` directions are screen-relative (up/down/left/right) and already mapped.
- 2026-10-02: nudge speed 0.3 for 1 s ≈ 9° on either axis (≈ 30°/s at speed 1.0). Use 0.05–0.15 for fine framing on the tele.
- `view_camera` waits ~1.5 s after any motion so frames aren't motion-blurred.
