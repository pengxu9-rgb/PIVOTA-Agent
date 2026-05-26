#!/usr/bin/env node
'use strict';

// Walks relationship_candidate_labels, resolves beauty attributes for each
// anchor+candidate pair, applies the Phase B preflight gates, and tallies
// the result against the reviewer's actual decision.
//
// For each row in the labels table:
//   - human_approved: counted as TP / FP based on gate outcome
//     (pass = correct, reject = false positive — gates would have wrongly
//     blocked an approved candidate)
//   - human_rejected: counted as TN / FN based on gate outcome
//     (reject = correct catch, pass = miss — gates would have let this
//     bad candidate reach the reviewer)
//
// Output: confusion-matrix + per-gate impact + per-relation-type breakdown.
// Read-only: no DB writes. Use --output <path> to dump a JSON report.

const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../src/db');
const { lookupBeautyAttributesBatch, normalizeKey } = require('../src/auroraBff/productBeautyAttributes');
const {
  applyAllGates,
  gateProductFormMismatch,
  gateTargetAreaMismatch,
  gateSpfOtcMismatch,
} = require('../src/auroraBff/productRelationshipGraphPreflight');

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const PER_GATE_FNS = {
  product_form: gateProductFormMismatch,
  target_area: gateTargetAreaMismatch,
  spf_or_otc: gateSpfOtcMismatch,
};

async function loadLabels({ queryFn = query, limit = null } = {}) {
  const limitSql = limit ? `LIMIT ${Math.max(1, Math.min(100000, Number(limit) || 1))}` : '';
  const res = await queryFn(`
    SELECT
      id,
      anchor_type,
      anchor_ref,
      candidate_product_ref,
      relation_type,
      label_state,
      market
    FROM relationship_candidate_labels
    WHERE anchor_type = 'product'
      AND candidate_product_ref LIKE 'product:%'
    ${limitSql}
  `);
  return Array.isArray(res?.rows) ? res.rows : [];
}

async function runValidation({ queryFn = query, limit = null, verbose = false } = {}) {
  const labels = await loadLabels({ queryFn, limit });
  const productKeys = new Set();
  for (const r of labels) {
    productKeys.add(normalizeKey(r.anchor_ref));
    productKeys.add(normalizeKey(r.candidate_product_ref));
  }
  productKeys.delete('');

  const attrsByKey = await lookupBeautyAttributesBatch(Array.from(productKeys), { queryFn });

  const counters = {
    total: labels.length,
    by_label_state: {},
    by_relation_type: {},
    confusion: { TP: 0, FP: 0, TN: 0, FN: 0, skipped: 0 },
    gate_impact: {
      product_form: { fires_on_approved: 0, fires_on_rejected: 0 },
      target_area: { fires_on_approved: 0, fires_on_rejected: 0 },
      spf_or_otc: { fires_on_approved: 0, fires_on_rejected: 0 },
    },
    coverage: {
      both_attrs_present: 0,
      one_missing: 0,
      both_missing: 0,
    },
    failure_reason_examples: {},
  };

  const samples = { false_positive: [], true_positive: [], false_negative: [] };

  for (const row of labels) {
    counters.by_label_state[row.label_state] = (counters.by_label_state[row.label_state] || 0) + 1;
    counters.by_relation_type[row.relation_type] = (counters.by_relation_type[row.relation_type] || 0) + 1;

    const anchorAttrs = attrsByKey.get(normalizeKey(row.anchor_ref));
    const candidateAttrs = attrsByKey.get(normalizeKey(row.candidate_product_ref));
    if (anchorAttrs && candidateAttrs) counters.coverage.both_attrs_present += 1;
    else if (!anchorAttrs && !candidateAttrs) counters.coverage.both_missing += 1;
    else counters.coverage.one_missing += 1;

    // Per-gate firing (for impact breakdown):
    for (const [gateName, gateFn] of Object.entries(PER_GATE_FNS)) {
      const r = gateFn(anchorAttrs, candidateAttrs, row.relation_type);
      if (!r.passes) {
        if (row.label_state === 'human_approved') counters.gate_impact[gateName].fires_on_approved += 1;
        else if (row.label_state === 'human_rejected') counters.gate_impact[gateName].fires_on_rejected += 1;
      }
    }

    // Combined applyAllGates → confusion-matrix bucketing:
    const combined = applyAllGates(anchorAttrs, candidateAttrs, row.relation_type);
    const gatesPass = combined.passes;

    if (row.label_state === 'human_approved') {
      if (gatesPass) counters.confusion.TP += 1;
      else {
        counters.confusion.FP += 1;
        if (samples.false_positive.length < 5) {
          samples.false_positive.push({
            id: row.id,
            relation_type: row.relation_type,
            anchor_ref: row.anchor_ref,
            candidate_product_ref: row.candidate_product_ref,
            anchor_attrs: anchorAttrs ? { product_form: anchorAttrs.product_form, target_area: anchorAttrs.target_area, spf_or_otc_flag: anchorAttrs.spf_or_otc_flag } : null,
            candidate_attrs: candidateAttrs ? { product_form: candidateAttrs.product_form, target_area: candidateAttrs.target_area, spf_or_otc_flag: candidateAttrs.spf_or_otc_flag } : null,
            prefilter_reasons: combined.prefilter_reasons,
          });
        }
      }
    } else if (row.label_state === 'human_rejected') {
      if (!gatesPass) {
        counters.confusion.TN += 1;
        if (samples.true_positive.length < 5) {
          samples.true_positive.push({
            id: row.id,
            relation_type: row.relation_type,
            anchor_attrs: anchorAttrs ? { product_form: anchorAttrs.product_form, target_area: anchorAttrs.target_area, spf_or_otc_flag: anchorAttrs.spf_or_otc_flag } : null,
            candidate_attrs: candidateAttrs ? { product_form: candidateAttrs.product_form, target_area: candidateAttrs.target_area, spf_or_otc_flag: candidateAttrs.spf_or_otc_flag } : null,
            prefilter_reasons: combined.prefilter_reasons,
          });
        }
        for (const reason of combined.prefilter_reasons) {
          const key = reason.split(':')[0];
          counters.failure_reason_examples[key] = (counters.failure_reason_examples[key] || 0) + 1;
        }
      } else {
        counters.confusion.FN += 1;
        if (samples.false_negative.length < 5) {
          samples.false_negative.push({
            id: row.id,
            relation_type: row.relation_type,
            anchor_attrs: anchorAttrs ? { product_form: anchorAttrs.product_form, target_area: anchorAttrs.target_area, spf_or_otc_flag: anchorAttrs.spf_or_otc_flag } : null,
            candidate_attrs: candidateAttrs ? { product_form: candidateAttrs.product_form, target_area: candidateAttrs.target_area, spf_or_otc_flag: candidateAttrs.spf_or_otc_flag } : null,
          });
        }
      }
    } else {
      counters.confusion.skipped += 1;
    }
  }

  const { TP, FP, TN, FN } = counters.confusion;
  const summary = {
    universe: labels.length,
    label_states: counters.by_label_state,
    relation_types: counters.by_relation_type,
    attribute_coverage: counters.coverage,
    confusion_matrix: counters.confusion,
    metrics: {
      // Of approved candidates, what fraction do gates correctly NOT reject?
      // (1 - false_positive_rate)
      approved_pass_rate: TP + FP === 0 ? null : Number((TP / (TP + FP)).toFixed(4)),
      // Of rejected candidates, what fraction do gates correctly reject?
      // (true_positive_rate / recall on negatives)
      rejected_catch_rate: TN + FN === 0 ? null : Number((TN / (TN + FN)).toFixed(4)),
      // Of all candidates gates reject, what fraction were actually rejections?
      // (precision when gates fire)
      gate_precision: FP + TN === 0 ? null : Number((TN / (TN + FP)).toFixed(4)),
    },
    gate_impact: counters.gate_impact,
    failure_reason_top_codes: counters.failure_reason_examples,
    samples: verbose ? samples : {
      false_positive_count: samples.false_positive.length,
      true_positive_count: samples.true_positive.length,
      false_negative_count: samples.false_negative.length,
    },
  };
  if (verbose) summary.samples = samples;
  return summary;
}

async function main() {
  const limit = argValue('limit');
  const outputPath = argValue('output');
  const verbose = hasFlag('verbose');

  const summary = await runValidation({
    limit: limit ? Number(limit) : null,
    verbose,
  });

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (outputPath) {
    const resolved = path.isAbsolute(outputPath) ? outputPath : path.join(process.cwd(), outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        const { closePool } = require('../src/db');
        if (typeof closePool === 'function') await closePool();
      } catch {
        // No-op in test/no-db contexts.
      }
      if (process.exitCode) process.exit(process.exitCode);
    });
}

module.exports = {
  loadLabels,
  runValidation,
};
