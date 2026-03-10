const { normalizeCanonicalScoreBreakdown, normalizeWhyCandidateObject } = require('./recoScoreExplain');
const {
  DUPE_COMPARE_TRADEOFF_AXES,
  DUPE_COMPARE_IMPACTS,
  DUPE_COMPARE_EVIDENCE_STRENGTHS,
} = require('./dupeCompareContract');

function uniqueStrings(items) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(items) ? items : []) {
    const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function asPlainObject(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) return null;
  return value;
}

function asStringArray(value) {
  if (Array.isArray(value)) return uniqueStrings(value);
  if (typeof value === 'string') return uniqueStrings([value]);
  return [];
}

function asObjectArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asPlainObject(item)).filter(Boolean);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
    if (text) return text;
  }
  return '';
}

const DUPE_COMPARE_TRADEOFF_AXIS_SET = new Set(DUPE_COMPARE_TRADEOFF_AXES);
const DUPE_COMPARE_IMPACT_SET = new Set(DUPE_COMPARE_IMPACTS);
const DUPE_COMPARE_EVIDENCE_STRENGTH_SET = new Set(DUPE_COMPARE_EVIDENCE_STRENGTHS);
const DUPE_COMPARE_EVIDENCE_SUPPORTS = new Set(['original', 'dupe', 'comparison']);

function normalizeDupeCompareEvidenceClaim(raw) {
  const row = asPlainObject(raw);
  if (!row) return null;

  const claim_en = firstNonEmptyString(
    row.claim_en,
    row.claimEn,
    row.claim,
    row.note,
    row.text,
    row.summary_en,
    row.summaryEn,
  );
  if (!claim_en) return null;

  const rawStrength = firstNonEmptyString(row.strength, row.evidence_level, row.evidenceLevel).toLowerCase();
  const strength = DUPE_COMPARE_EVIDENCE_STRENGTH_SET.has(rawStrength) ? rawStrength : 'uncertain';
  const supports = uniqueStrings(asStringArray(row.supports))
    .map((item) => item.toLowerCase())
    .filter((item) => DUPE_COMPARE_EVIDENCE_SUPPORTS.has(item));
  const uncertainties = uniqueStrings(
    asStringArray(row.uncertainties || row.missing_info || row.missingInfo || row.caveats),
  );

  return {
    claim_en,
    strength,
    ...(supports.length ? { supports } : {}),
    ...(uncertainties.length ? { uncertainties } : {}),
  };
}

function normalizeDupeCompareEvidenceClaims(value) {
  return asObjectArray(value)
    .map((row) => normalizeDupeCompareEvidenceClaim(row))
    .filter(Boolean)
    .slice(0, 12);
}

function inferDupeCompareTradeoffAxis(text) {
  const lower = String(text || '').trim().toLowerCase();
  if (!lower) return 'unknown';
  if (/^(texture|texture\/finish|finish)\s*:/.test(lower)) return lower.startsWith('finish') ? 'finish' : 'texture';
  if (/^(hydration)\s*:/.test(lower)) return 'hydration';
  if (/^(irritation risk|fragrance risk|risk)\s*:/.test(lower)) return 'irritation_risk';
  if (/^(hero ingredient shift|key ingredient|actives?)\s*:/.test(lower)) return 'actives';
  if (/^(price)\s*:/.test(lower)) return 'price';
  if (/(spf|sunscreen|uv|sun protection)/.test(lower)) return 'spf_role';
  if (/(fragrance|parfum|scent|essential oil|limonene|linalool|citral)/.test(lower)) return 'fragrance';
  if (/(irritation|sensitive|stinging|burn|retinoid|acid|aha|bha|pha|exfoliant|risk)/.test(lower)) return 'irritation_risk';
  if (/(texture|cream|gel|lotion|balm|oil|spread|occlusive|lightweight|richer)/.test(lower)) return 'texture';
  if (/(finish|matte|dewy|greasy|glow|light feel)/.test(lower)) return 'finish';
  if (/(hydration|moistur|humectant|barrier|seal|sealing)/.test(lower)) return 'hydration';
  if (/(price|affordable|\$|usd|expensive|cheaper|cost)/.test(lower)) return 'price';
  if (/(pump|jar|tube|dropper|packaging|bottle)/.test(lower)) return 'packaging';
  if (/(niacinamide|vitamin c|tranexamic|azelaic|retinol|retinal|ceramide|peptide|active|ingredient|brightening|hero ingredient)/.test(lower)) return 'actives';
  if (/(oily|dry|combination|acne|sensitive skin|skin type|suitability|daily use|use case)/.test(lower)) return 'suitability';
  return 'unknown';
}

function inferDupeCompareTradeoffImpact(text) {
  const lower = String(text || '').trim().toLowerCase();
  if (!lower) return 'uncertain';
  if (/(higher risk|less suitable|missing|avoid|caution|worse|irritation risk|not ideal)/.test(lower)) return 'worse_for_some';
  if (/(lighter|more affordable|better for|gentler|more suitable|easier|lighter feel)/.test(lower)) return 'better_for_some';
  return 'uncertain';
}

function inferDupeCompareTradeoffAudience(axis, text) {
  const lower = String(text || '').trim().toLowerCase();
  if (axis === 'texture' || axis === 'finish') {
    if (/(oily|shine|greasy)/.test(lower)) return 'matters for oily skin users seeking a lighter finish';
    if (/(dry|rich|seal|occlusive)/.test(lower)) return 'matters for dry skin users who need more sealing comfort';
    return 'matters for users who care about feel and finish';
  }
  if (axis === 'hydration') return 'matters for users deciding between lighter hydration and richer moisture support';
  if (axis === 'irritation_risk') return 'matters for sensitive or barrier-impaired users';
  if (axis === 'fragrance') return 'matters for fragrance-sensitive users';
  if (axis === 'price') return 'matters for budget-sensitive users';
  if (axis === 'packaging') return 'matters for users who care about hygiene and portability';
  if (axis === 'actives') return 'matters for users seeking specific active benefits';
  if (axis === 'spf_role') return 'matters for users relying on daytime UV protection';
  if (axis === 'suitability') return 'matters for skin-type and use-case fit';
  return 'matters for users comparing limited product details';
}

function normalizeDupeCompareTradeoff(raw) {
  const row = asPlainObject(raw);
  if (!row) return null;

  const difference_en = firstNonEmptyString(
    row.difference_en,
    row.differenceEn,
    row.difference,
    row.summary_en,
    row.summaryEn,
    row.claim_en,
    row.claimEn,
    row.note,
    row.text,
  );
  if (!difference_en) return null;

  const rawAxis = firstNonEmptyString(row.axis).toLowerCase();
  const axis = DUPE_COMPARE_TRADEOFF_AXIS_SET.has(rawAxis) ? rawAxis : inferDupeCompareTradeoffAxis(difference_en);
  const rawImpact = firstNonEmptyString(row.impact).toLowerCase();
  const impact = DUPE_COMPARE_IMPACT_SET.has(rawImpact) ? rawImpact : inferDupeCompareTradeoffImpact(difference_en);
  const who_it_matters_for =
    firstNonEmptyString(row.who_it_matters_for, row.whoItMattersFor, row.audience, row.for_users, row.forUsers)
    || inferDupeCompareTradeoffAudience(axis, difference_en);
  const difference_localized = firstNonEmptyString(row.difference_localized, row.differenceLocalized);

  return {
    axis,
    difference_en,
    impact,
    who_it_matters_for,
    ...(difference_localized ? { difference_localized } : {}),
  };
}

function uniqueDupeCompareTradeoffs(items) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const row = normalizeDupeCompareTradeoff(item);
    if (!row) continue;
    const key = `${row.axis}::${row.difference_en.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function classifyDupeCompareTradeoffString(text) {
  const clean = firstNonEmptyString(text);
  if (!clean) return null;
  const axis = inferDupeCompareTradeoffAxis(clean);
  return {
    axis,
    difference_en: clean,
    impact: inferDupeCompareTradeoffImpact(clean),
    who_it_matters_for: inferDupeCompareTradeoffAudience(axis, clean),
  };
}

function formatDupeCompareTradeoff(row) {
  const tradeoff = normalizeDupeCompareTradeoff(row);
  if (!tradeoff) return '';
  const difference = firstNonEmptyString(tradeoff.difference_localized, tradeoff.difference_en);
  if (!difference) return '';
  if (/^[^:]{1,28}:\s/.test(difference)) return difference;
  const axisLabel = tradeoff.axis === 'unknown' ? '' : tradeoff.axis.replace(/_/g, ' ');
  const who = firstNonEmptyString(tradeoff.who_it_matters_for);
  if (!axisLabel) return who ? `${difference} (${who})` : difference;
  const title = axisLabel.charAt(0).toUpperCase() + axisLabel.slice(1);
  return who ? `${title}: ${difference} (${who})` : `${title}: ${difference}`;
}

const INGREDIENT_UI_NOISE_TOKENS = new Set([
  'more',
  'show more',
  'read more',
  'view more',
  'see more',
  'ingredients',
  'ingredient',
  'key ingredients',
  'key ingredient',
]);

function normalizeIngredientToken(raw) {
  let text = String(raw == null ? '' : raw)
    .replace(/\u00a0/g, ' ')
    .replace(/\[\s*more\s*\]\s*/gi, '')
    .replace(/\(\s*more\s*\)\s*/gi, '')
    .replace(/^(?:show\s+more|read\s+more|view\s+more|see\s+more|more)\s*[:\-]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';

  const lower = text.toLowerCase();
  if (INGREDIENT_UI_NOISE_TOKENS.has(lower)) return '';
  if (/^(?:\.{2,}|…+)$/.test(text)) return '';
  return text;
}

function normalizeIngredientArray(value) {
  return uniqueStrings(asStringArray(value).map((item) => normalizeIngredientToken(item)).filter(Boolean));
}

function readScienceKeyIngredients(science) {
  const src = asPlainObject(science) || {};
  return normalizeIngredientArray(src.key_ingredients ?? src.keyIngredients);
}

function asNumberOrNull(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

const PRODUCT_ANALYSIS_GAP_MAP = {
  'concentration_unknown': 'ingredient_concentration_unknown',
  'ingredient_concentration_unknown': 'ingredient_concentration_unknown',
  'social_signals_missing': 'social_data_limited',
  'social_data_limited': 'social_data_limited',
  'competitors_missing': 'alternatives_unavailable',
  'competitors.candidates': 'alternatives_unavailable',
  'competitors.competitors.candidates': 'alternatives_unavailable',
  'alternatives_unavailable': 'alternatives_unavailable',
  'competitors_low_coverage': 'analysis_in_progress',
  'alternatives_limited': 'analysis_in_progress',
  'competitor_sync_aurora_fallback_used': 'analysis_in_progress',
  'catalog_product_missing': 'product_not_resolved',
  'catalog_backend_not_configured': 'product_not_resolved',
  'pivota_backend_not_configured': 'product_not_resolved',
  'upstream_deep_scan_skipped_anchor_missing': 'product_not_resolved',
  'anchor_missing_deepscan_degraded': 'product_not_resolved',
  'product_not_resolved': 'product_not_resolved',
  'evidence_missing': 'evidence_limited',
  'evidence_limited': 'evidence_limited',
  'analysis_missing': 'analysis_limited',
  'upstream_missing_or_unstructured': 'analysis_limited',
  'upstream_missing_or_empty': 'analysis_limited',
  'analysis_limited': 'analysis_limited',
  'upstream_analysis_missing': 'analysis_in_progress',
  'analysis_in_progress': 'analysis_in_progress',
  'url_fetch_forbidden_403': 'url_fetch_forbidden_403',
  'url_fetch_challenge_cloudflare': 'url_fetch_challenge_cloudflare',
  'url_fetch_access_denied': 'url_fetch_access_denied',
  'url_fetch_vendor_unblock_used': 'url_fetch_vendor_unblock_used',
  'url_fetch_vendor_unblock_failed': 'url_fetch_vendor_unblock_failed',
  'url_fetch_recovered_with_fallback': 'url_fetch_recovered_with_fallback',
  'on_page_fetch_blocked': 'on_page_fetch_blocked',
  'regulatory_source_used': 'regulatory_source_used',
  'retail_source_used': 'retail_source_used',
  'retail_source_no_match': 'retail_source_no_match',
  'llm_verification_used': 'llm_verification_used',
  'incidecoder_source_used': 'incidecoder_source_used',
  'incidecoder_no_match': 'incidecoder_no_match',
  'incidecoder_fetch_failed': 'incidecoder_fetch_failed',
  'incidecoder_unverified_not_persisted': 'incidecoder_unverified_not_persisted',
  'ingredient_source_conflict': 'ingredient_source_conflict',
  'related_semantics_reclassified': 'related_semantics_reclassified',
  'version_verification_needed': 'version_verification_needed',
  'price_unknown': 'price_temporarily_unavailable',
  'price_missing': 'price_temporarily_unavailable',
  'anchor_price_unknown': 'price_temporarily_unavailable',
  'anchor_price_missing': 'price_temporarily_unavailable',
  'price_temporarily_unavailable': 'price_temporarily_unavailable',
  'skin_fit.profile.skintype': 'profile_not_provided',
  'skin_fit.profile.sensitivity': 'profile_not_provided',
  'skin_fit.profile.barrierstatus': 'profile_not_provided',
  'skin_fit.profile.goals': 'profile_not_provided',
  'profile.skintype': 'profile_not_provided',
  'profile.sensitivity': 'profile_not_provided',
  'profile.barrierstatus': 'profile_not_provided',
  'profile.goals': 'profile_not_provided',
  'profile_skin_type_missing': 'profile_not_provided',
  'profile_sensitivity_missing': 'profile_not_provided',
  'profile_barrier_status_missing': 'profile_not_provided',
  'profile_goals_missing': 'profile_not_provided',
  'profile_not_provided': 'profile_not_provided',
};

const PRODUCT_ANALYSIS_INTERNAL_GAP_EXACT = new Set([
  'alternatives_unavailable',
  'alternatives_limited',
  'upstream_analysis_missing',
  'url_ingredient_analysis_used',
  'url_realtime_product_intel_used',
  'catalog_fallback_used',
  'competitor_sync_enrich_used',
  'competitor_async_backfill_used',
  'profile_context_dropped_for_reliability',
  'competitor_candidates_filtered_noise',
  'reco_blocks_schema_invalid',
  'reco_guardrail_applied',
  'reco_guardrail_same_brand_filtered',
  'reco_guardrail_on_page_filtered',
  'reco_guardrail_circuit_open',
  'reco_blocks_schema_invalid',
  'summary_quality_retry_used',
  'how_to_use_retry_used',
  'summary_profile_echo_sanitized',
]);

const PRODUCT_ANALYSIS_INTERNAL_GAP_PREFIXES = [
  'competitor_recall_',
  'catalog_anchor_fallback_',
  'ingredient_intel.',
  'skin_fit.',
  'social_signals.',
  'competitors.',
  'router.',
  'reco_dag_',
  'reco_blocks_',
  'url_',
  'upstream_',
  'internal_',
  'reco_guardrail_',
];

const PRODUCT_ANALYSIS_USER_VISIBLE_EXACT = new Set([
  'url_fetch_forbidden_403',
  'url_fetch_challenge_cloudflare',
  'url_fetch_access_denied',
  'url_fetch_vendor_unblock_used',
  'url_fetch_vendor_unblock_failed',
  'url_fetch_recovered_with_fallback',
  'on_page_fetch_blocked',
  'regulatory_source_used',
  'retail_source_used',
  'retail_source_no_match',
  'incidecoder_source_used',
  'incidecoder_no_match',
  'incidecoder_fetch_failed',
  'incidecoder_unverified_not_persisted',
  'ingredient_source_conflict',
  'related_semantics_reclassified',
  'version_verification_needed',
]);

function mapProductAnalysisGapCode(code) {
  const raw = String(code || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (PRODUCT_ANALYSIS_GAP_MAP[lower]) return PRODUCT_ANALYSIS_GAP_MAP[lower];
  if (/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(lower)) return lower;
  return '';
}

function isInternalProductAnalysisGapCode(code) {
  const lower = String(code || '').trim().toLowerCase();
  if (!lower) return true;
  if (PRODUCT_ANALYSIS_USER_VISIBLE_EXACT.has(lower)) return false;
  if (PRODUCT_ANALYSIS_INTERNAL_GAP_EXACT.has(lower)) return true;
  if (PRODUCT_ANALYSIS_INTERNAL_GAP_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  return false;
}

function deriveProfilePrompt(rawCodes) {
  const tokens = uniqueStrings(asStringArray(rawCodes)).map((code) => String(code || '').trim().toLowerCase());
  if (!tokens.length) return null;

  const missingFields = new Set();
  let needed = false;

  for (const token of tokens) {
    const mapped = mapProductAnalysisGapCode(token);
    if (mapped === 'profile_not_provided' || token === 'profile_not_provided') needed = true;
    if (/skin_fit\.profile\.skintype|profile\.skintype|profile_skin_type_missing/.test(token)) {
      needed = true;
      missingFields.add('skinType');
    }
    if (/skin_fit\.profile\.sensitivity|profile\.sensitivity|profile_sensitivity_missing/.test(token)) {
      needed = true;
      missingFields.add('sensitivity');
    }
    if (/skin_fit\.profile\.barrierstatus|profile\.barrierstatus|profile_barrier_status_missing/.test(token)) {
      needed = true;
      missingFields.add('barrierStatus');
    }
    if (/skin_fit\.profile\.goals|profile\.goals|profile_goals_missing/.test(token)) {
      needed = true;
      missingFields.add('goals');
    }
  }

  if (!needed) return null;
  if (!missingFields.size) {
    missingFields.add('skinType');
    missingFields.add('sensitivity');
    missingFields.add('barrierStatus');
  }

  return {
    needed: true,
    missing_fields: Array.from(missingFields),
    cta_action: 'open_profile',
    cta_target: 'profile_sheet',
  };
}

function splitProductAnalysisGaps(rawCodes) {
  const internalDebugCodes = uniqueStrings(asStringArray(rawCodes));
  const profilePrompt = deriveProfilePrompt(internalDebugCodes);
  const userFacingGaps = [];
  for (const raw of internalDebugCodes) {
    const mapped = mapProductAnalysisGapCode(raw);
    if (!mapped) continue;
    if (mapped === 'profile_not_provided') continue;
    if (isInternalProductAnalysisGapCode(mapped)) continue;
    userFacingGaps.push(mapped);
  }
  const userFacing = uniqueStrings(userFacingGaps);
  return {
    missing_info: userFacing,
    user_facing_gaps: userFacing,
    internal_debug_codes: internalDebugCodes,
    missing_info_internal: internalDebugCodes,
    profile_prompt: profilePrompt,
  };
}

function applyProductAnalysisGapContract(payload) {
  const p = asPlainObject(payload);
  if (!p) return payload;
  const mergedRawCodes = uniqueStrings([
    ...asStringArray(p.missing_info ?? p.missingInfo),
    ...asStringArray(p.user_facing_gaps ?? p.userFacingGaps),
    ...asStringArray(p.internal_debug_codes ?? p.internalDebugCodes),
    ...asStringArray(p.missing_info_internal ?? p.missingInfoInternal),
  ]);
  const gaps = splitProductAnalysisGaps(mergedRawCodes);
  return {
    ...p,
    missing_info: gaps.missing_info,
    user_facing_gaps: gaps.user_facing_gaps,
    internal_debug_codes: gaps.internal_debug_codes,
    missing_info_internal: gaps.missing_info_internal,
    ...(gaps.profile_prompt ? { profile_prompt: gaps.profile_prompt } : {}),
  };
}

function collectProductAnalysisGapCodes(payload, fieldMissing = null) {
  const p = asPlainObject(payload) || {};
  const evidence = asPlainObject(p.evidence) || {};
  const fromFieldMissing = Array.isArray(fieldMissing)
    ? fieldMissing.map((item) => String(item?.reason || '').trim()).filter(Boolean)
    : [];
  const payloadFieldMissingReasons = Array.isArray(p.field_missing)
    ? p.field_missing.map((item) => String(item?.reason || '').trim()).filter(Boolean)
    : [];
  return uniqueStrings([
    ...asStringArray(p.missing_info ?? p.missingInfo),
    ...asStringArray(p.user_facing_gaps ?? p.userFacingGaps),
    ...asStringArray(p.internal_debug_codes ?? p.internalDebugCodes),
    ...asStringArray(p.missing_info_internal ?? p.missingInfoInternal),
    ...asStringArray(evidence.missing_info ?? evidence.missingInfo),
    ...fromFieldMissing,
    ...payloadFieldMissingReasons,
  ]);
}

function hasEvidenceSourcesOfType(payload, acceptedTypes = []) {
  const p = asPlainObject(payload) || {};
  const evidence = asPlainObject(p.evidence) || {};
  const accepted = new Set(
    (Array.isArray(acceptedTypes) ? acceptedTypes : [])
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean),
  );
  if (!accepted.size) return false;
  return asStringArray(
    (Array.isArray(evidence.sources) ? evidence.sources : [])
      .map((item) => (asPlainObject(item) ? String(item.type || '').trim().toLowerCase() : ''))
      .filter(Boolean),
  ).some((type) => accepted.has(type));
}

function hasRenderableEvidenceSignals(payload) {
  const p = asPlainObject(payload) || {};
  const evidence = asPlainObject(p.evidence) || {};
  const science = asPlainObject(evidence.science) || {};
  const social = asPlainObject(evidence.social_signals ?? evidence.socialSignals) || {};
  const keyIngredients = readScienceKeyIngredients(science);
  const mechanisms = asStringArray(science.mechanisms);
  const fitNotes = asStringArray(science.fit_notes ?? science.fitNotes);
  const riskNotes = asStringArray(science.risk_notes ?? science.riskNotes);
  const expertNotes = asStringArray(evidence.expert_notes ?? evidence.expertNotes);
  const positives = asStringArray(social.typical_positive ?? social.typicalPositive);
  const negatives = asStringArray(social.typical_negative ?? social.typicalNegative);
  const riskForGroups = asStringArray(social.risk_for_groups ?? social.riskForGroups);
  const sources = Array.isArray(evidence.sources) ? evidence.sources.length : 0;
  return (
    keyIngredients.length > 0 ||
    mechanisms.length > 0 ||
    fitNotes.length > 0 ||
    riskNotes.length > 0 ||
    expertNotes.length > 0 ||
    positives.length > 0 ||
    negatives.length > 0 ||
    riskForGroups.length > 0 ||
    sources > 0
  );
}

function buildDiagnosticUnknownReasons(payload, { lang = 'EN', fieldMissing = null } = {}) {
  const isCn = String(lang || '').toUpperCase() === 'CN';
  const p = asPlainObject(payload) || {};
  const gapCodes = collectProductAnalysisGapCodes(p, fieldMissing).map((item) => String(item || '').toLowerCase());
  const gapSet = new Set(gapCodes);
  const provenance = asPlainObject(p.provenance) || {};
  const urlFetch = asPlainObject(provenance.url_fetch ?? provenance.urlFetch) || {};
  const urlFailureCode = String(urlFetch.failure_code || '').trim().toLowerCase();
  const reasons = [];

  if (gapSet.has('url_fetch_challenge_cloudflare') || urlFailureCode === 'url_fetch_challenge_cloudflare') {
    reasons.push(
      isCn
        ? '目标页面命中了 Cloudflare 反爬挑战页，无法直接提取商品正文。'
        : 'The target page hit a Cloudflare anti-bot challenge, so product-page content could not be extracted directly.',
    );
  } else if (gapSet.has('url_fetch_access_denied') || urlFailureCode === 'url_fetch_access_denied') {
    reasons.push(
      isCn
        ? '目标页面返回 Access Denied，当前网络路径无法稳定读取商品正文。'
        : 'The target page returned Access Denied, so the current network path could not read product-page content reliably.',
    );
  } else if (gapSet.has('url_fetch_forbidden_403') || urlFailureCode === 'url_fetch_forbidden_403') {
    reasons.push(
      isCn
        ? '目标页面被站点策略拦截（403），本次无法稳定抓取完整产品证据。'
        : 'The target page was blocked by site policy (403), so full product evidence could not be fetched reliably.',
    );
  } else if (gapSet.has('on_page_fetch_blocked')) {
    reasons.push(
      isCn
        ? '官网页面抓取受限，本次分析走了降级路径。'
        : 'Official-page fetching was blocked, so this run used a degraded analysis path.',
    );
  }

  if (
    gapSet.has('anchor_product_missing') ||
    gapSet.has('product_not_resolved') ||
    gapSet.has('catalog_product_missing') ||
    gapSet.has('catalog_no_match')
  ) {
    reasons.push(
      isCn
        ? '产品锚点解析不稳定（品牌/型号未完全确认），结论可信度受限。'
        : 'Product anchoring is not stable yet (brand/model not fully resolved), which limits confidence.',
    );
  }

  if (gapSet.has('regulatory_source_used')) {
    reasons.push(
      isCn
        ? '已使用监管源补证（如 DailyMed），但不同地区/批次可能存在配方差异。'
        : 'A regulatory source (for example DailyMed) was used, but formulas can vary by market/batch.',
    );
  }

  if (gapSet.has('retail_source_used')) {
    reasons.push(
      isCn
        ? '已使用主流零售页面补充证据，建议与官方/监管信息和实物包装 INCI 交叉核对。'
        : 'A mainstream retail PDP was used as supplemental evidence; cross-check with official/regulatory data and package INCI.',
    );
  }

  if (gapSet.has('incidecoder_source_used')) {
    reasons.push(
      isCn
        ? '已使用 INCIDecoder 补充成分线索，建议继续与实物包装 INCI 交叉核对。'
        : 'INCIDecoder was used as a supplemental ingredient source; cross-check with package INCI is still recommended.',
    );
  }

  if (gapSet.has('url_fetch_vendor_unblock_failed')) {
    reasons.push(
      isCn
        ? '已尝试解封抓取链路但仍失败，建议改用可访问的零售 PDP 或直接贴 INCI。'
        : 'An unblock-fetch fallback was attempted but still failed; use an accessible retail PDP or paste the INCI directly.',
    );
  }

  if (
    gapSet.has('evidence_missing') ||
    gapSet.has('analysis_limited') ||
    gapSet.has('upstream_missing_or_unstructured') ||
    !hasRenderableEvidenceSignals(p)
  ) {
    reasons.push(
      isCn
        ? '当前证据链覆盖不足（成分/口碑/专家注释存在缺口），暂不能给出高置信结论。'
        : 'Current evidence coverage is limited (ingredient/social/expert gaps), so a high-confidence verdict is not available yet.',
    );
  }

  if (gapSet.has('version_verification_needed')) {
    reasons.push(
      isCn
        ? '需核对地区与批次版本差异，以实物包装 INCI 为准。'
        : 'Version/region verification is still required; use your package INCI as final reference.',
    );
  }

  reasons.push(
    isCn
      ? '下一步：请粘贴完整 INCI，或提供可公开访问的官方产品页后重试。'
      : 'Next step: paste the full INCI or share a publicly accessible official product page and retry.',
  );

  return uniqueStrings(reasons).slice(0, 5);
}

function buildAssessmentUnknownReasonFallback(lang = 'EN') {
  const isCn = String(lang || '').toUpperCase() === 'CN';
  return [
    isCn
      ? '当前证据不足，暂时无法给出高置信度的产品结论。'
      : 'Current evidence is insufficient for a high-confidence product verdict.',
  ];
}

function isDiagnosticNarrativeLine(input) {
  const text = String(input || '').trim();
  if (!text) return false;
  if (/^(?:next step|下一步)\s*[:：]/i.test(text)) return true;
  return /(cloudflare|access denied|site policy \(403\)|official[-\s]?page fetching|official product page|could not be parsed reliably|degraded analysis path|官网页面抓取受限|降级路径|产品锚点解析不稳定|product anchoring is not stable|no-anchor deep scan|无锚点 deep scan|regulatory source|监管源补证|incidecoder|retail pdp|零售页面补充证据|unblock-fetch fallback|解封抓取|evidence coverage is limited|证据链覆盖不足|version\/region verification|批次版本差异|paste the full inci|公开可访问的官方产品页|publicly accessible official page|share an accessible official page|upstream did not return evidence details|upstream did not return usable reasoning|边界说明：成分浓度与批次差异不可见|boundary: concentration and batch variance are unknown)/i
    .test(text);
}

function backfillUrlFetchAttemptProviders(provenanceInput) {
  const provenance = asPlainObject(provenanceInput);
  if (!provenance) return provenanceInput;
  const hasSnake = provenance.url_fetch != null;
  const urlFetch = asPlainObject(hasSnake ? provenance.url_fetch : provenance.urlFetch);
  if (!urlFetch) return provenanceInput;
  const attempts = Array.isArray(urlFetch.attempts) ? urlFetch.attempts : null;
  if (!attempts || !attempts.length) return provenanceInput;

  const normalizedAttempts = attempts.map((entry) => {
    const item = asPlainObject(entry);
    if (!item) return entry;
    const provider = String(item.provider || 'native').trim().toLowerCase() || 'native';
    return {
      ...item,
      provider,
    };
  });

  const nextUrlFetch = {
    ...urlFetch,
    attempts: normalizedAttempts,
  };

  return hasSnake
    ? {
      ...provenance,
      url_fetch: nextUrlFetch,
    }
    : {
      ...provenance,
      urlFetch: nextUrlFetch,
    };
}

function normalizeRetrievalDegradationContract(input) {
  const raw = asPlainObject(input) || {};
  const transientFailureCount = Math.max(0, Math.trunc(Number(raw.transient_failure_count ?? raw.transientFailureCount) || 0));
  const attemptedSources = uniqueStrings(asStringArray(raw.attempted_sources ?? raw.attemptedSources)).slice(0, 8);
  const resolverFirstApplied = raw.resolver_first_applied === true;
  const resolverFirstSkippedForAurora = raw.resolver_first_skipped_for_aurora === true;
  const sourceTemporarilyDeprioritized = raw.source_temporarily_deprioritized === true;
  const degraded = raw.degraded === true || transientFailureCount > 0 || sourceTemporarilyDeprioritized;
  const budgetProfile = asPlainObject(raw.budget_profile ?? raw.budgetProfile);
  return {
    ...raw,
    transient_failure_count: transientFailureCount,
    attempted_sources: attemptedSources,
    resolver_first_applied: resolverFirstApplied,
    resolver_first_skipped_for_aurora: resolverFirstSkippedForAurora,
    source_temporarily_deprioritized: sourceTemporarilyDeprioritized,
    degraded,
    ...(budgetProfile ? { budget_profile: budgetProfile } : {}),
  };
}

function reconcileProductAnalysisConsistency(payload, { lang = 'EN', fieldMissing = null } = {}) {
  const p = asPlainObject(payload);
  if (!p) return payload;

  const assessment = asPlainObject(p.assessment);
  const anchor = asPlainObject(assessment?.anchor_product ?? assessment?.anchorProduct);
  const hasAnchor =
    !!anchor &&
    !!String(
      anchor.product_id ||
      anchor.sku_id ||
      anchor.display_name ||
      anchor.displayName ||
      anchor.name ||
      anchor.url ||
      '',
    ).trim();

  const pruneAnchorMissing = (input) =>
    uniqueStrings(asStringArray(input).filter((code) => String(code || '').trim().toLowerCase() !== 'anchor_product_missing'));

  let next = { ...p };
  const nextProvenance = backfillUrlFetchAttemptProviders(next.provenance);
  if (asPlainObject(nextProvenance)) {
    const provenanceObj = asPlainObject(nextProvenance) || {};
    next.provenance = {
      ...provenanceObj,
      retrieval_degradation: normalizeRetrievalDegradationContract(
        provenanceObj.retrieval_degradation ?? provenanceObj.retrievalDegradation,
      ),
    };
  }
  if (hasAnchor) {
    next = {
      ...next,
      missing_info: pruneAnchorMissing(next.missing_info ?? next.missingInfo),
      user_facing_gaps: pruneAnchorMissing(next.user_facing_gaps ?? next.userFacingGaps),
      internal_debug_codes: pruneAnchorMissing(next.internal_debug_codes ?? next.internalDebugCodes),
      missing_info_internal: pruneAnchorMissing(next.missing_info_internal ?? next.missingInfoInternal),
    };
    const evidenceObj = asPlainObject(next.evidence) || null;
    if (evidenceObj) {
      next.evidence = {
        ...evidenceObj,
        missing_info: pruneAnchorMissing(evidenceObj.missing_info ?? evidenceObj.missingInfo),
      };
    }
  }

  const currentAssessment = asPlainObject(next.assessment);
  if (!currentAssessment) {
    const fallbackAnchor = hasAnchor ? anchor : asPlainObject(next.product);
    next.assessment = {
      verdict: String(lang).toUpperCase() === 'CN' ? '未知' : 'Unknown',
      reasons: buildDiagnosticUnknownReasons(next, { lang, fieldMissing }),
      ...(fallbackAnchor ? { anchor_product: fallbackAnchor } : {}),
    };
  } else {
    const verdictToken = String(currentAssessment.verdict || '').trim().toLowerCase();
    const isUnknownVerdict = verdictToken === 'unknown' || verdictToken === '未知';
    if (isUnknownVerdict) {
      const reasons = asStringArray(currentAssessment.reasons);
      const nonGenericReasons = reasons.filter((line) => !isGenericReason(line, lang));
      const hasHighQualitySources = hasEvidenceSourcesOfType(next, ['official_page', 'regulatory']);
      if (!nonGenericReasons.length || hasHighQualitySources) {
        next.assessment = {
          ...currentAssessment,
          reasons: buildDiagnosticUnknownReasons(next, { lang, fieldMissing }),
        };
      }
    }
  }

  return applyProductAnalysisGapContract(next);
}

function asRecordOfNumbers(value) {
  const o = asPlainObject(value);
  if (!o) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    const key = String(k || '').trim();
    const n = asNumberOrNull(v);
    if (!key || n == null) continue;
    out[key] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeEvidence(raw) {
  const field_missing = [];
  const ev = asPlainObject(raw);
  if (!ev) {
    field_missing.push({ field: 'evidence', reason: 'upstream_missing_or_invalid' });
    return {
      evidence: {
        science: { key_ingredients: [], mechanisms: [], fit_notes: [], risk_notes: [] },
        social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
        expert_notes: [],
        confidence: null,
        missing_info: ['evidence_missing'],
      },
      field_missing,
    };
  }

  const scienceRaw = asPlainObject(ev.science);
  const scienceClaims = normalizeDupeCompareEvidenceClaims(ev.science);
  if (!scienceRaw && !scienceClaims.length) field_missing.push({ field: 'evidence.science', reason: 'upstream_missing_or_invalid' });

  const socialRaw = asPlainObject(ev.social_signals || ev.socialSignals);
  const socialClaims = normalizeDupeCompareEvidenceClaims(ev.social_signals || ev.socialSignals);
  if (!socialRaw && !socialClaims.length) field_missing.push({ field: 'evidence.social_signals', reason: 'upstream_missing_or_invalid' });

  const expertNotesRaw = ev.expert_notes ?? ev.expertNotes;
  const expertClaimObjects = normalizeDupeCompareEvidenceClaims(expertNotesRaw);
  const expert_notes = uniqueStrings([
    ...asStringArray(expertNotesRaw),
    ...expertClaimObjects.map((item) => item.claim_en),
  ]);
  if (!expert_notes.length) field_missing.push({ field: 'evidence.expert_notes', reason: 'upstream_missing_or_empty' });

  const science = {
    key_ingredients: readScienceKeyIngredients(scienceRaw),
    mechanisms: uniqueStrings([
      ...asStringArray(scienceRaw?.mechanisms),
      ...scienceClaims.map((item) => item.claim_en),
    ]),
    fit_notes: uniqueStrings([
      ...asStringArray(scienceRaw?.fit_notes ?? scienceRaw?.fitNotes),
      ...scienceClaims
        .filter((item) => Array.isArray(item.supports) && item.supports.some((token) => token === 'original' || token === 'dupe'))
        .map((item) => item.claim_en),
    ]),
    risk_notes: uniqueStrings([
      ...asStringArray(scienceRaw?.risk_notes ?? scienceRaw?.riskNotes),
      ...scienceClaims.flatMap((item) => asStringArray(item.uncertainties)),
    ]),
  };

  const social_signals = {
    ...(asRecordOfNumbers(socialRaw?.platform_scores ?? socialRaw?.platformScores)
      ? { platform_scores: asRecordOfNumbers(socialRaw?.platform_scores ?? socialRaw?.platformScores) }
      : {}),
    typical_positive: uniqueStrings([
      ...asStringArray(socialRaw?.typical_positive ?? socialRaw?.typicalPositive),
      ...socialClaims.map((item) => item.claim_en),
    ]),
    typical_negative: asStringArray(socialRaw?.typical_negative ?? socialRaw?.typicalNegative),
    risk_for_groups: uniqueStrings([
      ...asStringArray(socialRaw?.risk_for_groups ?? socialRaw?.riskForGroups),
      ...socialClaims.flatMap((item) => asStringArray(item.uncertainties)),
    ]),
  };

  const sources = [];
  for (const item of Array.isArray(ev.sources) ? ev.sources : []) {
    const row = asPlainObject(item);
    if (!row) continue;
    const type = String(row.type || '').trim().toLowerCase();
    if (!type) continue;
    if (type !== 'official_page' && type !== 'regulatory' && type !== 'retail_page' && type !== 'inci_decoder') continue;
    const url = String(row.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const label = String(row.label || '').trim();
    const confidence = asNumberOrNull(row.confidence);
    sources.push({
      type,
      url,
      ...(label ? { label } : {}),
      ...(confidence != null ? { confidence: Math.max(0, Math.min(1, confidence)) } : {}),
    });
    if (sources.length >= 8) break;
  }

  const missing_info = uniqueStrings(asStringArray(ev.missing_info ?? ev.missingInfo));
  const confidence = asNumberOrNull(ev.confidence);
  const structuredClaims = {
    ...(scienceClaims.length ? { science: scienceClaims } : {}),
    ...(socialClaims.length ? { social_signals: socialClaims } : {}),
    ...(expertClaimObjects.length ? { expert_notes: expertClaimObjects } : {}),
  };

  return {
    evidence: {
      science,
      social_signals,
      expert_notes,
      confidence,
      missing_info,
      ...(Object.keys(structuredClaims).length ? { structured_claims: structuredClaims } : {}),
      ...(sources.length ? { sources } : {}),
    },
    field_missing,
  };
}

function normalizeProductParse(raw) {
  const field_missing = [];
  const o = asPlainObject(raw);
  if (!o) {
    return {
      payload: { product: null, confidence: null, missing_info: ['upstream_missing_or_unstructured'] },
      field_missing: [{ field: 'product', reason: 'upstream_missing_or_unstructured' }],
    };
  }

  const parseRaw = asPlainObject(o.parse);
  const product =
    asPlainObject(o.product) ||
    asPlainObject(o.anchor_product || o.anchorProduct) ||
    asPlainObject(o.product_entity || o.productEntity) ||
    asPlainObject(parseRaw?.product) ||
    asPlainObject(parseRaw?.anchor_product || parseRaw?.anchorProduct) ||
    asPlainObject(parseRaw?.product_entity || parseRaw?.productEntity) ||
    null;
  if (!product) field_missing.push({ field: 'product', reason: 'upstream_missing_or_invalid' });

  const confidence = asNumberOrNull(
    o.confidence ??
      o.parse_confidence ??
      o.parseConfidence ??
      parseRaw?.parse_confidence ??
      parseRaw?.parseConfidence ??
      parseRaw?.confidence,
  );
  if (confidence == null) field_missing.push({ field: 'confidence', reason: 'upstream_missing_or_invalid' });

  const missing_info = uniqueStrings([
    ...asStringArray(o.missing_info ?? o.missingInfo),
    ...asStringArray(parseRaw?.missing_info ?? parseRaw?.missingInfo ?? parseRaw?.missing_fields ?? parseRaw?.missingFields),
  ]);

  return {
    payload: { product, confidence, missing_info },
    field_missing,
  };
}

function normalizeProductAnalysis(raw) {
  const o = asPlainObject(raw);
  if (!o) {
    const evOut = normalizeEvidence(null);
    const gaps = splitProductAnalysisGaps(['upstream_missing_or_unstructured', ...(evOut.evidence?.missing_info || [])]);
    return {
      payload: {
        assessment: null,
        evidence: evOut.evidence,
        confidence: null,
        missing_info: gaps.missing_info,
        user_facing_gaps: gaps.user_facing_gaps,
        internal_debug_codes: gaps.internal_debug_codes,
        missing_info_internal: gaps.missing_info_internal,
        ...(gaps.profile_prompt ? { profile_prompt: gaps.profile_prompt } : {}),
      },
      field_missing: [{ field: 'assessment', reason: 'upstream_missing_or_unstructured' }, ...evOut.field_missing],
    };
  }

  const field_missing = [];

  const assessment = asPlainObject(o.assessment) || null;
  if (!assessment) field_missing.push({ field: 'assessment', reason: 'upstream_missing_or_invalid' });

  const evOut = normalizeEvidence(o.evidence);
  field_missing.push(...evOut.field_missing);

  const confidence = asNumberOrNull(o.confidence);
  if (confidence == null) field_missing.push({ field: 'confidence', reason: 'upstream_missing_or_invalid' });

  const missing_info = uniqueStrings([
    ...asStringArray(o.missing_info ?? o.missingInfo),
    ...asStringArray(o.user_facing_gaps ?? o.userFacingGaps),
    ...asStringArray(o.internal_debug_codes ?? o.internalDebugCodes),
    ...asStringArray(o.missing_info_internal ?? o.missingInfoInternal),
  ]);
  if (evOut.evidence.missing_info?.length) missing_info.push(...evOut.evidence.missing_info);
  const gaps = splitProductAnalysisGaps(missing_info);

  const competitorsRaw = asPlainObject(o.competitors);
  const competitorCandidates = [];
  if (competitorsRaw && Array.isArray(competitorsRaw.candidates)) {
    for (const item of competitorsRaw.candidates) {
      const row = asPlainObject(item);
      if (!row) continue;
      competitorCandidates.push(row);
      if (competitorCandidates.length >= 12) break;
    }
  }
  if (competitorsRaw && !competitorCandidates.length) {
    field_missing.push({ field: 'competitors.candidates', reason: 'upstream_missing_or_empty' });
  }

  const relatedRaw = asPlainObject(o.related_products ?? o.relatedProducts);
  const relatedCandidates = [];
  if (relatedRaw && Array.isArray(relatedRaw.candidates)) {
    for (const item of relatedRaw.candidates) {
      const row = asPlainObject(item);
      if (!row) continue;
      relatedCandidates.push(row);
      if (relatedCandidates.length >= 12) break;
    }
  }
  if (relatedRaw && !relatedCandidates.length) {
    field_missing.push({ field: 'related_products.candidates', reason: 'upstream_missing_or_empty' });
  }

  const dupesRaw = asPlainObject(o.dupes);
  const dupeCandidates = [];
  if (dupesRaw && Array.isArray(dupesRaw.candidates)) {
    for (const item of dupesRaw.candidates) {
      const row = asPlainObject(item);
      if (!row) continue;
      dupeCandidates.push(row);
      if (dupeCandidates.length >= 12) break;
    }
  }
  if (dupesRaw && !dupeCandidates.length) {
    field_missing.push({ field: 'dupes.candidates', reason: 'upstream_missing_or_empty' });
  }

  return {
    payload: {
      assessment,
      evidence: evOut.evidence,
      confidence,
      missing_info: gaps.missing_info,
      user_facing_gaps: gaps.user_facing_gaps,
      internal_debug_codes: gaps.internal_debug_codes,
      missing_info_internal: gaps.missing_info_internal,
      ...(gaps.profile_prompt ? { profile_prompt: gaps.profile_prompt } : {}),
      ...(competitorCandidates.length ? { competitors: { candidates: competitorCandidates } } : {}),
      ...(relatedCandidates.length ? { related_products: { candidates: relatedCandidates } } : {}),
      ...(dupeCandidates.length ? { dupes: { candidates: dupeCandidates } } : {}),
    },
    field_missing,
  };
}

function isGenericReason(reason, lang) {
  const s = typeof reason === 'string' ? reason.trim() : reason == null ? '' : String(reason).trim();
  if (!s) return true;
  const lower = s.toLowerCase();

  const en = [
    'overall fit',
    'looks reasonable',
    'seems suitable',
    'seems risky',
    'broadly compatible',
    'generally compatible',
    'compatible with most',
    'works for most',
    'good fit for most',
  ];
  if (en.some((p) => lower.includes(p))) return true;

  if (String(lang || '').toUpperCase() === 'CN') {
    const cn = ['整体', '总体', '大体', '总体来看', '一般来说', '比较适合', '相对适合', '看起来还行', '大多数'];
    if (cn.some((p) => s.includes(p))) return true;
  }

  return false;
}

function truncateText(s, max = 200) {
  const t = typeof s === 'string' ? s.trim() : s == null ? '' : String(s).trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

function isMostlyEnglishText(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  if (!letters) return false;
  // If it has no CJK and a lot of latin letters, treat as EN-ish.
  const hasCjk = /[\u4e00-\u9fff]/.test(t);
  return !hasCjk && letters / Math.max(1, t.length) > 0.25;
}

function humanizeRiskToken(token, lang) {
  const t = String(token || '').trim();
  if (!t) return '';
  const lower = t.toLowerCase();

  const cn = String(lang).toUpperCase() === 'CN';
  const map = {
    high_irritation: cn ? '刺激性偏高（更容易刺痛/泛红）' : 'Higher irritation potential (stinging/redness more likely)',
    strong_acid: cn ? '酸类偏强（更容易刺激）' : 'Stronger acids (higher irritation risk)',
    mild_acid: cn ? '含温和酸类' : 'Contains mild acids',
    acid: cn ? '含酸类（注意频率）' : 'Contains acids (watch frequency)',
    fragrance: cn ? '可能含香精/香料（以成分表为准）' : 'May be fragranced (verify INCI)',
    fungal_acne: cn ? '真菌痘倾向人群需谨慎（以个人情况为准）' : 'If fungal-acne prone, use with caution (depends on the person)',
    comedogenic: cn ? '可能更闷（以个人情况为准）' : 'May feel occlusive for some users',
  };

  if (map[lower]) return map[lower];

  // If the token is a bare snake_case flag, do not surface it to end users.
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(lower)) return '';

  return t;
}

function humanizeRiskLine(line, lang) {
  const raw = String(line || '').trim();
  if (!raw) return '';
  // Common KB-ish formatting: "a | b | c"
  const parts = raw.split('|').map((p) => p.trim()).filter(Boolean);
  const tokens = parts.length >= 2 ? parts : [raw];
  const out = uniqueStrings(tokens.map((t) => humanizeRiskToken(t, lang)).filter(Boolean));
  return out.length ? truncateText(out.join('；'), 200) : '';
}

function isProfileEchoNarrativeLine(line) {
  const text = String(line || '').trim();
  if (!text) return false;
  if (/^(your profile|profile priorities|你的情况|你的画像|画像信息)[:：]/i.test(text)) return true;
  if (/^(fit signal|匹配点)[:：]/i.test(text)) {
    if (
      /\b(skintype\s*=|sensitivity\s*=|barrier\s*=)\b/i.test(text) ||
      /profile|画像|肤质|敏感|屏障|油皮|干皮|混合皮|低敏|中敏|高敏/i.test(text)
    ) {
      return true;
    }
  }
  if (/\b(skintype\s*=|sensitivity\s*=|barrier\s*=)\b/i.test(text)) return true;

  const normalized = text.toLowerCase();
  const profileTokenCount = [
    /\b(oily|dry|combo|combination|normal)\b/.test(normalized),
    /\b(sensitivity|sensitive|low|medium|high)\b/.test(normalized),
    /\b(barrier|healthy|impaired)\b/.test(normalized),
    /肤质|敏感|屏障|油皮|干皮|混合皮|低敏|中敏|高敏/.test(text),
  ].filter(Boolean).length;
  const productSignal = /\b(ingredient|formula|efficacy|mechanis|retino|acid|niacinamide|ceramide|peptide|spf|sunscreen|cleanser|moisturizer|serum|防晒|保湿|修护|控痘|去角质)\b/i
    .test(text);
  if (!productSignal && profileTokenCount >= 2 && text.length <= 120) return true;

  return false;
}

function sanitizeAssessmentNarrativeLines(lines, { max = 6, allowProfileEcho = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(lines) ? lines : []) {
    const text = String(raw || '')
      .replace(/\[\s*more\s*\]\s*/gi, '')
      .replace(/\(\s*more\s*\)\s*/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    if (!allowProfileEcho && isProfileEchoNarrativeLine(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(truncateText(text, 220));
    if (out.length >= Math.max(1, Number(max) || 6)) break;
  }
  return out;
}

function buildProfileFitReasons(profileSummary, evidence, { lang = 'EN' } = {}) {
  const p = asPlainObject(profileSummary);
  if (!p) return [];

  const cn = String(lang).toUpperCase() === 'CN';
  const normalizeEnum = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const skinType = normalizeEnum(p.skinType);
  const sensitivity = normalizeEnum(p.sensitivity);
  const barrier = normalizeEnum(p.barrierStatus);
  const goals = Array.isArray(p.goals) ? p.goals.map((g) => normalizeEnum(g)).filter(Boolean) : [];

  const tags = [];
  if (cn) {
    if (skinType === 'oily') tags.push('油皮');
    else if (skinType === 'dry') tags.push('干皮');
    else if (skinType === 'combo' || skinType === 'combination') tags.push('混合皮');
    else if (skinType) tags.push(`肤质：${skinType}`);

    if (sensitivity === 'low') tags.push('低敏');
    else if (sensitivity === 'medium') tags.push('中敏');
    else if (sensitivity === 'high') tags.push('高敏');
    else if (sensitivity) tags.push(`敏感：${sensitivity}`);

    if (barrier === 'healthy') tags.push('屏障健康');
    else if (barrier === 'impaired') tags.push('屏障受损');
    else if (barrier) tags.push(`屏障：${barrier}`);
  } else {
    if (skinType) tags.push(skinType === 'combination' || skinType === 'combo' ? 'combination' : skinType);
    if (sensitivity) tags.push(`sensitivity=${sensitivity}`);
    if (barrier) tags.push(`barrier=${barrier}`);
  }

  const ev = asPlainObject(evidence) || {};
  const science = asPlainObject(ev.science) || {};
  const keyIngredients = readScienceKeyIngredients(science);
  const riskNotes = asStringArray(science.risk_notes ?? science.riskNotes);

  const lower = uniqueStrings(keyIngredients.map((x) => String(x || '').trim()).filter(Boolean)).join(' | ').toLowerCase();
  const hasNiacinamide = /\bniacinamide\b|烟酰胺/.test(lower);
  const hasZincPca = /\bzinc\b.*\bpca\b|锌\s*pca/.test(lower);
  const hasBarrierSupport = /\b(ceramide|panthenol|allantoin|hyaluron|glycerin|beta[-\s]?glucan)\b|神经酰胺|泛醇|尿囊素|玻尿酸|甘油/.test(lower);
  const hasStrongActives =
    /\b(retinol|retinal|tretinoin|adapalene)\b|维a|阿达帕林/.test(lower) ||
    /\baha\b|\bbha\b|\bpha\b|\bglycolic\b|\blactic\b|果酸|水杨酸|杏仁酸|乳酸|葡糖酸内酯/.test(lower);

  const humanizedRisk = uniqueStrings(riskNotes.map((r) => humanizeRiskLine(r, lang)).filter(Boolean));
  const isHighIrr = humanizedRisk.some((r) => /刺激|irrit/i.test(r)) || riskNotes.some((r) => /high_irritation/i.test(String(r || '')));

  const out = [];

  const priorityTargets = [];
  if (cn) {
    if (skinType === 'oily') priorityTargets.push('减少多余油脂分泌与闷痘负担');
    if (skinType === 'dry') priorityTargets.push('提升保湿与锁水');
    if (sensitivity === 'high' || sensitivity === 'medium') priorityTargets.push('降低刺激暴露与泛红风险');
    if (barrier === 'impaired') priorityTargets.push('修复并稳定皮肤屏障');
    if (goals.includes('acne')) priorityTargets.push('兼顾痘痘/闭口管理');
    if (goals.includes('brightening')) priorityTargets.push('兼顾提亮与色沉管理');
  } else {
    if (skinType === 'oily') priorityTargets.push('manage excess sebum and reduce clog-prone load');
    if (skinType === 'dry') priorityTargets.push('improve hydration and moisture retention');
    if (sensitivity === 'high' || sensitivity === 'medium') priorityTargets.push('lower irritation exposure and redness risk');
    if (barrier === 'impaired') priorityTargets.push('support barrier repair and stability');
    if (goals.includes('acne')) priorityTargets.push('keep acne/comedone control on track');
    if (goals.includes('brightening')) priorityTargets.push('keep brightening/pigment goals on track');
  }

  // Keep fit hints product-centric; do not emit profile recap lines here.
  const compactPriority = uniqueStrings(priorityTargets).slice(0, 3);
  if (compactPriority.length) {
    out.push(
      cn
        ? `匹配点：${truncateText(compactPriority.join('；'), 120)}。`
        : `Fit signal: ${truncateText(compactPriority.join('; '), 180)}.`,
    );
  }

  if (cn) {
    const goalHint = [];
    if (goals.includes('brightening')) goalHint.push('提亮');
    if (goals.includes('acne')) goalHint.push('痘痘/痘印');
    if (goalHint.length && (hasNiacinamide || hasZincPca)) {
      out.push(`匹配点：你的目标包含${goalHint.join('、')}；烟酰胺/锌类通常更偏这条路线。`);
    } else if (skinType === 'oily' && (hasNiacinamide || hasZincPca)) {
      out.push('匹配点：油皮更常用烟酰胺/锌类来控油、改善痘印与毛孔观感。');
    } else if (barrier === 'impaired' && hasBarrierSupport) {
      out.push('匹配点：配方里有偏修护/保湿的成分，通常更适合屏障不稳时打底。');
    }
  } else {
    const goalHint = [];
    if (goals.includes('brightening')) goalHint.push('brightening');
    if (goals.includes('acne')) goalHint.push('acne/marks');
    if (goalHint.length && (hasNiacinamide || hasZincPca)) {
      out.push(`Fit: your goals include ${goalHint.join(' + ')}; niacinamide/zinc commonly align with that.`);
    } else if (skinType === 'oily' && (hasNiacinamide || hasZincPca)) {
      out.push('Fit: oily skin often uses niacinamide/zinc for oil control and the look of pores/marks.');
    } else if (barrier === 'impaired' && hasBarrierSupport) {
      out.push('Fit: this formula includes barrier-supportive humectant/soothing signals, which is useful for impaired barrier days.');
    }
  }

  const needsCaution = barrier === 'impaired' || sensitivity === 'high' || (sensitivity === 'medium' && (hasStrongActives || isHighIrr));
  if (needsCaution) {
    out.push(
      cn
        ? '使用建议：先低频、少量；若刺痛/泛红就暂停，并以修护保湿为主。'
        : 'How to use: start low and small; if stinging/redness happens, pause and focus on barrier support.',
    );
  }

  return sanitizeAssessmentNarrativeLines(out, { max: 3, allowProfileEcho: false });
}

function pickHeroIngredientFromEvidence(evidence, { lang = 'EN' } = {}) {
  const ev = asPlainObject(evidence);
  if (!ev) return null;
  const science = asPlainObject(ev.science) || {};
  const keyIngredients = readScienceKeyIngredients(science);
  if (!keyIngredients.length) return null;

  const candidates = keyIngredients
    .map((s) => (typeof s === 'string' ? s.trim() : String(s || '').trim()))
    .filter(Boolean)
    .filter((s) => !/^water$/i.test(s));
  if (!candidates.length) return null;

  const rules = [
    {
      tokens: ['tretinoin', 'adapalene', 'retinal', 'retinol'],
      role: { EN: 'retinoid', CN: '维A类' },
      why: {
        EN: 'Most effective for long-term texture/lines, but can be irritating—ramp slowly.',
        CN: '对长期纹理/抗老最有效，但刺激性可能更高——需要循序渐进。',
      },
    },
    {
      tokens: ['benzoyl peroxide'],
      role: { EN: 'anti-acne active', CN: '抗痘活性' },
      why: {
        EN: 'Can be very effective for inflammatory acne, but often drying/irritating—use carefully.',
        CN: '对炎症痘通常很有效，但容易干燥/刺激——需要谨慎使用。',
      },
    },
    {
      tokens: ['salicylic acid', 'bha', 'beta hydroxy'],
      role: { EN: 'exfoliant (BHA)', CN: '去角质（BHA）' },
      why: {
        EN: 'Helpful for pores/comedones by exfoliating inside the pore; irritation risk depends on strength/frequency.',
        CN: '对毛孔/闭口有帮助（可深入毛孔去角质）；刺激风险取决于浓度与频率。',
      },
    },
    {
      tokens: ['glycolic acid', 'aha', 'lactic acid', 'mandelic acid'],
      role: { EN: 'exfoliant (AHA)', CN: '去角质（AHA）' },
      why: {
        EN: 'Improves texture/dullness via exfoliation, but can increase sensitivity—start low and slow.',
        CN: '通过去角质改善粗糙/暗沉，但可能增加敏感——建议低频起步。',
      },
    },
    {
      tokens: ['azelaic acid'],
      role: { EN: 'multi-benefit active', CN: '多效活性' },
      why: {
        EN: 'Often useful for redness/bumps/pigmentation with a gentler profile than many acids (still patch test).',
        CN: '常用于泛红/闭口/色沉，相对更温和（但仍建议先做测试）。',
      },
    },
    {
      tokens: ['niacinamide'],
      role: { EN: 'multi-benefit active', CN: '多效活性' },
      why: {
        EN: 'Supports barrier function and can help oiliness/uneven tone in some users.',
        CN: '支持屏障功能，并可能改善出油/肤色不均（因人而异）。',
      },
    },
    {
      tokens: ['tranexamic acid'],
      role: { EN: 'brightening active', CN: '淡斑活性' },
      why: {
        EN: 'Targets discoloration/dark spots; usually well tolerated.',
        CN: '针对色沉/斑点；通常耐受性较好。',
      },
    },
    {
      tokens: ['ascorbic acid', 'vitamin c'],
      role: { EN: 'antioxidant (vitamin C)', CN: '抗氧化（维C）' },
      why: {
        EN: 'Can help brighten and protect from oxidative stress; irritation depends on form and strength.',
        CN: '可提亮并抗氧化；刺激性取决于维C形式与浓度。',
      },
    },
    {
      tokens: ['ceramide', 'ceramides'],
      role: { EN: 'barrier lipid', CN: '屏障脂质' },
      why: {
        EN: 'Supports barrier lipids and can improve tolerance/hydration over time.',
        CN: '补充屏障脂质，长期可提升耐受与保湿。',
      },
    },
    {
      tokens: ['petrolatum', 'petroleum jelly'],
      role: { EN: 'occlusive', CN: '封闭剂' },
      why: {
        EN: 'A strong occlusive that reduces water loss—often the main driver behind “barrier protection” feel.',
        CN: '强封闭成分，可减少水分流失——通常是“屏障保护感”的主要来源。',
      },
    },
    {
      tokens: ['panthenol'],
      role: { EN: 'soothing (pro‑vitamin B5)', CN: '舒缓（维B5前体）' },
      why: {
        EN: 'Helps soothe irritation and supports barrier comfort.',
        CN: '帮助舒缓刺激，并提升屏障舒适度。',
      },
    },
    {
      tokens: ['glycerin'],
      role: { EN: 'humectant', CN: '保湿剂' },
      why: {
        EN: 'A well-studied humectant that draws water into the skin to improve hydration.',
        CN: '经典保湿剂，可吸附水分提升含水量。',
      },
    },
    {
      tokens: ['hyaluronic acid', 'sodium hyaluronate'],
      role: { EN: 'humectant', CN: '保湿剂' },
      why: {
        EN: 'Hydrates by binding water; usually low irritation.',
        CN: '通过结合水分保湿；通常刺激性较低。',
      },
    },
  ];

  const lowerCandidates = candidates.map((x) => x.toLowerCase());
  const match = rules.find((r) => r.tokens.some((t) => lowerCandidates.some((c) => c.includes(t))));
  if (!match) return null;

  const langKey = String(lang).toUpperCase() === 'CN' ? 'CN' : 'EN';
  const name = candidates.find((x) => match.tokens.some((t) => x.toLowerCase().includes(t))) || candidates[0];

  return {
    name,
    role: match.role[langKey],
    why: match.why[langKey],
    source: 'heuristic',
  };
}

function buildReasonsFromEvidence(evidence, { lang = 'EN', verdict = '' } = {}) {
  const out = [];
  const ev = asPlainObject(evidence);
  if (!ev) return out;

  const evMissing = asStringArray(ev.missing_info ?? ev.missingInfo);
  if (evMissing.includes('evidence_missing')) {
    out.push(
      String(lang).toUpperCase() === 'CN'
        ? '上游未返回证据详情，因此无法给出结论背后的具体理由。'
        : 'Upstream did not return evidence details, so I cannot explain the verdict beyond its label.',
    );
    return out;
  }

  const science = asPlainObject(ev.science) || {};
  const social = asPlainObject(ev.social_signals || ev.socialSignals) || {};

  const fitNotes = asStringArray(science.fit_notes ?? science.fitNotes);
  const mechanisms = asStringArray(science.mechanisms);
  const riskNotes = asStringArray(science.risk_notes ?? science.riskNotes);
  const keyIngredients = readScienceKeyIngredients(science);

  const positives = asStringArray(social.typical_positive ?? social.typicalPositive);
  const negatives = asStringArray(social.typical_negative ?? social.typicalNegative);
  const riskForGroups = asStringArray(social.risk_for_groups ?? social.riskForGroups);

  const expertNotes = asStringArray(ev.expert_notes ?? ev.expertNotes);
  const hero = pickHeroIngredientFromEvidence(ev, { lang });

  const v = String(verdict || '').toLowerCase();
  const isNegative = v.includes('mismatch') || v.includes('avoid') || v.includes('veto') || v.includes('not');
  const isCaution = isNegative || v.includes('risky') || v.includes('caution') || v.includes('warn');

  const take = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : []);

  if (isCaution) {
    if (riskNotes.length) {
      const human = uniqueStrings(riskNotes.map((r) => humanizeRiskLine(r, lang)).filter(Boolean));
      if (human.length) out.push(...take(human, 2));
    }
    if (negatives.length) {
      out.push(
        String(lang).toUpperCase() === 'CN'
          ? `口碑（常见负向）：${take(negatives, 4).join('、')}`
          : `Social signals: common negatives — ${take(negatives, 4).join(', ')}`,
      );
    }
    if (riskForGroups.length) out.push(take(riskForGroups, 2).join('; '));
  }

  if (fitNotes.length) out.push(...take(fitNotes, 2));
  if (hero) {
    out.push(
      String(lang).toUpperCase() === 'CN'
        ? `最关键成分：${hero.name}（${hero.role}）— ${hero.why}`
        : `Most impactful ingredient: ${hero.name} (${hero.role}) — ${hero.why}`,
    );
  }
  if (mechanisms.length) out.push(...take(mechanisms, 1));

  if (!riskNotes.length) {
    out.push(
      String(lang).toUpperCase() === 'CN'
        ? '风险点：证据中未返回明确风险条目。'
        : 'No explicit risk flags were returned in the evidence.',
    );
  }

  if (positives.length) {
    out.push(
      String(lang).toUpperCase() === 'CN'
        ? `口碑（常见正向）：${take(positives, 4).join('、')}`
        : `Social signals: common positives — ${take(positives, 4).join(', ')}`,
    );
  }

  if (!hero) {
    const keyPicks = take(keyIngredients.filter((x) => !/^water$/i.test(String(x))), 4);
    if (keyPicks.length) {
      out.push(
        String(lang).toUpperCase() === 'CN'
          ? `关键成分（证据）：${keyPicks.join('、')}`
          : `Key ingredients (from evidence): ${keyPicks.join(', ')}`,
      );
    }
  }

  if (expertNotes.length) {
    out.push(
      String(lang).toUpperCase() === 'CN' ? `专家建议：${expertNotes[0]}` : `Expert notes: ${expertNotes[0]}`,
    );
  }

  return uniqueStrings(out);
}

function readAssessmentStringArray(assessment, snakeKey, camelKey) {
  return uniqueStrings(
    [
      ...asStringArray(assessment?.[snakeKey]),
      ...asStringArray(assessment?.[camelKey]),
    ].map((line) => truncateText(String(line || '').trim(), 220)).filter(Boolean),
  );
}

function buildFormulaIntentFromEvidence(evidence, { lang = 'EN' } = {}) {
  const ev = asPlainObject(evidence) || {};
  const science = asPlainObject(ev.science) || {};
  const mechanisms = asStringArray(science.mechanisms);
  const keyIngredients = readScienceKeyIngredients(science)
    .filter((item) => !/^water$/i.test(String(item || '').trim()));
  const hero = pickHeroIngredientFromEvidence(ev, { lang });
  const isCn = String(lang).toUpperCase() === 'CN';
  const out = [];
  if (mechanisms.length) out.push(...mechanisms.slice(0, 2));
  if (hero && hero.name) {
    out.push(
      isCn
        ? `核心驱动成分：${hero.name}${hero.role ? `（${hero.role}）` : ''}，主要目标是 ${hero.why || '提升配方主功效'}。`
        : `Core driver: ${hero.name}${hero.role ? ` (${hero.role})` : ''}, mainly targeting ${hero.why || 'the primary claimed effect'}.`,
    );
  }
  if (!out.length && keyIngredients.length) {
    out.push(
      isCn
        ? `这支产品主要围绕 ${keyIngredients.slice(0, 3).join('、')} 构建功效路径。`
        : `This formula mainly builds its efficacy around ${keyIngredients.slice(0, 3).join(', ')}.`,
    );
  }
  return uniqueStrings(out.map((line) => truncateText(String(line || ''), 220)).filter(Boolean)).slice(0, 3);
}

function buildBestForFromEvidence(evidence, { lang = 'EN' } = {}) {
  const ev = asPlainObject(evidence) || {};
  const science = asPlainObject(ev.science) || {};
  const fitNotes = asStringArray(science.fit_notes ?? science.fitNotes);
  if (fitNotes.length) return uniqueStrings(fitNotes.map((line) => truncateText(line, 200))).slice(0, 3);
  const isCn = String(lang).toUpperCase() === 'CN';
  return [
    isCn
      ? '若目标是稳态保养和低刺激迭代，这类配方通常更好起步。'
      : 'If your goal is steady maintenance and low-irritation iteration, this profile is usually easier to start with.',
  ];
}

function buildNotForFromEvidence(evidence, { lang = 'EN' } = {}) {
  const ev = asPlainObject(evidence) || {};
  const science = asPlainObject(ev.science) || {};
  const riskNotes = asStringArray(science.risk_notes ?? science.riskNotes);
  const human = uniqueStrings(riskNotes.map((line) => humanizeRiskLine(line, lang) || String(line || '').trim()).filter(Boolean));
  return human.slice(0, 3);
}

function buildIfNotIdealFromEvidence(evidence, { lang = 'EN' } = {}) {
  const isCn = String(lang).toUpperCase() === 'CN';
  const riskLines = buildNotForFromEvidence(evidence, { lang });
  const out = [];
  if (riskLines.length) {
    out.push(
      isCn
        ? '如果出现持续刺痛/泛红，先暂停该产品并切回温和清洁 + 修护保湿的基线。'
        : 'If persistent stinging/redness appears, pause this product and return to a gentle cleanse + barrier-repair baseline.',
    );
  }
  out.push(
    isCn
      ? '先从低频开始（每周 2-3 次），连续观察 10-14 天再决定是否加频。'
      : 'Start low-frequency (2-3x/week) and monitor for 10-14 days before increasing usage.',
  );
  return uniqueStrings(out).slice(0, 3);
}

function buildBetterPairingFromEvidence(evidence, { lang = 'EN' } = {}) {
  const ev = asPlainObject(evidence) || {};
  const science = asPlainObject(ev.science) || {};
  const riskJoined = asStringArray(science.risk_notes ?? science.riskNotes).join(' | ').toLowerCase();
  const isCn = String(lang).toUpperCase() === 'CN';
  const out = [];
  if (/\b(dry|drying|tight|dehydrat|干燥|紧绷)\b/i.test(riskJoined)) {
    out.push(
      isCn
        ? '搭配建议：加一层简单保湿修护（神经酰胺/泛醇/甘油）减少拔干风险。'
        : 'Pairing idea: add a simple barrier-hydration layer (ceramide/panthenol/glycerin) to reduce dryness risk.',
    );
  }
  if (/\b(acne|comedone|pores?|痘|闭口|毛孔)\b/i.test(riskJoined)) {
    out.push(
      isCn
        ? '若重点是控痘，优先搭配低刺激控油步骤并避免同晚叠加强活性。'
        : 'If acne control is the priority, pair with low-irritation oil-control steps and avoid same-night strong active stacking.',
    );
  }
  if (!out.length) {
    out.push(
      isCn
        ? '搭配建议：白天坚持防晒，夜间保持单变量迭代，更容易判断是否适配。'
        : 'Pairing idea: keep consistent daytime SPF and single-variable PM iteration to judge fit reliably.',
    );
  }
  return uniqueStrings(out).slice(0, 3);
}

function buildFollowUpQuestionFromPayload(payload, { lang = 'EN' } = {}) {
  const p = asPlainObject(payload) || {};
  const profilePrompt = asPlainObject(p.profile_prompt ?? p.profilePrompt) || {};
  const missingFields = uniqueStrings(asStringArray(profilePrompt.missing_fields ?? profilePrompt.missingFields));
  const isCn = String(lang).toUpperCase() === 'CN';
  if (missingFields.includes('sensitivity')) {
    return isCn
      ? '你目前的敏感度大概是低/中/高哪一档？这会直接影响频率建议。'
      : 'Would you rate your sensitivity as low/medium/high? This directly changes the usage frequency recommendation.';
  }
  if (missingFields.includes('goals')) {
    return isCn
      ? '你当前最优先是控痘、提亮还是修护？我可以据此把替代方案收敛到 2-3 个。'
      : 'What is your top priority now: acne control, brightening, or barrier repair? I can narrow alternatives to 2-3 options.';
  }
  return isCn
    ? '你更在意“更温和”还是“见效更快”？我可以按这个偏好给你下一步选项。'
    : 'Do you prefer “gentler” or “faster-visible results”? I can tune the next-step options based on that.';
}

function isProfileEchoSummaryText(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return /\b(your profile|profile priorities|你的情况|你的画像|匹配点)\b/i.test(text);
}

function buildConservativeProductSummary(evidence, { lang = 'EN' } = {}) {
  const ev = asPlainObject(evidence) || {};
  const science = asPlainObject(ev.science) || {};
  const mechanisms = asStringArray(science.mechanisms);
  const riskNotes = asStringArray(science.risk_notes ?? science.riskNotes);
  const isCn = String(lang).toUpperCase() === 'CN';
  if (mechanisms.length) {
    return isCn
      ? `该产品主要目标是：${truncateText(mechanisms[0], 140)}。`
      : `This formula mainly aims to: ${truncateText(mechanisms[0], 180)}.`;
  }
  if (riskNotes.length) {
    const risk = humanizeRiskLine(riskNotes[0], lang) || riskNotes[0];
    return isCn
      ? `该产品可用，但需关注：${truncateText(risk, 140)}。`
      : `This product can be usable, but watch for: ${truncateText(risk, 180)}.`;
  }
  return isCn
    ? '该产品可作为基础方案尝试，建议先低频并观察皮肤耐受。'
    : 'This product can be tried as a baseline option; start low-frequency and monitor tolerance.';
}

function pickAssessmentSummary({
  assessment,
  formulaIntent = [],
  evidence = null,
  reasons = [],
  lang = 'EN',
} = {}) {
  const candidates = [];
  const addCandidate = (value) => {
    const text = String(value || '').trim();
    if (!text) return;
    if (isProfileEchoSummaryText(text)) return;
    candidates.push(text);
  };
  if (asPlainObject(assessment)) {
    addCandidate(assessment.summary);
    addCandidate(assessment.quick_summary);
    addCandidate(assessment.quickSummary);
  }
  if (formulaIntent.length) addCandidate(formulaIntent[0]);
  const ev = asPlainObject(evidence) || {};
  const science = asPlainObject(ev.science) || {};
  const mechanisms = asStringArray(science.mechanisms);
  if (mechanisms.length) addCandidate(mechanisms[0]);
  for (const reason of Array.isArray(reasons) ? reasons : []) addCandidate(reason);
  if (!candidates.length) {
    return buildConservativeProductSummary(evidence, { lang });
  }
  return candidates[0];
}

function normalizeHowToUseShape(value, { lang = 'EN' } = {}) {
  if (!value) return null;
  if (Array.isArray(value)) {
    const steps = uniqueStrings(asStringArray(value).map((line) => truncateText(line, 220))).slice(0, 6);
    if (!steps.length) return null;
    return {
      steps,
      observation_window: String(lang).toUpperCase() === 'CN'
        ? '先观察 10-14 天，再决定是否加频。'
        : 'Monitor for 10-14 days before increasing frequency.',
      stop_signs: String(lang).toUpperCase() === 'CN'
        ? ['若持续刺痛/泛红/起皮，请暂停并回到温和修护。']
        : ['Pause and switch to gentle barrier support if persistent stinging/redness/peeling occurs.'],
    };
  }
  if (typeof value === 'string') {
    const note = String(value || '').trim();
    if (!note) return null;
    return {
      steps: [truncateText(note, 220)],
      observation_window: String(lang).toUpperCase() === 'CN'
        ? '先观察 10-14 天，再决定是否加频。'
        : 'Monitor for 10-14 days before increasing frequency.',
      stop_signs: String(lang).toUpperCase() === 'CN'
        ? ['若持续刺痛/泛红/起皮，请暂停并回到温和修护。']
        : ['Pause and switch to gentle barrier support if persistent stinging/redness/peeling occurs.'],
    };
  }
  const obj = asPlainObject(value);
  if (!obj) return null;
  const timing = String(obj.timing || obj.time || '').trim();
  const frequency = String(obj.frequency || '').trim();
  const steps = uniqueStrings(asStringArray(obj.steps).map((line) => truncateText(line, 220))).slice(0, 5);
  const notes = uniqueStrings(asStringArray(obj.notes).map((line) => truncateText(line, 220))).slice(0, 5);
  const mergedSteps = uniqueStrings([...steps, ...notes]).slice(0, 6);
  const observationWindow = String(obj.observation_window || obj.observationWindow || '').trim();
  const stopSigns = uniqueStrings(asStringArray(obj.stop_signs || obj.stopSigns).map((line) => truncateText(line, 220))).slice(0, 4);
  const out = {
    ...(timing ? { timing } : {}),
    ...(frequency ? { frequency } : {}),
    ...(mergedSteps.length ? { steps: mergedSteps } : {}),
    ...(observationWindow ? { observation_window: observationWindow } : {}),
    ...(stopSigns.length ? { stop_signs: stopSigns } : {}),
  };
  if (!Object.keys(out).length) return null;
  if (!out.observation_window) {
    out.observation_window = String(lang).toUpperCase() === 'CN'
      ? '先观察 10-14 天，再决定是否加频。'
      : 'Monitor for 10-14 days before increasing frequency.';
  }
  if (!Array.isArray(out.stop_signs) || !out.stop_signs.length) {
    out.stop_signs = String(lang).toUpperCase() === 'CN'
      ? ['若持续刺痛/泛红/起皮，请暂停并回到温和修护。']
      : ['Pause and switch to gentle barrier support if persistent stinging/redness/peeling occurs.'];
  }
  return out;
}

function buildHowToUseFromEvidence(evidence, { lang = 'EN' } = {}) {
  const isCn = String(lang).toUpperCase() === 'CN';
  const ev = asPlainObject(evidence) || {};
  const science = asPlainObject(ev.science) || {};
  const riskJoined = asStringArray(science.risk_notes ?? science.riskNotes).join(' | ').toLowerCase();
  const hasDrynessRisk = /\b(dry|drying|tight|dehydrat|干燥|紧绷)\b/i.test(riskJoined);
  const hasIrritationRisk = /\b(irrit|sting|burn|redness|刺激|刺痛|泛红)\b/i.test(riskJoined);
  const steps = [];
  if (isCn) {
    steps.push('按由薄到厚叠加，先保湿再封层。');
    steps.push('白天作为最后一步前请补足防晒。');
    if (hasDrynessRisk) steps.push('若出现拔干，先叠加简单保湿修护层再上该产品。');
    if (hasIrritationRisk) steps.push('先每周 2-3 次，耐受稳定后再加频。');
  } else {
    steps.push('Layer from thinnest to thickest; keep hydration before occlusive steps.');
    steps.push('Use daytime SPF as the final AM step.');
    if (hasDrynessRisk) steps.push('If dryness appears, add a simple barrier-hydration layer before this product.');
    if (hasIrritationRisk) steps.push('Start at 2-3x/week and increase only after stable tolerance.');
  }
  return {
    timing: isCn ? '早晚均可；敏感期优先夜间。' : 'AM/PM; prefer PM first during reactive phases.',
    frequency: isCn ? '先每周 2-3 次，10-14 天稳定后再决定是否加频。' : 'Start 2-3x/week; only increase after 10-14 days of stable tolerance.',
    steps: uniqueStrings(steps).slice(0, 6),
    observation_window: isCn ? '观察 10-14 天，重点看刺痛、泛红、紧绷是否下降。' : 'Observe for 10-14 days and track stinging, redness, and tightness.',
    stop_signs: isCn
      ? ['持续刺痛 >30-60 秒', '泛红/干痒持续加重', '出现明显爆痘或屏障不稳迹象']
      : ['Persistent stinging beyond 30-60 seconds', 'Worsening redness/dry itch', 'Noticeable breakout or barrier instability signals'],
  };
}

const PRODUCT_INTEL_CONTRACT_VERSION = 'aurora.product_intel.contract.v2';
const PRODUCT_INTEL_BLOCK_VERSION = 'aurora.product_intel.block.v1';

function clamp01(value) {
  const n = asNumberOrNull(value);
  if (n == null) return 0;
  return Math.max(0, Math.min(1, n));
}

function mapConfidenceLevel(score) {
  const s = clamp01(score);
  if (s >= 0.75) return 'high';
  if (s >= 0.4) return 'med';
  return 'low';
}

function buildBlockConfidence({
  coverage = 0,
  source_quality = 0.7,
  freshness = 1,
  consistency = 0.7,
  reasons = [],
  missing_fields = [],
} = {}) {
  const cv = clamp01(coverage);
  const sq = clamp01(source_quality);
  const fr = clamp01(freshness);
  const cs = clamp01(consistency);
  const score = Number((0.45 * cv + 0.2 * sq + 0.2 * fr + 0.15 * cs).toFixed(3));

  const outReasons = uniqueStrings([
    ...asStringArray(reasons),
    cv < 0.9 ? `coverage=${Math.round(cv * 100)}%` : '',
    sq < 0.9 ? `source_quality=${Math.round(sq * 100)}%` : '',
    fr < 0.95 ? `freshness=${Math.round(fr * 100)}%` : '',
    cs < 0.9 ? `consistency=${Math.round(cs * 100)}%` : '',
    missing_fields && missing_fields.length ? `missing_fields=${missing_fields.slice(0, 4).join(',')}` : '',
  ]);

  return {
    score,
    level: mapConfidenceLevel(score),
    reasons: outReasons.slice(0, 8),
  };
}

function buildEvidenceItem({
  source_type = 'expert_kb',
  source_name = null,
  url = null,
  captured_at = null,
  time_window = null,
  excerpt = '',
  data = null,
} = {}) {
  const out = {
    source_type,
    ...(source_name ? { source_name } : {}),
    ...(url ? { url } : {}),
    ...(captured_at ? { captured_at } : {}),
    ...(time_window && typeof time_window === 'object' ? { time_window } : {}),
    ...(excerpt ? { excerpt: truncateText(excerpt, 240) } : {}),
    ...(data && typeof data === 'object' && !Array.isArray(data) ? { data } : {}),
  };
  return out;
}

function normalizePlatformName(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'red') return 'XHS';
  if (s === 'reddit') return 'Reddit';
  if (s === 'tiktok') return 'TikTok';
  if (s === 'youtube') return 'YouTube';
  if (s === 'instagram') return 'Instagram';
  return raw;
}

function normalizeIngredientNameToken(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function isLikelyInvalidIngredientHeadingToken(raw) {
  const text = normalizeIngredientNameToken(raw);
  if (!text) return true;
  if (text.length < 2 || text.length > 120) return true;
  if (/^key ingredients?[:\s]?/i.test(text)) return true;
  if (/^active ingredients?[:\s]?/i.test(text)) return true;
  if (/^other ingredients?[:\s]?/i.test(text)) return true;
  if (/^ingredients?[:\s]?/i.test(text)) return true;
  if (/^full ingredients?[:\s]?/i.test(text)) return true;
  if (/^inactive ingredients?[:\s]?/i.test(text)) return true;
  if (/^contains[:\s]?/i.test(text)) return true;
  if (/^directions[:\s]?/i.test(text)) return true;
  if (/^warning[:\s]?/i.test(text)) return true;
  if (/^note[:\s]?/i.test(text)) return true;
  if (/[:\uff1a]$/.test(text)) return true;
  return false;
}

function inferIngredientFunctions(name, contextText) {
  const ingredient = normalizeIngredientNameToken(name).toLowerCase();
  const context = String(contextText || '').toLowerCase();
  const out = [];
  if (/\bniacinamide\b|烟酰胺/.test(ingredient)) out.push('barrier_support', 'oil_control', 'tone_evening');
  if (/\b(retinol|retinal|adapalene|tretinoin)\b|维a/.test(ingredient)) out.push('retinoid', 'texture_refine');
  if (/\b(hyaluronic|sodium hyaluronate|glycerin|panthenol|urea|betaine)\b|玻尿酸|甘油/.test(ingredient)) {
    out.push('humectant_hydration');
  }
  if (/\b(ceramide|cholesterol|fatty acid)\b|神经酰胺/.test(ingredient)) out.push('barrier_lipid_support');
  if (/\b(salicylic|bha|aha|pha|glycolic|lactic|mandelic)\b|果酸|水杨酸/.test(ingredient)) out.push('exfoliation');
  if (/\b(vitamin c|ascorbic|ascorbyl)\b|维c/.test(ingredient)) out.push('antioxidant_brightening');
  if (/\b(peptide)\b|肽/.test(ingredient)) out.push('peptide_support');
  if (!out.length) {
    if (/\bbarrier|repair|屏障/.test(context)) out.push('barrier_support');
    if (/\bhydrat|moisture|保湿|补水/.test(context)) out.push('humectant_hydration');
    if (/\bbright|tone|dark spot|提亮|淡斑/.test(context)) out.push('tone_evening');
  }
  return uniqueStrings(out).slice(0, 4);
}

function inferIngredientRisks(name, contextText) {
  const ingredient = normalizeIngredientNameToken(name).toLowerCase();
  const context = String(contextText || '').toLowerCase();
  const out = [];
  const hasRiskCarrier = /\b(fragrance|parfum|essential oil|limonene|linalool|citral|retinol|retinal|adapalene|tretinoin|salicylic|glycolic|lactic|mandelic|bha|aha|pha|alcohol denat|benzyl alcohol|menthol)\b|香精|精油|维a|果酸|水杨酸/.test(ingredient);
  if (/\b(fragrance|parfum|essential oil|limonene|linalool|citral|benzyl alcohol)\b|香精|精油/.test(ingredient)) out.push('fragrance');
  if (/\b(retinol|retinal|adapalene|tretinoin)\b|维a/.test(ingredient)) out.push('retinoid');
  if (/\b(salicylic|bha|aha|pha|glycolic|lactic|mandelic)\b|果酸|水杨酸/.test(ingredient)) out.push('exfoliating_acid');
  if (/\balcohol denat|denatured alcohol|menthol\b/.test(ingredient)) out.push('irritant');
  if (/\b(linalool|limonene|citral|geraniol|eugenol)\b/.test(ingredient)) out.push('allergen');
  if (/\b(comedo|pore clog|isopropyl myristate|coconut oil)\b|闷痘|爆痘/.test(ingredient)) out.push('comedogenic_risk');
  if (hasRiskCarrier && /\birritat|stinging|burn|high_irritation|刺激|刺痛|泛红/.test(context)) out.push('irritant');
  if (hasRiskCarrier && /\ballerg|敏感|过敏/.test(context)) out.push('allergen');
  return uniqueStrings(out).slice(0, 5);
}

function inferIngredientRationale(name, mechanisms = [], fitNotes = []) {
  const ingredient = normalizeIngredientNameToken(name);
  const token = ingredient.toLowerCase();
  const lines = uniqueStrings([...(Array.isArray(mechanisms) ? mechanisms : []), ...(Array.isArray(fitNotes) ? fitNotes : [])]);
  const pick = (re) => lines.find((line) => re.test(String(line || '').toLowerCase()));
  if (/\b(peptide|tripeptide|tetrapeptide|hexapeptide|pentapeptide)\b/.test(token)) {
    return pick(/\b(peptide|firm|fine lines?|wrinkle)\b/) || '';
  }
  if (/\b(hyaluronate|hyaluronic|glycerin|urea|betaine|sodium pca)\b/.test(token)) {
    return pick(/\b(hydrat|humect|moisture|water)\b/) || '';
  }
  if (/\b(ceramide|cholesterol|fatty acid|panthenol|allantoin|centella|madecassoside)\b/.test(token)) {
    return pick(/\b(barrier|repair|soothing|tolerance)\b/) || '';
  }
  if (/\b(niacinamide|ascorbic|vitamin c|tranexamic|kojic|arbutin|licorice)\b/.test(token)) {
    return pick(/\b(bright|tone|spot|even)\b/) || '';
  }
  if (/\b(retinol|retinal|adapalene|tretinoin|salicylic|glycolic|lactic|mandelic|aha|bha|pha)\b/.test(token)) {
    return pick(/\b(exfol|texture|turnover|renew|retino)\b/) || '';
  }
  return lines[0] || '';
}

const PRICE_BAND_ENUM = new Set(['budget', 'mid', 'premium', 'luxury', 'unknown']);

function normalizeCandidateSource(source) {
  const obj = asPlainObject(source);
  if (obj) {
    const type = String(obj.type || '').trim();
    if (type) {
      return {
        type,
        ...(typeof obj.name === 'string' && obj.name.trim() ? { name: obj.name.trim() } : {}),
        ...(typeof obj.url === 'string' && obj.url.trim() ? { url: obj.url.trim() } : {}),
      };
    }
  }
  if (typeof source === 'string' && source.trim()) return { type: source.trim() };
  return { type: 'unknown' };
}

function normalizeEvidenceRefs(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const obj = asPlainObject(item);
    if (obj) {
      out.push(obj);
      if (out.length >= 8) break;
      continue;
    }
    if (typeof item === 'string' && item.trim()) {
      out.push({ id: item.trim() });
      if (out.length >= 8) break;
    }
  }
  return out;
}

function normalizeSocialSummaryKeyword(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  if (text.length < 2 || text.length > 40) return '';
  if (/https?:\/\//i.test(text)) return '';
  if (/@/.test(text)) return '';
  if (/^(?:route_|dedupe_|internal_|fallback_|ref_)/i.test(text)) return '';
  if (/完美平替|100%\s*(?:相同|一样|identical|same)|miracle\s+dupe|无敌平替/i.test(text)) return '';
  return text;
}

const SOCIAL_SUMMARY_VOLUME_BUCKETS = new Set(['low', 'mid', 'high', 'unknown']);

function normalizeSocialSummaryUserVisible(raw) {
  const obj = asPlainObject(raw);
  if (!obj) return null;
  const themes = uniqueStrings(asStringArray(obj.themes)).slice(0, 3);
  if (!themes.length) return null;
  const topKeywords = uniqueStrings(
    asStringArray(obj.top_keywords)
      .map((item) => normalizeSocialSummaryKeyword(item))
      .filter(Boolean),
  ).slice(0, 6);
  const sentimentHint = typeof obj.sentiment_hint === 'string' ? obj.sentiment_hint.trim() : '';
  const volumeRaw = String(obj.volume_bucket || '').trim().toLowerCase();
  const volumeBucket = SOCIAL_SUMMARY_VOLUME_BUCKETS.has(volumeRaw) ? volumeRaw : 'unknown';
  return {
    themes,
    ...(topKeywords.length ? { top_keywords: topKeywords } : {}),
    ...(sentimentHint ? { sentiment_hint: sentimentHint } : {}),
    volume_bucket: volumeBucket,
  };
}

function inferPriceBand(rawBand, row) {
  const explicit = String(rawBand || '').trim().toLowerCase();
  if (PRICE_BAND_ENUM.has(explicit)) return explicit;
  const price = asNumberOrNull(row?.price ?? row?.price_value ?? row?.priceValue ?? row?.amount);
  if (price == null || price <= 0) return 'unknown';
  if (price < 20) return 'budget';
  if (price < 55) return 'mid';
  if (price < 110) return 'premium';
  return 'luxury';
}

function normalizeScoreBreakdown(raw, similarityHint = null) {
  const out = normalizeCanonicalScoreBreakdown(raw, { similarityHint });
  const requiredKeys = [
    'category_use_case_match',
    'ingredient_functional_similarity',
    'skin_fit_similarity',
    'social_reference_strength',
    'price_distance',
    'brand_constraint',
    'score_total',
  ];
  for (const key of requiredKeys) {
    if (out[key] == null) out[key] = 0;
  }
  if (out.quality == null) out.quality = 0;
  return out;
}

function normalizeCompetitorCandidates(rawCandidates) {
  const out = [];
  for (const item of Array.isArray(rawCandidates) ? rawCandidates : []) {
    const row = asPlainObject(item);
    if (!row) continue;
    const nameRaw = row.name ?? row.display_name ?? row.displayName;
    const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
    if (!name) continue;

    const similarityRaw = asNumberOrNull(row.similarity_score ?? row.similarityScore);
    const similarity =
      similarityRaw == null ? null : similarityRaw > 1 ? clamp01(similarityRaw / 100) : clamp01(similarityRaw);

    const whyCandidate = normalizeWhyCandidateObject(row.why_candidate ?? row.whyCandidate, {
      lang: 'EN',
    });
    const compareHighlights = uniqueStrings(asStringArray(row.compare_highlights ?? row.compareHighlights));
    const scoreBreakdown = normalizeScoreBreakdown(row.score_breakdown ?? row.scoreBreakdown, similarity);
    const source = normalizeCandidateSource(row.source ?? row.source_type ?? row.sourceType);
    const evidenceRefs = normalizeEvidenceRefs(row.evidence_refs ?? row.evidenceRefs);
    const priceBand = inferPriceBand(row.price_band ?? row.priceBand, row);
    const socialSummary = normalizeSocialSummaryUserVisible(
      row.social_summary_user_visible ?? row.socialSummaryUserVisible,
    );

    out.push({
      ...(row.product_id ? { product_id: String(row.product_id).trim() } : {}),
      ...(row.sku_id ? { sku_id: String(row.sku_id).trim() } : {}),
      ...(row.brand ? { brand: String(row.brand).trim() } : {}),
      name,
      ...(row.display_name ? { display_name: String(row.display_name).trim() } : {}),
      ...(similarity != null ? { similarity_score: similarity } : {}),
      why_candidate: whyCandidate,
      score_breakdown: scoreBreakdown,
      source,
      evidence_refs: evidenceRefs,
      price_band: priceBand,
      ...(socialSummary ? { social_summary_user_visible: socialSummary } : {}),
      ...(compareHighlights.length ? { compare_highlights: compareHighlights } : {}),
    });
    if (out.length >= 10) break;
  }
  return out;
}

function buildIngredientIntelBlock(payload, { generatedAt = new Date().toISOString() } = {}) {
  const p = asPlainObject(payload) || {};
  const ev = asPlainObject(p.evidence) || {};
  const science = asPlainObject(ev.science) || {};
  const keyIngredients = uniqueStrings(
    readScienceKeyIngredients(science)
      .map((name) => normalizeIngredientNameToken(name))
      .filter((name) => !isLikelyInvalidIngredientHeadingToken(name)),
  );
  const mechanisms = asStringArray(science.mechanisms);
  const fitNotes = asStringArray(science.fit_notes ?? science.fitNotes);
  const riskNotes = asStringArray(science.risk_notes ?? science.riskNotes);

  const missingFields = [];
  const warnings = [];
  if (!keyIngredients.length) missingFields.push('evidence.science.key_ingredients');
  if (!mechanisms.length && !fitNotes.length) warnings.push('science_mechanisms_missing');
  if (!riskNotes.length) warnings.push('risk_notes_missing');

  const contextText = uniqueStrings([...mechanisms, ...fitNotes, ...riskNotes]).join(' | ');
  const inciNormalized = keyIngredients.slice(0, 40).map((name) => ({
    inci: name,
    functions: inferIngredientFunctions(name, contextText),
    risks: inferIngredientRisks(name, contextText),
    suitability_tags: [],
  }));

  const actives = keyIngredients.slice(0, 8).map((name) => {
    const rationale = inferIngredientRationale(name, mechanisms, fitNotes);
    return {
      name,
      rationale: truncateText(
        rationale || `Evidence-derived active from science.key_ingredients (${name}).`,
        180,
      ),
    };
  });

  const redFlags = uniqueStrings([
    ...riskNotes.map((r) => humanizeRiskLine(r, 'EN')),
    ...inciNormalized.flatMap((x) => asStringArray(x.risks)),
  ]).slice(0, 8);

  const evidenceItems = [];
  if (keyIngredients.length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'expert_kb',
        source_name: 'aurora_structured',
        captured_at: generatedAt,
        excerpt: `Science key ingredients: ${keyIngredients.slice(0, 8).join(', ')}`,
        data: { key_ingredients: keyIngredients.slice(0, 16) },
      }),
    );
  }
  if (mechanisms.length || fitNotes.length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'expert_kb',
        source_name: 'aurora_structured',
        captured_at: generatedAt,
        excerpt: uniqueStrings([...mechanisms, ...fitNotes]).slice(0, 2).join(' | '),
        data: { mechanisms: mechanisms.slice(0, 8), fit_notes: fitNotes.slice(0, 8) },
      }),
    );
  }
  if (riskNotes.length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'expert_kb',
        source_name: 'aurora_structured',
        captured_at: generatedAt,
        excerpt: `Risk notes: ${riskNotes.slice(0, 3).join(' | ')}`,
        data: { risk_notes: riskNotes.slice(0, 8) },
      }),
    );
  }

  const confidence = buildBlockConfidence({
    coverage: (keyIngredients.length ? 0.55 : 0) + (mechanisms.length || fitNotes.length ? 0.25 : 0) + (riskNotes.length ? 0.2 : 0),
    source_quality: keyIngredients.length ? 0.82 : 0.55,
    freshness: 0.9,
    consistency: 0.76,
    reasons: ['evidence_first=science'],
    missing_fields: missingFields,
  });

  return {
    block: {
      ...(keyIngredients.length ? { inci_raw: keyIngredients.join(', ') } : {}),
      ...(inciNormalized.length ? { inci_normalized: inciNormalized } : { inci_normalized: [] }),
      ...(actives.length ? { actives } : { actives: [] }),
      ...(redFlags.length ? { red_flags: redFlags } : { red_flags: [] }),
      _meta: {
        generated_at: generatedAt,
        freshness_ttl_hours: 24 * 14,
        version: PRODUCT_INTEL_BLOCK_VERSION,
        confidence,
        evidence: evidenceItems,
        ...(missingFields.length ? { missing_fields: missingFields } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
    },
    confidence,
  };
}

function buildSkinFitBlock(payload, { profileSummary = null, generatedAt = new Date().toISOString() } = {}) {
  const p = asPlainObject(payload) || {};
  const ev = asPlainObject(p.evidence) || {};
  const science = asPlainObject(ev.science) || {};
  const assessment = asPlainObject(p.assessment) || {};
  const profile = asPlainObject(profileSummary ?? p.profile_summary ?? p.profileSummary) || {};

  const verdict = String(assessment.verdict || '').trim().toLowerCase();
  const reasons = asStringArray(assessment.reasons);
  const howToUse = asStringArray(assessment.how_to_use ?? assessment.howToUse);
  const riskNotes = asStringArray(science.risk_notes ?? science.riskNotes);
  const scienceKeyIngredients = readScienceKeyIngredients(science);
  const scienceMechanisms = asStringArray(science.mechanisms);
  const scienceFitNotes = asStringArray(science.fit_notes ?? science.fitNotes);
  const hasScienceEvidence =
    scienceKeyIngredients.length > 0 ||
    scienceMechanisms.length > 0 ||
    scienceFitNotes.length > 0 ||
    riskNotes.length > 0;
  const hasOnlyTemplateReasons =
    reasons.length > 0 &&
    reasons.every((line) => {
      const text = String(line || '').trim();
      if (!text) return true;
      if (isGenericReason(text, 'EN')) return true;
      return /(unknown|insufficient evidence|cannot complete|无法|证据不足|证据链|结论暂时为未知)/i.test(text);
    });

  const profileSkinType = typeof profile.skinType === 'string' ? profile.skinType.trim() : '';
  const profileSensitivity = typeof profile.sensitivity === 'string' ? profile.sensitivity.trim().toLowerCase() : '';
  const profileBarrier = typeof profile.barrierStatus === 'string' ? profile.barrierStatus.trim().toLowerCase() : '';
  const profileGoals = asStringArray(profile.goals);

  const riskJoined = uniqueStrings(riskNotes.map((x) => String(x || '').toLowerCase())).join(' | ');
  const hasIrritationRisk = /\birrit|sting|burn|high_irritation|刺激|刺痛|泛红/.test(riskJoined);
  const hasFragranceRisk = /\bfragrance|parfum|essential oil|香精|精油/.test(riskJoined);
  const isCautionVerdict = /\b(caution|avoid|mismatch|risky|unknown|不适配|谨慎|未知)\b/.test(verdict);

  const suitableFor = [];
  if (profileSkinType && !isCautionVerdict) suitableFor.push(profileSkinType);
  if (profileGoals.length && !isCautionVerdict) suitableFor.push(...profileGoals.map((g) => `goal:${g}`));

  const notRecommendedFor = [];
  if (hasIrritationRisk || profileSensitivity === 'high') notRecommendedFor.push('high_sensitivity');
  if (hasIrritationRisk || profileBarrier === 'impaired') notRecommendedFor.push('impaired_barrier');
  if (hasFragranceRisk) notRecommendedFor.push('fragrance_sensitive');

  const contraindications = [];
  if (hasIrritationRisk) {
    contraindications.push({
      condition: 'high_sensitivity_or_impaired_barrier',
      why: truncateText(
        reasons[0] || riskNotes[0] || 'Irritation signal found in science risk notes; ramp slowly and patch test.',
        200,
      ),
    });
  }
  if (hasFragranceRisk) {
    contraindications.push({
      condition: 'fragrance_sensitivity',
      why: truncateText(riskNotes.find((x) => /fragrance|parfum|香精|精油/i.test(String(x || ''))) || 'Fragrance-related risk token found.', 200),
    });
  }

  const routineTips = uniqueStrings([
    ...howToUse,
    ...(hasIrritationRisk ? ['Start with low frequency and pause if stinging/redness occurs.'] : []),
  ]).slice(0, 5);

  const missingFields = [];
  if (!profileSkinType) missingFields.push('profile.skinType');
  if (!profileSensitivity) missingFields.push('profile.sensitivity');
  if (!profileBarrier) missingFields.push('profile.barrierStatus');
  if (!reasons.length && !riskNotes.length) missingFields.push('assessment.reasons_or_science.risk_notes');

  const warnings = [];
  if (!profileGoals.length) warnings.push('profile.goals_missing');
  const evidenceGateApplied = !hasScienceEvidence || hasOnlyTemplateReasons;
  if (evidenceGateApplied) warnings.push('skin_fit_evidence_gate_applied');

  const evidenceItems = [];
  if (reasons.length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'expert_kb',
        source_name: 'aurora_assessment',
        captured_at: generatedAt,
        excerpt: reasons.slice(0, 2).join(' | '),
        data: { assessment_reasons: reasons.slice(0, 6), verdict: assessment.verdict || null },
      }),
    );
  }
  if (riskNotes.length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'expert_kb',
        source_name: 'aurora_science',
        captured_at: generatedAt,
        excerpt: `Risk notes: ${riskNotes.slice(0, 3).join(' | ')}`,
        data: { risk_notes: riskNotes.slice(0, 8) },
      }),
    );
  }
  if (profileSkinType || profileSensitivity || profileBarrier || profileGoals.length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'catalog',
        source_name: 'user_profile',
        captured_at: generatedAt,
        excerpt: `Profile context: skinType=${profileSkinType || 'unknown'}, sensitivity=${profileSensitivity || 'unknown'}, barrier=${profileBarrier || 'unknown'}`,
        data: {
          skinType: profileSkinType || null,
          sensitivity: profileSensitivity || null,
          barrierStatus: profileBarrier || null,
          goals: profileGoals,
        },
      }),
    );
  }

  let confidence = buildBlockConfidence({
    coverage: (() => {
      const base = (reasons.length ? 0.4 : 0) + (riskNotes.length ? 0.25 : 0) + (profileSkinType || profileSensitivity || profileBarrier ? 0.35 : 0);
      if (!evidenceGateApplied) return base;
      return Math.min(base, hasScienceEvidence ? 0.58 : 0.36);
    })(),
    source_quality: evidenceGateApplied ? (hasScienceEvidence ? 0.62 : 0.5) : 0.74,
    freshness: 0.92,
    consistency: evidenceGateApplied
      ? Math.min(hasIrritationRisk && !isCautionVerdict ? 0.62 : 0.72, hasScienceEvidence ? 0.64 : 0.55)
      : hasIrritationRisk && !isCautionVerdict
        ? 0.62
        : 0.72,
    reasons: ['rules_first=skin_fit', ...(evidenceGateApplied ? ['evidence_gate=science_sparse'] : [])],
    missing_fields: missingFields,
  });
  if (evidenceGateApplied) {
    const ceiling = hasScienceEvidence ? 0.58 : 0.42;
    if (Number(confidence.score) > ceiling) {
      confidence = {
        ...confidence,
        score: Number(ceiling.toFixed(3)),
        level: mapConfidenceLevel(ceiling),
        reasons: uniqueStrings([
          ...asStringArray(confidence.reasons),
          hasScienceEvidence ? 'confidence_ceiling=58%' : 'confidence_ceiling=42%',
        ]).slice(0, 8),
      };
    }
  }

  return {
    block: {
      suitable_for: uniqueStrings(suitableFor).slice(0, 8),
      not_recommended_for: uniqueStrings(notRecommendedFor).slice(0, 8),
      contraindications: contraindications.slice(0, 6),
      ...(routineTips.length ? { routine_tips: routineTips } : { routine_tips: [] }),
      _meta: {
        generated_at: generatedAt,
        freshness_ttl_hours: 24 * 14,
        version: PRODUCT_INTEL_BLOCK_VERSION,
        confidence,
        evidence: evidenceItems,
        ...(missingFields.length ? { missing_fields: missingFields } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
    },
    confidence,
  };
}

function buildSocialSignalsBlock(payload, { generatedAt = new Date().toISOString() } = {}) {
  const p = asPlainObject(payload) || {};
  const ev = asPlainObject(p.evidence) || {};
  const social = asPlainObject(ev.social_signals || ev.socialSignals) || {};

  const platformScores = asRecordOfNumbers(social.platform_scores ?? social.platformScores) || {};
  const positives = asStringArray(social.typical_positive ?? social.typicalPositive);
  const negatives = asStringArray(social.typical_negative ?? social.typicalNegative);
  const riskForGroups = asStringArray(social.risk_for_groups ?? social.riskForGroups);

  const platforms = [];
  for (const [rawName, rawScore] of Object.entries(platformScores)) {
    const name = normalizePlatformName(rawName);
    if (!name || String(rawName).toLowerCase() === 'burn_rate') continue;
    const score01 = rawScore > 1 ? clamp01(rawScore / 100) : clamp01(rawScore);
    platforms.push({
      name,
      mention_count: null,
      sample_size: null,
      time_window: null,
      sentiment: {
        pos: Number(score01.toFixed(3)),
        neu: Number(Math.max(0, 1 - score01).toFixed(3)),
        neg: 0,
      },
      top_topics: positives.slice(0, 4).map((topic) => ({ topic, count: null, polarity: 'pos' })),
      risk_terms: riskForGroups.slice(0, 4).map((term) => ({ term, count: null })),
    });
  }

  const missingFields = [];
  if (!Object.keys(platformScores).length) missingFields.push('evidence.social_signals.platform_scores');
  if (!positives.length && !negatives.length) missingFields.push('evidence.social_signals.topics');
  if (!riskForGroups.length) missingFields.push('evidence.social_signals.risk_for_groups');

  const warnings = [];
  if (platforms.length) warnings.push('social_sample_size_missing');
  warnings.push('social_time_window_missing');

  const evidenceItems = [];
  if (Object.keys(platformScores).length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'social',
        source_name: 'aurora_social_signals',
        captured_at: generatedAt,
        excerpt: `Platform scores: ${Object.entries(platformScores)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')}`,
        data: { platform_scores: platformScores },
      }),
    );
  }
  if (positives.length || negatives.length || riskForGroups.length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: 'social',
        source_name: 'aurora_social_signals',
        captured_at: generatedAt,
        excerpt: uniqueStrings([
          positives.length ? `Positive: ${positives.slice(0, 3).join(', ')}` : '',
          negatives.length ? `Negative: ${negatives.slice(0, 3).join(', ')}` : '',
          riskForGroups.length ? `Risk groups: ${riskForGroups.slice(0, 2).join(', ')}` : '',
        ]).join(' | '),
        data: {
          typical_positive: positives.slice(0, 8),
          typical_negative: negatives.slice(0, 8),
          risk_for_groups: riskForGroups.slice(0, 8),
        },
      }),
    );
  }

  const confidence = buildBlockConfidence({
    coverage: (Object.keys(platformScores).length ? 0.45 : 0) + (positives.length || negatives.length ? 0.3 : 0) + (riskForGroups.length ? 0.25 : 0),
    source_quality: Object.keys(platformScores).length ? 0.58 : 0.46,
    freshness: 0.7,
    consistency: 0.66,
    reasons: ['social_aggregation=partial'],
    missing_fields: missingFields,
  });

  return {
    block: {
      platforms,
      overall_summary: {
        top_pos_themes: positives.slice(0, 5),
        top_neg_themes: negatives.slice(0, 5),
        watchouts: riskForGroups.slice(0, 5),
      },
      _meta: {
        generated_at: generatedAt,
        freshness_ttl_hours: 48,
        version: PRODUCT_INTEL_BLOCK_VERSION,
        confidence,
        evidence: evidenceItems,
        ...(missingFields.length ? { missing_fields: missingFields } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
    },
    confidence,
  };
}

function readRecoRawBlock(payload, blockName) {
  const p = asPlainObject(payload) || {};
  if (blockName === 'related_products') return asPlainObject(p.related_products ?? p.relatedProducts);
  if (blockName === 'dupes') return asPlainObject(p.dupes);
  return asPlainObject(p.competitors);
}

function buildRecoCandidatesBlock(
  payload,
  {
    blockName = 'competitors',
    generatedAt = new Date().toISOString(),
    sourceType = 'catalog',
    sourceName = 'aurora_reco_candidates',
    reasons = [],
    sourceQualityWhenPresent = 0.68,
    sourceQualityWhenMissing = 0.48,
    missingWarning = '',
  } = {},
) {
  const p = asPlainObject(payload) || {};
  const blockRaw = readRecoRawBlock(p, blockName);
  const candidatesIn = normalizeCompetitorCandidates(blockRaw?.candidates);
  const assessment = asPlainObject(p.assessment) || {};
  const anchor = asPlainObject(assessment.anchor_product || assessment.anchorProduct) || null;

  const missingFields = [];
  if (!candidatesIn.length) missingFields.push(`${blockName}.candidates`);

  const warnings = [];
  if (!candidatesIn.length && anchor && missingWarning) warnings.push(missingWarning);

  const evidenceItems = [];
  if (candidatesIn.length) {
    evidenceItems.push(
      buildEvidenceItem({
        source_type: sourceType,
        source_name: sourceName,
        captured_at: generatedAt,
        excerpt: `Candidates: ${candidatesIn.slice(0, 3).map((x) => x.name).join(', ')}`,
        data: { candidates: candidatesIn.slice(0, 8) },
      }),
    );
  }

  const confidence = buildBlockConfidence({
    coverage: candidatesIn.length ? Math.min(1, 0.5 + Math.min(0.5, candidatesIn.length * 0.1)) : 0.2,
    source_quality: candidatesIn.length ? sourceQualityWhenPresent : sourceQualityWhenMissing,
    freshness: 0.86,
    consistency: 0.72,
    reasons,
    missing_fields: missingFields,
  });

  return {
    block: {
      candidates: candidatesIn,
      _meta: {
        generated_at: generatedAt,
        freshness_ttl_hours: 24 * 7,
        version: PRODUCT_INTEL_BLOCK_VERSION,
        confidence,
        evidence: evidenceItems,
        ...(missingFields.length ? { missing_fields: missingFields } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
    },
    confidence,
  };
}

function buildCompetitorsBlock(payload, { generatedAt = new Date().toISOString() } = {}) {
  return buildRecoCandidatesBlock(payload, {
    blockName: 'competitors',
    generatedAt,
    sourceType: 'catalog',
    sourceName: 'aurora_reco_competitors',
    reasons: ['competitor_recall=reco_blocks_router'],
    sourceQualityWhenPresent: 0.68,
    sourceQualityWhenMissing: 0.48,
    missingWarning: 'no_competitor_candidates_from_upstream',
  });
}

function buildRelatedProductsBlock(payload, { generatedAt = new Date().toISOString() } = {}) {
  return buildRecoCandidatesBlock(payload, {
    blockName: 'related_products',
    generatedAt,
    sourceType: 'catalog',
    sourceName: 'aurora_related_products',
    reasons: ['related_products=upstream_or_router'],
    sourceQualityWhenPresent: 0.64,
    sourceQualityWhenMissing: 0.44,
    missingWarning: 'related_products_missing',
  });
}

function buildDupesBlock(payload, { generatedAt = new Date().toISOString() } = {}) {
  return buildRecoCandidatesBlock(payload, {
    blockName: 'dupes',
    generatedAt,
    sourceType: 'catalog',
    sourceName: 'aurora_dupe_candidates',
    reasons: ['dupes=upstream_or_router'],
    sourceQualityWhenPresent: 0.66,
    sourceQualityWhenMissing: 0.46,
    missingWarning: 'dupes_missing',
  });
}

function buildBlockMissingInfo(blockName, blockMeta) {
  const out = [];
  const meta = asPlainObject(blockMeta) || {};
  const missing = asStringArray(meta.missing_fields ?? meta.missingFields);
  if (missing.length) {
    for (const field of missing.slice(0, 5)) {
      const token = String(field || '').trim();
      if (!token) continue;
      out.push(token.startsWith(`${blockName}.`) ? token : `${blockName}.${token}`);
    }
  }
  const confidence = asPlainObject(meta.confidence) || {};
  const level = String(confidence.level || '').trim().toLowerCase();
  if (level === 'low') out.push(`${blockName}_low_confidence`);
  return uniqueStrings(out);
}

function buildProductIntelContract(payload, { lang = 'EN', profileSummary = null } = {}) {
  const p = asPlainObject(payload);
  if (!p) return null;
  const generatedAt = new Date().toISOString();

  const ingredientOut = buildIngredientIntelBlock(p, { generatedAt });
  const skinFitOut = buildSkinFitBlock(p, { profileSummary, generatedAt });
  const socialOut = buildSocialSignalsBlock(p, { generatedAt });
  const competitorsOut = buildCompetitorsBlock(p, { generatedAt });
  const relatedOut = buildRelatedProductsBlock(p, { generatedAt });
  const dupesOut = buildDupesBlock(p, { generatedAt });

  const assessment = asPlainObject(p.assessment) || {};
  const anchorProduct = asPlainObject(assessment.anchor_product || assessment.anchorProduct) || asPlainObject(p.product) || null;
  const sourceMeta = asPlainObject(p.source_meta ?? p.sourceMeta) || {};

  const confidenceByBlock = {
    ingredient_intel: ingredientOut.confidence,
    skin_fit: skinFitOut.confidence,
    social_signals: socialOut.confidence,
    competitors: competitorsOut.confidence,
    related_products: relatedOut.confidence,
    dupes: dupesOut.confidence,
  };

  const missingInfo = uniqueStrings([
    ...buildBlockMissingInfo('ingredient_intel', ingredientOut.block?._meta),
    ...buildBlockMissingInfo('skin_fit', skinFitOut.block?._meta),
    ...buildBlockMissingInfo('social_signals', socialOut.block?._meta),
    ...buildBlockMissingInfo('competitors', competitorsOut.block?._meta),
    ...buildBlockMissingInfo('related_products', relatedOut.block?._meta),
    ...buildBlockMissingInfo('dupes', dupesOut.block?._meta),
  ]);

  const provenance = {
    generated_at: generatedAt,
    contract_version: PRODUCT_INTEL_CONTRACT_VERSION,
    pipeline: 'aurora_product_intel_main_path',
    source:
      (typeof sourceMeta.analyzer === 'string' && sourceMeta.analyzer.trim()) ||
      (typeof sourceMeta.source === 'string' && sourceMeta.source.trim()) ||
      'aurora_bff_normalize',
    validation_mode: 'soft_fail',
  };

  return {
    version: PRODUCT_INTEL_CONTRACT_VERSION,
    ...(anchorProduct ? { product: anchorProduct } : {}),
    ingredient_intel: ingredientOut.block,
    skin_fit: skinFitOut.block,
    social_signals: socialOut.block,
    competitors: competitorsOut.block,
    related_products: relatedOut.block,
    dupes: dupesOut.block,
    confidence_by_block: confidenceByBlock,
    provenance,
    missing_info: missingInfo,
    missing_info_internal: missingInfo,
    language: String(lang || 'EN').toUpperCase() === 'CN' ? 'CN' : 'EN',
  };
}

function attachProductIntelContract(payload, { lang = 'EN', profileSummary = null } = {}) {
  const p = asPlainObject(payload);
  if (!p) return payload;
  const intel = buildProductIntelContract(p, { lang, profileSummary });
  if (!intel) return payload;
  const inputProvenance = asPlainObject(p.provenance) || {};
  const mergedProvenance = {
    ...intel.provenance,
    ...inputProvenance,
    generated_at:
      (typeof inputProvenance.generated_at === 'string' && inputProvenance.generated_at.trim()) ||
      intel.provenance.generated_at,
    contract_version: intel.provenance.contract_version,
    pipeline:
      (typeof inputProvenance.pipeline === 'string' && inputProvenance.pipeline.trim()) ||
      intel.provenance.pipeline,
    source:
      (typeof inputProvenance.source === 'string' && inputProvenance.source.trim()) ||
      intel.provenance.source,
    validation_mode:
      (typeof inputProvenance.validation_mode === 'string' && inputProvenance.validation_mode.trim()) ||
      intel.provenance.validation_mode,
  };
  const inputConfidenceByBlock = asPlainObject(p.confidence_by_block || p.confidenceByBlock) || {};
  const mergedConfidenceByBlock = {
    ...(asPlainObject(intel.confidence_by_block) || {}),
  };
  for (const [key, value] of Object.entries(inputConfidenceByBlock)) {
    if (!key) continue;
    if (!asPlainObject(value)) continue;
    mergedConfidenceByBlock[key] = value;
  }

  const mergedDebugCodes = uniqueStrings([
    ...asStringArray(p.missing_info ?? p.missingInfo),
    ...asStringArray(p.user_facing_gaps ?? p.userFacingGaps),
    ...asStringArray(p.internal_debug_codes ?? p.internalDebugCodes),
    ...asStringArray(p.missing_info_internal ?? p.missingInfoInternal),
    ...asStringArray(intel.missing_info),
    ...asStringArray(intel.missing_info_internal),
  ]);
  const gaps = splitProductAnalysisGaps(mergedDebugCodes);

  return {
    ...p,
    ...(intel.product ? { product: intel.product } : {}),
    ingredient_intel: intel.ingredient_intel,
    skin_fit: intel.skin_fit,
    social_signals: intel.social_signals,
    competitors: intel.competitors,
    related_products: intel.related_products,
    dupes: intel.dupes,
    confidence_by_block: mergedConfidenceByBlock,
    provenance: mergedProvenance,
    product_intel_contract_version: intel.version,
    missing_info: gaps.missing_info,
    user_facing_gaps: gaps.user_facing_gaps,
    internal_debug_codes: gaps.internal_debug_codes,
    missing_info_internal: gaps.missing_info_internal,
    ...(gaps.profile_prompt ? { profile_prompt: gaps.profile_prompt } : {}),
  };
}

function enrichProductAnalysisPayload(payload, { lang = 'EN', profileSummary = null } = {}) {
  const basePayload = asPlainObject(payload);
  if (!basePayload) return payload;
  const p = reconcileProductAnalysisConsistency(basePayload, { lang });
  const internalDebugCodes = uniqueStrings(asStringArray(p.internal_debug_codes ?? p.internalDebugCodes));
  const assessment = asPlainObject(p.assessment);
  if (!assessment) {
    const fallbackAnchor = asPlainObject(p.product);
    const fallbackPayload = {
      ...p,
      assessment: {
        verdict: String(lang).toUpperCase() === 'CN' ? '未知' : 'Unknown',
        reasons: buildAssessmentUnknownReasonFallback(lang),
        ...(fallbackAnchor ? { anchor_product: fallbackAnchor } : {}),
      },
    };
    return reconcileProductAnalysisConsistency(
      attachProductIntelContract(fallbackPayload, { lang, profileSummary }),
      { lang },
    );
  }

  const verdict =
    typeof assessment.verdict === 'string' ? assessment.verdict.trim() : String(assessment.verdict || '').trim();
  const hasTemplateSectionsFromModel =
    readAssessmentStringArray(assessment, 'formula_intent', 'formulaIntent').length > 0 ||
    readAssessmentStringArray(assessment, 'best_for', 'bestFor').length > 0 ||
    readAssessmentStringArray(assessment, 'not_for', 'notFor').length > 0 ||
    readAssessmentStringArray(assessment, 'if_not_ideal', 'ifNotIdeal').length > 0 ||
    readAssessmentStringArray(assessment, 'better_pairing', 'betterPairing').length > 0;

  const existingReasons = sanitizeAssessmentNarrativeLines(asStringArray(assessment.reasons), {
    max: 10,
    allowProfileEcho: false,
  }).filter((line) => !isDiagnosticNarrativeLine(line));
  const keptReasons = existingReasons
    .filter((r) => !isGenericReason(r, lang))
    .map((r) => truncateText(r, 200))
    .filter(Boolean);

  const minReasons = 2;
  const maxReasons = 5;

  let reasons = keptReasons.slice();

  // Optional: inject profile-fit explanations when profile context is available (chat/product-analyze flows).
  const profileReasons = hasTemplateSectionsFromModel
    ? []
    : buildProfileFitReasons(profileSummary ?? p.profile_summary ?? p.profileSummary ?? null, p.evidence, { lang });
  let profileReasonsUsed = 0;
  if (profileReasons.length) {
    // CN users often receive mixed-language upstream reasons; prefer CN-ish reasons when we have them.
    if (String(lang).toUpperCase() === 'CN') {
      const hasCn = profileReasons.some((r) => /[\u4e00-\u9fff]/.test(String(r || '')));
      if (hasCn) reasons = reasons.filter((r) => !isMostlyEnglishText(r));
    }
    // Prepend, but keep room for the hero ingredient line (added later) when possible.
    const budget = Math.max(1, maxReasons - 1);
    const pre = profileReasons.slice(0, budget);
    profileReasonsUsed = pre.length;
    reasons = uniqueStrings([...pre, ...reasons]).slice(0, maxReasons);
  }

  // Remove raw risk-code fragments that are not user-readable.
  reasons = uniqueStrings(
    reasons
      .map((r) => {
        const hr = humanizeRiskLine(r, lang);
        return hr || r;
      })
      .filter((r) => {
        const t = String(r || '').trim();
        if (!t) return false;
        if (/^[a-z0-9]+(_[a-z0-9]+)+$/i.test(t)) return false;
        return true;
      })
      .filter((line) => !isDiagnosticNarrativeLine(line)),
  ).slice(0, maxReasons);
  reasons = sanitizeAssessmentNarrativeLines(reasons, { max: maxReasons, allowProfileEcho: false });

  if (reasons.length < minReasons) {
    const derived = buildReasonsFromEvidence(p.evidence, { lang, verdict });
    for (const r of derived) {
      if (!r) continue;
      if (isDiagnosticNarrativeLine(r)) continue;
      if (reasons.includes(r)) continue;
      reasons.push(r);
      if (reasons.length >= maxReasons) break;
    }
  }

  if (!reasons.length) {
    const isUnknownVerdict = (() => {
      const verdictToken = String(assessment.verdict || '').trim().toLowerCase();
      return verdictToken === 'unknown' || verdictToken === '未知';
    })();
    if (isUnknownVerdict) reasons = buildAssessmentUnknownReasonFallback(lang);
    else {
      reasons = [
        String(lang).toUpperCase() === 'CN'
          ? '当前证据细节不足（上游仅返回结论标签）。'
          : 'Current evidence details are insufficient (upstream returned verdict label only).',
      ];
    }
  }

  const heroExisting = assessment.hero_ingredient ?? assessment.heroIngredient ?? null;
  const hero = heroExisting && typeof heroExisting === 'object' ? heroExisting : pickHeroIngredientFromEvidence(p.evidence, { lang });

  if (hero && typeof hero === 'object' && hero.name && hero.why && Array.isArray(reasons) && reasons.length < maxReasons) {
    const heroName = String(hero.name).toLowerCase();
    const alreadyMentioned = reasons.some((r) => String(r || '').toLowerCase().includes(heroName));
    if (!alreadyMentioned) {
      const heroLine =
        String(lang).toUpperCase() === 'CN'
          ? `最关键成分：${hero.name}（${hero.role || '未知'}）— ${hero.why}`
          : `Most impactful ingredient: ${hero.name} (${hero.role || 'unknown'}) — ${hero.why}`;
      // If we have profile-fit reasons, keep them as the top lines (more user-specific),
      // then insert hero ingredient after them.
      if (profileReasonsUsed > 0) {
        const idx = Math.max(0, Math.min(profileReasonsUsed, reasons.length));
        reasons.splice(idx, 0, heroLine);
      } else {
        reasons.unshift(heroLine);
      }
    }
  }

  const formulaIntentExisting = readAssessmentStringArray(assessment, 'formula_intent', 'formulaIntent');
  const formulaIntent = formulaIntentExisting.length
    ? formulaIntentExisting.slice(0, 3)
    : buildFormulaIntentFromEvidence(p.evidence, { lang });
  const summaryRaw = pickAssessmentSummary({
    assessment,
    formulaIntent,
    evidence: p.evidence,
    reasons,
    lang,
  });
  const summary = truncateText(String(summaryRaw || '').trim(), 260) || '';
  const summarySanitized =
    summary &&
    isProfileEchoSummaryText(String(assessment.summary ?? assessment.quick_summary ?? assessment.quickSummary ?? '')) &&
    !isProfileEchoSummaryText(summary);
  if (summarySanitized) internalDebugCodes.push('summary_profile_echo_sanitized');
  const bestForExisting = readAssessmentStringArray(assessment, 'best_for', 'bestFor');
  const bestFor = sanitizeAssessmentNarrativeLines(bestForExisting.length
    ? bestForExisting.slice(0, 3)
    : buildBestForFromEvidence(p.evidence, { lang }).slice(0, 3), { max: 3, allowProfileEcho: false });
  const notForExisting = readAssessmentStringArray(assessment, 'not_for', 'notFor');
  const notFor = notForExisting.length
    ? notForExisting.slice(0, 3)
    : buildNotForFromEvidence(p.evidence, { lang }).slice(0, 3);
  const ifNotIdealExisting = readAssessmentStringArray(assessment, 'if_not_ideal', 'ifNotIdeal');
  const ifNotIdeal = ifNotIdealExisting.length
    ? ifNotIdealExisting.slice(0, 3)
    : buildIfNotIdealFromEvidence(p.evidence, { lang }).slice(0, 3);
  const betterPairingExisting = readAssessmentStringArray(assessment, 'better_pairing', 'betterPairing');
  const betterPairing = betterPairingExisting.length
    ? betterPairingExisting.slice(0, 3)
    : buildBetterPairingFromEvidence(p.evidence, { lang }).slice(0, 3);
  const followUpQuestion = truncateText(
    String(assessment.follow_up_question || assessment.followUpQuestion || '').trim(),
    220,
  ) || buildFollowUpQuestionFromPayload(p, { lang });
  const howToUseNormalized =
    normalizeHowToUseShape(assessment.how_to_use ?? assessment.howToUse, { lang }) ||
    buildHowToUseFromEvidence(p.evidence, { lang });

  const finalizedReasons = uniqueStrings(
    reasons.filter((line) => !isDiagnosticNarrativeLine(line)),
  ).slice(0, maxReasons);
  if (!finalizedReasons.length) {
    finalizedReasons.push(
      summary ||
        (String(lang).toUpperCase() === 'CN'
          ? '当前证据不足，请补充更多证据信息后再判断。'
          : 'Current evidence details are insufficient; please provide more evidence.'),
    );
  }

  const outAssessment = {
    ...assessment,
    ...(hero && typeof hero === 'object' ? { hero_ingredient: hero } : {}),
    ...(summary ? { summary } : {}),
    ...(formulaIntent.length ? { formula_intent: formulaIntent } : {}),
    ...(bestFor.length ? { best_for: bestFor } : {}),
    ...(notFor.length ? { not_for: notFor } : {}),
    ...(ifNotIdeal.length ? { if_not_ideal: ifNotIdeal } : {}),
    ...(betterPairing.length ? { better_pairing: betterPairing } : {}),
    ...(followUpQuestion ? { follow_up_question: followUpQuestion } : {}),
    ...(howToUseNormalized ? { how_to_use: howToUseNormalized } : {}),
    reasons: finalizedReasons,
  };
  return reconcileProductAnalysisConsistency(
    attachProductIntelContract(
      {
        ...p,
        assessment: outAssessment,
        ...(internalDebugCodes.length ? { internal_debug_codes: uniqueStrings(internalDebugCodes) } : {}),
      },
      { lang, profileSummary },
    ),
    { lang },
  );
}

function normalizeDupeCompare(raw) {
  const _stubObj = (reason) => ({
    _stub: true,
    anchor_resolution_status: 'failed',
    anchor_resolution_reason: reason,
  });
  const unwrapProductLike = (value) => {
    const obj = asPlainObject(value);
    if (!obj) return null;
    return asPlainObject(obj.product) || asPlainObject(obj.sku) || obj;
  };

  const o = asPlainObject(raw);
  if (!o) {
    const evOut = normalizeEvidence(null);
    return {
      payload: {
        original: _stubObj('upstream_missing_or_unstructured'),
        dupe: _stubObj('upstream_missing_or_unstructured'),
        tradeoffs: [],
        evidence: evOut.evidence,
        confidence: null,
        missing_info: uniqueStrings(['upstream_missing_or_unstructured', ...(evOut.evidence?.missing_info || [])]),
      },
      field_missing: [{ field: 'tradeoffs', reason: 'upstream_missing_or_unstructured' }, ...evOut.field_missing],
    };
  }

  const field_missing = [];

  const original = unwrapProductLike(o.original || o.original_product || o.originalProduct)
    || _stubObj('upstream_missing');
  const dupe = unwrapProductLike(o.dupe || o.dupe_product || o.dupeProduct)
    || _stubObj('upstream_missing');

  const similarityRaw = asNumberOrNull(
    o.similarity
      ?? o.similarity_score
      ?? o.similarityScore
      ?? o.dupe?.similarity_score
      ?? o.dupe?.similarityScore,
  );
  const similarity = similarityRaw == null ? null : similarityRaw > 1 ? similarityRaw : similarityRaw * 100;

  const tradeoffsRaw = Array.isArray(o.tradeoffs) ? o.tradeoffs : [];
  const tradeoffsDetailRaw = asPlainObject(o.tradeoffs_detail || o.tradeoffsDetail) || null;
  const tradeoffStrings = Array.isArray(o.tradeoffs)
    ? asStringArray(tradeoffsRaw.filter((item) => typeof item === 'string'))
    : asStringArray(o.tradeoffs);
  const primaryTradeoff = normalizeDupeCompareTradeoff(tradeoffsDetailRaw?.primary_tradeoff || tradeoffsDetailRaw?.primaryTradeoff || null);
  const tradeoffObjects = uniqueDupeCompareTradeoffs([
    ...(primaryTradeoff ? [primaryTradeoff] : []),
    ...uniqueDupeCompareTradeoffs(tradeoffsRaw),
    ...uniqueDupeCompareTradeoffs(
      tradeoffsDetailRaw?.structured_tradeoffs
      || tradeoffsDetailRaw?.structuredTradeoffs,
    ),
    ...tradeoffStrings
      .map((item) => classifyDupeCompareTradeoffString(item))
      .filter(Boolean),
  ]);
  const tradeoffs = tradeoffStrings.length
    ? tradeoffStrings
    : uniqueStrings(tradeoffObjects.map((item) => formatDupeCompareTradeoff(item)).filter(Boolean));
  if (!tradeoffs.length) field_missing.push({ field: 'tradeoffs', reason: 'upstream_missing_or_empty' });

  const tradeoffsDetail = (tradeoffsDetailRaw || tradeoffObjects.length)
    ? {
        ...(tradeoffsDetailRaw || {}),
        ...(tradeoffObjects.length ? { structured_tradeoffs: tradeoffObjects } : {}),
      }
    : null;

  const evOut = normalizeEvidence(o.evidence);
  field_missing.push(...evOut.field_missing);

  const confidence = asNumberOrNull(o.confidence);
  if (confidence == null) field_missing.push({ field: 'confidence', reason: 'upstream_missing_or_invalid' });

  const missing_info = uniqueStrings(asStringArray(o.missing_info ?? o.missingInfo));
  if (evOut.evidence.missing_info?.length) missing_info.push(...evOut.evidence.missing_info);
  const compareQuality = String(o.compare_quality ?? o.compareQuality ?? '').trim().toLowerCase() === 'limited' ? 'limited' : 'full';
  const limitedReason = typeof (o.limited_reason ?? o.limitedReason) === 'string'
    ? String(o.limited_reason ?? o.limitedReason).trim()
    : '';

  return {
    payload: {
      original,
      dupe,
      ...(similarity != null ? { similarity: Math.max(0, Math.min(100, Math.round(similarity))) } : {}),
      ...(tradeoffsDetail ? { tradeoffs_detail: tradeoffsDetail } : {}),
      tradeoffs,
      evidence: evOut.evidence,
      confidence,
      compare_quality: compareQuality,
      limited_reason: limitedReason,
      missing_info: uniqueStrings(missing_info),
    },
    field_missing,
  };
}

function normalizeRecoGenerate(raw) {
  const o = asPlainObject(raw);
  if (!o) {
    const evOut = normalizeEvidence(null);
    return {
      payload: {
        recommendations: [],
        evidence: evOut.evidence,
        confidence: null,
        missing_info: uniqueStrings(['upstream_missing_or_unstructured']),
        warnings: uniqueStrings(evOut.evidence?.missing_info || []),
      },
      field_missing: [{ field: 'recommendations', reason: 'upstream_missing_or_unstructured' }, ...evOut.field_missing],
    };
  }

  const field_missing = [];

  const recommendations = Array.isArray(o.recommendations) ? o.recommendations : [];
  if (!recommendations.length) field_missing.push({ field: 'recommendations', reason: 'upstream_missing_or_empty' });

  const evOut = normalizeEvidence(o.evidence);
  field_missing.push(...evOut.field_missing);

  const confidence = asNumberOrNull(o.confidence);
  if (confidence == null) field_missing.push({ field: 'confidence', reason: 'upstream_missing_or_invalid' });

  const missing_info_raw = uniqueStrings(asStringArray(o.missing_info ?? o.missingInfo));
  const warnings_raw = uniqueStrings(
    asStringArray(o.warnings ?? o.warning ?? o.context_gaps ?? o.contextGaps ?? o.warnings_info ?? o.warningsInfo),
  );

  const warningLike = new Set([
    'routine_missing',
    'over_budget',
    'price_unknown',
    'availability_unknown',
    'recent_logs_missing',
    'itinerary_unknown',
    'analysis_missing',
    'evidence_missing',
    'upstream_missing_or_unstructured',
    'upstream_missing_or_empty',
    'alternatives_partial',
  ]);

  const warnings = uniqueStrings([
    ...warnings_raw,
    ...missing_info_raw.filter((c) => warningLike.has(String(c || '').trim())),
    ...(evOut.evidence.missing_info || []),
  ]);

  const missing_info = uniqueStrings(missing_info_raw.filter((c) => !warningLike.has(String(c || '').trim())));

  return {
    payload: {
      recommendations,
      evidence: evOut.evidence,
      confidence,
      missing_info,
      warnings,
    },
    field_missing,
  };
}

module.exports = {
  normalizeEvidence,
  normalizeProductParse,
  normalizeProductAnalysis,
  applyProductAnalysisGapContract,
  reconcileProductAnalysisConsistency,
  enrichProductAnalysisPayload,
  normalizeDupeCompare,
  normalizeRecoGenerate,
};
