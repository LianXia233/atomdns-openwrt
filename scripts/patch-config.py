#!/usr/bin/env python3
"""Apply this repository's default customizations to an extracted AtomDNS config.

Idempotent. Used by build-bundle.sh so CI and local builds ship the same defaults:

1. domestic upstream group gets Tencent DoH + DoT (119.29.29.29) and concurrent=4;
2. the extra direct-DoH domains from config-extra/whitelist.txt are appended to
   rule/whitelist.txt (whitelist -> direct, domestic DNS group).
"""
from __future__ import annotations

import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
EXTRA_WHITELIST = HERE.parent / "config-extra" / "whitelist.txt"

TENCENT = [
    ("腾讯DOH", "https://doh.pub/dns-query", "119.29.29.29"),
    ("腾讯DOT", "tls://dot.pub", "119.29.29.29"),
]


def patch_domestic(config: pathlib.Path) -> list[str]:
    path = config / "sub_config" / "forward_local.yaml"
    text = path.read_text(encoding="utf-8")
    notes: list[str] = []

    if "tag: 腾讯DOH" not in text:
        marker = '          dial_addr: "223.5.5.5"\n'
        if marker not in text:
            raise SystemExit(f"{path}: 找不到 阿里DOH 的 dial_addr 行")
        block = "".join(
            f'        - tag: {tag}\n          addr: "{addr}"\n          dial_addr: "{dial}"\n'
            for tag, addr, dial in TENCENT
        )
        text = text.replace(marker, marker + block, 1)
        notes.append("国内组 +腾讯DOH +腾讯DOT")

    start = text.find("  - tag: domestic")
    if start < 0:
        raise SystemExit(f"{path}: 找不到 domestic 组")
    end = text.find("\n  - tag:", start + 1)
    if end < 0:
        end = len(text)
    head, body = text[:start], text[start:end]
    marker = "      concurrent:"
    pos = body.find(marker)
    if pos < 0:
        raise SystemExit(f"{path}: domestic 组没有 concurrent")
    line_end = body.find("\n", pos)
    if line_end < 0:
        line_end = len(body)
    old_line = body[pos:line_end]
    if not old_line.startswith("      concurrent: 4"):
        body = body[:pos] + "      concurrent: 4" + old_line[len("      concurrent: 2"):] + body[line_end:]
        notes.append("国内组 concurrent=4")
    path.write_text(head + body + text[end:], encoding="utf-8")
    return notes


def patch_whitelist(config: pathlib.Path) -> list[str]:
    target = config / "rule" / "whitelist.txt"
    text = target.read_text(encoding="utf-8") if target.exists() else ""
    seen = {line.strip() for line in text.splitlines() if line.strip()}
    added: list[str] = []
    for line in EXTRA_WHITELIST.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and line not in seen:
            seen.add(line)
            added.append(line)
    if added:
        if text and not text.endswith("\n"):
            text += "\n"
        target.write_text(text + "\n".join(added) + "\n", encoding="utf-8")
    return added


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-config.py <config-dir>", file=sys.stderr)
        return 2
    config = pathlib.Path(sys.argv[1])
    if not (config / "sub_config" / "forward_local.yaml").is_file():
        print(f"not an AtomDNS config dir: {config}", file=sys.stderr)
        return 2

    notes = patch_domestic(config)
    added = patch_whitelist(config)

    for note in notes:
        print(f"defaults: {note}")
    if added:
        print(f"defaults: whitelist +{len(added)} 条（{', '.join(added)}）")
    if not notes and not added:
        print("defaults: 已是目标状态")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
