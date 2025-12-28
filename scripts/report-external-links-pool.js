#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_MARKETS = new Set(["US", "JP"]);
const CATEGORY_ORDER = ["prep", "base", "brow", "eye", "blush", "contour", "lip"];

const DEFAULT_CATEGORY_TARGETS = Object.freeze({
  prep: 8,
  base: 12,
  brow: 8,
  eye: 12,
  blush: 8,
  contour: 6,
  lip: 10,
});

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

function todayUtcYYYYMMDD() {
  return new Date().toISOString().slice(0, 10);
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

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function safeHostnameFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function listOffersFromPool(pool) {
  const offers = [];
  const byCategory = pool?.byCategory || {};
  const byRole = pool?.byRole || {};

  for (const [category, list] of Object.entries(byCategory)) {
    if (!Array.isArray(list)) continue;
    for (const e of list) offers.push({ scope: "category", scopeId: category, entry: e });
  }
  for (const [roleId, list] of Object.entries(byRole)) {
    if (!Array.isArray(list)) continue;
    for (const e of list) offers.push({ scope: "role", scopeId: roleId, entry: e });
  }
  return offers;
}

function countUniqueOffersByUrl(offers) {
  const seen = new Set();
  for (const o of offers) {
    const url = String(o?.entry?.url || "").trim();
    if (!url) continue;
    seen.add(url);
  }
  return seen.size;
}

function computeTopDomains(domainCounts, limit) {
  const pairs = Array.from(domainCounts.entries());
  pairs.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  return pairs.slice(0, limit).map(([domain, count]) => ({ domain, count }));
}

function computeByCategoryMetrics(pool, allowlistSet, categoryTargets) {
  const byCategory = pool?.byCategory || {};
  const out = {};
  const gaps = [];
  const invalidDomainUrls = [];

  for (const category of CATEGORY_ORDER) {
    const list = Array.isArray(byCategory[category]) ? byCategory[category] : [];
    const domainCounts = new Map();
    for (const e of list) {
      const domain = String(e?.domain || safeHostnameFromUrl(e?.url || "")).toLowerCase();
      if (!domain) continue;
      domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
      if (!allowlistSet.has(domain)) invalidDomainUrls.push(String(e?.url || ""));
    }

    const offers = list.length;
    const domains = domainCounts.size;
    const topDomains = computeTopDomains(domainCounts, 5);
    const target = Number.isFinite(categoryTargets[category])
      ? categoryTargets[category]
      : DEFAULT_CATEGORY_TARGETS[category] ?? 0;
    const missing = Math.max(0, target - offers);
    const meetsTarget = missing === 0;

    const topDomainShare =
      offers > 0 && topDomains.length > 0 ? topDomains[0].count / offers : 0;
    const diversityWarning = offers >= 3 && topDomainShare > 0.7;

    out[category] = {
      offers,
      domains,
      topDomains,
      target,
      missing,
      meetsTarget,
      diversityWarning,
      topDomainShare: Number.isFinite(topDomainShare) ? Number(topDomainShare.toFixed(4)) : 0,
    };

    if (!meetsTarget) {
      gaps.push({
        category,
        target,
        offers,
        missing,
      });
    }
  }

  gaps.sort((a, b) => {
    if (b.missing !== a.missing) return b.missing - a.missing;
    return a.category.localeCompare(b.category);
  });

  return { byCategory: out, gaps, invalidDomainUrls };
}

function computeByRoleMetrics(pool) {
  const byRole = pool?.byRole || {};
  const rows = [];
  for (const [roleId, list] of Object.entries(byRole)) {
    if (!Array.isArray(list)) continue;
    const domainCounts = new Map();
    for (const e of list) {
      const domain = String(e?.domain || safeHostnameFromUrl(e?.url || "")).toLowerCase();
      if (!domain) continue;
      domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    }
    rows.push({
      roleId,
      offers: list.length,
      domains: domainCounts.size,
      topDomains: computeTopDomains(domainCounts, 3),
    });
  }
  rows.sort((a, b) => {
    if (b.offers !== a.offers) return b.offers - a.offers;
    return a.roleId.localeCompare(b.roleId);
  });
  const top30 = rows.slice(0, 30);
  const byRoleTop = {};
  for (const r of top30) byRoleTop[r.roleId] = r;
  return { byRoleTop, top30 };
}

function loadTargetsIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = readJsonFile(filePath);
  if (!raw || typeof raw !== "object") return null;
  const categoryTargets = raw.categoryTargets && typeof raw.categoryTargets === "object" ? raw.categoryTargets : null;
  const roleTargets = raw.roleTargets && typeof raw.roleTargets === "object" ? raw.roleTargets : null;
  return { categoryTargets, roleTargets };
}

function generateExternalPoolReport({
  market,
  date,
  pool,
  allowlistDomains,
  targets,
}) {
  const allowlistSet = new Set((allowlistDomains || []).map((d) => String(d).toLowerCase()));

  const categoryTargets = targets?.categoryTargets || DEFAULT_CATEGORY_TARGETS;

  const offersAll = listOffersFromPool(pool);
  const totalsUniqueOffers = countUniqueOffersByUrl(offersAll);
  const allDomainCounts = new Map();
  for (const o of offersAll) {
    const domain = String(o?.entry?.domain || safeHostnameFromUrl(o?.entry?.url || "")).toLowerCase();
    if (!domain) continue;
    allDomainCounts.set(domain, (allDomainCounts.get(domain) || 0) + 1);
  }
  const topDomains = computeTopDomains(allDomainCounts, 10);

  const uniqueDomains = allDomainCounts.size;

  const { byCategory, gaps: categoryGaps, invalidDomainUrls } = computeByCategoryMetrics(
    pool,
    allowlistSet,
    categoryTargets,
  );
  const { byRoleTop, top30 } = computeByRoleMetrics(pool);

  const invalidDomainCount = invalidDomainUrls.filter(Boolean).length;

  const gaps = {
    categories: categoryGaps,
    roles: [],
  };

  const reportJson = {
    market,
    date,
    totals: {
      offers: totalsUniqueOffers,
      domains: uniqueDomains,
      allowlistDomains: allowlistSet.size,
      topDomains,
    },
    byCategory: Object.fromEntries(CATEGORY_ORDER.map((c) => [c, byCategory[c]])),
    byRole: byRoleTop,
    gaps,
    hygiene: {
      invalidDomainCount,
      duplicatePrunedCount: null,
    },
    notes: {
      offersCountDefinition: "Unique canonical URLs across byRole + byCategory lists (may double-count across scopes in other metrics).",
      duplicatePrunedCount: "Not tracked by build script (null).",
    },
  };

  const mdLines = [];
  mdLines.push(`# External Offers Pool Report (${market}) — ${date}`);
  mdLines.push("");
  mdLines.push("This report is generated from local pool JSON + allowlist + dicts. Do not edit by hand.");
  mdLines.push("");
  mdLines.push("## Summary");
  mdLines.push(`- Total offers (unique URLs): **${totalsUniqueOffers}**`);
  mdLines.push(`- Unique domains: **${uniqueDomains}**`);
  mdLines.push(`- Allowlist domains: **${allowlistSet.size}**`);
  mdLines.push(`- Invalid-domain offers (should be 0): **${invalidDomainCount}**`);
  mdLines.push("");
  mdLines.push("### Top domains (by entry count)");
  for (const td of topDomains) mdLines.push(`- ${td.domain}: ${td.count}`);
  if (topDomains.length === 0) mdLines.push("- (none)");
  mdLines.push("");
  mdLines.push("## Coverage by category");
  mdLines.push("| category | offers | unique domains | target | meets? | top domains |");
  mdLines.push("|---|---:|---:|---:|:---:|---|");
  for (const category of CATEGORY_ORDER) {
    const m = byCategory[category];
    const top = (m.topDomains || []).slice(0, 3).map((d) => `${d.domain} (${d.count})`).join(", ");
    mdLines.push(
      `| ${category} | ${m.offers} | ${m.domains} | ${m.target} | ${m.meetsTarget ? "✅" : "❌"} | ${top || "-"} |`,
    );
  }
  mdLines.push("");
  mdLines.push("## Gap list (categories below target)");
  if (categoryGaps.length === 0) {
    mdLines.push("- (none)");
  } else {
    for (const g of categoryGaps) {
      mdLines.push(`- ${g.category}: missing **${g.missing}** (have ${g.offers}, target ${g.target})`);
    }
  }
  mdLines.push("");
  mdLines.push("## Coverage by role (top 30 by offers)");
  mdLines.push("| roleId | offers | unique domains | top domains |");
  mdLines.push("|---|---:|---:|---|");
  if (top30.length === 0) {
    mdLines.push("| (none) | 0 | 0 | - |");
  } else {
    for (const r of top30) {
      const top = (r.topDomains || []).map((d) => `${d.domain} (${d.count})`).join(", ");
      mdLines.push(`| ${r.roleId} | ${r.offers} | ${r.domains} | ${top || "-"} |`);
    }
  }
  mdLines.push("");
  mdLines.push("## Suggested actions");
  const suggestions = [];
  for (const category of CATEGORY_ORDER) {
    const m = byCategory[category];
    if (m.missing > 0) suggestions.push(`Add **${m.missing}** more offers for category **${category}**.`);
    if (m.diversityWarning) suggestions.push(`Improve domain diversity for category **${category}** (top domain share ${Math.round(m.topDomainShare * 100)}%).`);
  }
  if (invalidDomainCount > 0) suggestions.push("Fix invalid-domain offers (domain not in allowlist).");
  if (suggestions.length === 0) {
    mdLines.push("- (none)");
  } else {
    for (const s of suggestions) mdLines.push(`- ${s}`);
  }
  mdLines.push("");

  const reportMd = `${mdLines.join("\n")}\n`;
  return { reportJson, reportMd };
}

function writeExternalPoolReportFiles({ outDir, market, date, reportJson, reportMd }) {
  fs.mkdirSync(outDir, { recursive: true });
  const base = `external_pool_report_${market}_${date}`;
  const mdPath = path.join(outDir, `${base}.md`);
  const jsonPath = path.join(outDir, `${base}.json`);
  fs.writeFileSync(mdPath, reportMd, "utf8");
  fs.writeFileSync(jsonPath, stableJsonStringify(reportJson), "utf8");
  return { mdPath, jsonPath };
}

function usageAndExit(code) {
  console.log(`Usage:
  npm run external:report -- --market US|JP

Optional flags:
  --date YYYY-MM-DD
  --outDir <dir>         (default: artifacts/reports)
  --pool <path>          (default: src/layer3/data/externalLinks_<market>.json)
  --allowlist <path>     (default: src/layer3/data/external_allowlist_<market>.txt)
  --targets <path>       (default: src/layer3/data/external_pool_targets_<market>.json if present)

Notes:
  - This script uses local files only (no network).
  - If the pool JSON is missing, run: npm run external:build-pool
`);
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const market = String(args.market || "").trim().toUpperCase();
  if (!ALLOWED_MARKETS.has(market)) usageAndExit(1);

  const repoRoot = path.join(__dirname, "..");
  const date = String(args.date || todayUtcYYYYMMDD()).trim();
  const outDir = args.outDir
    ? path.resolve(repoRoot, String(args.outDir))
    : path.join(repoRoot, "artifacts", "reports");

  const poolPath = args.pool
    ? path.resolve(repoRoot, String(args.pool))
    : path.join(repoRoot, "src", "layer3", "data", `externalLinks_${market}.json`);
  const allowlistPath = args.allowlist
    ? path.resolve(repoRoot, String(args.allowlist))
    : path.join(repoRoot, "src", "layer3", "data", `external_allowlist_${market}.txt`);
  const targetsPath = args.targets
    ? path.resolve(repoRoot, String(args.targets))
    : path.join(repoRoot, "src", "layer3", "data", `external_pool_targets_${market}.json`);

  if (!fs.existsSync(poolPath)) {
    console.error(`[external:report] Missing pool JSON at ${poolPath}`);
    console.error(`[external:report] Run: npm run external:build-pool`);
    process.exit(1);
  }

  const pool = readJsonFile(poolPath);
  const allowlistDomains = readLinesFile(allowlistPath);
  const targets = loadTargetsIfExists(targetsPath);

  const { reportJson, reportMd } = generateExternalPoolReport({
    market,
    date,
    pool,
    allowlistDomains,
    targets,
  });

  const { mdPath, jsonPath } = writeExternalPoolReportFiles({
    outDir,
    market,
    date,
    reportJson,
    reportMd,
  });

  console.log(`[external:report] wrote ${path.relative(repoRoot, mdPath)}`);
  console.log(`[external:report] wrote ${path.relative(repoRoot, jsonPath)}`);
  if (reportJson.hygiene.invalidDomainCount > 0) {
    console.warn(`[external:report] WARNING: invalidDomainCount=${reportJson.hygiene.invalidDomainCount} (domains not in allowlist)`);
  }
}

if (require.main === module) main();

module.exports = {
  generateExternalPoolReport,
  writeExternalPoolReportFiles,
  readLinesFile,
};

