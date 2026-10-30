#!/usr/bin/env python3
"""ZWO Seestar cloud client: login, list devices, allocate/release a P2P session.

Standard-library only. Endpoints and payload shapes match the Seestar Android app:

  login   POST {seestar}/v1/user/login         body: {authKey, password, authType}
  devices GET  {remote}/v1/my-device           header: Authorization: <accessToken>
  connect GET  {remote}/v1/device-p2p/online-link?deviceSn&deviceModel&srcId
  stop    POST {remote}/v1/device-p2p/stop      body: {conId}

Credentials come from the environment: SEESTAR_USER & SEESTAR_PASSWORD.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# assets/seestar_env.json -> prod.domain
DOMAIN_SEESTAR = os.environ.get("SEESTAR_API_SEESTAR", "https://api.seestar.com")
DOMAIN_REMOTE = os.environ.get("SEESTAR_API_REMOTE", "https://api-ithings.zwoastro.com")

PLATFORM = "seestar"
HEADER_PLATFORM = "x-service-platform"
TIMEOUT = 45.0

# device-state / remote-mode codes as reported by the API
DEVICE_STATUS = {0: "INACTIVE", 1: "ONLINE", 2: "OFFLINE", 3: "SHOOTING", 4: "OCCUPIED"}
REMOTE_MODE = {0: "P2P", 1: "RELAY", 2: "LAN"}

SECRET_FIELDS = {"p2pLicenseKey", "sdkLicenseKey", "password", "username", "deviceUid"}


class ApiError(RuntimeError):
    pass


# One HTTP call, returning (status, parsed-json). Network errors become ApiError.
def _request(
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    body: dict | None = None,
) -> tuple[int, Any]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            status = resp.status
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        status = exc.code
        raw = exc.read()
    except urllib.error.URLError as exc:
        raise ApiError(f"network failure: {exc.reason}") from None
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, {"_raw": raw.decode("utf-8", "replace")[:500]}


def _base_headers() -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        HEADER_PLATFORM: PLATFORM,
        "X-Lang": "en",
        "country_code": os.environ.get("SEESTAR_COUNTRY", "DE"),
    }


def _auth_headers(token: str) -> dict[str, str]:
    headers = _base_headers()
    # JWTInterceptor sets both, raw token, no "Bearer " prefix.
    headers["Authorization"] = token
    headers["X-Astroimg-Authorization"] = token
    return headers


def login(user: str, password: str) -> str:
    # A phone number logs in as "mobile", anything else as "email".
    auth_type = "mobile" if re.fullmatch(r"\+?\d[\d\s-]{5,}", user) else "email"
    body = {"authKey": user, "password": password, "authType": auth_type}
    status, payload = _request(
        "POST", f"{DOMAIN_SEESTAR}/v1/user/login", headers=_base_headers(), body=body
    )
    if status != 200:
        raise ApiError(
            f"login failed: HTTP {status} "
            f"code={payload.get('code')} msg={payload.get('msg')}"
        )
    token = (payload.get("data") or {}).get("accessToken")
    if not token:
        raise ApiError(f"login: no accessToken in response: {payload}")
    return token


def _url(base: str, path: str, params: dict[str, Any]) -> str:
    return f"{base}{path}?{urllib.parse.urlencode(params)}"


def list_devices(token: str) -> list[dict[str, Any]]:
    status, payload = _request(
        "GET",
        _url(DOMAIN_REMOTE, "/v1/my-device",
             {"current": 1, "pageSize": 100, "isContainShared": 1}),
        headers=_auth_headers(token),
    )
    if status == 401:
        raise ApiError("device list: 401 unauthorized (token rejected)")
    if status != 200:
        raise ApiError(
            f"device list failed: HTTP {status} "
            f"code={payload.get('code')} msg={payload.get('msg')}"
        )
    # The page of devices sits under one of several keys depending on the API.
    data = payload.get("data")
    if isinstance(data, dict):
        for key in ("items", "list", "records", "data"):
            value = data.get(key)
            if isinstance(value, list):
                return value
        return []
    return data if isinstance(data, list) else []


def device_detail(token: str, sn: str, model: str) -> dict[str, Any]:
    status, payload = _request(
        "GET",
        _url(DOMAIN_REMOTE, "/v1/my-device/detail",
             {"deviceSn": sn, "deviceModel": model, "onlyQueryOwner": "false"}),
        headers=_auth_headers(token),
    )
    if status != 200 or not isinstance(payload, dict):
        return {}
    data = payload.get("data")
    return data if isinstance(data, dict) else {}


def source_id() -> str:
    """Stable per-install client id sent as `srcId`.

    The backend keeps one active session per device/srcId, so a stable id lets a
    later run supersede our own stale session. Derived from the host's machine
    id (hashed, never sent raw); a random id is used when none is available.
    """
    override = os.environ.get("SEESTAR_SRC_ID")
    if override:
        return override
    # The image bakes a stable machine-id at build time (see Containerfile).
    for path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            mid = Path(path).read_text().strip()
        except OSError:
            continue
        if mid:
            # Mask machine ID:
            return hmac.new(b"seestar-portfwd", mid.encode(), hashlib.sha256).hexdigest()[:32]
    return uuid.uuid4().hex


def online_link(token: str, sn: str, model: str, src: str) -> tuple[int, dict[str, Any]]:
    status, payload = _request(
        "GET",
        _url(DOMAIN_REMOTE, "/v1/device-p2p/online-link",
             {"deviceSn": sn, "deviceModel": model, "srcId": src}),
        headers=_auth_headers(token),
    )
    return status, payload if isinstance(payload, dict) else {"_raw": payload}


def stop_p2p(token: str, con_id: str) -> tuple[int, Any]:
    return _request(
        "POST",
        f"{DOMAIN_REMOTE}/v1/device-p2p/stop",
        headers=_auth_headers(token),
        body={"conId": con_id},
    )


def _redact(data: dict[str, Any], reveal: bool) -> dict[str, Any]:
    if reveal:
        return data
    out: dict[str, Any] = {}
    for key, value in data.items():
        if key in SECRET_FIELDS and isinstance(value, str) and value:
            out[key] = f"<{len(value)} chars>"
        else:
            out[key] = value
    return out


def _enum(table: dict[int, str], value: Any) -> str:
    return table.get(value, f"UNKNOWN({value})") if isinstance(value, int) else str(value)


def _ts(value: Any) -> str:
    if not isinstance(value, int) or value <= 0:
        return "-"
    return datetime.fromtimestamp(value, timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def print_table(devices: list[dict[str, Any]]) -> None:
    if not devices:
        print("No devices on this account.")
        return
    print(f"{len(devices)} device(s):\n")
    for dev in devices:
        name = dev.get("modelAndSn") or (
            f"{dev.get('deviceModel')} {dev.get('deviceSn')}"
        )
        print(f"  {name}")
        print(f"    status      : {_enum(DEVICE_STATUS, dev.get('deviceStatus'))}")
        print(f"    remote mode : {_enum(REMOTE_MODE, dev.get('remoteMode'))}")
        print(f"    serial      : {dev.get('deviceSn')}")
        print(f"    model       : {dev.get('deviceModel')} / {dev.get('subModel')}")
        print(f"    location    : {dev.get('address') or '-'} ({dev.get('timezone')})")
        print(f"    updated     : {_ts(dev.get('updateTime'))}")
        print()


def _credentials() -> tuple[str, str]:
    user = os.environ.get("SEESTAR_USER")
    password = os.environ.get("SEESTAR_PASSWORD")
    if not user or not password:
        raise ApiError("set SEESTAR_USER and SEESTAR_PASSWORD in the environment")
    return user, password


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit the device list as JSON")
    parser.add_argument("--connect", metavar="SN", help="allocate a P2P session")
    parser.add_argument("--stop", metavar="CONID", help="release a P2P session")
    parser.add_argument(
        "--show-secrets", action="store_true", help="reveal license keys / credentials"
    )
    args = parser.parse_args()

    try:
        user, password = _credentials()
        token = login(user, password)

        # --stop: release a session and exit.
        if args.stop:
            status, body = stop_p2p(token, args.stop)
            print(f"stopP2p -> HTTP {status}")
            print(json.dumps(body, indent=2, ensure_ascii=False))
            return 0

        devices = list_devices(token)

        # --connect: allocate a session for one device and print the response.
        if args.connect:
            match = [d for d in devices if d.get("deviceSn") == args.connect]
            if not match:
                print(f"error: no device with serial {args.connect}", file=sys.stderr)
                return 1
            dev = match[0]
            src = source_id()
            status, body = online_link(
                token, args.connect, dev.get("deviceModel", ""), src
            )
            data = body.get("data") if isinstance(body, dict) else None
            if isinstance(data, dict):
                body = {**body, "data": _redact(data, args.show_secrets)}
            print(f"HTTP {status}")
            print(json.dumps(body, indent=2, ensure_ascii=False))
            return 0 if status == 200 else 1

        # plain listing: merge in per-device detail (adds remoteMode)
        for dev in devices:
            sn, model = dev.get("deviceSn"), dev.get("deviceModel")
            if sn and model:
                dev.update(
                    {k: v for k, v in device_detail(token, sn, model).items()
                     if v is not None}
                )
    except ApiError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.json:
        json.dump(devices, sys.stdout, indent=2, ensure_ascii=False)
        print()
    else:
        print_table(devices)
    return 0


if __name__ == "__main__":
    sys.exit(main())
