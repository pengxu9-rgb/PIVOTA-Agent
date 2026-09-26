#!/usr/bin/env node
/**
 * Reconcile catalog_products.category_path onto the canonical taxonomy.
 *
 * ADR-012 (reconcilers, not pokes): convergent and idempotent — it computes the
 * target from src/services/beautyTaxonomy.js and writes only rows that differ,
 * so re-running after convergence is a no-op and a partial run is safe to
 * resume. Dry-run is the DEFAULT; --write is required to mutate.
 *
 * Class 3 of the recall-lane assessment. The split taxonomy starves the
 * canonical browse leg: prod-measured 2026-08-04, "toner" and "shampoo" recall
 * ZERO rows through their resolver prefix while text mode returns 48/48.
 *
 * Only paths listed in CATEGORY_PATH_ALIASES move. Leaf words that legitimately
 * name different products (lip oil vs face oil vs body oil; skincare vs
 * haircare mask) are never touched — see INTENTIONALLY_DISTINCT.
 *
 * Usage:
 *   node scripts/reconcile-catalog-category-taxonomy.cjs              # dry run
 *   node scripts/reconcile-catalog-category-taxonomy.cjs --write      # apply
 *   node scripts/reconcile-catalog-category-taxonomy.cjs --audit      # drift only
 *   node scripts/reconcile-catalog-category-taxonomy.cjs --limit 100  # cap rows
 */

'use strict';

const { Pool } = require('pg');
const {
  CATEGORY_PATH_ALIASES,
  toCanonicalCategoryPath,
} = require('../src/services/beautyTaxonomy');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const AUDIT_ONLY = args.includes('--audit');
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Math.max(1, Number(args[limitArg + 1]) || 0) : null;
const BATCH = 500;

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  if (!process.env.DATABASE_URL) fail('DATABASE_URL is required');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 2,
    statement_timeout: 120000,
  });

  const variants = Object.keys(CATEGORY_PATH_ALIASES);
  const startedAt = Date.now();
  const summary = {
    mode: AUDIT_ONLY ? 'audit' : WRITE ? 'write' : 'dry-run',
    alias_rules: variants.length,
    rows_needing_move: 0,
    rows_moved: 0,
    per_rule: {},
    serving_eligible_affected: 0,
  };

  try {
    // ---- 1. Drift audit: what is off-canonical right now? -----------------
    const drift = await pool.query(
      `SELECT p.category_path AS from_path,
              count(*) AS rows,
              count(*) FILTER (WHERE ips.serving_eligible) AS serving_rows
         FROM catalog_products p
         LEFT JOIN index_pipeline_state ips ON ips.content_key = p.content_key
        WHERE p.category_path = ANY($1::text[])
        GROUP BY 1
        ORDER BY 2 DESC`,
      [variants],
    );

    console.log(`\n=== taxonomy drift (${summary.mode}) ===`);
    if (drift.rows.length === 0) {
      console.log('  none — every aliased path is already canonical');
    }
    for (const r of drift.rows) {
      const to = toCanonicalCategoryPath(r.from_path);
      const rows = Number(r.rows);
      summary.rows_needing_move += rows;
      summary.serving_eligible_affected += Number(r.serving_rows);
      summary.per_rule[r.from_path] = { to, rows, serving: Number(r.serving_rows) };
      console.log(
        `  ${String(rows).padStart(5)} rows (${String(r.serving_rows).padStart(5)} serving)  ${r.from_path}  ->  ${to}`,
      );
    }
    console.log(
      `\n  TOTAL: ${summary.rows_needing_move} rows to move (${summary.serving_eligible_affected} serving-eligible)`,
    );

    if (AUDIT_ONLY || summary.rows_needing_move === 0) {
      console.log(`\ndone in ${Date.now() - startedAt}ms`);
      return summary;
    }

    if (!WRITE) {
      console.log('\nDRY RUN — no rows written. Re-run with --write to apply.');
      // Show a sample of affected products so the change is reviewable.
      const sample = await pool.query(
        `SELECT category_path, left(title, 54) AS title
           FROM catalog_products
          WHERE category_path = ANY($1::text[])
          ORDER BY category_path
          LIMIT 12`,
        [variants],
      );
      console.log('\n  sample rows that would move:');
      for (const s of sample.rows) {
        console.log(`    ${s.category_path.padEnd(34)} ${s.title}`);
      }
      console.log(`\ndone in ${Date.now() - startedAt}ms`);
      return summary;
    }

    // ---- 2. Apply, one alias rule at a time, batched ----------------------
    // Batched by product_key so a mid-run failure leaves a partially converged
    // (still valid) state that a re-run finishes — never a torn rewrite.
    for (const [fromPath, meta] of Object.entries(summary.per_rule)) {
      let moved = 0;
      for (;;) {
        if (LIMIT && summary.rows_moved >= LIMIT) break;
        const batch = LIMIT ? Math.min(BATCH, LIMIT - summary.rows_moved) : BATCH;
        const res = await pool.query(
          `UPDATE catalog_products
              SET category_path = $2,
                  category_label_source = 'taxonomy_reconciler_v1',
                  updated_at = updated_at
            WHERE product_key IN (
                    SELECT product_key FROM catalog_products
                     WHERE category_path = $1
                     LIMIT $3
                  )
            RETURNING product_key`,
          [fromPath, meta.to, batch],
        );
        const n = res.rowCount || 0;
        moved += n;
        summary.rows_moved += n;
        if (n === 0) break;
      }
      console.log(`  moved ${String(moved).padStart(5)}  ${fromPath} -> ${meta.to}`);
      if (LIMIT && summary.rows_moved >= LIMIT) {
        console.log(`  (stopped at --limit ${LIMIT})`);
        break;
      }
    }

    // ---- 3. Convergence check: re-audit -----------------------------------
    const after = await pool.query(
      `SELECT count(*) AS remaining FROM catalog_products WHERE category_path = ANY($1::text[])`,
      [variants],
    );
    const remaining = Number(after.rows[0].remaining);
    console.log(`\n  post-run drift: ${remaining} rows still off-canonical${LIMIT ? ' (--limit was set)' : ''}`);
    if (!LIMIT && remaining !== 0) {
      fail(`reconciler did not converge — ${remaining} rows remain`);
    }
    console.log(`\ndone in ${Date.now() - startedAt}ms; moved ${summary.rows_moved} rows`);
    return summary;
  } finally {
    try { await pool.end(); } catch (_) { /* pool already closed */ }
  }
}

if (require.main === module) {
  main().catch((err) => fail(err?.message || String(err)));
}

module.exports = { main };
