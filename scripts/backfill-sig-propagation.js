#!/usr/bin/env node
'use strict';

// Backfills pivota_signature_id in catalog_products for all product group
// members that don't share their group's canonical (primary) sig.
//
// Root cause: map-and-merge-pdp-entity-resolution.js previously did not
// propagate the primary member's sig to non-primary members, leaving each
// member with its own independently-minted sig. This script fixes the 483
// existing groups with inconsistent sigs.
//
// Hard rules:
//   - UPDATE only — no INSERT/DELETE/DDL.
//   - Idempotent: re-running noops when sigs already match.
//   - Dry-run default; --apply required for live writes.
//   - Uses an advisory lock to prevent concurrent runs.

const { query, withClient, closePool } = require('../src/db');

const LOCK_ID = 8823991;  // shared with map-and-merge sig propagation

const SAFE_GROUPS_CTE = `
  WITH member_conflicts AS (
    SELECT merchant_id, platform, platform_product_id
    FROM product_group_members
    GROUP BY merchant_id, platform, platform_product_id
    HAVING COUNT(DISTINCT product_group_id) > 1
  ),
  ambiguous_member_groups AS (
    SELECT DISTINCT pgm.product_group_id
    FROM product_group_members pgm
    JOIN member_conflicts mc
      ON mc.merchant_id = pgm.merchant_id
     AND mc.platform = pgm.platform
     AND mc.platform_product_id = pgm.platform_product_id
  ),
  primary_candidates AS (
    SELECT
      pgm.product_group_id,
      pgm.merchant_id,
      pgm.platform,
      pgm.platform_product_id,
      cp.pivota_signature_id
    FROM product_group_members pgm
    LEFT JOIN catalog_products cp
      ON cp.merchant_id = pgm.merchant_id
     AND cp.platform = pgm.platform
     AND cp.source_product_id = pgm.platform_product_id
    WHERE pgm.is_primary = true
  ),
  primary_stats AS (
    SELECT
      product_group_id,
      COUNT(*)::int AS primary_row_count,
      (COUNT(DISTINCT pivota_signature_id) FILTER (WHERE pivota_signature_id IS NOT NULL))::int AS primary_sig_count
    FROM primary_candidates
    GROUP BY product_group_id
  ),
  all_groups AS (
    SELECT DISTINCT product_group_id
    FROM product_group_members
  ),
  safe_primary AS (
    SELECT DISTINCT ON (pc.product_group_id)
      pc.product_group_id,
      pc.pivota_signature_id AS canonical_sig,
      pc.merchant_id AS primary_merchant_id,
      pc.platform AS primary_platform,
      pc.platform_product_id AS primary_product_id
    FROM primary_candidates pc
    JOIN primary_stats ps ON ps.product_group_id = pc.product_group_id
    LEFT JOIN ambiguous_member_groups amg ON amg.product_group_id = pc.product_group_id
    WHERE pc.pivota_signature_id IS NOT NULL
      AND ps.primary_sig_count = 1
      AND amg.product_group_id IS NULL
    ORDER BY pc.product_group_id, pc.merchant_id, pc.platform, pc.platform_product_id
  )
`;

const DRY_RUN_GROUPS_SQL = `
  ${SAFE_GROUPS_CTE},
  inconsistent AS (
    SELECT gp.product_group_id,
           gp.canonical_sig,
           pgm.platform_product_id AS member_product_id,
           cp.pivota_signature_id  AS current_sig
    FROM safe_primary gp
    JOIN product_group_members pgm ON pgm.product_group_id = gp.product_group_id
    JOIN catalog_products cp
      ON cp.merchant_id = pgm.merchant_id
     AND cp.platform = pgm.platform
     AND cp.source_product_id = pgm.platform_product_id
    WHERE cp.pivota_signature_id IS DISTINCT FROM gp.canonical_sig
  )
  SELECT
    count(DISTINCT product_group_id)::int AS groups_to_fix,
    count(*)::int                         AS rows_to_update,
    (
      SELECT count(*)::int
      FROM all_groups ag
      LEFT JOIN primary_stats ps ON ps.product_group_id = ag.product_group_id
      WHERE COALESCE(ps.primary_sig_count, 0) = 0
    ) AS groups_missing_primary_sig,
    (
      SELECT count(*)::int
      FROM primary_stats
      WHERE primary_sig_count > 1
    ) AS groups_with_multiple_primary_sigs,
    (
      SELECT count(*)::int
      FROM ambiguous_member_groups
    ) AS groups_with_shared_members
  FROM inconsistent
`;

const APPLY_SQL = `
  ${SAFE_GROUPS_CTE}
  UPDATE catalog_products cp
  SET pivota_signature_id       = gp.canonical_sig,
      pivota_signature_minted_at = COALESCE(cp.pivota_signature_minted_at, now()),
      updated_at                = now()
  FROM product_group_members pgm
  JOIN safe_primary gp ON gp.product_group_id = pgm.product_group_id
  WHERE cp.merchant_id = pgm.merchant_id
    AND cp.platform = pgm.platform
    AND cp.source_product_id = pgm.platform_product_id
    AND cp.pivota_signature_id IS DISTINCT FROM gp.canonical_sig
`;

const VERIFY_SQL = `
  ${SAFE_GROUPS_CTE},
  group_status AS (
    SELECT
      pgm.product_group_id,
      bool_or(cp.pivota_signature_id IS DISTINCT FROM sp.canonical_sig) AS has_mismatch
    FROM safe_primary sp
    JOIN product_group_members pgm ON pgm.product_group_id = sp.product_group_id
    JOIN catalog_products cp
      ON cp.merchant_id = pgm.merchant_id
     AND cp.platform = pgm.platform
     AND cp.source_product_id = pgm.platform_product_id
    GROUP BY pgm.product_group_id
  )
  SELECT
    count(*) FILTER (WHERE has_mismatch)::int AS groups_still_inconsistent,
    (
      SELECT count(*)::int
      FROM all_groups ag
      LEFT JOIN primary_stats ps ON ps.product_group_id = ag.product_group_id
      WHERE COALESCE(ps.primary_sig_count, 0) = 0
    ) AS groups_missing_primary_sig,
    (
      SELECT count(*)::int
      FROM primary_stats
      WHERE primary_sig_count > 1
    ) AS groups_with_multiple_primary_sigs,
    (
      SELECT count(*)::int
      FROM ambiguous_member_groups
    ) AS groups_with_shared_members
  FROM group_status
`;

async function main({ argv = process.argv } = {}) {
  if (!process.env.DATABASE_URL) {
    process.stderr.write('FATAL: DATABASE_URL is required\n');
    process.exitCode = 1;
    return;
  }
  const apply = argv.includes('--apply');

  // Dry-run: show scope
  const scope = (await query(DRY_RUN_GROUPS_SQL)).rows[0];
  process.stdout.write(`scope: ${JSON.stringify(scope)}\n`);

  if (!apply) {
    process.stdout.write(JSON.stringify({
      status: 'dry_run',
      ...scope,
      note: 'pass --apply to write',
    }) + '\n');
    return;
  }

  let rowsUpdated = 0;
  let groupsStillInconsistent = 0;
  let groupsMissingPrimarySig = 0;
  let groupsWithMultiplePrimarySigs = 0;
  let groupsWithSharedMembers = 0;

  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
      const result = await client.query(APPLY_SQL);
      rowsUpdated = result.rowCount || 0;
      const verify = (await client.query(VERIFY_SQL)).rows[0] || {};
      groupsStillInconsistent = Number(verify.groups_still_inconsistent || 0);
      groupsMissingPrimarySig = Number(verify.groups_missing_primary_sig || 0);
      groupsWithMultiplePrimarySigs = Number(verify.groups_with_multiple_primary_sigs || 0);
      groupsWithSharedMembers = Number(verify.groups_with_shared_members || 0);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });

  const skippedGroups =
    groupsMissingPrimarySig + groupsWithMultiplePrimarySigs + groupsWithSharedMembers;
  process.stdout.write(JSON.stringify({
    status: groupsStillInconsistent === 0 && skippedGroups === 0 ? 'ok' : 'partial',
    rows_updated: rowsUpdated,
    groups_still_inconsistent: groupsStillInconsistent,
    groups_missing_primary_sig: groupsMissingPrimarySig,
    groups_with_multiple_primary_sigs: groupsWithMultiplePrimarySigs,
    groups_with_shared_members: groupsWithSharedMembers,
  }) + '\n');

  if (groupsStillInconsistent > 0 || skippedGroups > 0) {
    process.stderr.write(
      `WARNING: ${groupsStillInconsistent} groups still inconsistent; ${skippedGroups} ambiguous or missing-primary-sig groups skipped.\n`,
    );
  }
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
  DRY_RUN_GROUPS_SQL,
  APPLY_SQL,
  VERIFY_SQL,
  LOCK_ID,
};
