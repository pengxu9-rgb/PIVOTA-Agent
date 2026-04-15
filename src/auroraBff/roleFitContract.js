'use strict';

function pickFirstTrimmed(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function normalizeConcernQueryToken(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeRecoTargetStep(value) {
  const token = String(value || '').trim().toLowerCase();
  if (!token) return '';
  if (token.includes('sunscreen') || token.includes('spf') || token.includes('sun')) return 'sunscreen';
  if (token.includes('moistur') || token.includes('cream') || token.includes('lotion') || token.includes('gel cream')) return 'moisturizer';
  if (token.includes('mask')) return 'mask';
  if (token.includes('serum')) return 'serum';
  if (token.includes('treatment') || token.includes('retinol') || token.includes('acid')) return 'treatment';
  if (token.includes('cleanser') || token.includes('wash')) return 'cleanser';
  return token;
}

function countConcernRoleSignalMatches(text, values = [], maxHits = 2) {
  const haystack = String(text || '').trim().toLowerCase();
  if (!haystack) return 0;
  let hits = 0;
  for (const raw of Array.isArray(values) ? values : []) {
    const token = normalizeConcernQueryToken(raw).toLowerCase();
    if (!token || !haystack.includes(token)) continue;
    hits += 1;
    if (hits >= maxHits) break;
  }
  return hits;
}

function buildConcernIngredientAliases(value) {
  const token = normalizeConcernQueryToken(value).toLowerCase();
  if (!token) return [];
  const aliases = new Set([token]);
  if (token === 'zinc pca') aliases.add('zinc');
  if (token === 'salicylic acid') aliases.add('bha');
  return [...aliases];
}

function countConcernIngredientMatches(text, values = [], maxHits = 2) {
  const haystack = String(text || '').trim().toLowerCase();
  if (!haystack) return 0;
  let hits = 0;
  for (const raw of Array.isArray(values) ? values : []) {
    const aliases = buildConcernIngredientAliases(raw);
    if (aliases.length <= 0) continue;
    if (!aliases.some((token) => token && haystack.includes(token))) continue;
    hits += 1;
    if (hits >= maxHits) break;
  }
  return hits;
}

function buildConcernRoleProductTypeHypotheses(role = null, preferredStep = '') {
  const base = Array.isArray(role?.product_type_hypotheses) ? role.product_type_hypotheses : [];
  const aliases = [];
  if (preferredStep === 'moisturizer') {
    aliases.push('moisturizer', 'lotion', 'cream', 'gel cream', 'water gel', 'water cream', 'emulsion');
  } else if (preferredStep === 'sunscreen') {
    aliases.push('sunscreen', 'spf', 'sun fluid', 'sun cream', 'sun lotion', 'uv');
  } else if (preferredStep === 'serum') {
    aliases.push('serum', 'essence', 'ampoule');
  } else if (preferredStep === 'treatment') {
    aliases.push('treatment', 'serum', 'ampoule', 'essence');
  }
  return Array.from(
    new Set(
      [...base, ...aliases]
        .map((value) => normalizeConcernQueryToken(value).toLowerCase())
        .filter(Boolean),
    ),
  );
}

function scoreConcernRoleCandidate(row, role, { candidateStep, candidateText = '' } = {}) {
  const roleId = String(role?.role_id || '').trim();
  if (!roleId) return null;
  const preferredStep = normalizeRecoTargetStep(role?.preferred_step);
  // Treatment roles often land on serum-shaped catalog items even when the planner
  // does not explicitly emit alternate_steps=["serum"].
  const alternateStepSet = new Set(
    Array.isArray(role?.alternate_steps)
      ? role.alternate_steps.map((value) => normalizeRecoTargetStep(value)).filter(Boolean)
      : [],
  );
  if (preferredStep === 'treatment') alternateStepSet.add('serum');
  const alternateSteps = [...alternateStepSet];
  const retrievalRoleId = pickFirstTrimmed(row?.retrieval_role_id, row?.role_id);
  const retrievalRoleMatched = Boolean(retrievalRoleId && retrievalRoleId === roleId);
  const fitKeywordMatches = countConcernRoleSignalMatches(candidateText, role?.fit_keywords, 3);
  const queryTermMatches = countConcernRoleSignalMatches(candidateText, role?.query_terms, 3);
  const ingredientMatches = countConcernIngredientMatches(candidateText, role?.ingredient_hypotheses, 2);
  const productTypeMatches = countConcernRoleSignalMatches(
    candidateText,
    buildConcernRoleProductTypeHypotheses(role, preferredStep),
    2,
  );
  const strongSemanticFitMatched = fitKeywordMatches > 0 || queryTermMatches > 0;
  const exactStep = Boolean(candidateStep && preferredStep && candidateStep === preferredStep);
  const alternateStep = Boolean(candidateStep && alternateSteps.includes(candidateStep));
  const semanticFitMatched = fitKeywordMatches > 0 || queryTermMatches > 0 || ingredientMatches > 0 || productTypeMatches > 0;
  const supportStepRescueApplied =
    Number(role?.rank || 99) > 1
    && preferredStep !== 'treatment'
    && exactStep
    && retrievalRoleMatched
    && productTypeMatches > 0
    && fitKeywordMatches === 0
    && queryTermMatches === 0
    && ingredientMatches === 0;
  const treatmentSerumIngredientRescueApplied =
    preferredStep === 'treatment'
    && candidateStep === 'serum'
    && ingredientMatches >= 2
    && productTypeMatches > 0
    && fitKeywordMatches === 0
    && queryTermMatches === 0;
  const treatmentSerumActiveSemanticRescueApplied =
    preferredStep === 'treatment'
    && candidateStep === 'serum'
    && retrievalRoleMatched
    && ingredientMatches > 0
    && productTypeMatches > 0
    && strongSemanticFitMatched;

  let score = 0;
  if (exactStep) score += preferredStep === 'treatment' ? 0.22 : 0.34;
  else if (alternateStep) {
    // For abstract treatment roles, serum is the real catalog shape.
    // Promote only when the candidate text carries role-level semantics,
    // not when it matches by ingredient tokens alone.
    score += preferredStep === 'treatment'
      ? (strongSemanticFitMatched ? 0.3 : 0.08)
      : 0.18;
  }
  score += Math.min(0.27, fitKeywordMatches * 0.12);
  score += Math.min(0.18, queryTermMatches * 0.08);
  score += Math.min(0.16, ingredientMatches * 0.08);
  score += Math.min(0.12, productTypeMatches * 0.06);
  if (retrievalRoleMatched) score += semanticFitMatched ? 0.08 : 0.02;
  if (
    retrievalRoleMatched
    && preferredStep === 'treatment'
    && alternateStep
    && strongSemanticFitMatched
  ) {
    score += 0.14;
  }
  if (treatmentSerumIngredientRescueApplied) score += 0.32;
  if (treatmentSerumActiveSemanticRescueApplied && !treatmentSerumIngredientRescueApplied) score += 0.08;
  // For routine-ready support slots, keep exact-step moisturizer/sunscreen matches viable
  // when the catalog only gives us the role-matched product shape, without loosening treatment rules.
  if (supportStepRescueApplied) score += 0.16;
  if (preferredStep === 'treatment' && candidateStep === 'serum' && !semanticFitMatched) {
    score = Math.min(score, 0.34);
  }
  if (!semanticFitMatched && !exactStep && !alternateStep) {
    score = Math.min(score, 0.28);
  }
  return {
    role_id: roleId,
    role,
    score: Number(score.toFixed(4)),
    semantic_fit_matched: semanticFitMatched,
    strong_semantic_fit_matched: strongSemanticFitMatched,
    retrieval_role_matched: retrievalRoleMatched,
    support_step_rescue_applied: supportStepRescueApplied,
    treatment_serum_ingredient_rescue_applied: treatmentSerumIngredientRescueApplied,
    treatment_serum_active_semantic_rescue_applied: treatmentSerumActiveSemanticRescueApplied,
    fit_keyword_matches: fitKeywordMatches,
    query_term_matches: queryTermMatches,
    ingredient_matches: ingredientMatches,
    product_type_matches: productTypeMatches,
    exact_step: exactStep,
    alternate_step: alternateStep,
  };
}

module.exports = {
  scoreConcernRoleCandidate,
};
