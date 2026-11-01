# Smart telescope specifications

One JSON file per model, read by the capture-settings planner (`acquisition_plan`, the Plan tab's
**Capture** line). The planner picks the file from the model name the scope reports (`match`), then
the optics it reports, else the driver's first file; `PLAN_DEVICE=<id>` in `.env` forces one.

**Add a model, or correct a shipped one:** put a file of the same shape in `<DATA_DIR>/devices/`
(`data/devices/` for the Dwarf, `data-seestar/devices/` for the Seestar). A file there whose `id`
matches a shipped one replaces it; leave the shipped files alone so updates do not overwrite your
edits. Invalid files are skipped with the reason in the log and in `acquisition_plan action=devices`.

A spec is a starting point. What the connected scope reports (its EQ mode, stack gain, filter wheel,
the exposures and gains it offers, its dark masters) overrides it, and what `acquisition_measure`
measures from this unit's raw frames (conversion gain, read noise, black level, clip level, the
site's sky and the stars' FWHM) overrides the sensor figures. `acquisition_plan action=device` shows
which number came from where.

| Field | Meaning |
|---|---|
| `id` | lower-case-with-dashes; the key `PLAN_DEVICE` and measurements use |
| `driver` | `dwarf`, `seestar` or `other` |
| `match` | lower-case pieces of the reported model name; the longest match wins (`"s50 pro"` beats `"s50"`) |
| `optics` | `apertureMm`, `focalLengthMm` (`PLAN_APERTURE_MM` overrides the aperture) |
| `sensor.widthPx`, `heightPx`, `pixelUm` | the full sensor; plate scale and field follow |
| `sensor.bitDepth`, `dataMaxAdu` | the raw files' range: the value a clipped pixel has (4095 for 12-bit, 65535 for 16-bit) |
| `sensor.blackLevelAdu` | the level of a dark at a typical sub (offset + dark current) |
| `sensor.qe` | peak quantum efficiency (throughput = 0.85 × qe) |
| `sensor.fullWellE` | the pixel's well; the usable well is the smaller of this and the ADC range × e⁻/ADU |
| `sensor.gainUnit` | how e⁻/ADU follows the gain number: `0.1dB` (ZWO: ×10^(−Δgain/200)) or `linear` (∝ 1/gain) |
| `sensor.ePerAdu` | `[{gain, value}]` electrons per raw-file ADU; one anchor is enough |
| `sensor.readNoiseE` | `[{gain, value}]` read noise in electrons, interpolated between anchors |
| `sensor.darkCurrentEPerS` | dark current at a typical sensor temperature |
| `gain` | `settable` (false: the firmware sets the stack gain), `default`, `min`, `max`, `options` (the gains worth trying) |
| `exposure.altAzS`, `eqS` | sub lengths offered in each mount mode; `eqExtendedS` only when the firmware says so (Seestar `more_exposure`) |
| `exposure.requiresMatchingDarks` | the firmware refuses a sub without a dark of that exposure and gain (Dwarf) |
| `exposure.perSubOverheadS` | seconds between subs (readout, download) |
| `dither` | `everySubs`, and its cost: `costS` seconds and/or `costSubs` discarded subs; `longFromS` + `everySubsLong` for a longer interval from that sub length |
| `filters` | `name` (as the driver's tools take it), `aliases` (PLAN_FILTERS' spellings), `band` (`broadband`, `uhc`, `duo_wide`, `duo_tight`, `line`), optional `skyFraction` (share of a broadband sky passed), `deepSky: false` for daytime glass |
| `sources`, `notes` | where the numbers come from; shown with the device |

Numbers marked as estimates in a file's `notes` are the ones to measure first:
`acquisition_measure action=sensor` on dark frames, then `action=sky` on a clear night's session.
