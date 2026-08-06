#!/usr/bin/env node
'use strict';
/**
 * ADR-009 phase 3 — re-key legacy Path B rows off the `external_seed` sentinel.
 *
 * Moves `catalog_products` rows written by `external_product_seeds_mirror_v1`
 * from the shared `external_seed` bucket onto the observed seller
 * (`merch_obs_…`) that `ensure_observed_seller` already minted, which
 * `external_product_seeds.seller_ref` records. Path C
 * (`catalog_enrichment_agent_v1`) is NOT in scope: it still mints the sentinel,
 * so draining it before its writer is fixed just lets the bucket refill.
 *
 * BATCHED BY TARGET SELLER, not by source_domain. The plan originally said
 * domain; prod measurement killed that: 2,588 of the 8,974 rows have a NULL
 * source_domain (they would be skipped silently) and 297 targets map to only
 * 177 domains, because brand-direct sellers key on (brand, etld1) so one domain
 * can carry several sellers. seller_ref is 1:1 with the merchant being written.
 *
 * SIBLING TABLES MOVE IN THE SAME TRANSACTION. Three tables carry a
 * denormalized merchant_id for the same cohort; leaving them behind splits a
 * product from its SKUs, offers and PDP listing:
 *   catalog_skus          join on product_key                    (~15,197 rows)
 *   catalog_offers        join on product_key                    (~9,940 rows)
 *   pdp_identity_listing  join on product_id = source_product_id (~8,757 rows)
 * Note pdp_identity_listing keys on source_product_id (`ext_…`), NOT
 * product_key — a join on product_key silently matches zero rows.
 *
 * EXCLUDED: seller_ref = merch_efbc46b4619cfbdf, the retired founder test rig
 * (50 rows, jwx893-fz.myshopify.com dev store). It is the one target that is
 * status='inactive' AND the only one carrying a non-NULL last_full_sync_at, so
 * re-keying would both drop those rows from serving and expose them to the
 * stale-product sweep. They serve publicly today through the sentinel branch
 * and need their own suppression step, not this one.
 *
 * Hard prohibitions (each with a precedent):
 *   - product_key is NEVER written. ADR-009 D4.2 re-keys merchant_id only; a
 *     2026-08-01 backfill that "repaired" 720 ext: keys took 364 PDPs to 500.
 *   - signature columns are NEVER written, in the spirit of
 *     assert_sig_frozen_sql. Enforced by inspecting every SET clause before
 *     any statement runs.
 *
 * Preflight assertions, re-run INSIDE each batch transaction so a mid-run
 * change in prod aborts that seller rather than corrupting it:
 *   - every target exists in catalog_merchants with an admitting status;
 *   - every target has last_full_sync_at IS NULL;
 *   - the re-key introduces no UNIQUE-index collision, on either index that
 *     leads with merchant_id: idx_catalog_products_source_identity
 *     (merchant_id, platform, source_product_id) and
 *     idx_catalog_skus_source_identity_v2 (merchant_id, platform, product_key,
 *     source_variant_id).
 *
 * Every ledger row_ref is its table's PRIMARY KEY — product_key, sku_key,
 * offer_id, source_listing_ref. catalog_offers in particular has up to 30 rows
 * per product_key in this cohort, so keying the ledger on product_key would
 * both lose per-row identity and make rollback revert offers the batch never
 * touched.
 *
 * Read-only DRY-RUN by default. Writing requires BOTH --write and
 * --confirm REKEY_EXTERNAL_SEED_PATH_B.
 *
 *   node scripts/rekey-external-seed-path-b.cjs --preflight       # assertions only
 *   node scripts/rekey-external-seed-path-b.cjs                   # dry-run plan
 *   node scripts/rekey-external-seed-path-b.cjs --max-sellers 1 \
 *     --write --confirm REKEY_EXTERNAL_SEED_PATH_B                # one seller
 *   node scripts/rekey-external-seed-path-b.cjs --rollback-batch <id> \
 *     --write --confirm REKEY_EXTERNAL_SEED_PATH_B                # undo a batch
 */

const { closePool, query, withClient } = require('../src/db');

// The whole risk of this migration is a correct row that serving stops
// admitting: a re-keyed row leaves the sentinel branch of
// activeCatalogProductSourceWhere and falls to the merchant-status branch. So
// each batch measures admission with the DEPLOYED predicate before and after
// its own writes, inside the transaction, and rolls back on any loss.
const { activeCatalogProductSourceWhere } = require('../src/services/activeCatalogSourceSql');
const SERVING_PREDICATE = activeCatalogProductSourceWhere('cp', 'cm');

const SENTINEL = 'external_seed';
const PATH_B_SOURCE_SYSTEM = 'external_product_seeds_mirror_v1';
const RETIRED_TEST_RIG = 'merch_efbc46b4619cfbdf';
const CONFIRM_TOKEN = 'REKEY_EXTERNAL_SEED_PATH_B';

// Statuses activeCatalogProductSourceWhere admits on its merchant branch. A
// re-keyed row leaves the sentinel branch and lands here, so a target outside
// this set would go dark on every serving surface.
const ADMITTING_STATUSES = ['active', 'observed'];

// $1 sentinel, $2 source_system, $3 excluded rig. Statements that embed this
// bind their own values starting at $4, so the numbering never collides.
const COHORT_SQL = `
  SELECT cp.product_key,
         cp.source_product_id,
         cp.platform,
         eps.seller_ref AS new_merchant_id
  FROM catalog_products cp
  JOIN external_product_seeds eps
    ON eps.external_product_id = cp.source_product_id
  WHERE cp.merchant_id = $1
    AND cp.source_system = $2
    AND eps.seller_ref IS NOT NULL
    AND eps.seller_ref <> $3
`;
const COHORT_PARAMS = [SENTINEL, PATH_B_SOURCE_SYSTEM, RETIRED_TEST_RIG];

// Every write, in one place. `$4` is the target seller. Each statement updates
// its table and records what it actually wrote into the ledger in the SAME
// statement, so a row can never move without a ledger entry.
const UPDATE_STATEMENTS = [
  {
    table: 'catalog_products',
    sql: `
      WITH cohort AS (${COHORT_SQL}),
      updated AS (
        UPDATE catalog_products AS tgt
           SET merchant_id = $4
          FROM cohort c
         WHERE c.product_key = tgt.product_key
           AND c.new_merchant_id = $4
        RETURNING tgt.product_key AS row_ref
      )
      INSERT INTO external_seed_rekey_ledger
        (batch_id, source_table, row_ref, old_merchant_id, new_merchant_id)
      SELECT $5, 'catalog_products', row_ref, $1, $4 FROM updated`,
  },
  {
    table: 'catalog_skus',
    sql: `
      WITH cohort AS (${COHORT_SQL}),
      updated AS (
        UPDATE catalog_skus AS tgt
           SET merchant_id = $4
          FROM cohort c
         WHERE c.product_key = tgt.product_key
           AND c.new_merchant_id = $4
           AND tgt.merchant_id = $1
        RETURNING tgt.sku_key AS row_ref
      )
      INSERT INTO external_seed_rekey_ledger
        (batch_id, source_table, row_ref, old_merchant_id, new_merchant_id)
      SELECT $5, 'catalog_skus', row_ref, $1, $4 FROM updated`,
  },
  {
    table: 'catalog_offers',
    sql: `
      WITH cohort AS (${COHORT_SQL}),
      updated AS (
        UPDATE catalog_offers AS tgt
           SET merchant_id = $4
          FROM cohort c
         WHERE c.product_key = tgt.product_key
           AND c.new_merchant_id = $4
           AND tgt.merchant_id = $1
        RETURNING tgt.offer_id AS row_ref
      )
      INSERT INTO external_seed_rekey_ledger
        (batch_id, source_table, row_ref, old_merchant_id, new_merchant_id)
      SELECT $5, 'catalog_offers', row_ref, $1, $4 FROM updated`,
  },
  {
    // Keys on source_product_id ('ext_…'), NOT product_key.
    table: 'pdp_identity_listing',
    sql: `
      WITH cohort AS (${COHORT_SQL}),
      updated AS (
        UPDATE pdp_identity_listing AS tgt
           SET merchant_id = $4
          FROM cohort c
         WHERE c.source_product_id = tgt.product_id
           AND c.new_merchant_id = $4
           AND tgt.merchant_id = $1
        RETURNING tgt.source_listing_ref AS row_ref
      )
      INSERT INTO external_seed_rekey_ledger
        (batch_id, source_table, row_ref, old_merchant_id, new_merchant_id)
      SELECT $5, 'pdp_identity_listing', row_ref, $1, $4 FROM updated`,
  },
];

// Assignment to a frozen column is forbidden; reading product_key in a join is
// not. So only SET clauses are inspected.
const FROZEN_COLUMN_PATTERN = /\b(product_key|pivota_signature_id|sig_id|signature\w*)\s*=/i;

function assertFrozenColumnsUnwritten() {
  for (const stmt of UPDATE_STATEMENTS) {
    const setClauses = stmt.sql.match(/\bSET\b[\s\S]*?(?=\bFROM\b)/gi) || [];
    if (!setClauses.length) throw new Error(`could not parse SET clause for ${stmt.table}`);
    for (const clause of setClauses) {
      if (FROZEN_COLUMN_PATTERN.test(clause)) {
        throw new Error(`refusing to run: ${stmt.table} UPDATE writes a frozen column`);
      }
    }
  }
}

function parseArgs(argv) {
  const args = { write: false, confirm: null, preflightOnly: false, maxSellers: null, rollbackBatch: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--write') args.write = true;
    else if (a === '--preflight') args.preflightOnly = true;
    else if (a === '--confirm') args.confirm = argv[++i];
    else if (a === '--max-sellers') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error('--max-sellers must be a positive integer');
      args.maxSellers = n;
    } else if (a === '--rollback-batch') args.rollbackBatch = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.write && args.confirm !== CONFIRM_TOKEN) {
    throw new Error(`--write requires --confirm ${CONFIRM_TOKEN}`);
  }
  return args;
}

// `exec` is either the pool (`query`) or a transaction client, so the same
// assertions run standalone and inside each batch. `sellerId` scopes them to a
// single target: the pre-run pass checks all 297 at once, but re-checking the
// whole cohort inside each of 297 transactions would scan it 297 times over.
async function runPreflight(exec, sellerId = null) {
  const failures = [];

  const bad = await exec(
    `WITH cohort AS (${COHORT_SQL}),
     scoped AS (SELECT * FROM cohort WHERE $5::text IS NULL OR new_merchant_id = $5),
     targets AS (SELECT DISTINCT new_merchant_id AS mid FROM scoped)
     SELECT t.mid,
            (cm.merchant_id IS NULL) AS absent,
            lower(coalesce(cm.status, 'active')) AS status,
            (cm.last_full_sync_at IS NOT NULL) AS has_last_full_sync
     FROM targets t LEFT JOIN catalog_merchants cm ON cm.merchant_id = t.mid
     WHERE cm.merchant_id IS NULL
        OR lower(coalesce(cm.status, 'active')) <> ALL($4::text[])
        OR cm.last_full_sync_at IS NOT NULL`,
    [...COHORT_PARAMS, ADMITTING_STATUSES, sellerId],
  );
  for (const row of bad.rows) {
    if (row.absent) failures.push(`target ${row.mid} has no catalog_merchants row`);
    else if (row.has_last_full_sync) failures.push(`target ${row.mid} carries last_full_sync_at (stale sweep would reach it)`);
    else failures.push(`target ${row.mid} status='${row.status}' is not admitted by serving`);
  }

  // UNIQUE (merchant_id, platform, source_product_id): the re-key rewrites the
  // first component, so check against rows that already exist AND within the
  // batch itself.
  const collisions = await exec(
    `WITH cohort AS (${COHORT_SQL}),
     scoped AS (SELECT * FROM cohort WHERE $4::text IS NULL OR new_merchant_id = $4)
     SELECT
       (SELECT count(*)::int FROM scoped c JOIN catalog_products x
          ON x.merchant_id = c.new_merchant_id
         AND x.platform IS NOT DISTINCT FROM c.platform
         AND x.source_product_id = c.source_product_id
         AND x.product_key <> c.product_key) AS against_existing,
       (SELECT count(*)::int FROM (
          SELECT 1 FROM scoped GROUP BY new_merchant_id, platform, source_product_id
          HAVING count(*) > 1) d) AS within_batch`,
    [...COHORT_PARAMS, sellerId],
  );
  const { against_existing: againstExisting, within_batch: withinBatch } = collisions.rows[0];
  if (againstExisting > 0) failures.push(`${againstExisting} catalog_products rows collide with an existing (merchant_id, platform, source_product_id)`);
  if (withinBatch > 0) failures.push(`${withinBatch} duplicate catalog_products keys within the batch itself`);

  // catalog_skus carries its own UNIQUE index that leads with merchant_id —
  // idx_catalog_skus_source_identity_v2 (merchant_id, platform, product_key,
  // source_variant_id) — so the sibling update can collide even when the
  // product update cannot. Clean on prod today; asserted because this script is
  // re-runnable and the corpus keeps moving.
  const skuCollisions = await exec(
    `WITH cohort AS (${COHORT_SQL}),
     scoped AS (SELECT * FROM cohort WHERE $4::text IS NULL OR new_merchant_id = $4),
     proposed AS (
       SELECT s.sku_key, c.new_merchant_id, s.platform, s.product_key, s.source_variant_id
       FROM catalog_skus s JOIN scoped c ON c.product_key = s.product_key
       WHERE s.merchant_id = $1)
     SELECT
       (SELECT count(*)::int FROM proposed p JOIN catalog_skus x
          ON x.merchant_id = p.new_merchant_id
         AND x.platform IS NOT DISTINCT FROM p.platform
         AND x.product_key = p.product_key
         AND x.source_variant_id IS NOT DISTINCT FROM p.source_variant_id
         AND x.sku_key <> p.sku_key) AS against_existing,
       (SELECT count(*)::int FROM (
          SELECT 1 FROM proposed
          GROUP BY new_merchant_id, platform, product_key, source_variant_id
          HAVING count(*) > 1) d) AS within_batch`,
    [...COHORT_PARAMS, sellerId],
  );
  const sku = skuCollisions.rows[0];
  if (sku.against_existing > 0) failures.push(`${sku.against_existing} catalog_skus rows collide with an existing (merchant_id, platform, product_key, source_variant_id)`);
  if (sku.within_batch > 0) failures.push(`${sku.within_batch} duplicate catalog_skus keys within the batch itself`);

  return failures;
}

async function loadPlan(exec) {
  const res = await exec(
    `WITH cohort AS (${COHORT_SQL})
     SELECT new_merchant_id, count(*)::int AS products
     FROM cohort GROUP BY 1 ORDER BY products ASC, new_merchant_id ASC`,
    COHORT_PARAMS,
  );
  return res.rows;
}

async function countAdmittedForCohort(client, sellerId) {
  const res = await client.query(
    `WITH cohort AS (${COHORT_SQL})
     SELECT count(*)::int AS admitted
     FROM cohort k
     JOIN catalog_products cp ON cp.product_key = k.product_key
     LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
     WHERE k.new_merchant_id = $4 AND ${SERVING_PREDICATE}`,
    [...COHORT_PARAMS, sellerId],
  );
  return res.rows[0].admitted;
}

async function countAdmittedForLedger(client, batchId, sellerId) {
  const res = await client.query(
    `SELECT count(*)::int AS admitted
     FROM external_seed_rekey_ledger l
     JOIN catalog_products cp ON cp.product_key = l.row_ref
     LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
     WHERE l.batch_id = $1 AND l.new_merchant_id = $2
       AND l.source_table = 'catalog_products'
       AND ${SERVING_PREDICATE}`,
    [batchId, sellerId],
  );
  return res.rows[0].admitted;
}

async function rekeySeller(client, sellerId, batchId, expectedProducts) {
  const admittedBefore = await countAdmittedForCohort(client, sellerId);
  const counts = {};
  for (const stmt of UPDATE_STATEMENTS) {
    // eslint-disable-next-line no-await-in-loop
    const res = await client.query(stmt.sql, [...COHORT_PARAMS, sellerId, batchId]);
    // rowCount here is the ledger INSERT count, which equals the UPDATE count
    // by construction — counting what actually landed, never what was attempted.
    counts[stmt.table] = res.rowCount;
  }
  if (counts.catalog_products !== expectedProducts) {
    throw new Error(
      `expected ${expectedProducts} catalog_products rows for ${sellerId}, wrote ${counts.catalog_products}`,
    );
  }

  const admittedAfter = await countAdmittedForLedger(client, batchId, sellerId);
  if (admittedAfter < admittedBefore) {
    throw new Error(
      `serving admission dropped for ${sellerId}: ${admittedBefore} -> ${admittedAfter}; rolling back`,
    );
  }
  counts.admitted_before = admittedBefore;
  counts.admitted_after = admittedAfter;
  return counts;
}

// Each row_ref is that table's PRIMARY KEY, so one ledger entry restores
// exactly one row. `AND merchant_id = $3` scopes the revert to rows still
// holding the value this batch wrote: a row since moved on by something else is
// left alone rather than silently dragged back to the sentinel.
const ROLLBACK_STATEMENTS = {
  catalog_products: 'UPDATE catalog_products SET merchant_id = $1 WHERE product_key = $2 AND merchant_id = $3',
  catalog_skus: 'UPDATE catalog_skus SET merchant_id = $1 WHERE sku_key = $2 AND merchant_id = $3',
  catalog_offers: 'UPDATE catalog_offers SET merchant_id = $1 WHERE offer_id = $2 AND merchant_id = $3',
  pdp_identity_listing: 'UPDATE pdp_identity_listing SET merchant_id = $1 WHERE source_listing_ref = $2 AND merchant_id = $3',
};

async function rollbackBatch(batchId) {
  const byTable = ROLLBACK_STATEMENTS;
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const entries = await client.query(
        'SELECT source_table, row_ref, old_merchant_id, new_merchant_id FROM external_seed_rekey_ledger WHERE batch_id = $1',
        [batchId],
      );
      if (!entries.rowCount) throw new Error(`no ledger entries for batch ${batchId}`);
      let restored = 0;
      for (const e of entries.rows) {
        const sql = byTable[e.source_table];
        if (!sql) throw new Error(`unknown source_table in ledger: ${e.source_table}`);
        // eslint-disable-next-line no-await-in-loop
        const res = await client.query(sql, [e.old_merchant_id, e.row_ref, e.new_merchant_id]);
        restored += res.rowCount;
      }
      await client.query('COMMIT');
      console.log(JSON.stringify({ event: 'rollback_complete', batch_id: batchId, ledger_entries: entries.rowCount, rows_restored: restored }, null, 2));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.rollbackBatch) {
    if (!args.write) throw new Error(`--rollback-batch requires --write --confirm ${CONFIRM_TOKEN}`);
    await rollbackBatch(args.rollbackBatch);
    return;
  }

  assertFrozenColumnsUnwritten();

  const failures = await runPreflight(query);
  const plan = await loadPlan(query);
  const totalProducts = plan.reduce((n, r) => n + r.products, 0);

  console.log(JSON.stringify({
    event: 'preflight',
    sellers: plan.length,
    products: totalProducts,
    excluded_test_rig: RETIRED_TEST_RIG,
    failures,
  }, null, 2));

  if (failures.length) throw new Error(`preflight failed with ${failures.length} assertion(s); refusing to write`);
  if (args.preflightOnly) return;

  // Smallest sellers first: an early failure costs the least and still proves
  // the path end to end.
  const targets = args.maxSellers ? plan.slice(0, args.maxSellers) : plan;

  if (!args.write) {
    console.log(JSON.stringify({
      event: 'dry_run',
      would_rekey_sellers: targets.length,
      would_rekey_products: targets.reduce((n, r) => n + r.products, 0),
      smallest_first: targets.slice(0, 5),
    }, null, 2));
    return;
  }

  const batchId = `rekey_${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const totals = { sellers: 0, catalog_products: 0, catalog_skus: 0, catalog_offers: 0, pdp_identity_listing: 0 };

  for (const target of targets) {
    // One transaction per seller: a failure aborts that seller only, and the
    // run resumes by being re-run — moved rows no longer match the
    // sentinel-scoped cohort, so completed sellers are skipped naturally.
    // eslint-disable-next-line no-await-in-loop
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const midRun = await runPreflight((sql, params) => client.query(sql, params), target.new_merchant_id);
        if (midRun.length) throw new Error(`preflight regressed mid-run: ${midRun[0]}`);
        const counts = await rekeySeller(client, target.new_merchant_id, batchId, target.products);
        await client.query('COMMIT');
        totals.sellers += 1;
        // Only the per-table write counts aggregate; admitted_before/after are
        // per-batch assertions, not totals.
        for (const stmt of UPDATE_STATEMENTS) totals[stmt.table] += counts[stmt.table];
        console.log(JSON.stringify({ event: 'seller_rekeyed', batch_id: batchId, seller: target.new_merchant_id, ...counts }));
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
  }

  console.log(JSON.stringify({ event: 'complete', batch_id: batchId, ...totals }, null, 2));
  console.log(`rollback with: --rollback-batch ${batchId} --write --confirm ${CONFIRM_TOKEN}`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}

module.exports = {
  COHORT_SQL,
  COHORT_PARAMS,
  UPDATE_STATEMENTS,
  ROLLBACK_STATEMENTS,
  ADMITTING_STATUSES,
  RETIRED_TEST_RIG,
  SENTINEL,
  PATH_B_SOURCE_SYSTEM,
  CONFIRM_TOKEN,
  assertFrozenColumnsUnwritten,
  parseArgs,
  countAdmittedForCohort,
  countAdmittedForLedger,
  SERVING_PREDICATE,
};
