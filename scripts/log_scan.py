#!/usr/bin/env python3

import argparse
import glob
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple


REPO_ROOT = Path(__file__).resolve().parents[1]


DEFAULT_SCAN_PATHS = [
    "artifacts",
    "tmp",
    "loadtest_report.md",
]


DEFAULT_TEXT_EXTS = {
    ".log",
    ".txt",
    ".out",
    ".err",
    ".json",
    ".jsonl",
    ".md",
    ".csv",
}


EXCLUDE_DIR_NAMES = {
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    "__pycache__",
}


_RE_DATA_URL = re.compile(
    r"data:image/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]{200,}",
    re.IGNORECASE,
)
_RE_BASE64_JPEG = re.compile(r"/9j/[A-Za-z0-9+/=]{200,}")
_RE_JPEG_MAGIC_TEXT = re.compile(r"(?:\\xff\\xd8\\xff|ffd8ff|FF D8 FF)", re.IGNORECASE)
_RE_EXIF_MARK = re.compile(r"(?:Exif\\x00\\x00|Exif\\u0000\\u0000|Exif\\0\\0|\\bExif\\b)")
_RE_NUM = re.compile(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")

_LANDMARK_KEYS = (
    "landmarks",
    "keypoints",
    "face_landmarks",
    "facemesh",
    "face_mesh",
    "mesh_points",
    "face_points",
)


@dataclass(frozen=True)
class Finding:
    kind: str
    path: Path
    line_no: int
    snippet: str


def _is_excluded(path: Path) -> bool:
    for part in path.parts:
        if part in EXCLUDE_DIR_NAMES:
            return True
    return False


def _expand_paths(raw_paths: Sequence[str]) -> List[Path]:
    out: List[Path] = []
    for raw in raw_paths:
        s = (raw or "").strip()
        if not s:
            continue
        # Expand globs relative to repo root.
        matches = glob.glob(str(REPO_ROOT / s), recursive=True)
        if matches:
            for m in matches:
                out.append(Path(m))
            continue
        out.append(REPO_ROOT / s)
    # De-dup while preserving order.
    seen = set()
    uniq: List[Path] = []
    for p in out:
        try:
            key = str(p.resolve())
        except Exception:
            key = str(p)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(p)
    return uniq


def _iter_files(paths: Sequence[Path]) -> Iterable[Path]:
    for p in paths:
        if _is_excluded(p):
            continue
        if p.is_file():
            yield p
            continue
        if p.is_dir():
            for child in p.rglob("*"):
                if not child.is_file():
                    continue
                if _is_excluded(child):
                    continue
                yield child


def _looks_text_like(path: Path, allowed_exts: Optional[Sequence[str]]) -> bool:
    if allowed_exts is not None:
        return path.suffix.lower() in {e.lower() for e in allowed_exts}
    return path.suffix.lower() in DEFAULT_TEXT_EXTS


def _count_numbers(s: str) -> int:
    return len(_RE_NUM.findall(s))


def _scan_file(path: Path, *, max_bytes: int) -> List[Finding]:
    findings: List[Finding] = []
    try:
        if path.stat().st_size > max_bytes:
            return findings
    except Exception:
        return findings

    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except Exception:
        return findings

    i = 0
    while i < len(lines):
        line = lines[i]
        line_no = i + 1
        hay = line.rstrip("\n")

        if _RE_DATA_URL.search(hay):
            findings.append(Finding("data_url_base64", path, line_no, hay[:260]))
            i += 1
            continue

        if _RE_BASE64_JPEG.search(hay):
            findings.append(Finding("base64_jpeg_header", path, line_no, hay[:260]))
            i += 1
            continue

        if _RE_JPEG_MAGIC_TEXT.search(hay):
            findings.append(Finding("jpeg_magic_bytes", path, line_no, hay[:260]))
            i += 1
            continue

        if _RE_EXIF_MARK.search(hay):
            # EXIF markers can be mentioned in docs; only flag when the line looks binary-ish.
            if _count_numbers(hay) > 10 or "base64" in hay.lower() or "\\x" in hay.lower():
                findings.append(Finding("exif_marker", path, line_no, hay[:260]))
                i += 1
                continue

        lower = hay.lower()
        if any(k in lower for k in _LANDMARK_KEYS) and "[" in hay:
            window = "".join(lines[i : min(len(lines), i + 40)])
            n = _count_numbers(window)
            if n >= 120:
                snippet = hay[:260]
                findings.append(Finding("landmark_like_array", path, line_no, snippet))
                i += 1
                continue

        # Catch extremely long numeric arrays on a single line.
        if "[" in hay and _count_numbers(hay) >= 180:
            findings.append(Finding("large_numeric_array", path, line_no, hay[:260]))
            i += 1
            continue

        i += 1

    return findings


def _render_findings(findings: Sequence[Finding]) -> str:
    lines: List[str] = []
    for f in findings:
        rel = f.path.resolve().relative_to(REPO_ROOT)
        lines.append(f"[{f.kind}] {rel}:{f.line_no}: {f.snippet}")
    return "\n".join(lines)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Scan logs/stdout captures for privacy leaks.")
    parser.add_argument("paths", nargs="*", help="Paths or globs to scan (relative to repo root).")
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=5_000_000,
        help="Skip files larger than this many bytes (default: 5MB).",
    )
    parser.add_argument(
        "--ext",
        action="append",
        default=None,
        help="Restrict to extensions (e.g. --ext .log --ext .json). Defaults to a text-safe allowlist.",
    )
    parser.add_argument("--quiet", action="store_true", help="Only print findings on failure.")
    args = parser.parse_args(list(argv) if argv is not None else None)

    raw_paths = args.paths or DEFAULT_SCAN_PATHS
    roots = _expand_paths(raw_paths)
    allowed_exts = args.ext

    findings: List[Finding] = []
    for file_path in _iter_files(roots):
        if not _looks_text_like(file_path, allowed_exts):
            continue
        findings.extend(_scan_file(file_path, max_bytes=int(args.max_bytes)))

    if findings:
        sys.stdout.write("Privacy scan FAILED. Potential sensitive payloads found:\n")
        sys.stdout.write(_render_findings(findings) + "\n")
        return 1

    if not args.quiet:
        sys.stdout.write("Privacy scan OK (no suspicious payloads found).\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

