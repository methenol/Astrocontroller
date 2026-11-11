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
  * a session the scope's rendezvous refuses (Connect_Ex -42/-60) is kept and dialled again: the
    scope's P2P agent takes minutes to answer after a session ended, and handing the session back
    to ask for another one only restarts that wait. One session per connect request, as the app;
  * the backend hears about every session the way it hears from the official app: p2pConnectStart
    once online-link has handed the session out, p2pConnectSucceed when the tunnel is up,
    p2pConnectFailed (with the SDK's code) for a session given back without coming up, and
    p2pConnectCancel for one abandoned because a disconnect was asked for first. The app sends
    these on every connect; a backend that tracks the scope's one session by them must never be
    left waiting for ours;
  * every teardown releases the telescope: SIGINT to the tunnel (stop the port mappings, abort and
    disconnect the SDK sessions, which is all the official app ever does), then the account is
    watched until the scope reports itself free again; stop_p2p for the conId only when it does
    not, or for a session that never came up. On Disconnect, before every reconnect, on SIGTERM,
    and at start for the session a crashed run left behind (its conId stays in the state file until
    the backend confirms the release).

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
from typing import Any, Callable

# seestar_status.py sits in the repository root: /work in the image, the checkout next to src/.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import seestar_status as cloud  # noqa: E402  (that path has to exist first)

QEMU = os.environ.get("QEMU", "qemu-arm")
SYSROOT = os.environ.get("TUNNEL_SYSROOT", "/bionic")
TUNNEL_BIN = os.environ.get("TUNNEL_BIN", "/work/tunnel")
DNSHOOK = os.environ.get("TUNNEL_DNSHOOK", "/work/libdnshook.so")

#: the tunnel binary prints "[*] tunnel ready" once its ports are forwarded
UP_BANNER = re.compile(r"tunnel ready|TUNNEL UP", re.I)
#: the tunnel's own report of a Connect_Ex refusal, with the SDK's code
REFUSAL_LINE = re.compile(r"Connect_Ex failed: (-?\d+)")
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
        #: long enough for the child to work through its own Connect_Ex retries (TUTK_CONNECT_TRIES,
        #: about a minute each): the -42/-60 right after a session ended is cured by trying again on
        #: the same session, so cutting that short turns one refusal into a storm of them. A refusal
        #: the child has given up on is noticed from its output and cut short instead.
        self.ready_timeout_s = env_num("SEESTAR_TUNNEL_READY_TIMEOUT_S", 240, 5)
        self.retry_min_s = env_num("SEESTAR_TUNNEL_RETRY_MIN_S", 5, 1)
        self.retry_max_s = env_num("SEESTAR_TUNNEL_RETRY_MAX_S", 120, 1)
        #: long enough for a child blocked inside Connect_Ex to come back out of it and abort the
        #: session on its way out; SIGKILL before that leaves the scope occupied by a session of ours
        self.stop_grace_s = env_num("SEESTAR_TUNNEL_STOP_GRACE_S", 75, 1)
        self.watchdog_s = env_num("SEESTAR_TUNNEL_WATCHDOG_S", 10, 1)
        self.liveness_fails = int(env_num("SEESTAR_TUNNEL_LIVENESS_FAILS", 3, 1))
        #: how often to re-prove that the tunnel carries traffic once it is up. The binary checks the
        #: P2P session itself every second and exits when it goes away, so dialling the scope's
        #: control service any more often than this only competes with the traffic that matters
        self.liveness_s = max(self.watchdog_s, env_num("SEESTAR_TUNNEL_LIVENESS_S", 60, 5))
        #: how long one liveness probe waits for the control service's reply once the tunnel is up.
        #: The scope's control channel stalls now and then while the P2P session itself holds (the
        #: SDK's own check, every second in the tunnel binary, still passes and the other session
        #: keeps carrying pictures); coming out of such a stall a fresh connection took 14 s to be
        #: answered (2026-11-11), so a short window reads a slow answer as a dead session
        self.probe_timeout_s = env_num("SEESTAR_TUNNEL_PROBE_TIMEOUT_S", 20, 1)
        #: while the control port does not answer, look again this often so a recovery is seen
        self.silent_probe_s = max(self.watchdog_s, env_num("SEESTAR_TUNNEL_SILENT_PROBE_S", 30, 1))
        #: reconnect only after the control port has gone this long without one answer (and at
        #: least liveness_fails probes in a row missed). A session the SDK has really lost is ended
        #: by the tunnel binary itself (exit 3) within its 30 s alive timeout; this is the backstop
        #: for one that stays nominally alive but carries nothing. It is sized against what a
        #: reconnect costs: a fresh session is refused (Connect_Ex -42) for 3 to 7 minutes and more
        #: (2026-11-11), while the stalls seen recovered by themselves within about 2 minutes, so
        #: cutting one short turned a 2-minute hiccup into a 5-minute-plus outage
        self.silent_s = env_num("SEESTAR_TUNNEL_SILENT_S", 300, 0)
        #: while connected, re-read the scope's status (ONLINE/SHOOTING/OCCUPIED) from the account this
        #: often so /status does not keep the value seen at connect time; 0 = only at connect/release
        self.status_refresh_s = env_num("SEESTAR_TUNNEL_STATUS_REFRESH_S", 120, 0)
        self.leave_port_s = env_num("SEESTAR_TUNNEL_LEAVE_PORT_S", 5, 0)
        #: the tunnel died before it ever came up (the scope's rendezvous refused it with -42/-60,
        #: typically): try it again on the SAME session, this many times and for at most
        #: session_budget_s since the session was allocated, before giving it back. Putting a session
        #: back and asking for a new one is what turns a single Connect_Ex -42 into a string of them:
        #: the scope's P2P agent needs minutes to answer again after a session ended, and the wait
        #: starts over with every new session.
        self.connect_retries = min(60, int(env_num("SEESTAR_TUNNEL_CONNECT_RETRIES", 20, 0)))
        self.connect_retry_s = min(60.0, env_num("SEESTAR_TUNNEL_CONNECT_RETRY_S", 3, 0))
        self.session_budget_s = env_num("SEESTAR_TUNNEL_SESSION_BUDGET_S", 900, 0)
        #: after the SDK disconnect, how long to watch the account for the scope reporting itself free
        #: (ONLINE) before stop_p2p is sent for the session; 0 = always send it
        self.release_wait_s = env_num("SEESTAR_TUNNEL_RELEASE_WAIT_S", 20, 0)
        #: hold the session at most this long without a refresh from the controller; 0 = until Disconnect
        self.lease_s = env_num("SEESTAR_TUNNEL_LEASE_S", 0, 0)
        self.lock_path = os.environ.get("SEESTAR_TUNNEL_LOCK", "/var/lib/seestar-portfwd/tunnel.lock")
        self.state_path = os.environ.get("SEESTAR_TUNNEL_STATE", "/var/lib/seestar-portfwd/session.json")
        #: the id the backend keys sessions by; it lives on the state volume, not in the image, so it
        #: survives rebuilds and a new allocation supersedes the session the last container held
        self.src_id_path = os.environ.get("SEESTAR_TUNNEL_SRC_ID", "/var/lib/seestar-portfwd/srcid")
        self.log_lines = int(env_num("SEESTAR_TUNNEL_LOG_LINES", 40, 5))


def log(text: str) -> None:
    print(f"[supervisor {time.strftime('%H:%M:%S')}] {text}", flush=True)


def tcp_open(port: int, timeout: float = 2.0) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout):
            return True
    except OSError:
        return False


def rpc_probe(port: int, timeout: float = 8.0, abandon: Callable[[], bool] | None = None) -> tuple[bool, str]:
    """One JSON-RPC round trip on the forwarded control port: proof the session carries traffic.

    A session the SDK has lost keeps its forwarded ports open and silent, so a bare connect proves
    nothing; `test_connection` is what the tunnel binary uses for its own self-test.

    `abandon` is asked about once a second while the reply is awaited: a long wait must not hold
    up a Disconnect or hide a tunnel that has exited.
    """
    try:
        s = socket.create_connection(("127.0.0.1", port), min(timeout, 5.0))
    except OSError as exc:
        return False, f"127.0.0.1:{port}: {exc}"
    deadline = time.time() + timeout
    data = b""
    try:
        s.sendall(b'{"id":1,"method":"test_connection"}\r\n')
        while True:
            left = deadline - time.time()
            if left <= 0:
                return False, f"127.0.0.1:{port}: no reply to test_connection in {timeout:.0f} s"
            s.settimeout(min(1.0, left))
            try:
                data = s.recv(256)
                break
            except socket.timeout:
                if abandon is not None and abandon():
                    return False, f"127.0.0.1:{port}: probe abandoned"
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
        #: which dial of the current session is running (1 = the first)
        self.session_attempt = 0
        #: the last Connect_Ex result the tunnel printed for the current session, for the report
        self.connect_code: int | None = None
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
        # the controller renews its lease every 30 s: that is noise once the wish is known
        if fresh:
            log(f"connect requested ({'lease' if self.lease_s else 'held'} {self.lease_s:.0f} s, start trying)")

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
                "sessionAttempt": self.session_attempt,
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
        came_up = False
        try:
            session = self._allocate()
            if session:
                for go in range(self.cfg.connect_retries + 1):
                    with self.cond:
                        self.session_attempt = go + 1
                    self._spawn(session)
                    came_up = self._monitor(session)
                    with self.cond:
                        child, refused = self.child, self.refused
                    # A child that printed its last refusal exits right after it: give it the moment
                    # rather than killing it, so its SDK teardown runs in the app's order.
                    if child is not None and refused and child.poll() is None:
                        try:
                            child.wait(5)
                        except subprocess.TimeoutExpired:
                            pass
                    # a tunnel that DIED before coming up is worth dialling again on this same session,
                    # within the session's budget; a hung one goes back through the release and the backoff
                    died = child is not None and child.poll() is not None
                    age = time.time() - float(session.get("at") or time.time())
                    with self.cond:
                        again = (not came_up and not self.stopping and self.desired == "connected"
                                and go < self.cfg.connect_retries and died
                                and age < self.cfg.session_budget_s)
                    if not again:
                        if not came_up and died and not self.stopping and self.desired == "connected":
                            log(f"giving session {str(session['con_id'])[:8]}... back after "
                                f"{go + 1} dial(s) over {age:.0f} s: asking for another one")
                        break
                    self._stop_child()
                    log(f"the tunnel did not come up on session {str(session['con_id'])[:8]}... "
                        f"(dial {go + 1}, {age:.0f} s since it was allocated): dialling it again in "
                        f"{self.cfg.connect_retry_s:.0f} s, {self.cfg.connect_retries - go} left")
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
                if not session.get("came_up"):
                    # the app's one report per session that never came up: Cancel when the user
                    # gave up on it first, Failed (with the SDK's answer) when the scope did
                    with self.cond:
                        cancelled = self.stopping or self.desired != "connected"
                        code = self.connect_code
                    self._report(session, cloud.REPORT_CANCEL if cancelled else cloud.REPORT_FAILED,
                                 None if cancelled else code)
                self._release(session)
            with self.cond:
                self.session = None
                self.session_attempt = 0
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

    def _source_id(self) -> str:
        """The client id the backend keys sessions by.

        The backend keeps one active session per device/srcId, so allocating again under the same id
        supersedes the session a previous run left behind. The upstream id is derived from the host's
        machine id, which a container either lacks or rebuilds: that hands out a fresh id per
        allocation, every session then sits orphaned holding the scope, and each later Connect_Ex
        answers -42 until the backend times it out (the storm). So it is generated once and kept on
        the state volume beside the session journal.
        """
        try:
            with open(self.cfg.src_id_path) as fh:
                sid = fh.read().strip()
            if sid:
                return sid
        except OSError:
            pass
        sid = cloud.source_id()
        try:
            os.makedirs(os.path.dirname(self.cfg.src_id_path) or ".", exist_ok=True)
            tmp = self.cfg.src_id_path + ".tmp"
            with open(tmp, "w") as fh:
                fh.write(f"{sid}\n")
            os.replace(tmp, self.cfg.src_id_path)
            log(f"this installation's session id is {sid[:8]}... (kept in {self.cfg.src_id_path})")
        except OSError as exc:
            log(f"could not persist the session id, using a fresh one: {exc}")
        return sid

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
        status, body = cloud.online_link(token, sn, model, self._source_id())
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
        p2p = data.get("p2pStatus")
        log(f"session {str(session['con_id'])[:8]}... allocated for {sn} "
            f"(device uid {str(data.get('deviceUid'))[:4]}..., p2pStatus {p2p})")
        self._report(session, cloud.REPORT_START)
        return session

    def _report(self, session: dict[str, Any], event: str, code: int | None = None) -> None:
        """Tell the backend how the session is going, as the official app does (device-log/report).

        Never fatal: the report is bookkeeping for the backend, the tunnel is the work. It is sent
        on the worker thread, in order, so Start always precedes Succeed/Failed/Cancel."""
        con_id = str(session.get("con_id") or "")
        if not con_id:
            return
        label = con_id[:8]
        try:
            status, body = cloud.report_connect_result(
                self.token or self._login(), str(session.get("sn") or ""), str(session.get("model") or ""),
                con_id, event, code)
        except Exception as exc:  # noqa: BLE001  (a report that cannot be delivered changes nothing here)
            log(f"could not report {event} for session {label}...: {exc}")
            return
        # this backend answers {"code": 200, "msg": "OK", "data": {"result": true}}
        taken = status == 200 and (not isinstance(body, dict) or body.get("code") in (0, 200, None))
        if taken:
            log(f"reported {event} for session {label}..." + (f" (code {code})" if code is not None else ""))
        else:
            log(f"the backend did not take the {event} report for session {label}... "
                f"(HTTP {status}): {json.dumps(body)[:200]}")

    #: set when the child reports a Connect_Ex refusal it has given up on - the ones it is still
    #: working through print "(retrying)"; waiting on a child that has finished trying buys nothing
    refused: bool = False

    def _spawn(self, session: dict[str, Any]) -> None:
        env = {**os.environ, **session["env"], "LD_LIBRARY_PATH": "/opt/lib"}
        argv = [QEMU, "-L", SYSROOT, "-E", f"LD_PRELOAD={DNSHOOK}", TUNNEL_BIN]
        log(f"opening the tunnel: {os.path.basename(argv[0])} {TUNNEL_BIN}")
        with self.cond:
            self.banner = False
            self.refused = False
            self.connect_code = None
        child = subprocess.Popen(  # noqa: S603  (fixed argv; the credentials go only in the env)
            argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
            errors="replace",  # the SDK's output is not always UTF-8; a bad byte must not kill the reader
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
            # "... (retrying)" is the child working through the retries that the -42/-60 after a
            # session ending actually need; only a refusal it has given up on is worth cutting short
            refused = "Connect_Ex failed" in line and "retrying" not in line
            answer = REFUSAL_LINE.search(line)
            with self.cond:
                self.output.append(line)
                if answer:
                    self.connect_code = int(answer.group(1))
                if refused:
                    self.refused = True
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
        #: when the control port was first found not answering in the current stall; None = it answers
        silent_since: float | None = None
        last_liveness = 0.0  # the first liveness pass after coming up waits liveness_s
        last_status = 0.0  # the account's view of the scope is re-read every status_refresh_s
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
            with self.cond:
                refused = self.refused
            if refused and not came_up:
                self._fail(
                    "the scope's P2P agent did not answer the rendezvous (Connect_Ex -42/-60): it takes "
                    "minutes to come back after a session ended; dialling the same session again",
                    retry=True,
                )
                break
            code = child.poll()
            if code is not None:
                reason = "was killed" if code < 0 else f"exit code {code}"
                note = " (the P2P session went away)" if code == EXIT_SESSION_LOST else ""
                with self.cond:
                    self.last_exit = f"{reason}{note}"
                log(f"the tunnel exited, {reason}{note}")
                break
            every = cfg.silent_probe_s if silent_since is not None else cfg.liveness_s
            probe_now = not came_up or (time.time() - last_liveness) >= every
            if probe_now:
                last_liveness = time.time()
                ok, detail = rpc_probe(cfg.probe_port, timeout=5.0 if not came_up else cfg.probe_timeout_s,
                                       abandon=self._probe_moot)
                if self._probe_moot():
                    continue  # the top of the loop handles the disconnect or the exit
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
                    if not session.get("came_up"):
                        session["came_up"] = True  # the app reports Succeed as soon as it is up
                        self._report(session, cloud.REPORT_SUCCEED)
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
                    if silent_since is not None:
                        log(f"the tunnel answers again after {time.time() - silent_since:.0f} s of silence: "
                            "the session held, no reconnect needed")
                    misses = 0
                    silent_since = None
                    with self.cond:
                        self.backoff = self.cfg.retry_min_s  # it answers: start the next backoff short
                    if cfg.status_refresh_s and time.time() - last_status >= cfg.status_refresh_s:
                        last_status = time.time()
                        self._scope_free()  # refreshes self.device["status"] as a side effect
                else:
                    misses += 1
                    if silent_since is None:
                        silent_since = last_liveness  # when the probe that found it silent started
                    silent = time.time() - silent_since
                    if misses >= cfg.liveness_fails and silent >= cfg.silent_s:
                        log(f"the tunnel stopped answering ({detail}): silent for {silent:.0f} s, "
                            f"{misses} probe(s) in a row; reconnecting")
                        self._fail(f"the session went silent for {silent:.0f} s: {detail}", retry=True)
                        break
                    log(f"the tunnel stopped answering ({detail}): silent for {silent:.0f} s; the P2P "
                        f"session is still held, so it is waited out (reconnect after "
                        f"{cfg.silent_s:.0f} s and {cfg.liveness_fails} misses in a row)")
            with self.cond:
                # waiting for readiness is worth looking again soon; the watchdog's pace is for liveness
                wait = READY_POLL_S if not came_up else cfg.watchdog_s
                if came_up and self.lease_s and self.lease_expires:
                    wait = max(0.05, min(wait, self.lease_expires - time.time()))  # never hold past the lease
                self.cond.wait(wait)
        return came_up

    def _probe_moot(self) -> bool:
        """A probe's answer no longer matters: a disconnect was asked for, or the tunnel exited."""
        with self.cond:
            child = self.child
            if self.stopping or self.desired != "connected" or child is None:
                return True
        return child.poll() is not None

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

    def _scope_free(self) -> bool | None:
        """What the account says about the scope right now: True when it is not OCCUPIED, None when
        the account could not be asked."""
        try:
            devices = cloud.list_devices(self.token or self._login())
        except Exception as exc:  # noqa: BLE001  (the account is only a witness here)
            log(f"could not read the scope's status from the account: {exc}")
            return None
        sn = str((self.session or {}).get("sn") or os.environ.get("SEESTAR_SN") or "")
        dev = next((d for d in devices if not sn or d.get("deviceSn") == sn), None)
        if dev is None:
            return None
        state = cloud.DEVICE_STATUS.get(dev.get("deviceStatus"), "?")
        with self.cond:
            if self.device:
                self.device = {**self.device, "status": state}
        return dev.get("deviceStatus") != 4

    def _release(self, session: dict[str, Any]) -> None:
        """Give the scope back.

        The SDK disconnect the tunnel ran on its way out is what the official app does, and the scope
        reports itself free (ONLINE) to the backend on its own once the session is gone. The backend's
        stop_p2p is the fallback: for a session that never came up (the scope never saw it end) and
        for one the account still shows as OCCUPIED after the SDK teardown. It is not sent for the
        sake of it: a stop the backend carries out is followed by minutes of Connect_Ex -42 for the
        next session.
        """
        con_id = str(session.get("con_id") or "")
        if not con_id:
            self._clear_state(session)
            return
        label = con_id[:8]
        with self.cond:
            self._set_phase("releasing")
        if session.get("came_up") and self.cfg.release_wait_s > 0:
            started = time.time()
            deadline = started + self.cfg.release_wait_s
            while True:
                free = self._scope_free()
                if free:
                    log(f"session {label}... ended by the SDK disconnect: the scope reports itself free "
                        f"after {time.time() - started:.0f} s, no stop needed")
                    self._clear_state(session)
                    return
                if free is None or time.time() >= deadline:
                    break
                time.sleep(2.0)
            log(f"the scope still reports OCCUPIED {time.time() - started:.0f} s after the SDK "
                f"disconnect: asking the backend to stop session {label}...")
        for attempt in (1, 2, 3, 4):
            try:
                status, body = cloud.stop_p2p(self.token or self._login(), con_id)
            except Exception as exc:  # noqa: BLE001  (anything the backend does is a failed release: retry, keep the state file)
                log(f"could not release session {label}... (attempt {attempt}): {exc}")
                self.token = None if attempt == 1 else self.token
                time.sleep(1.5 * attempt)  # a session the backend is still chewing on frees itself shortly
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
            self._note_held(str(session.get("con_id") or ""))
        except OSError as exc:
            log(f"could not record the session in {self.cfg.state_path}: {exc}")

    def _clear_state(self, session: dict[str, Any]) -> None:
        try:
            with open(self.cfg.state_path) as fh:
                held = json.load(fh).get("con_id")
            if str(held) == str(session.get("con_id")):
                os.remove(self.cfg.state_path)
            self._forget_held(str(session.get("con_id") or ""))
        except (OSError, ValueError):
            pass

    # ---- every session we were ever given -------------------------------------------------------
    #
    # The state file holds the current session only. A run that was killed, segfaulted or restarted
    # can leave older ones allocated on the backend, and each of those keeps the scope occupied:
    # every later Connect_Ex answers -42 until the backend times them out (up to a day). So the
    # conIds are journalled, and everything in the journal goes back before a new session is asked
    # for. That is what "release the telescope of sessions" means in practice.

    def _held_path(self) -> str:
        return self.cfg.state_path + ".held"

    def _held_list(self) -> list[str]:
        try:
            with open(self._held_path()) as fh:
                return [line.strip() for line in fh if line.strip()]
        except OSError:
            return []

    def _write_held(self, con_ids: list[str]) -> None:
        try:
            if not con_ids:
                try:
                    os.remove(self._held_path())
                except FileNotFoundError:
                    pass
                return
            tmp = self._held_path() + ".tmp"
            with open(tmp, "w") as fh:
                fh.write("\n".join(con_ids[-20:]) + "\n")
            os.replace(tmp, self._held_path())
        except OSError as exc:
            log(f"could not write the held-session journal: {exc}")

    def _note_held(self, con_id: str) -> None:
        if not con_id:
            return
        held = self._held_list()
        if con_id not in held:
            self._write_held([*held, con_id])

    def _forget_held(self, con_id: str) -> None:
        held = self._held_list()
        if con_id in held:
            self._write_held([c for c in held if c != con_id])

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
        for con_id in self._held_list():
            if con_id == str(stale.get("con_id") or ""):
                continue
            log(f"an earlier run still holds session {con_id[:8]}...; giving the scope back before connecting")
            self._release({"con_id": con_id})
            self._forget_held(con_id)

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
                try:
                    self.end_headers()
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # a controller shutting down asks and does not wait for the answer

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
    # SEESTAR_TUNNEL_MULTI=1: this container hosts one supervisor per telescope (src/manager.py),
    # each started by the manager with SEESTAR_TUNNEL_SLOT set; this process is then the manager.
    multi = os.environ.get("SEESTAR_TUNNEL_MULTI", "").strip().lower() in ("1", "true", "yes", "on")
    if multi and not os.environ.get("SEESTAR_TUNNEL_SLOT"):
        import manager  # noqa: PLC0415  (beside this file; only the multi-tunnel setup needs it)
        return manager.main()
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
