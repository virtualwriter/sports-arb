#!/usr/bin/env python3
"""Join live daemon fills to continuous scan/backtest CSV.

For each live fill:
  - link packageId row in monotonic-chronological-packages-continuous.csv
  - attach stream min/max cost from middle-audit + candidate-snapshots
  - find cheaper scanned siblings on the same event + shape
  - optional capture-audit terminalStatus counts

Writes:
  - analysis/live-scan-join.json
  - analysis/live-scan-join.md
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from shape_roi_best_worst import (
    classify_shape,
    classify_shape_from_audit,
    load_gamma_cache,
    market_meta,
    parse_package_id,
    stream_cost_bounds,
)

DEFAULT_STREAM_PATHS = [
    "monotonic-candidate-snapshots.jsonl",
    "monotonic-candidate-snapshots.jsonl.dublin-postcutover-backup",
    "monotonic-middle-audit.jsonl",
    "monotonic-middle-audit.jsonl.1",
    "monotonic-middle-audit.jsonl.2.gz",
]


def event_slug(package_id: str) -> str:
    return package_id.split("::", 1)[0] if "::" in package_id else package_id


def shape_from_strikes(asset: str, broad: float, narrow: float, labels: str = "") -> tuple[str, str, int] | None:
    lo, hi = min(broad, narrow), max(broad, narrow)
    width = int(round(hi - lo))
    family = f"{lo:g}-{hi:g}"
    text = labels.lower()
    if "team total" in text:
        market_type = "team_total"
    elif "spread" in text:
        market_type = "spread"
    elif asset == "SOCCER":
        market_type = "match_total" if ("o/u" in text or "over/under" in text or "total" in text) else "unknown"
    elif asset == "MLB":
        market_type = "game_total" if ("o/u" in text or "over/under" in text or "total" in text) else "match_total"
    else:
        market_type = "unknown"
    if market_type == "unknown" and asset in {"SOCCER", "MLB"}:
        market_type = "match_total" if asset == "SOCCER" else "game_total"
    return market_type, family, width


def classify_package(
    package_id: str,
    asset: str,
    cache: dict[str, dict[str, Any]],
    bounds: dict[str, dict[str, Any]],
    *,
    broad_strike: float | None = None,
    narrow_strike: float | None = None,
    leg_labels: str = "",
) -> tuple[str, str, int] | None:
    sample = bounds.get(package_id, {}).get("sample")
    if sample:
        audited = classify_shape_from_audit(asset, sample)
        if audited:
            return audited
    parsed = parse_package_id(package_id)
    if parsed:
        shape = classify_shape(asset, market_meta(cache, parsed[0]), market_meta(cache, parsed[1]))
        if shape:
            return shape
    if broad_strike is not None and narrow_strike is not None:
        return shape_from_strikes(asset, broad_strike, narrow_strike, leg_labels)
    return None


def sibling_group_key(event: str, asset: str, market_type: str, family: str) -> str:
    # Soccer O/U ladders share line families across market_type labels; group by family.
    if asset == "SOCCER" and family:
        return f"{event}|{asset}|{family}"
    return f"{event}|{asset}|{market_type}|{family}"


def load_daemon_live(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    data = json.loads(path.read_text())
    return data if isinstance(data, list) else []


def ledger_row_key(row: dict[str, Any]) -> str:
    return str(row.get("id") or f"{row.get('packageId', 'unknown')}::{row.get('createdAt', '')}")


def load_archived_packages(archive_dir: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not archive_dir.exists():
        return rows
    for path in sorted(archive_dir.glob("*.json")):
        try:
            parsed = json.loads(path.read_text())
        except json.JSONDecodeError:
            continue
        records = parsed if isinstance(parsed, list) else []
        for record in records:
            if not isinstance(record, dict):
                continue
            for pkg in record.get("packages") or []:
                if isinstance(pkg, dict):
                    rows.append(pkg)
    return rows


def load_combined_ledger(live_path: Path, archive_dir: Path | None = None) -> list[dict[str, Any]]:
    by_key: dict[str, dict[str, Any]] = {}
    if archive_dir is not None:
        for row in load_archived_packages(archive_dir):
            by_key[ledger_row_key(row)] = row
    for row in load_daemon_live(live_path):
        by_key[ledger_row_key(row)] = row
    return list(by_key.values())


def daemon_fill_row(row: dict[str, Any]) -> dict[str, Any] | None:
    status = row.get("status")
    if status not in {"package_complete", "sold"}:
        return None
    asset = str(row.get("asset") or "").upper()
    if asset not in {"SOCCER", "MLB"}:
        return None
    package_id = str(row.get("packageId") or "")
    if not package_id:
        return None
    prices = row.get("prices") or {}
    gate_cost = float(prices.get("packageCost") or 0)
    shares = float(row.get("filledShares") or 0)
    actual_cost = float(row.get("actualCost") or 0)
    fill_cost = actual_cost / shares if shares > 0 else gate_cost
    eq = row.get("executionQuote") or {}
    legs = row.get("packageLegs") or []
    leg_labels = " ".join(str(leg.get("instrumentLabel") or "") for leg in legs)
    return {
        "ledgerId": row.get("id"),
        "packageId": package_id,
        "event": row.get("eventSlug") or event_slug(package_id),
        "asset": asset,
        "submittedAt": row.get("createdAt"),
        "status": status,
        "broadStrike": row.get("broadStrike"),
        "narrowStrike": row.get("narrowStrike"),
        "gateCost": round(gate_cost, 4),
        "fillCost": round(fill_cost, 4),
        "filledShares": shares,
        "executionQuote": eq,
        "legLabels": leg_labels,
    }


def load_csv_index(path: Path) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    with path.open(newline="") as handle:
        for row in csv.DictReader(handle):
            pid = row.get("packageId")
            if pid:
                out[pid] = row
    return out


def summarize_capture_audit(path: Path, package_ids: set[str], events: set[str]) -> dict[str, dict[str, int]]:
    if not path.exists():
        return {}
    counts: dict[str, Counter[str]] = defaultdict(Counter)
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", errors="replace") as handle:
        for line in handle:
            if not any(token in line for token in events):
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            pid = str(row.get("packageId") or "")
            if pid not in package_ids:
                continue
            status = str(row.get("terminalStatus") or "?")
            counts[pid][status] += 1
    return {pid: dict(counter) for pid, counter in counts.items()}


def shape_key(asset: str, market_type: str, family: str) -> str:
    return f"{asset}|{market_type}|{family}"


def build_sibling_index(
    csv_index: dict[str, dict[str, str]],
    cache: dict[str, dict[str, Any]],
    bounds: dict[str, dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    by_event_shape: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for package_id, row in csv_index.items():
        asset = row.get("asset") or ""
        if asset not in {"SOCCER", "MLB"}:
            continue
        shape = classify_package(package_id, asset, cache, bounds)
        if not shape:
            continue
        market_type, family, width = shape
        slot = bounds.get(package_id)
        csv_cost = float(row.get("cost") or 0)
        best = slot["min"] if slot else csv_cost
        worst = slot["max"] if slot else csv_cost
        payout = row.get("payoutMultiple") or ""
        entry = {
            "packageId": package_id,
            "event": event_slug(package_id),
            "csvCost": csv_cost,
            "bestObserved": best,
            "worstObserved": worst,
            "payoutMultiple": payout or None,
            "resolved": payout in {"1", "2"},
            "outcome": "middle" if payout == "2" else ("floor" if payout == "1" else None),
            "firstObserved": (row.get("firstObserved") or "")[:19],
            "shape": {"marketType": market_type, "lineFamily": family, "middleWidth": width},
        }
        key = sibling_group_key(entry["event"], asset, market_type, family)
        by_event_shape[key].append(entry)
    for siblings in by_event_shape.values():
        siblings.sort(key=lambda item: item["bestObserved"])
    return by_event_shape


def pick_cheaper_siblings(
    siblings: list[dict[str, Any]],
    *,
    fill_cost: float,
    traded_package_id: str,
    limit: int = 5,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for sib in siblings:
        if sib["packageId"] == traded_package_id:
            continue
        if sib["bestObserved"] + 1e-9 < fill_cost:
            out.append({
                **sib,
                "cheaperThanFillBy": round((fill_cost - sib["bestObserved"]) * 100, 2),
            })
        if len(out) >= limit:
            break
    return out


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Live fill ↔ scan join",
        "",
        f"Generated: {report['generatedAt']}",
        f"Continuous CSV: `{report['packagesCsv']}`",
        f"Live ledger: `{report['liveLedger']}`",
        "",
        "## Summary",
        "",
        f"- Live fill rows: **{report['summary']['liveFillRows']}**",
        f"- Unique live packageIds: **{report['summary']['uniquePackageIds']}**",
        f"- In continuous CSV: **{report['summary']['inContinuousCsv']}**",
        f"- Missing from CSV: **{report['summary']['missingFromCsv']}**",
        f"- Unresolved at join time: **{report['summary']['unresolved']}**",
        f"- Fills with cheaper scanned sibling: **{report['summary']['fillsWithCheaperSibling']}**",
        "",
        "## Live fills",
        "",
        "| Submitted | Event | Shape | Fill | Stream best | Stream worst | Cheapest sib | Δ¢ | Resolved |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for fill in report["liveFills"]:
        shape = fill.get("shape") or {}
        shape_label = f"{shape.get('lineFamily', '?')} ({shape.get('marketType', '?')})"
        cheapest = fill.get("cheapestSibling")
        cheap_cost = f"{cheapest['bestObserved']:.3f}" if cheapest else "—"
        delta = f"{fill.get('cheaperSiblingGapCents', 0):.1f}" if cheapest else "—"
        resolved = fill.get("outcome") or "pending"

        def fmt_cost(value: Any) -> str:
            return f"{float(value):.3f}" if value is not None else "—"

        lines.append(
            f"| {str(fill.get('submittedAt') or '')[:19]} "
            f"| `{fill.get('event', '')[:28]}` "
            f"| {shape_label} "
            f"| {fmt_cost(fill.get('fillCost'))} "
            f"| {fmt_cost(fill.get('bestObserved'))} "
            f"| {fmt_cost(fill.get('worstObserved'))} "
            f"| {cheap_cost} "
            f"| {delta} "
            f"| {resolved} |"
        )

    lines.extend(["", "## Per-event cheapest scanned vs what you paid", ""])
    for event_report in report["eventReports"]:
        lines.append(f"### `{event_report['event']}`")
        lines.append("")
        lines.append(
            f"- Shape **{event_report['shape']['lineFamily']}** "
            f"({event_report['shape']['marketType']})"
        )
        lines.append(f"- Scanned packages in CSV: **{event_report['scannedPackages']}**")
        lines.append(f"- Live fills on this event: **{event_report['liveFillCount']}**")
        if event_report.get("cheapestScanned"):
            c = event_report["cheapestScanned"]
            lines.append(
                f"- Cheapest scanned: **${c['bestObserved']:.3f}** "
                f"(`{c['packageId']}`)"
            )
        if event_report.get("yourFill"):
            y = event_report["yourFill"]
            lines.append(f"- What you paid: **${y['fillCost']:.3f}** (`{y['packageId']}`)")
            if event_report.get("overpayCents") is not None:
                lines.append(f"- Over cheapest scanned by: **{event_report['overpayCents']:.1f}¢**")
        lines.append("")

    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Join live fills to continuous scan/backtest CSV.")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--packages", default="analysis/monotonic-chronological-packages-continuous.csv")
    parser.add_argument("--gamma-cache", default="analysis/gamma-market-cache-v2.json")
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("SPORTS_ARB_DATA_DIR", "data"),
        help="Ledger root (default: $SPORTS_ARB_DATA_DIR or repo data/)",
    )
    parser.add_argument("--live", help="Override live ledger path")
    parser.add_argument("--capture-audit", action="store_true", help="Scan capture-audit for live packageIds")
    parser.add_argument("--json-out", default="analysis/live-scan-join.json")
    parser.add_argument("--md-out", default="analysis/live-scan-join.md")
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    data_dir = Path(args.data_dir)
    if not data_dir.is_absolute():
        data_dir = (repo_root / data_dir).resolve()
    packages_path = repo_root / args.packages
    gamma_path = repo_root / args.gamma_cache
    live_path = Path(args.live) if args.live else data_dir / "polymarket-live-packages.json"
    json_out = repo_root / args.json_out
    md_out = repo_root / args.md_out

    cache = load_gamma_cache(gamma_path)
    stream_paths = [data_dir / name for name in DEFAULT_STREAM_PATHS]
    bounds = stream_cost_bounds(stream_paths)
    csv_index = load_csv_index(packages_path)
    sibling_index = build_sibling_index(csv_index, cache, bounds)

    raw_live = load_combined_ledger(live_path, data_dir / "archive")
    live_rows = [row for row in (daemon_fill_row(item) for item in raw_live) if row]
    live_rows.sort(key=lambda row: str(row.get("submittedAt") or ""))

    package_ids = {row["packageId"] for row in live_rows}
    events = {row["event"] for row in live_rows}
    capture_counts: dict[str, dict[str, int]] = {}
    if args.capture_audit:
        capture_counts = summarize_capture_audit(data_dir / "monotonic-capture-audit.jsonl", package_ids, events)

    joined: list[dict[str, Any]] = []
    event_reports: dict[str, dict[str, Any]] = {}

    for fill in live_rows:
        package_id = fill["packageId"]
        csv_row = csv_index.get(package_id)
        shape = classify_package(
            package_id,
            fill["asset"],
            cache,
            bounds,
            broad_strike=float(fill["broadStrike"]) if fill.get("broadStrike") is not None else None,
            narrow_strike=float(fill["narrowStrike"]) if fill.get("narrowStrike") is not None else None,
            leg_labels=fill.get("legLabels") or "",
        )
        market_type, family, width = shape if shape else ("unknown", "unknown", 0)
        slot = bounds.get(package_id)
        csv_cost = float(csv_row.get("cost") or 0) if csv_row else None
        best = slot["min"] if slot else csv_cost
        worst = slot["max"] if slot else csv_cost
        payout = (csv_row or {}).get("payoutMultiple") or ""
        sib_key = sibling_group_key(fill["event"], fill["asset"], market_type, family)
        siblings = sibling_index.get(sib_key, [])
        cheaper = pick_cheaper_siblings(
            siblings,
            fill_cost=fill["fillCost"],
            traded_package_id=package_id,
        )
        cheapest = cheaper[0] if cheaper else None
        gap_cents = round((fill["fillCost"] - cheapest["bestObserved"]) * 100, 2) if cheapest else None

        entry = {
            **fill,
            "inContinuousCsv": csv_row is not None,
            "liveTraded": True,
            "shape": {
                "marketType": market_type,
                "lineFamily": family,
                "middleWidth": width,
            },
            "csvCost": csv_cost,
            "bestObserved": best,
            "worstObserved": worst,
            "hasStreamBounds": slot is not None,
            "payoutMultiple": payout or None,
            "resolved": payout in {"1", "2"},
            "outcome": "middle" if payout == "2" else ("floor" if payout == "1" else None),
            "cheapestSibling": cheapest,
            "cheaperSiblings": cheaper,
            "cheaperSiblingGapCents": gap_cents,
            "captureAudit": capture_counts.get(package_id),
        }
        joined.append(entry)

        ev_key = f"{fill['event']}|{family}|{market_type}"
        if ev_key not in event_reports and shape:
            cheapest_scanned = siblings[0] if siblings else None
            event_reports[ev_key] = {
                "event": fill["event"],
                "shape": {"marketType": market_type, "lineFamily": family, "middleWidth": width},
                "scannedPackages": len(siblings),
                "liveFillCount": 0,
                "cheapestScanned": cheapest_scanned,
                "yourFill": None,
                "overpayCents": None,
            }
        if shape and ev_key in event_reports:
            event_reports[ev_key]["liveFillCount"] += 1
            current = event_reports[ev_key]["yourFill"]
            if current is None or fill["fillCost"] > current["fillCost"]:
                event_reports[ev_key]["yourFill"] = {
                    "packageId": package_id,
                    "fillCost": fill["fillCost"],
                }
            cheapest_scanned = event_reports[ev_key]["cheapestScanned"]
            if cheapest_scanned and event_reports[ev_key]["yourFill"]:
                event_reports[ev_key]["overpayCents"] = round(
                    (event_reports[ev_key]["yourFill"]["fillCost"] - cheapest_scanned["bestObserved"]) * 100,
                    2,
                )

    enriched_csv = []
    live_pid_set = package_ids
    for package_id, row in csv_index.items():
        if package_id not in live_pid_set:
            continue
        enriched_csv.append({
            "packageId": package_id,
            "liveTraded": True,
            "cost": row.get("cost"),
            "payoutMultiple": row.get("payoutMultiple") or None,
            "firstObserved": row.get("firstObserved"),
        })

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "packagesCsv": str(packages_path),
        "liveLedger": str(live_path),
        "summary": {
            "liveFillRows": len(joined),
            "uniquePackageIds": len(package_ids),
            "inContinuousCsv": sum(1 for row in joined if row["inContinuousCsv"]),
            "missingFromCsv": sum(1 for row in joined if not row["inContinuousCsv"]),
            "unresolved": sum(1 for row in joined if not row["resolved"]),
            "fillsWithCheaperSibling": sum(1 for row in joined if row.get("cheapestSibling")),
        },
        "liveFills": joined,
        "continuousCsvLiveRows": enriched_csv,
        "eventReports": sorted(event_reports.values(), key=lambda item: item["event"]),
    }

    json_out.parent.mkdir(parents=True, exist_ok=True)
    json_out.write_text(json.dumps(report, indent=2))
    md_out.write_text(render_markdown(report))
    print(f"[join] wrote {json_out}")
    print(f"[join] wrote {md_out}")
    print(
        f"[join] live={report['summary']['liveFillRows']} "
        f"in_csv={report['summary']['inContinuousCsv']} "
        f"cheaper_sibling={report['summary']['fillsWithCheaperSibling']}"
    )


if __name__ == "__main__":
    main()
