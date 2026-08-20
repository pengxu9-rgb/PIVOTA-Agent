#!/usr/bin/env node
/**
 * Cold zero-rate probe for the PUBLIC read MCP tier (`search_catalog`, anonymous).
 *
 * WHY THIS EXISTS. On 2026-08-20 ordinary beauty queries answered "No products matched this search." —
 * a confident factual claim about the catalog that an LLM agent relays to the shopper as "no such
 * products exist". Two independent mechanisms produced it, and they are told apart by ONE observation:
 * whether a whitespace/case variant of the same question returns products.
 *
 *   Mechanism 2 (result cache keyed on the raw tool args, empty pages stored) — SOME variant rescues it.
 *   Mechanism 1 (a resolved category prefix discarding the query text)        — NO variant rescues it.
 *
 * So the probe does not just count zeros: for every zero it tries the variants and reports the split.
 * A run that only counted zeros could not tell a fixed mechanism from an unfixed one.
 *
 * VARIANTS MUST BE TRIED SEPARATELY, NOT JUST A TRAILING SPACE. Each distinct raw string is its own
 * cache key and each independently rolls the dice on a transient zero, so a trailing-space probe alone
 * misattributes: in the 2026-08-20 baseline `lip liner`, `cushion compact`, `lip sleeping mask` and
 * `purple shampoo` all survived the space probe and were rescued by Title Case.
 *
 * Usage:
 *   node scripts/audit-public-search-zero-rate.mjs [--url https://mcp.pivota.cc/mcp] [--out report.json]
 *
 * Send a query set ONLY ONCE per run if you want a COLD number — a repeat inside the cache TTL measures
 * the cache, not the lane.
 */

const DEFAULT_URL = 'https://mcp.pivota.cc/mcp';

// Realistic shopper queries spread across skincare / makeup / haircare. Haircare is over-represented on
// purpose: it is where the category-prefix resolver aims at the sparsest buckets.
const QUERIES = [
  'cushion compact', 'lip liner', 'eye cream for dark circles', 'peeling gel', 'cica cream',
  'collagen mask', 'sleeping pack', 'body lotion', 'hand cream', 'nail strengthener',
  'setting spray', 'primer for oily skin', 'color corrector', 'eyelash serum', 'hair serum',
  'purple shampoo', 'curl cream', 'heat protectant', 'split end treatment', 'volumizing mousse',
  'retinol cream', 'glycolic acid', 'ceramide moisturizer', 'snail mucin', 'propolis ampoule',
  'green tea cleanser', 'oil cleanser', 'exfoliating pads', 'spot patch', 'lip sleeping mask',
];

function variantsOf(query) {
  return [
    `${query} `,
    query.replace(/\b\w/g, (c) => c.toUpperCase()),
    query.toUpperCase(),
    query.replace(/ /g, '  '),
  ];
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = arg('--url', DEFAULT_URL);
const outPath = arg('--out', null);

async function probe(query) {
  const startedAt = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'search_catalog', arguments: { query, limit: 10 } },
    }),
  });
  let body = await res.text();
  if (body.startsWith('event:') || body.startsWith('data:')) {
    const line = body.split('\n').find((l) => l.startsWith('data:'));
    body = line ? line.slice(5).trim() : body;
  }
  const parsed = JSON.parse(body);
  const sc = parsed?.result?.structuredContent ?? {};
  return {
    query,
    returned: sc.returned ?? 0,
    // Emitted by publicReadProjection.js so a caller can tell a coverage gap from an absence without
    // parsing prose. Absent on a pre-fix deployment.
    empty_reason: sc.empty_reason ?? null,
    note: sc.note ?? null,
    elapsed_s: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = [];
for (const query of QUERIES) {
  const cold = await probe(query);
  let rescuedBy = null;
  if (cold.returned === 0) {
    for (const variant of variantsOf(query)) {
      await sleep(250);
      const alt = await probe(variant);
      if (alt.returned > 0) { rescuedBy = variant; break; }
    }
  }
  const row = { ...cold, rescued_by: rescuedBy };
  rows.push(row);
  console.log(JSON.stringify(row));
  await sleep(350);
}

const zeros = rows.filter((r) => r.returned === 0);
const cacheShaped = zeros.filter((r) => r.rescued_by !== null);
const laneShaped = zeros.filter((r) => r.rescued_by === null);
// A note that still asserts an absence while the page was emptied by this tier's own filters is the
// user-facing half of the defect, and it survives independently of the zero-rate.
const dishonest = rows.filter((r) => r.returned === 0 && r.empty_reason && r.empty_reason !== 'no_match'
  && /No products matched this search/.test(r.note || ''));

console.log('\n===== SUMMARY =====');
console.log(`queries                       : ${rows.length}`);
console.log(`zero-result                   : ${zeros.length} (${Math.round((100 * zeros.length) / rows.length)}%)`);
console.log(`  rescued by a variant   (M2) : ${cacheShaped.length}  ${JSON.stringify(cacheShaped.map((r) => r.query))}`);
console.log(`  no variant rescues     (M1) : ${laneShaped.length}  ${JSON.stringify(laneShaped.map((r) => r.query))}`);
console.log(`empty pages mislabelled       : ${dishonest.length}`);

if (outPath) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(outPath, JSON.stringify({ url, at: new Date().toISOString(), rows }, null, 2));
  console.log(`\nwrote ${outPath}`);
}
