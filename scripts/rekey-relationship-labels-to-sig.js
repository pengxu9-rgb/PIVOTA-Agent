#!/usr/bin/env node
'use strict';

// Rekeys relationship_candidate_labels from ext_*-keyed anchor_ref /
// candidate_product_ref values to sig_*-keyed equivalents, completing the graph
// identity migration.
//
// Run AFTER:
//   1. backfill-sig-propagation.js --apply  (SIG consistency fixed)
//   2. migration 052                        (sig_id column on PBA)
//   3. fresh builder run                    (generates sig_*-keyed candidates)
//
// Conflict behaviour:
//   - Preserve explicit review decisions over generated rows.
//   - Priority: human_approved > ai_approved > human_rejected > needs_evidence
//     > review_ready > generated > prefilter_rejected.
//   - Within the same label_state priority, prefer higher review_priority and
//     then newer updated_at.
//
// Hard rules:
//   - No DDL. Idempotent: ext_*-keyed rows with no unambiguous sig match are
//     left untouched and reported as residuals.
//   - Dry-run default; --apply required for live writes.

const { query, withClient, closePool } = require('../src/db');

const SIG_PROPAGATION_LOCK_ID = 8823991;
const REKEY_LOCK_ID = 8823992;
const EXT_REF_LIKE = "LIKE 'product:ext\\_%' ESCAPE '\\'";

const CATALOG_SIG_CTE = `
  WITH catalog_sig AS (
    SELECT
      source_product_id,
      MIN(pivota_signature_id) AS pivota_signature_id
    FROM catalog_products
    WHERE source_product_id IS NOT NULL
      AND source_product_id <> ''
      AND pivota_signature_id IS NOT NULL
    GROUP BY source_product_id
    HAVING COUNT(DISTINCT pivota_signature_id) = 1
  )
`;

const SIG_MAP_SELECT = `
  ${CATALOG_SIG_CTE},
  sig_map AS (
    SELECT
      l.id,
      l.anchor_type,
      l.label_state,
      l.market,
      l.anchor_ref,
      l.candidate_product_ref,
      l.relation_type,
      l.review_priority,
      l.updated_at,
      CASE
        WHEN l.anchor_ref ${EXT_REF_LIKE}
          THEN concat('product:', a_sig.pivota_signature_id)
        ELSE l.anchor_ref
      END AS new_anchor_ref,
      CASE
        WHEN l.candidate_product_ref ${EXT_REF_LIKE}
          THEN concat('product:', c_sig.pivota_signature_id)
        ELSE l.candidate_product_ref
      END AS new_candidate_ref
    FROM relationship_candidate_labels l
    LEFT JOIN catalog_sig a_sig
      ON l.anchor_ref ${EXT_REF_LIKE}
     AND a_sig.source_product_id = regexp_replace(l.anchor_ref, '^product:', '')
    LEFT JOIN catalog_sig c_sig
      ON l.candidate_product_ref ${EXT_REF_LIKE}
     AND c_sig.source_product_id = regexp_replace(l.candidate_product_ref, '^product:', '')
    WHERE (l.anchor_ref ${EXT_REF_LIKE} OR l.candidate_product_ref ${EXT_REF_LIKE})
  )
`;

// Rows where every ext_* side has an unambiguous catalog sig.
const RESOLVABLE_SQL = `
  ${SIG_MAP_SELECT}
  SELECT count(*)::int AS resolvable
  FROM sig_map
  WHERE (anchor_ref NOT ${EXT_REF_LIKE} OR new_anchor_ref IS NOT NULL)
    AND (candidate_product_ref NOT ${EXT_REF_LIKE} OR new_candidate_ref IS NOT NULL)
    AND (
      lower(anchor_ref) IS DISTINCT FROM lower(new_anchor_ref)
      OR lower(candidate_product_ref) IS DISTINCT FROM lower(new_candidate_ref)
    )
`;

const FETCH_SIG_MAP_SQL = `
  ${SIG_MAP_SELECT}
  SELECT *
  FROM sig_map
  WHERE (anchor_ref NOT ${EXT_REF_LIKE} OR new_anchor_ref IS NOT NULL)
    AND (candidate_product_ref NOT ${EXT_REF_LIKE} OR new_candidate_ref IS NOT NULL)
    AND (
      lower(anchor_ref) IS DISTINCT FROM lower(new_anchor_ref)
      OR lower(candidate_product_ref) IS DISTINCT FROM lower(new_candidate_ref)
    )
`;

const FETCH_EXISTING_SQL = `
  WITH target AS (
    SELECT
      unnest($1::text[]) AS market,
      unnest($2::text[]) AS anchor_type,
      unnest($3::text[]) AS anchor_ref,
      unnest($4::text[]) AS candidate_product_ref,
      unnest($5::text[]) AS relation_type
  )
  SELECT DISTINCT
    l.id,
    l.anchor_type,
    l.label_state,
    l.market,
    l.anchor_ref,
    l.candidate_product_ref,
    l.relation_type,
    l.review_priority,
    l.updated_at
  FROM relationship_candidate_labels l
  JOIN target t
    ON l.market = t.market
   AND l.anchor_type = t.anchor_type
   AND lower(l.anchor_ref) = lower(t.anchor_ref)
   AND lower(l.candidate_product_ref) = lower(t.candidate_product_ref)
   AND l.relation_type = t.relation_type
`;

const RESIDUAL_SQL = `
  SELECT count(*)::int AS n
  FROM relationship_candidate_labels
  WHERE anchor_ref ${EXT_REF_LIKE}
     OR candidate_product_ref ${EXT_REF_LIKE}
`;

function labelStatePriority(labelState) {
  switch (String(labelState || '').toLowerCase()) {
    case 'human_approved': return 100;
    case 'ai_approved': return 90;
    case 'human_rejected': return 80;
    case 'needs_evidence': return 70;
    case 'review_ready': return 60;
    case 'generated': return 20;
    case 'prefilter_rejected': return 10;
    default: return 0;
  }
}

function updatedTime(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function compareWinner(left, right) {
  const priorityDelta = labelStatePriority(left.label_state) - labelStatePriority(right.label_state);
  if (priorityDelta) return priorityDelta;
  const reviewPriorityDelta = Number(left.review_priority ?? -1) - Number(right.review_priority ?? -1);
  if (Math.abs(reviewPriorityDelta) > 0.000001) return reviewPriorityDelta;
  const updatedDelta = updatedTime(left.updated_at) - updatedTime(right.updated_at);
  if (updatedDelta) return updatedDelta;
  return String(right.id || '').localeCompare(String(left.id || ''));
}

function identityKey(row) {
  return [
    String(row.market || 'US'),
    String(row.anchor_type || 'product'),
    String(row.new_anchor_ref || row.anchor_ref || '').toLowerCase(),
    String(row.new_candidate_ref || row.candidate_product_ref || '').toLowerCase(),
    String(row.relation_type || ''),
  ].join('|');
}

function chooseWinner(rows) {
  return rows.reduce((winner, row) => (!winner || compareWinner(row, winner) > 0 ? row : winner), null);
}

async function fetchExistingRows(client, sigMap) {
  if (!sigMap.length) return [];
  const uniqueTargets = Array.from(new Map(sigMap.map((row) => [identityKey(row), row])).values());
  const res = await client.query(
    FETCH_EXISTING_SQL,
    [
      uniqueTargets.map((row) => row.market || 'US'),
      uniqueTargets.map((row) => row.anchor_type || 'product'),
      uniqueTargets.map((row) => row.new_anchor_ref),
      uniqueTargets.map((row) => row.new_candidate_ref),
      uniqueTargets.map((row) => row.relation_type),
    ],
  );
  return (Array.isArray(res?.rows) ? res.rows : []).map((row) => ({
    ...row,
    kind: 'existing',
    new_anchor_ref: row.anchor_ref,
    new_candidate_ref: row.candidate_product_ref,
  }));
}

function planConflictResolution(sigMap, existingRows) {
  const groups = new Map();
  for (const row of sigMap) {
    const item = { ...row, kind: 'ext' };
    const key = identityKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const row of existingRows) {
    const key = identityKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const toDelete = new Set();
  const toUpdate = [];
  let conflictsMerged = 0;
  for (const rows of groups.values()) {
    const winner = chooseWinner(rows);
    if (!winner) continue;
    for (const row of rows) {
      if (row.id === winner.id) continue;
      toDelete.add(row.id);
      conflictsMerged += 1;
    }
    if (winner.kind === 'ext') toUpdate.push(winner);
  }
  return { toDelete, toUpdate, conflictsMerged };
}

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
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [SIG_PROPAGATION_LOCK_ID]);
      await client.query('SELECT pg_advisory_xact_lock($1)', [REKEY_LOCK_ID]);

      const sigMap = (await client.query(FETCH_SIG_MAP_SQL)).rows;
      const existingRows = await fetchExistingRows(client, sigMap);
      const plan = planConflictResolution(sigMap, existingRows);
      conflictsMerged = plan.conflictsMerged;

      if (plan.toDelete.size > 0) {
        await client.query(
          'DELETE FROM relationship_candidate_labels WHERE id = ANY($1::text[])',
          [Array.from(plan.toDelete)],
        );
      }

      const BATCH = 2000;
      for (let i = 0; i < plan.toUpdate.length; i += BATCH) {
        const batch = plan.toUpdate.slice(i, i + BATCH);
        const res = await client.query(`
          UPDATE relationship_candidate_labels AS t
          SET anchor_ref            = v.a,
              candidate_product_ref = v.c,
              updated_at            = now()
          FROM (
            SELECT
              unnest($1::text[]) AS id,
              unnest($2::text[]) AS a,
              unnest($3::text[]) AS c
          ) v
          WHERE t.id = v.id
        `, [
          batch.map((row) => row.id),
          batch.map((row) => row.new_anchor_ref),
          batch.map((row) => row.new_candidate_ref),
        ]);
        updated += Number(res.rowCount || 0);
      }

      residualExtKeyed = Number(((await client.query(RESIDUAL_SQL)).rows[0] || {}).n || 0);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });

  process.stdout.write(JSON.stringify({
    status: residualExtKeyed === 0 ? 'ok' : 'partial',
    rows_rekeyed: updated,
    conflicts_merged: conflictsMerged,
    residual_ext_keyed_orphans: residualExtKeyed,
    note: residualExtKeyed > 0
      ? 'Residual rows have no unambiguous catalog_products sig. Backfill catalog identities or accept as coverage loss.'
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

module.exports = {
  main,
  labelStatePriority,
  compareWinner,
  planConflictResolution,
  RESOLVABLE_SQL,
  FETCH_SIG_MAP_SQL,
  REKEY_LOCK_ID,
  SIG_PROPAGATION_LOCK_ID,
};
