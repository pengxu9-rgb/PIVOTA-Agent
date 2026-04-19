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

function buildGentleDailySunscreenRole() {
  return {
    ...buildDailySunscreenRole(),
    query_terms: ['daily sunscreen skincare', 'broad spectrum sunscreen'],
  };
}

function buildLayeringMoisturizerRole() {
  return {
    role_id: 'layering_compatible_moisturizer_or_spf',
    rank: 60,
    preferred_step: 'moisturizer',
    label: 'Layering-compatible moisturizer or SPF',
    fit_keywords: ['lightweight', 'layering', 'non-greasy', 'makeup'],
    query_terms: ['gel cream moisturizer', 'lightweight moisturizer', 'makeup layering'],
    product_type_hypotheses: ['moisturizer'],
  };
}

function buildSensitiveBarrierTargetContext() {
  return {
    request_text: 'My barrier feels sensitive while using a retinoid. What should I buy next?',
    primary_concern: 'barrier_support',
    semantic_plan: {
      primary_concern: 'retinoid barrier support',
      routine_mode: 'routine_mix',
      must_satisfy_constraints: ['sensitive barrier', 'avoid extra active treatments'],
    },
    framework_roles: [
      buildBarrierMoisturizerRole(),
      {
        role_id: 'soothing_treatment',
        rank: 2,
        preferred_step: 'treatment',
        alternate_steps: ['serum'],
        label: 'Soothing treatment',
        fit_keywords: ['soothing', 'calming', 'redness', 'sensitive skin'],
      },
      buildGentleDailySunscreenRole(),
    ],
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

function buildBarrierMoisturizerRole() {
  return {
    role_id: 'barrier_moisturizer',
    rank: 2,
    preferred_step: 'moisturizer',
    label: 'Barrier-support moisturizer',
    fit_keywords: ['barrier repair', 'ceramide', 'soothing', 'sensitive skin'],
    query_terms: ['barrier repair moisturizer', 'ceramide cream sensitive skin', 'soothing moisturizer'],
    ingredient_hypotheses: ['Ceramide NP', 'Panthenol', 'Glycerin'],
    product_type_hypotheses: ['moisturizer', 'cream'],
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
    buildGentleDailySunscreenRole(),
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

test('barrier moisturizer role demotes retinoid active moisturizers despite exact product shape', () => {
  const score = scoreConcernRoleCandidate(
    {
      title: 'Beauty of Joseon Revive Firming Moisturizer : Ginseng + Retinol',
      retrieval_role_id: 'barrier_moisturizer',
    },
    buildBarrierMoisturizerRole(),
    {
      candidateStep: 'moisturizer',
      candidateText: 'Beauty of Joseon Revive Firming Moisturizer : Ginseng + Retinol moisturizer',
    },
  );

  assert.ok(score);
  assert.equal(score?.support_step_rescue_applied, true);
  assert.equal(score?.low_irritation_active_mismatch_applied, true);
  assert.ok(Number(score?.score || 0) < 0.42);
});

test('daily sunscreen support demotes acne/tone active SPF in sensitive barrier routine context', () => {
  const score = scoreConcernRoleCandidate(
    {
      title: 'Naturium Dew-Glow Moisturizer SPF 50 - Jumbo',
      retrieval_role_id: 'daily_sunscreen',
    },
    buildGentleDailySunscreenRole(),
    {
      candidateStep: 'sunscreen',
      targetContext: buildSensitiveBarrierTargetContext(),
      candidateText:
        'Naturium Dew-Glow Moisturizer SPF 50 sunscreen with UV filters, niacinamide, salicylic acid, azelaic acid, and glow finish.',
    },
  );

  assert.ok(score);
  assert.equal(score?.low_irritation_active_mismatch_applied, true);
  assert.equal(score?.low_irritation_offtarget_active_mismatch_applied, true);
  assert.ok(Number(score?.score || 0) < 0.42);
});

test('daily sunscreen role does not demote active SPF when the role explicitly asks acne or oil-control fit', () => {
  const role = {
    ...buildDailySunscreenRole(),
    fit_keywords: ['spf', 'lightweight', 'uv filters', 'oil control', 'acne'],
    query_terms: ['oil control sunscreen acne-prone skin'],
  };
  const score = scoreConcernRoleCandidate(
    {
      title: 'Naturium Dew-Glow Moisturizer SPF 50 - Jumbo',
      retrieval_role_id: 'daily_sunscreen',
    },
    role,
    {
      candidateStep: 'sunscreen',
      targetContext: {
        request_text: 'I have oily acne-prone skin. What sunscreen should I buy?',
        semantic_plan: {
          primary_concern: 'oil control and clogged pores',
          must_satisfy_constraints: ['acne-prone', 'oil control'],
        },
      },
      candidateText:
        'Naturium Dew-Glow Moisturizer SPF 50 sunscreen with UV filters, niacinamide, salicylic acid, azelaic acid, and acne-prone oil control support.',
    },
  );

  assert.ok(score);
  assert.equal(score?.low_irritation_active_mismatch_applied, false);
  assert.ok(Number(score?.score || 0) >= 0.52);
});

test('daily sunscreen support demotes eye-area SPF products for full-face sunscreen roles', () => {
  const score = scoreConcernRoleCandidate(
    {
      title: 'Supergoop Bright-Eyed Mineral Eye Cream SPF 40',
      retrieval_role_id: 'daily_sunscreen',
    },
    buildGentleDailySunscreenRole(),
    {
      candidateStep: 'sunscreen',
      candidateText:
        'Supergoop Bright-Eyed Mineral Eye Cream SPF 40 sunscreen for the delicate eye area with UV filters.',
    },
  );

  assert.ok(score);
  assert.equal(score?.eye_area_role_mismatch_applied, true);
  assert.ok(Number(score?.score || 0) < 0.42);
});

test('daily sunscreen role demotes tinted coverage SPF when the request did not ask for tint or coverage', () => {
  const score = scoreConcernRoleCandidate(
    {
      title: 'Supergoop Protec(tint) Daily Skin Tint SPF 50',
      retrieval_role_id: 'daily_sunscreen',
    },
    buildGentleDailySunscreenRole(),
    {
      candidateStep: 'sunscreen',
      targetContext: {
        request_text: 'What daily sunscreen should I buy for sensitive skin?',
        semantic_plan: {
          primary_concern: 'daily sunscreen',
          must_satisfy_constraints: ['sensitive skin', 'daily protection'],
        },
      },
      candidateText:
        'Supergoop Protec(tint) Daily Skin Tint SPF 50 sunscreen with lightweight UV filters and skin-tint coverage.',
    },
  );

  assert.ok(score);
  assert.equal(score?.sunscreen_coverage_tint_mismatch_applied, true);
  assert.ok(Number(score?.score || 0) < 0.42);
});

test('daily sunscreen role keeps tinted coverage SPF viable when the request explicitly asked for tint', () => {
  const score = scoreConcernRoleCandidate(
    {
      title: 'Supergoop Protec(tint) Daily Skin Tint SPF 50',
      retrieval_role_id: 'daily_sunscreen',
    },
    {
      ...buildGentleDailySunscreenRole(),
      fit_keywords: ['spf', 'uv filters', 'tinted', 'coverage'],
      query_terms: ['tinted sunscreen', 'skin tint spf'],
    },
    {
      candidateStep: 'sunscreen',
      targetContext: {
        request_text: 'I want a tinted sunscreen with light coverage.',
        semantic_plan: {
          primary_concern: 'tinted daily sunscreen',
          must_satisfy_constraints: ['tinted finish', 'light coverage'],
        },
      },
      candidateText:
        'Supergoop Protec(tint) Daily Skin Tint SPF 50 sunscreen with lightweight UV filters and skin-tint coverage.',
    },
  );

  assert.ok(score);
  assert.equal(score?.sunscreen_coverage_tint_mismatch_applied, false);
  assert.ok(Number(score?.score || 0) >= 0.58);
});

test('layering moisturizer role demotes rich heavy creams despite exact moisturizer shape', () => {
  const score = scoreConcernRoleCandidate(
    {
      title: 'Jurlique Nutri-Define Supreme Restorative Rich Cream',
      retrieval_role_id: 'layering_compatible_moisturizer_or_spf',
    },
    buildLayeringMoisturizerRole(),
    {
      candidateStep: 'moisturizer',
      candidateText:
        'Jurlique Nutri-Define Supreme Restorative Rich Cream moisturizer with glycerin and squalane.',
    },
  );

  assert.ok(score);
  assert.equal(score?.lightweight_texture_mismatch_applied, true);
  assert.ok(Number(score?.score || 0) < 0.42);
});

test('layering moisturizer role demotes mist and toner form factors even when lightweight copy matches', () => {
  const score = scoreConcernRoleCandidate(
    {
      title: 'PIXI BEAUTY Clarity Mist',
      category: 'Face Mist',
      product_type: 'Face Mist',
      retrieval_role_id: 'layering_compatible_moisturizer_or_spf',
    },
    buildLayeringMoisturizerRole(),
    {
      candidateStep: 'toner',
      candidateText:
        'PIXI BEAUTY Clarity Mist face mist with cica, hyaluronic complex, lightweight oil-free hydration, and makeup layering use.',
    },
  );

  assert.ok(score);
  assert.equal(score?.lightweight_moisturizer_form_factor_mismatch_applied, true);
  assert.equal(score?.lightweight_texture_mismatch_applied, false);
  assert.ok(Number(score?.score || 0) < 0.42);
});

test('layering moisturizer role keeps generic cream as a low-confidence viable fallback when texture evidence is sparse', () => {
  const score = scoreConcernRoleCandidate(
    {
      title: 'Jurlique Rare Rose Cream',
      retrieval_role_id: 'layering_compatible_moisturizer_or_spf',
    },
    buildLayeringMoisturizerRole(),
    {
      candidateStep: 'moisturizer',
      candidateText:
        'Jurlique Rare Rose Cream moisturizer with rose extract and botanical hydration.',
    },
  );

  assert.ok(score);
  assert.equal(score?.support_step_rescue_applied, false);
  assert.equal(score?.lightweight_texture_evidence_missing_applied, true);
  assert.ok(Number(score?.score || 0) >= 0.52);
  assert.ok(Number(score?.score || 0) < 0.58);
});

test('layering moisturizer role stays viable when lightweight lotion evidence is present', () => {
  const score = scoreConcernRoleCandidate(
    {
      title: 'Round Lab Birch Juice Moisturizing Lotion',
      retrieval_role_id: 'layering_compatible_moisturizer_or_spf',
    },
    buildLayeringMoisturizerRole(),
    {
      candidateStep: 'moisturizer',
      candidateText:
        'Round Lab Birch Juice Moisturizing Lotion lightweight moisturizer lotion with non-greasy layering hydration.',
    },
  );

  assert.ok(score);
  assert.equal(score?.lightweight_texture_evidence_missing_applied, false);
  assert.ok(Number(score?.score || 0) >= 0.58);
});
