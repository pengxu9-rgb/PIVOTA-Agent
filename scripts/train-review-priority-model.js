#!/usr/bin/env node
'use strict';

// Trains the Lever-2 review-priority logistic model from human-labeled
// relationship candidates and writes the committed artifact
// src/auroraBff/relationshipReviewPriorityModel.json.
//
// Read-only on the DB. Uses extractFeatures from relationshipReviewPriority so
// the trained feature space exactly matches inference (no train/serve skew).
//
//   node scripts/train-review-priority-model.js            # report only
//   node scripts/train-review-priority-model.js --write    # also write artifact
//
// Reproducibility: standardized logistic regression, deterministic GD, fixed
// 5-fold interleave. Same data in => same coefficients out.

const fs = require('node:fs');
const path = require('node:path');
const { query, closePool } = require('../src/db');
const { FEATURE_NAMES, extractFeatures } = require('../src/auroraBff/relationshipReviewPriority');

const ARTIFACT = path.join(__dirname, '../src/auroraBff/relationshipReviewPriorityModel.json');

const LABELED_SQL = `
  SELECT l.label_state, l.relation_type, l.score_total, l.anchor_snapshot, l.candidate_snapshot,
         aa.product_form a_form, aa.category_leaf a_leaf, aa.target_area a_area,
         aa.scent_family a_scent, aa.skin_concern a_concern, aa.claim_risk_level a_claim,
         ca.product_form c_form, ca.category_leaf c_leaf, ca.target_area c_area,
         ca.scent_family c_scent, ca.skin_concern c_concern, ca.claim_risk_level c_claim
  FROM relationship_candidate_labels l
  LEFT JOIN product_beauty_attributes aa ON aa.product_key = regexp_replace(l.anchor_ref, '^product:', '')
  LEFT JOIN product_beauty_attributes ca ON ca.product_key = regexp_replace(l.candidate_product_ref, '^product:', '')
  WHERE l.label_state IN ('human_approved','human_rejected')
`;

const brandOf = (s) => (s && (s.brand || s.brand_name || s.vendor)) || null;

function rowToInput(r) {
  return {
    anchorAttrs: { product_form: r.a_form, category_leaf: r.a_leaf, target_area: r.a_area, scent_family: r.a_scent, skin_concern: r.a_concern, claim_risk_level: r.a_claim },
    candidateAttrs: { product_form: r.c_form, category_leaf: r.c_leaf, target_area: r.c_area, scent_family: r.c_scent, skin_concern: r.c_concern, claim_risk_level: r.c_claim },
    relationType: r.relation_type,
    scoreTotal: r.score_total,
    anchorBrand: brandOf(r.anchor_snapshot),
    candidateBrand: brandOf(r.candidate_snapshot),
  };
}

function standardize(Xraw) {
  const d = Xraw[0].length;
  const mean = new Array(d).fill(0); const sd = new Array(d).fill(0);
  for (const x of Xraw) for (let j = 0; j < d; j += 1) mean[j] += x[j] / Xraw.length;
  for (const x of Xraw) for (let j = 0; j < d; j += 1) sd[j] += (x[j] - mean[j]) ** 2 / Xraw.length;
  for (let j = 0; j < d; j += 1) sd[j] = Math.sqrt(sd[j]) || 1;
  return { mean, sd };
}

function fit(X, y, { lr = 0.1, epochs = 400, l2 = 0.01 } = {}) {
  const n = X.length; const d = X[0].length;
  const w = new Array(d).fill(0); let b = 0;
  for (let e = 0; e < epochs; e += 1) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i += 1) {
      let z = b; for (let j = 0; j < d; j += 1) z += w[j] * X[i][j];
      const p = 1 / (1 + Math.exp(-z)); const err = p - y[i];
      for (let j = 0; j < d; j += 1) gw[j] += err * X[i][j]; gb += err;
    }
    for (let j = 0; j < d; j += 1) w[j] -= lr * (gw[j] / n + l2 * w[j]); b -= lr * gb / n;
  }
  return { w, b };
}

function auc(scores, y) {
  const pos = [], neg = [];
  scores.forEach((s, i) => (y[i] ? pos : neg).push(s));
  if (!pos.length || !neg.length) return null;
  let win = 0; for (const p of pos) for (const n of neg) win += p > n ? 1 : (p === n ? 0.5 : 0);
  return win / (pos.length * neg.length);
}

async function main({ argv = process.argv } = {}) {
  if (!process.env.DATABASE_URL) { process.stderr.write('FATAL: DATABASE_URL required\n'); process.exitCode = 1; return; }
  const write = argv.includes('--write');
  const trainedAt = argv.includes('--trained-at') ? argv[argv.indexOf('--trained-at') + 1] : null;

  const { rows } = await query(LABELED_SQL);
  const Xraw = rows.map((r) => extractFeatures(rowToInput(r)));
  const y = rows.map((r) => (r.label_state === 'human_approved' ? 1 : 0));
  const { mean, sd } = standardize(Xraw);
  const std = (x) => x.map((v, j) => (v - mean[j]) / sd[j]);
  const X = Xraw.map(std);

  // 5-fold CV for honest AUC + precision@top-K
  const K = 5; const oof = new Array(X.length).fill(null);
  for (let k = 0; k < K; k += 1) {
    const trX = [], trY = [], te = [];
    X.forEach((x, i) => { if (i % K === k) te.push(i); else { trX.push(x); trY.push(y[i]); } });
    const m = fit(trX, trY);
    for (const i of te) { let z = m.b; for (let j = 0; j < X[i].length; j += 1) z += m.w[j] * X[i][j]; oof[i] = 1 / (1 + Math.exp(-z)); }
  }
  const cvAuc = auc(oof, y);
  const order = oof.map((p, i) => [p, y[i]]).sort((a, b) => b[0] - a[0]);
  const precAt = (f) => { const k = Math.max(1, Math.round(order.length * f)); return +(order.slice(0, k).filter((t) => t[1]).length / k).toFixed(3); };

  // Final fit on all data for the shipped coefficients
  const finalFit = fit(X, y);
  const artifact = {
    model: 'relationship_review_priority',
    kind: 'standardized_logistic',
    feature_names: FEATURE_NAMES,
    mean, sd,
    weights: finalFit.w.map((v) => +v.toFixed(6)),
    intercept: +finalFit.b.toFixed(6),
    trained_at: trainedAt,           // pass via --trained-at; Date.now is unavailable in some harnesses
    n_train: rows.length,
    n_approved: y.reduce((a, c) => a + c, 0),
    cv_auc: +Number(cvAuc).toFixed(3),
    precision_at_top: { '5pct': precAt(0.05), '10pct': precAt(0.10), '20pct': precAt(0.20) },
  };

  process.stdout.write(`${JSON.stringify({ cv_auc: artifact.cv_auc, precision_at_top: artifact.precision_at_top, n_train: artifact.n_train }, null, 2)}\n`);
  if (write) {
    fs.writeFileSync(ARTIFACT, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    process.stderr.write(`wrote ${ARTIFACT}\n`);
  } else {
    process.stderr.write('(report only; pass --write to persist artifact)\n');
  }
  process.exitCode = 0;
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`${e && e.stack ? e.stack : String(e)}\n`); process.exitCode = 1; })
    .finally(async () => { try { await closePool(); } catch { /* ignore */ } });
}

module.exports = { main, LABELED_SQL, rowToInput, fit, auc, ARTIFACT };
