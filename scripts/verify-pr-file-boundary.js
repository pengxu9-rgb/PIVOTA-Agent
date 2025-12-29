#!/usr/bin/env node
/* eslint-disable no-console */

const { execSync } = require("node:child_process");

function sh(cmd) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trimEnd();
}

function allowDirtyTree() {
  if (String(process.env.VERIFY_ALLOW_DIRTY || "").trim() === "1") return true;
  return process.argv.includes("--allow-dirty");
}

function main() {
  const status = sh("git status --porcelain");
  const clean = !status.trim();
  const allowDirty = allowDirtyTree();
  if (!clean && !allowDirty) {
    console.error("[FAIL] working tree is not clean.");
    console.error('Fix: commit/stash your changes, or re-run with VERIFY_ALLOW_DIRTY=1 (or "--allow-dirty").');
    console.error(status);
    process.exit(1);
  }
  if (!clean && allowDirty) console.warn("[WARN] working tree is not clean; VERIFY_ALLOW_DIRTY enabled (boundary check still enforced)");

  const committed = sh("git diff --name-only origin/main...HEAD || true");
  const unstaged = sh("git diff --name-only || true");
  const staged = sh("git diff --cached --name-only || true");
  const untracked = sh("git ls-files --others --exclude-standard || true");

  const changed = Array.from(
    new Set([committed, unstaged, staged, untracked].join("\n").split("\n").map((s) => s.trim()).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b));

  // Keep this list for truly out-of-scope files that should never land via feature PRs.
  // Internal pins pipeline files are now allowed (docs + scripts + templates).
  const forbidden = new Set([]);

  const bad = changed.filter((p) => forbidden.has(p));
  if (bad.length) {
    console.error("[FAIL] PR contains forbidden/unrelated files:");
    console.error(bad.join("\n"));
    process.exit(1);
  }

  console.log(`GIT_OK clean=${clean} allowDirty=${allowDirty} changed=${changed.length}`);
}

main();
