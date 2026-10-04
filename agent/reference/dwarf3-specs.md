# DWARFLAB DWARF 3: specification sheet

Sources: **[M]** official user manual (`dwarflab-help/…User-Manual…`), **[T]** official troubleshooting
guide, **[P]** official product page (dwarflab.com, 2026-10-03), **[D]** read from this device's
firmware / HTTP API, **[V]** verified on this device (dates), **[3]** third-party reviews (treat as
approximate). This unit: DWARF3_704420, serial D3001265B00067, firmware 1.5.3.9 [D].

## Optics and cameras
| | Telephoto (tele, "cam_0") | Wide-angle (wide, "cam_1") |
|---|---|---|
| Lens | 6-element apochromatic dual-camera lens group [P] | same group [P] |
| Aperture / focal length | 35 mm [3] / 150 mm, f/4.3 | 6.7 mm |
| Equivalent focal length | 737 mm [P] | 45 mm [P] |
| Sensor | Sony IMX678 Starvis 2, 1/1.8", 8.3 MP [P] | 1/2.8", 2 MP [P] |
| Resolution / pixel | 3840 × 2160, 2.0 µm (4K, "bin 1") [D][V] | 1920 × 1080 |
| Plate scale | 2.75″/px | ~84″/px |
| Field of view | 2.95° × 1.66° [D] | 45° × 26° [D] |
| Data | 12-bit, raw Bayer RGGB in 16-bit FITS (values 0–4095, black ≈ 200) [P][V] | |
| Sensor figures | QE 83 %, read noise 0.6 e⁻, full well 11 270 e⁻ [P] | |
- Output formats: JPG, PNG, FITS, TIFF [P]. Video up to 4K 30 fps [M].
- Sun / Moon modes: 1× = 4K, 2× = 1080p crop [M].

## Filters (tele, built-in wheel) [P][M]
| Name in the app / tools | Passband | Use |
|---|---|---|
| VIS | 430–650 nm (UV/IR cut) | daytime, regular shooting |
| Astro | 440–690 nm (passes Hα) | broadband deep sky: galaxies, clusters, reflection nebulae |
| Duo-Band | OIII 500.7 nm + Hα 656.3 nm | emission nebulae; cuts light pollution and moonlight |
- **Solar filter:** magnetic, integrated, in the box [P]. Required for any Sun pointing.
- **ND filter for dark frames:** the manual says to install the ND filter and "fully retract the lens cylinder (closed position)" [M 3.2.3.1]. **On this device the operator tilts the scope up by hand and fits the magnetic filter; parking or any motion knocks it off [V 2026-10-03].** Use `dark_frames action=nd_fitted` (locks all motion) and the dark-library skill.

## Exposure, gain and modes
- Deep-sky exposure up to **60 s** [P]. Manufacturer guidance: 15–60 s and gain 60–80 [M]. **Auto mode** caps exposure at 15 s [M].
- **Tele deep-sky gain ≥ 40.** Lower gains cause vertical banding in stacks [M].
- **EQ mode is mandatory for exposures ≥ 30 s** ("a recent update has now made it mandatory"); it is recommended from 15 s [M 3.2.2.2]. CoMosaic and Astro Mosaic always need EQ mode, and CoStack needs it above 30 s [M].
- **Dithering:** below 60 s, a dither every 6 captured frames; at 60 s and above, every 10. Frames exposed during a dither are discarded, so gaps in frame numbers are normal [T]. Seen on this device: blocks of 6 at 15 s, one 15 s gap per dither [V 2026-10-01 NGC 281].
- **Dark frames:** they must match exposure, gain and resolution exactly. The firmware stacks up to 20 frames per master. Darks are grouped by temperature, and the app prompts to retake them beyond **±8 °C** [M 3.2.3].
  - The tool: `dark_frames`. The capture command is never acknowledged; the master file appearing in CALI_FRAME marks the end [V 2026-10-03].
- Factory masters in CALI_FRAME are dated 2037/2038 [V][3]. The wide camera has no factory darks [3].
- Schedule Shooting: plans run unattended at a set time [M 3.8].

## Mount
- Alt-az fork with stepper motors; must be **homed after every power-on** (error -14520 = not homed) [V].
- Pitch ≈ 90° = level; altitude ≈ pitch − 90 (alt-az); parked ≈ 2.5°; rotation centre of travel ≈ 159° [V].
- Field rotation in alt-az: corner trails ≈ 3 px at 15 s, 6 px at 30 s, 12 px at 60 s for a target due south at 45° altitude, lat 40° (see acquisition-profiles).
- **EQ mode:** the whole scope is tilted on a wedge or tripod so its rotation axis points at the celestial pole; this removes field rotation and needs polar alignment [M][P].

## Power, environment, storage
- Battery: ~10 000 mAh [3]; ~5.5 h of astrophotography at room temperature [P]. Charging over USB-C, PD 12 V / 2 A (24 W) fast charge [M].
- **Astro shooting stops automatically at 8 % battery** (recording at 7 %). Firmware updates need ≥ 20 % [M].
- Charging slows or pauses below 0 °C and is disabled above 45 °C battery temperature. The device shuts down at a 65 °C battery NTC temperature. The temperature the app shows is the tele camera's, not the battery's [M].
- Operating temperature −20 °C to 45 °C; IP54 (dust and dew resistant) [P]. Weight ≈ 1.35 kg [P].
- Storage: 128 GB eMMC; ~104 GB usable on this unit [M][D]. Recording stops below 1 GB free [M]. One hour of 15 s raw subs ≈ 4 GB.
- **In the box** [P]: DWARF 3, storage bag, magnetic integrated solar filter, filter bag, USB-C cable, lens cloth.

## Network and protocol (this device, STA mode at 10.0.0.196) [V]
| Port | What |
|---|---|
| 9900 | WebSocket control (protobuf `WsPacket`): one controlling client at a time. The official DWARFLAB app takes the session ("single device connection only"); close it. |
| 8082 | HTTP: device info, album, per-mode parameter schema (exposure tables, gain lists, parameter ids) |
| 554 | RTSP live views `ch0` (tele) / `ch1` (wide), H.265 1080p30; tele RTSP pauses in some astro modes |
| 8092 | MJPEG stack preview while live stacking |
| 80 / 21 | HTTP / anonymous FTP file access; FTP root = the SD card's `DWARF3/` folder |
| AP mode | the scope's own Wi-Fi at 192.168.88.1 |

**Firmware quirks found (1.5.3)** [V]:
- These commands are acted on but never acknowledged: single-step focus, track start, RGB / power.
- Motor run-to is answered only when the motion finishes. The dark capture (11021) is never answered: the master file appearing marks its end.
- A forced live stack without GoTo is preview-only: no FITS are saved.
- A long manual exposure (≥ 1 s) on the wide camera stops its live video until exposure is back to auto.
- A failed calibration can leave the motors un-homed.

## SD-card layout (see `dwarflab-help/How-to-View-and-Obtain-the-Files-on-DWARF-3.md`)
- `Astronomy/DWARF_RAW_<TELE|WIDE>_<target>_EXP_<s>_GAIN_<g>_<date-time>/`: raw subs `<target>_<exp>s<gain>_<filter>_<time>_<temp>C.fits`, the subs the stacker rejected (`failed_…fits`), `stacked*.jpg/png/fits`, `shotsInfo.json`, `Thumbnail/`.
- `Astronomy/CALI_FRAME/<dark|flat|bias>/<cam_0|cam_1>/`: masters, e.g. `dark_exp_15.000000_gain_60_bin_1_38C_stack_20.fits`, `flat_gain_2_bin_1_ir_<0 VIS|1 Astro|2 Duo-Band>.fits`, `bias_gain_2_bin_1.fits`.
- `Astronomy/Solving_Failed/` (failed plate-solve snapshots), `RESTACKED/`, `STARTRAILS/`.
