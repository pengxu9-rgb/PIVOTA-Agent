const crypto = require('crypto');

const LlmGateway = require('./services/llm_gateway');
const { runRecoHybridResolveCandidates } = require('./usecases/recoHybridResolveCandidates');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return value == null ? '' : String(value).trim();
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return '';
}

function uniqStrings(values, max = 12) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const text = asString(raw);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function clampNumber(value, min = 0, max = 1, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function normalizeLanguage(value) {
  return String(value || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
}

function normalizeSlot(slot) {
  const token = asString(slot).toLowerCase();
  if (token === 'pm') return 'pm';
  if (token === 'am') return 'am';
  return 'unknown';
}

function normalizeStep(step) {
  const token = asString(step).toLowerCase();
  if (!token) return 'other';
  if (/(spf|sunscreen|sun screen|uv|防晒)/i.test(token)) return 'sunscreen';
  if (/(cleanser|cleanse|face wash|洁面|洗面|清洁)/i.test(token)) return 'cleanser';
  if (/(moistur|cream|lotion|balm|gel|面霜|乳液|保湿|修护)/i.test(token)) return 'moisturizer';
  if (/(toner|mist|softener|化妆水|爽肤水|喷雾)/i.test(token)) return 'toner';
  if (/(essence|精华水)/i.test(token)) return 'essence';
  if (/(serum|ampoule|booster|retinol|retinoid|acid|aha|bha|azelaic|niacinamide|vitamin c|peptide|benzoyl|精华|活性|酸|维a|烟酰胺|壬二酸|过氧化苯甲酰)/i.test(token)) {
    return 'treatment';
  }
  return token;
}

function inferProductType(candidate) {
  const step = normalizeStep(candidate && candidate.step);
  const text = asString(candidate && candidate.product_text);
  const lower = text.toLowerCase();
  if (step === 'sunscreen') return 'sunscreen';
  if (step === 'cleanser') return 'cleanser';
  if (step === 'moisturizer') return /spf/.test(lower) ? 'spf moisturizer' : 'moisturizer';
  if (step === 'toner') return 'toner';
  if (step === 'essence') return 'essence';
  if (/retinol|retinal|retinoid/.test(lower)) return 'retinoid serum';
  if (/aha|bha|salicylic|glycolic|lactic|mandelic|exfoliat|peel|刷酸/.test(lower)) return 'exfoliant treatment';
  if (/benzoyl peroxide|过氧化苯甲酰/.test(lower)) return 'benzoyl peroxide treatment';
  if (/vitamin c|ascorbic|vc\b|维c/.test(lower)) return 'vitamin c serum';
  if (/serum|ampoule|booster|essence|精华/.test(lower)) return 'serum';
  if (/cream|lotion|balm|gel cream|面霜|乳液|保湿/.test(lower)) return 'moisturizer';
  return step === 'treatment' ? 'treatment' : step || 'other';
}

function inferLikelyRole(candidate, inferredProductType) {
  const slot = normalizeSlot(candidate && candidate.slot);
  if (inferredProductType === 'sunscreen' || inferredProductType === 'spf moisturizer') {
    return 'UV protection';
  }
  if (inferredProductType === 'cleanser') return 'cleansing';
  if (inferredProductType === 'moisturizer') return 'barrier support';
  if (inferredProductType === 'retinoid serum') return 'anti-aging treatment';
  if (inferredProductType === 'vitamin c serum') return 'brightening antioxidant support';
  if (inferredProductType === 'exfoliant treatment') return 'exfoliation';
  if (inferredProductType === 'benzoyl peroxide treatment') return 'acne treatment';
  if (slot === 'am') return 'daytime support';
  if (slot === 'pm') return 'night support';
  return 'general skincare support';
}

function inferKeySignals(candidate, inferredProductType) {
  const text = asString(candidate && candidate.product_text);
  const out = [];
  if (/retinol|retinal|retinoid/i.test(text)) out.push('retinoid signal');
  if (/aha|bha|salicylic|glycolic|lactic|mandelic|exfoliat/i.test(text)) out.push('exfoliant signal');
  if (/benzoyl peroxide/i.test(text)) out.push('benzoyl peroxide signal');
  if (/vitamin c|ascorbic|vc\b/i.test(text)) out.push('vitamin C signal');
  if (/ceramide/i.test(text)) out.push('ceramide signal');
  if (/hyaluronic|hyaluronate/i.test(text)) out.push('hydration signal');
  if (/niacinamide/i.test(text)) out.push('niacinamide signal');
  if (/spf|pa\+|uv|sunscreen/i.test(text) || inferredProductType === 'sunscreen') out.push('UV filter signal');
  if (/balm|repair cream|night cream|sleeping/i.test(text)) out.push('rich texture signal');
  if (!out.length && inferredProductType !== 'other') out.push(`${inferredProductType} signal`);
  return uniqStrings(out, 4);
}

function isStrongActiveType(type, text = '') {
  const token = String(type || '').toLowerCase();
  const lower = String(text || '').toLowerCase();
  return token.includes('retinoid')
    || token.includes('exfoliant')
    || token.includes('benzoyl')
    || /retinol|retinal|retinoid|aha|bha|salicylic|glycolic|mandelic|lactic|benzoyl peroxide|tretinoin|adapalene/i.test(lower);
}

function looksHeavyForDaytime(type, text = '') {
  const token = String(type || '').toLowerCase();
  const lower = String(text || '').toLowerCase();
  return token.includes('moisturizer')
    && /balm|sleeping|night cream|repair cream|rich cream|heavy cream|ointment/i.test(lower);
}

function goalVerdictForType(goal, inferredProductType) {
  const key = asString(goal).toLowerCase();
  const type = String(inferredProductType || '').toLowerCase();
  if (!key) return { verdict: 'unknown', reason: 'Goal was not provided.' };
  if (key.includes('wrinkle') || key.includes('aging') || key.includes('fine line')) {
    if (type.includes('retinoid')) return { verdict: 'good', reason: 'Retinoid-like products usually align with wrinkle-focused goals.' };
    if (type === 'sunscreen') return { verdict: 'good', reason: 'Daily UV protection supports long-term wrinkle prevention.' };
    if (type.includes('moisturizer') || type.includes('serum')) return { verdict: 'mixed', reason: 'Supportive hydration can help, but this is not a primary wrinkle treatment.' };
    return { verdict: 'unknown', reason: 'Goal fit is unclear from the available product signals.' };
  }
  if (key.includes('dehydrat') || key.includes('hydrat') || key.includes('dry')) {
    if (type.includes('moisturizer') || type.includes('essence') || type.includes('serum')) {
      return { verdict: 'good', reason: 'Hydrating or barrier-support steps usually align with dehydration goals.' };
    }
    if (type.includes('cleanser')) return { verdict: 'mixed', reason: 'Cleanser fit depends on how stripping the formula is.' };
    if (isStrongActiveType(type)) return { verdict: 'mixed', reason: 'Strong actives can help some goals but may worsen dehydration if the routine is already drying.' };
    return { verdict: 'unknown', reason: 'Hydration fit is unclear from the available product signals.' };
  }
  if (key.includes('acne') || key.includes('breakout') || key.includes('blemish')) {
    if (type.includes('benzoyl') || type.includes('exfoliant')) return { verdict: 'good', reason: 'This looks like a direct acne-treatment step.' };
    if (type === 'sunscreen') return { verdict: 'mixed', reason: 'Daily sunscreen matters, but it is not a direct breakout treatment.' };
    return { verdict: 'unknown', reason: 'Acne fit is unclear from the available product signals.' };
  }
  if (key.includes('barrier') || key.includes('sensitive') || key.includes('redness')) {
    if (type.includes('moisturizer') || type === 'cleanser') return { verdict: 'good', reason: 'Barrier-support basics usually align with sensitivity-focused goals.' };
    if (isStrongActiveType(type)) return { verdict: 'poor', reason: 'This looks like a stronger active that may need caution for sensitive-barrier goals.' };
    return { verdict: 'unknown', reason: 'Barrier fit is unclear from the available product signals.' };
  }
  return { verdict: 'unknown', reason: 'No deterministic goal mapping was available.' };
}

function buildEvidenceBasis(candidate) {
  const basis = [];
  if (pickFirstTrimmed(candidate && candidate.resolved_display_name, candidate && candidate.resolved_name_or_null, candidate && candidate.resolved_name)) {
    basis.push('resolved_name');
  }
  if (asString(candidate && candidate.step)) basis.push('step_label');
  if (asString(candidate && candidate.brand)) basis.push('brand_signal');
  if (asString(candidate && candidate.inferred_product_type_hint)) basis.push('product_type_hint');
  if (asString(candidate && candidate.inci_hint)) basis.push('ingredient_hint');
  if (!basis.length) basis.push('unknown');
  return basis;
}

function inferInventoryStep(row) {
  const type = asString(row && row.inferred_product_type).toLowerCase();
  const step = normalizeStep(row && (row.original_step_label || row.step));
  const label = asString(row && (row.input_label || row.product_text)).toLowerCase();
  if (type.includes('sunscreen') || type === 'spf moisturizer' || step === 'sunscreen' || /(spf|sunscreen|uv)/i.test(label)) return 'sunscreen';
  if (type.includes('cleanser') || step === 'cleanser' || /(cleanser|cleanse|face wash|wash|洁面|洗面)/i.test(label)) return 'cleanser';
  if (type.includes('moisturizer') || step === 'moisturizer' || /(moistur|cream|lotion|balm|gel cream|乳液|面霜)/i.test(label)) return 'moisturizer';
  if (type.includes('serum') || type.includes('treatment') || type.includes('essence') || step === 'treatment' || step === 'toner' || step === 'essence') return 'treatment';
  return 'other';
}

function buildRoutineInventory(rows = []) {
  const inventory = {
    any: { sunscreen: false, cleanser: false, moisturizer: false, treatment: false },
    am: { sunscreen: false, cleanser: false, moisturizer: false, treatment: false },
    pm: { sunscreen: false, cleanser: false, moisturizer: false, treatment: false },
    total_count: 0,
  };
  for (const row of asArray(rows)) {
    if (!isPlainObject(row)) continue;
    inventory.total_count += 1;
    const step = inferInventoryStep(row);
    const slot = normalizeSlot(row.slot);
    if (!Object.prototype.hasOwnProperty.call(inventory.any, step)) continue;
    inventory.any[step] = true;
    if (slot === 'am' || slot === 'pm') inventory[slot][step] = true;
  }
  return inventory;
}

function resolveGapTiming(rawTiming, step, text) {
  const explicit = asString(rawTiming).toLowerCase();
  if (explicit === 'am' || explicit === 'pm' || explicit === 'either') return explicit;
  const lower = asString(text).toLowerCase();
  if (/(am and pm|pm and am|both am and pm|morning and night|morning and evening|both routines|both slots)/i.test(lower)) return 'both';
  if (/(^|\b)(am|morning|daytime)(\b|$)/i.test(lower)) return 'am';
  if (/(^|\b)(pm|night|evening)(\b|$)/i.test(lower)) return 'pm';
  if (step === 'sunscreen') return 'am';
  return 'either';
}

function inferGapReference(row = {}) {
  const text = [
    asString(row.title),
    asString(row.why_this_first),
    asString(row.reasoning),
    asString(row.why),
    asString(row.note),
    ...asArray(row.evidence),
  ].join(' ').trim();
  const targetStep = asString(row.target_step).toLowerCase();
  let step = '';
  if (targetStep) {
    step = targetStep;
  } else if (/(spf|sunscreen|uv protection)/i.test(text)) {
    step = 'sunscreen';
  } else if (/(cleanser|cleanse|cleansing|face wash|wash)/i.test(text)) {
    step = 'cleanser';
  } else if (/(moisturizer|moisturis|moisturiz|cream|lotion|barrier cream|gel cream|balm)/i.test(text)) {
    step = 'moisturizer';
  } else if (/(serum|treatment|panthenol|peptide|hydrating|soothing)/i.test(text)) {
    step = 'serum';
  }
  return {
    step,
    timing: resolveGapTiming(row.timing, step, text),
    isGapLike:
      asString(row.action_type) === 'add_step'
      || asString(row.need_state) === 'fill_gap'
      || asString(row.issue_type) === 'gap'
      || /(missing|gap|lack|add\b|need\b)/i.test(text),
  };
}

function inventoryHasStep(inventory, step, timing = 'either') {
  const slotMap = isPlainObject(inventory) ? inventory : {};
  if (!step || !isPlainObject(slotMap.any)) return false;
  if (step === 'serum' || step === 'treatment') {
    if (timing === 'am') return Boolean(slotMap.am && slotMap.am.treatment);
    if (timing === 'pm') return Boolean(slotMap.pm && slotMap.pm.treatment);
    if (timing === 'both') return Boolean(slotMap.am && slotMap.am.treatment) && Boolean(slotMap.pm && slotMap.pm.treatment);
    return Boolean(slotMap.any && slotMap.any.treatment);
  }
  if (timing === 'am') return Boolean(slotMap.am && slotMap.am[step]);
  if (timing === 'pm') return Boolean(slotMap.pm && slotMap.pm[step]);
  if (timing === 'both') return Boolean(slotMap.am && slotMap.am[step]) && Boolean(slotMap.pm && slotMap.pm[step]);
  return Boolean(slotMap.any && slotMap.any[step]);
}

function isFalseGapReference(row, context = {}) {
  const inventory = isPlainObject(context && context.routine_inventory) ? context.routine_inventory : null;
  if (!inventory) return false;
  const ref = inferGapReference(row);
  if (!ref.isGapLike || !ref.step) return false;
  return inventoryHasStep(inventory, ref.step, ref.timing);
}

function containsEyeStepSignal(value) {
  const text = asString(value).toLowerCase();
  return /(eye product|eye cream|eye serum|eye gel|under[- ]?eye|under eye|dedicated eye|eye treatment|eye care)/i.test(text);
}

function isLowSignalOptionalAdjustment(item, context = {}) {
  const actionType = asString(item && item.action_type);
  if (actionType !== 'add_step') return false;
  if (containsEyeStepSignal(asString(item && item.title))) return true;
  const linkedNeeds = asArray(context && context.raw_recommendation_needs)
    .filter((need) => asString(need && need.adjustment_id) === asString(item && item.adjustment_id));
  if (linkedNeeds.some((need) => containsEyeStepSignal(asString(need && need.target_step)) || containsEyeStepSignal(asString(need && need.why)))) {
    return true;
  }
  return false;
}

function isCoreGuidanceStep(targetStep) {
  const token = asString(targetStep).toLowerCase();
  return token === 'sunscreen'
    || token === 'cleanser'
    || token === 'moisturizer'
    || token === 'spf moisturizer'
    || token === 'am sunscreen';
}

function buildFallbackProductAudit(candidate, context = {}) {
  const inputLabel = asString(candidate && candidate.product_text) || asString(candidate && candidate.product_url) || 'Unknown product';
  const inferredProductType = inferProductType(candidate);
  const likelyRole = inferLikelyRole(candidate, inferredProductType);
  const likelySignals = inferKeySignals(candidate, inferredProductType);
  const slot = normalizeSlot(candidate && candidate.slot);
  const step = normalizeStep(candidate && candidate.step);
  const goals = uniqStrings([...(asArray(context.goals)), ...(asArray(context.concerns))], 4);
  const productText = asString(candidate && candidate.product_text);
  const potentialConcerns = [];
  let suggestedAction = 'keep';

  if ((inferredProductType === 'sunscreen' || inferredProductType === 'spf moisturizer') && slot === 'pm') {
    suggestedAction = 'move_to_am';
    potentialConcerns.push('This looks like an AM protection step rather than a PM step.');
  } else if (isStrongActiveType(inferredProductType, productText) && slot === 'am') {
    suggestedAction = 'move_to_pm';
    potentialConcerns.push('This looks like a stronger active that is usually easier to manage at night.');
  } else if (looksHeavyForDaytime(inferredProductType, productText) && slot === 'am') {
    suggestedAction = 'move_to_pm';
    potentialConcerns.push('This texture signal looks heavy for daytime wear.');
  } else if (inferredProductType === 'other') {
    suggestedAction = 'unknown';
    potentialConcerns.push('The exact product type is still unclear from the provided label.');
  }

  if (context.sensitivity && String(context.sensitivity).toLowerCase() !== 'low' && isStrongActiveType(inferredProductType, productText)) {
    potentialConcerns.push('Sensitivity context suggests this step may need slower onboarding or lower frequency.');
  }

  const fitForSkinType = (() => {
    if (context.sensitivity && String(context.sensitivity).toLowerCase() !== 'low' && isStrongActiveType(inferredProductType, productText)) {
      return {
        verdict: 'mixed',
        reason: 'This may fit, but the current sensitivity context suggests a more cautious cadence.',
      };
    }
    if (inferredProductType === 'cleanser' || inferredProductType === 'moisturizer' || inferredProductType === 'sunscreen') {
      return {
        verdict: 'good',
        reason: 'This product type is usually a core support step when the formula is tolerable.',
      };
    }
    return {
      verdict: inferredProductType === 'other' ? 'unknown' : 'mixed',
      reason: inferredProductType === 'other'
        ? 'The exact product type is unclear, so fit is still tentative.'
        : 'Fit depends on the exact formula strength and the rest of the routine.',
    };
  })();

  const fitForGoals = goals.map((goal) => ({
    goal,
    ...goalVerdictForType(goal, inferredProductType),
  }));

  const fitForSeasonOrClimate = {
    verdict: 'unknown',
    reason: context.season || context.climate
      ? 'Season or climate context was limited, so this is a tentative fit call.'
      : 'No explicit season or climate context was provided.',
  };

  const missingInfo = [];
  if (!pickFirstTrimmed(candidate && candidate.resolved_display_name, candidate && candidate.parsed_product_hint && candidate.parsed_product_hint.display_name)) {
    missingInfo.push('Exact SKU or full product name was not confirmed.');
  }
  if (!context.season && !context.climate) {
    missingInfo.push('Season or climate context is missing.');
  }

  const confidence = clampNumber(
    inferredProductType === 'other'
      ? 0.46
      : likelySignals.length > 1
        ? 0.72
        : 0.62,
    0,
    1,
    0.55,
  );

  const conciseReasoning = (() => {
    if (suggestedAction === 'move_to_am') {
      return 'This looks like a sunscreen-style product, so it makes more sense as an AM protection step than a PM step.';
    }
    if (suggestedAction === 'move_to_pm') {
      return isStrongActiveType(inferredProductType, productText)
        ? 'This reads like a stronger active, so PM placement is usually the safer first move for tolerability.'
        : 'The product label suggests a richer texture, so PM placement is a better fit than daytime use.';
    }
    if (suggestedAction === 'unknown') {
      return 'The product label is still too vague to make a precise slot recommendation, so this is a tentative category-level read.';
    }
    return 'This looks directionally usable in the current slot, with the biggest unknowns tied to exact formula version and strength.';
  })();

  return {
    product_ref: asString(candidate && candidate.product_ref),
    slot,
    original_step_label: step === 'other' ? null : step,
    input_label: inputLabel,
    resolved_name_or_null:
      pickFirstTrimmed(candidate && candidate.resolved_display_name, candidate && candidate.resolved_name) || null,
    evidence_basis: buildEvidenceBasis(candidate),
    inferred_product_type: inferredProductType,
    likely_role: likelyRole,
    likely_key_ingredients_or_signals: likelySignals,
    fit_for_skin_type: fitForSkinType,
    fit_for_goals: fitForGoals,
    fit_for_season_or_climate: fitForSeasonOrClimate,
    potential_concerns: uniqStrings(potentialConcerns, 5),
    suggested_action: suggestedAction,
    confidence,
    missing_info: uniqStrings(missingInfo, 5),
    concise_reasoning_en: conciseReasoning,
  };
}

function normalizeFallbackAuditOutput(auditedCandidates, rawOutput, context = {}) {
  const rawProducts = Array.isArray(rawOutput && rawOutput.products) ? rawOutput.products : [];
  const productsByRef = new Map(
    rawProducts
      .filter((row) => isPlainObject(row) && asString(row.product_ref))
      .map((row) => [asString(row.product_ref), row]),
  );
  const products = auditedCandidates.map((candidate) => {
    const fallback = buildFallbackProductAudit(candidate, context);
    const raw = productsByRef.get(fallback.product_ref);
    if (!isPlainObject(raw)) return fallback;
    return {
      ...fallback,
      slot: ['am', 'pm', 'unknown'].includes(asString(raw.slot)) ? asString(raw.slot) : fallback.slot,
      original_step_label: raw.original_step_label == null ? fallback.original_step_label : asString(raw.original_step_label) || null,
      input_label: asString(raw.input_label) || fallback.input_label,
      resolved_name_or_null: raw.resolved_name_or_null == null ? fallback.resolved_name_or_null : asString(raw.resolved_name_or_null) || null,
      evidence_basis: uniqStrings(raw.evidence_basis, 6).length ? uniqStrings(raw.evidence_basis, 6) : fallback.evidence_basis,
      inferred_product_type: asString(raw.inferred_product_type) || fallback.inferred_product_type,
      likely_role: asString(raw.likely_role) || fallback.likely_role,
      likely_key_ingredients_or_signals: uniqStrings(raw.likely_key_ingredients_or_signals, 6).length
        ? uniqStrings(raw.likely_key_ingredients_or_signals, 6)
        : fallback.likely_key_ingredients_or_signals,
      fit_for_skin_type: isPlainObject(raw.fit_for_skin_type) ? {
        verdict: ['good', 'mixed', 'poor', 'unknown'].includes(asString(raw.fit_for_skin_type.verdict)) ? asString(raw.fit_for_skin_type.verdict) : fallback.fit_for_skin_type.verdict,
        reason: asString(raw.fit_for_skin_type.reason) || fallback.fit_for_skin_type.reason,
      } : fallback.fit_for_skin_type,
      fit_for_goals: Array.isArray(raw.fit_for_goals) && raw.fit_for_goals.length
        ? raw.fit_for_goals
          .map((row) => isPlainObject(row) ? {
            goal: asString(row.goal),
            verdict: ['good', 'mixed', 'poor', 'unknown'].includes(asString(row.verdict)) ? asString(row.verdict) : 'unknown',
            reason: asString(row.reason),
          } : null)
          .filter(Boolean)
        : fallback.fit_for_goals,
      fit_for_season_or_climate: isPlainObject(raw.fit_for_season_or_climate) ? {
        verdict: ['good', 'mixed', 'poor', 'unknown'].includes(asString(raw.fit_for_season_or_climate.verdict)) ? asString(raw.fit_for_season_or_climate.verdict) : fallback.fit_for_season_or_climate.verdict,
        reason: asString(raw.fit_for_season_or_climate.reason) || fallback.fit_for_season_or_climate.reason,
      } : fallback.fit_for_season_or_climate,
      potential_concerns: uniqStrings(raw.potential_concerns, 6).length ? uniqStrings(raw.potential_concerns, 6) : fallback.potential_concerns,
      suggested_action: ['keep', 'move_to_am', 'move_to_pm', 'reduce_frequency', 'replace', 'remove', 'unknown'].includes(asString(raw.suggested_action))
        ? asString(raw.suggested_action)
        : fallback.suggested_action,
      confidence: clampNumber(raw.confidence, 0, 1, fallback.confidence),
      missing_info: uniqStrings(raw.missing_info, 6).length ? uniqStrings(raw.missing_info, 6) : fallback.missing_info,
      concise_reasoning_en: asString(raw.concise_reasoning_en) || fallback.concise_reasoning_en,
    };
  });

  const additionalItems = Array.isArray(rawOutput && rawOutput.additional_items_needing_verification)
    ? rawOutput.additional_items_needing_verification
      .map((row) => isPlainObject(row) ? {
        input_label: asString(row.input_label),
        reason: asString(row.reason),
      } : null)
      .filter((row) => row && row.input_label && row.reason)
    : [];

  return {
    schema_version: 'aurora.routine_product_audit.v1',
    products,
    additional_items_needing_verification: additionalItems,
    missing_info: uniqStrings(rawOutput && rawOutput.missing_info, 8),
    confidence: clampNumber(rawOutput && rawOutput.confidence, 0, 1, averageConfidence(products)),
  };
}

function averageConfidence(products) {
  const list = asArray(products).map((row) => clampNumber(row && row.confidence, 0, 1, 0)).filter((value) => value > 0);
  if (!list.length) return 0.55;
  return Number((list.reduce((sum, value) => sum + value, 0) / list.length).toFixed(3));
}

function stepRankForOrder(type) {
  const token = String(type || '').toLowerCase();
  if (token === 'cleanser') return 10;
  if (token === 'toner') return 20;
  if (token === 'essence') return 30;
  if (token.includes('serum') || token.includes('treatment') || token.includes('vitamin c') || token.includes('retinoid') || token.includes('exfoliant')) return 40;
  if (token.includes('moisturizer')) return 50;
  if (token.includes('sunscreen') || token === 'spf moisturizer') return 60;
  return 90;
}

function buildDefaultOrder(products, slot) {
  return asArray(products)
    .filter((product) => normalizeSlot(product && product.slot) === slot)
    .slice()
    .sort((left, right) => {
      const rankDiff = stepRankForOrder(left && left.inferred_product_type) - stepRankForOrder(right && right.inferred_product_type);
      if (rankDiff !== 0) return rankDiff;
      return asString(left && left.product_ref).localeCompare(asString(right && right.product_ref));
    })
    .map((product, index) => ({
      product_ref: asString(product.product_ref),
      input_label: asString(product.input_label),
      recommended_order: index + 1,
      why_here: buildOrderReason(product),
    }));
}

function buildOrderReason(product) {
  const type = String(product && product.inferred_product_type || '').toLowerCase();
  if (type === 'cleanser') return 'Cleanser comes first to reset the skin before leave-on steps.';
  if (type.includes('toner') || type.includes('essence')) return 'This reads like a lighter prep layer, so it sits before heavier leave-on steps.';
  if (type.includes('serum') || type.includes('treatment') || type.includes('retinoid') || type.includes('vitamin c') || type.includes('exfoliant')) {
    return 'Treatment-style steps usually sit after lighter hydration and before moisturizer.';
  }
  if (type.includes('moisturizer')) return 'Moisturizer should seal in lighter treatment layers.';
  if (type.includes('sunscreen') || type === 'spf moisturizer') return 'Sunscreen belongs at the end of the AM routine.';
  return 'This placement follows a light-to-heavy routine order.';
}

function buildDeterministicOverlapOrGaps(auditOutput, context = {}) {
  const products = asArray(auditOutput && auditOutput.products);
  const issues = [];
  const amProducts = products.filter((product) => product.slot === 'am');
  const pmProducts = products.filter((product) => product.slot === 'pm');
  const inventory = isPlainObject(context && context.routine_inventory)
    ? context.routine_inventory
    : buildRoutineInventory(products);
  const amHasSpf = inventoryHasStep(inventory, 'sunscreen', 'am')
    || amProducts.some((product) => String(product.inferred_product_type || '').toLowerCase().includes('sunscreen') || String(product.inferred_product_type || '').toLowerCase() === 'spf moisturizer');
  if (!amHasSpf) {
    issues.push({
      issue_type: 'gap',
      title: 'AM protection looks missing',
      evidence: ['No current AM product clearly reads as sunscreen or SPF coverage.'],
      affected_products: [],
    });
  }

  const pmStrongActives = pmProducts.filter((product) => isStrongActiveType(product.inferred_product_type, product.input_label));
  if (pmStrongActives.length > 1) {
    issues.push({
      issue_type: 'overlap',
      title: 'Strong active load may be stacked too heavily',
      evidence: pmStrongActives.map((product) => `${product.input_label} looks like a stronger active in PM.`).slice(0, 4),
      affected_products: pmStrongActives.map((product) => product.product_ref),
    });
  }

  const moveIssues = products
    .filter((product) => ['move_to_am', 'move_to_pm'].includes(asString(product.suggested_action)))
    .slice(0, 3);
  for (const product of moveIssues) {
    issues.push({
      issue_type: 'order_problem',
      title: `${product.input_label} looks better in ${product.suggested_action === 'move_to_am' ? 'AM' : 'PM'}`,
      evidence: [product.concise_reasoning_en],
      affected_products: [product.product_ref],
    });
  }

  if (!issues.length) {
    issues.push({
      issue_type: 'goal_mismatch',
      title: 'The routine is usable, but goal fit still depends on a few product details',
      evidence: ['Some products are still being judged at category level because exact SKU or formula details are unclear.'],
      affected_products: products.slice(0, 2).map((product) => product.product_ref),
    });
  }

  return issues.slice(0, 6);
}

function normalizeNeedState(actionType) {
  if (actionType === 'add_step') return 'fill_gap';
  if (actionType === 'replace' || actionType === 'swap_step') return 'replace_current';
  return 'upgrade_existing';
}

function buildDeterministicSynthesis(auditOutput, context = {}) {
  const products = asArray(auditOutput && auditOutput.products);
  const amOrder = buildDefaultOrder(products, 'am');
  const pmOrder = buildDefaultOrder(products, 'pm');
  const overlapOrGaps = buildDeterministicOverlapOrGaps(auditOutput, context);
  const adjustments = [];

  for (const product of products) {
    const action = asString(product.suggested_action);
    if (action === 'keep' || action === 'unknown') continue;
    adjustments.push({
      adjustment_id: `adj_${asString(product.product_ref) || crypto.randomUUID().slice(0, 8)}`,
      priority_rank: adjustments.length + 1,
      title: action === 'move_to_am'
        ? `Move ${product.input_label} to AM`
        : action === 'move_to_pm'
          ? `Move ${product.input_label} to PM`
          : action === 'reduce_frequency'
            ? `Reduce ${product.input_label} frequency`
            : action === 'remove'
              ? `Remove ${product.input_label}`
              : `Replace ${product.input_label}`,
      action_type: action === 'move_to_am' || action === 'move_to_pm' ? 'move' : action,
      affected_products: [product.product_ref],
      why_this_first: product.concise_reasoning_en,
      expected_outcome: action === 'reduce_frequency'
        ? 'Lower irritation or routine overload risk.'
        : action === 'replace'
          ? 'Better goal fit with less friction in the current routine.'
          : 'A cleaner AM/PM split with less routine mismatch.',
    });
    if (adjustments.length >= 3) break;
  }

  if (adjustments.length < 3 && overlapOrGaps.some((issue) => issue.issue_type === 'gap') && !inventoryHasStep(context && context.routine_inventory, 'sunscreen', 'am')) {
    adjustments.push({
      adjustment_id: 'adj_add_spf_gap',
      priority_rank: adjustments.length + 1,
      title: 'Add a clear AM sunscreen step',
      action_type: 'add_step',
      affected_products: [],
      why_this_first: 'AM protection looks missing, so the routine is exposed before any higher-order optimization matters.',
      expected_outcome: 'Better daytime protection and a more complete AM routine.',
    });
  }

  const improvedAm = buildImprovedRoutine(products, 'am', adjustments);
  const improvedPm = buildImprovedRoutine(products, 'pm', adjustments);
  const recommendationNeeds = adjustments
    .filter((item) => item.action_type === 'replace' || item.action_type === 'add_step' || item.action_type === 'swap_step')
    .map((item) => {
      const affected = products.find((product) => item.affected_products.includes(product.product_ref));
      const targetStep = affected ? normalizeRecommendedStep(affected.inferred_product_type, item.action_type) : 'sunscreen';
      return {
        adjustment_id: item.adjustment_id,
        need_state: normalizeNeedState(item.action_type),
        target_step: targetStep,
        why: item.why_this_first,
        required_attributes: buildRequiredAttributes(item, affected, context),
        avoid_attributes: buildAvoidAttributes(item, affected, context),
        timing: targetStep === 'sunscreen' ? 'am' : affected && affected.slot === 'pm' ? 'pm' : 'either',
        texture_or_format: inferTextureOrFormat(affected),
        priority: item.priority_rank === 1 ? 'high' : item.priority_rank === 2 ? 'medium' : 'low',
      };
    })
    .slice(0, 3);
  const recommendationQueries = recommendationNeeds.map((need) => ({
    adjustment_id: need.adjustment_id,
    query_en: buildRecommendationQuery(need, context),
  }));

  return {
    schema_version: 'aurora.routine_synthesis.v1',
    current_routine_assessment: {
      summary: buildAssessmentSummary(adjustments, overlapOrGaps),
      main_strengths: buildMainStrengths(products),
      main_issues: buildMainIssues(adjustments, overlapOrGaps),
    },
    per_step_order_am: amOrder,
    per_step_order_pm: pmOrder,
    overlap_or_gaps: overlapOrGaps,
    top_3_adjustments: adjustments.slice(0, 3),
    improved_am_routine: improvedAm,
    improved_pm_routine: improvedPm,
    rationale_for_each_adjustment: adjustments.slice(0, 3).map((item) => ({
      adjustment_id: item.adjustment_id,
      reasoning: item.why_this_first,
      evidence: collectAdjustmentEvidence(item, products, overlapOrGaps),
      tradeoff_or_caution: item.action_type === 'add_step'
        ? 'A new step only helps if it is consistent with the rest of the routine.'
        : 'Keep changes minimal at first so you can see which adjustment actually helps.',
    })),
    recommendation_needs: recommendationNeeds,
    recommendation_queries: recommendationQueries,
    confidence: clampNumber(auditOutput && auditOutput.confidence, 0, 1, 0.62),
    missing_info: uniqStrings(auditOutput && auditOutput.missing_info, 8),
  };
}

function buildAssessmentSummary(adjustments, overlapOrGaps) {
  const topAdjustment = asArray(adjustments)[0];
  if (topAdjustment) {
    return `The routine is usable, but the clearest first fix is "${topAdjustment.title}" because it addresses the biggest current mismatch.`;
  }
  const topIssue = asArray(overlapOrGaps)[0];
  if (topIssue) {
    return `The routine is directionally okay, but "${topIssue.title}" is still the main thing limiting fit right now.`;
  }
  return 'The routine is broadly usable, but a few product details are still tentative.';
}

function buildMainStrengths(products) {
  const strengths = [];
  const list = asArray(products);
  if (list.some((product) => String(product.inferred_product_type || '').toLowerCase().includes('moisturizer'))) {
    strengths.push('There is at least one moisturizer-style support step already in the routine.');
  }
  if (list.some((product) => String(product.inferred_product_type || '').toLowerCase().includes('sunscreen'))) {
    strengths.push('There is already an AM protection signal in the current product set.');
  }
  if (list.some((product) => isStrongActiveType(product.inferred_product_type, product.input_label))) {
    strengths.push('The routine already includes at least one treatment-oriented step.');
  }
  if (!strengths.length) strengths.push('The current product list is concise enough to simplify without a full reset.');
  return strengths.slice(0, 3);
}

function buildMainIssues(adjustments, overlapOrGaps) {
  const issues = [];
  for (const item of asArray(adjustments)) {
    if (!asString(item.title)) continue;
    issues.push(item.title);
    if (issues.length >= 3) break;
  }
  for (const item of asArray(overlapOrGaps)) {
    if (!asString(item.title) || issues.includes(item.title)) continue;
    issues.push(item.title);
    if (issues.length >= 3) break;
  }
  return issues;
}

function collectAdjustmentEvidence(adjustment, products, issues) {
  const out = [];
  for (const ref of asArray(adjustment && adjustment.affected_products)) {
    const product = asArray(products).find((row) => asString(row.product_ref) === asString(ref));
    if (product && asString(product.concise_reasoning_en)) out.push(asString(product.concise_reasoning_en));
  }
  for (const issue of asArray(issues)) {
    if (!asArray(issue.affected_products).some((ref) => asArray(adjustment && adjustment.affected_products).includes(ref))) continue;
    out.push(...uniqStrings(issue.evidence, 2));
  }
  return uniqStrings(out, 4);
}

function normalizeRecommendedStep(inferredProductType, actionType) {
  const token = String(inferredProductType || '').toLowerCase();
  if (actionType === 'add_step') return 'sunscreen';
  if (token.includes('sunscreen') || token === 'spf moisturizer') return 'sunscreen';
  if (token.includes('moisturizer')) return 'moisturizer';
  if (token.includes('cleanser')) return 'cleanser';
  if (token.includes('serum') || token.includes('treatment') || token.includes('retinoid') || token.includes('vitamin c') || token.includes('exfoliant')) return 'serum';
  return 'treatment';
}

function buildRequiredAttributes(adjustment, product, context = {}) {
  const attributes = [];
  if (product) {
    const type = String(product.inferred_product_type || '').toLowerCase();
    if (type.includes('sunscreen')) attributes.push('broad-spectrum daily UV protection');
    if (type.includes('moisturizer')) attributes.push('barrier-supportive hydration');
    if (type.includes('retinoid')) attributes.push('beginner-tolerable retinoid texture');
    if (type.includes('exfoliant')) attributes.push('controlled exfoliation strength');
  }
  if (asString(context.sensitivity).toLowerCase() !== 'low') attributes.push('sensitive-skin-friendly finish');
  if (!attributes.length && adjustment && adjustment.action_type === 'add_step') attributes.push('clear fit for the missing routine step');
  return uniqStrings(attributes, 5);
}

function buildAvoidAttributes(adjustment, product, context = {}) {
  const attributes = [];
  if (product && isStrongActiveType(product.inferred_product_type, product.input_label)) {
    attributes.push('overly strong first-use actives');
  }
  if (asString(context.sensitivity).toLowerCase() !== 'low') {
    attributes.push('high fragrance or obvious sting-prone formulas');
  }
  if (adjustment && adjustment.action_type === 'add_step' && asString(adjustment.title).toLowerCase().includes('sunscreen')) {
    attributes.push('unclear SPF claims');
  }
  return uniqStrings(attributes, 5);
}

function inferTextureOrFormat(product) {
  if (!product) return null;
  const label = asString(product.input_label).toLowerCase();
  if (label.includes('gel')) return 'gel';
  if (label.includes('cream')) return 'cream';
  if (label.includes('fluid')) return 'fluid';
  if (label.includes('serum')) return 'serum';
  return null;
}

function buildRecommendationQuery(need, context = {}) {
  const tokens = [
    asString(need.target_step),
    ...uniqStrings(need.required_attributes, 3),
    ...(asString(context.skinType) ? [asString(context.skinType)] : []),
    ...(asString(context.sensitivity) ? [asString(context.sensitivity)] : []),
    ...(asArray(context.goals).length ? [asString(asArray(context.goals)[0])] : []),
  ].filter(Boolean);
  return uniqStrings(tokens, 8).join(' ');
}

function buildImprovedRoutine(products, slot, adjustments) {
  const base = buildDefaultOrder(products, slot).map((row) => ({
    step_order: row.recommended_order,
    what_to_use: row.input_label,
    frequency: 'as currently tolerated',
    note: row.why_here,
    source_type: 'existing_product',
  }));
  if (!base.length && slot === 'pm') {
    return [];
  }
  const hasMissingSpfAdjustment = asArray(adjustments).some((item) => item.action_type === 'add_step' && asString(item.title).toLowerCase().includes('sunscreen'));
  if (slot === 'am' && hasMissingSpfAdjustment) {
    base.push({
      step_order: base.length + 1,
      what_to_use: 'Add a clear sunscreen step',
      frequency: 'daily',
      note: 'This is the main missing AM step from the current routine.',
      source_type: 'step_placeholder',
    });
  }
  return base.slice(0, 8);
}

function buildSeasonClimateContext(profile, profileSummary) {
  const row = isPlainObject(profile) ? profile : {};
  const summary = isPlainObject(profileSummary) ? profileSummary : {};
  return {
    season: pickFirstTrimmed(row.season, row.current_season, summary.season) || null,
    climate: pickFirstTrimmed(row.climate, row.environment, summary.climate) || null,
    humidity: pickFirstTrimmed(row.humidity, summary.humidity) || null,
    uv_level: pickFirstTrimmed(row.uv_level, row.uvLevel, summary.uv_level) || null,
  };
}

function buildProfileContext(profile, profileSummary) {
  const row = isPlainObject(profile) ? profile : {};
  const summary = isPlainObject(profileSummary) ? profileSummary : {};
  const skinType = pickFirstTrimmed(summary.skinType, row.skin_type, row.skinType) || null;
  const sensitivity = pickFirstTrimmed(summary.sensitivity, row.sensitivity) || null;
  const barrierStatus = pickFirstTrimmed(summary.barrierStatus, row.barrier_status, row.barrierStatus) || null;
  return {
    skin_type: skinType,
    sensitivity,
    barrier_status: barrierStatus,
  };
}

function buildGoalContext(profile, profileSummary) {
  const row = isPlainObject(profile) ? profile : {};
  const summary = isPlainObject(profileSummary) ? profileSummary : {};
  const goals = uniqStrings([
    ...asArray(summary.goals),
    ...asArray(summary.concerns),
    ...asArray(row.goals),
    ...asArray(row.concerns),
  ], 6);
  return {
    goals,
    primary_goals: goals.slice(0, 3),
  };
}

function scoreCandidatePriority(candidate, goalContext = {}) {
  const text = asString(candidate && candidate.product_text).toLowerCase();
  const type = inferProductType(candidate);
  let bucket = 60;
  if (type === 'sunscreen' || type === 'spf moisturizer') bucket = 10;
  else if (isStrongActiveType(type, text)) bucket = 20;
  else if (type === 'serum' || type === 'vitamin c serum' || type === 'essence') bucket = 30;
  else if (type === 'moisturizer') bucket = 40;
  else if (type === 'cleanser') bucket = 50;

  const unresolvedRisk = pickFirstTrimmed(candidate && candidate.product_url, candidate && candidate.inci_hint) ? 0 : 1;
  const goalTerms = uniqStrings(goalContext && goalContext.goals, 6).join(' ').toLowerCase();
  const goalRelevance = goalTerms && text ? (goalTerms.includes('wrinkle') && /retinol|retinoid|peptide|spf/.test(text))
    || (goalTerms.includes('dehydrat') && /cream|hydrat|ceramide|hyaluronic|moistur/.test(text))
      ? 0
      : 1
    : 1;
  const dayNightMismatch = normalizeSlot(candidate && candidate.slot) === 'am' && (isStrongActiveType(type, text) || looksHeavyForDaytime(type, text)) ? 0 : 1;
  return {
    bucket,
    unresolvedRisk,
    goalRelevance,
    dayNightMismatch,
    originalRank: Number.isFinite(Number(candidate && candidate.rank)) ? Math.trunc(Number(candidate.rank)) : 999,
  };
}

function prioritizeRoutineCandidates(routineProductCandidates, goalContext = {}) {
  const all = asArray(routineProductCandidates).map((candidate, index) => {
    const row = isPlainObject(candidate) ? { ...candidate } : {};
    const slot = normalizeSlot(row.slot);
    const step = normalizeStep(row.step);
    const productRef = `routine_${slot}_${String(index + 1).padStart(2, '0')}`;
    const priority = scoreCandidatePriority(row, goalContext);
    return {
      ...row,
      slot,
      step,
      product_ref: productRef,
      _priority: priority,
      _original_index: index,
    };
  });

  if (all.length <= 8) {
    return { audited: all, additional: [] };
  }

  const chosen = all
    .slice()
    .sort((left, right) => {
      const fields = ['bucket', 'unresolvedRisk', 'goalRelevance', 'dayNightMismatch', 'originalRank'];
      for (const field of fields) {
        const diff = Number(left._priority[field]) - Number(right._priority[field]);
        if (diff !== 0) return diff;
      }
      return left._original_index - right._original_index;
    })
    .slice(0, 8)
    .map((item) => item.product_ref);
  const chosenSet = new Set(chosen);
  const audited = all.filter((item) => chosenSet.has(item.product_ref)).sort((left, right) => left._original_index - right._original_index);
  const additional = all.filter((item) => !chosenSet.has(item.product_ref)).sort((left, right) => left._original_index - right._original_index);
  return { audited, additional };
}

let gatewaySingleton = null;

function createGateway() {
  return new LlmGateway({
    stubResponses: String(process.env.AURORA_CHAT_V2_STUB_RESPONSES || '').trim().toLowerCase() === 'true',
  });
}

function getGateway() {
  if (!gatewaySingleton) gatewaySingleton = createGateway();
  return gatewaySingleton;
}

function computeStageOutputBudget(stage, auditedCount) {
  const count = Math.max(0, Number(auditedCount) || 0);
  if (stage === 'stage_a') {
    if (count <= 5) return 2800;
    return Math.min(4200, 2800 + ((count - 5) * 150));
  }
  if (count <= 5) return 2200;
  return Math.min(3400, 2200 + ((count - 5) * 120));
}

async function resolveRecommendationGroups({
  recommendationNeeds,
  recommendationQueries,
  context,
  logger = null,
  deps = {},
} = {}) {
  const needs = asArray(recommendationNeeds)
    .map((need) => isPlainObject(need) ? need : null)
    .filter(Boolean);
  const queryByAdjustment = new Map(
    asArray(recommendationQueries)
      .map((row) => isPlainObject(row) ? [asString(row.adjustment_id), asString(row.query_en)] : null)
      .filter(Boolean),
  );

  const groups = [];
  for (const need of needs) {
    const adjustmentId = asString(need.adjustment_id);
    if (!adjustmentId) continue;
    const query = queryByAdjustment.get(adjustmentId) || buildRecommendationQuery(need, context);
    const candidateOutput = {
      answer_en: query,
      products: [
        {
          name: query,
          product_type: asString(need.target_step) || 'serum',
          why: { en: asString(need.why) || 'Bound to a routine adjustment need.' },
          suitability_score: 0.78,
          price_tier: null,
          search_aliases: uniqStrings([
            query,
            `${asString(need.target_step)} ${uniqStrings(need.required_attributes, 2).join(' ')}`.trim(),
          ], 4),
        },
      ],
    };
    let resolved = null;
    try {
      resolved = await runRecoHybridResolveCandidates({
        request: {
          context: {
            locale: context && context.language === 'CN' ? 'zh-CN' : 'en-US',
            profile: {
              concerns: uniqStrings(context && context.goals, 4),
              goals: uniqStrings(context && context.goals, 4),
            },
          },
          params: {
            target_step: asString(need.target_step) || null,
            _extracted_concerns: uniqStrings(context && context.goals, 4),
          },
        },
        candidateOutput,
        logger,
        deps,
      });
    } catch (error) {
      logger && logger.warn && logger.warn({ err: error && error.message ? error.message : String(error), adjustment_id: adjustmentId }, 'routine analysis v2: recommendation resolve failed');
    }

    const candidatePool = asArray(resolved && resolved.rows)
      .filter((row) => {
        if (!isPlainObject(row)) return false;
        const matchState = asString(row.match_state).toLowerCase();
        if (matchState === 'exact' || matchState === 'fuzzy') return true;
        if (asString(row.product_id) || asString(row.canonical_product_ref) || asString(row.subject_product_group_id)) return true;
        const pdpOpen = isPlainObject(row.pdp_open) ? row.pdp_open : null;
        const path = asString(pdpOpen && pdpOpen.path).toLowerCase();
        return path === 'ref' || path === 'group';
      })
      .slice(0, 3);
    const categoryGuidance = buildCategoryGuidance(need, context);
    groups.push({
      adjustment_id: adjustmentId,
      need_state: asString(need.need_state) || 'upgrade_existing',
      target_step: asString(need.target_step) || 'serum',
      timing: asString(need.timing) || 'either',
      why: asString(need.why),
      required_attributes: uniqStrings(need.required_attributes, 5),
      avoid_attributes: uniqStrings(need.avoid_attributes, 5),
      candidate_pool_source: candidatePool.length ? 'reco_hybrid_search' : 'guidance_only',
      candidate_pool: candidatePool,
      category_guidance: candidatePool.length ? categoryGuidance : categoryGuidance,
      unresolved_reason: candidatePool.length ? null : 'no_grounded_candidates',
      recommendation_query: query,
    });
  }
  return groups;
}

function buildCategoryGuidance(need, context = {}) {
  const targetStep = asString(need && need.target_step) || 'step';
  const requiredAttributes = uniqStrings(need && need.required_attributes, 4);
  const avoidAttributes = uniqStrings(need && need.avoid_attributes, 4);
  const note = targetStep === 'sunscreen'
    ? 'Prioritize a clearly wearable AM sunscreen before adding more treatment complexity.'
    : `Prioritize a ${targetStep} that solves this adjustment without increasing routine friction.`;
  return {
    what_to_look_for: requiredAttributes.length ? requiredAttributes : ['clear fit for the missing step'],
    avoid: avoidAttributes,
    note,
    context_goal: uniqStrings(context && context.goals, 3),
  };
}

function sanitizeSynthesisOutput(synthesis, auditOutput, context = {}) {
  const products = asArray(auditOutput && auditOutput.products);
  const removedAdjustmentIds = new Set();
  const overlapOrGaps = asArray(synthesis && synthesis.overlap_or_gaps).filter((issue) => !isFalseGapReference(issue, context));
  const topAdjustments = asArray(synthesis && synthesis.top_3_adjustments)
    .filter((item) => {
      const shouldKeep = !isFalseGapReference(item, context) && !isLowSignalOptionalAdjustment(item, context);
      if (!shouldKeep && asString(item && item.adjustment_id)) removedAdjustmentIds.add(asString(item.adjustment_id));
      return shouldKeep;
    })
    .slice(0, 3)
    .map((item, index) => ({
      ...item,
      priority_rank: index + 1,
    }));
  const validAdjustmentIds = new Set(topAdjustments.map((item) => asString(item.adjustment_id)).filter(Boolean));
  const recommendationNeeds = asArray(synthesis && synthesis.recommendation_needs)
    .filter((need) => !removedAdjustmentIds.has(asString(need && need.adjustment_id)))
    .filter((need) => !isFalseGapReference(need, context))
    .filter((need) => !containsEyeStepSignal(asString(need && need.target_step)) && !containsEyeStepSignal(asString(need && need.why)))
    .filter((need) => validAdjustmentIds.has(asString(need && need.adjustment_id)));
  const validNeedIds = new Set(recommendationNeeds.map((item) => asString(item.adjustment_id)).filter(Boolean));
  const recommendationQueries = asArray(synthesis && synthesis.recommendation_queries)
    .filter((item) => validNeedIds.has(asString(item && item.adjustment_id)));
  const rationale = asArray(synthesis && synthesis.rationale_for_each_adjustment)
    .filter((item) => validAdjustmentIds.has(asString(item && item.adjustment_id)));
  const mainIssues = buildMainIssues(topAdjustments, overlapOrGaps);
  const summary = buildAssessmentSummary(topAdjustments, overlapOrGaps);
  return {
    ...synthesis,
    current_routine_assessment: {
      summary,
      main_strengths: uniqStrings(synthesis && synthesis.current_routine_assessment && synthesis.current_routine_assessment.main_strengths, 3).length
        ? uniqStrings(synthesis.current_routine_assessment.main_strengths, 3)
        : buildMainStrengths(products),
      main_issues: mainIssues,
    },
    overlap_or_gaps: overlapOrGaps,
    top_3_adjustments: topAdjustments,
    improved_am_routine: buildImprovedRoutine(products, 'am', topAdjustments),
    improved_pm_routine: buildImprovedRoutine(products, 'pm', topAdjustments),
    rationale_for_each_adjustment: rationale.length
      ? rationale
      : topAdjustments.map((item) => ({
        adjustment_id: item.adjustment_id,
        reasoning: item.why_this_first,
        evidence: collectAdjustmentEvidence(item, products, overlapOrGaps),
        tradeoff_or_caution: item.action_type === 'add_step'
          ? 'A new step only helps if it is consistent with the rest of the routine.'
          : 'Keep changes minimal at first so you can see which adjustment actually helps.',
      })),
    recommendation_needs: recommendationNeeds,
    recommendation_queries: recommendationQueries,
  };
}

function shouldDisplayRecommendationGroup(group, synthesis, context = {}) {
  const hasPool = asArray(group && group.candidate_pool).length > 0;
  if (hasPool) return true;
  if (!isPlainObject(group && group.category_guidance)) return false;
  const targetStep = asString(group && group.target_step).toLowerCase();
  const needState = asString(group && group.need_state);
  const adjustment = asArray(synthesis && synthesis.top_3_adjustments)
    .find((item) => asString(item && item.adjustment_id) === asString(group && group.adjustment_id));
  if (containsEyeStepSignal(targetStep) || containsEyeStepSignal(asString(group && group.why))) return false;
  if (needState === 'fill_gap' && isCoreGuidanceStep(targetStep) && !isFalseGapReference({ ...group, action_type: 'add_step' }, context)) {
    return true;
  }
  if (needState === 'replace_current' && adjustment) {
    const priorityRank = Number(adjustment.priority_rank) || 99;
    const actionType = asString(adjustment.action_type);
    const isStrongReplacement = ['replace', 'swap_step', 'remove'].includes(actionType);
    if (priorityRank === 1 && isStrongReplacement && (isCoreGuidanceStep(targetStep) || targetStep === 'serum' || targetStep === 'treatment')) {
      return true;
    }
  }
  if (isFalseGapReference({ ...group, action_type: 'add_step' }, context)) return false;
  return false;
}

function getVisibleRecommendationGroups(recommendationGroups, synthesis, context = {}) {
  return asArray(recommendationGroups).filter((group) => shouldDisplayRecommendationGroup(group, synthesis, context));
}

function buildLegacyCompatPayload(synthesis, recommendationGroups, context = {}) {
  const summary = asString(synthesis && synthesis.current_routine_assessment && synthesis.current_routine_assessment.summary);
  const highlights = uniqStrings(synthesis && synthesis.current_routine_assessment && synthesis.current_routine_assessment.main_strengths, 3);
  const concerns = uniqStrings(synthesis && synthesis.current_routine_assessment && synthesis.current_routine_assessment.main_issues, 3);
  const nextQuestions = uniqStrings(
    asArray(synthesis && synthesis.top_3_adjustments).map((item) => `How should I apply "${asString(item && item.title)}"?`),
    3,
  );
  const visibleRecommendationGroups = getVisibleRecommendationGroups(recommendationGroups, synthesis, context);
  return {
    summary,
    highlights,
    concerns,
    next_questions: nextQuestions,
    recommendation_cta_enabled: visibleRecommendationGroups.length > 0,
    source: 'routine_analysis_v2',
  };
}

function buildAssistantText(synthesis, language) {
  const isCn = normalizeLanguage(language) === 'CN';
  const top = asArray(synthesis && synthesis.top_3_adjustments)[0];
  const summary = asString(synthesis && synthesis.current_routine_assessment && synthesis.current_routine_assessment.summary);
  if (isCn) {
    if (top && asString(top.title)) {
      return `我先按你当前产品逐个看过了。现在最该先改的是「${asString(top.title)}」，因为它最直接影响这套 routine 的适配度。`;
    }
    return summary || '我已经先按你当前产品做了逐个审视，再给出组合级调整建议。';
  }
  if (top && asString(top.title)) {
    return `I reviewed each current product first. The best place to start is "${asString(top.title)}" because it drives the biggest routine mismatch right now.`;
  }
  return summary || 'I reviewed the current products first and then mapped the main routine-level adjustments.';
}

function buildCards({ audit, synthesis, recommendationGroups, additionalCandidates, language, requestId, context = {} }) {
  const visibleRecommendationGroups = getVisibleRecommendationGroups(recommendationGroups, synthesis, context);
  const unresolvedRecommendationNotes = visibleRecommendationGroups.length === 0
    ? asArray(synthesis && synthesis.recommendation_needs).map((need) => ({
      adjustment_id: asString(need && need.adjustment_id),
      note: 'Need identified, but no grounded product candidates are available yet.',
    })).filter((row) => row.adjustment_id)
    : [];
  const cards = [
    {
      card_id: `routine_product_audit_${requestId}`,
      type: 'routine_product_audit_v1',
      payload: {
        schema_version: 'aurora.routine_product_audit.card.v1',
        products: asArray(audit && audit.products),
        additional_items_needing_verification: additionalCandidates.map((item) => ({
          product_ref: asString(item.product_ref),
          input_label: asString(item.product_text),
          reason: 'Deferred because the routine exceeded the audited core-product limit.',
        })),
        missing_info: uniqStrings(audit && audit.missing_info, 8),
        confidence: clampNumber(audit && audit.confidence, 0, 1, 0.6),
      },
    },
    {
      card_id: `routine_adjustment_${requestId}`,
      type: 'routine_adjustment_plan_v1',
      payload: {
        schema_version: 'aurora.routine_adjustment_plan.card.v1',
        current_routine_assessment: synthesis.current_routine_assessment,
        per_step_order_am: synthesis.per_step_order_am,
        per_step_order_pm: synthesis.per_step_order_pm,
        overlap_or_gaps: synthesis.overlap_or_gaps,
        top_3_adjustments: synthesis.top_3_adjustments,
        improved_am_routine: synthesis.improved_am_routine,
        improved_pm_routine: synthesis.improved_pm_routine,
        rationale_for_each_adjustment: synthesis.rationale_for_each_adjustment,
        recommendation_needs: synthesis.recommendation_needs,
        unresolved_recommendation_notes: unresolvedRecommendationNotes,
        missing_info: synthesis.missing_info,
      },
    },
  ];
  if (visibleRecommendationGroups.length > 0) {
    cards.push({
      card_id: `routine_recommendation_${requestId}`,
      type: 'routine_recommendation_v1',
      payload: {
        schema_version: 'aurora.routine_recommendation.card.v1',
        recommendation_groups: visibleRecommendationGroups,
        missing_info: uniqStrings(
          visibleRecommendationGroups.flatMap((group) => group && group.unresolved_reason ? [group.unresolved_reason] : []),
          8,
        ),
      },
    });
  }

  return cards;
}

async function runRoutineAnalysisV2({
  requestId,
  language = 'EN',
  profile = null,
  profileSummary = null,
  routineProductCandidates = [],
  ingredientPlan = null,
  logger = null,
  llmGateway = null,
  recommendationResolverDeps = {},
} = {}) {
  const normalizedLanguage = normalizeLanguage(language);
  const profileContext = buildProfileContext(profile, profileSummary);
  const goalContext = buildGoalContext(profile, profileSummary);
  const seasonClimateContext = buildSeasonClimateContext(profile, profileSummary);
  const prioritized = prioritizeRoutineCandidates(routineProductCandidates, goalContext);
  const gateway = llmGateway || getGateway();
  const routineInventory = buildRoutineInventory(routineProductCandidates);
  const stageAInputProducts = prioritized.audited.map((candidate) => ({
    product_ref: candidate.product_ref,
    slot: normalizeSlot(candidate.slot),
    original_step_label: normalizeStep(candidate.step),
    input_label: asString(candidate.product_text),
    resolved_name_or_null: pickFirstTrimmed(candidate.parsed_product_hint && candidate.parsed_product_hint.display_name) || null,
    evidence_basis: buildEvidenceBasis(candidate),
    inferred_product_type_hint: inferProductType(candidate),
    parsed_product_hint: isPlainObject(candidate.parsed_product_hint) ? candidate.parsed_product_hint : null,
    inci_hint: asString(candidate.inci_hint) || null,
  }));
  const deterministicSignals = {
    product_count: prioritized.audited.length,
    total_routine_product_count: asArray(routineProductCandidates).length,
    selected_product_refs: prioritized.audited.map((item) => item.product_ref),
    deferred_product_refs: prioritized.additional.map((item) => item.product_ref),
    deferred_product_labels: prioritized.additional.map((item) => asString(item.product_text)).filter(Boolean).slice(0, 8),
    ingredient_plan_present: Boolean(ingredientPlan),
  };

  const stageABudget = computeStageOutputBudget('stage_a', prioritized.audited.length);
  let stageARaw = null;
  try {
    const result = await gateway.call({
      templateId: 'routine_product_audit_v1',
      taskMode: 'routine',
      params: {
        profile_context_json: profileContext,
        goal_context_json: goalContext,
        season_climate_context_json: seasonClimateContext,
        deterministic_signals_json: deterministicSignals,
        routine_products_json: stageAInputProducts,
      },
      schema: 'RoutineProductAuditOutput',
      maxOutputTokens: stageABudget,
    });
    stageARaw = result && result.parsed ? result.parsed : null;
  } catch (error) {
    logger && logger.warn && logger.warn({ err: error && error.message ? error.message : String(error) }, 'routine analysis v2: stage A failed, using fallback audit');
  }
  const audit = normalizeFallbackAuditOutput(prioritized.audited, stageARaw, {
    goals: goalContext.goals,
    concerns: goalContext.goals,
    sensitivity: profileContext.sensitivity,
    season: seasonClimateContext.season,
    climate: seasonClimateContext.climate,
  });

  const stageBBudget = computeStageOutputBudget('stage_b', audit.products.length);
  let stageBRaw = null;
  try {
    const result = await gateway.call({
      templateId: 'routine_synthesis_v1',
      taskMode: 'routine',
      params: {
        profile_context_json: profileContext,
        goal_context_json: goalContext,
        season_climate_context_json: seasonClimateContext,
        deterministic_signals_json: deterministicSignals,
        routine_products_json: stageAInputProducts,
        deferred_products_json: prioritized.additional.map((candidate) => ({
          product_ref: candidate.product_ref,
          slot: normalizeSlot(candidate.slot),
          original_step_label: normalizeStep(candidate.step),
          input_label: asString(candidate.product_text),
          inferred_product_type_hint: inferProductType(candidate),
        })),
        all_routine_products_json: prioritized.audited.concat(prioritized.additional).map((candidate) => ({
          product_ref: candidate.product_ref,
          slot: normalizeSlot(candidate.slot),
          original_step_label: normalizeStep(candidate.step),
          input_label: asString(candidate.product_text),
          inferred_product_type_hint: inferProductType(candidate),
        })),
        product_audit_json: audit,
        ingredient_plan_json: ingredientPlan || null,
      },
      schema: 'RoutineSynthesisOutput',
      maxOutputTokens: stageBBudget,
    });
    stageBRaw = result && result.parsed ? result.parsed : null;
  } catch (error) {
    logger && logger.warn && logger.warn({ err: error && error.message ? error.message : String(error) }, 'routine analysis v2: stage B failed, using deterministic synthesis');
  }
  const synthesis = coerceSynthesisOutput(stageBRaw, audit, {
    skinType: profileContext.skin_type,
    sensitivity: profileContext.sensitivity,
    goals: goalContext.goals,
    routine_inventory: routineInventory,
  });
  const recommendationGroups = await resolveRecommendationGroups({
    recommendationNeeds: synthesis.recommendation_needs,
    recommendationQueries: synthesis.recommendation_queries,
    context: {
      language: normalizedLanguage,
      skinType: profileContext.skin_type,
      sensitivity: profileContext.sensitivity,
      goals: goalContext.goals,
    },
    logger,
    deps: recommendationResolverDeps,
  });
  const cards = buildCards({
    audit,
    synthesis,
    recommendationGroups,
    additionalCandidates: prioritized.additional,
    language: normalizedLanguage,
    requestId,
    context: {
      routine_inventory: routineInventory,
    },
  });
  return {
    audit,
    synthesis,
    recommendation_groups: recommendationGroups,
    cards,
    assistant_text: buildAssistantText(synthesis, normalizedLanguage),
    legacy_compat: buildLegacyCompatPayload(synthesis, recommendationGroups, {
      routine_inventory: routineInventory,
    }),
    debug_meta: {
      schema_version: 'aurora.routine_analysis_v2.debug.v1',
      enabled: true,
      stage_a: {
        audited_product_count: audit.products.length,
        deferred_product_count: prioritized.additional.length,
        output_budget: stageABudget,
        confidence: audit.confidence,
      },
      stage_b: {
        adjustment_count: asArray(synthesis.top_3_adjustments).length,
        recommendation_need_count: asArray(synthesis.recommendation_needs).length,
        output_budget: stageBBudget,
        confidence: synthesis.confidence,
      },
      recommendation_groups: recommendationGroups.map((group) => ({
        adjustment_id: asString(group.adjustment_id),
        candidate_count: asArray(group.candidate_pool).length,
        guidance_only: asArray(group.candidate_pool).length === 0 && isPlainObject(group.category_guidance),
      })),
    },
    persist_payload: {
      product_audit: {
        products: audit.products,
        additional_items_needing_verification: audit.additional_items_needing_verification,
        confidence: audit.confidence,
      },
      routine_synthesis: {
        current_routine_assessment: synthesis.current_routine_assessment,
        top_3_adjustments: synthesis.top_3_adjustments,
        recommendation_needs: synthesis.recommendation_needs,
      },
    },
  };
}

function coerceSynthesisOutput(rawOutput, auditOutput, context = {}) {
  const fallback = buildDeterministicSynthesis(auditOutput, context);
  if (!isPlainObject(rawOutput)) return sanitizeSynthesisOutput(fallback, auditOutput, context);
  const normalizeImproved = (rows) => asArray(rows)
    .map((row) => isPlainObject(row) ? {
      step_order: Number.isFinite(Number(row.step_order)) ? Math.max(1, Math.trunc(Number(row.step_order))) : null,
      what_to_use: asString(row.what_to_use),
      frequency: asString(row.frequency),
      note: asString(row.note),
      source_type: ['existing_product', 'step_placeholder'].includes(asString(row.source_type)) ? asString(row.source_type) : 'existing_product',
    } : null)
    .filter((row) => row && row.step_order != null && row.what_to_use);
  const normalizeOrder = (rows) => asArray(rows)
    .map((row) => isPlainObject(row) ? {
      product_ref: asString(row.product_ref),
      input_label: asString(row.input_label),
      recommended_order: Number.isFinite(Number(row.recommended_order)) ? Math.max(1, Math.trunc(Number(row.recommended_order))) : null,
      why_here: asString(row.why_here),
    } : null)
    .filter((row) => row && row.product_ref && row.recommended_order != null);
  const normalizeAdjustments = (rows) => asArray(rows)
    .map((row) => isPlainObject(row) ? {
      adjustment_id: asString(row.adjustment_id),
      priority_rank: Number.isFinite(Number(row.priority_rank)) ? Math.max(1, Math.trunc(Number(row.priority_rank))) : null,
      title: asString(row.title),
      action_type: ['keep', 'move', 'reduce_frequency', 'replace', 'remove', 'add_step', 'swap_step'].includes(asString(row.action_type)) ? asString(row.action_type) : 'replace',
      affected_products: uniqStrings(row.affected_products, 6),
      why_this_first: asString(row.why_this_first),
      expected_outcome: asString(row.expected_outcome),
    } : null)
    .filter((row) => row && row.adjustment_id && row.priority_rank != null && row.title);
  const normalizeNeeds = (rows) => asArray(rows)
    .map((row) => isPlainObject(row) ? {
      adjustment_id: asString(row.adjustment_id),
      need_state: ['replace_current', 'fill_gap', 'upgrade_existing'].includes(asString(row.need_state)) ? asString(row.need_state) : 'upgrade_existing',
      target_step: asString(row.target_step),
      why: asString(row.why),
      required_attributes: uniqStrings(row.required_attributes, 6),
      avoid_attributes: uniqStrings(row.avoid_attributes, 6),
      timing: ['am', 'pm', 'either'].includes(asString(row.timing)) ? asString(row.timing) : 'either',
      texture_or_format: asString(row.texture_or_format) || null,
      priority: ['high', 'medium', 'low'].includes(asString(row.priority)) ? asString(row.priority) : 'medium',
    } : null)
    .filter((row) => row && row.adjustment_id && row.target_step);

  const topAdjustments = normalizeAdjustments(rawOutput.top_3_adjustments);
  const recommendationNeeds = normalizeNeeds(rawOutput.recommendation_needs);
  const recommendationQueries = asArray(rawOutput.recommendation_queries)
    .map((row) => isPlainObject(row) ? {
      adjustment_id: asString(row.adjustment_id),
      query_en: asString(row.query_en),
    } : null)
    .filter((row) => row && row.adjustment_id && row.query_en);

  const normalized = {
    schema_version: 'aurora.routine_synthesis.v1',
    current_routine_assessment: isPlainObject(rawOutput.current_routine_assessment) ? {
      summary: asString(rawOutput.current_routine_assessment.summary) || fallback.current_routine_assessment.summary,
      main_strengths: uniqStrings(rawOutput.current_routine_assessment.main_strengths, 3).length
        ? uniqStrings(rawOutput.current_routine_assessment.main_strengths, 3)
        : fallback.current_routine_assessment.main_strengths,
      main_issues: uniqStrings(rawOutput.current_routine_assessment.main_issues, 3).length
        ? uniqStrings(rawOutput.current_routine_assessment.main_issues, 3)
        : fallback.current_routine_assessment.main_issues,
    } : fallback.current_routine_assessment,
    per_step_order_am: normalizeOrder(rawOutput.per_step_order_am).length ? normalizeOrder(rawOutput.per_step_order_am) : fallback.per_step_order_am,
    per_step_order_pm: normalizeOrder(rawOutput.per_step_order_pm).length ? normalizeOrder(rawOutput.per_step_order_pm) : fallback.per_step_order_pm,
    overlap_or_gaps: asArray(rawOutput.overlap_or_gaps).length ? asArray(rawOutput.overlap_or_gaps)
      .map((row) => isPlainObject(row) ? {
        issue_type: ['overlap', 'gap', 'conflict', 'too_heavy', 'too_irritating', 'goal_mismatch', 'season_mismatch', 'order_problem'].includes(asString(row.issue_type)) ? asString(row.issue_type) : 'goal_mismatch',
        title: asString(row.title),
        evidence: uniqStrings(row.evidence, 4),
        affected_products: uniqStrings(row.affected_products, 6),
      } : null)
      .filter((row) => row && row.title) : fallback.overlap_or_gaps,
    top_3_adjustments: topAdjustments.length ? topAdjustments.slice(0, 3) : fallback.top_3_adjustments,
    improved_am_routine: normalizeImproved(rawOutput.improved_am_routine).length ? normalizeImproved(rawOutput.improved_am_routine) : fallback.improved_am_routine,
    improved_pm_routine: normalizeImproved(rawOutput.improved_pm_routine).length ? normalizeImproved(rawOutput.improved_pm_routine) : fallback.improved_pm_routine,
    rationale_for_each_adjustment: asArray(rawOutput.rationale_for_each_adjustment).length ? asArray(rawOutput.rationale_for_each_adjustment)
      .map((row) => isPlainObject(row) ? {
        adjustment_id: asString(row.adjustment_id),
        reasoning: asString(row.reasoning),
        evidence: uniqStrings(row.evidence, 4),
        tradeoff_or_caution: asString(row.tradeoff_or_caution),
      } : null)
      .filter((row) => row && row.adjustment_id && row.reasoning) : fallback.rationale_for_each_adjustment,
    recommendation_needs: recommendationNeeds,
    recommendation_queries: recommendationQueries.length ? recommendationQueries : fallback.recommendation_queries,
    confidence: clampNumber(rawOutput.confidence, 0, 1, fallback.confidence),
    missing_info: uniqStrings(rawOutput.missing_info, 8).length ? uniqStrings(rawOutput.missing_info, 8) : fallback.missing_info,
  };
  return sanitizeSynthesisOutput(normalized, auditOutput, context);
}

function __resetGatewayForTest() {
  gatewaySingleton = null;
}

module.exports = {
  runRoutineAnalysisV2,
  prioritizeRoutineCandidates,
  computeStageOutputBudget,
  resolveRecommendationGroups,
  buildCategoryGuidance,
  buildLegacyCompatPayload,
  coerceSynthesisOutput,
  normalizeFallbackAuditOutput,
  buildDeterministicSynthesis,
  buildRoutineInventory,
  getVisibleRecommendationGroups,
  buildFallbackProductAudit,
  __resetGatewayForTest,
};
