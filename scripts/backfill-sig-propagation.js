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

const LOCK_ID = 8823991;  // arbitrary advisory lock key unique to this job

const DRY_RUN_GROUPS_SQL = `
  WITH group_primary AS (
    SELECT pgm.product_group_id,
           cp.pivota_signature_id AS canonical_sig,
           pgm.platform_product_id AS primary_product_id
    FROM product_group_members pgm
    JOIN catalog_products cp
      ON cp.source_product_id = pgm.platform_product_id
    WHERE pgm.is_primary = true
      AND cp.pivota_signature_id IS NOT NULL
  ),
  inconsistent AS (
    SELECT gp.product_group_id,
           gp.canonical_sig,
           pgm.platform_product_id AS member_product_id,
           cp.pivota_signature_id  AS current_sig
    FROM group_primary gp
    JOIN product_group_members pgm ON pgm.product_group_id = gp.product_group_id
    JOIN catalog_products cp ON cp.source_product_id = pgm.platform_product_id
    WHERE cp.pivota_signature_id IS DISTINCT FROM gp.canonical_sig
  )
  SELECT
    count(DISTINCT product_group_id)::int AS groups_to_fix,
    count(*)::int                         AS rows_to_update
  FROM inconsistent
`;

const APPLY_SQL = `
  WITH group_primary AS (
    SELECT pgm.product_group_id,
           cp.pivota_signature_id AS canonical_sig
    FROM product_group_members pgm
    JOIN catalog_products cp ON cp.source_product_id = pgm.platform_product_id
    WHERE pgm.is_primary = true
      AND cp.pivota_signature_id IS NOT NULL
  )
  UPDATE catalog_products cp
  SET pivota_signature_id       = gp.canonical_sig,
      pivota_signature_minted_at = COALESCE(cp.pivota_signature_minted_at, now()),
      updated_at                = now()
  FROM product_group_members pgm
  JOIN group_primary gp ON gp.product_group_id = pgm.product_group_id
  WHERE cp.source_product_id = pgm.platform_product_id
    AND cp.pivota_signature_id IS DISTINCT FROM gp.canonical_sig
`;

const VERIFY_SQL = `
  SELECT count(DISTINCT pgm.product_group_id) FILTER (
    WHERE (
      SELECT count(DISTINCT cp2.pivota_signature_id)
      FROM product_group_members pgm2
      JOIN catalog_products cp2 ON cp2.source_product_id = pgm2.platform_product_id
      WHERE pgm2.product_group_id = pgm.product_group_id
        AND cp2.pivota_signature_id IS NOT NULL
    ) > 1
  )::int AS groups_still_inconsistent
  FROM product_group_members pgm
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

  await withClient(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    const result = await client.query(APPLY_SQL);
    rowsUpdated = result.rowCount || 0;
    const verify = (await client.query(VERIFY_SQL)).rows[0];
    groupsStillInconsistent = Number(verify.groups_still_inconsistent);
  });

  process.stdout.write(JSON.stringify({
    status: groupsStillInconsistent === 0 ? 'ok' : 'partial',
    rows_updated: rowsUpdated,
    groups_still_inconsistent: groupsStillInconsistent,
  }) + '\n');

  if (groupsStillInconsistent > 0) {
    process.stderr.write(
      `WARNING: ${groupsStillInconsistent} groups still inconsistent — primary may lack a sig.\n`,
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

module.exports = { main };
