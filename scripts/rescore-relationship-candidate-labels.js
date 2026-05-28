#!/usr/bin/env node
'use strict';

// Rescore `label_state='generated'` rows against the now-populated PBA.
//
// Why this exists: the Phase B preflight gates landed 2026-05-26 (PR #1552),
// but the 2026-05-27 build pass produced 1,113 generated rows BEFORE the C.3
// DeepSeek backfill finished populating ext_* keys in product_beauty_attributes
// (completed 2026-05-28). At build time, attrs lookup returned empty for those
// keys, so applyAllGates passed-by-default for every edge and zero rows were
// routed to prefilter_rejected.
//
// This script re-runs applyAllGates against the still-`generated` queue using
// the now-complete PBA, and promotes failing edges to `prefilter_rejected`.
// Catches a measured ~17% of the queue (76 target_area + 157 category_leaf +
// 29 spf_otc) at <3% FP rate observed on the labeled-data simulation.
//
// Hard rules:
//   - UPDATE only — no INSERT/DELETE/DDL.
//   - WHERE label_state = 'generated' guard prevents racing reviewer decisions.
//   - Dry-run default; --apply required for live writes.
//   - Idempotent: re-running noops on already-rescored rows.

const {
  applyAllGates,
} = require('../src/auroraBff/productRelationshipGraphPreflight');
const {
  lookupBeautyAttributesBatch,
  normalizeKey,
} = require('../src/auroraBff/productBeautyAttributes');
const { query, closePool } = require('../src/db');

const FETCH_GENERATED_SQL = `
  SELECT id, edge_id, anchor_ref, candidate_product_ref, relation_type
  FROM relationship_candidate_labels
  WHERE label_state = 'generated'
  ORDER BY created_at ASC
`;

const PROMOTE_SQL = `
  UPDATE relationship_candidate_labels
  SET label_state = 'prefilter_rejected',
      prefilter_reasons = $1::text[],
      updated_at = now()
  WHERE id = $2
    AND label_state = 'generated'
`;

async function fetchGeneratedRows(queryFn) {
  const r = await queryFn(FETCH_GENERATED_SQL);
  return Array.isArray(r?.rows) ? r.rows : [];
}

function scoreRow(row, attrsByKey) {
  const aKey = normalizeKey(row.anchor_ref);
  const cKey = normalizeKey(row.candidate_product_ref);
  const anchorAttrs = aKey ? attrsByKey.get(aKey) : null;
  const candidateAttrs = cKey ? attrsByKey.get(cKey) : null;
  if (!anchorAttrs || !candidateAttrs) {
    return { bucket: 'skipped_missing_attrs', reasons: null };
  }
  const gateResult = applyAllGates(anchorAttrs, candidateAttrs, row.relation_type);
  if (!gateResult.passes) {
    return { bucket: 'promoted_prefilter_rejected', reasons: gateResult.prefilter_reasons };
  }
  return { bucket: 'passed', reasons: null };
}

async function rescore({
  queryFn,
  lookupFn,
  apply = false,
  startedAt = new Date().toISOString(),
  now = Date.now,
} = {}) {
  const t0 = now();
  const rows = await fetchGeneratedRows(queryFn);
  if (rows.length === 0) {
    return {
      metric: {
        ts: startedAt,
        job: 'rcl_rescore',
        status: 'noop',
        dry_run: !apply,
        candidates_scored: 0,
        promoted: 0,
        skipped_missing_attrs: 0,
        passed: 0,
        promotion_reasons: {},
        duration_ms: now() - t0,
      },
      promotions: [],
    };
  }

  const productKeys = new Set();
  for (const row of rows) {
    const a = normalizeKey(row.anchor_ref);
    const c = normalizeKey(row.candidate_product_ref);
    if (a) productKeys.add(a);
    if (c) productKeys.add(c);
  }
  const attrsByKey = await lookupFn(Array.from(productKeys), { queryFn });

  let promoted = 0, skippedMissing = 0, passed = 0;
  const promotionReasons = {};
  const promotions = [];

  for (const row of rows) {
    const { bucket, reasons } = scoreRow(row, attrsByKey);
    if (bucket === 'promoted_prefilter_rejected') {
      promoted += 1;
      for (const reason of reasons) {
        const head = reason.split(':')[0];
        promotionReasons[head] = (promotionReasons[head] || 0) + 1;
      }
      promotions.push({ id: row.id, edge_id: row.edge_id, reasons });
      if (apply) {
        // eslint-disable-next-line no-await-in-loop
        await queryFn(PROMOTE_SQL, [reasons, row.id]);
      }
    } else if (bucket === 'skipped_missing_attrs') {
      skippedMissing += 1;
    } else {
      passed += 1;
    }
  }

  return {
    metric: {
      ts: startedAt,
      job: 'rcl_rescore',
      status: 'ok',
      dry_run: !apply,
      candidates_scored: rows.length,
      promoted,
      skipped_missing_attrs: skippedMissing,
      passed,
      promotion_reasons: promotionReasons,
      duration_ms: now() - t0,
    },
    promotions,
  };
}

async function main({ env = process.env, argv = process.argv } = {}) {
  if (!env.DATABASE_URL) {
    process.stderr.write('FATAL: DATABASE_URL is required\n');
    process.exitCode = 1;
    return;
  }
  const apply = argv.includes('--apply');
  const { metric } = await rescore({
    queryFn: query,
    lookupFn: lookupBeautyAttributesBatch,
    apply,
  });
  process.stdout.write(`${JSON.stringify(metric)}\n`);
  process.exitCode = 0;
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await closePool();
      } catch {
        // ignored
      }
    });
}

module.exports = {
  rescore,
  scoreRow,
  fetchGeneratedRows,
  FETCH_GENERATED_SQL,
  PROMOTE_SQL,
  main,
};
