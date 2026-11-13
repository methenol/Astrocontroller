# ZWO Seestar S50 Pro: specification sheet

Sources: **[P]** the official ZWO product page and its specification table (`zwo-help/Seestar-S50-Pro-Product-Page.md`), **[G]** official Seestar guides (`zwo-help/`), **[D]** read from this unit's firmware (9.75, `get_device_state`), **[V]** verified on this unit (dates), **[A]** the Seestar app 3.4.1. Other Seestar models (S30, S30 Pro, S50) differ: their numbers are in Astrocontroller's device files, not here.

## Optics and cameras
| | Telephoto (tele, the firmware's "View") | Wide-angle (wide, "SecondView") |
|---|---|---|
| Aperture / focal length | 50 mm / 260 mm, f/5.2 [P][D] | 3.4 mm / 6 mm, f/1.75 [P] |
| Equivalent focal length | 880 mm [P] | 35 mm [P] |
| Optical design | 4-element apochromat with ED glass [P] | |
| Sensor | OmniVision OS08B10, 1/1.2", 2.9 µm, 8.3 MP [P][D] | Sony IMX586, 1/2", 1.6 µm, 8.3 MP [P] |
| Resolution | 2160 × 3840, portrait [P][D] | 2160 × 3840, portrait [P] |
| Field of view | 2.8° on the long side, portrait [P]: ≈ 1.38° × 2.45°, ≈ 2.3″/px at full resolution [D] | 63° (portrait) [P]; measured ≈ 31° on the short side, 67–70 px/° on the 2160-px frame [V 2026-11-04] |
| Focus range | 15 m – ∞ [P] | 0.1 m – ∞ [P] |
- Live frames and the stack arrive at half size (1080 × 1920, ≈ 4.5″/px) [V].
- Raw subs: 16-bit FITS, clipped at 65535, BIAS card ≈ 2065 at gain 200 [V 2026-10-27].

## Filters [P]
| Tools' name | What it is | Camera |
|---|---|---|
| IRCUT | UV/IR-cut, broadband | tele and wide |
| LP | dual-band light-pollution filter: OIII 30 nm + Hα 20 nm | tele only |
| dark | dark-frame filter (the wheel's closed slot) | tele only |
- Magnetic solar filter, external: required for any Sun pointing [P][G].

## Exposure, gain, darks
- Sub lengths: 2/5/10/20/30 s in alt-az; 60 s in EQ mode only; 90/120 s in EQ when the firmware's `exp_ms.more_exposure` is on [A][P].
- The stack gain is the firmware's: 200 on this unit; the app has no gain control [D]. The live view runs at another gain for plate solving.
- Darks: with `auto_master_dark` on, the Seestar makes a master dark for a sub length itself (arm closed) the first time it stacks at that length, and keeps it in `darklibrary/<length>s` [D].
- Dithering: about every 5 subs, ≈ 17 s each; a 60 s sub takes ≈ 63 s with overhead [V 2026-10-27].

## Mount and pointing
- Alt-azimuth fork; Equatorial Mode on a wedge / tilted tripod (needs polar alignment) [P][G]. Slew 1×–1440× [P]. Mechanical home position [P]. Base thread 3/8"-16 [P].
- **The firmware works in JNow** (equator and equinox of date): GoTo targets, the mount's position and plate-solve answers. Astrocontroller's tools take and report J2000 and convert at the scope; `raw_rpc` answers are JNow [V 2026-11-13: J2000 sent unconverted put every target 15–22′ west of centre].
- `goto_target` = the firmware's AutoGoto: slew, plate-solve, re-centre on the tele. Its own plate solve reports the commanded JNow position when it is centred.
- Hand moves (`nudge`): the stick's throw to speed is ≈ 1 % 0.03°/s, 10 % 0.34°/s, 50 % 1.35°/s, 100 % 2.48°/s [V 2026-11-04].

## Power, environment, storage, connections [P]
- Battery 10 000 mAh, up to 9 h (ZWO lab, alt-az, tele stargazing, > 25 °C). Power input USB-C, 5 V 3 A or 12 V 3 A.
- Operating −10 to 40 °C; charging 0 to 40 °C; operating humidity 20–80 %. Not waterproof [G].
- Storage 128 GB eMMC, ≈ 100 GB usable.
- Wi-Fi 2.4/5 GHz (≈ 10 m), Bluetooth (≈ 5 m), USB-C. Weight 2.8 kg (main unit); 140 × 149 × 268 mm folded.
- Remote: ZWO Telescope Network. One session per telescope at a time: the official app connecting takes it over [G][V].
