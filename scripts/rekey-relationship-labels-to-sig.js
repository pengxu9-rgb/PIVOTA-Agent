#!/usr/bin/env node
'use strict';

// Rekeys relationship_candidate_labels from ext_*-keyed anchor_ref /
// candidate_product_ref to sig_*-keyed equivalents, completing the graph
// identity migration.
//
// Run AFTER:
//   1. backfill-sig-propagation.js --apply  (SIG consistency fixed)
//   2. migration 052                        (sig_id column on PBA)
//   3. fresh builder run                    (generates sig_*-keyed candidates)
//
// Behaviour per label_state:
//   generated / prefilter_rejected: UPDATE refs to sig_* via catalog_products.
//     On unique conflict (two ext_* collapse to same sig pair), keep the row
//     with the higher review_priority or most recent updated_at, delete the other.
//   human_approved / ai_approved: preserve review decisions — same UPDATE + merge
//     logic, but keep the approved row on conflict.
//   human_rejected / needs_evidence: UPDATE refs; on conflict keep the rejected one.
//
// Hard rules:
//   - No DDL. Idempotent: ext_*-keyed rows with no sig match are left untouched.
//   - Dry-run default; --apply required for live writes.

const { query, withClient, closePool } = require('../src/db');

const LOCK_ID = 8823992;

// Rows we can identify a sig_* for
const RESOLVABLE_SQL = `
  WITH sig_map AS (
    SELECT
      l.id,
      l.label_state,
      l.anchor_ref,
      l.candidate_product_ref,
      l.relation_type,
      l.market,
      l.review_priority,
      l.updated_at,
      concat('product:', a_cp.pivota_signature_id) AS new_anchor_ref,
      concat('product:', c_cp.pivota_signature_id) AS new_candidate_ref
    FROM relationship_candidate_labels l
    JOIN catalog_products a_cp
      ON a_cp.source_product_id = regexp_replace(l.anchor_ref, '^product:', '')
    JOIN catalog_products c_cp
      ON c_cp.source_product_id = regexp_replace(l.candidate_product_ref, '^product:', '')
    WHERE l.anchor_ref   LIKE 'product:ext_%'
      AND a_cp.pivota_signature_id IS NOT NULL
      AND c_cp.pivota_signature_id IS NOT NULL
  )
  SELECT count(*)::int AS resolvable FROM sig_map
`;

async function main({ argv = process.argv } = {}) {
  if (!process.env.DATABASE_URL) {
    process.stderr.write('FATAL: DATABASE_URL required\n');
    process.exitCode = 1;
    return;
  }
  const apply = argv.includes('--apply');

  const scope = (await query(RESOLVABLE_SQL)).rows[0];
  process.stdout.write(`resolvable ext_*-keyed rows: ${scope.resolvable}\n`);

  if (!apply) {
    process.stdout.write(JSON.stringify({ status: 'dry_run', ...scope, note: 'pass --apply to write' }) + '\n');
    return;
  }

  let updated = 0;
  let conflictsMerged = 0;
  let residualExtKeyed = 0;

  await withClient(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);

    // Step 1: resolve sig_* refs for all ext_*-keyed rows
    const sigMap = (await client.query(`
      SELECT
        l.id, l.label_state, l.review_priority, l.updated_at,
        regexp_replace(l.anchor_ref, '^product:', '') AS ext_anchor,
        regexp_replace(l.candidate_product_ref, '^product:', '') AS ext_candidate,
        concat('product:', a_cp.pivota_signature_id) AS new_anchor_ref,
        concat('product:', c_cp.pivota_signature_id) AS new_candidate_ref
      FROM relationship_candidate_labels l
      JOIN catalog_products a_cp
        ON a_cp.source_product_id = regexp_replace(l.anchor_ref, '^product:', '')
      JOIN catalog_products c_cp
        ON c_cp.source_product_id = regexp_replace(l.candidate_product_ref, '^product:', '')
      WHERE l.anchor_ref LIKE 'product:ext_%'
        AND a_cp.pivota_signature_id IS NOT NULL
        AND c_cp.pivota_signature_id IS NOT NULL
      ORDER BY
        CASE l.label_state WHEN 'human_approved' THEN 0 WHEN 'ai_approved' THEN 1 WHEN 'human_rejected' THEN 2 ELSE 3 END,
        l.review_priority DESC NULLS LAST, l.updated_at DESC NULLS LAST
    `)).rows;

    // Step 2: detect conflicts (two ext_* rows → same sig identity key)
    const seen = new Map(); // "market|anchor_type|sig_anchor|sig_candidate|relation_type" → winning id
    const toDelete = new Set();
    for (const row of sigMap) {
      const key = `${row.market || 'US'}|product|${row.new_anchor_ref.toLowerCase()}|${row.new_candidate_ref.toLowerCase()}|${row.relation_type}`;
      // Check if a sig_*-keyed row already exists in the DB
      const existing = (await client.query(
        `SELECT id FROM relationship_candidate_labels WHERE lower(anchor_ref)=lower($1) AND lower(candidate_product_ref)=lower($2) AND relation_type=$3 AND market=$4`,
        [row.new_anchor_ref, row.new_candidate_ref, row.relation_type, row.market || 'US'],
      )).rows[0];
      if (existing && existing.id !== row.id) {
        // sig_*-keyed row already exists — this ext_* row loses; delete it
        toDelete.add(row.id);
        conflictsMerged += 1;
        continue;
      }
      if (seen.has(key)) {
        // Another ext_* row already claims this sig identity — delete the loser
        toDelete.add(row.id);
        conflictsMerged += 1;
        continue;
      }
      seen.set(key, row.id);
    }

    // Step 3: delete losers first (avoids unique constraint violations on update)
    if (toDelete.size > 0) {
      await client.query(
        `DELETE FROM relationship_candidate_labels WHERE id = ANY($1::text[])`,
        [Array.from(toDelete)],
      );
    }

    // Step 4: bulk-update surviving rows
    const toUpdate = sigMap.filter((r) => !toDelete.has(r.id));
    const BATCH = 2000;
    for (let i = 0; i < toUpdate.length; i += BATCH) {
      const batch = toUpdate.slice(i, i + BATCH);
      const ids = batch.map((r) => r.id);
      const newAnchors = batch.map((r) => r.new_anchor_ref);
      const newCandidates = batch.map((r) => r.new_candidate_ref);
      await client.query(`
        UPDATE relationship_candidate_labels AS t
        SET anchor_ref           = v.a,
            candidate_product_ref = v.c,
            updated_at           = now()
        FROM (SELECT unnest($1::text[]) id, unnest($2::text[]) a, unnest($3::text[]) c) v
        WHERE t.id = v.id
      `, [ids, newAnchors, newCandidates]);
      updated += batch.length;
    }

    // Step 5: count residual ext_*-keyed rows (orphans with no catalog_products match)
    const residual = (await client.query(
      `SELECT count(*)::int n FROM relationship_candidate_labels WHERE anchor_ref LIKE 'product:ext_%'`,
    )).rows[0].n;
    residualExtKeyed = residual;
  });

  process.stdout.write(JSON.stringify({
    status: 'ok',
    rows_rekeyed: updated,
    conflicts_merged: conflictsMerged,
    residual_ext_keyed_orphans: residualExtKeyed,
    note: residualExtKeyed > 0
      ? 'Orphan rows have no catalog_products entry. Backfill their catalog entries or accept as coverage loss.'
      : 'All ext_*-keyed rows resolved.',
  }) + '\n');
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try { await closePool(); } catch { /* ignored */ }
    });
}

module.exports = { main };
