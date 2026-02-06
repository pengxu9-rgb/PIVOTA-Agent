#!/usr/bin/env python3

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


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


def percentile(values: List[float], p: float) -> float:
    if not values:
        return 0.0
    if p <= 0:
        return float(min(values))
    if p >= 100:
        return float(max(values))
    s = sorted(values)
    k = (len(s) - 1) * (p / 100.0)
    f = int(k)
    c = min(f + 1, len(s) - 1)
    if f == c:
        return float(s[f])
    d0 = s[f] * (c - k)
    d1 = s[c] * (k - f)
    return float(d0 + d1)


def fmt_ms(x: float) -> str:
    return f"{x:8.2f} ms"


def collect_images(paths: List[str]) -> List[str]:
    exts = {".jpg", ".jpeg", ".png", ".webp"}
    out: List[str] = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            for child in sorted(p.rglob("*")):
                if child.is_file() and child.suffix.lower() in exts:
                    out.append(str(child))
        elif p.is_file() and p.suffix.lower() in exts:
            out.append(str(p))
    return out


def run_node_bench(
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


def llm_tokens_from_report(report: Dict[str, Any]) -> Tuple[int, int, int]:
    calls = report.get("llm_calls") or []
    prompt_total = 0
    completion_total = 0
    total_total = 0
    for c in calls:
        usage = (c or {}).get("usage") or {}
        try:
            prompt_total += int(usage.get("prompt_tokens") or 0)
        except Exception:
            pass
        try:
            completion_total += int(usage.get("completion_tokens") or 0)
        except Exception:
            pass
        try:
            total_total += int(usage.get("total_tokens") or 0)
        except Exception:
            pass
    if total_total == 0:
        total_total = prompt_total + completion_total
    return (prompt_total, completion_total, total_total)


def summarize(payload: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    results = payload.get("results") or []
    total = [float((r.get("report") or {}).get("total_ms") or 0.0) for r in results]
    ok_count = sum(1 for r in results if r.get("ok"))
    fail_count = max(0, len(results) - ok_count)
    llm_calls = sum(int(((r.get("report") or {}).get("llm_summary") or {}).get("calls") or 0) for r in results)
    llm_prompt_tokens = 0
    llm_completion_tokens = 0
    llm_total_tokens = 0
    for r in results:
        p, c, t = llm_tokens_from_report(r.get("report") or {})
        llm_prompt_tokens += p
        llm_completion_tokens += c
        llm_total_tokens += t

    # LLM output validity (schema/self-check), as reported by the node bench.
    vision_called = 0
    vision_ok = 0
    report_called = 0
    report_ok = 0
    report_output_chars: List[int] = []
    for r in results:
        outcomes = r.get("llm_outcomes") or {}
        v = outcomes.get("vision") or {}
        if v.get("called"):
            vision_called += 1
            if v.get("ok"):
                vision_ok += 1
        rep = outcomes.get("report") or {}
        if rep.get("called"):
            report_called += 1
            if rep.get("ok"):
                report_ok += 1
            try:
                report_output_chars.append(int(rep.get("output_chars") or 0))
            except Exception:
                pass

    stage_rows = []
    for stage in DEFAULT_STAGES:
        values = [stage_ms_from_report(r.get("report") or {}, stage) for r in results]
        stage_rows.append(
            {
                "stage": stage,
                "p50": percentile(values, 50),
                "p95": percentile(values, 95),
            }
        )

    slowest = max(stage_rows, key=lambda x: x["p95"] or 0.0) if stage_rows else None

    summary = {
        "n": len(results),
        "ok": ok_count,
        "failed": fail_count,
        "failure_rate": (fail_count / len(results)) if results else 0.0,
        "llm_calls": llm_calls,
        "llm_prompt_tokens": llm_prompt_tokens,
        "llm_completion_tokens": llm_completion_tokens,
        "llm_total_tokens": llm_total_tokens,
        "llm_outcomes": {
            "vision": {
                "called": vision_called,
                "ok": vision_ok,
                "schema_failure_rate": (0.0 if vision_called == 0 else float(vision_called - vision_ok) / float(vision_called)),
            },
            "report": {
                "called": report_called,
                "ok": report_ok,
                "schema_failure_rate": (0.0 if report_called == 0 else float(report_called - report_ok) / float(report_called)),
                "output_chars_p50": percentile([float(x) for x in report_output_chars], 50) if report_output_chars else 0.0,
                "output_chars_p95": percentile([float(x) for x in report_output_chars], 95) if report_output_chars else 0.0,
            },
        },
        "total_p50": percentile(total, 50),
        "total_p95": percentile(total, 95),
        "stage_rows": stage_rows,
        "slowest_stage_p95": slowest,
    }
    return ("", summary)


def print_report(payload: Dict[str, Any], summary: Dict[str, Any]) -> None:
    print("== bench_analyze ==")
    print(f"schema_version: {payload.get('schema_version')}")
    print(f"generated_at : {payload.get('generated_at')}")
    print(f"lang         : {payload.get('lang')}")
    print(f"repeat       : {payload.get('repeat')}")
    if payload.get("qc") is not None:
        print(f"qc           : {payload.get('qc')}")
    if payload.get("primary") is not None:
        print(f"primary      : {payload.get('primary')}")
    if payload.get("detector") is not None:
        print(f"detector     : {payload.get('detector')}")
    if payload.get("degraded_mode") is not None:
        print(f"degraded_mode: {payload.get('degraded_mode')}")
    print(f"images       : {', '.join(payload.get('images') or [])}")
    print("")

    print("== overall ==")
    print(f"n        : {summary['n']}")
    print(f"ok       : {summary['ok']}")
    print(f"failed   : {summary['failed']} ({summary['failure_rate']*100:.1f}%)")
    print(f"llm_calls: {summary['llm_calls']} (skips ok; 0 means no keys or disabled)")
    if summary.get("llm_total_tokens") or summary.get("llm_prompt_tokens") or summary.get("llm_completion_tokens"):
        print(
            f"llm_tokens: total={summary['llm_total_tokens']} prompt={summary['llm_prompt_tokens']} completion={summary['llm_completion_tokens']}"
        )
    print(f"total p50: {fmt_ms(summary['total_p50'])}")
    print(f"total p95: {fmt_ms(summary['total_p95'])}")
    if summary.get("slowest_stage_p95"):
        s = summary["slowest_stage_p95"]
        print(f"slowest (p95): {s['stage']} {fmt_ms(s['p95'])}")
    print("")

    outcomes = summary.get("llm_outcomes") or {}
    if outcomes:
        v = outcomes.get("vision") or {}
        r = outcomes.get("report") or {}
        if v.get("called") or r.get("called"):
            print("== llm outcomes (schema validity) ==")
            print(f"vision called: {int(v.get('called') or 0)} ok: {int(v.get('ok') or 0)} fail_rate: {(float(v.get('schema_failure_rate') or 0.0)*100):.1f}%")
            print(
                f"report called: {int(r.get('called') or 0)} ok: {int(r.get('ok') or 0)} fail_rate: {(float(r.get('schema_failure_rate') or 0.0)*100):.1f}%"
            )
            if r.get("called"):
                print(f"report output chars p50/p95: {int(r.get('output_chars_p50') or 0)}/{int(r.get('output_chars_p95') or 0)}")
            print("")

    print("== stage breakdown (ms) ==")
    print(f"{'stage':12} {'p50':>10} {'p95':>10}")
    for row in summary["stage_rows"]:
        print(f"{row['stage']:12} {row['p50']:10.2f} {row['p95']:10.2f}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="*", help="Image files/dirs (.jpg/.png/.webp). If empty, uses an embedded tiny image.")
    ap.add_argument("--lang", default="EN", choices=["EN", "CN"], help="Output language for the analysis pipeline.")
    ap.add_argument("--repeat", type=int, default=5, help="Repeat count per image (for latency distribution).")
    ap.add_argument("--qc", default="pass", choices=["pass", "degraded", "fail", "unknown"], help="Simulated photo QC grade.")
    ap.add_argument("--primary", default="routine", choices=["routine", "logs", "none"], help="Simulated primary inputs.")
    ap.add_argument("--detector", default="auto", choices=["auto", "low", "medium", "high"], help="Detector confidence override.")
    ap.add_argument("--degraded-mode", dest="degraded_mode", default="", choices=["", "report", "vision"], help="Degraded-mode override.")
    ap.add_argument("--out", default="", help="Optional path to write raw JSON results.")
    args = ap.parse_args()

    images = collect_images(args.paths)
    payload = run_node_bench(
        images,
        args.lang,
        max(1, min(200, args.repeat)),
        args.qc,
        args.primary,
        args.detector,
        args.degraded_mode,
    )
    _, summary = summarize(payload)
    print_report(payload, summary)

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps({"payload": payload, "summary": summary}, ensure_ascii=False, indent=2))
        print(f"\nwrote: {out_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
