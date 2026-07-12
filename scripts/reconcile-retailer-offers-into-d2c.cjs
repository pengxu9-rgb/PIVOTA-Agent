#!/usr/bin/env node
'use strict';
/**
 * Fix Plan D · T2 — reconcile EXISTING retailer offers into D2C products.
 *
 * Folds each retailer-domain offer's self-minted product into the matching D2C /
 * brand-direct product when (brandCore + strict titleCore) match EXACTLY, so the
 * shared content_key (and product group) collapses the two sellers onto one PDP.
 * Near (token-jaccard) matches are NEVER auto-merged — they are written to the
 * review report + `retailer_offer_identity_review` table for a human.
 *
 * Read-only DRY-RUN by default. `--apply` performs the EXACT-match fold in prod.
 *   railway run node ./scripts/reconcile-retailer-offers-into-d2c.cjs            # dry-run
 *   railway run node ./scripts/reconcile-retailer-offers-into-d2c.cjs --apply    # apply exact
 *   railway run node ./scripts/reconcile-retailer-offers-into-d2c.cjs --out reports/pland_t2.json
 *
 * Perf: prod public proxy ≈ 1 write/s per statement — all writes are single
 * set-based unnest batches, never row-at-a-time.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const {
  brandCore,
  titleCore,
  identityMatchKey,
  buildCatalogIdentityIndex,
  resolveAgainstIndex,
  coreTokens,
  jaccard,
} = require('../src/services/retailerOfferIdentity');

const FUZZY_THRESHOLD = 0.72;
const REVIEW_SPIKE_PCT = 10; // >10% fuzzy of matched-brand offers ⇒ threshold too loose

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}
function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  return !v || v.startsWith('--') ? fallback : v;
}

async function loadRetailerOffers(client) {
  const res = await client.query(`
    SELECT o.offer_id, o.product_key, p.content_key, p.brand, p.title,
           p.merchant_id, p.platform, p.source_product_id,
           lower(coalesce(nullif(o.offer_payload->>'domain',''), o.source_domain)) AS dom
    FROM catalog_offers o
    JOIN catalog_products p ON p.product_key = o.product_key
    WHERE o.offer_type = 'retailer' AND o.suppression_reason IS NULL
    ORDER BY p.brand, p.title`);
  return res.rows || [];
}

async function multiRetailerMetrics(client) {
  const res = await client.query(`
    WITH r AS (
      SELECT p.content_key,
             lower(coalesce(nullif(o.offer_payload->>'domain',''), o.source_domain)) dom,
             o.offer_type
      FROM catalog_offers o JOIN catalog_products p ON p.product_key=o.product_key
      WHERE o.suppression_reason IS NULL AND p.content_key IS NOT NULL
    )
    SELECT
      (SELECT count(*) FROM (SELECT content_key FROM r WHERE offer_type='retailer' AND dom IS NOT NULL GROUP BY content_key HAVING count(DISTINCT dom)>=2) a)::int AS multi_retailer_2plus,
      (SELECT count(*) FROM (SELECT content_key FROM r WHERE dom IS NOT NULL GROUP BY content_key HAVING count(DISTINCT dom)>=2) b)::int AS multi_source_2plus,
      (SELECT count(*) FROM (SELECT content_key FROM r WHERE dom IS NOT NULL GROUP BY content_key HAVING count(DISTINCT dom)>=3) d)::int AS multi_source_3plus`);
  return res.rows[0];
}

async function ensureReviewTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS retailer_offer_identity_review (
      id text PRIMARY KEY,
      retailer_product_key text NOT NULL,
      retailer_offer_id text,
      retailer_domain text,
      brand text,
      brand_core text,
      title text,
      title_core text,
      candidate_product_key text,
      candidate_content_key text,
      candidate_title text,
      jaccard_score numeric(6,4),
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
}

async function main() {
  const apply = hasFlag('apply');
  const outPath = argValue('out');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 25000,
    query_timeout: 300000,
  });
  await client.connect();
  const queryFn = (sql, params) => client.query(sql, params);

  const before = await multiRetailerMetrics(client);
  const offers = await loadRetailerOffers(client);
  const brands = Array.from(new Set(offers.map((o) => (o.brand || '').trim()).filter(Boolean)));
  const excludeProductKeys = offers.map((o) => o.product_key);
  const index = await buildCatalogIdentityIndex(queryFn, brands, { excludeProductKeys });

  const exactMatches = [];
  const fuzzyCandidates = [];
  const selfMint = [];
  for (const o of offers) {
    // Already folded (content_key equals a D2C content_key in the exact index)?
    const r = resolveAgainstIndex(index, o.brand, o.title, { fuzzyThreshold: FUZZY_THRESHOLD });
    if (r.decision === 'reuse_exact') {
      if (r.match.content_key && r.match.content_key !== o.content_key) {
        exactMatches.push({ offer: o, target: r.match });
      } else {
        // Same content_key already ⇒ nothing to change (idempotent).
        selfMint.push({ offer: o, reason: 'already_folded' });
      }
    } else if (r.decision === 'review_fuzzy') {
      fuzzyCandidates.push({ offer: o, target: r.match, score: r.score });
    } else {
      selfMint.push({ offer: o, reason: 'no_match', score: r.score || 0 });
    }
  }

  // Review-queue spike guard (relative to offers whose brand HAS D2C candidates).
  const brandsWithCandidates = new Set(Array.from(index.byBrand.keys()));
  const matchableOffers = offers.filter((o) => brandsWithCandidates.has(brandCore(o.brand)));
  const reviewPct = matchableOffers.length
    ? Math.round((fuzzyCandidates.length / matchableOffers.length) * 1000) / 10
    : 0;

  let applied = { mode: apply ? 'apply' : 'dry_run', content_key_updates: 0, group_member_updates: 0, review_rows_written: 0, apply_error: null };

  if (apply && exactMatches.length) {
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '10s'`);
      await client.query(`SET LOCAL statement_timeout = '120s'`);

      const pks = exactMatches.map((m) => m.offer.product_key);
      const newCks = exactMatches.map((m) => m.target.content_key);
      const targetPks = exactMatches.map((m) => m.target.product_key);
      const ckRes = await client.query(
        `
        UPDATE catalog_products AS p
        SET content_key = d.new_ck,
            product_payload = coalesce(p.product_payload,'{}'::jsonb) || jsonb_build_object(
              'content_key_reconcile_v1', jsonb_build_object(
                'plan','fix_plan_D_T2', 'rule','brand_title_core_exact',
                'from_content_key', p.content_key, 'folded_into', d.new_ck,
                'target_product_key', d.target_pk, 'at', now()
              )),
            updated_at = now()
        FROM (SELECT unnest($1::text[]) AS pk, unnest($2::text[]) AS new_ck, unnest($3::text[]) AS target_pk) d
        WHERE p.product_key = d.pk AND p.content_key IS DISTINCT FROM d.new_ck`,
        [pks, newCks, targetPks],
      );
      applied.content_key_updates = ckRes.rowCount || 0;

      const groupPks = exactMatches.filter((m) => m.target.product_group_id).map((m) => m.offer.product_key);
      const groupIds = exactMatches.filter((m) => m.target.product_group_id).map((m) => m.target.product_group_id);
      if (groupPks.length) {
        const gRes = await client.query(
          `
          UPDATE product_group_members AS mem
          SET product_group_id = d.new_pg, is_primary = false, updated_at = now()
          FROM (SELECT unnest($1::text[]) AS pk, unnest($2::text[]) AS new_pg) d
          JOIN catalog_products p ON p.product_key = d.pk
          WHERE mem.merchant_id = p.merchant_id
            AND mem.platform = p.platform
            AND mem.platform_product_id = p.source_product_id
            AND mem.product_group_id IS DISTINCT FROM d.new_pg`,
          [groupPks, groupIds],
        );
        applied.group_member_updates = gRes.rowCount || 0;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      applied.apply_error = String(err?.message || err);
    }
  }

  // Persist fuzzy candidates for review (durable table + report). Best-effort.
  if (apply && fuzzyCandidates.length && !applied.apply_error) {
    try {
      await ensureReviewTable(client);
      const ids = [], rpk = [], roid = [], rdom = [], br = [], brc = [], ti = [], tic = [], cpk = [], cck = [], cti = [], sc = [];
      for (const f of fuzzyCandidates) {
        ids.push(`ror_${f.offer.product_key}_${f.target.product_key}`.slice(0, 200));
        rpk.push(f.offer.product_key); roid.push(f.offer.offer_id); rdom.push(f.offer.dom);
        br.push(f.offer.brand); brc.push(brandCore(f.offer.brand));
        ti.push(f.offer.title); tic.push(titleCore(f.offer.title, f.offer.brand));
        cpk.push(f.target.product_key); cck.push(f.target.content_key); cti.push(f.target.title);
        sc.push(f.score);
      }
      const rRes = await client.query(
        `
        INSERT INTO retailer_offer_identity_review
          (id, retailer_product_key, retailer_offer_id, retailer_domain, brand, brand_core, title, title_core,
           candidate_product_key, candidate_content_key, candidate_title, jaccard_score)
        SELECT * FROM unnest(
          $1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],
          $9::text[],$10::text[],$11::text[],$12::numeric[]
        ) AS t(id,rpk,roid,rdom,br,brc,ti,tic,cpk,cck,cti,sc)
        ON CONFLICT (id) DO UPDATE SET
          jaccard_score = EXCLUDED.jaccard_score, updated_at = now()`,
        [ids, rpk, roid, rdom, br, brc, ti, tic, cpk, cck, cti, sc],
      );
      applied.review_rows_written = rRes.rowCount || 0;
    } catch (err) {
      applied.review_error = String(err?.message || err);
    }
  }

  const after = apply && !applied.apply_error ? await multiRetailerMetrics(client) : null;

  const report = {
    plan: 'fix_plan_D_T2_reconcile_retailer_offers_into_d2c',
    generated_at: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry_run',
    fuzzy_threshold: FUZZY_THRESHOLD,
    retailer_offers_total: offers.length,
    retailer_brands: brands.length,
    d2c_candidate_products: index.candidateCount,
    counts: {
      exact_reuse: exactMatches.length,
      fuzzy_review: fuzzyCandidates.length,
      self_mint_no_match: selfMint.filter((s) => s.reason === 'no_match').length,
      already_folded: selfMint.filter((s) => s.reason === 'already_folded').length,
    },
    review_spike: {
      matchable_offers: matchableOffers.length,
      fuzzy_pct_of_matchable: reviewPct,
      too_loose: reviewPct > REVIEW_SPIKE_PCT,
      threshold_pct: REVIEW_SPIKE_PCT,
    },
    metrics_before: before,
    metrics_after: after,
    applied,
    exact_sample: exactMatches.slice(0, 25).map((m) => ({
      brand: m.offer.brand, retailer_domain: m.offer.dom,
      retailer_title: m.offer.title, retailer_product_key: m.offer.product_key, from_content_key: m.offer.content_key,
      d2c_title: m.target.title, d2c_product_key: m.target.product_key, into_content_key: m.target.content_key,
    })),
    fuzzy_sample: fuzzyCandidates.slice(0, 25).map((f) => ({
      brand: f.offer.brand, score: f.score,
      retailer_title: f.offer.title, retailer_product_key: f.offer.product_key,
      candidate_title: f.target.title, candidate_product_key: f.target.product_key,
    })),
    exact_by_brand: Object.entries(
      exactMatches.reduce((acc, m) => { const b = m.offer.brand || 'unknown'; acc[b] = (acc[b] || 0) + 1; return acc; }, {}),
    ).map(([brand, n]) => ({ brand, n })).sort((a, b) => b.n - a.n),
  };

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(serialized);
  if (outPath) {
    const resolved = path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, serialized, 'utf8');
  }
  await client.end();
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
});
