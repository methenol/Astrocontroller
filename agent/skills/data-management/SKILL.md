---
name: data-management
description: Moving captures from the telescope SD card into the imagery library, calibration frames, and keeping the SD card from filling up.
---
# Data management

- `list_device_sessions` → astro sessions on the SD card (FITS count, size, already-in-library flag).
- `transfer_session session=<folder|latest>` copies into the library:
  - `<Target>/<date>_<folder>/` with `stacked.jpg`, `stacked-16_*.png` (16-bit linear stack), `img_reference.png`, `shotsInfo.json`, `session.json`
  - `lights/*.fits` raw subframes (16-bit Bayer, ~16.6 MB each, so 1 h of 15 s subs ≈ 4 GB); `lights/rejected/` holds subs the scope's stacker rejected (`failed_*.fits`), and `stacked-16_*.fits` is the scope's own linear stack
  - `_calibration/<tele|wide>/<dark|flat|bias>/` the device's calibration masters (shared by all sessions)
- Transfers run in the background over FTP (measured 2026-10-02: ~20 MB/s on this network, so a 3 GB session takes ~3 min). Track them with `jobs`. Tell the user the estimate (size ÷ ~20 MB/s).
- Photos, videos and stacked JPGs: `transfer_files paths=[…]` → `_photos/<date>/`.
- Free SD space shows in `telescope_status.storage`. Only delete with explicit user approval (`delete_album_items … confirm=true`), and only after confirming the data is in the library (`list_library`).
- `Solving_Failed/` and `RESTACKED/` folders on the SD card hold failed-calibration snapshots and on-device restacks.
