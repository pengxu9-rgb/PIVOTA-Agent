#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

const { parseCsvString } = require("../src/layer2/kb/importTechniqueCsv");

const ALLOWED_MARKETS = new Set(["US", "JP"]);
const ALLOWED_SCOPES = new Set(["role", "category"]);
const ALLOWED_CATEGORIES = new Set([
  "prep",
  "base",
  "contour",
  "brow",
  "eye",
  "blush",
  "lip",
]);
const ALLOWED_PIN_REASONS = new Set([
  "partner",
  "promo",
  "high_cvr",
  "supply_guarantee",
  "manual_test",
]);

function stableJsonStringify(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

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

function usageAndExit(code) {
  console.log(`Usage:
  npm run internal:build-pins

Optional flags:
  --input <path>     (default: src/layer3/data/internal_role_sku_map.csv)
  --outDir <dir>     (default: src/layer3/data)
  --date YYYY-MM-DD  (default: today in local time)
  --market US|JP     (optional: build a single market from the CSV)
`);
  process.exit(code);
}

function loadRoleIdsV1() {
  const dictPath = path.join(__dirname, "..", "src", "layer2", "dicts", "roles_v1.json");
  if (!fs.existsSync(dictPath)) return new Set();
  const parsed = JSON.parse(fs.readFileSync(dictPath, "utf8"));
  const roles = Array.isArray(parsed?.roles) ? parsed.roles : [];
  const out = new Set();
  for (const r of roles) {
    const id = String(r?.id ?? "").trim();
    if (!id) continue;
    out.add(`ROLE:${id}`);
  }
  return out;
}

function parseInteger(raw) {
  const s = String(raw ?? "").trim();
  if (!/^\d+$/.test(s)) return null;
  return Number(s);
}

function parseTags(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  const tags = s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const unique = [];
  for (const t of tags) if (!unique.includes(t)) unique.push(t);
  return unique;
}

function parseDateYYYYMMDD(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: `Invalid date "${s}" (expected YYYY-MM-DD)` };
  return s;
}

function todayYYYYMMDD() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeRow(row, options) {
  const market = String(row.market ?? "").trim().toUpperCase();
  const scope = String(row.scope ?? "").trim().toLowerCase();
  const scopeId = String(row.scope_id ?? "").trim();
  const skuId = String(row.sku_id ?? "").trim();
  const merchantId = String(row.merchant_id ?? "").trim();
  const priorityRaw = row.priority;
  const pinReasonRaw = String(row.pin_reason ?? "").trim();

  if (!ALLOWED_MARKETS.has(market)) throw new Error(`Invalid market "${market}"`);
  if (options.marketFilter && market !== options.marketFilter) return null;
  if (!ALLOWED_SCOPES.has(scope)) throw new Error(`Invalid scope "${scope}" (expected role|category)`);
  if (!scopeId) throw new Error("Missing scope_id");
  if (!skuId) throw new Error("Missing sku_id");

  if (scope === "category") {
    if (!ALLOWED_CATEGORIES.has(scopeId)) {
      throw new Error(
        `Invalid category scope_id "${scopeId}" (expected one of ${Array.from(ALLOWED_CATEGORIES).join(",")})`,
      );
    }
  } else if (scope === "role") {
    if (!scopeId.startsWith("ROLE:")) throw new Error(`role scope_id must start with "ROLE:" (got "${scopeId}")`);
    if (!options.allowedRoleIds.has(scopeId)) throw new Error(`Unknown role scope_id "${scopeId}" (not in roles_v1.json)`);
  }

  const priority = parseInteger(priorityRaw);
  if (priority === null || priority < 0 || priority > 100) {
    throw new Error(`Invalid priority "${priorityRaw}" (expected integer 0..100)`);
  }

  let pinReason = null;
  if (pinReasonRaw) {
    const normalized = pinReasonRaw.toLowerCase();
    if (!ALLOWED_PIN_REASONS.has(normalized)) {
      throw new Error(
        `Invalid pin_reason "${pinReasonRaw}" (expected one of ${Array.from(ALLOWED_PIN_REASONS).join(",")})`,
      );
    }
    pinReason = normalized;
  }

  const start = parseDateYYYYMMDD(row.start_date);
  if (start && start.error) throw new Error(start.error);
  const end = parseDateYYYYMMDD(row.end_date);
  if (end && end.error) throw new Error(end.error);
  if (start && end && start > end) throw new Error(`Invalid date window start_date > end_date (${start} > ${end})`);

  const tags = parseTags(row.tags);
  const notes = String(row.notes ?? "").trim();

  return {
    market,
    scope,
    scopeId,
    skuId,
    ...(merchantId ? { merchantId } : {}),
    priority,
    ...(pinReason ? { pinReason } : {}),
    ...(tags.length ? { tags } : {}),
    ...(notes ? { notes } : {}),
    ...(start ? { startDate: start } : {}),
    ...(end ? { endDate: end } : {}),
  };
}

function groupKey(entry) {
  return `${entry.market}:${entry.scope}:${entry.scopeId}`;
}

function stableComparePin(a, b) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return String(a.skuId).localeCompare(String(b.skuId));
}

function dedupePins(pins) {
  const bySku = new Map();
  for (const p of pins) {
    const existing = bySku.get(p.skuId);
    if (!existing) {
      bySku.set(p.skuId, p);
      continue;
    }
    if (p.priority > existing.priority) bySku.set(p.skuId, p);
  }
  return Array.from(bySku.values()).sort(stableComparePin);
}

function buildInternalPinsPools(params) {
  const { csvRows, updatedAt, marketFilter, allowedRoleIds } = params;

  const pools = {
    US: { market: "US", version: "v0", updatedAt, byRole: {}, byCategory: {} },
    JP: { market: "JP", version: "v0", updatedAt, byRole: {}, byCategory: {} },
  };

  const warnings = [];
  const errors = [];

  for (let i = 0; i < csvRows.length; i += 1) {
    const rowNumber = i + 2;
    const row = csvRows[i] || {};
    if (!String(row.market ?? "").trim() && !String(row.sku_id ?? "").trim()) continue;
    try {
      const entry = normalizeRow(row, { marketFilter, allowedRoleIds });
      if (!entry) continue;
      const pool = pools[entry.market];
      if (!pool) continue;

      if (entry.scope === "role") {
        if (!pool.byRole[entry.scopeId]) pool.byRole[entry.scopeId] = [];
        pool.byRole[entry.scopeId].push(entry);
      } else {
        if (!pool.byCategory[entry.scopeId]) pool.byCategory[entry.scopeId] = [];
        pool.byCategory[entry.scopeId].push(entry);
      }
    } catch (e) {
      errors.push(`Row ${rowNumber}: ${e && e.message ? e.message : String(e)}`);
    }
  }

  for (const m of ["US", "JP"]) {
    const pool = pools[m];
    for (const roleId of Object.keys(pool.byRole).sort()) {
      pool.byRole[roleId] = dedupePins(pool.byRole[roleId]);
    }
    const catKeys = Object.keys(pool.byCategory);
    catKeys.sort((a, b) => a.localeCompare(b));
    const sortedByCategory = {};
    for (const cat of catKeys) sortedByCategory[cat] = dedupePins(pool.byCategory[cat]);
    pool.byCategory = sortedByCategory;
  }

  return { pools, warnings, errors };
}

function writePoolsToDisk(params) {
  const { pools, outDir } = params;
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];

  const write = (market, filename) => {
    const filePath = path.join(outDir, filename);
    fs.writeFileSync(filePath, stableJsonStringify(pools[market]), "utf8");
    out.push(filePath);
  };

  write("US", "internalPins_us.json");
  write("JP", "internalPins_jp.json");
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usageAndExit(0);

  const inputPath = args.input
    ? String(args.input)
    : path.join("src", "layer3", "data", "internal_role_sku_map.csv");
  const outDir = args.outDir ? String(args.outDir) : path.join("src", "layer3", "data");
  const updatedAt = args.date ? String(args.date) : todayYYYYMMDD();
  const marketFilter = args.market ? String(args.market).trim().toUpperCase() : null;

  if (marketFilter && !ALLOWED_MARKETS.has(marketFilter)) {
    console.error(`[internal:build-pins] invalid --market ${marketFilter}`);
    process.exit(2);
  }

  if (!fs.existsSync(inputPath)) {
    console.warn(`[internal:build-pins] No CSV found at ${inputPath}; nothing to build (no-op).`);
    return;
  }

  const roles = loadRoleIdsV1();
  if (roles.size === 0) {
    console.warn("[internal:build-pins] Warning: roles_v1.json not found or empty; role-scoped rows will fail validation.");
  }

  const csvText = fs.readFileSync(inputPath, "utf8");
  const { rows } = parseCsvString(csvText);
  const result = buildInternalPinsPools({
    csvRows: rows,
    updatedAt,
    marketFilter,
    allowedRoleIds: roles,
  });

  for (const w of result.warnings) console.warn(w);
  if (result.errors.length) {
    console.error(`[internal:build-pins] FAILED (${result.errors.length} error(s))`);
    for (const e of result.errors) console.error(`- ${e}`);
    process.exit(1);
  }

  const written = writePoolsToDisk({ pools: result.pools, outDir });
  console.log(`[internal:build-pins] input=${inputPath}`);
  console.log(`[internal:build-pins] wrote:`);
  for (const p of written) console.log(`- ${p}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildInternalPinsPools,
  loadRoleIdsV1,
  normalizeRow,
  ALLOWED_CATEGORIES,
};

