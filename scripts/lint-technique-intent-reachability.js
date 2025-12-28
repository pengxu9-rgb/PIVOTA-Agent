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

function stableSort(a) {
  return [...a].sort((x, y) => String(x).localeCompare(String(y)));
}

function readIntentsV0() {
  const filePath = path.join(__dirname, "..", "src", "layer2", "dicts", "intents_v0.json");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectReferencedTechniqueIds(intentsV0, market) {
  const ids = new Set();
  const intents = Array.isArray(intentsV0?.intents) ? intentsV0.intents : [];
  for (const it of intents) {
    const m = it?.markets?.[market];
    const techniqueIds = Array.isArray(m?.techniqueIds) ? m.techniqueIds : [];
    for (const tid of techniqueIds) ids.add(String(tid));
  }
  return ids;
}

function reportForMarket({ market, includeStarter }) {
  // Default to production-like behavior (starter off) unless explicitly included.
  process.env.ENABLE_STARTER_KB = includeStarter ? "1" : "0";
  const { loadTechniqueKB } = require("../src/layer2/kb/loadTechniqueKB");

  const intentsV0 = readIntentsV0();
  const referencedIds = collectReferencedTechniqueIds(intentsV0, market);

  const kb = loadTechniqueKB(market);
  const kbIds = new Set(kb.list.map((c) => String(c.id)));

  const missing = stableSort([...referencedIds].filter((id) => !kbIds.has(id)));
  const orphans = stableSort([...kbIds].filter((id) => !referencedIds.has(id)));

  const activityReferenced = stableSort([...referencedIds].filter((id) => id.startsWith("US_")));

  return {
    market,
    includeStarter,
    counts: {
      kbTotal: kbIds.size,
      referencedTotal: referencedIds.size,
      missingTotal: missing.length,
      orphanTotal: orphans.length,
      activityReferencedTotal: activityReferenced.length,
    },
    activityReferenced,
    missing,
  };
}

function printReport(r) {
  console.log(`=== Technique Intent Reachability (${r.market}) ===`);
  console.log(`starter_kb_included=${r.includeStarter}`);
  console.log(
    `counts kb=${r.counts.kbTotal} referenced=${r.counts.referencedTotal} orphan=${r.counts.orphanTotal} missing=${r.counts.missingTotal}`
  );
  console.log(`activity_referenced_total=${r.counts.activityReferencedTotal}`);
  if (r.activityReferenced.length) {
    for (const id of r.activityReferenced) console.log(`- ${id}`);
  }
  if (r.missing.length) {
    console.log("missing:");
    for (const id of r.missing) console.log(`- ${id}`);
  }
  console.log("");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const includeStarter = String(args.includeStarter || "").trim() === "1" || args["include-starter"] === true;

  for (const market of ["US", "JP"]) {
    // Avoid module cache leakage between modes.
    for (const k of Object.keys(require.cache)) {
      if (k.includes(`${path.sep}src${path.sep}layer2${path.sep}kb${path.sep}loadTechniqueKB.js`)) delete require.cache[k];
    }
    printReport(reportForMarket({ market, includeStarter }));
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

