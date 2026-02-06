#!/usr/bin/env python3

import argparse
import asyncio
import json
import os
import socket
import subprocess
import tempfile
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

import numpy as np
from PIL import Image, ImageFilter

try:
    import httpx
except Exception:  # pragma: no cover
    httpx = None  # type: ignore


REPO_ROOT = Path(__file__).resolve().parents[1]


def _percentile(values: List[float], p: float) -> float:
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


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _clamp_u8(arr: np.ndarray) -> np.ndarray:
    return np.clip(arr, 0, 255).astype(np.uint8)


def _make_synthetic_jpeg_bytes(*, variant: str, seed: int = 42) -> bytes:
    """
    Deterministic, non-identifiable synthetic "skin-like" image for load tests.
    Tuned to pass computeSkinMask() YCrCb thresholds; variants allow degraded/fail paths.
    """
    rng = np.random.default_rng(seed)
    h = w = 384
    base = np.zeros((h, w, 3), dtype=np.float32)

    # Skin-like base (similar to scripts/perturb_stability.py).
    base[..., 0] = 155  # R
    base[..., 1] = 140  # G
    base[..., 2] = 135  # B

    xx = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :]
    yy = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None]
    shade = xx * 3.0 + yy * 2.0
    base[..., 0] += shade
    base[..., 1] += shade * 0.9
    base[..., 2] += shade * 0.8

    noise = rng.normal(0.0, 8.0, size=base.shape).astype(np.float32)
    img = _clamp_u8(base + noise)
    pil = Image.fromarray(img)

    v = (variant or "pass").strip().lower()
    if v in {"degraded", "warn", "warning"}:
        pil = pil.filter(ImageFilter.GaussianBlur(radius=1.35))
    elif v in {"fail", "failed"}:
        # Very dark => exposureFactor < 0.2 in computeQualityMetrics().
        pil = Image.new("RGB", (w, h), (30, 30, 30))

    buf = BytesIO()
    pil.save(buf, format="JPEG", quality=85, optimize=True)
    return buf.getvalue()


@dataclass(frozen=True)
class LoadTestConfig:
    duration_s: float
    concurrency: int
    request_timeout_s: float
    qc: str
    out_path: Path
    p95_budget_ms: Optional[float]


class _StubPhotoBackend(ThreadingHTTPServer):
    def __init__(self, addr: Tuple[str, int], image_bytes_by_id: Dict[str, bytes]):
        super().__init__(addr, _StubPhotoHandler)
        self.image_bytes_by_id = image_bytes_by_id


class _StubPhotoHandler(BaseHTTPRequestHandler):
    server: _StubPhotoBackend  # type: ignore[assignment]

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        # Keep load tests quiet.
        return

    def _write_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/photos/download-url":
            qs = parse_qs(parsed.query)
            upload_id = (qs.get("upload_id") or [""])[0]
            if not upload_id:
                return self._write_json(400, {"error": "missing_upload_id"})
            blob_url = f"http://127.0.0.1:{self.server.server_port}/blob/{upload_id}"
            return self._write_json(200, {"download": {"url": blob_url}, "content_type": "image/jpeg"})

        if parsed.path.startswith("/blob/"):
            photo_id = parsed.path.split("/blob/", 1)[1]
            data = self.server.image_bytes_by_id.get(photo_id)
            if data is None:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        self.send_response(404)
        self.end_headers()


def _start_stub_backend(*, qc: str) -> Tuple[_StubPhotoBackend, str]:
    port = _free_port()
    # Serve one deterministic image id; keep response sizes stable.
    image_bytes_by_id = {
        "synthetic_pass": _make_synthetic_jpeg_bytes(variant="pass"),
        "synthetic_degraded": _make_synthetic_jpeg_bytes(variant="degraded"),
        "synthetic_fail": _make_synthetic_jpeg_bytes(variant="fail"),
    }
    server = _StubPhotoBackend(("127.0.0.1", port), image_bytes_by_id=image_bytes_by_id)
    url = f"http://127.0.0.1:{port}"
    return (server, url)


def _build_request_body(qc: str) -> Dict[str, Any]:
    qc_norm = (qc or "pass").strip().lower()
    photo_id = "synthetic_pass"
    if qc_norm in {"degraded", "warn", "warning", "low"}:
        photo_id = "synthetic_degraded"
    elif qc_norm in {"fail", "failed", "bad", "reject", "rejected"}:
        photo_id = "synthetic_fail"

    return {
        "use_photo": True,
        "currentRoutine": {"am": {"cleanser": "gentle", "spf": "spf"}, "pm": {"cleanser": "gentle"}},
        "photos": [{"slot_id": "front", "photo_id": photo_id, "qc_status": qc_norm}],
    }


def _start_node_server(*, port: int, pivota_backend_base_url: str) -> Tuple[subprocess.Popen, Path]:
    env = dict(os.environ)
    env.update(
        {
            "PORT": str(port),
            "NODE_ENV": "test",
            "LOG_LEVEL": "error",
            # Photo backend fetch
            "PIVOTA_BACKEND_BASE_URL": pivota_backend_base_url,
            "PIVOTA_BACKEND_AGENT_API_KEY": "test_key",
            # Disable external LLM calls by default (load tests should be local + deterministic).
            "AURORA_BFF_USE_MOCK": "false",
            "AURORA_DECISION_BASE_URL": "",
            "AURORA_SKIN_VISION_ENABLED": "false",
            "OPENAI_API_KEY": "",
            "OPENAI_BASE_URL": "",
            # Avoid accidental external dependencies.
            "PIVOTA_API_BASE": "http://127.0.0.1:1",
            "PIVOTA_API_KEY": "",
            "DATABASE_URL": "",
            "DB_AUTO_MIGRATE": "false",
        }
    )

    log_path = Path(tempfile.mkdtemp(prefix="aurora_loadtest_")) / "node_server.log"
    log_file = open(log_path, "w", encoding="utf-8")
    proc = subprocess.Popen(
        ["node", "src/server.js"],
        cwd=str(REPO_ROOT),
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        text=True,
    )
    return (proc, log_path)


async def _wait_ready(base_url: str, *, timeout_s: float = 20.0) -> None:
    if httpx is None:  # pragma: no cover
        raise RuntimeError("httpx is required for scripts/load_test.py")
    deadline = time.monotonic() + timeout_s
    async with httpx.AsyncClient(timeout=2.0) as client:
        while time.monotonic() < deadline:
            try:
                r = await client.get(f"{base_url}/healthz")
                if r.status_code == 200 and (r.json() or {}).get("ok") is True:
                    return
            except Exception:
                pass
            await asyncio.sleep(0.2)
    raise TimeoutError(f"server not ready after {timeout_s}s: {base_url}")


def _extract_analysis_summary(envelope: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    cards = envelope.get("cards") or []
    if not isinstance(cards, list):
        return None
    for c in cards:
        if not isinstance(c, dict):
            continue
        if c.get("type") == "analysis_summary":
            payload = c.get("payload")
            return payload if isinstance(payload, dict) else None
    return None


def _infer_llm_called(analysis_payload: Dict[str, Any]) -> bool:
    qr = analysis_payload.get("quality_report") or {}
    llm = (qr.get("llm") or {}) if isinstance(qr, dict) else {}
    vision = llm.get("vision") or {}
    report = llm.get("report") or {}
    v_dec = vision.get("decision") if isinstance(vision, dict) else None
    r_dec = report.get("decision") if isinstance(report, dict) else None
    return v_dec == "call" or r_dec == "call"


def _infer_timeout_degraded(analysis_payload: Dict[str, Any]) -> bool:
    qr = analysis_payload.get("quality_report") or {}
    reasons = qr.get("reasons") if isinstance(qr, dict) else None
    if not isinstance(reasons, list):
        return False
    for r in reasons:
        s = str(r or "")
        if "timeout" in s.lower() or "超时" in s:
            return True
    return False


@dataclass
class RequestResult:
    ok: bool
    latency_ms: float
    status_code: Optional[int]
    llm_called: bool
    timeout_degraded: bool
    error: Optional[str]


async def _run_load(base_url: str, cfg: LoadTestConfig) -> List[RequestResult]:
    if httpx is None:  # pragma: no cover
        raise RuntimeError("httpx is required for scripts/load_test.py")

    headers = {"X-Aurora-UID": "loadtest_uid_1", "X-Lang": "EN", "Content-Type": "application/json"}
    body = _build_request_body(cfg.qc)
    results: List[RequestResult] = []
    deadline = time.monotonic() + cfg.duration_s

    async with httpx.AsyncClient(timeout=cfg.request_timeout_s) as client:
        # Small warmup to avoid including cold start in latency stats.
        for _ in range(min(2, cfg.concurrency)):
            try:
                await client.post(f"{base_url}/v1/analysis/skin", headers=headers, json=body)
            except Exception:
                pass

        async def worker() -> None:
            while time.monotonic() < deadline:
                t0 = time.monotonic()
                try:
                    resp = await client.post(f"{base_url}/v1/analysis/skin", headers=headers, json=body)
                    dt = (time.monotonic() - t0) * 1000.0
                    status = int(resp.status_code)
                    if status != 200:
                        results.append(RequestResult(ok=False, latency_ms=dt, status_code=status, llm_called=False, timeout_degraded=False, error=f"http_{status}"))
                        continue
                    try:
                        envelope = resp.json()
                    except Exception:
                        results.append(RequestResult(ok=False, latency_ms=dt, status_code=status, llm_called=False, timeout_degraded=False, error="json_decode_failed"))
                        continue
                    payload = _extract_analysis_summary(envelope)
                    if not payload:
                        results.append(RequestResult(ok=False, latency_ms=dt, status_code=status, llm_called=False, timeout_degraded=False, error="missing_analysis_summary"))
                        continue
                    results.append(
                        RequestResult(
                            ok=True,
                            latency_ms=dt,
                            status_code=status,
                            llm_called=_infer_llm_called(payload),
                            timeout_degraded=_infer_timeout_degraded(payload),
                            error=None,
                        )
                    )
                except httpx.TimeoutException:
                    dt = (time.monotonic() - t0) * 1000.0
                    results.append(RequestResult(ok=False, latency_ms=dt, status_code=None, llm_called=False, timeout_degraded=True, error="client_timeout"))
                except Exception as e:
                    dt = (time.monotonic() - t0) * 1000.0
                    results.append(RequestResult(ok=False, latency_ms=dt, status_code=None, llm_called=False, timeout_degraded=False, error=f"client_error:{type(e).__name__}"))

        tasks = [asyncio.create_task(worker()) for _ in range(max(1, int(cfg.concurrency)))]
        await asyncio.gather(*tasks)

    return results


def _render_report(
    *,
    cfg: LoadTestConfig,
    target_url: str,
    node_log_path: Path,
    results: List[RequestResult],
) -> str:
    ok_lat = [r.latency_ms for r in results if r.ok]
    p50 = _percentile(ok_lat, 50)
    p95 = _percentile(ok_lat, 95)
    p99 = _percentile(ok_lat, 99)

    n = len(results)
    ok_n = sum(1 for r in results if r.ok)
    err_n = n - ok_n
    err_rate = (0.0 if n == 0 else float(err_n) / float(n))

    timeout_degraded_n = sum(1 for r in results if r.timeout_degraded)
    llm_called_n = sum(1 for r in results if r.llm_called)
    llm_ratio = (0.0 if n == 0 else float(llm_called_n) / float(n))

    budget = cfg.p95_budget_ms
    budget_line = "Budget: (disabled)"
    verdict = "N/A"
    if budget is not None and budget > 0:
        budget_line = f"Budget: p95 <= {budget:.0f} ms"
        verdict = "PASS" if p95 <= budget else "FAIL"

    lines = []
    lines.append("# Load Test Report")
    lines.append("")
    lines.append(f"- Generated at: `{time.strftime('%Y-%m-%d %H:%M:%S')}`")
    lines.append(f"- Target: `{target_url}`")
    lines.append(f"- Duration: `{cfg.duration_s:.1f}s`, Concurrency: `{cfg.concurrency}`, Request timeout: `{cfg.request_timeout_s:.1f}s`")
    lines.append(f"- Scenario: `qc={cfg.qc}` (synthetic photo served via local stub backend)")
    lines.append(f"- {budget_line} → **{verdict}**")
    lines.append(f"- Node logs: `{node_log_path}`")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append("| metric | value |")
    lines.append("|---|---:|")
    lines.append(f"| requests_total | {n} |")
    lines.append(f"| ok | {ok_n} |")
    lines.append(f"| errors | {err_n} |")
    lines.append(f"| error_rate | {err_rate:.2%} |")
    lines.append(f"| p50_ms (ok) | {p50:.2f} |")
    lines.append(f"| p95_ms (ok) | {p95:.2f} |")
    lines.append(f"| p99_ms (ok) | {p99:.2f} |")
    lines.append(f"| timeout_degraded_count | {timeout_degraded_n} |")
    lines.append(f"| llm_called_ratio | {llm_ratio:.2%} |")
    lines.append("")
    lines.append("## Notes")
    lines.append("")
    lines.append("- `llm_called_ratio` is inferred from `analysis_summary.payload.quality_report.llm.*.decision == \"call\"` (policy decision).")
    lines.append("- `timeout_degraded_count` is inferred from quality reasons containing `timeout/超时` or client-side timeouts.")
    lines.append("- External LLM calls are disabled by default in this load test (local + deterministic).")
    lines.append("")
    return "\n".join(lines)


def _parse_args() -> LoadTestConfig:
    p = argparse.ArgumentParser(description="Lightweight local load test for POST /v1/analysis/skin")
    p.add_argument("--duration", type=float, default=float(os.environ.get("LOADTEST_DURATION_S", "10")), help="Duration in seconds.")
    p.add_argument("--concurrency", type=int, default=int(os.environ.get("LOADTEST_CONCURRENCY", "8")), help="Number of concurrent workers.")
    p.add_argument("--timeout", type=float, default=float(os.environ.get("LOADTEST_REQUEST_TIMEOUT_S", "8")), help="Per-request timeout (seconds).")
    p.add_argument("--qc", type=str, default=os.environ.get("LOADTEST_QC", "pass"), help="Photo QC token: pass|degraded|fail.")
    p.add_argument("--out", type=str, default=os.environ.get("LOADTEST_OUT", str(REPO_ROOT / "loadtest_report.md")), help="Output markdown path.")
    p.add_argument(
        "--p95-budget-ms",
        type=float,
        default=float(os.environ["LOADTEST_P95_BUDGET_MS"]) if os.environ.get("LOADTEST_P95_BUDGET_MS") else None,
        help="Fail (exit 1) if p95 exceeds this threshold.",
    )
    args = p.parse_args()
    return LoadTestConfig(
        duration_s=float(args.duration),
        concurrency=int(args.concurrency),
        request_timeout_s=float(args.timeout),
        qc=str(args.qc),
        out_path=Path(args.out),
        p95_budget_ms=float(args.p95_budget_ms) if args.p95_budget_ms is not None else None,
    )


def main() -> int:
    cfg = _parse_args()
    if httpx is None:
        raise RuntimeError("Missing dependency: httpx")

    stub_server, stub_base_url = _start_stub_backend(qc=cfg.qc)
    node_proc = None
    node_log_path = Path("(not-started)")
    try:
        # Run the stub backend in a background thread.
        import threading

        t = threading.Thread(target=stub_server.serve_forever, daemon=True)
        t.start()

        node_port = _free_port()
        node_proc, node_log_path = _start_node_server(port=node_port, pivota_backend_base_url=stub_base_url)
        target_url = f"http://127.0.0.1:{node_port}"

        asyncio.run(_wait_ready(target_url, timeout_s=20.0))
        results = asyncio.run(_run_load(target_url, cfg))

        report_md = _render_report(cfg=cfg, target_url=target_url, node_log_path=node_log_path, results=results)
        cfg.out_path.parent.mkdir(parents=True, exist_ok=True)
        cfg.out_path.write_text(report_md, encoding="utf-8")
        print(report_md)

        ok_lat = [r.latency_ms for r in results if r.ok]
        p95 = _percentile(ok_lat, 95)
        if cfg.p95_budget_ms is not None and cfg.p95_budget_ms > 0 and p95 > cfg.p95_budget_ms:
            return 1
        return 0
    finally:
        try:
            stub_server.shutdown()
        except Exception:
            pass
        try:
            stub_server.server_close()
        except Exception:
            pass
        if node_proc is not None:
            try:
                node_proc.terminate()
                node_proc.wait(timeout=10)
            except Exception:
                try:
                    node_proc.kill()
                except Exception:
                    pass


if __name__ == "__main__":
    raise SystemExit(main())
