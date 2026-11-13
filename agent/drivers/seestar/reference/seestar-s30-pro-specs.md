# ZWO Seestar S30 Pro: specification sheet

Sources: **[P]** the official ZWO product page and its specification table (`zwo-help/Seestar-S30-Pro-Product-Page.md`), **[F]** the official S30 Pro FAQ (`zwo-help/Seestar-S30-Pro-FAQ.md`), **[G]** official Seestar guides (`zwo-help/`), **[A]** the Seestar app 3.4.1, **[C]** calculated from [P]. Nothing here is verified on an S30 Pro yet: the firmware behaviour below is the Seestar family's, verified on an S50 Pro (`seestar-s50-pro-specs.md`). Which model you run: `seestar_status` → `device.model`.

## Optics and cameras
| | Telephoto (tele, the firmware's "View") | Wide-angle (wide, "SecondView") |
|---|---|---|
| Aperture / focal length | 30 mm / 160 mm, f/5.3 [P] | 3.4 mm / 6 mm, f/1.75 [P] |
| Optical design | 4-element apochromat with ED glass [P] | |
| Sensor | Sony IMX585, 2.9 µm, 8.3 MP [P] | Sony IMX586, 8.3 MP [P] |
| Resolution | 2160 × 3840, portrait [P] | 2160 × 3840, portrait [P] |
| Field of view | 4.6° on the diagonal [P]: ≈ 2.24° × 3.99°, ≈ 3.7″/px at full resolution [C] | 63° [P] |
| Focus range | 6 m – ∞ [P] | 0.1 m – ∞, autofocus supported [P] |

## Filters [P]
| Tools' name | What it is | Camera |
|---|---|---|
| IRCUT | UV/IR-cut, broadband (passes Hα [F]) | tele and wide |
| LP | astronomical light-pollution filter: OIII 30 nm + Hα 20 nm | tele |
| dark | dark-field filter (the wheel's closed slot) | tele |
- Magnetic solar filter, external: required for any Sun pointing [P][G]. No other external filters or accessories fit [F].

## Exposure, gain, darks
- Sub lengths: 2/5/10/20/30 s in alt-az; up to 60 s in EQ mode [A][F]; 90/120 s in EQ when the firmware's `exp_ms.more_exposure` is on [A].
- **EQ mode needs a compatible Seestar mount (the TH10)** for polar alignment; without it EQ mode cannot be enabled [F].
- The stack gain is the firmware's (the app has no gain control); darks are made by the scope per sub length with `auto_master_dark` on, as on every Seestar [A].

## Mount and pointing
- Alt-azimuth; Equatorial Mode on the TH10 [F].
- The firmware works in JNow, as every Seestar's: Astrocontroller's tools take and report J2000 and convert at the scope; `raw_rpc` answers are JNow.

## Power, storage, connections [P]
- Battery 6000 mAh (22 Wh), about 6 h (ZWO lab) [P][F]; 5–6 h of imaging per session [F]. Power input USB-C, 5 V 3 A.
- Storage 128 GB eMMC.
- Wi-Fi, Bluetooth, USB-C; Station Mode through a home network; no internet needed once set up [F].
- Milky Way Mode (wide camera): live stacking, foreground separation, panoramas, star trails [F][G].
