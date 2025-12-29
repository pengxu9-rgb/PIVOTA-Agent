#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_CATEGORIES = ["prep", "base", "contour", "brow", "eye", "blush", "lip"];

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

function todayYYYYMMDD() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function readJsonOrNull(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isSoon(dateStr, now, days) {
  if (!dateStr) return false;
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  const deltaDays = (t - now) / (1000 * 60 * 60 * 24);
  return deltaDays >= 0 && deltaDays <= days;
}

function buildReport(pool, date) {
  const byRole = pool?.byRole && typeof pool.byRole === "object" ? pool.byRole : {};
  const byCategory = pool?.byCategory && typeof pool.byCategory === "object" ? pool.byCategory : {};

  let totalPins = 0;
  const rolesPinned = Object.keys(byRole).length;
  const categoriesPinned = Object.keys(byCategory).length;
  const now = Date.parse(`${date}T00:00:00Z`);

  const soonToExpire = [];
  for (const roleId of Object.keys(byRole)) {
    const pins = Array.isArray(byRole[roleId]) ? byRole[roleId] : [];
    totalPins += pins.length;
    for (const p of pins) {
      if (isSoon(p.endDate, now, 14)) {
        soonToExpire.push({ scope: "role", scopeId: roleId, skuId: p.skuId, endDate: p.endDate });
      }
    }
  }
  for (const cat of Object.keys(byCategory)) {
    const pins = Array.isArray(byCategory[cat]) ? byCategory[cat] : [];
    totalPins += pins.length;
    for (const p of pins) {
      if (isSoon(p.endDate, now, 14)) {
        soonToExpire.push({ scope: "category", scopeId: cat, skuId: p.skuId, endDate: p.endDate });
      }
    }
  }

  const gaps = ALLOWED_CATEGORIES.filter((c) => !byCategory[c] || !Array.isArray(byCategory[c]) || byCategory[c].length === 0);

  const reportJson = {
    market: pool?.market || "UNKNOWN",
    date,
    totals: { pins: totalPins, rolesPinned, categoriesPinned },
    gaps: { categoriesNoPins: gaps },
    hygiene: { soonToExpire },
  };

  const lines = [];
  lines.push(`# Internal Pins Report (${reportJson.market})`);
  lines.push("");
  lines.push(`Date: ${date}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Total pins: ${totalPins}`);
  lines.push(`- Roles pinned: ${rolesPinned}`);
  lines.push(`- Categories pinned: ${categoriesPinned}`);
  lines.push("");
  lines.push("## Category coverage (informational)");
  lines.push("");
  lines.push("| Category | Pins |");
  lines.push("|---|---:|");
  for (const c of ALLOWED_CATEGORIES) {
    const n = Array.isArray(byCategory[c]) ? byCategory[c].length : 0;
    lines.push(`| ${c} | ${n} |`);
  }
  lines.push("");
  lines.push("## Gaps");
  if (gaps.length === 0) lines.push("- None");
  else for (const c of gaps) lines.push(`- ${c}: 0 pins`);
  lines.push("");
  lines.push("## Soon-to-expire pins (end_date within 14 days)");
  if (soonToExpire.length === 0) lines.push("- None");
  else for (const e of soonToExpire.sort((a, b) => String(a.endDate).localeCompare(String(b.endDate)))) {
    lines.push(`- ${e.scope}:${e.scopeId} sku=${e.skuId} endDate=${e.endDate}`);
  }
  lines.push("");

  return { markdown: `${lines.join("\n")}\n`, json: reportJson };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const market = String(args.market || "").trim().toUpperCase();
  if (!market || (market !== "US" && market !== "JP")) {
    console.error("Usage: npm run internal:report -- --market US|JP");
    process.exit(2);
  }

  const date = args.date ? String(args.date) : todayYYYYMMDD();
  const dataDir = path.join("src", "layer3", "data");
  const poolPath = path.join(dataDir, market === "JP" ? "internalPins_jp.json" : "internalPins_us.json");
  const pool = readJsonOrNull(poolPath);
  if (!pool) {
    console.error(`[internal:report] Missing pool JSON at ${poolPath}`);
    console.error(`[internal:report] Run: npm run internal:build-pins`);
    process.exit(1);
  }

  const outDir = path.join("artifacts", "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const { markdown, json } = buildReport(pool, date);
  const mdPath = path.join(outDir, `internal_pins_report_${market.toLowerCase()}_${date}.md`);
  const jsonPath = path.join(outDir, `internal_pins_report_${market.toLowerCase()}_${date}.json`);
  fs.writeFileSync(mdPath, markdown, "utf8");
  fs.writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  console.log(`[internal:report] wrote ${mdPath}`);
  console.log(`[internal:report] wrote ${jsonPath}`);
}

if (require.main === module) {
  main();
}

module.exports = { buildReport };

