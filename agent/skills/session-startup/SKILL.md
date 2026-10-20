---
name: session-startup
description: First thing to do in any session or after the telescope powers on — connection, homing, time/location sync, battery/SD checks, raising the scope.
---
# Session startup checklist

1. `telescope_status` → check `connected`, `battery`, `storage`, `motors.homed`, `bodyMode`.
   - Not connected: the scope may be off, on another network, or the **official DWARFLAB app is open** (it steals the session — ask the user to close it), then `telescope_reconnect`.
2. Motors not homed (`motors.homed: false`, or any motion fails with -14520): `motors_home` (~30–60 s). It ends pointing **down** (pitch ≈ 2.5°).
3. `sync_time_and_location` (happens automatically on connect, but re-run if the user moved site or the clock looks wrong).
4. Raise the scope to look around: `move_motors pitch_deg=120` (≈ 30° altitude in Alt-Az) and `view_camera source=wide`.
5. Turn the RGB ring light off for night work: `power action=rgb_off`.
6. Warn if battery < 15% or SD free < 2 GB.
7. Once it is dark: `map_obstructions` (status). No map for this site (a new site, or the scope moved more than ~300 m) → `map_obstructions action=run`: it GoTos two or three sky positions to fix its pointing by the telescope's plate solving, pans all round taking wide stills, and saves the site's horizon so `plan_targets` only offers what is visible (`obstructedNow`, `horizon`). ~15–25 min; point at clear sky first. Afterwards the next GoTo is one-click (the survey's motor resets can clear the calibration). The owner can clear or redo the map from the Tonight tab.

## Known facts (verified on this device, fw 1.5.3)
- Pitch ≈ 90° is level; pitch − 90 ≈ altitude (Alt-Az). Rotation ≈ 159° is the centre of travel after homing.
- Motor run-to replies only when the motion finishes, so `move_motors` waits for completion.
- The live RTSP views go blank while some astro tasks run. `view_camera source=stack` shows the stacking result instead.
