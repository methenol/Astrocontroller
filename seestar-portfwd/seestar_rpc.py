#!/usr/bin/env python3
"""Minimal JSON-RPC client for the Seestar control channel.

Standard-library only. Talks to the tunnel's published control
port (127.0.0.1:4700 by default). Override with env vars.

Usage:
    ./seestar_rpc.py <method> [json-params]
    ./seestar_rpc.py get_device_state
    ./seestar_rpc.py scope_goto_target '{"ra": 5.5, "dec": -5.4}'
"""

from __future__ import annotations

import json
import os
import socket
import sys

CONTROL_PORT = int(os.environ.get("SEESTAR_CONTROL_PORT", "4700"))
CONTROL_HOST = os.environ.get("SEESTAR_CONTROL_HOST", "127.0.0.1")


class RpcError(RuntimeError):
    pass


def rpc(method: str, params=None, req_id: int = 1, timeout: float = 20.0) -> dict:
    payload: dict = {"id": req_id, "method": method}
    if params is not None:
        payload["params"] = params

    # A fresh connection per call, mirroring the app.
    with socket.create_connection((CONTROL_HOST, CONTROL_PORT), timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall((json.dumps(payload) + "\r\n").encode())

        # The device also emits unsolicited events, so read line by line until
        # the reply carrying our id arrives.
        buf = b""
        while True:
            while b"\r\n" in buf:
                line, _, buf = buf.partition(b"\r\n")
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if msg.get("id") == req_id:
                    return msg
            chunk = sock.recv(65536)
            if not chunk:
                raise RpcError(f"{method}: connection closed before a reply")
            buf += chunk


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print((__doc__ or "").strip())
        return 0 if argv else 2

    method = argv[0]
    params = None
    if len(argv) > 1:
        raw = argv[1]
        try:
            params = json.loads(raw)
        except ValueError:
            print(f"error: params must be valid JSON, got: {raw}", file=sys.stderr)
            return 2

    try:
        reply = rpc(method, params)
    except (OSError, RpcError) as exc:
        print(
            f"error: {exc}\n"
            f"(is the tunnel up? this talks to {CONTROL_HOST}:{CONTROL_PORT})",
            file=sys.stderr,
        )
        return 1

    json.dump(reply, sys.stdout, indent=2, ensure_ascii=False)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
