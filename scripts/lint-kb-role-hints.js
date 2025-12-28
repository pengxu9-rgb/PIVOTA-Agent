#!/usr/bin/env node
/* eslint-disable no-console */
const { loadTechniqueKB } = require("../src/layer2/kb/loadTechniqueKB");
const { buildRoleNormalizer, loadRolesV0 } = require("../src/layer2/dicts/roles");
const { lintRoleHintsForCards } = require("../src/layer2/kb/roleHintIntegrity");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const s = String(argv[i] || "");
    if (!s) continue;
    if (!s.startsWith("--")) {
      out._.push(s);
      continue;
    }
    const m = s.match(/^--([^=]+)=(.*)$/);
    if (m) {
      out[m[1]] = m[2];
      continue;
    }
    const k = s.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith("--")) {
      out[k] = next;
      i += 1;
    } else {
      out[k] = true;
    }
  }
  return out;
}

function parseEnvBool(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return null;
}

function stableSort(list) {
  return [...list].sort((a, b) => String(a).localeCompare(String(b)));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const market = String(args.market || args.m || args._[0] || "").trim().toUpperCase();
  if (market !== "US" && market !== "JP") {
    throw new Error("Usage: node scripts/lint-kb-role-hints.js --market US|JP [--json] [--strict] [--include-starter]");
  }

  const strict = args.strict === true || String(args.strict || "").trim() === "1";
  const includeStarter =
    args["include-starter"] === true ||
    args.includeStarter === true ||
    String(args.includeStarter || "").trim() === "1" ||
    parseEnvBool(process.env.ENABLE_STARTER_KB) === true;

  // Default to production-like behavior (starter off) unless explicitly enabled.
  process.env.ENABLE_STARTER_KB = includeStarter ? "1" : "0";

  const rolesDict = loadRolesV0();
  const roleNormalizer = buildRoleNormalizer(rolesDict);
  const kb = loadTechniqueKB(market);

  const report = lintRoleHintsForCards({
    market,
    cards: kb.list,
    rolesDict,
    normalizeRoleHint: roleNormalizer.normalizeRoleHint,
    maxSuggestions: 3,
  });

  const asJson = args.json === true || String(args.json || "").trim() === "1";
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`=== KB Role Hints Integrity (${market}) ===`);
    console.log(`starter_kb_included=${includeStarter ? "true" : "false"}`);
    console.log(
      `summary kb=${report.summary.kbCardCount} cardsWithRoleHints=${report.summary.cardsWithRoleHints} totalHints=${report.summary.totalRoleHints} unknownHints=${report.summary.unknownRoleHintsCount} cardsAffected=${report.summary.cardsAffectedCount}`
    );

    if (report.unknownRoleHints.length) {
      console.log("unknown_role_hints (top 20):");
      for (const it of report.unknownRoleHints.slice(0, 20)) {
        const sug = Array.isArray(it.suggestions) && it.suggestions.length ? it.suggestions.join(",") : "(none)";
        console.log(`- ${it.cardId} hint=${JSON.stringify(it.hint)} normalized=${JSON.stringify(it.normalizedHint)} suggestions=${sug}`);
      }

      const uniqueHints = stableSort(Object.keys(report.byHint || {}));
      console.log(`unique_unknown_hints=${uniqueHints.length}`);
    }
  }

  if (strict && report.summary.unknownRoleHintsCount > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(String(err?.stack || err?.message || err));
    process.exitCode = 1;
  }
}

