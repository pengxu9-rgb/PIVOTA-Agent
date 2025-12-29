#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

const { parseCsvString } = require("../src/layer2/kb/importTechniqueCsv");
const { loadRoleIdsV1, normalizeRow } = require("./build-internal-pins");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }

    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }

    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function lintInternalPins(params) {
  const { inputPath, marketFilter } = params;

  if (!fs.existsSync(inputPath)) {
    return {
      ok: true,
      warnings: [`[internal:lint] No CSV found at ${inputPath}; skipping (no-op).`],
      errors: [],
      counts: { rows: 0, accepted: 0 },
    };
  }

  const roles = loadRoleIdsV1();
  const csvText = fs.readFileSync(inputPath, "utf8");
  const { rows } = parseCsvString(csvText);

  const errors = [];
  const warnings = [];
  let accepted = 0;

  const seen = new Map(); // groupKey -> Set<skuId>

  for (let i = 0; i < rows.length; i += 1) {
    const rowNumber = i + 2;
    const row = rows[i] || {};
    if (!String(row.market ?? "").trim() && !String(row.sku_id ?? "").trim()) continue;
    try {
      const entry = normalizeRow(row, { marketFilter, allowedRoleIds: roles });
      if (!entry) continue;
      accepted += 1;

      const gk = `${entry.market}:${entry.scope}:${entry.scopeId}`;
      if (!seen.has(gk)) seen.set(gk, new Set());
      const bySku = seen.get(gk);
      if (bySku.has(entry.skuId)) {
        errors.push(`Row ${rowNumber}: duplicate sku_id within group ${gk}: ${entry.skuId}`);
      } else {
        bySku.add(entry.skuId);
      }
    } catch (e) {
      errors.push(`Row ${rowNumber}: ${e && e.message ? e.message : String(e)}`);
    }
  }

  return { ok: errors.length === 0, warnings, errors, counts: { rows: rows.length, accepted } };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = args.input
    ? String(args.input)
    : path.join("src", "layer3", "data", "internal_role_sku_map.csv");
  const marketFilter = args.market ? String(args.market).trim().toUpperCase() : null;

  const result = lintInternalPins({ inputPath, marketFilter });
  for (const w of result.warnings) console.warn(w);
  if (!result.ok) {
    console.error(`[internal:lint] FAILED (${result.errors.length} error(s))`);
    for (const e of result.errors) console.error(`- ${e}`);
    process.exit(1);
  }
  console.log(`[internal:lint] OK (accepted=${result.counts.accepted}, csvRows=${result.counts.rows})`);
}

if (require.main === module) {
  main();
}

module.exports = { lintInternalPins };

