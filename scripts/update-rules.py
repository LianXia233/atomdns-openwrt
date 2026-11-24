#!/usr/bin/env python3
"""Refresh the bundled sing-box rule sets (srs/*.srs) from their descriptor URLs.

Every srs/*.json ships one or more descriptors like:

    {"name": "geosite_cn", "type": "geositecn", "files": "srs/geosite-cn.srs",
     "url": "https://.../cn.srs", "enabled": true, ...}

This script downloads each enabled URL, validates the SRS payload, atomically
replaces the file when the content changed, and updates last_updated. Downloads
are fail-soft: a failed rule keeps the bundled file and only logs a warning, so
a flaky upstream never blocks a release (set RULES_STRICT=1 to fail instead).

A build record is written to webinfo/rules-updated.json.
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import sys
import urllib.request
from datetime import datetime, timezone

USER_AGENT = "atomdns-openwrt-builder/1.0"
MIN_SRS_BYTES = 1024


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: update-rules.py <config-dir>", file=sys.stderr)
        return 2
    config = pathlib.Path(sys.argv[1]).resolve()
    srs_dir = config / "srs"
    if not srs_dir.is_dir():
        print(f"no srs directory in {config}", file=sys.stderr)
        return 2

    records: list[dict] = []
    warnings = 0

    for descriptor in sorted(srs_dir.glob("*.json")):
        if descriptor.name == "rules-updated.json":
            continue
        try:
            entries = json.loads(descriptor.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001 - report and keep going
            print(f"WARN {descriptor.name}: {exc}", file=sys.stderr)
            warnings += 1
            continue
        if not isinstance(entries, list):
            continue

        dirty = False
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            url = entry.get("url")
            rel = entry.get("files")
            if not entry.get("enabled", True) or not url or not rel:
                continue

            target = (config / rel).resolve()
            try:
                target.relative_to(config)
            except ValueError:
                print(f"WARN {descriptor.name}: unsafe path {rel}", file=sys.stderr)
                warnings += 1
                continue

            name = entry.get("name") or target.name
            try:
                data = fetch(str(url))
            except Exception as exc:  # noqa: BLE001 - fail soft
                print(f"WARN {name}: download failed: {exc}", file=sys.stderr)
                warnings += 1
                continue

            if len(data) < MIN_SRS_BYTES or data[:3] != b"SRS":
                print(
                    f"WARN {name}: invalid SRS payload ({len(data)} bytes)",
                    file=sys.stderr,
                )
                warnings += 1
                continue

            old = target.read_bytes() if target.exists() else b""
            changed = sha256(old) != sha256(data)
            if changed:
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = target.with_name(target.name + ".tmp")
                temporary.write_bytes(data)
                os.replace(temporary, target)
                entry["last_updated"] = datetime.now(timezone.utc).isoformat(
                    timespec="seconds"
                )
                dirty = True

            records.append(
                {
                    "name": name,
                    "url": str(url),
                    "file": rel,
                    "bytes": len(data),
                    "sha256": sha256(data),
                    "changed": changed,
                }
            )
            print(
                f"rules: {'updated  ' if changed else 'unchanged'} {name} "
                f"{len(data)} bytes sha256={sha256(data)[:12]}"
            )

        if dirty:
            descriptor.write_text(
                json.dumps(entries, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )

    record = {
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": records,
        "warnings": warnings,
    }
    webinfo = config / "webinfo"
    webinfo.mkdir(parents=True, exist_ok=True)
    (webinfo / "rules-updated.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    print(f"rules: {len(records)} checked, {warnings} warning(s)")
    if warnings and os.environ.get("RULES_STRICT") == "1":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
