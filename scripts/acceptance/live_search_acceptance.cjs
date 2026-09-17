#!/usr/bin/env node
'use strict';

// Live acceptance: Meitu's exact requests against the DEPLOYED gateway, end to end.
//
// tests/acceptance proves the contract + gate layer offline. This proves the rest --
// canonical SQL recall, seed lane, ranking, transport projection, the resolve lane and the
// served PRICE -- by making the same calls Meitu made (evidence E1-E5, 2026-09-15) and
// comparing against the merchant's own storefront.
//
// Run it after every gateway deploy (the gateway never deploys on merge):
//
//   PIVOTA_API_KEY=... node scripts/acceptance/live_search_acceptance.cjs [--out report.json] [--report-only]
//
// PIVOTA_API_KEY is sent as X-API-Key (REST) and X-Agent-API-Key (hosted UCP);
// PIVOTA_UCP_AGENT_API_KEY overrides the latter. Keys are read from the environment only
// and never printed. Merchant truth comes from the public `/products/<handle>.json`.
//
// Exit code: 1 if a case whose `live.status` is "pass" fails, or a "known_fail" one now passes
// (promote `live.status` in tests/acceptance/cases.json). --report-only always exits 0.
// The offline `status` is not consulted: the gate passing offline says nothing about recall,
// ranking or price on the deployed gateway.

const fs = require('fs');
const path = require('path');

const CASES = require(path.join(__dirname, '..', '..', 'tests', 'acceptance', 'cases.json'));
const REST_BASE = process.env.PIVOTA_REST_BASE || 'https://api.pivota.cc';
const UCP_URL = process.env.PIVOTA_UCP_URL || 'https://commerce.mcp.pivota.cc/ucp/mcp';
const PRICE_TOLERANCE = 0.01;

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Does a served product describe the live target? The whole normalised target title
// contained in the served title (so "[BRAND] <title>" matches), or the merchant handle in
// any URL field.
function matchesTarget(product, target) {
  if (!product || typeof product !== 'object') return false;
  const title = normalizeTitle(product.title || product.name);
  if (title && title.includes(normalizeTitle(target.title))) return true;
  const urls = [product.url, product.canonical_url, product.destination_url, product.external_url];
  return urls.some((u) => typeof u === 'string' && u.includes(`/products/${target.url_handle}`));
}

// The served price of a matched product, as { amount, currency } in MAJOR units.
// REST transport carries price/price_amount + currency; hosted UCP carries variants[].price
// as { amount (minor units), currency }.
function servedPrice(product, surface) {
  if (surface === 'ucp') {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const priced = variants.find((v) => v && v.price && Number.isFinite(Number(v.price.amount)));
    return priced ? { amount: Number(priced.price.amount) / 100, currency: priced.price.currency || null } : null;
  }
  const raw = product.price_amount != null ? product.price_amount : product.price;
  const amount = typeof raw === 'object' && raw ? Number(raw.amount) : Number(raw);
  return Number.isFinite(amount) ? { amount, currency: product.currency || null, as_of: product.price_as_of || null } : null;
}

// Merchant truth for the target variant, from Shopify's product JSON.
function merchantVariantPrice(productJson, target) {
  const variants = (productJson && productJson.product && productJson.product.variants) || [];
  const v = variants.find((x) => String(x.id) === String(target.variant_id));
  if (!v) return null;
  const amount = Number(v.price);
  return Number.isFinite(amount) ? { amount, currency: v.price_currency || null } : null;
}

function comparePrice(served, merchant) {
  if (!served || !merchant) return { ok: false, why: !served ? 'no served price' : 'no merchant price' };
  if (merchant.currency && served.currency && merchant.currency !== served.currency) {
    return { ok: false, why: `currency ${served.currency} != merchant ${merchant.currency}` };
  }
  const delta = Math.abs(served.amount - merchant.amount);
  return delta <= PRICE_TOLERANCE ? { ok: true } : { ok: false, why: `served ${served.amount} != merchant ${merchant.amount}` };
}

async function getJson(fetchImpl, url, init) {
  const started = Date.now();
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, body, elapsed_ms: Date.now() - started };
}

async function runLive({ fetchImpl = fetch, env = process.env } = {}) {
  const restKey = env.PIVOTA_API_KEY;
  const ucpKey = env.PIVOTA_UCP_AGENT_API_KEY || restKey;
  if (!restKey) throw new Error('PIVOTA_API_KEY is not set');

  const merchant = {};
  for (const [id, target] of Object.entries(CASES.live_targets || {})) {
    const r = await getJson(fetchImpl, target.merchant_product_json, { headers: { accept: 'application/json' } });
    merchant[id] = { status: r.status, price: merchantVariantPrice(r.body, target) };
  }

  const results = [];
  for (const c of CASES.cases.filter((x) => x.live)) {
    const target = CASES.live_targets[c.expect.target];
    const topN = c.live.top_n;
    const surfaces = {};

    const restUrl = `${REST_BASE}/agent/v1/beauty/products/search?${new URLSearchParams({
      query: c.query, market: c.market || 'SG', allow_external_seed: 'true', allow_stale_cache: 'false',
      in_stock_only: 'false', limit: String(Math.max(topN, 20)),
    })}`;
    const rest = await getJson(fetchImpl, restUrl, { headers: { 'X-API-Key': restKey, accept: 'application/json' } });
    surfaces.rest = rest;

    const ucp = await getJson(fetchImpl, UCP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Agent-API-Key': ucpKey },
      body: JSON.stringify({
        jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
        params: { name: 'search_catalog', arguments: { meta: {}, catalog: {
          query: c.query, pagination: { limit: Math.max(topN, 20) }, context: { currency: 'SGD' }, filters: { available: false },
        } } },
      }),
    });
    try {
      ucp.body = JSON.parse(ucp.body.result.content[0].text);
    } catch { /* leave as-is; the product lookup below reports it */ }
    surfaces.ucp = ucp;

    const perSurface = {};
    for (const [name, r] of Object.entries(surfaces)) {
      const products = (r.body && Array.isArray(r.body.products)) ? r.body.products : [];
      const rank = products.findIndex((p) => matchesTarget(p, target));
      const found = rank >= 0 && rank < topN;
      const price = found ? comparePrice(servedPrice(products[rank], name), merchant[c.expect.target].price) : null;
      perSurface[name] = {
        http_status: r.status, elapsed_ms: r.elapsed_ms, returned: products.length, rank: rank >= 0 ? rank + 1 : null,
        found_in_top_n: found, price_ok: price ? price.ok : null, price_problem: price && !price.ok ? price.why : null,
        reason_code: r.body && r.body.metadata ? r.body.metadata.reason_code || null : null,
      };
    }
    const pass = Object.values(perSurface).every((s) => s.found_in_top_n && s.price_ok);
    results.push({ id: c.id, query: c.query, top_n: topN, status: c.live.status, pass, surfaces: perSurface });
  }

  for (const rc of CASES.live_resolve_cases || []) {
    const target = CASES.live_targets[rc.target];
    const r = await getJson(fetchImpl, `${REST_BASE}/agent/v1/products/resolve?${new URLSearchParams({ sku_id: rc.sku_id, limit: '10' })}`,
      { headers: { 'X-API-Key': restKey, accept: 'application/json' } });
    const candidates = (r.body && Array.isArray(r.body.candidates)) ? r.body.candidates : [];
    const pass = Boolean(r.body && r.body.resolved) && candidates.some((cand) => matchesTarget(cand, target) || JSON.stringify(cand).includes(target.url_handle));
    results.push({ id: rc.id, sku_id: rc.sku_id, status: rc.status, pass, http_status: r.status, reason_code: r.body ? r.body.reason_code || null : null });
  }

  const regressions = results.filter((r) => r.status === 'pass' && !r.pass).map((r) => r.id);
  const promotions = results.filter((r) => r.status === 'known_fail' && r.pass).map((r) => r.id);
  return { ran_at: new Date().toISOString(), rest_base: REST_BASE, ucp_url: UCP_URL, merchant, results, regressions, promotions };
}

async function main(argv) {
  const outFlag = argv.indexOf('--out');
  const report = await runLive();
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (outFlag >= 0 && argv[outFlag + 1]) fs.writeFileSync(argv[outFlag + 1], text);
  else process.stdout.write(text);
  const passed = report.results.filter((r) => r.pass).length;
  console.error(`live acceptance: ${passed}/${report.results.length} pass; regressions ${report.regressions.length}; promotions due ${report.promotions.length}`);
  if (argv.includes('--report-only')) return 0;
  return report.regressions.length || report.promotions.length ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(`live acceptance: ${err.message}`);
    process.exitCode = 2;
  });
}

module.exports = { comparePrice, matchesTarget, merchantVariantPrice, normalizeTitle, runLive, servedPrice };
