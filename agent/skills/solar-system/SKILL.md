---
name: solar-system
description: Imaging the Moon, planets and (with a solar filter only) the Sun — modes, exposure, focus and lucky-imaging style capture.
---
# Moon, planets, Sun

- `sky_conditions` / `find_target name=<planet>` → altitude, transit time, magnitude. Image near transit, above 30° if possible.
- `goto_target name=Jupiter` (planets/Moon use the solar-system GoTo). For the Moon or Sun, `track_sun_moon` keeps them centred with the dedicated tracking mode.
- Modes: `set_shooting_mode mode=Moon` / `Planet` / `Sun`.
- Filter **VIS**. Focus: `autofocus mode=normal` on the limb or planet disc (pass its x,y), then verify with `analyze_image` sharpness and a cropped `view_camera`.
- Exposure: short. Moon ~1/250–1/1000 s, gain low. Jupiter/Saturn ~1/60–1/200 s, gain 80–150. Avoid saturation (`analyze_image.saturatedPercent` ≈ 0).
- Capture many frames (`take_photo count=30`) or a short video for stacking in external software. The Moon also works well with live stacking in Moon mode.
- **Sun**: only after the user confirms the solar filter is fitted (`track_sun_moon body=sun solar_filter_confirmed=true`). Never otherwise.
