#!/usr/bin/env python3
"""Run several Seestar tunnels in one container: one supervisor per telescope, each in its own slot.

The supervisor (supervisor.py) owns one telescope's one P2P session. With SEESTAR_TUNNEL_MULTI=1
the container's entry point becomes this manager instead, and Astrocontroller's profile hub asks it
for a supervisor per Seestar profile that connects over ZWO Telescope Network. Every slot has its
own account, its own serial, its own session journal and source id, and its own ports:

  slot n   device port p  ->  local port p + n*1000     (4700 -> 5700 for slot 1, 6700 for slot 2 ...)
           control API    ->  4710 + n*1000
           state          ->  /var/lib/seestar-portfwd/slot-<n>/   (slot 0 "legacy": the volume's root,
                                                                   where the single-tunnel setup kept it)

Every device port modulo 1000 is distinct, so the slots never collide; 33 is the last slot whose
ports all fit below 65536.

Manager API on SEESTAR_TUNNEL_MANAGER_PORT (4709), JSON over HTTP, the same Bearer token as the
supervisors (SEESTAR_TUNNEL_CONTROL_TOKEN) when one is set:

  GET    /health          the manager answers
  GET    /tunnels         every slot: serial, account, running, pid
  PUT    /tunnels/<n>     {"user", "password", "sn", "country", "legacy"}: make slot n's supervisor run
                          with this account (a no-op when it already does; restarted when it changed)
  DELETE /tunnels/<n>     stop slot n's supervisor: it releases its telescope on the way out

The credentials live only in this process's memory and the supervisor's environment. The hub sends
them again whenever it starts a profile and every minute after, so a restarted container picks its
slots back up by itself. Slot 0 also starts from the container's own SEESTAR_USER/SEESTAR_PASSWORD
when they are set, which keeps a single-telescope setup working unchanged.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

SUPERVISOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "supervisor.py")
STATE_ROOT = os.environ.get("SEESTAR_TUNNEL_STATE_ROOT", "/var/lib/seestar-portfwd")
MAX_SLOT = 33
SLOT_STRIDE = 1000
RESTART_S = 5.0
#: a supervisor gets this long to release its telescope after SIGTERM (its own budget plus the release)
STOP_WAIT_S = float(os.environ.get("SEESTAR_TUNNEL_STOP_GRACE_S", "75") or 75) + 60
SLOT_PATH = re.compile(r"^/tunnels/(\d{1,2})$")


def log(text: str) -> None:
    print(f"[manager] {text}", flush=True)


def offset(slot: int) -> int:
    return slot * SLOT_STRIDE


def slot_env(slot: int, spec: dict[str, Any]) -> dict[str, str]:
    """The environment slot n's supervisor runs with."""
    off = offset(slot)
    env = {
        **os.environ,
        "SEESTAR_TUNNEL_SLOT": str(slot),
        "SEESTAR_TUNNEL_AUTOSTART": "0",
        "SEESTAR_TUNNEL_CONTROL_PORT": str(4710 + off),
        "SEESTAR_TUNNEL_PROBE_PORT": str(4700 + off),
        "TUTK_PORT_OFFSET": str(off),
        "SEESTAR_USER": spec["user"],
        "SEESTAR_PASSWORD": spec["password"],
        "SEESTAR_SN": spec.get("sn", ""),
        "SEESTAR_COUNTRY": spec.get("country") or "US",
    }
    if not spec.get("legacy"):
        state = os.path.join(STATE_ROOT, f"slot-{slot}")
        os.makedirs(state, exist_ok=True)
        env["SEESTAR_TUNNEL_LOCK"] = os.path.join(state, "tunnel.lock")
        env["SEESTAR_TUNNEL_STATE"] = os.path.join(state, "session.json")
        env["SEESTAR_TUNNEL_SRC_ID"] = os.path.join(state, "srcid")
    env.pop("SEESTAR_TUNNEL_MULTI", None)
    return env


class Slot:
    def __init__(self, n: int, spec: dict[str, Any]) -> None:
        self.n = n
        self.spec = spec
        self.proc: subprocess.Popen | None = None
        self.wanted = True
        self.since = time.time()
        self.restarts = 0

    def key(self) -> tuple:
        s = self.spec
        return (s["user"], s["password"], s.get("sn", ""), s.get("country", ""), bool(s.get("legacy")))

    def describe(self) -> dict[str, Any]:
        running = self.proc is not None and self.proc.poll() is None
        return {
            "slot": self.n,
            "sn": self.spec.get("sn", ""),
            "user": self.spec["user"],
            "legacy": bool(self.spec.get("legacy")),
            "controlPort": 4710 + offset(self.n),
            "portOffset": offset(self.n),
            "running": running,
            "wanted": self.wanted,
            "pid": self.proc.pid if running and self.proc else None,
            "since": round(self.since, 3),
            "restarts": self.restarts,
        }


class Manager:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.slots: dict[int, Slot] = {}
        self.stopping = False
        self.token = os.environ.get("SEESTAR_TUNNEL_CONTROL_TOKEN", "")
        self.port = int(os.environ.get("SEESTAR_TUNNEL_MANAGER_PORT", "4709") or 4709)
        self.bind = os.environ.get("SEESTAR_TUNNEL_CONTROL_BIND", "0.0.0.0")

    # ---- slots -----------------------------------------------------------------------------

    def _spawn(self, slot: Slot) -> None:
        argv = [sys.executable, SUPERVISOR]
        slot.proc = subprocess.Popen(  # noqa: S603  (fixed argv; the credentials go only in the env)
            argv, env=slot_env(slot.n, slot.spec), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1, errors="replace",
        )
        slot.since = time.time()
        log(f"slot {slot.n}: supervisor started for {slot.spec.get('sn') or 'the account'} "
            f"(ports +{offset(slot.n)}, control {4710 + offset(slot.n)}, pid {slot.proc.pid})")
        threading.Thread(target=self._pump, args=(slot, slot.proc), name=f"slot-{slot.n}", daemon=True).start()

    def _pump(self, slot: Slot, proc: subprocess.Popen) -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            print(f"[slot {slot.n}] {line.rstrip()}", flush=True)
        code = proc.wait()
        with self.lock:
            again = slot.wanted and not self.stopping and self.slots.get(slot.n) is slot and slot.proc is proc
        if again:
            log(f"slot {slot.n}: supervisor exited ({code}); starting it again in {RESTART_S:.0f} s")
            time.sleep(RESTART_S)
            with self.lock:
                if slot.wanted and not self.stopping and self.slots.get(slot.n) is slot and slot.proc is proc:
                    slot.restarts += 1
                    self._spawn(slot)

    def _stop(self, slot: Slot) -> None:
        """SIGTERM: the supervisor releases its telescope, then exits. Waits for it (on a worker thread)."""
        slot.wanted = False
        proc = slot.proc
        if proc is None or proc.poll() is not None:
            return
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(STOP_WAIT_S)
        except subprocess.TimeoutExpired:
            log(f"slot {slot.n}: supervisor did not exit within {STOP_WAIT_S:.0f} s; killing it")
            proc.kill()
            proc.wait()
        log(f"slot {slot.n}: supervisor stopped")

    def ensure(self, n: int, spec: dict[str, Any]) -> str:
        new = Slot(n, spec)
        with self.lock:
            old = self.slots.get(n)
            if old and old.key() == new.key() and old.wanted:
                return "unchanged"
            self.slots[n] = new
        def run() -> None:
            if old:
                self._stop(old)
            with self.lock:
                if self.slots.get(n) is new and new.wanted and not self.stopping:
                    self._spawn(new)
        threading.Thread(target=run, name=f"ensure-{n}", daemon=True).start()
        return "replaced" if old else "started"

    def remove(self, n: int) -> bool:
        with self.lock:
            slot = self.slots.pop(n, None)
        if not slot:
            return False
        threading.Thread(target=self._stop, args=(slot,), name=f"remove-{n}", daemon=True).start()
        return True

    def stop_all(self) -> None:
        with self.lock:
            self.stopping = True
            slots = list(self.slots.values())
        workers = [threading.Thread(target=self._stop, args=(s,)) for s in slots]
        for w in workers:
            w.start()
        for w in workers:
            w.join()

    # ---- API -------------------------------------------------------------------------------

    def serve(self) -> None:
        manager = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            server_version = "seestar-portfwd-manager/1.0"

            def _json(self, code: int, payload: Any) -> None:
                body = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                try:
                    self.end_headers()
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def _denied(self) -> bool:
                if not manager.token:
                    return False
                if self.headers.get("Authorization", "") in (f"Bearer {manager.token}", manager.token):
                    return False
                self._json(401, {"error": "the manager wants SEESTAR_TUNNEL_CONTROL_TOKEN as Authorization: Bearer <token>"})
                return True

            def _body(self) -> dict:
                try:
                    length = min(int(self.headers.get("Content-Length") or 0), 8192)
                    parsed = json.loads(self.rfile.read(length) or b"{}") if length else {}
                except ValueError:
                    return {}
                return parsed if isinstance(parsed, dict) else {}

            def _slot(self) -> int | None:
                m = SLOT_PATH.match(self.path.split("?")[0])
                if not m or int(m.group(1)) > MAX_SLOT:
                    self._json(404, {"error": f"no such route: {self.path} (slots are 0-{MAX_SLOT})"})
                    return None
                return int(m.group(1))

            def do_GET(self) -> None:  # noqa: N802
                route = self.path.split("?")[0]
                if route == "/health":
                    self._json(200, {"ok": True, "slots": len(manager.slots)})
                    return
                if route != "/tunnels":
                    self._json(404, {"error": f"no such route: {self.path}"})
                    return
                if self._denied():
                    return
                with manager.lock:
                    self._json(200, {"tunnels": [s.describe() for s in sorted(manager.slots.values(), key=lambda s: s.n)]})

            def do_PUT(self) -> None:  # noqa: N802
                n = self._slot()
                if n is None or self._denied():
                    return
                b = self._body()
                user, password = str(b.get("user") or "").strip(), str(b.get("password") or "")
                if not user or not password:
                    self._json(400, {"error": "user and password (the ZWO account) are required"})
                    return
                spec = {
                    "user": user,
                    "password": password,
                    "sn": str(b.get("sn") or "").strip(),
                    "country": str(b.get("country") or "US").strip() or "US",
                    "legacy": bool(b.get("legacy")) and n == 0,
                }
                result = manager.ensure(n, spec)
                self._json(200 if result == "unchanged" else 202, {"slot": n, "result": result})

            def do_DELETE(self) -> None:  # noqa: N802
                n = self._slot()
                if n is None or self._denied():
                    return
                self._json(202 if manager.remove(n) else 404, {"slot": n})

            def log_message(self, fmt: str, *args: Any) -> None:
                pass

        server = ThreadingHTTPServer((self.bind, self.port), Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, name="manager", daemon=True).start()
        log(f"multi-tunnel manager listens on {self.bind}:{self.port}" + (" (Bearer token required)" if self.token else ""))


def health() -> int:
    import socket

    port = int(os.environ.get("SEESTAR_TUNNEL_MANAGER_PORT", "4709") or 4709)
    try:
        with socket.create_connection(("127.0.0.1", port), 3) as s:
            s.sendall(f"GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n".encode())
            ok = s.recv(64).startswith(b"HTTP/1.1 200")
    except OSError as exc:
        print(f"the multi-tunnel manager on port {port} is not answering: {exc}", file=sys.stderr)
        return 1
    return 0 if ok else 1


def main() -> int:
    if sys.argv[1:2] in (["--health"], ["--status"]):
        return health()
    manager = Manager()
    manager.serve()
    user, password = os.environ.get("SEESTAR_USER", "").strip(), os.environ.get("SEESTAR_PASSWORD", "")
    if user and password:
        log("SEESTAR_USER is set: slot 0 runs with the container's own account (the single-tunnel setup)")
        manager.ensure(0, {"user": user, "password": password, "sn": os.environ.get("SEESTAR_SN", ""),
                           "country": os.environ.get("SEESTAR_COUNTRY", "US"), "legacy": True})

    stopping = threading.Event()

    def on_signal(signo: int, _frame: Any) -> None:
        if not stopping.is_set():
            log(f"{signal.Signals(signo).name}: stopping every slot (each releases its telescope)")
            stopping.set()

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    while not stopping.wait(0.5):
        pass
    manager.stop_all()
    return 0


if __name__ == "__main__":
    sys.exit(main())
