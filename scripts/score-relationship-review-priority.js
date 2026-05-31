#!/usr/bin/env node
'use strict';

// Lever-2: populate relationship_candidate_labels.review_priority for the
// review-pending ('generated') queue, so reviewers can work highest-predicted-
// approval first. Ranking aid only — does not change label_state or auto-promote.
//
// Hard rules (mirrors rescore-relationship-candidate-labels):
//   - UPDATE only — no INSERT/DELETE/DDL.
//   - WHERE label_state='generated' guard prevents racing reviewer decisions.
//   - Dry-run default; --apply required for live writes.
//   - Idempotent: recomputes deterministically; re-running converges.
//
// Requires migration 050 (review_priority column) before --apply.

const { computeReviewPriority, MODEL } = require('../src/auroraBff/relationshipReviewPriority');
const { lookupBeautyAttributesBatch, normalizeKey } = require('../src/auroraBff/productBeautyAttributes');
const { query, closePool } = require('../src/db');

const FETCH_SQL = `
  SELECT id, anchor_ref, candidate_product_ref, relation_type, score_total,
         anchor_snapshot, candidate_snapshot
  FROM relationship_candidate_labels
  WHERE label_state = 'generated'
  ORDER BY created_at ASC
`;

const UPDATE_SQL = `
  UPDATE relationship_candidate_labels
  SET review_priority = $1, updated_at = now()
  WHERE id = $2 AND label_state = 'generated'
`;

const brandOf = (s) => (s && (s.brand || s.brand_name || s.vendor)) || null;

function priorityForRow(row, attrsByKey) {
  const a = normalizeKey(row.anchor_ref);
  const c = normalizeKey(row.candidate_product_ref);
  return computeReviewPriority({
    anchorAttrs: a ? attrsByKey.get(a) : null,
    candidateAttrs: c ? attrsByKey.get(c) : null,
    relationType: row.relation_type,
    scoreTotal: row.score_total,
    anchorBrand: brandOf(row.anchor_snapshot),
    candidateBrand: brandOf(row.candidate_snapshot),
  });
}

async function scorePriorities({ queryFn = query, lookupFn = lookupBeautyAttributesBatch, apply = false } = {}) {
  if (!MODEL) {
    return { metric: { job: 'rcl_review_priority', status: 'no_model', scored: 0 }, scored: [] };
  }
  const { rows } = await queryFn(FETCH_SQL);
  const keys = new Set();
  for (const r of rows) { const a = normalizeKey(r.anchor_ref); const c = normalizeKey(r.candidate_product_ref); if (a) keys.add(a); if (c) keys.add(c); }
  const attrsByKey = await lookupFn(Array.from(keys), { queryFn });

  const values = [];
  let updated = 0;
  for (const row of rows) {
    const p = priorityForRow(row, attrsByKey);
    if (p == null) continue;
    values.push(p);
    if (apply) {
      // eslint-disable-next-line no-await-in-loop
      await queryFn(UPDATE_SQL, [p, row.id]);
      updated += 1;
    }
  }

  values.sort((x, y) => y - x);
  const q = (f) => (values.length ? values[Math.min(values.length - 1, Math.floor(values.length * f))] : null);
  return {
    metric: {
      job: 'rcl_review_priority',
      status: 'ok',
      dry_run: !apply,
      candidates: rows.length,
      scored: values.length,
      updated,
      model_cv_auc: MODEL.cv_auc,
      distribution: values.length ? {
        max: +values[0].toFixed(3),
        p90: +q(0.10).toFixed(3),
        p50: +q(0.50).toFixed(3),
        p10: +q(0.90).toFixed(3),
        min: +values[values.length - 1].toFixed(3),
      } : null,
    },
  };
}

async function main({ env = process.env, argv = process.argv } = {}) {
  if (!env.DATABASE_URL) { process.stderr.write('FATAL: DATABASE_URL required\n'); process.exitCode = 1; return; }
  const { metric } = await scorePriorities({ apply: argv.includes('--apply') });
  process.stdout.write(`${JSON.stringify(metric)}\n`);
  process.exitCode = 0;
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`${e && e.stack ? e.stack : String(e)}\n`); process.exitCode = 1; })
    .finally(async () => { try { await closePool(); } catch { /* ignore */ } });
}

module.exports = { scorePriorities, priorityForRow, FETCH_SQL, UPDATE_SQL, main };
