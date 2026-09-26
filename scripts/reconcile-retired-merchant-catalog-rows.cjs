#!/usr/bin/env node
'use strict';
/**
 * #1917 — converge catalog rows whose MERCHANT is retired.
 *
 * Contract: docs/CATALOG_SOURCE_RETIREMENT_CONTRACT.md
 *
 * Two invariants, one reconciler:
 *
 *   I1  catalog_products.sync_status = 'live'  ⇒  the row's merchant is
 *       active/observed. A retired merchant's rows belong at 'archived'.
 *   I2  catalog_merchants.indexable = TRUE     ⇒  the same. `indexable` must
 *       never claim a retired merchant belongs in the index.
 *
 * ── WHY CASCADE RATHER THAN "EXCLUDE AT QUERY TIME" ──────────────────────────
 * `sync_status` is a claim about the row's relationship to its SOURCE sync:
 * 'live' means the last sync saw this row and it is current. Once a merchant is
 * deactivated no sync will ever run again, so 'live' becomes a false claim that
 * never expires — merch_efbc46b4619cfbdf last synced 2026-04-10 and asserted
 * 'live' for four months afterwards. 'archived' is the terminal state the
 * column already has for exactly this ("we stopped tracking this row"), and
 * #1910 established the flip with the same reasoning.
 *
 * The alternative — leave 'live' and rely on the merchant-status join — is a
 * fallback chain. `activeCatalogProductSourceWhere` is a DEFENCE, not the
 * contract, and it is not universally applied: RecommendationEngine's seed-lane
 * fast path (src/services/RecommendationEngine.js:2866, "skip the
 * catalog_merchants join") and discoveryFeed's first_party lateral
 * (src/services/discoveryFeed.js:8904) both read `cp.sync_status = 'live'` with
 * no merchant-status join at all. Making every future reader remember the join
 * is how this class of bug recurs; making the ROW tell the truth is not.
 *
 * ── WHY A RECONCILER RATHER THAN A WRITE ON THE DEACTIVATION PATH ────────────
 * There is no deactivation path in this repo to hook. Nothing here writes
 * catalog_merchants.status or merchant_stores.status outside one-off scripts —
 * deactivation is operational, and the merchant tables are also written by
 * pivota-backend. A sync-time poke would therefore cover neither the manual SQL
 * case nor rows that land AFTER the deactivation. Per ADR-012 this is a
 * CONVERGENT RECONCILER instead: cohort recomputed from current merchant state
 * on every run, safe to re-run, drift reported whether or not it writes.
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 * Every archived row must be provably retired, not merely mislabelled. Guards
 * (reported as block_reason, never silently dropped):
 *   1. active_store_exists  — a merchant_store still 'active'. Then the STORE
 *      is the live fact and the merchant row is the stale one; archiving would
 *      retire a syncing catalog on the strength of the wrong field.
 *   2. row_trust_public     — catalog_row_trust says this row serves today.
 *      Archiving would silently pull a served row; that needs a human.
 *   3. index_serving_eligible — index_pipeline_state says the row's CONTENT is
 *      serving-eligible. Coarser than the row (ips is content_key-grained, see
 *      the grain note in catalogRowTrustUpserter.js), so this is deliberately
 *      conservative: skip rather than clobber.
 * Measured on prod 2026-08-07: 1,558 cohort rows, 0 blocked by any guard.
 *
 * catalog_offers are NOT touched. Offers are gated by their own suppression and
 * by the product join; retiring the product is what this issue is about, and
 * widening to offers would put a second, unmeasured write in the same run.
 *
 * After a successful archive the affected rows' catalog_row_trust is recomputed
 * (--no-refresh-trust to skip), because `sync_status` is a trust INPUT — see the
 * PUBLISH_STATE_NOT_PUBLIC gate in catalogTrustPolicy.js. Leaving it stale would
 * mean the row says 'archived' while its trust row still reflects 'live'.
 *
 * Read-only DRY-RUN by default. Writing requires BOTH --write and
 * --confirm RECONCILE_RETIRED_MERCHANT_CATALOG_ROWS.
 *
 *   node scripts/reconcile-retired-merchant-catalog-rows.cjs              # dry-run
 *   node scripts/reconcile-retired-merchant-catalog-rows.cjs --drift-only # metric only
 *   node scripts/reconcile-retired-merchant-catalog-rows.cjs --merchant merch_x
 *   node scripts/reconcile-retired-merchant-catalog-rows.cjs \
 *     --write --confirm RECONCILE_RETIRED_MERCHANT_CATALOG_ROWS
 */

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');

const CONFIRM_TOKEN = 'RECONCILE_RETIRED_MERCHANT_CATALOG_ROWS';
const DEFAULT_BATCH_SIZE = 200;

/**
 * The one definition of "this merchant is a live source". Everything else in
 * this file — cohort, guards, the UPDATE re-assertions, the indexable
 * invariant — is expressed against it, so the two invariants cannot drift
 * apart the way status and indexable did.
 *
 * 'observed' is ADR-009's observed-seller-of-record status and serves, exactly
 * as in activeCatalogProductSourceWhere. Kept as a shared SQL fragment rather
 * than a second copy of that helper: this asks about the MERCHANT alone, while
 * the helper also folds in store/platform/test-rig legs it needs and this
 * does not.
 */
const ACTIVE_MERCHANT_STATUSES = Object.freeze(['active', 'observed']);

function retiredMerchantSql(alias = 'cm') {
  return `lower(coalesce(${alias}.status, '')) NOT IN ('active', 'observed')`;
}

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  return String(value ?? '').trim();
}

/**
 * Cohort: live rows under a merchant whose catalog_merchants row EXISTS and is
 * not active/observed.
 *
 * The existence requirement is deliberate. `activeCatalogProductSourceWhere`
 * reads `coalesce(cm.status, 'active')` — a missing merchant row defaults OPEN
 * — and prod carries 13 such live rows (merch_cf2dbaf5774a524d,
 * damdamtokyo.com, no catalog_merchants row and no stores). Those rows are a
 * real defect but the OPPOSITE one: the repair is to mint the missing merchant
 * row, not to archive a real brand's catalog on the strength of an absent
 * record. They are counted in the drift report and never written.
 *
 * Guard columns are selected, not filtered, so a blocked row stays visible.
 */
const COHORT_SQL = `
  SELECT
    cp.product_key,
    cp.merchant_id,
    cp.catalog_track,
    cp.source_domain,
    cp.title,
    cp.sync_status,
    cp.suppression_reason,
    cm.merchant_name,
    lower(coalesce(cm.status, '')) AS merchant_status,
    cm.indexable AS merchant_indexable,
    coalesce(st.has_active_store, FALSE) AS has_active_store,
    coalesce(t.serving_decision, '') AS serving_decision,
    coalesce(ips.serving_eligible, FALSE) AS index_serving_eligible
  FROM catalog_products cp
  JOIN catalog_merchants cm
    ON cm.merchant_id = cp.merchant_id
  LEFT JOIN LATERAL (
    SELECT bool_or(lower(coalesce(ms.status, '')) = 'active') AS has_active_store
    FROM merchant_stores ms
    WHERE ms.merchant_id = cp.merchant_id
  ) st ON TRUE
  LEFT JOIN catalog_row_trust t
    ON t.subject_type = 'product'
   AND t.subject_key = cp.product_key
  LEFT JOIN index_pipeline_state ips
    ON ips.content_key = cp.content_key
  WHERE cp.sync_status = 'live'
    AND ${retiredMerchantSql('cm')}
`;

/**
 * Pure guard evaluation over one cohort row. Returns null when the row is safe
 * to archive, or a block_reason naming the invariant that failed.
 */
function blockReasonFor(row) {
  const r = row && typeof row === 'object' ? row : {};
  if (r.has_active_store === true) return 'active_store_exists';
  if (asString(r.serving_decision).toLowerCase() === 'public') return 'row_trust_public';
  if (r.index_serving_eligible === true) return 'index_serving_eligible';
  return null;
}

function assertWriteConfirmed({ write, confirm }) {
  if (write && asString(confirm) !== CONFIRM_TOKEN) {
    throw new Error(`Refusing write without --confirm ${CONFIRM_TOKEN}`);
  }
}

async function fetchCohort({ merchantId = '', limit = 0 } = {}) {
  const params = [];
  let sql = COHORT_SQL;
  if (merchantId) {
    params.push(merchantId);
    sql += ` AND cp.merchant_id = $${params.length}`;
  }
  sql += ' ORDER BY cp.merchant_id ASC, cp.product_key ASC';
  if (limit > 0) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
  }
  const res = await query(sql, params);
  return res.rows || [];
}

/**
 * Merchants whose `indexable` bit contradicts their status (invariant I2).
 * Only the TRUE-while-retired direction is a defect: indexable=false on an
 * active merchant is a deliberate hold-out (pdpRenderability.js documents
 * merch_efbc46b4619cfbdf's false bit as the only thing keeping 737 rows out of
 * the sitemap) and must never be flipped on by a reconciler.
 */
async function fetchIndexableDrift({ merchantId = '' } = {}) {
  const params = [];
  let sql = `
    SELECT cm.merchant_id, cm.merchant_name, lower(coalesce(cm.status, '')) AS merchant_status
    FROM catalog_merchants cm
    WHERE cm.indexable IS TRUE
      AND ${retiredMerchantSql('cm')}
  `;
  if (merchantId) {
    params.push(merchantId);
    sql += ` AND cm.merchant_id = $${params.length}`;
  }
  sql += ' ORDER BY cm.merchant_id ASC';
  const res = await query(sql, params);
  return res.rows || [];
}

/**
 * Live rows whose merchant has NO catalog_merchants row — the fail-open
 * `coalesce(cm.status, 'active')` population. Reported, never written; see the
 * COHORT_SQL note.
 */
async function fetchOrphanMerchantDrift() {
  const res = await query(`
    SELECT cp.merchant_id,
           count(*)::int AS live_rows,
           count(*) FILTER (WHERE cp.suppression_reason IS NULL)::int AS live_unsuppressed_rows
    FROM catalog_products cp
    LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
    WHERE cp.sync_status = 'live'
      AND cm.merchant_id IS NULL
    GROUP BY 1
    ORDER BY live_rows DESC
  `);
  return res.rows || [];
}

/**
 * Set-based archive of one batch. Re-asserts the whole cohort predicate inside
 * the UPDATE — still live, merchant row still present, merchant still retired,
 * still no active store — so a row that changed between SELECT and UPDATE is
 * skipped rather than archived on stale evidence. Returns rowCount landed.
 */
async function archiveBatch(productKeys) {
  if (!productKeys.length) return 0;
  const res = await query(
    `
      UPDATE catalog_products AS cp
      SET sync_status = 'archived',
          updated_at = now()
      WHERE cp.product_key = ANY($1::text[])
        AND cp.sync_status = 'live'
        AND EXISTS (
          SELECT 1 FROM catalog_merchants cm
          WHERE cm.merchant_id = cp.merchant_id
            AND ${retiredMerchantSql('cm')}
        )
        AND NOT EXISTS (
          SELECT 1 FROM merchant_stores ms
          WHERE ms.merchant_id = cp.merchant_id
            AND lower(coalesce(ms.status, '')) = 'active'
        )
    `,
    [productKeys],
  );
  return Number(res.rowCount || 0);
}

/**
 * Clear `indexable` on retired merchants. Re-asserts the retirement predicate
 * for the same reason archiveBatch does, and only ever writes TRUE -> FALSE.
 */
async function clearIndexableBatch(merchantIds) {
  if (!merchantIds.length) return 0;
  const res = await query(
    `
      UPDATE catalog_merchants AS cm
      SET indexable = FALSE,
          updated_at = now()
      WHERE cm.merchant_id = ANY($1::text[])
        AND cm.indexable IS TRUE
        AND ${retiredMerchantSql('cm')}
    `,
    [merchantIds],
  );
  return Number(res.rowCount || 0);
}

/**
 * `sync_status` is a trust input (catalogTrustPolicy's PUBLISH_STATE_NOT_PUBLIC
 * gate), so archived rows carry a stale trust verdict until recomputed. Failure
 * here is reported, not fatal: the archive itself already landed and is the
 * durable fix, and the trust cron reconverges independently.
 */
async function refreshTrust(productKeys) {
  if (!productKeys.length) return { rows_written: 0, path: 'skipped_empty' };
  try {
    const { upsertCatalogRowTrustMany } = require('../src/services/catalogRowTrustUpserter');
    const pool = { query: (sql, params) => query(sql, params) };
    const wrote = await upsertCatalogRowTrustMany(pool, productKeys, new Date());
    return { rows_written: Number(wrote || 0), path: 'upserter' };
  } catch (err) {
    return { rows_written: 0, path: 'failed', error: err.message };
  }
}

function summarizeByMerchant(rows) {
  const byMerchant = new Map();
  for (const r of rows) {
    const key = r.merchant_id;
    const entry = byMerchant.get(key) || {
      merchant_id: key,
      merchant_name: r.merchant_name || null,
      merchant_status: r.merchant_status || null,
      merchant_indexable: r.merchant_indexable === true,
      live_rows: 0,
      live_unsuppressed_rows: 0,
    };
    entry.live_rows += 1;
    if (!r.suppression_reason) entry.live_unsuppressed_rows += 1;
    byMerchant.set(key, entry);
  }
  return [...byMerchant.values()].sort((a, b) => b.live_rows - a.live_rows);
}

async function run({
  write = false,
  confirm = '',
  merchantId = '',
  limit = 0,
  batchSize = DEFAULT_BATCH_SIZE,
  driftOnly = false,
  refreshTrustAfter = true,
} = {}) {
  assertWriteConfirmed({ write, confirm });

  const cohort = await fetchCohort({ merchantId, limit });
  const indexableDrift = await fetchIndexableDrift({ merchantId });
  const orphanMerchants = await fetchOrphanMerchantDrift();

  const eligible = [];
  const blocked = [];
  for (const row of cohort) {
    const reason = blockReasonFor(row);
    if (reason) blocked.push({ product_key: row.product_key, merchant_id: row.merchant_id, block_reason: reason });
    else eligible.push(row);
  }

  const byBlockReason = blocked.reduce((acc, b) => {
    acc[b.block_reason] = (acc[b.block_reason] || 0) + 1;
    return acc;
  }, {});

  let archived = 0;
  let indexableCleared = 0;
  let trust = null;
  const archivedKeys = [];
  const clearedMerchantIds = [];
  const shouldWrite = write && !driftOnly;
  if (shouldWrite) {
    for (let i = 0; i < eligible.length; i += batchSize) {
      const slice = eligible.slice(i, i + batchSize).map((r) => r.product_key);
      const landed = await archiveBatch(slice);
      archived += landed;
      if (landed > 0) archivedKeys.push(...slice);
    }
    const merchantIds = indexableDrift.map((m) => m.merchant_id);
    for (let i = 0; i < merchantIds.length; i += batchSize) {
      const landed = await clearIndexableBatch(merchantIds.slice(i, i + batchSize));
      indexableCleared += landed;
      if (landed > 0) clearedMerchantIds.push(...merchantIds.slice(i, i + batchSize));
    }
    if (refreshTrustAfter) {
      trust = await refreshTrust(archivedKeys);
    }
  }

  return {
    counters: {
      // I1 — sync_status drift.
      cohort_rows: cohort.length,
      eligible_rows: eligible.length,
      blocked_rows: blocked.length,
      archived_rows: archived,
      // I2 — indexable drift.
      indexable_drift_merchants: indexableDrift.length,
      indexable_cleared: indexableCleared,
      // Reported-only population (see fetchOrphanMerchantDrift).
      orphan_merchant_live_rows: orphanMerchants.reduce((n, m) => n + m.live_rows, 0),
      orphan_merchants: orphanMerchants.length,
    },
    by_block_reason: byBlockReason,
    by_merchant: summarizeByMerchant(cohort),
    indexable_drift: indexableDrift,
    orphan_merchants: orphanMerchants,
    blocked_sample: blocked.slice(0, 15),
    trust_refresh: trust,
    // The rollback record. A batch's keys are recorded when its UPDATE lands, so
    // `--out` gives an exact undo set:
    //   UPDATE catalog_products SET sync_status='live'
    //   WHERE product_key = ANY(<archived_product_keys>);
    //   UPDATE catalog_merchants SET indexable=TRUE
    //   WHERE merchant_id = ANY(<indexable_cleared_merchant_ids>);
    // Without this the cohort is only re-derivable while merchant status is
    // unchanged — which is precisely what a bad run might have changed.
    archived_product_keys: archivedKeys,
    indexable_cleared_merchant_ids: clearedMerchantIds,
  };
}

async function main() {
  const write = hasFlag('write');
  const confirm = asString(argValue('confirm'));
  const merchantId = asString(argValue('merchant'));
  const limit = Math.max(0, Number(argValue('limit', '0')) || 0);
  const batchSize = Math.max(1, Number(argValue('batch-size', String(DEFAULT_BATCH_SIZE))) || DEFAULT_BATCH_SIZE);
  const driftOnly = hasFlag('drift-only');
  const refreshTrustAfter = !hasFlag('no-refresh-trust');
  const out = asString(argValue('out'));

  assertWriteConfirmed({ write, confirm });

  const result = await run({ write, confirm, merchantId, limit, batchSize, driftOnly, refreshTrustAfter });
  const report = {
    plan: 'issue_1917_reconcile_retired_merchant_catalog_rows',
    generated_at: new Date().toISOString(),
    mode: write && !driftOnly ? 'write' : 'dry_run',
    active_merchant_statuses: ACTIVE_MERCHANT_STATUSES,
    filters: {
      merchant_id: merchantId || null,
      limit: limit || null,
      drift_only: driftOnly,
      refresh_trust: refreshTrustAfter,
    },
    batch_size: batchSize,
    ...result,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\nreport written: ${out}\n`);
  }
}

module.exports = {
  ACTIVE_MERCHANT_STATUSES,
  CONFIRM_TOKEN,
  COHORT_SQL,
  retiredMerchantSql,
  assertWriteConfirmed,
  blockReasonFor,
  summarizeByMerchant,
  fetchCohort,
  fetchIndexableDrift,
  fetchOrphanMerchantDrift,
  archiveBatch,
  clearIndexableBatch,
  run,
};

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err.stack || err.message}\n`);
      process.exitCode = 1;
    })
    .finally(() => closePool().catch(() => {}));
}
