const { getAuroraKbV0 } = require('./kbV0/loader');
const {
  collectConceptIdsFromText,
  matchIngredientOntology,
  mapConceptsToRoutineActiveTokens,
} = require('./kbV0/conceptMatcher');
const {
  recordAuroraKbV0RuleMatch,
  recordAuroraKbV0LegacyFallback,
} = require('./visionMetrics');

const RISK_TO_SEVERITY = Object.freeze({
  high: 'block',
  medium: 'warn',
  low: 'low',
});

const SEVERITY_WEIGHT = Object.freeze({
  low: 1,
  warn: 2,
  block: 3,
});

const ACTIVE_TO_CONCEPTS = Object.freeze({
  retinoid: ['RETINOID'],
  benzoyl_peroxide: ['BENZOYL_PEROXIDE'],
  bha: ['BHA', 'SALICYLIC_ACID'],
  aha: ['AHA'],
  vitamin_c: ['VITAMIN_C', 'ASCORBIC_ACID'],
  niacinamide: ['NIACINAMIDE'],
  azelaic_acid: ['AZELAIC_ACID'],
  tranexamic_acid: ['TRANEXAMIC_ACID'],
});

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr || []) {
    const s = String(v || '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function normalizeLanguage(language) {
  return String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
}

function normalizeActiveToken(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return null;

  const map = [
    [/tretinoin|adapalene|retinal|retinol|retinoid/, 'retinoid'],
    [/benzoyl\s*peroxide|bpo/, 'benzoyl_peroxide'],
    [/salicylic|bha/, 'bha'],
    [/glycolic|lactic|mandelic|aha|pha/, 'aha'],
    [/vitamin\s*c|ascorbic|l-ascorbic|ascorbate/, 'vitamin_c'],
    [/niacinamide/, 'niacinamide'],
    [/azelaic/, 'azelaic_acid'],
    [/tranexamic/, 'tranexamic_acid'],
  ];

  for (const [re, out] of map) {
    if (re.test(t)) return out;
  }

  if (t.length > 40) return null;
  return t;
}

function collectProductTextCandidates(product) {
  if (!product || typeof product !== 'object') return [];
  const candidates = [];
  const keyActives = product.key_actives || product.keyActives || product.actives;
  if (Array.isArray(keyActives)) candidates.push(...keyActives);

  const evidence = product.evidence_pack || product.evidencePack;
  if (evidence && typeof evidence === 'object') {
    if (Array.isArray(evidence.keyActives)) candidates.push(...evidence.keyActives);
  }

  const ingredients = product.ingredients;
  if (ingredients && typeof ingredients === 'object') {
    if (Array.isArray(ingredients.highlights)) candidates.push(...ingredients.highlights);
    if (Array.isArray(ingredients.head)) candidates.push(...ingredients.head);
  }

  const fields = [
    product.name,
    product.title,
    product.category,
    product.step,
    product.slot_step,
    product.slotStep,
    product.display_name,
    product.displayName,
    product.product,
  ];
  for (const field of fields) {
    if (typeof field === 'string' && field.trim()) candidates.push(field);
  }

  return candidates
    .flatMap((value) => (typeof value === 'string' ? value.split(/[,/|+]/) : []))
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function inferConceptIdsFromTexts(texts, language = 'EN') {
  const lang = normalizeLanguage(language);
  const conceptIds = [];
  for (const text of Array.isArray(texts) ? texts : []) {
    conceptIds.push(...collectConceptIdsFromText({ text, language: lang, max: 64, includeSubstring: true }));
    const ontology = matchIngredientOntology({ text, language: lang, max: 16 });
    for (const item of ontology) {
      if (!item || typeof item !== 'object') continue;
      conceptIds.push(...(Array.isArray(item.classes) ? item.classes : []));
    }
  }
  return uniq(conceptIds.map((value) => String(value || '').trim().toUpperCase()).filter(Boolean));
}

function extractActives(product, { language = 'EN' } = {}) {
  const candidates = collectProductTextCandidates(product);
  const legacyActives = uniq(
    candidates
      .map(normalizeActiveToken)
      .filter(Boolean),
  );
  const conceptIds = inferConceptIdsFromTexts(candidates, language);
  const mappedActives = mapConceptsToRoutineActiveTokens(conceptIds);
  return uniq([...legacyActives, ...mappedActives]).map((token) => String(token || '').toLowerCase());
}

function extractConcepts(product, { language = 'EN' } = {}) {
  const concepts = new Set();
  const candidates = collectProductTextCandidates(product);
  for (const conceptId of inferConceptIdsFromTexts(candidates, language)) {
    concepts.add(conceptId);
  }
  for (const token of extractActives(product, { language })) {
    const mapped = ACTIVE_TO_CONCEPTS[String(token || '').toLowerCase()] || [];
    for (const conceptId of mapped) concepts.add(String(conceptId || '').toUpperCase());
  }
  return Array.from(concepts);
}

function findDistinctPair(aIndices, bIndices) {
  const a = Array.isArray(aIndices) ? aIndices : [];
  const b = Array.isArray(bIndices) ? bIndices : [];
  for (const i of a) {
    for (const j of b) {
      if (i === j) continue;
      return i < j ? [i, j] : [j, i];
    }
  }
  return null;
}

function collectStepData({ routine, testProduct, language }) {
  const am = Array.isArray(routine && routine.am) ? routine.am : [];
  const pm = Array.isArray(routine && routine.pm) ? routine.pm : [];
  const lang = normalizeLanguage(language);

  const steps = [];
  const addStep = (item) => {
    const actives = extractActives(item, { language: lang }).map((t) => t.toLowerCase());
    const concepts = extractConcepts(item, { language: lang }).map((t) => t.toUpperCase());
    steps.push({
      actives: new Set(actives),
      concepts: new Set(concepts),
    });
  };

  for (const item of am) addStep(item);
  for (const item of pm) addStep(item);
  if (testProduct) addStep(testProduct);

  const routineActives = uniq([
    ...am.flatMap((item) => extractActives(item, { language: lang })),
    ...pm.flatMap((item) => extractActives(item, { language: lang })),
  ]).map((t) => t.toLowerCase());
  const testActives = extractActives(testProduct, { language: lang }).map((t) => t.toLowerCase());

  const routineConcepts = uniq([
    ...am.flatMap((item) => extractConcepts(item, { language: lang })),
    ...pm.flatMap((item) => extractConcepts(item, { language: lang })),
  ]).map((t) => t.toUpperCase());
  const testConcepts = extractConcepts(testProduct, { language: lang }).map((t) => t.toUpperCase());

  const indicesWithActive = (token) => {
    const key = String(token || '').trim().toLowerCase();
    if (!key) return [];
    const out = [];
    for (let i = 0; i < steps.length; i += 1) {
      if (steps[i].actives.has(key)) out.push(i);
    }
    return out;
  };

  const indicesWithConcept = (conceptId) => {
    const key = String(conceptId || '').trim().toUpperCase();
    if (!key) return [];
    const out = [];
    for (let i = 0; i < steps.length; i += 1) {
      if (steps[i].concepts.has(key)) out.push(i);
    }
    return out;
  };

  return {
    steps,
    routineActives,
    testActives,
    routineConcepts,
    testConcepts,
    indicesWithActive,
    indicesWithConcept,
  };
}

function buildLegacyConflicts({ stepData }) {
  const { routineActives, testActives, indicesWithActive } = stepData;
  const has = (token) => routineActives.includes(token) || testActives.includes(token);
  const conflicts = [];

  if (has('retinoid') && (has('aha') || has('bha'))) {
    const pair = findDistinctPair(indicesWithActive('retinoid'), [...indicesWithActive('aha'), ...indicesWithActive('bha')]);
    conflicts.push({
      severity: 'warn',
      rule_id: 'retinoid_x_acids',
      message: 'Retinoids + AHAs/BHAs can increase irritation. Consider alternating nights or spacing them apart.',
      ...(pair ? { step_indices: pair } : {}),
    });
  }

  if (has('retinoid') && has('benzoyl_peroxide')) {
    const pair = findDistinctPair(indicesWithActive('retinoid'), indicesWithActive('benzoyl_peroxide'));
    conflicts.push({
      severity: 'block',
      rule_id: 'retinoid_x_bpo',
      message: 'Avoid layering retinoids with benzoyl peroxide in the same routine; it can be very irritating and reduce efficacy.',
      ...(pair ? { step_indices: pair } : {}),
    });
  }

  if (has('vitamin_c') && (has('aha') || has('bha'))) {
    const pair = findDistinctPair(indicesWithActive('vitamin_c'), [...indicesWithActive('aha'), ...indicesWithActive('bha')]);
    conflicts.push({
      severity: 'warn',
      rule_id: 'vitc_x_acids',
      message: 'Vitamin C + strong acids may be too irritating for some skin types. Consider separating AM/PM.',
      ...(pair ? { step_indices: pair } : {}),
    });
  }

  const exfoliantCount = ['aha', 'bha'].filter((token) => routineActives.includes(token)).length;
  if (exfoliantCount >= 2) {
    const exfoliantSteps = Array.from(new Set([...indicesWithActive('aha'), ...indicesWithActive('bha')])).sort((a, b) => a - b);
    const pair = exfoliantSteps.length >= 2 ? [exfoliantSteps[0], exfoliantSteps[1]] : null;
    conflicts.push({
      severity: 'warn',
      rule_id: 'multiple_exfoliants',
      message: 'Multiple exfoliants detected in the routine. Watch for dryness/irritation and reduce frequency if needed.',
      ...(pair ? { step_indices: pair } : {}),
    });
  }

  for (const row of conflicts) {
    recordAuroraKbV0RuleMatch({ source: 'legacy', ruleId: row.rule_id, level: row.severity });
  }
  return conflicts;
}

function actionMessage(actionCode) {
  const code = String(actionCode || '').trim().toLowerCase();
  if (code === 'avoid_same_night') return 'Avoid using these in the same night.';
  if (code === 'separate_days') return 'Use on separate days.';
  if (code === 'ok_with_caution') return 'Can be layered cautiously with slower frequency.';
  return '';
}

function buildKbInteractionConflicts({ kb, stepData }) {
  const conflicts = [];
  const allConcepts = new Set([
    ...stepData.routineConcepts.map((value) => String(value || '').toUpperCase()),
    ...stepData.testConcepts.map((value) => String(value || '').toUpperCase()),
  ]);
  const interactions = Array.isArray(kb && kb.interaction_rules && kb.interaction_rules.interactions)
    ? kb.interaction_rules.interactions
    : [];

  for (const row of interactions) {
    if (!row || typeof row !== 'object') continue;
    const conceptA = String(row.concept_a || '').trim().toUpperCase();
    const conceptB = String(row.concept_b || '').trim().toUpperCase();
    if (!conceptA || !conceptB) continue;
    if (!allConcepts.has(conceptA) || !allConcepts.has(conceptB)) continue;

    const riskLevel = String(row.risk_level || '').trim().toLowerCase() || 'medium';
    const severity = RISK_TO_SEVERITY[riskLevel] || 'warn';
    const ruleId = String(row.interaction_id || `${conceptA}_X_${conceptB}`).trim();
    const recommendedAction = String(row.recommended_action || '').trim().toLowerCase() || 'ok_with_caution';
    const note = String(row.notes || '').trim();
    const action = actionMessage(recommendedAction);
    const message = [note, action].filter(Boolean).join(' ');

    let pair = findDistinctPair(stepData.indicesWithConcept(conceptA), stepData.indicesWithConcept(conceptB));
    if (!pair) {
      const mappedA = mapConceptsToRoutineActiveTokens([conceptA])[0];
      const mappedB = mapConceptsToRoutineActiveTokens([conceptB])[0];
      if (mappedA && mappedB) {
        pair = findDistinctPair(stepData.indicesWithActive(mappedA), stepData.indicesWithActive(mappedB));
      }
    }

    recordAuroraKbV0RuleMatch({ source: 'kb_v0', ruleId, level: riskLevel });
    conflicts.push({
      severity,
      rule_id: ruleId,
      message: message || 'Potential interaction risk detected.',
      risk_level: riskLevel,
      recommended_action: recommendedAction,
      ...(pair ? { step_indices: pair } : {}),
    });
  }

  return conflicts;
}

function mergeConflicts(rows) {
  const out = [];
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const ruleId = String(row.rule_id || '').trim() || 'unknown_rule';
    const pair = Array.isArray(row.step_indices) && row.step_indices.length === 2
      ? `${Math.min(row.step_indices[0], row.step_indices[1])}|${Math.max(row.step_indices[0], row.step_indices[1])}`
      : 'na';
    const key = `${ruleId}|${pair}`;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...row,
        rule_id: ruleId,
        severity: String(row.severity || 'warn').toLowerCase(),
      });
      continue;
    }

    const prevWeight = SEVERITY_WEIGHT[String(existing.severity || 'low').toLowerCase()] || 1;
    const nextWeight = SEVERITY_WEIGHT[String(row.severity || 'low').toLowerCase()] || 1;
    if (nextWeight > prevWeight) existing.severity = String(row.severity || 'warn').toLowerCase();
    if (!existing.message && row.message) existing.message = String(row.message);
    if (!existing.risk_level && row.risk_level) existing.risk_level = String(row.risk_level);
    if (!existing.recommended_action && row.recommended_action) existing.recommended_action = String(row.recommended_action);
    if (!existing.step_indices && Array.isArray(row.step_indices)) existing.step_indices = row.step_indices.slice(0, 2);
    byKey.set(key, existing);
  }

  for (const row of byKey.values()) out.push(row);
  out.sort((a, b) => {
    const sa = SEVERITY_WEIGHT[String(a.severity || 'low').toLowerCase()] || 1;
    const sb = SEVERITY_WEIGHT[String(b.severity || 'low').toLowerCase()] || 1;
    if (sb !== sa) return sb - sa;
    return String(a.rule_id || '').localeCompare(String(b.rule_id || ''));
  });
  return out;
}

function allowLowRiskSafeCorrection(row) {
  const riskLevel = String(row && row.risk_level ? row.risk_level : '').trim().toLowerCase();
  const recommendedAction = String(row && row.recommended_action ? row.recommended_action : '').trim().toLowerCase();
  return riskLevel === 'low' && recommendedAction === 'ok_with_caution';
}

function simulateConflicts({ routine, testProduct, language = 'EN' } = {}) {
  const stepData = collectStepData({ routine, testProduct, language });
  const kb = getAuroraKbV0();
  const kbAvailable = Boolean(kb && kb.ok && !kb.disabled);
  const kbConflicts = kbAvailable ? buildKbInteractionConflicts({ kb, stepData }) : [];
  const legacyConflicts = buildLegacyConflicts({ stepData });

  if (!kbAvailable && legacyConflicts.length > 0) {
    recordAuroraKbV0LegacyFallback({ reason: (kb && kb.reason) || 'loader_unavailable' });
  } else if (kbAvailable && kbConflicts.length === 0 && legacyConflicts.length > 0) {
    recordAuroraKbV0LegacyFallback({ reason: 'no_kb_match' });
  }

  const conflicts = mergeConflicts([...kbConflicts, ...legacyConflicts]);
  const hasBlock = conflicts.some((row) => String(row.severity || '').toLowerCase() === 'block');
  const hasWarn = conflicts.some((row) => String(row.severity || '').toLowerCase() === 'warn');
  const hasLowOnly = conflicts.length > 0 && !hasBlock && !hasWarn;
  const lowRiskSafeWhitelistEligible = conflicts.length > 0 && conflicts.every((row) => allowLowRiskSafeCorrection(row));

  const safe = !hasBlock && !hasWarn && (conflicts.length === 0 || lowRiskSafeWhitelistEligible);
  const summary = conflicts.length === 0
    ? 'Looks compatible with your routine order.'
    : hasBlock
      ? 'Potentially unsafe combo detected. Consider changing the routine order or alternating days.'
      : hasWarn
        ? 'Some irritation risks detected. Consider spacing actives apart or alternating nights.'
        : lowRiskSafeWhitelistEligible
          ? 'Only low-risk interactions detected. Monitor tolerance and adjust frequency if needed.'
          : 'Low-risk interactions detected but need caution based on action guidance.';

  const pairs = [];
  for (const token of stepData.routineActives) pairs.push(`routine:${token}`);
  for (const token of stepData.testActives) pairs.push(`test:${token}`);

  return {
    safe,
    conflicts,
    summary,
    debug: {
      routineActives: stepData.routineActives,
      testActives: stepData.testActives,
      routineConcepts: stepData.routineConcepts,
      testConcepts: stepData.testConcepts,
      pairs: pairs.slice(0, 64),
      hasLowOnly,
      lowRiskSafeWhitelistEligible,
    },
  };
}

module.exports = {
  extractActives,
  simulateConflicts,
};
