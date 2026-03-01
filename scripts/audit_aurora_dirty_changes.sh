#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BACKEND_REPO="${WORKSPACE_ROOT}/PIVOTA-Agent-hotfix"
FRONTEND_REPO="${WORKSPACE_ROOT}/pivota-aurora-chatbox"
OUT_DIR="${BACKEND_REPO}/reports/aurora-stability-audit"
STAMP="$(date -u +%Y%m%d_%H%M%S)"
REPORT_PATH="${OUT_DIR}/Aurora_Stability_Audit_Report_${STAMP}.md"

mkdir -p "${OUT_DIR}"

repo_status_snapshot() {
  local repo="$1"
  local name="$2"
  local status branch commit modified tracked untracked staged

  if ! git -C "${repo}" rev-parse --git-dir >/dev/null 2>&1; then
    printf "%s|missing|missing|0|0|0|0\n" "${name}"
    return
  fi

  branch="$(git -C "${repo}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  commit="$(git -C "${repo}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  status="$(git -C "${repo}" status --porcelain=v1)"
  tracked="$(printf "%s\n" "${status}" | awk 'NF && $1 != "??" {c+=1} END {print c+0}')"
  untracked="$(printf "%s\n" "${status}" | awk '$1 == "??" {c+=1} END {print c+0}')"
  staged="$(printf "%s\n" "${status}" | awk 'NF && $1 != "??" && substr($0,1,1) != " " {c+=1} END {print c+0}')"
  modified="$(printf "%s\n" "${status}" | awk 'NF && $1 != "??" && (substr($0,2,1) != " " || substr($0,1,1) != " ") {c+=1} END {print c+0}')"
  printf "%s|%s|%s|%s|%s|%s|%s\n" "${name}" "${branch}" "${commit}" "${tracked}" "${untracked}" "${staged}" "${modified}"
}

conflict_scan() {
  local repo="$1"
  rg -n \
    --glob '!**/node_modules/**' \
    --glob '!**/dist/**' \
    --glob '!**/.next/**' \
    '^(<<<<<<< .+|=======|>>>>>>> .+)$' \
    "${repo}" || true
}

suspicious_name_scan() {
  local repo="$1"
  find "${repo}" \
    -path "${repo}/node_modules" -prune -o \
    -path "${repo}/dist" -prune -o \
    -path "${repo}/.git" -prune -o \
    -type f -name '* 2.*' -print
}

worktree_scan() {
  local repo="$1"
  find "${repo}" \
    -path "${repo}/.git" -prune -o \
    -type d -name '_worktrees' -print
}

{
  echo "# Aurora Stability Audit Report"
  echo
  echo "- generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- workspace_root: ${WORKSPACE_ROOT}"
  echo
  echo "## Repo Summary"
  echo
  echo "| repo | branch | commit | tracked_changes | untracked_files | staged_changes | total_changes |"
  echo "|---|---|---|---:|---:|---:|---:|"
  repo_status_snapshot "${BACKEND_REPO}" "PIVOTA-Agent-hotfix" | awk -F'|' '{printf "| %s | %s | %s | %s | %s | %s | %s |\n",$1,$2,$3,$4,$5,$6,$7}'
  repo_status_snapshot "${FRONTEND_REPO}" "pivota-aurora-chatbox" | awk -F'|' '{printf "| %s | %s | %s | %s | %s | %s | %s |\n",$1,$2,$3,$4,$5,$6,$7}'
  echo

  echo "## Modified/Untracked Details"
  echo
  echo "### Backend"
  git -C "${BACKEND_REPO}" status --short || true
  echo
  echo "### Frontend"
  git -C "${FRONTEND_REPO}" status --short || true
  echo

  echo "## Suspicious File Names (* 2.*)"
  echo
  echo "### Backend"
  suspicious_name_scan "${BACKEND_REPO}" || true
  echo
  echo "### Frontend"
  suspicious_name_scan "${FRONTEND_REPO}" || true
  echo

  echo "## _worktrees Pollution Scan"
  echo
  echo "### Backend"
  worktree_scan "${BACKEND_REPO}" || true
  echo
  echo "### Frontend"
  worktree_scan "${FRONTEND_REPO}" || true
  echo

  echo "## Merge Conflict Marker Scan"
  echo
  echo "### Backend"
  conflict_scan "${BACKEND_REPO}"
  echo
  echo "### Frontend"
  conflict_scan "${FRONTEND_REPO}"
  echo
} > "${REPORT_PATH}"

echo "Audit report written: ${REPORT_PATH}"
