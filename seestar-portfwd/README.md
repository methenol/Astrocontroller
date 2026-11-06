# seestar-portfwd

Connect to your ZWO Seestar telescope over the Internet from a computer -
using the same **Telescope Network** path the phone app uses - and forward its
service ports to `localhost` so you can drive it with any software.

It runs the Seestar app's own ThroughTek Kalay libraries under `qemu-arm` in a
container, authenticates with your ZWO account, opens the P2P tunnel, and
publishes the device ports. Tested on Arch Linux with podman and a S30 Pro
(firmware 8.46); but should work on any OS that supports Docker.

The container runs a **supervisor** (`src/supervisor.py`) instead of the tunnel
directly: it holds exactly one session with the scope, reconnects it when the P2P
link drops, always gives it back, and takes Connect and Disconnect over HTTP —
see *Supervisor*.

## Usage

```bash
cp .env.example .env          # optional: preset credentials
docker compose build
docker compose run --service-ports --rm seestar
```

You're prompted for anything not already configured in `.env`. If the account has
one telescope it's used automatically. A **TUNNEL UP** banner lists the published
ports; Ctrl-C disconnects and releases the session.

`docker compose up` runs headless but can't prompt, so use it only with all
credentials in `.env`.

### Connect and disconnect

Nothing is connected until something asks for it — unless
`SEESTAR_TUNNEL_AUTOSTART=1`, which `compose.yaml` sets for standalone use. Ask
the supervisor:

```bash
curl -s localhost:4710/status                     # what is it doing right now
curl -s -X POST localhost:4710/connect            # take the scope
curl -s -X POST localhost:4710/disconnect         # give it back
```

`/connect` answers as soon as it is trying; `/disconnect` waits until the backend
has released the session and answers `{"released": true}`.

## Talking to the telescope

Point any tool at `127.0.0.1`. For example, list the ASCOM Alpaca devices
(cameras, focusers, mount, filter wheel):

```bash
curl -s http://127.0.0.1:32323/management/v1/configureddevices | jq .
```

ASCOM Alpaca clients (e.g. `pip install alpyca`) can then drive it via
`http://127.0.0.1:32323/api/v1/...`.

Two small utility scripts (stdlib Python 3):

```bash
# list the telescopes on your account (no tunnel needed)
SEESTAR_USER=... SEESTAR_PASSWORD=... ./seestar_status.py

# call any JSON-RPC method against a running tunnel
./seestar_rpc.py get_device_state
./seestar_rpc.py popen '{"cmd": "id"}'
```

`seestar_rpc.py` talks the same JSON-RPC-over-TCP protocol as the phone app
(port 4700) - the examples below drive the mount and cameras the same way the
app itself would.

### Pointing

Jog with a dead-man command (auto-stops after `dur_sec`, `percent: 0` stops
early); `angle` is screen-relative: `0` right, `90` up, `180` left, `270` down.
Or slew straight to RA/Dec (hours, degrees):

```bash
./seestar_rpc.py scope_speed_move '{"percent": 30, "angle": 0, "level": 1, "dur_sec": 2}'
./seestar_rpc.py scope_goto '[5.6, -1.2]'
```

### Focusing

Absolute step position (0-`max_step`, see `get_device_state().focuser`),
larger = closer focus. Or let the device autofocus:

```bash
./seestar_rpc.py get_focuser_position
./seestar_rpc.py move_focuser '{"step": 1361, "ret_step": true}'
./seestar_rpc.py start_auto_focuse
```

### Streaming the cameras

Both cameras stream live over RTSP once a view is started - the ports don't
listen until then. One call starts (and stops) both at once:

```bash
./seestar_rpc.py iscope_start_view '{"mode": "scenery"}'
vlc rtsp://127.0.0.1:4554/stream   # telephoto
vlc rtsp://127.0.0.1:4555/stream   # wide-angle
./seestar_rpc.py iscope_stop_view
```

### Parking

Folds the mount back to its stowed position and stops tracking:

```bash
./seestar_rpc.py scope_park
```

### SSH access

The `pi` user's password is set by the vendor and unknown to us,
install a SSH pubkey for the `pi` user with the `popen` JSON-RPC method to
still get a shell on the device:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/seestar_pi   # or use existing key
PUBKEY=$(cat ~/.ssh/seestar_pi.pub)

CMD="mkdir -p /home/pi/.ssh \
  && echo '$PUBKEY' >> /home/pi/.ssh/authorized_keys \
  && chown -R pi:pi /home/pi/.ssh \
  && chmod 700 /home/pi/.ssh \
  && chmod 600 /home/pi/.ssh/authorized_keys \
  && chmod g-w /home/pi"
RPC_ARG=$(python3 -c 'import json, sys; print(json.dumps({"cmd": sys.argv[1]}))' "$CMD")

./seestar_rpc.py popen "$RPC_ARG"
ssh -i ~/.ssh/seestar_pi -p 2222 pi@127.0.0.1
```

## Ports

All known device services are forwarded and published on `127.0.0.1`:

| Host | Device | Service |
|------|--------|---------|
| 4700 | 4700 | JSON-RPC control |
| 4350 | 4350 | firmware control |
| 8080 | 80 | file/image server |
| 4801 | 4801 | file API |
| 4800 / 4804 | 4800 / 4804 | image / wide stream |
| 4554 / 4555 | 4554 / 4555 | RTSP video, telephoto / wide |
| 4361 | 4361 | firmware upload |
| 4445 | 445 | SMB (eMMC images share) |
| 2222 | 22 | SSH |
| 32323 | 32323 | ASCOM Alpaca |

The privileged ports (80/22/445) are remapped to high host ports so they don't
clash with a local web server / sshd / Samba; edit `compose.yaml` to change this.
To forward a port not listed, add it to the `PORTS` table in `src/tunnel.c` and
`compose.yaml`.

The supervisor's control API is published on `127.0.0.1:4710`; it is not a device
port (`SEESTAR_TUNNEL_CONTROL_PORT=0` turns it off).

Published on loopback only: the telescope's interfaces are unauthenticated, so
don't expose them on an untrusted network. Only one remote session per telescope
is active at a time: the supervisor holds a lock while its session lives, so
connecting here supersedes the app's session and no second tunnel can start
alongside it.

## Supervisor

`src/supervisor.py` is the image's entry point. It owns the one `tunnel` process
and with it the one P2P session the scope serves, and it is the only thing that
asks the ZWO backend for a session.

**One session at a time.** An exclusive `flock` (`SEESTAR_TUNNEL_LOCK`) is held
for exactly as long as a session exists, so a second tunnel cannot start while
this one has the scope — another `docker compose run` backs off instead of
stealing it. The tunnel opens a single SDK session, every request sends the same
`srcId` so the backend treats a reconnect as superseding *our own* stale session,
and a conId left in the state file by a killed run is released before a new one
is asked for. Point `SEESTAR_TUNNEL_LOCK` at a folder you mount into every tunnel
container to extend the lock across containers.

**Reliable.** The session counts as up when the tunnel has printed its banner and
the forwarded control port answers a real `test_connection` — looked for every
0.25 s until then, so `up` is reported as soon as it is true; from then the
watchdog proves it again every `SEESTAR_TUNNEL_WATCHDOG_S`. A tunnel that never
becomes ready, exits, or goes silent is killed, released and reopened after a
backoff (`SEESTAR_TUNNEL_RETRY_MIN_S` up to `..._MAX_S`, reset once a session has
held five minutes), so the container stays up and heals the link rather than
waiting for Docker to restart it.

A tunnel that dies before it ever came up is restarted on the **same** session
(`SEESTAR_TUNNEL_CONNECT_RETRIES`, `..._RETRY_S`), and the binary asks
`Connect_Ex` again on the spot (`TUTK_CONNECT_TRIES`, `TUTK_CONNECT_PAUSE_S`):
the first call routinely comes back `-42` (`IOTC_ER_FAIL_SETUP_RELAY`) or `-60`
(`IOTC_ER_MASTER_NOT_RESPONSE`) while the rendezvous server and the scope sort
out who held the last session, and handing the session back to allocate a new
one is what makes the next call fail too. Before every retry the binary does
what the app's `sanitizeBeforeConnect` does — `P2PTunnelAgent_Connect_Stop`
and `IOTC_ReInitSocket(0)`, a fresh UDP socket for the next hole punch. A call that
is going to work answers in 6–30 s, one that is not blocks for 60–80 s (the T
SDK does not honour `IOTC_Setup_P2PConnection_Timeout`, so there is no knob).

**The backend hears about every session** the way the official app tells it
(`POST /v1/device-log/report`): `p2pConnectStart` once `online-link` has handed
the session out, `p2pConnectSucceed` the moment the tunnel is up,
`p2pConnectFailed` with the SDK's code for a session given back without coming
up, `p2pConnectCancel` for one abandoned because a disconnect came first.

The account API's `deviceStatus` is a hint, never a gate: whatever it claims — `SHOOTING`,
`OFFLINE` — the supervisor still asks for the session and dials, because that field has been seen
reporting a busy or dead scope that was perfectly connectable, and waiting on it leaves the
telescope unreachable. `online_link` and `Connect_Ex` are the real answers; the claim is logged and
nothing more.

**Always released.** Every teardown gives the scope back: SIGINT to the tunnel
(stop the port mappings, abort and disconnect the SDK sessions) and then
`device-p2p/stop` for the conId — on Disconnect, before each reconnect, on
SIGTERM, and at start for whatever a crashed run left behind. The conId stays in
the state file until the backend confirms the release, so even a `kill -9` leaves
a record for the next start. A caller that takes a lease (`{"leaseS": n}`) also
releases it by itself — the n seconds count from when the session is ours, not
from when it was asked for — so a controller that died can no longer leave the
scope occupied.

**The wish survives a crash.** The state file also records that a controller was holding the
session, so a container that died — or a host reboot — takes the connection back by itself instead
of sitting idle while something is still asking for it. A planned `stop`/`down` is a disconnect and
clears the wish; a controller that is still interested asks again on its own within its poll
interval. Keep the state directory on a volume (`/var/lib/seestar-portfwd`): on a container-local
path the record dies with the container and neither the conId nor the wish survives a rebuild.

| Variable | Default | Meaning |
|----------|---------|---------|
| `SEESTAR_TUNNEL_AUTOSTART` | `0` | connect at container start instead of waiting for `/connect` |
| `SEESTAR_TUNNEL_CONTROL_PORT` | `4710` | the control API (`0` = off) |
| `SEESTAR_TUNNEL_CONTROL_BIND` | `0.0.0.0` | address it listens on |
| `SEESTAR_TUNNEL_CONTROL_TOKEN` | – | require `Authorization: Bearer <token>` |
| `SEESTAR_TUNNEL_LEASE_S` | `0` | hold a session at most this long without a refresh |
| `SEESTAR_TUNNEL_READY_TIMEOUT_S` | `180` | give up on an attempt that never came up |
| `SEESTAR_TUNNEL_RETRY_MIN_S` / `_MAX_S` | `5` / `120` | the reconnect backoff |
| `SEESTAR_TUNNEL_WATCHDOG_S` | `10` | how often the session is proven alive |
| `SEESTAR_TUNNEL_LIVENESS_FAILS` | `3` | failed passes before a reconnect |
| `SEESTAR_TUNNEL_STATUS_REFRESH_S` | `120` | while connected, re-read the scope's account status (ONLINE/SHOOTING/OCCUPIED) this often for `/status`; `0` = only at connect/release |
| `SEESTAR_TUNNEL_STOP_GRACE_S` | `10` | SIGINT to SIGKILL for the tunnel |
| `SEESTAR_TUNNEL_LOCK` | `/var/lib/seestar-portfwd/tunnel.lock` | the one-session lock |
| `SEESTAR_TUNNEL_STATE` | `/var/lib/seestar-portfwd/session.json` | the conId until it is released |
| `SEESTAR_TUNNEL_CONNECT_RETRIES` / `_RETRY_S` | `2` / `3` | restarts on the same session when the tunnel dies before it came up |
| `TUTK_CONNECT_TRIES` / `TUTK_CONNECT_PAUSE_S` | `1` / `3` | the tunnel binary's own `Connect_Ex` retries inside one process; every connect that worked (12/12, 2026-10-30) was a process's first try, a retry in the same process kept asking the P2P server that had not answered, so the supervisor's fresh-process redials do the retrying |
| `TUTK_TCP_RELAY_ONLY` | `0` | asks the SDK for its TCP relay mode before init (`IOTC_TCPRelayOnly_TurnOn`); `0` leaves the default |
| `DNSHOOK_ALL_ADDRS` | `0` | `1` hands the SDK every A record of the TUTK master instead of the first (it fared worse) |
| `DNSHOOK_PROBE` | `1` | the TUTK master name resolves round-robin to five servers and one of them never answers from some networks (every dial that drew it was a -60 after 77 s): the shim probes them in parallel with a TCP connect to `DNSHOOK_PROBE_PORT` (80) and hands the SDK the fastest one that answered; `0` hands it whatever the resolver listed first |
| `DNSHOOK_PROBE_MS` | `1500` | how long the probe waits for the servers to answer |
| `DNSHOOK_PREFER` | empty | comma-separated addresses to put first among the servers that answered the probe |
| `TUTK_LOG_DIR` | `/tmp/tutk` | where the SDK writes its own verbose log; after a refused `Connect_Ex` the tunnel prints the newest 300 lines of it (handshake chatter filtered, prefixed `[sdk]`) and keeps the full file of that try as `<name>.<try>` |
| `TUTK_LOG_LEVEL` | `0` | passed to the SDK's `*_Set_Log_Attr` (which this SDK build refuses); the `*_Set_Log_Path` fallback logs at full verbosity regardless |
| `TUTK_HOLD_SECONDS` | `86400` | how long the tunnel holds a session before exiting on its own |

`python3 src/supervisor.py --status` (and `--health`, which the image's
healthcheck runs) asks the supervisor that is already running. `--once` is the
old single-shot behaviour: connect now, hold until Ctrl-C, release on the way out.

## License

GPLv3 (see LICENSE). The libraries under `tunnel_libs/` are ThroughTek
binaries extracted from the Seestar app, bundled so the tunnel can run.

This copy is vendored inside the Astrocontroller project (`seestar-portfwd/`,
built by its `docker-compose.yml`) from <https://github.com/Phaeilo/seestar-portfwd>
— `main` at `e61512b` plus the `tutk-t-sdk` branch at `f895492` — with local
changes on top: the supervisor, the `TUTK_SUFFIX` build option, one tunnel
session instead of two, and exit code 3 when the session is lost. Keep LICENSE
and this note when copying it.

## Disclaimer

Not affiliated with, endorsed, or supported by ZWO. All product and company
names are the property of their respective owners and may be trademarks.
Developed with Claude and Anthropic models. Use at your own risk.

## Several telescopes in one container (`SEESTAR_TUNNEL_MULTI=1`)

With `SEESTAR_TUNNEL_MULTI=1` the entry point is the multi-tunnel manager (`src/manager.py`) instead of a single supervisor. It answers on `SEESTAR_TUNNEL_MANAGER_PORT` (4709):

| Request | Effect |
|---|---|
| `GET /health` | the manager is up (the image's healthcheck) |
| `GET /tunnels` | every slot: serial, account, running, pid, ports |
| `PUT /tunnels/<n>` `{"user","password","sn","country"}` | run slot *n*'s supervisor with this account (no-op if unchanged) |
| `DELETE /tunnels/<n>` | stop slot *n*: its supervisor releases the telescope first |

Slot *n* forwards each device port to local port + *n*×1000 (`TUTK_PORT_OFFSET` in `tunnel.c`), runs its control API on 4710 + *n*×1000 and keeps its session journal and source id in `/var/lib/seestar-portfwd/slot-<n>/`. Every device port is distinct modulo 1000, so slots never collide; 33 is the highest slot. Credentials live only in memory and in the supervisor's environment. Astrocontroller's profile hub sends them again every minute, so a restarted container gets its slots back by itself. If `SEESTAR_USER`/`SEESTAR_PASSWORD` are set on the container, slot 0 starts with them and with the original state paths, so a single-telescope setup works unchanged.
