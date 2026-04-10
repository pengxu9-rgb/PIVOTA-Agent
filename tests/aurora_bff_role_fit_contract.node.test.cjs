const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreConcernRoleCandidate } = require('../src/auroraBff/roleFitContract');

function buildOilControlTreatmentRole() {
  return {
    role_id: 'oil_control_treatment',
    rank: 1,
    preferred_step: 'treatment',
    alternate_steps: ['serum'],
    fit_keywords: ['oil control', 'shine control', 'mattifying', 'acne', 'congestion', 'clogged pores'],
    query_terms: ['oil control serum', 'shine control serum'],
    ingredient_hypotheses: ['niacinamide', 'zinc pca', 'salicylic acid'],
    product_type_hypotheses: ['treatment', 'serum'],
  };
}

test('treatment role rescues serum candidate with paired oil-control actives', () => {
  const score = scoreConcernRoleCandidate(
    {
      title: 'The Ordinary Niacinamide 10% + Zinc 1%',
    },
    buildOilControlTreatmentRole(),
    {
      candidateStep: 'serum',
      candidateText: 'The Ordinary Niacinamide 10% + Zinc 1% serum',
    },
  );

  assert.ok(score);
  assert.equal(score?.treatment_serum_ingredient_rescue_applied, true);
  assert.equal(score?.ingredient_matches, 2);
  assert.equal(score?.product_type_matches, 1);
  assert.ok(Number(score?.score || 0) >= 0.58);
});

test('treatment role rescues role-aligned salicylic serum when semantic acne signal is present', () => {
  const score = scoreConcernRoleCandidate(
    {
      title: 'The Ordinary Salicylic Acid 2% Solution',
      retrieval_role_id: 'oil_control_treatment',
    },
    buildOilControlTreatmentRole(),
    {
      candidateStep: 'serum',
      candidateText: 'The Ordinary Salicylic Acid 2% Solution serum formulated to target acne',
    },
  );

  assert.ok(score);
  assert.equal(score?.treatment_serum_ingredient_rescue_applied, false);
  assert.equal(score?.treatment_serum_active_semantic_rescue_applied, true);
  assert.equal(score?.ingredient_matches, 1);
  assert.equal(score?.product_type_matches, 1);
  assert.ok(Number(score?.score || 0) >= 0.58);
});

test('treatment role keeps niacinamide dark-spot serum below viability without oil-control semantics', () => {
  const score = scoreConcernRoleCandidate(
    {
      title: 'Watch Ya Tone Niacinamide Dark Spot Serum Refill',
      retrieval_role_id: 'oil_control_treatment',
    },
    buildOilControlTreatmentRole(),
    {
      candidateStep: 'serum',
      candidateText: 'Watch Ya Tone Niacinamide Dark Spot Serum Refill serum for dark spots',
    },
  );

  assert.ok(score);
  assert.equal(score?.treatment_serum_active_semantic_rescue_applied, false);
  assert.equal(score?.ingredient_matches, 1);
  assert.ok(Number(score?.score || 0) < 0.42);
});

test('treatment role keeps generic soothing serum below viability threshold', () => {
  const score = scoreConcernRoleCandidate(
    {
      title: 'Winona Soothing Repair Serum',
    },
    buildOilControlTreatmentRole(),
    {
      candidateStep: 'serum',
      candidateText: 'Winona Soothing Repair Serum',
    },
  );

  assert.ok(score);
  assert.equal(score?.treatment_serum_ingredient_rescue_applied, false);
  assert.equal(score?.ingredient_matches, 0);
  assert.ok(Number(score?.score || 0) < 0.42);
});
