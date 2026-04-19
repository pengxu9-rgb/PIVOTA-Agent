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

function buildConcernRoleFitText(role = null) {
  return [
    role?.role_id,
    role?.label,
    role?.why_this_role,
    ...(Array.isArray(role?.fit_keywords) ? role.fit_keywords : []),
    ...(Array.isArray(role?.query_terms) ? role.query_terms : []),
    ...(Array.isArray(role?.ingredient_hypotheses) ? role.ingredient_hypotheses : []),
    ...(Array.isArray(role?.product_type_hypotheses) ? role.product_type_hypotheses : []),
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function buildConcernRowEvidenceText(row = null, candidateText = '') {
  const sku = row && typeof row.sku === 'object' && !Array.isArray(row.sku) ? row.sku : {};
  const product = row && typeof row.product === 'object' && !Array.isArray(row.product) ? row.product : {};
  return [
    candidateText,
    row?.title,
    row?.display_name,
    row?.displayName,
    row?.name,
    row?.category,
    row?.product_type,
    row?.productType,
    row?.short_description,
    row?.shortDescription,
    row?.description,
    row?.summary,
    row?.subtitle,
    ...(Array.isArray(row?.key_features) ? row.key_features : []),
    ...(Array.isArray(row?.keyFeatures) ? row.keyFeatures : []),
    ...(Array.isArray(row?.benefit_tags) ? row.benefit_tags : []),
    ...(Array.isArray(row?.benefitTags) ? row.benefitTags : []),
    ...(Array.isArray(row?.search_aliases) ? row.search_aliases : []),
    ...(Array.isArray(row?.searchAliases) ? row.searchAliases : []),
    ...(Array.isArray(row?.tags) ? row.tags : []),
    ...(Array.isArray(row?.tag_tokens) ? row.tag_tokens : []),
    sku?.title,
    sku?.display_name,
    sku?.displayName,
    sku?.name,
    sku?.category,
    sku?.product_type,
    sku?.productType,
    sku?.short_description,
    sku?.shortDescription,
    sku?.description,
    product?.title,
    product?.display_name,
    product?.displayName,
    product?.name,
    product?.category,
    product?.product_type,
    product?.productType,
    product?.short_description,
    product?.shortDescription,
    product?.description,
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function hasRetinoidActiveSignal(text = '') {
  return /\b(retinol|retinal|retinaldehyde|retinoid|tretinoin|adapalene)\b/i.test(String(text || ''));
}

function buildConcernTargetContextFitText(targetContext = null) {
  const semanticPlan = targetContext && typeof targetContext === 'object' ? targetContext.semantic_plan : null;
  const frameworkRoles = Array.isArray(targetContext?.framework_roles) ? targetContext.framework_roles : [];
  return [
    targetContext?.request_text,
    targetContext?.focus_text,
    targetContext?.primary_concern,
    targetContext?.concern,
    targetContext?.framework_id,
    semanticPlan?.primary_concern,
    semanticPlan?.routine_mode,
    semanticPlan?.comparison_mode,
    ...(Array.isArray(semanticPlan?.must_satisfy_constraints) ? semanticPlan.must_satisfy_constraints : []),
    ...(Array.isArray(semanticPlan?.evidence_needed) ? semanticPlan.evidence_needed : []),
    ...frameworkRoles.map((nextRole) => buildConcernRoleFitText(nextRole)),
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function hasOffTargetIrritationActiveSignal(text = '') {
  const haystack = String(text || '');
  return /\b(salicylic acid|bha|glycolic acid|lactic acid|mandelic acid|azelaic acid|benzoyl peroxide|exfoliat(?:e|ing|ion|or)|retinol|retinal|retinaldehyde|retinoid|tretinoin|adapalene|vitamin c|ascorbic acid)\b/i.test(haystack);
}

function hasActiveForwardRoleSignal(text = '') {
  return /\b(acne|blemish|breakout|clogged pore|congestion|oil control|shine control|mattify|mattifying|sebum|brighten|brightening|dark spot|hyperpigmentation|tone|mark|anti[- ]?aging|firming|wrinkle|exfoliat(?:e|ing|ion|or))\b/i.test(String(text || ''));
}

function hasEyeAreaProductSignal(text = '') {
  return /\b(eye cream|eye serum|eye area|under[- ]?eye|bright[- ]?eyed|for eyes?|delicate eye)\b/i.test(String(text || ''));
}

function roleAllowsEyeAreaProduct(roleText = '') {
  return /\b(eye cream|eye serum|eye area|under[- ]?eye|for eyes?|delicate eye|eye)\b/i.test(String(roleText || ''));
}

function roleExpectsLightweightLayeringTexture(roleText = '') {
  return /\b(lightweight|layering|non[- ]?greasy|makeup|under makeup|pilling|gel cream|water cream)\b/i.test(String(roleText || ''));
}

function hasPositiveLightweightTextureSignal(text = '') {
  return /\b(lightweight|layering|non[- ]?greasy|oil[- ]?free|breathable|fast[- ]?absorbing|quick[- ]?absorbing|gel(?:[- ]?cream)?|water(?:[- ]?(?:gel|cream))|fluid|lotion|emulsion|milk)\b/i.test(
    String(text || ''),
  );
}

function hasLayeringMoisturizerFormFactorSignal(text = '') {
  return /\b(moisturi[sz]er|gel[- ]?cream|water[- ]?(?:gel|cream)|face\s+lotion|gel\s+lotion|moisturizing\s+lotion|lotion|emulsion|cream)\b/i.test(
    String(text || ''),
  );
}

function hasMistTonerSprayFormFactorSignal(text = '') {
  return /\b(face\s+mist|facial\s+mist|mist|skin\s+toner|toner|toning\s+mist|spray|spritz)\b/i.test(
    String(text || ''),
  );
}

function roleExplicitlyAllowsMistTonerSpray(role = null, targetContext = null) {
  const roleText = buildConcernRoleFitText(role);
  const contextText = buildConcernTargetContextFitText(targetContext);
  return /\b(face\s+mist|facial\s+mist|mist|skin\s+toner|toner|toning\s+mist|spray|spritz)\b/i.test(
    `${roleText} ${contextText}`.trim(),
  );
}

function hasCosmeticFinishProductShapeSignal(text = '') {
  return /\b(radiance\s+perfector|perfector|glow\s+drops?|bronze\s*\+\s*glow|bronz(?:e|ing|er)(?:\s+drops?)?|highlighter|illuminat(?:or|ing)|luminizer|shimmer|pearlescent|skin\s+tint|tinted\s+moisturi[sz]er|foundation|concealer|bb\s+cream|cc\s+cream|blush|makeup\s+primer|primer)\b/i.test(
    String(text || ''),
  );
}

function roleExplicitlyAllowsCosmeticFinishProduct(role = null, targetContext = null) {
  const roleText = buildConcernRoleFitText(role);
  const contextText = buildConcernTargetContextFitText(targetContext);
  return /\b(glow\s+drops?|bronze\s*\+\s*glow|bronz(?:e|ing|er)(?:\s+drops?)?|radiance\s+perfector|perfector|highlighter|illuminat(?:or|ing)|luminizer|shimmer|pearlescent|skin\s+tint|tinted\s+moisturi[sz]er|foundation|concealer|bb\s+cream|cc\s+cream|blush|makeup\s+primer|primer)\b/i.test(
    `${roleText} ${contextText}`.trim(),
  );
}

function hasHeavyTextureMismatchSignal(text = '') {
  return /\b(rich cream|supreme restorative rich|heavy cream|ultra[- ]?rich|balm|butter|ointment|sleeping mask)\b/i.test(String(text || ''));
}

function hasCoverageTintSignal(text = '') {
  return /\b(tint(?:ed)?|coverage|skin tint|bb cream|cc cream|tone[- ]?up|complexion)\b/i.test(String(text || ''));
}

function roleExplicitlyAllowsCoverageTint(role = null, targetContext = null) {
  const roleText = buildConcernRoleFitText(role);
  const contextText = buildConcernTargetContextFitText(targetContext);
  return /\b(tint(?:ed)?|coverage|skin tint|bb cream|cc cream|tone[- ]?up|complexion|finish fit|under makeup|makeup|primer|base)\b/i.test(
    `${roleText} ${contextText}`.trim(),
  );
}

function roleExpectsLowIrritationSupportProduct(role = null, preferredStep = '', targetContext = null) {
  if (preferredStep !== 'moisturizer' && preferredStep !== 'sunscreen') return false;
  const roleText = buildConcernRoleFitText(role);
  const contextText = buildConcernTargetContextFitText(targetContext);
  if (!roleText && !contextText) return false;
  if (hasActiveForwardRoleSignal(roleText)) return false;
  if (preferredStep === 'moisturizer') {
    return /\b(barrier|repair|soothing|calming|sensitive|hydrating|lightweight|layering|irritation|redness)\b/.test(roleText)
      || /\b(barrier|repair|soothing|calming|sensitive|retinoid|retinol|irritation|redness|reactive|no extra active|avoid active)\b/.test(contextText);
  }
  return /\b(barrier|repair|soothing|calming|sensitive|retinoid|retinol|irritation|redness|reactive|no extra active|avoid active)\b/.test(contextText);
}

function scoreConcernRoleCandidate(row, role, { candidateStep, candidateText = '', targetContext = null } = {}) {
  const roleId = String(role?.role_id || '').trim();
  if (!roleId) return null;
  const preferredStep = normalizeRecoTargetStep(role?.preferred_step);
  const roleText = buildConcernRoleFitText(role);
  const candidateEvidenceText = buildConcernRowEvidenceText(row, candidateText);
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
  const roleSemanticFitMatched = fitKeywordMatches > 0 || queryTermMatches > 0 || ingredientMatches > 0;
  const semanticFitMatched = roleSemanticFitMatched || productTypeMatches > 0;
  const lightweightTextureExpected =
    preferredStep === 'moisturizer' && roleExpectsLightweightLayeringTexture(roleText);
  const lightweightTextureEvidenceMissingApplied =
    lightweightTextureExpected
    && !hasPositiveLightweightTextureSignal(candidateEvidenceText)
    && !hasHeavyTextureMismatchSignal(candidateEvidenceText);
  const supportStepRescueApplied =
    Number(role?.rank || 99) > 1
    && preferredStep !== 'treatment'
    && preferredStep !== 'serum'
    && exactStep
    && retrievalRoleMatched
    && productTypeMatches > 0
    && fitKeywordMatches === 0
    && queryTermMatches === 0
    && ingredientMatches === 0
    && !lightweightTextureEvidenceMissingApplied;
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
  const lowIrritationSupportExpected = roleExpectsLowIrritationSupportProduct(role, preferredStep, targetContext);
  const lowIrritationRetinoidMismatchApplied =
    hasRetinoidActiveSignal(candidateEvidenceText)
    && lowIrritationSupportExpected;
  const lowIrritationOfftargetActiveMismatchApplied =
    hasOffTargetIrritationActiveSignal(candidateEvidenceText)
    && lowIrritationSupportExpected;
  const lowIrritationActiveMismatchApplied =
    lowIrritationRetinoidMismatchApplied || lowIrritationOfftargetActiveMismatchApplied;
  const eyeAreaRoleMismatchApplied =
    preferredStep === 'sunscreen'
    && hasEyeAreaProductSignal(candidateEvidenceText)
    && !roleAllowsEyeAreaProduct(buildConcernRoleFitText(role));
  const lightweightTextureMismatchApplied =
    preferredStep === 'moisturizer'
    && lightweightTextureExpected
    && hasHeavyTextureMismatchSignal(candidateEvidenceText);
  const lightweightMoisturizerFormFactorMismatchApplied =
    preferredStep === 'moisturizer'
    && lightweightTextureExpected
    && hasMistTonerSprayFormFactorSignal(candidateEvidenceText)
    && !hasLayeringMoisturizerFormFactorSignal(candidateEvidenceText)
    && !roleExplicitlyAllowsMistTonerSpray(role, targetContext);
  const cosmeticFinishProductShapeMismatchApplied =
    (preferredStep === 'moisturizer' || preferredStep === 'treatment' || preferredStep === 'serum')
    && hasCosmeticFinishProductShapeSignal(candidateEvidenceText)
    && !roleExplicitlyAllowsCosmeticFinishProduct(role, targetContext);
  const sunscreenCoverageTintMismatchApplied =
    preferredStep === 'sunscreen'
    && hasCoverageTintSignal(candidateEvidenceText)
    && !roleExplicitlyAllowsCoverageTint(role, targetContext);

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
  if (lightweightTextureEvidenceMissingApplied) {
    score = Math.min(score, 0.54);
  }
  if (
    lowIrritationActiveMismatchApplied
    || eyeAreaRoleMismatchApplied
    || lightweightTextureMismatchApplied
    || lightweightMoisturizerFormFactorMismatchApplied
    || cosmeticFinishProductShapeMismatchApplied
    || sunscreenCoverageTintMismatchApplied
  ) {
    score = Math.min(score - 0.34, 0.38);
  }
  score = Math.max(0, score);
  return {
    role_id: roleId,
    role,
    score: Number(score.toFixed(4)),
    semantic_fit_matched: semanticFitMatched,
    role_semantic_fit_matched: roleSemanticFitMatched,
    strong_semantic_fit_matched: strongSemanticFitMatched,
    retrieval_role_matched: retrievalRoleMatched,
    support_step_rescue_applied: supportStepRescueApplied,
    low_irritation_active_mismatch_applied: lowIrritationActiveMismatchApplied,
    low_irritation_retinoid_mismatch_applied: lowIrritationRetinoidMismatchApplied,
    low_irritation_offtarget_active_mismatch_applied: lowIrritationOfftargetActiveMismatchApplied,
    eye_area_role_mismatch_applied: eyeAreaRoleMismatchApplied,
    lightweight_texture_mismatch_applied: lightweightTextureMismatchApplied,
    lightweight_moisturizer_form_factor_mismatch_applied: lightweightMoisturizerFormFactorMismatchApplied,
    cosmetic_finish_product_shape_mismatch_applied: cosmeticFinishProductShapeMismatchApplied,
    lightweight_texture_evidence_missing_applied: lightweightTextureEvidenceMissingApplied,
    sunscreen_coverage_tint_mismatch_applied: sunscreenCoverageTintMismatchApplied,
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
