#!/usr/bin/env python3
"""The invariants the scope's one-session limit demands of the supervisor.

    python3 test_supervisor.py

No dependencies: a fake tunnel binary stands in for qemu + the SDK (it prints what the real one
prints and opens the local port a ready tunnel would), and the ZWO cloud is replaced with a
recording stub. What is asserted is what would otherwise be learned the hard way at 2 a.m.: that
only one tunnel process ever exists, that the session is always given back, that sessions a
crashed run left behind are returned before a new one is asked for, that the id the backend keys
sessions by survives the container, and which Connect_Ex refusals are worth waiting for.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "src"))

import supervisor as sup  # noqa: E402  (the path above has to exist first)
import seestar_status as real_cloud  # noqa: E402  (its error classes must be the real ones)

#: stands in for /work/tunnel: prints the lines the real binary prints, and opens the port a ready
#: tunnel would be serving, so the readiness gate can be exercised without a telescope
FAKE_TUNNEL = """#!/usr/bin/env python3
import os, socket, time
mode = os.environ.get("FAKE_MODE", "ready")
port = int(os.environ["FAKE_PROBE_PORT"])
with open(os.environ["FAKE_PIDS"], "a") as fh:
    fh.write(f"{os.getpid()}\\n")
if mode == "refuse_final":
    # the real connector prints its last refusal and exits 1 right after it
    print("[!] Connect_Ex failed: -42", flush=True)
    raise SystemExit(1)
if mode == "refuse_then_second_dial":
    # refused on the first dial of a session, up on the second: the -42 that follows a session ending
    if sum(1 for _ in open(os.environ["FAKE_PIDS"])) < 2:
        print("[!] Connect_Ex failed: -60", flush=True)
        raise SystemExit(1)
if mode == "hang":
    # a connect that never answers: Connect_Ex blocked inside the SDK
    while True:
        time.sleep(1)
if mode == "garbage":
    # the SDK prints bytes that are not UTF-8 now and then; the supervisor's reader must survive them
    import sys
    sys.stdout.buffer.write(b"    dns t\\xff\\xfe -> (no A record)\\n")
    sys.stdout.flush()
if mode == "refuse_then_ready":
    print("[!] Connect_Ex failed: -42 (retrying)", flush=True)
    time.sleep(0.5)
print("[*] tunnel ready - press Ctrl-C to disconnect", flush=True)
srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", port))
srv.listen(8)
srv.settimeout(0.5)
# FAKE_STALL_AFTER_S/_FOR_S: the control channel stalls that long after the first connection -
# connections are accepted and never answered, as the scope's 4700 behind a stalled session is
stall_after = float(os.environ.get("FAKE_STALL_AFTER_S", "-1"))
stall_for = float(os.environ.get("FAKE_STALL_FOR_S", "0"))
first = None
held = []
while True:
    try:
        client, _ = srv.accept()
    except OSError:
        continue
    now = time.time()
    if first is None:
        first = now
    if stall_after >= 0 and first + stall_after <= now < first + stall_after + stall_for:
        held.append(client)
        continue
    try:
        with client:
            client.sendall(b'{"result":"server connected!"}\\n')
    except OSError:
        continue  # a probe that hangs up once it has its answer is normal, not a crash
"""

#: qemu is invoked as `qemu -L sysroot -E LD_PRELOAD=... <program>`; the program is what matters here
FAKE_QEMU = '#!/bin/sh\neval "prog=\\${$#}"\nexec "$prog"\n'


class FakeCloud:
    """The handful of cloud calls the supervisor makes, recording every one of them."""

    TIMEOUT = 12.0
    DEVICE_STATUS = {1: "ONLINE", 3: "SHOOTING", 4: "OCCUPIED"}
    REPORT_START = real_cloud.REPORT_START
    REPORT_SUCCEED = real_cloud.REPORT_SUCCEED
    REPORT_FAILED = real_cloud.REPORT_FAILED
    REPORT_CANCEL = real_cloud.REPORT_CANCEL
    #: the supervisor catches the cloud module's own error class, so the stub has to carry it
    ApiError = real_cloud.ApiError

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.sessions: list[str] = []
        self.released: list[str] = []
        self.src_ids: list[str] = []
        #: what the account reports for the scope: ONLINE until a session is allocated, OCCUPIED from
        #: then on until the session ends. A real scope reports itself free on its own once the SDK
        #: session is gone; `sticky` keeps it OCCUPIED until the backend's stop_p2p, the case the
        #: supervisor must fall back to.
        self.status = 1
        self.sticky = False
        self.tunnel_pids = ""

    def _session_gone(self) -> bool:
        """The fake scope frees itself when no tunnel process is alive any more."""
        try:
            with open(self.tunnel_pids) as fh:
                pids = [int(x) for x in fh if x.strip()]
        except OSError:
            return True
        for pid in pids:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                continue
            except PermissionError:
                return False
            return False
        return True

    def login(self, user: str, password: str) -> str:  # noqa: ARG002
        self.calls.append("login")
        return "token"

    def list_devices(self, token: str) -> list[dict]:  # noqa: ARG002
        self.calls.append("list_devices")
        if self.status == 4 and not self.sticky and self._session_gone():
            self.status = 1
        return [{"deviceSn": "FAKE-SN", "deviceName": "Seestar", "deviceModel": "Seestar S50", "deviceStatus": self.status}]

    def online_link(self, token: str, sn: str, model: str, src_id: str) -> tuple[int, dict]:  # noqa: ARG002
        self.calls.append("online_link")
        self.src_ids.append(src_id)
        con_id = f"con{len(self.sessions) + 1:032d}"
        self.sessions.append(con_id)
        self.status = 4
        data = {"conId": con_id, "deviceUid": "1", "sdkLicenseKey": "2", "username": "u", "password": "p", "p2pStatus": 1}
        return 200, {"code": 0, "data": data}

    def stop_p2p(self, token: str, con_id: str) -> tuple[int, dict]:  # noqa: ARG002
        self.calls.append(f"stop_p2p:{con_id}")
        self.released.append(con_id)
        self.status = 1
        return 200, {"code": 0}

    def report_connect_result(self, token: str, sn: str, model: str, con_id: str, event: str,  # noqa: ARG002
                              code: int | None = None) -> tuple[int, dict]:
        self.calls.append(f"report:{event}:{con_id}" + (f":{code}" if code is not None else ""))
        return 200, {"code": 200, "msg": "OK", "data": {"result": True}}  # the real backend's answer

    def source_id(self) -> str:
        return "stable-from-the-installation"


class Harness:
    """A supervisor with a fake cloud, a fake tunnel and everything in one scratch directory."""

    def __init__(self, mode: str = "ready", **env_extra: str) -> None:
        self.dir = tempfile.mkdtemp(prefix="seestar-sup-")
        self.cloud = FakeCloud()
        tunnel = os.path.join(self.dir, "fake-tunnel")
        qemu = os.path.join(self.dir, "fake-qemu")
        with open(tunnel, "w") as fh:
            fh.write(FAKE_TUNNEL)
        with open(qemu, "w") as fh:
            fh.write(FAKE_QEMU)
        os.chmod(tunnel, 0o755)
        os.chmod(qemu, 0o755)
        self.pids = os.path.join(self.dir, "pids")
        open(self.pids, "a").close()
        self.cloud.tunnel_pids = self.pids
        probe = _free_port()
        env = {
            "FAKE_MODE": mode,
            "FAKE_PIDS": self.pids,
            "FAKE_PROBE_PORT": str(probe),
            "QEMU": qemu,
            "TUNNEL_SYSROOT": self.dir,
            "TUNNEL_DNSHOOK": os.path.join(self.dir, "nope.so"),
            "TUNNEL_BIN": tunnel,
            "SEESTAR_USER": "operator",
            "SEESTAR_PASSWORD": "secret",
            "SEESTAR_DEVICE": "FAKE-SN",
            "SEESTAR_TUNNEL_AUTOSTART": "",
            "SEESTAR_TUNNEL_CONTROL_PORT": str(_free_port()),
            "SEESTAR_TUNNEL_PROBE_PORT": str(probe),
            "SEESTAR_TUNNEL_READY_TIMEOUT_S": "5",
            "SEESTAR_TUNNEL_RETRY_MIN_S": "1",
            "SEESTAR_TUNNEL_RETRY_MAX_S": "2",
            "SEESTAR_TUNNEL_STOP_GRACE_S": "1",
            "SEESTAR_TUNNEL_WATCHDOG_S": "1",
            "SEESTAR_TUNNEL_LIVENESS_S": "5",
            "SEESTAR_TUNNEL_CONNECT_RETRIES": "0",
            "SEESTAR_TUNNEL_CONNECT_RETRY_S": "0.2",
            "SEESTAR_TUNNEL_SESSION_BUDGET_S": "900",
            "SEESTAR_TUNNEL_RELEASE_WAIT_S": "6",
            "SEESTAR_TUNNEL_LOCK": os.path.join(self.dir, "tunnel.lock"),
            "SEESTAR_TUNNEL_STATE": os.path.join(self.dir, "session.json"),
            "SEESTAR_TUNNEL_SRC_ID": os.path.join(self.dir, "srcid"),
            **env_extra,
        }
        self._saved = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        sup.cloud = self.cloud  # the only cloud the supervisor will ever see
        # the spawn command is resolved when the module is imported, so the fakes are installed there
        sup.QEMU = qemu
        sup.SYSROOT = self.dir
        sup.DNSHOOK = os.path.join(self.dir, "nope.so")
        sup.TUNNEL_BIN = tunnel

    def rebuild(self) -> sup.Supervisor:
        """A fresh supervisor over the same directory: a container restart."""
        s = sup.Supervisor(sup.Config())
        s.start()
        return s

    def pids_written(self) -> list[int]:
        with open(self.pids) as fh:
            return [int(line) for line in fh if line.strip()]

    def alive(self, pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def cleanup(self, s: sup.Supervisor | None) -> None:
        if s is not None:
            try:
                s.begin_stop()
                for _ in range(60):
                    if s.status()["phase"] in ("idle", "stopped", "disconnected"):
                        break
                    time.sleep(0.1)
            except Exception:  # noqa: BLE001 - teardown must never fail a test
                pass
        for pid in self.pids_written():
            if self.alive(pid):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v



def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class SupervisorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.h: Harness | None = None
        self.s: sup.Supervisor | None = None

    def tearDown(self) -> None:
        if self.h is not None:
            self.h.cleanup(self.s)

    def boot(self, mode: str = "ready", **env_extra: str) -> sup.Supervisor:
        self.h = Harness(mode, **env_extra)
        self.s = self.h.rebuild()
        return self.s

    def wait(self, predicate, timeout: float = 20.0, what: str = "condition") -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return
            time.sleep(0.1)
        self.fail(f"timed out waiting for {what}; status={json.dumps(self.s.status(), default=str)[:400]}")

    # ---- the invariants -----------------------------------------------------------------------

    def test_connect_runs_one_tunnel_and_disconnect_gives_the_scope_back(self) -> None:
        s = self.boot()
        s.connect()
        self.wait(lambda: s.status()["phase"] == "connected", what="the tunnel to come up")
        self.wait(lambda: len(self.h.pids_written()) >= 1, what="the tunnel process")
        self.assertEqual(len(self.h.pids_written()), 1, "a second tunnel process was started")
        self.assertEqual(len(self.h.cloud.sessions), 1, "a second P2P session was allocated")
        con_id = self.h.cloud.sessions[0]

        out = s.disconnect(wait_s=10)
        self.assertEqual(out["phase"], "idle", f"the disconnect left the supervisor in {out['phase']}")
        # the scope reported itself free after the SDK disconnect, as a real one does: no stop_p2p,
        # which is what the official app never sends and what precedes the minutes of -42
        self.assertNotIn(f"stop_p2p:{con_id}", self.h.cloud.calls, "stop_p2p was sent for a session the scope had already ended")
        self.assertEqual(self.h.cloud.status, 1, "the scope was left OCCUPIED")
        reports = [c for c in self.h.cloud.calls if c.startswith("report:")]
        self.assertEqual(reports, [f"report:p2pConnectStart:{con_id}", f"report:p2pConnectSucceed:{con_id}"],
                         "the backend was not told about the session the way the app tells it")
        self.assertLess(self.h.cloud.calls.index(f"report:p2pConnectStart:{con_id}"),
                        len(self.h.cloud.calls) - 1 - self.h.cloud.calls[::-1].index("list_devices"),
                        "p2pConnectStart was reported only after the session had ended")
        self.wait(lambda: s.status()["phase"] not in ("connected", "connecting"), what="the tunnel to stop")
        for pid in self.h.pids_written():
            self.assertFalse(self.h.alive(pid), f"tunnel {pid} outlived the disconnect")
        self.assertFalse(os.path.exists(os.path.join(self.h.dir, "session.json.held")), "a released session stayed in the journal")
        self.assertFalse(os.path.exists(os.path.join(self.h.dir, "session.json")) and json.load(open(os.path.join(self.h.dir, "session.json"))).get("con_id"), "the ended session stayed in the state file")

    def test_a_session_the_scope_keeps_reporting_is_stopped_through_the_backend(self) -> None:
        s = self.boot(SEESTAR_TUNNEL_RELEASE_WAIT_S="1")
        self.h.cloud.sticky = True
        s.connect()
        self.wait(lambda: s.status()["phase"] == "connected", what="the tunnel to come up")
        con_id = self.h.cloud.sessions[0]
        out = s.disconnect(wait_s=10)
        self.assertEqual(out["phase"], "idle", f"the disconnect left the supervisor in {out['phase']}")
        self.assertIn(f"stop_p2p:{con_id}", self.h.cloud.calls, "a session the scope still reported was never given back")
        self.assertEqual(self.h.cloud.status, 1, "the scope was left OCCUPIED")

    def test_a_connect_while_connected_never_opens_a_second_session(self) -> None:
        s = self.boot()
        s.connect()
        self.wait(lambda: s.status()["phase"] == "connected", what="the tunnel to come up")
        for _ in range(5):  # the controller asks for the connection repeatedly; the scope must not notice
            s.connect()
        time.sleep(0.5)
        self.assertEqual(len(self.h.cloud.sessions), 1, "a repeated connect allocated another session")
        self.assertEqual(len(self.h.pids_written()), 1, "a repeated connect started another tunnel")

    def test_the_session_id_survives_the_container_and_is_what_the_backend_keys_on(self) -> None:
        s = self.boot()
        s.connect()
        self.wait(lambda: s.status()["phase"] == "connected", what="the tunnel to come up")
        first = self.h.cloud.src_ids[-1]
        path = os.path.join(self.h.dir, "srcid")
        self.assertTrue(os.path.exists(path), "the session id was not persisted, so a restart would orphan it")
        with open(path) as fh:
            self.assertEqual(fh.read().strip(), first)

        s.begin_stop()  # a container restart, same volume: the id must not change
        s2 = self.h.rebuild()
        self.s = s2
        s2.connect()
        self.wait(lambda: s2.status()["phase"] == "connected", what="the tunnel to come up a second time")
        self.assertEqual(self.h.cloud.src_ids[-1], first, "a fresh container invented a new session id")

    def test_a_session_left_by_a_crashed_run_is_given_back_before_a_new_one(self) -> None:
        s = self.boot()
        s.connect()
        self.wait(lambda: s.status()["phase"] == "connected", what="the tunnel to come up")
        orphan = self.h.cloud.sessions[0]
        # simulate the hard death of the container: the state and journal stay, nothing was released
        for pid in self.h.pids_written():
            if self.h.alive(pid):
                os.kill(pid, signal.SIGKILL)
        s.begin_stop()
        self.h.cloud.released.clear()

        s2 = self.h.rebuild()
        self.s = s2
        s2.connect()
        self.wait(lambda: s2.status()["phase"] == "connected", what="the tunnel to come up after the crash")
        self.assertIn(f"stop_p2p:{orphan}", self.h.cloud.calls, "the session the crashed run held was never released")
        self.assertLess(
            self.h.cloud.calls.index(f"stop_p2p:{orphan}"),
            len(self.h.cloud.calls) - 1 - self.h.cloud.calls[::-1].index("online_link"),
            "a new session was asked for before the orphaned one was given back",
        )

    def test_a_refusal_the_child_is_still_retrying_is_not_cut_short(self) -> None:
        # the -42 that follows a session ending is cured by retrying on the same session: giving up
        # on the first refusal is what turns one -42 into a storm of them
        s = self.boot("refuse_then_ready")
        started = time.time()
        s.connect()
        self.wait(lambda: s.status()["phase"] == "connected", timeout=10, what="the retrying child to come up")
        self.assertEqual(self.h.cloud.released, [], "the session was handed back while the child was still retrying")
        self.assertGreaterEqual(time.time() - started, 0.4, "the refusal was never given its retry")

    def test_a_refusal_the_child_gave_up_on_is_dialled_again_on_the_same_session(self) -> None:
        # ready_timeout is 5 s here; a child that has finished trying must not be waited on for it,
        # and the session it was refused on is dialled again rather than handed back: the scope's
        # P2P agent answers minutes after a session ended, whichever session asks
        s = self.boot("refuse_final", SEESTAR_TUNNEL_CONNECT_RETRIES="2")
        s.connect()
        self.wait(lambda: bool(self.h.cloud.sessions), timeout=10, what="a session to be allocated")
        con_id = self.h.cloud.sessions[0]
        started = time.time()
        self.wait(lambda: s.status()["phase"] in ("backoff", "idle", "failed"), timeout=8, what="the attempt to be abandoned")
        self.assertLess(time.time() - started, 6, "a child that had given up was waited on for the whole timeout")
        self.assertEqual(len(self.h.pids_written()), 3, "the refused session was not dialled again the configured number of times")
        self.assertEqual(self.h.cloud.sessions, [con_id], "another session was asked for while the refused one still had dials left")
        self.assertIn(f"stop_p2p:{con_id}", self.h.cloud.calls, "a session that never came up was left held")
        reports = [c for c in self.h.cloud.calls if c.startswith("report:")]
        self.assertEqual(reports, [f"report:p2pConnectStart:{con_id}", f"report:p2pConnectFailed:{con_id}:-42"],
                         "a refused session must be reported failed once, with the SDK's code, and never succeeded")
        self.assertLess(self.h.cloud.calls.index(reports[1]), self.h.cloud.calls.index(f"stop_p2p:{con_id}"),
                        "the failure was reported only after the session was stopped")

    def test_output_that_is_not_utf8_does_not_kill_the_tunnel_reader(self) -> None:
        s = self.boot("garbage")
        s.connect()
        self.wait(lambda: s.status()["phase"] == "connected", timeout=10, what="the tunnel to come up past a bad byte")
        self.assertTrue(any("dns t" in line for line in s.status()["output"]), "the line with the bad byte was lost")

    def test_a_disconnect_before_the_tunnel_is_up_is_reported_as_a_cancel(self) -> None:
        s = self.boot("hang")
        s.connect()
        self.wait(lambda: bool(self.h.pids_written()), timeout=10, what="the tunnel to be started")
        con_id = self.h.cloud.sessions[0]
        s.disconnect(wait_s=10)
        reports = [c for c in self.h.cloud.calls if c.startswith("report:")]
        self.assertEqual(reports, [f"report:p2pConnectStart:{con_id}", f"report:p2pConnectCancel:{con_id}"],
                         "a session the user gave up on before it came up is a cancel, not a failure")

    def test_a_session_refused_once_comes_up_on_its_second_dial(self) -> None:
        s = self.boot("refuse_then_second_dial", SEESTAR_TUNNEL_CONNECT_RETRIES="3")
        s.connect()
        self.wait(lambda: s.status()["phase"] == "connected", timeout=15, what="the second dial to come up")
        self.assertEqual(len(self.h.cloud.sessions), 1, "a refusal cost a session")
        self.assertEqual(self.h.cloud.released, [], "the session was handed back on the way")
        self.assertEqual(len(self.h.pids_written()), 2, "the second dial did not happen on the same session")

    def test_a_session_past_its_budget_is_given_back(self) -> None:
        s = self.boot("refuse_final", SEESTAR_TUNNEL_CONNECT_RETRIES="5", SEESTAR_TUNNEL_SESSION_BUDGET_S="0.5")
        s.connect()
        self.wait(lambda: len(self.h.cloud.sessions) >= 2, timeout=15, what="a second session after the first one's budget ran out")
        first = self.h.cloud.sessions[0]
        self.assertIn(f"stop_p2p:{first}", self.h.cloud.calls, "the session past its budget was not given back")
        self.assertLess(len(self.h.pids_written()), 6, "the budget did not stop the dialling")

    def test_a_control_channel_stall_shorter_than_the_budget_is_waited_out(self) -> None:
        # 2026-11-11: 4700 went silent for ~2 min while the P2P session held, then answered again;
        # three misses killed it anyway and the fresh session was refused (-42) for 5+ minutes
        s = self.boot(FAKE_STALL_AFTER_S="1", FAKE_STALL_FOR_S="9", SEESTAR_TUNNEL_LIVENESS_FAILS="1",
                      SEESTAR_TUNNEL_PROBE_TIMEOUT_S="1", SEESTAR_TUNNEL_SILENT_PROBE_S="1",
                      SEESTAR_TUNNEL_SILENT_S="30")
        s.connect()
        self.wait(lambda: s.status()["phase"] == "connected", what="the tunnel to come up")
        self.wait(lambda: not s.status()["portOpen"], timeout=10, what="a probe to find the control port silent")
        self.wait(lambda: s.status()["portOpen"], timeout=15, what="the control port to answer again")
        self.assertEqual(s.status()["phase"], "connected", "a stall that recovered by itself cost the session")
        self.assertEqual(len(self.h.pids_written()), 1, "the tunnel was restarted over a stall")
        self.assertEqual(len(self.h.cloud.sessions), 1, "a new session was allocated over a stall")

    def test_a_control_channel_that_stays_silent_is_reconnected(self) -> None:
        s = self.boot(FAKE_STALL_AFTER_S="1", FAKE_STALL_FOR_S="1000", SEESTAR_TUNNEL_LIVENESS_FAILS="2",
                      SEESTAR_TUNNEL_PROBE_TIMEOUT_S="1", SEESTAR_TUNNEL_SILENT_PROBE_S="1",
                      SEESTAR_TUNNEL_SILENT_S="4")
        s.connect()
        self.wait(lambda: s.status()["phase"] == "connected", what="the tunnel to come up")
        self.wait(lambda: len(self.h.pids_written()) >= 2, timeout=25, what="a reconnect after the silence budget")
        self.assertFalse(self.h.alive(self.h.pids_written()[0]), "the silent tunnel was left running beside the new one")

    def test_a_disconnect_during_a_silent_probe_is_not_held_up(self) -> None:
        s = self.boot(FAKE_STALL_AFTER_S="0", FAKE_STALL_FOR_S="1000", SEESTAR_TUNNEL_READY_TIMEOUT_S="60")
        s.connect()
        self.wait(lambda: len(self.h.pids_written()) >= 1, what="the tunnel process")
        time.sleep(1.5)  # a readiness probe is now waiting on the silent port
        started = time.time()
        s.disconnect(wait_s=10)
        self.assertLess(time.time() - started, 8, "the disconnect waited out the probe")


if __name__ == "__main__":
    unittest.main(verbosity=2)
