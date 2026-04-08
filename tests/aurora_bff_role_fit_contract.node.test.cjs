const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreConcernRoleCandidate } = require('../src/auroraBff/roleFitContract');

function buildOilControlTreatmentRole() {
  return {
    role_id: 'oil_control_treatment',
    rank: 1,
    preferred_step: 'treatment',
    alternate_steps: ['serum'],
    fit_keywords: ['oil control', 'shine control', 'mattifying'],
    query_terms: ['oil control serum', 'shine control serum'],
    ingredient_hypotheses: ['niacinamide', 'zinc', 'salicylic acid'],
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
