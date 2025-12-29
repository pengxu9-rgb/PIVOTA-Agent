#!/usr/bin/env node
/* eslint-disable no-console */

const { execSync } = require("node:child_process");

function sh(cmd) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trimEnd();
}

function main() {
  const status = sh("git status --porcelain");
  if (status.trim()) {
    console.error("[FAIL] working tree is not clean:");
    console.error(status);
    process.exit(1);
  }

  const changed = sh("git diff --name-only origin/main...HEAD || true")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const forbidden = new Set([
    "docs/internal_role_sku_map.md",
    "scripts/build-internal-pins.js",
    "src/layer3/data/internal_role_sku_map.template.csv",
  ]);

  const bad = changed.filter((p) => forbidden.has(p));
  if (bad.length) {
    console.error("[FAIL] PR contains forbidden/unrelated files:");
    console.error(bad.join("\n"));
    process.exit(1);
  }

  console.log("GIT_OK clean=true");
}

main();

