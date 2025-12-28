#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { parseCsvString } = require("../src/layer2/kb/importTechniqueCsv");
const {
  validateHttpUrlOrThrow,
  canonicalizeUrl,
  hostnameMatchesAllowlist,
} = require("../src/layer3/external/urlUtils");

const ALLOWED_MARKETS = new Set(["US", "JP"]);
const ALLOWED_SCOPES = new Set(["role", "category"]);
const ALLOWED_PARTNER_TYPES = new Set(["none", "affiliate", "partner", "unknown"]);
const ALLOWED_CATEGORIES = new Set([
  "prep",
  "base",
  "contour",
  "brow",
  "eye",
  "blush",
  "lip",
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
      const key = a.slice(2, eq);
      const value = a.slice(eq + 1);
      out[key] = value;
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
  npm run external:build-pool

Optional flags:
  --input <path>   (default: src/layer3/data/external_offers_pool.csv)
  --outDir <dir>   (default: src/layer3/data)
  --date YYYY-MM-DD (default: today in local time)
  --domainCap <n>  (default: 2)
  --market US|JP   (optional: build a single market from the CSV)

Notes:
  - If the CSV does not exist, this script prints a message and exits 0 (no-op).
  - Domains are validated against allowlist files:
      src/layer3/data/external_allowlist_US.txt
      src/layer3/data/external_allowlist_JP.txt
`);
  process.exit(code);
}

function readLinesFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  return text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith("#"))
    .map((l) => l.toLowerCase());
}

function readJsonFileOrEmpty(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw;
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

function stablePartnerKey(partner) {
  const p = partner || {};
  return `${p.type || ""}|${p.program || ""}|${p.name || ""}`;
}

function stableHashShort(input) {
  return crypto.createHash("sha256").update(String(input), "utf8").digest("hex").slice(0, 12);
}

function validateAndNormalizeRow(row, options) {
  const market = String(row.market ?? "").trim().toUpperCase();
  const scope = String(row.scope ?? "").trim().toLowerCase();
  const scopeId = String(row.scope_id ?? "").trim();
  const urlRaw = String(row.url ?? "").trim();
  const priorityRaw = row.priority;
  const partnerType = String(row.partner_type ?? "").trim().toLowerCase();

  if (!ALLOWED_MARKETS.has(market)) throw new Error(`Invalid market "${market}"`);
  if (options.marketFilter && market !== options.marketFilter) return null;
  if (!ALLOWED_SCOPES.has(scope)) throw new Error(`Invalid scope "${scope}" (expected role|category)`);
  if (!scopeId) throw new Error("Missing scope_id");

  if (scope === "category") {
    if (!ALLOWED_CATEGORIES.has(scopeId)) {
      throw new Error(`Invalid category scope_id "${scopeId}" (expected one of ${Array.from(ALLOWED_CATEGORIES).join(",")})`);
    }
  } else if (scope === "role") {
    if (!scopeId.startsWith("ROLE:")) throw new Error(`role scope_id must start with "ROLE:" (got "${scopeId}")`);
    if (!options.allowedRoleIds.has(scopeId)) throw new Error(`Unknown role scope_id "${scopeId}" (not in roles_v1.json)`);
  }

  const priority = parseInteger(priorityRaw);
  if (priority === null || priority < 0 || priority > 100) throw new Error(`Invalid priority "${priorityRaw}" (expected integer 0..100)`);

  if (!ALLOWED_PARTNER_TYPES.has(partnerType)) {
    throw new Error(
      `Invalid partner_type "${partnerType}" (expected one of ${Array.from(ALLOWED_PARTNER_TYPES).join(",")})`,
    );
  }

  const urlObj = validateHttpUrlOrThrow(urlRaw);
  const canonicalUrl = canonicalizeUrl(urlObj.toString());
  const domain = new URL(canonicalUrl).hostname.toLowerCase();

  const allowlist = options.domainAllowlistByMarket[market] || [];
  if (!hostnameMatchesAllowlist(domain, allowlist)) {
    throw new Error(`Domain not allowed for market=${market}: "${domain}"`);
  }

  const partnerProgram = String(row.partner_program ?? "").trim();
  const partnerName = String(row.partner_name ?? "").trim();
  const disclosureText = String(row.disclosure_text ?? "").trim();
  const notes = String(row.notes ?? "").trim();
  const tags = parseTags(row.tags);

  return {
    market,
    scope,
    scopeId,
    canonicalUrl,
    domain,
    priority,
    partner: {
      type: partnerType,
      ...(partnerProgram ? { program: partnerProgram } : {}),
      ...(partnerName ? { name: partnerName } : {}),
    },
    ...(disclosureText ? { disclosureText } : {}),
    ...(tags.length ? { tags } : {}),
    ...(notes ? { notes } : {}),
  };
}

function dedupeWithinGroup(entries) {
  const byUrl = new Map();
  for (const e of entries) {
    const existing = byUrl.get(e.canonicalUrl);
    if (!existing) {
      byUrl.set(e.canonicalUrl, e);
      continue;
    }
    if (e.priority > existing.priority) {
      byUrl.set(e.canonicalUrl, e);
      continue;
    }
    if (e.priority === existing.priority && e.rowIndex < existing.rowIndex) {
      byUrl.set(e.canonicalUrl, e);
    }
  }
  return Array.from(byUrl.values());
}

function sortEntries(entries) {
  return entries.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (a.domain !== b.domain) return a.domain.localeCompare(b.domain);
    if (a.canonicalUrl !== b.canonicalUrl) return a.canonicalUrl.localeCompare(b.canonicalUrl);
    if (stablePartnerKey(a.partner) !== stablePartnerKey(b.partner)) {
      return stablePartnerKey(a.partner).localeCompare(stablePartnerKey(b.partner));
    }
    return a.rowIndex - b.rowIndex;
  });
}

function applyDomainDiversityCap(entries, cap) {
  const limit = Math.max(0, Number(cap) || 0);
  if (!Number.isFinite(limit) || limit <= 0) return entries;

  const counts = new Map();
  const out = [];
  for (const e of entries) {
    const n = counts.get(e.domain) || 0;
    if (n >= limit) continue;
    counts.set(e.domain, n + 1);
    out.push(e);
  }
  return out;
}

function buildExternalLinksPools(params) {
  const {
    csvRows,
    updatedAt,
    domainAllowlistByMarket,
    partnersByMarket,
    domainCap = 2,
    marketFilter,
    allowedRoleIds,
  } = params;

  const grouped = new Map();
  const accepted = [];

  for (let i = 0; i < csvRows.length; i += 1) {
    const rowNumber = i + 2; // header is row 1
    const row = csvRows[i] || {};

    // Skip empty rows
    if (!String(row.market ?? "").trim() && !String(row.url ?? "").trim()) continue;

    const normalized = validateAndNormalizeRow(row, {
      domainAllowlistByMarket,
      partnersByMarket,
      marketFilter,
      allowedRoleIds,
    });
    if (!normalized) continue;

    const groupKey = `${normalized.market}:${normalized.scope}:${normalized.scopeId}`;
    if (!grouped.has(groupKey)) grouped.set(groupKey, []);
    grouped.get(groupKey).push({ ...normalized, rowIndex: i, rowNumber });
    accepted.push({ ...normalized, rowNumber });
  }

  const outByMarket = {};
  for (const market of ALLOWED_MARKETS) {
    if (marketFilter && market !== marketFilter) continue;

    const byRole = {};
    const byCategory = {};

    const groupKeys = Array.from(grouped.keys())
      .filter((k) => k.startsWith(`${market}:`))
      .sort((a, b) => a.localeCompare(b));

    for (const key of groupKeys) {
      const parts = key.split(":");
      const scope = parts[1] || "";
      const scopeId = parts.slice(2).join(":");
      const entries = grouped.get(key) || [];
      const deduped = dedupeWithinGroup(entries);
      const sorted = sortEntries(deduped);
      const capped = applyDomainDiversityCap(sorted, domainCap);

      const compact = capped.map((e) => {
        const base = {
          url: e.canonicalUrl,
          priority: e.priority,
          partner: e.partner,
          domain: e.domain,
        };
        if (e.disclosureText) base.disclosureText = e.disclosureText;
        if (e.tags) base.tags = e.tags;
        if (e.notes) base.notes = e.notes;
        return base;
      });

      if (scope === "role") byRole[scopeId] = compact;
      else byCategory[scopeId] = compact;
    }

    const pool = {
      market,
      version: "v0",
      updatedAt,
      defaults: {
        disclosure: {
          type: "unknown",
          text: "Prices may change. We may earn a commission from qualifying purchases.",
        },
      },
      domainAllowlist: domainAllowlistByMarket[market] || [],
      partners: partnersByMarket[market] || {},
      byRole,
      byCategory,
    };

    outByMarket[market] = pool;
  }

  return { pools: outByMarket, acceptedCount: accepted.length };
}

function writePoolsToDisk(poolsByMarket, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const written = [];
  for (const market of Object.keys(poolsByMarket).sort()) {
    const filename = `externalLinks_${market}.json`;
    const filePath = path.join(outDir, filename);
    fs.writeFileSync(filePath, stableJsonStringify(poolsByMarket[market]), "utf8");
    written.push(filePath);
  }
  return written;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const inputPath = args.input
    ? String(args.input)
    : path.join("src", "layer3", "data", "external_offers_pool.csv");
  const outDir = args.outDir ? String(args.outDir) : path.join("src", "layer3", "data");
  const domainCap = args.domainCap ? Number(args.domainCap) : 2;
  const marketFilter = args.market ? String(args.market).trim().toUpperCase() : null;
  const updatedAt = args.date ? String(args.date).trim() : new Date().toISOString().slice(0, 10);

  if (marketFilter && !ALLOWED_MARKETS.has(marketFilter)) {
    console.error(`Invalid --market "${marketFilter}" (expected US|JP)`);
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(updatedAt)) {
    console.error(`Invalid --date "${updatedAt}" (expected YYYY-MM-DD)`);
    process.exit(1);
  }

  if (!fs.existsSync(inputPath)) {
    console.warn(`[external:build-pool] No CSV found at ${inputPath}; nothing to build (no-op).`);
    process.exit(0);
  }

  const allowlistUS = readLinesFile(path.join(outDir, "external_allowlist_US.txt"));
  const allowlistJP = readLinesFile(path.join(outDir, "external_allowlist_JP.txt"));
  const partnersUS = readJsonFileOrEmpty(path.join(outDir, "external_partners_US.json"));
  const partnersJP = readJsonFileOrEmpty(path.join(outDir, "external_partners_JP.json"));

  const roles = loadRoleIdsV1();
  if (roles.size === 0) {
    console.warn(`[external:build-pool] Warning: roles_v1.json not found or empty; role-scoped rows will fail validation.`);
  }

  const csvText = fs.readFileSync(inputPath, "utf8");
  const { rows } = parseCsvString(csvText);

  const { pools, acceptedCount } = buildExternalLinksPools({
    csvRows: rows,
    updatedAt,
    domainAllowlistByMarket: { US: allowlistUS, JP: allowlistJP },
    partnersByMarket: { US: partnersUS, JP: partnersJP },
    domainCap,
    marketFilter,
    allowedRoleIds: roles,
  });

  const writtenPaths = writePoolsToDisk(pools, outDir);
  console.log(`[external:build-pool] input=${inputPath}`);
  console.log(`[external:build-pool] accepted ${acceptedCount} row(s)`);
  console.log(`[external:build-pool] wrote:`);
  for (const p of writtenPaths) console.log(`  - ${p} (sha=${stableHashShort(fs.readFileSync(p, "utf8"))})`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildExternalLinksPools,
  validateAndNormalizeRow,
  readLinesFile,
  loadRoleIdsV1,
  ALLOWED_CATEGORIES,
  stableHashShort,
};
