#!/usr/bin/env python3

from __future__ import annotations

import datetime as _dt
import fnmatch
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Set


DEFAULT_EXCLUDE_DIR_NAMES: Set[str] = {
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
}


def _utc_iso(ts: float) -> str:
    return _dt.datetime.utcfromtimestamp(ts).replace(microsecond=0).isoformat() + "Z"


def _resolve_user_path(raw: str, *, repo_root: Path) -> Path:
    p = Path(os.path.expanduser(str(raw).strip()))
    if not p.is_absolute():
        p = repo_root / p
    return p


def _iter_repo_files(repo_root: Path, *, exclude_dir_names: Set[str]) -> Iterable[Path]:
    # os.walk is significantly faster than Path.rglob and lets us prune directories.
    for root, dirnames, filenames in os.walk(str(repo_root)):
        # Prune excluded dirs in-place to prevent walking into them.
        dirnames[:] = [d for d in dirnames if d not in exclude_dir_names]
        for filename in filenames:
            yield Path(root) / filename


@dataclass(frozen=True)
class DiscoveredCandidate:
    path: Path
    mtime: float
    mtime_iso: str
    origin: str  # arg|env|well_known|glob
    stat_error: Optional[str] = None


@dataclass(frozen=True)
class DiscoveryResult:
    name: str
    selected: Optional[DiscoveredCandidate]
    selected_via: str  # arg|env|auto|none
    override_kind: Optional[str]  # arg|env
    override_name: Optional[str]
    override_value: Optional[str]
    override_error: Optional[str]
    searched_rel_paths: List[str]
    searched_patterns: List[str]
    candidates: List[DiscoveredCandidate]  # sorted by mtime desc
    repo_root: Path
    cwd: Path


def discover_artifact(
    *,
    name: str,
    repo_root: Path,
    explicit_path: str = "",
    env_override_name: str = "",
    default_rel_paths: Sequence[str],
    patterns: Sequence[str],
    exclude_dir_names: Optional[Set[str]] = None,
) -> DiscoveryResult:
    repo_root = Path(repo_root).resolve()
    cwd = Path.cwd().resolve()
    exclude_dir_names = set(exclude_dir_names or DEFAULT_EXCLUDE_DIR_NAMES)

    override_kind: Optional[str] = None
    override_name: Optional[str] = None
    override_value: Optional[str] = None
    override_error: Optional[str] = None

    def _candidate_from_path(p: Path, *, origin: str) -> DiscoveredCandidate:
        try:
            st = p.stat()
            return DiscoveredCandidate(path=p.resolve(), mtime=float(st.st_mtime), mtime_iso=_utc_iso(float(st.st_mtime)), origin=origin)
        except Exception as e:
            return DiscoveredCandidate(path=p, mtime=-1.0, mtime_iso="(unknown)", origin=origin, stat_error=str(e))

    # 1) Explicit CLI arg wins.
    if str(explicit_path or "").strip():
        override_kind = "arg"
        override_value = str(explicit_path).strip()
        override_name = None
        p = _resolve_user_path(override_value, repo_root=repo_root)
        try:
            if p.is_file():
                cand = _candidate_from_path(p, origin="arg")
                return DiscoveryResult(
                    name=name,
                    selected=cand,
                    selected_via="arg",
                    override_kind=override_kind,
                    override_name=override_name,
                    override_value=override_value,
                    override_error=None,
                    searched_rel_paths=list(default_rel_paths),
                    searched_patterns=list(patterns),
                    candidates=[cand],
                    repo_root=repo_root,
                    cwd=cwd,
                )
            override_error = f"explicit path not found: {p}"
        except Exception as e:
            override_error = f"explicit path error: {e}"

    # 2) Env override (if no explicit arg).
    if override_kind is None and str(env_override_name or "").strip():
        env_val = os.environ.get(env_override_name)
        if env_val is not None and str(env_val).strip():
            override_kind = "env"
            override_name = env_override_name
            override_value = str(env_val).strip()
            p = _resolve_user_path(override_value, repo_root=repo_root)
            try:
                if p.is_file():
                    cand = _candidate_from_path(p, origin="env")
                    return DiscoveryResult(
                        name=name,
                        selected=cand,
                        selected_via="env",
                        override_kind=override_kind,
                        override_name=override_name,
                        override_value=override_value,
                        override_error=None,
                        searched_rel_paths=list(default_rel_paths),
                        searched_patterns=list(patterns),
                        candidates=[cand],
                        repo_root=repo_root,
                        cwd=cwd,
                    )
                override_error = f"override path not found: {p}"
            except Exception as e:
                override_error = f"override path error: {e}"

    # 3) Auto discovery.
    cand_map: dict[str, DiscoveredCandidate] = {}

    # Well-known locations (fast path).
    for rel in default_rel_paths:
        rel_s = str(rel).strip()
        if not rel_s:
            continue
        p = (repo_root / rel_s).resolve()
        try:
            if p.is_file():
                key = str(p)
                cand_map.setdefault(key, _candidate_from_path(p, origin="well_known"))
        except Exception:
            continue

    # Broad glob-style discovery: patterns are matched against relative POSIX paths.
    pat_list = [str(p).strip() for p in patterns if str(p).strip()]
    if pat_list:
        for p in _iter_repo_files(repo_root, exclude_dir_names=exclude_dir_names):
            try:
                rel_posix = p.resolve().relative_to(repo_root).as_posix()
            except Exception:
                try:
                    rel_posix = p.relative_to(repo_root).as_posix()
                except Exception:
                    rel_posix = str(p)
            if not any(fnmatch.fnmatch(rel_posix, pat) for pat in pat_list):
                continue
            key = str(p.resolve())
            cand_map.setdefault(key, _candidate_from_path(p, origin="glob"))

    candidates = list(cand_map.values())
    candidates.sort(key=lambda c: (c.mtime, str(c.path)), reverse=True)
    selected = next((c for c in candidates if c.stat_error is None and c.mtime >= 0), None)
    selected_via = "auto" if selected is not None else "none"

    return DiscoveryResult(
        name=name,
        selected=selected,
        selected_via=selected_via,
        override_kind=override_kind,
        override_name=override_name,
        override_value=override_value,
        override_error=override_error,
        searched_rel_paths=list(default_rel_paths),
        searched_patterns=list(patterns),
        candidates=candidates,
        repo_root=repo_root,
        cwd=cwd,
    )

