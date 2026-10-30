#!/usr/bin/env python3
"""Supervise the Seestar Telescope Network tunnel: one session, on demand, always released.

The container's entry point. It owns exactly one `tunnel` process and with it exactly one P2P
session, because the scope serves one remote client at a time; the supervisor's job is that a
second one never exists and that the one we hold is always given back:

  * it connects only when asked (SEESTAR_TUNNEL_AUTOSTART=1, or POST /connect), so a container that
    merely runs leaves the scope to the official app;
  * one lock file + one child + one conId: while a session lives no other tunnel can start, and a
    connect while already connected is a lease refresh, never a second session;
  * a session that is lost, hangs, or never becomes ready is killed and reopened after a backoff,
    so a dropped P2P link heals by itself while the container stays up;
  * every teardown releases the telescope: SIGINT to the tunnel (stop the port mappings, abort and
    disconnect the SDK sessions) and then stop_p2p for the conId. On Disconnect, before every
    reconnect, on SIGTERM, and at start for the session a crashed run left behind (its conId stays
    in the state file until the backend confirms the release).

Control API on SEESTAR_TUNNEL_CONTROL_PORT (4710), JSON over HTTP:

  GET  /status       phase, device, session, attempts, last error, the tunnel's last output lines
  POST /connect      bring the tunnel up and keep it up; {"leaseS": n} holds it only while the
                     caller keeps asking, so a controller that vanishes releases the telescope
  POST /disconnect   tear the tunnel down, release the telescope, wait for the release ({"waitS": n})

A container can run for days without touching the scope. `--status` / `--health` read the API of the
supervisor that is already running (the image's healthcheck); `--once` connects, holds until Ctrl-C
and releases, which is what a person at a terminal wants — the same thing that
`SEESTAR_TUNNEL_AUTOSTART=1` does at container start.
"""

from __future__ import annotations

import fcntl
import getpass
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# seestar_status.py sits in the repository root: /work in the image, the checkout next to src/.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import seestar_status as cloud  # noqa: E402  (that path has to exist first)

QEMU = os.environ.get("QEMU", "qemu-arm")
SYSROOT = os.environ.get("TUNNEL_SYSROOT", "/bionic")
TUNNEL_BIN = os.environ.get("TUNNEL_BIN", "/work/tunnel")
DNSHOOK = os.environ.get("TUNNEL_DNSHOOK", "/work/libdnshook.so")

#: the tunnel binary prints "[*] tunnel ready" once its ports are forwarded
UP_BANNER = re.compile(r"tunnel ready|TUNNEL UP", re.I)
#: "[*] mode P2P (direct), remote 1.2.3.4", from IOTC_Session_Check_Ex
MODE_LINE = re.compile(r"mode\s+(.+?),\s*remote\s+(\S+)")
#: the credentials the tunnel binary reads, mapped from the online-link response
TUTK_FIELDS = {
    "TUTK_UID": "deviceUid",
    "TUTK_SDK_LICENSE": "sdkLicenseKey",
    "TUTK_USERNAME": "username",
    "TUTK_PASSWORD": "password",
}
#: the tunnel binary's own exit code for "the P2P session went away"
EXIT_SESSION_LOST = 3
#: a session that held this long earns a fresh backoff when it drops
STABLE_S = 300.0
#: how often the monitor re-checks while the tunnel has not proven itself yet; the watchdog's own
#: pace is only for liveness, waiting 10 s to notice "tunnel ready" would be silly
READY_POLL_S = 0.25

# stop_p2p has to get its answer inside Docker's stop_grace_period (20 s in Astrocontroller's
# compose); the API's own 45 s would let SIGKILL win the race and leave the scope OCCUPIED.
cloud.TIMEOUT = float(os.environ.get("SEESTAR_API_TIMEOUT_S", "12"))


class ConfigError(Exception):
    """Retrying cannot help: credentials, device selection, an API that rejects us."""


class TransientError(Exception):
    """Worth another attempt after a backoff: the API, the network, the SDK, the scope itself."""


def env_num(name: str, default: float, minimum: float = 0.0) -> float:
    try:
        value = float(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value >= minimum else default


class Config:
    """Everything the supervisor reads from the environment (documented in the README)."""

    def __init__(self) -> None:
        self.autostart = os.environ.get("SEESTAR_TUNNEL_AUTOSTART", "").strip().lower() in ("1", "true", "yes", "on")
        self.control_port = int(env_num("SEESTAR_TUNNEL_CONTROL_PORT", 4710))
        self.control_bind = os.environ.get("SEESTAR_TUNNEL_CONTROL_BIND", "0.0.0.0")
        self.control_token = os.environ.get("SEESTAR_TUNNEL_CONTROL_TOKEN", "")
        self.probe_port = int(env_num("SEESTAR_TUNNEL_PROBE_PORT", 4700))
        self.ready_timeout_s = env_num("SEESTAR_TUNNEL_READY_TIMEOUT_S", 180, 5)
        self.retry_min_s = env_num("SEESTAR_TUNNEL_RETRY_MIN_S", 5, 1)
        self.retry_max_s = env_num("SEESTAR_TUNNEL_RETRY_MAX_S", 120, 1)
        self.stop_grace_s = env_num("SEESTAR_TUNNEL_STOP_GRACE_S", 10, 1)
        self.watchdog_s = env_num("SEESTAR_TUNNEL_WATCHDOG_S", 10, 1)
        self.liveness_fails = int(env_num("SEESTAR_TUNNEL_LIVENESS_FAILS", 3, 1))
        #: how often to re-prove that the tunnel carries traffic once it is up. The binary checks the
        #: P2P session itself every second and exits when it goes away, so dialling the scope's
        #: control service any more often than this only competes with the traffic that matters
        self.liveness_s = max(self.watchdog_s, env_num("SEESTAR_TUNNEL_LIVENESS_S", 60, 5))
        self.leave_port_s = env_num("SEESTAR_TUNNEL_LEAVE_PORT_S", 5, 0)
        #: the tunnel died before it ever came up: try it again on the SAME session this many times
        #: before giving it back — putting a session back and asking for a new one is what turns a
        #: single Connect_Ex -42 into a string of them
        self.connect_retries = min(5, int(env_num("SEESTAR_TUNNEL_CONNECT_RETRIES", 2, 0)))
        self.connect_retry_s = min(60.0, env_num("SEESTAR_TUNNEL_CONNECT_RETRY_S", 3, 0))
        #: hold the session at most this long without a refresh from the controller; 0 = until Disconnect
        self.lease_s = env_num("SEESTAR_TUNNEL_LEASE_S", 0, 0)
        self.lock_path = os.environ.get("SEESTAR_TUNNEL_LOCK", "/var/lib/seestar-portfwd/tunnel.lock")
        self.state_path = os.environ.get("SEESTAR_TUNNEL_STATE", "/var/lib/seestar-portfwd/session.json")
        self.log_lines = int(env_num("SEESTAR_TUNNEL_LOG_LINES", 40, 5))


def log(text: str) -> None:
    print(f"[supervisor {time.strftime('%H:%M:%S')}] {text}", flush=True)


def tcp_open(port: int, timeout: float = 2.0) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout):
            return True
    except OSError:
        return False


def rpc_probe(port: int, timeout: float = 8.0) -> tuple[bool, str]:
    """One JSON-RPC round trip on the forwarded control port: proof the session carries traffic.

    A session the SDK has lost keeps its forwarded ports open and silent, so a bare connect proves
    nothing; `test_connection` is what the tunnel binary uses for its own self-test.
    """
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout)
    except OSError as exc:
        return False, f"127.0.0.1:{port}: {exc}"
    try:
        s.settimeout(timeout)
        s.sendall(b'{"id":1,"method":"test_connection"}\r\n')
        data = s.recv(256)
    except OSError as exc:
        return False, f"127.0.0.1:{port}: {exc}"
    finally:
        s.close()
    if not data:
        return False, f"127.0.0.1:{port}: no reply to test_connection"
    return True, data[:120].decode("utf-8", "replace").strip()


# ---- the account side, as the single-shot entry point did it ------------------------------------


def prompt(var: str, label: str, secret: bool = False) -> str:
    val = os.environ.get(var)
    if val:
        return val
    if not sys.stdin.isatty():
        raise ConfigError(
            f"{var} is not set and there is no interactive terminal: put it in .env or the "
            "container environment, or run the tunnel where it can prompt"
        )
    return getpass.getpass(f"{label}: ") if secret else input(f"{label}: ")


def device_label(d: dict) -> str:
    st = cloud.DEVICE_STATUS.get(d.get("deviceStatus"), "?")
    return f"{d.get('deviceModel', '?')} {d.get('deviceSn', '?')} [{st}]"


def pick_device(devices: list[dict]) -> str:
    sn = os.environ.get("SEESTAR_SN")
    if sn:
        return sn
    if not devices:
        raise ConfigError("this account has no telescopes")
    if len(devices) == 1:
        log(f"using the only device: {device_label(devices[0])}")
        return devices[0]["deviceSn"]
    if not sys.stdin.isatty():
        listing = ", ".join(device_label(d) for d in devices)
        raise ConfigError(f"the account has several devices; set SEESTAR_SN to one of: {listing}")
    print("Multiple telescopes on this account:", file=sys.stderr)
    for i, d in enumerate(devices, 1):
        print(f"  {i}) {device_label(d)}", file=sys.stderr)
    while True:
        try:
            idx = int(input(f"Select [1-{len(devices)}]: ")) - 1
        except ValueError:
            continue
        except (EOFError, KeyboardInterrupt):
            raise ConfigError("no device was selected") from None
        if 0 <= idx < len(devices):
            return devices[idx]["deviceSn"]


class Supervisor:
    """The one owner of the tunnel process and of the P2P session it carries."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.cond = threading.Condition()
        self.desired = "disconnected"
        self.phase = "idle"
        self.phase_since = time.time()
        self.attempts = 0
        self.reconnects = 0
        self.last_error: str | None = None
        self.last_exit: str | None = None
        self.device: dict[str, Any] | None = None
        self.session: dict[str, Any] | None = None
        self.child: subprocess.Popen | None = None
        self.banner = False
        self.mode: str | None = None
        self.port_open = False
        self.up_since = 0.0
        self.lease_s = cfg.lease_s
        self.lease_expires = 0.0
        self.backoff = cfg.retry_min_s
        self.stopping = False
        self.output: deque[str] = deque(maxlen=cfg.log_lines)
        self.token: str | None = None
        self.lock_fh: Any = None
        self.worker = threading.Thread(target=self._run, name="tunnel", daemon=True)

    # ---- asked for by the control API and by the signals ---------------------------------------

    def connect(self, lease_s: float | None = None) -> None:
        """Want the telescope. Idempotent: while a session lives this only renews the lease."""
        with self.cond:
            fresh = self.desired != "connected"
            self.lease_s = self.cfg.lease_s if lease_s is None else max(0.0, lease_s)
            self.lease_expires = time.time() + self.lease_s if self.lease_s else 0.0
            self.desired = "connected"
            if fresh:
                self.backoff = self.cfg.retry_min_s
                if self.phase == "failed":  # a refusal is retried when somebody asks again
                    self.last_error = None
                    self._set_phase("idle")
        log(f"connect requested ({'lease' if self.lease_s else 'held'} "
            f"{self.lease_s:.0f} s, " + ("already wanted" if not fresh else "start trying") + ")")

    def disconnect(self, wait_s: float) -> dict:
        """Release the telescope, waiting (bounded) until the backend has given it back."""
        with self.cond:
            wanted = self.desired == "connected" or self.phase != "idle"
            self.desired = "disconnected"
            self.lease_expires = 0.0
            self.cond.notify_all()
            deadline = time.time() + max(0.0, wait_s)
            while self.phase != "idle" and not self.stopping and time.time() < deadline:
                self.cond.wait(0.25)
        log("disconnect requested" + ("" if wanted else " (nothing was connected)"))
        return self.status()

    def begin_stop(self) -> None:
        with self.cond:
            self.stopping = True
            self.desired = "disconnected"
            self.lease_expires = 0.0
            self.cond.notify_all()

    def status(self) -> dict:
        with self.cond:
            session = None
            if self.session:
                con = str(self.session.get("con_id") or "")
                session = {
                    "sn": self.session.get("sn"),
                    "model": self.session.get("model"),
                    "conId": f"{con[:6]}..." if con else None,
                    "allocatedAt": self.session.get("at"),
                }
            return {
                "phase": self.phase,
                "desired": self.desired,
                "since": round(self.phase_since, 3),
                "autostart": self.cfg.autostart,
                "attempts": self.attempts,
                "reconnects": self.reconnects,
                "lastError": self.last_error,
                "lastExit": self.last_exit,
                "device": self.device,
                "session": session,
                "portOpen": self.port_open,
                "mode": self.mode,
                "upSince": self.up_since or None,
                "leaseSeconds": self.lease_s or None,
                "leaseExpiresAt": self.lease_expires or None,
                "backoffSeconds": round(self.backoff, 1),
                "stopping": self.stopping,
                "output": list(self.output),
            }

    # ---- the worker: the only thread that owns the session --------------------------------------

    def start(self) -> None:
        self.worker.start()

    def _run(self) -> None:
        """The one thread that owns the session, so it must never die with the scope held: whatever
        happens below, the tunnel is stopped, the session released and the lock let go."""
        try:
            self._supervise()
        except Exception:  # noqa: BLE001  (a bug in here must not leave the telescope occupied)
            log("the supervisor loop broke down:\n" + traceback.format_exc())
        finally:
            self._stop_child()
            with self.cond:
                session, self.session = self.session, None
                self.stopping = True  # nothing supervises any more: let Docker start a clean one
                self.cond.notify_all()
            if session:
                self._release(session)
            self._release_lock()

    def _supervise(self) -> None:
        self._reap_stale()
        while self._wait_until_wanted():
            came_up, retryable = self._attempt()
            with self.cond:
                wanted = self.desired == "connected" and not self.stopping
                if came_up:
                    self.reconnects += 1
                    if self.up_since and time.time() - self.up_since > STABLE_S:
                        self.backoff = self.cfg.retry_min_s  # it held a while: start over shortly
            if not wanted:
                continue
            if not retryable:
                with self.cond:
                    self._set_phase("failed")
                    self.desired = "disconnected"
                    log(f"not retrying until the next connect request: {self.last_error}")
                    while self.desired != "connected" and not self.stopping:
                        self.cond.wait(0.5)
                continue
            with self.cond:
                wait = self.backoff
                self.backoff = min(self.backoff * 2, self.cfg.retry_max_s)
                self._set_phase("backoff")
                log(f"reconnecting in {wait:.0f} s")
                deadline = time.time() + wait
                while time.time() < deadline and self.desired == "connected" and not self.stopping:
                    self.cond.wait(min(0.5, max(0.01, deadline - time.time())))

    def _wait_until_wanted(self) -> bool:
        """Block until something asks for the telescope; False when the supervisor should end."""
        with self.cond:
            while self.desired != "connected" and not self.stopping:
                self._set_phase("idle")
                self.cond.wait(0.5)
            return not self.stopping

    def _set_phase(self, phase: str) -> None:
        """Call with self.cond held."""
        if self.phase != phase:
            self.phase = phase
            self.phase_since = time.time()

    def _fail(self, message: str, retry: bool) -> None:
        with self.cond:
            self.last_error = message
        log(f"{'will retry: ' if retry else 'refused: '}{message}")

    # ---- one attempt: lock, allocate, run, watch, release ----------------------------------------

    def _attempt(self) -> tuple[bool, bool]:
        """Open one session and hold it. Returns (it came up, is another attempt worth it)."""
        with self.cond:
            self.attempts += 1
            self._set_phase("connecting")
            self.banner = False
            self.mode = None
            self.port_open = False
            self.up_since = 0.0
        if not self._acquire_lock():
            return False, True
        session: dict[str, Any] | None = None
        try:
            session = self._allocate()
            if session:
                came_up = False
                for go in range(self.cfg.connect_retries + 1):
                    self._spawn(session)
                    came_up = self._monitor(session)
                    with self.cond:
                        child = self.child
                    # a tunnel that DIED before coming up is worth restarting on this same session; a
                    # hung one goes back through the release and the backoff
                    died = child is not None and child.poll() is not None
                    with self.cond:
                        again = (not came_up and not self.stopping and self.desired == "connected"
                                and go < self.cfg.connect_retries and died)
                    if not again:
                        break
                    self._stop_child()
                    log(f"the tunnel did not come up; trying again on session "
                        f"{str(session['con_id'])[:8]}... ({self.cfg.connect_retries - go} left)")
                    with self.cond:
                        self.cond.wait(self.cfg.connect_retry_s)
                return came_up, True
            return False, False  # stopped on the way in: asked for, not a failure
        except ConfigError as exc:
            self._fail(f"config: {exc}", retry=False)
            return False, False
        except TransientError as exc:
            self._fail(str(exc), retry=True)
            return False, True
        except cloud.ApiError as exc:
            self.token = None  # a rejected token is worth a fresh login
            self._fail(f"the ZWO account API: {exc}", retry=True)
            return False, True
        except OSError as exc:
            self._fail(f"local: {exc}", retry=True)
            return False, True
        except Exception as exc:  # noqa: BLE001  (unexpected is worth a retry, never a dead worker)
            self._fail(f"unexpected {type(exc).__name__}: {exc}", retry=True)
            log(traceback.format_exc())
            return False, True
        finally:
            self._stop_child()
            if session:
                self._release(session)
            with self.cond:
                self.session = None
                self.port_open = False
            self._release_lock()

    def _acquire_lock(self) -> bool:
        """The one-session rule, held on the filesystem: whoever has this lock has the scope.

        Inside the container that is airtight; point SEESTAR_TUNNEL_LOCK at a folder mounted into
        every tunnel container you could run at once to extend it across containers.
        """
        if self.lock_fh:
            return True
        fh = None
        try:
            os.makedirs(os.path.dirname(self.cfg.lock_path) or ".", exist_ok=True)
            fh = open(self.cfg.lock_path, "a+")
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if fh:
                fh.close()
            self._fail(f"the session lock {self.cfg.lock_path} is not usable or is held by another "
                       f"tunnel: {exc}", retry=True)
            return False
        self.lock_fh = fh
        return True

    def _release_lock(self) -> None:
        if self.lock_fh is None:
            return
        try:
            fcntl.flock(self.lock_fh.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        self.lock_fh.close()
        self.lock_fh = None

    def _login(self) -> str:
        if not self.token:
            user = prompt("SEESTAR_USER", "ZWO account email")
            password = prompt("SEESTAR_PASSWORD", "Password", secret=True)
            log(f"logging in to ZWO Telescope Network as {user}")
            self.token = cloud.login(user, password)
        return self.token

    def _allocate(self) -> dict[str, Any] | None:
        """Ask for the scope's one P2P session, after giving back any session of ours still out there."""
        self._reap_stale()
        token = self._login()
        devices = cloud.list_devices(token)
        sn = pick_device(devices)
        dev = next((d for d in devices if d.get("deviceSn") == sn), None)
        if dev is None:
            raise ConfigError(f"device {sn} is not on this account")
        model = dev.get("deviceModel", "")
        state = cloud.DEVICE_STATUS.get(dev.get("deviceStatus"), "?")
        with self.cond:
            self.device = {"sn": sn, "model": model, "status": state}
        if dev.get("deviceStatus") not in (None, 1):
            # The account's status field is a hint, never a gate. It has been seen reporting SHOOTING
            # and OFFLINE for a scope that was powered up and connectable, and refusing to dial on the
            # strength of it leaves the telescope unreachable while it waits out a state that never
            # ends. online-link and Connect_Ex are the real answers; log the claim and connect anyway.
            log(f"{sn} reports {state}; connecting regardless")
        log(f"requesting the P2P session for {sn}...")
        status, body = cloud.online_link(token, sn, model, cloud.source_id())
        data = body.get("data") or {}
        if not all(data.get(k) for k in TUTK_FIELDS.values()) or not data.get("conId"):
            raise TransientError(f"online-link failed (HTTP {status}): {json.dumps(body)[:300]}")
        session = {
            "con_id": data["conId"],
            "sn": sn,
            "model": model,
            "at": round(time.time(), 3),
            "env": {name: str(data[key]) for name, key in TUTK_FIELDS.items()},
        }
        # Recorded before the tunnel starts: a crash here still leaves the conId to release.
        self._write_state(session)
        with self.cond:
            self.session = session
        log(f"session {str(session['con_id'])[:8]}... allocated for {sn}")
        return session

    def _spawn(self, session: dict[str, Any]) -> None:
        env = {**os.environ, **session["env"], "LD_LIBRARY_PATH": "/opt/lib"}
        argv = [QEMU, "-L", SYSROOT, "-E", f"LD_PRELOAD={DNSHOOK}", TUNNEL_BIN]
        log(f"opening the tunnel: {os.path.basename(argv[0])} {TUNNEL_BIN}")
        with self.cond:
            self.banner = False
        child = subprocess.Popen(  # noqa: S603  (fixed argv; the credentials go only in the env)
            argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
        )
        with self.cond:
            self.child = child
        threading.Thread(target=self._pump, args=(child,), name="tunnel-output", daemon=True).start()

    def _pump(self, child: subprocess.Popen) -> None:
        stream = child.stdout
        if stream is None:
            return
        for line in stream:
            line = line.rstrip()
            if not line:
                continue
            if UP_BANNER.search(line):
                with self.cond:
                    self.banner = True
            else:
                found = MODE_LINE.search(line)
                if found:
                    with self.cond:
                        self.mode = found.group(1).strip()
            with self.cond:
                self.output.append(line)
            log(f"tunnel: {line}")

    def _monitor(self, session: dict[str, Any]) -> bool:
        """Hold the session: ready within the deadline, then proven alive on every watchdog pass.

        Ends when the tunnel exits, when it stops proving itself, when the lease runs out, or when
        something asks to be disconnected. True when the tunnel was up at some point.
        """
        cfg = self.cfg
        deadline = time.time() + cfg.ready_timeout_s
        came_up = False
        misses = 0
        last_liveness = 0.0  # the first liveness pass after coming up waits liveness_s
        while True:
            with self.cond:
                child, wanted = self.child, self.desired == "connected"
                lease_over = bool(self.lease_s and self.lease_expires and time.time() > self.lease_expires)
            if self.stopping or not wanted:
                log("a disconnect was asked for: giving the telescope back")
                break
            if lease_over:
                with self.cond:
                    self.desired = "disconnected"
                    self.last_error = "no controller refreshed the lease, so the telescope was released"
                log("nobody is holding the session any more: releasing the telescope")
                break
            if child is None:
                break
            code = child.poll()
            if code is not None:
                reason = "was killed" if code < 0 else f"exit code {code}"
                note = " (the P2P session went away)" if code == EXIT_SESSION_LOST else ""
                with self.cond:
                    self.last_exit = f"{reason}{note}"
                log(f"the tunnel exited, {reason}{note}")
                break
            probe_now = not came_up or (time.time() - last_liveness) >= cfg.liveness_s
            if probe_now:
                last_liveness = time.time()
                ok, detail = rpc_probe(cfg.probe_port, timeout=5.0 if not came_up else 8.0)
                with self.cond:
                    self.port_open = ok
            if not came_up:
                with self.cond:
                    ready = self.banner and ok
                if ready:
                    came_up = True
                    last_liveness = time.time()
                    with self.cond:
                        self.up_since = time.time()
                        self.last_error = None
                        self._set_phase("connected")
                        if self.lease_s:  # the lease is time we hold the scope, not time since it was asked for
                            self.lease_expires = time.time() + self.lease_s
                    log(f"the tunnel is up for {session['sn']} ({detail})")
                elif time.time() > deadline:
                    self._fail(
                        f"the tunnel did not come up within {cfg.ready_timeout_s:.0f} s "
                        f"(banner {'seen' if self.banner else 'missing'}, control port: {detail})",
                        retry=True,
                    )
                    break
            else:
                if not probe_now:
                    pass  # nothing to ask this pass: the tunnel reports a dead session by itself
                elif ok:
                    misses = 0
                    with self.cond:
                        self.backoff = self.cfg.retry_min_s  # it answers: start the next backoff short
                else:
                    misses += 1
                    log(f"the tunnel stopped answering ({detail}), "
                        f"{max(cfg.liveness_fails - misses, 0)} pass(es) left before a reconnect")
                    if misses >= cfg.liveness_fails:
                        self._fail(f"the session went silent: {detail}", retry=True)
                        break
            with self.cond:
                # waiting for readiness is worth looking again soon; the watchdog's pace is for liveness
                wait = READY_POLL_S if not came_up else cfg.watchdog_s
                if came_up and self.lease_s and self.lease_expires:
                    wait = max(0.05, min(wait, self.lease_expires - time.time()))  # never hold past the lease
                self.cond.wait(wait)
        return came_up

    def _stop_child(self) -> None:
        with self.cond:
            child, self.child = self.child, None
        if child is None:
            return
        if child.poll() is None:
            # Ctrl-C for the tunnel: it stops the port mappings, then aborts and disconnects.
            log("stopping the tunnel (SIGINT: stop mappings, abort and disconnect the session)")
            try:
                child.send_signal(signal.SIGINT)
            except OSError:
                pass
            try:
                child.wait(self.cfg.stop_grace_s)
            except subprocess.TimeoutExpired:
                log("the tunnel ignored SIGINT; killing it (the session is still released below)")
                child.kill()
                try:
                    child.wait(5)
                except subprocess.TimeoutExpired:
                    pass
        # A listener of the old process that still answers would make the next attempt look ready.
        deadline = time.time() + self.cfg.leave_port_s
        while tcp_open(self.cfg.probe_port) and time.time() < deadline:
            time.sleep(0.25)

    def _release(self, session: dict[str, Any]) -> None:
        """Give the scope back. Closing our sockets is not enough: the backend has to end the session."""
        con_id = str(session.get("con_id") or "")
        if not con_id:
            self._clear_state(session)
            return
        label = con_id[:8]
        with self.cond:
            self._set_phase("releasing")
        for attempt in (1, 2):
            try:
                status, body = cloud.stop_p2p(self.token or self._login(), con_id)
            except Exception as exc:  # noqa: BLE001  (anything the backend does is a failed release: retry, keep the state file)
                log(f"could not release session {label}... (attempt {attempt}): {exc}")
                self.token = None if attempt == 1 else self.token
                time.sleep(0.5 * attempt)
                continue
            if status == 401:
                log(f"the backend rejected the token while releasing {label}...")
                self.token = None
                continue
            if status == 200:
                log(f"session {label}... released: the scope is free for another client")
                self._clear_state(session)
                return
            if status == 400 and isinstance(body, dict) and body.get("code") == 100002:
                # "Parameter error" is what this backend answers for a conId it no longer knows:
                # the SDK's own teardown ended it, which is the outcome we were asking for.
                log(f"session {label}... was already gone: the scope is free for another client")
                self._clear_state(session)
                return
            log(f"the backend would not release {label}... (HTTP {status}): {json.dumps(body)[:200]}")
            break
        # Left in the state file so the next start retries; the scope would otherwise sit OCCUPIED.
        log(f"the scope may stay occupied until the backend times session {label}... out")

    # ---- the session a crashed run may have left behind -------------------------------------------

    def _write_state(self, session: dict[str, Any]) -> None:
        try:
            os.makedirs(os.path.dirname(self.cfg.state_path) or ".", exist_ok=True)
            tmp = self.cfg.state_path + ".tmp"
            with open(tmp, "w") as fh:
                record = {k: session.get(k) for k in ("con_id", "sn", "model", "at")}
                # the controller's wish is stored with the session: an image upgrade, a host reboot or
                # Docker's restart policy must not leave the telescope idle while something still wants
                # it. The release paths delete this file, so only a never-released session is restored.
                record["desired"] = self.desired
                record["leaseS"] = self.lease_s
                json.dump(record, fh)
            os.replace(tmp, self.cfg.state_path)
        except OSError as exc:
            log(f"could not record the session in {self.cfg.state_path}: {exc}")

    def _clear_state(self, session: dict[str, Any]) -> None:
        try:
            with open(self.cfg.state_path) as fh:
                held = json.load(fh).get("con_id")
            if str(held) == str(session.get("con_id")):
                os.remove(self.cfg.state_path)
        except (OSError, ValueError):
            pass

    def _reap_stale(self) -> None:
        """Release what a crashed or killed run left allocated before opening another session."""
        try:
            with open(self.cfg.state_path) as fh:
                stale = json.load(fh)
        except FileNotFoundError:
            return
        except (OSError, ValueError) as exc:
            log(f"the session state in {self.cfg.state_path} is unreadable ({exc}); leaving it")
            return
        con_id = str(stale.get("con_id") or "")
        if con_id:
            log(f"the previous run left session {con_id[:8]}... allocated; releasing it first")
            self._release({"con_id": con_id})

    def restore_desired(self) -> bool:
        """True when a controller was holding this connection the last time the container ran."""
        try:
            with open(self.cfg.state_path) as fh:
                return json.load(fh).get("desired") == "connected"
        except (OSError, ValueError):
            return False

    # ---- the control API ---------------------------------------------------------------------

    def serve(self) -> ThreadingHTTPServer | None:
        if self.cfg.control_port <= 0:
            log("SEESTAR_TUNNEL_CONTROL_PORT=0: no control API, the tunnel only follows autostart")
            return None
        supervisor = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            server_version = "seestar-portfwd-supervisor/1.0"

            def _json(self, code: int, payload: dict) -> None:
                body = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def _authorized(self) -> bool:
                want = supervisor.cfg.control_token
                if not want:
                    return True
                given = self.headers.get("Authorization", "")
                return given in (f"Bearer {want}", want)

            def _denied(self) -> bool:
                if self._authorized():
                    return False
                self._json(401, {"error": "the supervisor wants SEESTAR_TUNNEL_CONTROL_TOKEN "
                                          "as Authorization: Bearer <token>"})
                return True

            def _body(self) -> dict:
                try:
                    length = min(int(self.headers.get("Content-Length") or 0), 4096)
                except ValueError:
                    return {}
                if not length:
                    return {}
                try:
                    parsed = json.loads(self.rfile.read(length) or b"{}")
                except ValueError:
                    return {}
                return parsed if isinstance(parsed, dict) else {}

            def _route(self) -> str:
                return self.path.split("?")[0]

            def do_GET(self) -> None:  # noqa: N802  (http.server's spelling)
                if self._route() != "/status":
                    self._json(404, {"error": f"no such route: {self.path}"})
                    return
                if not self._denied():
                    self._json(200, supervisor.status())

            def do_POST(self) -> None:  # noqa: N802
                route = self._route()
                if route not in ("/connect", "/disconnect"):
                    self._json(404, {"error": f"no such route: {self.path}"})
                    return
                if self._denied():
                    return
                body = self._body()
                if route == "/connect":
                    raw = body.get("leaseS")
                    try:
                        lease = None if raw is None else float(raw)
                    except (TypeError, ValueError):
                        self._json(400, {"error": "leaseS has to be a number of seconds"})
                        return
                    supervisor.connect(lease)
                    self._json(202, supervisor.status())
                    return
                try:
                    wait = min(max(float(body.get("waitS", 15)), 0.0), 30.0)
                except (TypeError, ValueError):
                    wait = 15.0
                status = supervisor.disconnect(wait)
                released = status["phase"] == "idle" and status["session"] is None
                self._json(200 if released else 409, {**status, "released": released})

            def log_message(self, fmt: str, *args: Any) -> None:
                pass  # the controller polls /status every few seconds: keep its log for the tunnel

        try:
            server = ThreadingHTTPServer((self.cfg.control_bind, self.cfg.control_port), Handler)
        except OSError as exc:
            log(f"the control API could not bind {self.cfg.control_bind}:{self.cfg.control_port} ({exc}): "
                "Connect and Disconnect from Astrocontroller will not reach this container")
            return None
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, name="control", daemon=True).start()
        log(f"the control API listens on {self.cfg.control_bind}:{self.cfg.control_port}"
            + (" (Bearer token required)" if self.cfg.control_token else ""))
        return server


# ---- entry point ---------------------------------------------------------------------------------


def cli(cfg: Config, mode: str) -> int:
    """--status / --health: ask the supervisor that is already running (the image's healthcheck)."""
    if cfg.control_port <= 0:  # no API to ask: the tunnel follows autostart alone, so do not call it sick
        print("the control API is disabled (SEESTAR_TUNNEL_CONTROL_PORT=0): there is nothing to report")
        return 0 if mode == "health" else 1
    host, port = "127.0.0.1", cfg.control_port
    headers = {"Host": f"{host}:{port}", "Connection": "close"}
    if cfg.control_token:
        headers["Authorization"] = f"Bearer {cfg.control_token}"
    request = "GET /status HTTP/1.1\r\n"
    for name, value in headers.items():
        request += f"{name}: {value}\r\n"
    request += "\r\n"
    try:
        with socket.create_connection((host, port), 3) as s:
            s.settimeout(5)
            s.sendall(request.encode())
            raw = b""
            while len(raw) < 65536:
                chunk = s.recv(8192)
                if not chunk:
                    break
                raw += chunk
    except OSError as exc:
        print(f"the supervisor's control API on port {port} is not answering: {exc}", file=sys.stderr)
        return 1
    _, _, body = raw.decode("utf-8", "replace").partition("\r\n\r\n")
    try:
        status = json.loads(body)
    except ValueError:
        print(f"the supervisor answered nonsense: {raw[:200]!r}", file=sys.stderr)
        return 1
    if mode == "status":
        print(json.dumps(status, indent=2))
        return 0
    print(f"supervisor {status.get('phase')} (wants {status.get('desired')}, "
          f"{status.get('attempts')} attempt(s)): {status.get('lastError') or 'no error'}")
    return 0 if status.get("phase") != "failed" else 1


def main() -> int:
    cfg = Config()
    argv = sys.argv[1:]
    if argv and argv[0] in ("--status", "--health"):
        return cli(cfg, argv[0].lstrip("-"))

    supervisor = Supervisor(cfg)
    supervisor.serve()
    supervisor.start()
    if argv and argv[0] == "--once":  # what a person at a terminal wants: connect, hold, release
        supervisor.connect(0.0)
    elif supervisor.restore_desired():
        log("the controller was holding this connection when the container last ran: taking it back")
        supervisor.connect()
    elif cfg.autostart:
        log("SEESTAR_TUNNEL_AUTOSTART: connecting now")
        supervisor.connect()

    stopping = threading.Event()

    def on_signal(signo: int, _frame: Any) -> None:
        if stopping.is_set():
            return
        stopping.set()
        log(f"{signal.Signals(signo).name}: releasing the telescope")
        supervisor.begin_stop()

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    while not stopping.wait(0.5):
        pass
    supervisor.worker.join(timeout=cfg.stop_grace_s + 3 * cloud.TIMEOUT + 5)
    return 0


if __name__ == "__main__":
    sys.exit(main())
