#!/usr/bin/env python3
"""
Export deduped shadow_would_submit rows from monotonic-capture-audit.jsonl into
sports-arb-shadows.jsonl (SportsArbPackage-shaped records).

Production already emits ~100k+ shadow probes via the daemon capture path; this
script backfills the shadow ledger file for tooling that expects PATHS.shadows.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def ledger_bucket(cost: float) -> str:
    if cost < 1.0:
        return "<1.000"
    if cost <= 1.005:
        return "1.000-1.005"
    if cost <= 1.02:
        return "1.005-1.02"
    if cost <= 1.05:
        return "1.02-1.05"
    if cost <= 1.10:
        return "1.05-1.10"
    if cost <= 1.16:
        return "1.10-1.16"
    if cost <= 1.25:
        return "1.16-1.25"
    return "1.25-2.00"


def shadow_row_from_capture(row: dict[str, Any]) -> dict[str, Any] | None:
    ws = row.get("ws") or {}
    package_id = ws.get("packageId")
    if not package_id:
        return None
    strategy = row.get("strategy") or {}
    cost = float(ws.get("cost") or 0)
    sizing = row.get("sizing") or {}
    shares = float(sizing.get("shares") or ws.get("availableSize") or 0)
    broad = ws.get("broad") or {}
    narrow = ws.get("narrow") or {}
    sport_id = strategy.get("sportId") or ws.get("asset") or "UNKNOWN"
    now = row.get("terminalAt") or row.get("observedAt")
    return {
        "recordedAt": now,
        "package": {
            "packageId": package_id,
            "idempotencyKey": row.get("captureId", package_id)[:24],
            "status": "shadow_open",
            "mode": "shadow",
            "shadowPurpose": strategy.get("shadowPurpose") or "excluded_shape_probe",
            "sport": {
                "sportId": sport_id,
                "adapterVersion": "capture-export-v1",
            },
            "event": {
                "slug": ws.get("eventSlug"),
                "title": ws.get("eventTitle"),
            },
            "strategy": {
                "marketType": strategy.get("marketType", "unknown"),
                "lineFamily": strategy.get("lineFamily", "?"),
                "middleWidth": strategy.get("middleWidth"),
                "costBucket": strategy.get("costBucket") or ledger_bucket(cost),
                "comparisonGroup": strategy.get("comparisonGroup"),
                "liveGateFailed": strategy.get("gateFailures") or [],
                "wouldHaveQualifiedExceptFor": strategy.get("gateFailures") or None,
            },
            "legs": {
                "broad": {
                    "marketId": broad.get("marketId"),
                    "question": broad.get("question"),
                    "tokenId": broad.get("yesTokenId"),
                    "side": "YES",
                    "strike": broad.get("strike"),
                    "ask": broad.get("yesAsk"),
                },
                "narrow": {
                    "marketId": narrow.get("marketId"),
                    "question": narrow.get("question"),
                    "tokenId": narrow.get("noTokenId"),
                    "side": "NO",
                    "strike": narrow.get("strike"),
                    "ask": narrow.get("noAsk"),
                },
            },
            "pricing": {
                "packageCost": cost,
                "lockedEdge": ws.get("lockedEdge"),
                "availableShares": shares,
                "maxSpread": ws.get("maxSpread"),
            },
            "sizing": {
                "targetUsd": sizing.get("cost"),
                "intendedShares": shares,
            },
            "timestamps": {"created": now, "updated": now, "discovered": row.get("observedAt")},
            "metadataSnapshotId": f"capture:{row.get('captureId')}",
            "captureMeta": {
                "terminalStatus": row.get("terminalStatus"),
                "shadow": row.get("shadow"),
                "abTestArm": row.get("abTestArm"),
                "reason": row.get("reason"),
            },
            "resolution": {"status": "unresolved", "payoutPerShare": 0, "source": "pending_polymarket_resolution"},
        },
    }


def export_shadows(audit_path: Path, out_path: Path, *, sports_only: bool) -> dict[str, Any]:
    best: dict[str, dict[str, Any]] = {}
    rows_read = 0
    for line in audit_path.open(errors="replace"):
        rows_read += 1
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("terminalStatus") != "shadow_would_submit":
            continue
        ws = row.get("ws") or {}
        if sports_only and ws.get("asset") not in {"SOCCER", "MLB"}:
            continue
        package_id = ws.get("packageId")
        if not package_id:
            continue
        cost = float(ws.get("cost") or 99)
        prev = best.get(package_id)
        if prev is None or cost < float((prev.get("ws") or {}).get("cost") or 99):
            best[package_id] = row

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w") as handle:
        for row in best.values():
            exported = shadow_row_from_capture(row)
            if exported:
                handle.write(json.dumps(exported, sort_keys=True) + "\n")

    return {
        "audit": str(audit_path),
        "output": str(out_path),
        "rowsRead": rows_read,
        "uniqueShadowPackages": len(best),
        "sportsOnly": sports_only,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Export capture-audit shadow_would_submit rows to sports-arb-shadows.jsonl")
    parser.add_argument("--audit", default="/var/lib/sports-arb/data/monotonic-capture-audit.jsonl")
    parser.add_argument("--out", default="/var/lib/sports-arb/data/sports-arb-shadows.jsonl")
    parser.add_argument("--all-sports", action="store_true", help="Include non SOCCER/MLB assets")
    args = parser.parse_args()
    summary = export_shadows(Path(args.audit), Path(args.out), sports_only=not args.all_sports)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
