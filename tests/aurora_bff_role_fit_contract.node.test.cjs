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

function buildDailySunscreenRole() {
  return {
    role_id: 'daily_sunscreen',
    rank: 3,
    preferred_step: 'sunscreen',
    fit_keywords: ['spf', 'lightweight', 'uv filters', 'non-greasy'],
    query_terms: ['oil control sunscreen', 'lightweight sunscreen oily skin'],
    ingredient_hypotheses: ['UV filters'],
    product_type_hypotheses: ['sunscreen'],
  };
}

function buildHydratingSerumRole() {
  return {
    role_id: 'hydrating_serum_or_essence',
    rank: 2,
    preferred_step: 'serum',
    fit_keywords: ['hydrating', 'dehydrated', 'hyaluronic acid', 'essence', 'plumping'],
    query_terms: ['hydrating serum dehydrated skin', 'hyaluronic acid serum'],
    ingredient_hypotheses: ['Hyaluronic acid', 'Glycerin', 'Panthenol'],
    product_type_hypotheses: ['serum', 'essence'],
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

test('support sunscreen role rescues exact-step role-matched candidate with weak title semantics', () => {
  const score = scoreConcernRoleCandidate(
    {
      title: 'Daily Protect',
      retrieval_role_id: 'daily_sunscreen',
    },
    buildDailySunscreenRole(),
    {
      candidateStep: 'sunscreen',
      candidateText: 'Daily Protect sunscreen',
    },
  );

  assert.ok(score);
  assert.equal(score?.support_step_rescue_applied, true);
  assert.equal(score?.fit_keyword_matches, 0);
  assert.equal(score?.query_term_matches, 0);
  assert.equal(score?.ingredient_matches, 0);
  assert.equal(score?.product_type_matches, 1);
  assert.ok(Number(score?.score || 0) >= 0.58);
});

test('hydrating serum role does not treat generic serum shape as role evidence', () => {
  const score = scoreConcernRoleCandidate(
    {
      title: 'The Ordinary Niacinamide 10% + Zinc 1%',
      retrieval_role_id: 'hydrating_serum_or_essence',
    },
    buildHydratingSerumRole(),
    {
      candidateStep: 'serum',
      candidateText: 'The Ordinary Niacinamide 10% + Zinc 1% serum for oil balance',
    },
  );

  assert.ok(score);
  assert.equal(score?.support_step_rescue_applied, false);
  assert.equal(score?.role_semantic_fit_matched, false);
  assert.equal(score?.semantic_fit_matched, true);
  assert.equal(score?.product_type_matches, 1);
  assert.ok(Number(score?.score || 0) < 0.52);
});

test('hydrating serum role remains viable when true hydration evidence is present', () => {
  const score = scoreConcernRoleCandidate(
    {
      title: 'Hydra B5 Hyaluronic Acid Serum',
      retrieval_role_id: 'hydrating_serum_or_essence',
    },
    buildHydratingSerumRole(),
    {
      candidateStep: 'serum',
      candidateText: 'Hydra B5 Hyaluronic Acid Serum hydrating plumping serum with glycerin',
    },
  );

  assert.ok(score);
  assert.equal(score?.role_semantic_fit_matched, true);
  assert.equal(score?.fit_keyword_matches > 0 || score?.ingredient_matches > 0, true);
  assert.ok(Number(score?.score || 0) >= 0.52);
});
