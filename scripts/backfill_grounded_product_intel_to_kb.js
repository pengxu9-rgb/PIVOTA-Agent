#!/usr/bin/env node
'use strict';

/*
 * Grounded dossier → aurora_product_intel_kb backfill (dossier authoring engine, Phase 1).
 *
 * Makes the grounded generator the PRIMARY, at-rest content engine: it synthesizes a
 * Tier-G graded dossier per product and PERSISTS it to aurora_product_intel_kb so the
 * serve path (hydrateProductWithPublishedIntel, requireReviewed) returns it directly —
 * fixing latency (served at rest) and lifting graded_claims / structured_why off the
 * positioning-blurb floor. See docs/dossier-authoring-engine-plan.md.
 *
 * Precedence (the inversion): a grounded dossier outranks a positioning blurb
 * (seller-tier copy / strict_human_manual_rewrite seller summary) and replaces it in
 * the KB. It NEVER overwrites a protected genuine human/community dossier
 * (community_supported, verified pivota_reviewed, real strict-human pilots).
 *
 * DRY-RUN by default. Pass --write to persist. Re-run scripts/eval_dossier_coverage.cjs
 * afterwards to watch the number climb.
 *
 * Usage:
 *   # discover via agent search, dry-run:
 *   AGENT_KEY=<key> BASE=https://pivota-agent-staging.up.railway.app \
 *     node scripts/backfill_grounded_product_intel_to_kb.js --queries "centella serum,niacinamide serum" --limit 50
 *   # specific products, write:
 *   AGENT_KEY=<key> BASE=... node scripts/backfill_grounded_product_intel_to_kb.js --product-ids m1:p1,m2:p2 --write
 *   # offline / pre-assembled products (each row carries ingredient_intel or ingredients_inci):
 *   node scripts/backfill_grounded_product_intel_to_kb.js --products-file /tmp/products.json --write
 *
 * Reading existing KB rows + writing require DB access (DATABASE_URL); discovery/loading
 * via the gateway require AGENT_KEY + BASE. --products-file skips the gateway.
 */

const fs = require('fs');
const path = require('path');

const {
  PRODUCT_INTEL_CONTRACT_VERSION,
  synthesizeGroundedProductIntelBundle,
  isGroundedProductIntelBundle,
  isProtectedDossierBundle,
  isPositioningBlurbBundle,
} = require('../src/pdpProductIntel');
const { readProductIntelBundleFromKbRow } = require('../src/services/externalSeedPdpReadiness');

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

// ── pure helpers (unit-tested) ──────────────────────────────────────────────

function countGradedClaims(bundle) {
  const core = asObject(bundle?.product_intel_core) || {};
  return asArray(core.evidence_claims).filter(
    (claim) => /^[ABC]$/i.test(asString(claim?.evidence_grade)) && asString(claim?.substantiation_status),
  ).length;
}

// Decide whether a freshly synthesized grounded dossier should replace whatever is
// already in the KB slot. Grounded is PRIMARY: write unless an existing protected
// genuine human/community dossier holds the slot.
function decideGroundedWrite({ existingKbRow = null, groundedBundle = null } = {}) {
  if (!groundedBundle || !isGroundedProductIntelBundle(groundedBundle)) {
    return { write: false, reason: 'no_grounded_bundle' };
  }
  const existing = readProductIntelBundleFromKbRow(existingKbRow);
  if (!existing) return { write: true, reason: 'new' };
  if (isProtectedDossierBundle(existing)) return { write: false, reason: 'protected_dossier_kept' };
  if (isGroundedProductIntelBundle(existing)) return { write: true, reason: 'refresh_grounded' };
  if (isPositioningBlurbBundle(existing)) return { write: true, reason: 'replace_positioning_blurb' };
  // existing is non-servable junk (e.g. a Tier-L draft) — grounded is strictly better.
  return { write: true, reason: 'replace_nonservable' };
}

// Build the aurora_product_intel_kb entry. Mirrors the pilot publish shape:
//   analysis = { contract_version, product_intel_v1: <bundle> }
function buildGroundedKbEntry({
  productId,
  canonicalProductRef = null,
  groundedBundle,
  existingKbRow = null,
  now = new Date().toISOString(),
} = {}) {
  const bundle = { ...groundedBundle };
  if (canonicalProductRef && !bundle.canonical_product_ref) bundle.canonical_product_ref = canonicalProductRef;
  const grounding = asObject(asObject(bundle.provenance)?.grounding) || {};
  const existingBundle = readProductIntelBundleFromKbRow(existingKbRow);
  const replaced = existingBundle
    ? {
        previous_source: asString(existingKbRow?.source) || null,
        previous_evidence_profile:
          asString(existingBundle.evidence_profile || existingBundle.product_intel_core?.evidence_profile) || null,
        previous_review_tier: asString(existingBundle.provenance?.review_tier || existingBundle.provenance?.tier) || null,
        previous_generator: asString(existingBundle.provenance?.generator) || null,
      }
    : null;
  return {
    kb_key: `product:${asString(productId)}`,
    analysis: {
      contract_version: PRODUCT_INTEL_CONTRACT_VERSION,
      product_intel_v1: bundle,
    },
    source: 'pivota_grounded_synthesis_v1',
    source_meta: {
      tier: 'grounded',
      review_tier: 'grounded',
      reviewer_kind: 'automated_grounded',
      evidence_profile: 'grounded_verified',
      quality_state: 'eligible',
      generator: 'pivota_grounded_v1',
      backfill: 'dossier_authoring_engine_phase1',
      graded_claims: countGradedClaims(bundle),
      active_slugs: asArray(grounding.active_slugs),
      ...(replaced ? { replaced } : {}),
    },
    last_success_at: now,
    last_error: null,
  };
}

// Tolerant extraction of a generator-ready product (with INCI) from a get_pdp_v2
// response. Falls back gracefully; returns null when no usable INCI is found.
function extractGeneratorProductFromPdp(pdpResponse, ref = {}) {
  const productId = asString(ref.product_id);
  // locate the richest product-like node + any ingredient list in the response tree.
  let product = null;
  const inciItems = [];
  const activeItems = [];
  const seen = new Set();
  const pushItems = (value, sink) => {
    for (const item of asArray(value)) {
      const name = asString(typeof item === 'string' ? item : item?.inci || item?.name || item?.display_name || item?.label);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(`${sink === activeItems ? 'a' : 'i'}:${key}`)) continue;
      seen.add(`${sink === activeItems ? 'a' : 'i'}:${key}`);
      sink.push(name);
    }
  };
  const walk = (node, depth) => {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    // ingredient lists, wherever they live (ingredients_inci module, ingredient_intel, product)
    pushItems(node.ingredients_inci, inciItems);
    pushItems(node.ingredients, inciItems);
    // typed PDP module: { type: 'ingredients_inci', data: { items|ingredients_inci|ingredients } }
    if (asString(node.type).toLowerCase().includes('ingredient') && asObject(node.data)) {
      pushItems(node.data.items, inciItems);
      pushItems(node.data.ingredients_inci, inciItems);
      pushItems(node.data.ingredients, inciItems);
      pushItems(node.data.active_items, activeItems);
    }
    if (asObject(node.ingredient_intel)) {
      pushItems(node.ingredient_intel.items, inciItems);
      pushItems(node.ingredient_intel.active_items, activeItems);
    }
    pushItems(node.active_items, activeItems);
    pushItems(node.key_ingredients, activeItems);
    pushItems(node.hero_ingredients, activeItems);
    // candidate product node (carries an id + a name/title)
    const nodeProductId = asString(node.product_id || node.id);
    if (nodeProductId && asString(node.title || node.name) && (!product || asObject(node.ingredient_intel) || node.ingredients_inci)) {
      product = node;
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(pdpResponse, 0);

  if (!inciItems.length && !activeItems.length) return null;
  const base = asObject(product) || {};
  return {
    product_id: productId || asString(base.product_id || base.id),
    ...(ref.merchant_id ? { merchant_id: asString(ref.merchant_id) } : {}),
    title: asString(base.title || base.name),
    brand: asString(base.brand?.name || base.brand),
    category: asString(base.category || base.product_type),
    key_ingredients: activeItems,
    ingredient_intel: {
      items: inciItems,
      active_items: activeItems,
      raw_text: inciItems.join(', '),
    },
  };
}

// ── orchestration (I/O injected for tests) ──────────────────────────────────

async function backfillOne({ ref, loadProduct, getExisting, buildGrounded = null } = {}) {
  const productId = asString(ref?.product_id);
  if (!productId) return { ref, status: 'skipped', reason: 'no_product_id' };

  let product = null;
  try {
    product = await loadProduct(ref);
  } catch (err) {
    return { ref, status: 'error', reason: `load_failed:${asString(err?.message) || 'unknown'}` };
  }
  if (!product) return { ref, status: 'skipped', reason: 'product_not_loaded' };

  const canonicalProductRef = {
    product_id: productId,
    ...(ref.merchant_id ? { merchant_id: asString(ref.merchant_id) } : {}),
  };

  let groundedBundle = null;
  try {
    groundedBundle = await synthesizeGroundedProductIntelBundle({ product, canonicalProductRef, buildGrounded });
  } catch (err) {
    return { ref, status: 'error', reason: `synth_failed:${asString(err?.message) || 'unknown'}` };
  }
  if (!groundedBundle) return { ref, status: 'skipped', reason: 'no_grounded_bundle' };

  let existingKbRow = null;
  try {
    existingKbRow = (await getExisting(productId)) || null;
  } catch {
    existingKbRow = null;
  }

  const decision = decideGroundedWrite({ existingKbRow, groundedBundle });
  const gradedClaims = countGradedClaims(groundedBundle);
  if (!decision.write) {
    return { ref, status: 'skipped', reason: decision.reason, graded_claims: gradedClaims };
  }
  const entry = buildGroundedKbEntry({ productId, canonicalProductRef, groundedBundle, existingKbRow });
  return {
    ref,
    status: 'eligible',
    reason: decision.reason,
    kb_key: entry.kb_key,
    graded_claims: gradedClaims,
    entry,
  };
}

async function runBackfill({
  refs,
  loadProduct,
  getExisting,
  upsert = async () => undefined,
  write = false,
  buildGrounded = null,
  logger = console,
} = {}) {
  const results = [];
  for (const ref of asArray(refs)) {
    // serial: the generator + per-product KB read are light; this keeps the
    // batched ingredient-KB lookups predictable and avoids hammering the gateway.
    // eslint-disable-next-line no-await-in-loop
    const result = await backfillOne({ ref, loadProduct, getExisting, buildGrounded });
    if (result.status === 'eligible' && write) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await upsert(result.entry);
        result.status = 'written';
      } catch (err) {
        result.status = 'error';
        result.reason = `write_failed:${asString(err?.message) || 'unknown'}`;
      }
    }
    const { entry, ...logged } = result;
    logger?.log?.(JSON.stringify(logged));
    results.push(result);
  }
  return summarize(results, write);
}

function summarize(results, write) {
  const byStatus = {};
  const byReason = {};
  let gradedTotal = 0;
  for (const row of results) {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
    byReason[row.reason] = (byReason[row.reason] || 0) + 1;
    gradedTotal += Number(row.graded_claims || 0);
  }
  const eligible = results.filter((r) => r.status === 'eligible' || r.status === 'written').length;
  return {
    mode: write ? 'write' : 'dry_run',
    scanned: results.length,
    eligible,
    written: byStatus.written || 0,
    by_status: byStatus,
    by_reason: byReason,
    graded_claims_authored: gradedTotal,
    rows: results.map(({ entry, ...rest }) => rest),
  };
}

// ── gateway loaders (default I/O) ───────────────────────────────────────────

function buildInvoker(base, key) {
  const headers = { 'Content-Type': 'application/json', 'X-Agent-API-Key': key };
  return async function invoke(body) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 40000);
        const res = await fetch(`${base}/agent/shop/v1/invoke`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);
        return await res.json();
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    return null;
  };
}

function collectRefs(node, out, seen, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const v of node) collectRefs(v, out, seen, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    const productId = node.product_id || node.id;
    const merchantId = node.merchant_id;
    if (productId && merchantId) {
      const key = `${merchantId}:${productId}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ product_id: String(productId), merchant_id: String(merchantId) });
      }
    }
    for (const v of Object.values(node)) collectRefs(v, out, seen, depth + 1);
  }
}

async function discoverRefsFromQueries(invoke, queries, limit) {
  const refs = [];
  const seen = new Set();
  for (const query of queries) {
    // eslint-disable-next-line no-await-in-loop
    const res = await invoke({ operation: 'find_products_multi', payload: { query, limit: 8 } });
    if (res) collectRefs(res, refs, seen);
    if (refs.length >= limit * 2) break;
  }
  return refs.slice(0, limit);
}

function gatewayProductLoader(invoke) {
  return async function loadProduct(ref) {
    const res = await invoke({
      operation: 'get_pdp_v2',
      payload: { product_ref: ref, include: ['product_intel', 'offers', 'reviews', 'ingredients'] },
    });
    return extractGeneratorProductFromPdp(res, ref);
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    base: process.env.BASE || 'https://pivota-agent-staging.up.railway.app',
    key: process.env.AGENT_KEY || '',
    productIds: [],
    queries: [],
    productsFile: '',
    limit: Number(process.env.MAX_PRODUCTS || 50),
    write: false,
    out: process.env.OUT || '/tmp/grounded_backfill.json',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--product-ids' && next) {
      out.productIds = next.split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (token === '--queries' && next) {
      out.queries = next.split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (token === '--products-file' && next) {
      out.productsFile = next;
      i += 1;
    } else if (token === '--limit' && next) {
      out.limit = Math.max(1, Number(next) || out.limit);
      i += 1;
    } else if (token === '--base' && next) {
      out.base = next;
      i += 1;
    } else if (token === '--write') {
      out.write = true;
    } else if (token === '--out' && next) {
      out.out = next;
      i += 1;
    }
  }
  return out;
}

function parseProductRef(value) {
  const raw = asString(value);
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx > 0) {
    return { merchant_id: raw.slice(0, idx), product_id: raw.slice(idx + 1) };
  }
  return { product_id: raw };
}

async function main() {
  const args = parseArgs(process.argv);
  const { getProductIntelKbEntry, upsertProductIntelKbEntry } = require('../src/auroraBff/productIntelKbStore');
  const getExisting = async (productId) => getProductIntelKbEntry(`product:${productId}`);

  let refs = [];
  let loadProduct = null;

  if (args.productsFile) {
    const file = path.isAbsolute(args.productsFile) ? args.productsFile : path.resolve(process.cwd(), args.productsFile);
    const products = JSON.parse(fs.readFileSync(file, 'utf8'));
    const byId = new Map();
    for (const product of asArray(products)) {
      const id = asString(product?.product_id || product?.id);
      if (!id) continue;
      byId.set(id, product);
      refs.push({ product_id: id, ...(product.merchant_id ? { merchant_id: asString(product.merchant_id) } : {}) });
    }
    loadProduct = async (ref) => byId.get(asString(ref.product_id)) || null;
  } else {
    if (!args.key) {
      process.stderr.write('AGENT_KEY (and BASE) required unless --products-file is used\n');
      process.exit(2);
    }
    const invoke = buildInvoker(args.base, args.key);
    loadProduct = gatewayProductLoader(invoke);
    refs = args.productIds.map(parseProductRef).filter(Boolean);
    if (args.queries.length) {
      const discovered = await discoverRefsFromQueries(invoke, args.queries, args.limit);
      const seen = new Set(refs.map((r) => r.product_id));
      for (const ref of discovered) {
        if (seen.has(ref.product_id)) continue;
        seen.add(ref.product_id);
        refs.push(ref);
      }
    }
    refs = refs.slice(0, args.limit);
  }

  if (!refs.length) {
    process.stderr.write('no product refs to backfill (pass --product-ids, --queries, or --products-file)\n');
    process.exit(2);
  }

  process.stderr.write(
    `[grounded-backfill] mode=${args.write ? 'WRITE' : 'dry_run'} refs=${refs.length} base=${args.productsFile ? `file:${args.productsFile}` : args.base}\n`,
  );
  const summary = await runBackfill({
    refs,
    loadProduct,
    getExisting,
    upsert: upsertProductIntelKbEntry,
    write: args.write,
  });

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(
    `[grounded-backfill] ${summary.mode}: scanned=${summary.scanned} eligible=${summary.eligible} written=${summary.written} graded_claims=${summary.graded_claims_authored} → ${args.out}\n`,
  );
  process.stdout.write(`${JSON.stringify({ ...summary, rows: undefined })}\n`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await require('../src/db').closePool();
      } catch {
        /* ignore */
      }
      if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
    });
}

module.exports = {
  countGradedClaims,
  decideGroundedWrite,
  buildGroundedKbEntry,
  extractGeneratorProductFromPdp,
  backfillOne,
  runBackfill,
  summarize,
  parseProductRef,
};
