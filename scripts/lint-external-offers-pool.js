#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

const { parseCsvString } = require("../src/layer2/kb/importTechniqueCsv");
const {
  validateAndNormalizeRow,
  readLinesFile,
  loadRoleIdsV1,
  stableHashShort,
} = require("./build-external-links-pool");

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

function isHeavyCanonicalUrl(canonicalUrl) {
  try {
    const u = new URL(canonicalUrl);
    const qs = u.searchParams;
    const n = Array.from(qs.keys()).length;
    const len = u.search.length;
    return n >= 4 || len >= 80;
  } catch {
    return false;
  }
}

function lintExternalOffersPool(params) {
  const { inputPath, outDir, marketFilter } = params;

  if (!fs.existsSync(inputPath)) {
    return {
      ok: true,
      warnings: [
        `[external:lint] No CSV found at ${inputPath}; skipping (no-op).`,
      ],
      errors: [],
      counts: { rows: 0, accepted: 0 },
    };
  }

  const allowlistUS = readLinesFile(path.join(outDir, "external_allowlist_US.txt"));
  const allowlistJP = readLinesFile(path.join(outDir, "external_allowlist_JP.txt"));
  const roles = loadRoleIdsV1();

  const csvText = fs.readFileSync(inputPath, "utf8");
  const { rows } = parseCsvString(csvText);

  const errors = [];
  const warnings = [];

  const seenByGroup = new Map(); // groupKey -> Map<canonicalUrl, rowNumber>
  let accepted = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const rowNumber = i + 2;
    const row = rows[i] || {};
    if (!String(row.market ?? "").trim() && !String(row.url ?? "").trim()) continue;

    try {
      const normalized = validateAndNormalizeRow(row, {
        domainAllowlistByMarket: { US: allowlistUS, JP: allowlistJP },
        partnersByMarket: { US: {}, JP: {} },
        domainCap: 999,
        marketFilter,
        allowedRoleIds: roles,
      });
      if (!normalized) continue;
      accepted += 1;

      const groupKey = `${normalized.market}:${normalized.scope}:${normalized.scopeId}`;
      if (!seenByGroup.has(groupKey)) seenByGroup.set(groupKey, new Map());
      const byUrl = seenByGroup.get(groupKey);
      if (byUrl.has(normalized.canonicalUrl)) {
        errors.push(
          `Row ${rowNumber}: duplicate canonicalUrl within group ${groupKey}: ${normalized.canonicalUrl} (also seen at row ${byUrl.get(
            normalized.canonicalUrl,
          )})`,
        );
      } else {
        byUrl.set(normalized.canonicalUrl, rowNumber);
      }

      if (isHeavyCanonicalUrl(normalized.canonicalUrl)) {
        warnings.push(
          `Row ${rowNumber}: canonicalUrl has a heavy querystring (consider simplifying): ${normalized.canonicalUrl}`,
        );
      }
    } catch (e) {
      errors.push(`Row ${rowNumber}: ${e && e.message ? e.message : String(e)}`);
    }
  }

  return {
    ok: errors.length === 0,
    warnings,
    errors,
    counts: { rows: rows.length, accepted },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = args.input
    ? String(args.input)
    : path.join("src", "layer3", "data", "external_offers_pool.csv");
  const outDir = args.outDir ? String(args.outDir) : path.join("src", "layer3", "data");
  const marketFilter = args.market ? String(args.market).trim().toUpperCase() : null;

  const result = lintExternalOffersPool({ inputPath, outDir, marketFilter });

  for (const w of result.warnings) console.warn(w);
  if (!result.ok) {
    console.error(`[external:lint] FAILED (${result.errors.length} error(s))`);
    for (const e of result.errors) console.error(`- ${e}`);
    process.exit(1);
  }

  console.log(
    `[external:lint] OK (accepted=${result.counts.accepted}, csvRows=${result.counts.rows}, sha=${stableHashShort(
      fs.existsSync(inputPath) ? fs.readFileSync(inputPath, "utf8") : "",
    )})`,
  );
}

if (require.main === module) {
  main();
}

module.exports = { lintExternalOffersPool };

