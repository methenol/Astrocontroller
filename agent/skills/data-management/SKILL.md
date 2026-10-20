---
name: data-management
description: Moving captures from the telescope SD card into the imagery library, calibration frames, and keeping the SD card from filling up.
---
# Data management

- `list_device_sessions` → astro sessions on the SD card (FITS count, size, already-in-library flag).
- `transfer_session session=<folder|latest>` copies into the library, which mirrors the telescope's own Astronomy folder:
  - `DWARF_RAW_<TELE|WIDE>_<target>_EXP_…/` with the raw subs `*.fits` (16-bit Bayer, ~16.6 MB each, so 1 h of 15 s subs ≈ 4 GB), `failed_*.fits` (subs the scope's stacker rejected; AstroPhoto Studio still grades them), `stacked-16_*.fits/.png` (the scope's own stack), `stacked.jpg`, `shotsInfo.json`, `session.json`
  - `CALI_FRAME/<dark|flat|bias>/<cam_0|cam_1>/` the device's calibration masters, shared by all sessions. Studio finds them beside the sessions by itself.
  - `<session>/processed/` the finished JPEG/TIFF from AstroPhoto Studio, copied back when its job is done
- Transfers run in the background over FTP (measured 2026-10-02: ~20 MB/s on this network, so a 3 GB session takes ~3 min). Track them with `jobs`. Tell the user the estimate (size ÷ ~20 MB/s).
- Photos, videos and stacked JPGs: `transfer_files paths=[…]` → `_photos/<date>/`.
- Free SD space shows in `telescope_status.storage`. Never delete anything on your own: `delete_album_items` is only for files the user told you to delete. When space runs low, report it.
- `Solving_Failed/` and `RESTACKED/` folders on the SD card hold failed-calibration snapshots and on-device restacks.

## Processing (AstroPhoto Studio)
- After a transfer, processing is queued automatically (`.env` ASTROPHOTO_AUTO_PROCESS, profile ASTROPHOTO_PROFILE). `processing_status` shows whether the server is reachable, its profiles, the local outbox and the server queue with ETAs.
- One job = one image. **Multi-night stacks**: `process_session target="C 33"` pools every library session of that target (all days) into one image; `sessions=[…]` picks specific nights. `transfer_session … pool=true` does the same automatically for a new night. Keep one filter per pool (Duo-Band nights and Astro nights make different images).
- Field sessions: with no server in reach, items wait in the outbox and go out when it answers. If the server cannot see the library (no NAS), the subs and masters are uploaded to it first (resumable).
- `processing_job action=cancel|retry|move id=…` manages one item. Profiles come from the server, so check `processing_status` instead of assuming names.
