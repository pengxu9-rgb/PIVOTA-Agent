#!/usr/bin/env python3

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List


DEFAULT_STAGES = [
    "decode",
    "face",
    "skin_roi",
    "quality",
    "detector",
    "postprocess",
    "llm",
    "render",
]


def fmt_ms(x: float) -> str:
    return f"{x:8.2f} ms"


def mean(values: List[float]) -> float:
    if not values:
        return 0.0
    return float(sum(values)) / float(len(values))


def run_node(
    images: List[str],
    lang: str,
    repeat: int,
    qc: str,
    primary: str,
    detector: str,
    degraded_mode: str,
) -> Dict[str, Any]:
    cmd = [
        "node",
        "scripts/bench-skin-analyze.cjs",
        "--lang",
        lang,
        "--repeat",
        str(repeat),
        "--qc",
        qc,
        "--primary",
        primary,
        "--detector",
        detector,
    ]
    if degraded_mode:
        cmd.extend(["--degraded-mode", degraded_mode])
    cmd.append("--")
    cmd.extend(images)
    proc = subprocess.run(
        cmd,
        cwd=str(Path(__file__).resolve().parents[1]),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ},
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "node bench failed")
    return json.loads(proc.stdout)


def stage_ms_from_report(report: Dict[str, Any], stage: str) -> float:
    stages = report.get("stages") or []
    for s in stages:
        if s.get("name") == stage:
            try:
                return float(s.get("ms") or 0.0)
            except Exception:
                return 0.0
    return 0.0


def main() -> int:
    parser = argparse.ArgumentParser(description="Profile hotspot stages for skin analysis (mean ms over N runs).")
    parser.add_argument("--lang", default="EN", choices=["EN", "CN"])
    parser.add_argument("--repeat", type=int, default=50)
    parser.add_argument("--qc", default="pass", choices=["pass", "degraded", "fail", "unknown"])
    parser.add_argument("--primary", default="routine", choices=["routine", "logs", "none"])
    parser.add_argument("--detector", default="auto", choices=["auto", "high", "medium", "low"])
    parser.add_argument("--degraded-mode", dest="degraded_mode", default="", choices=["", "report", "vision"])
    parser.add_argument("images", nargs="*", help="Optional image paths (if empty, uses a deterministic synthetic image).")
    args = parser.parse_args()

    repeat = max(1, min(500, int(args.repeat)))
    payload = run_node(
        images=list(args.images or []),
        lang=args.lang,
        repeat=repeat,
        qc=args.qc,
        primary=args.primary,
        detector=args.detector,
        degraded_mode=args.degraded_mode,
    )

    results = payload.get("results") or []
    totals = [float((r.get("report") or {}).get("total_ms") or 0.0) for r in results]

    print("== profile_hotspots ==")
    print(f"schema_version: {payload.get('schema_version')}")
    print(f"generated_at : {payload.get('generated_at')}")
    print(f"lang         : {payload.get('lang')}")
    print(f"repeat       : {payload.get('repeat')}")
    print(f"qc           : {payload.get('qc')}")
    print(f"primary      : {payload.get('primary')}")
    print(f"detector     : {payload.get('detector')}")
    print(f"images       : {', '.join(payload.get('images') or [])}")
    print()

    print("== mean latency ==")
    print(f"total mean: {fmt_ms(mean(totals))}")
    print()

    rows = []
    for stage in DEFAULT_STAGES:
        values = [stage_ms_from_report(r.get("report") or {}, stage) for r in results]
        rows.append((stage, mean(values)))

    rows.sort(key=lambda x: x[1], reverse=True)

    print("== mean stage breakdown (ms) ==")
    print(f"{'stage':<12} {'mean':>12}")
    for stage, ms in rows:
        print(f"{stage:<12} {fmt_ms(ms)}")
    print()

    slowest = rows[0] if rows else None
    if slowest:
        print(f"slowest mean stage: {slowest[0]} ({fmt_ms(slowest[1])})")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
