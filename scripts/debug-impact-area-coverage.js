#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const s = String(a || "");
    if (!s) continue;
    if (!s.startsWith("--")) {
      out._.push(s);
      continue;
    }
    const m = s.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else out[s.slice(2)] = true;
  }
  return out;
}

function stableSort(list) {
  return [...list].sort((a, b) => String(a).localeCompare(String(b)));
}

function readJson(relPathFromRepoRoot) {
  const abs = path.join(__dirname, "..", relPathFromRepoRoot);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function truthy(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(s);
}

function runOnce({ enableExtendedAreas, lookSpecFixturePath }) {
  process.env.LAYER2_ENABLE_EXTENDED_AREAS = enableExtendedAreas ? "1" : "0";
  const { runAdjustmentRulesUS } = require("../src/layer2/personalization/rules/runAdjustmentRulesUS");

  const lookSpec = readJson(lookSpecFixturePath);
  const skeletons = runAdjustmentRulesUS({
    lookSpec,
    preferenceMode: "structure",
    userFaceProfile: null,
    refFaceProfile: null,
    similarityReport: null,
  });

  const impactAreas = skeletons.map((s) => String(s?.impactArea || "")).filter(Boolean);
  const includesNonBaseEyeLip = impactAreas.some((a) => a !== "base" && a !== "eye" && a !== "lip");

  console.log("=== Impact Area Coverage (US) ===");
  console.log(`extended_enabled=${enableExtendedAreas ? "true" : "false"}`);
  console.log(`fixture=${lookSpecFixturePath}`);
  console.log(`impactAreas=${impactAreas.join(",") || "(none)"}`);
  console.log(`includesNonBaseEyeLip=${includesNonBaseEyeLip ? "true" : "false"}`);
  console.log("skeletons:");
  for (const sk of skeletons) {
    const doActionIds = stableSort((Array.isArray(sk?.doActionIds) ? sk.doActionIds : []).map(String)).filter(Boolean);
    console.log(
      `- ${String(sk?.impactArea || "")} ruleId=${String(sk?.ruleId || "")} doActionIds=${doActionIds.join(",") || "(none)"}`
    );
  }
  console.log("");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const lookSpecFixturePath =
    String(args.fixture || "").trim() || "fixtures/look_replicator/lookspec_base_coverage_full.json";
  const enableExtendedAreas = args.enable == null ? truthy(process.env.LAYER2_ENABLE_EXTENDED_AREAS) : truthy(args.enable);

  runOnce({ enableExtendedAreas, lookSpecFixturePath });
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(String(err?.stack || err?.message || err));
    process.exitCode = 1;
  }
}

