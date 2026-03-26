const crypto = require('crypto');

function createProductIntelSupportRuntime(options = {}) {
  const {
    isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
    pickFirstTrimmed = (...values) => {
      for (const raw of values) {
        const value = String(raw || '').trim();
        if (value) return value;
      }
      return '';
    },
    uniqCaseInsensitiveStrings = (items = [], max = 32) => {
      const seen = new Set();
      const out = [];
      for (const raw of Array.isArray(items) ? items : []) {
        const value = String(raw || '').trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
        if (out.length >= max) break;
      }
      return out;
    },
    normalizeProductIntelFingerprintToken = (value, { maxLen = 120 } = {}) =>
      String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .slice(0, Math.max(0, Math.trunc(Number(maxLen) || 0))),
    canonicalizeProductUrlForIntelKb = (value) => String(value || '').trim(),
    normalizeProductIntelKbKey = (value) => String(value || '').trim(),
    extractWhitelistedSocialChannels = ({ channels = [] } = {}) =>
      uniqCaseInsensitiveStrings(channels, 8),
    asStringArray = (value) =>
      Array.isArray(value)
        ? value.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
    RECO_DOGFOOD_CONFIG = null,
    AURORA_COMP_SNAPSHOT_SOFT_TTL_MS = 259200000,
    AURORA_PRODUCT_INTEL_NARRATIVE_QUALITY_RETRY_ENABLED = false,
    AURORA_PRODUCT_INTEL_NARRATIVE_QUALITY_RETRY_MAX = 0,
  } = options;

  function extractProductIntelInciFingerprint(parsedProductObj) {
    const base = isPlainObject(parsedProductObj) ? parsedProductObj : null;
    if (!base) return '';
    const direct = pickFirstTrimmed(base.inci, base.ingredients, base.ingredient_list, base.ingredientList);
    if (direct) return direct;
    const ingredientsArray = Array.isArray(base.ingredients)
      ? base.ingredients
      : Array.isArray(base.inci_list)
        ? base.inci_list
        : Array.isArray(base.inciList)
          ? base.inciList
          : [];
    if (!ingredientsArray.length) return '';
    return ingredientsArray
      .map((item) => (typeof item === 'string' ? item : item == null ? '' : String(item)).trim())
      .filter(Boolean)
      .slice(0, 80)
      .join('|');
  }

  function buildProductIntelFingerprintSeed({ parsedProductObj, productHint = '', langCode = 'EN' } = {}) {
    void langCode;
    const parsed = isPlainObject(parsedProductObj) ? parsedProductObj : null;
    const brandRaw = pickFirstTrimmed(parsed?.brand, parsed?.brand_name, parsed?.brandName);
    const nameRaw = pickFirstTrimmed(
      parsed?.name,
      parsed?.display_name,
      parsed?.displayName,
      parsed?.title,
      parsed?.product_name,
      parsed?.productName,
    );
    const inciRaw = extractProductIntelInciFingerprint(parsed);
    const hintRaw = String(productHint || '').trim();

    const brand = normalizeProductIntelFingerprintToken(brandRaw, { maxLen: 120 });
    const name = normalizeProductIntelFingerprintToken(nameRaw || hintRaw, { maxLen: 200 });
    const inci = normalizeProductIntelFingerprintToken(inciRaw, { maxLen: 700 });
    const hint = normalizeProductIntelFingerprintToken(hintRaw, { maxLen: 220 });

    if (!brand && !name && !inci && !hint) return '';
    return [brand, name, inci, hint].join('|');
  }

  function buildProductIntelKbKeyParts({ productUrl, parsedProduct, productHint = '', lang = 'EN' } = {}) {
    const parsedProductObj = isPlainObject(parsedProduct) ? parsedProduct : null;
    const anchorId = pickFirstTrimmed(parsedProductObj?.product_id, parsedProductObj?.sku_id);
    const langCode = String(lang || 'EN').toUpperCase() === 'CN' ? 'CN' : 'EN';
    const urlRaw = String(productUrl || '').trim();
    const normalizedUrl = /^https?:\/\/\S+/i.test(urlRaw) ? canonicalizeProductUrlForIntelKb(urlRaw) : '';
    const fingerprintSeed = buildProductIntelFingerprintSeed({ parsedProductObj, productHint, langCode });
    return {
      anchorId,
      normalizedUrl,
      fingerprintSeed,
      langCode,
    };
  }

  function resolveProductIntelKbKeyQuality({ productUrl, parsedProduct, productHint = '', lang = 'EN' } = {}) {
    const parts = buildProductIntelKbKeyParts({ productUrl, parsedProduct, productHint, lang });
    if (parts.normalizedUrl) return 'url';
    if (parts.anchorId) return 'anchor';
    if (parts.fingerprintSeed) return 'fingerprint';
    return 'none';
  }

  function buildProductIntelKbKey({ productUrl, parsedProduct, lang = 'EN', productHint = '' } = {}) {
    const parts = buildProductIntelKbKeyParts({ productUrl, parsedProduct, productHint, lang });
    const fingerprintHash = parts.fingerprintSeed
      ? crypto.createHash('sha256').update(parts.fingerprintSeed).digest('hex')
      : '';
    const keyRaw = parts.normalizedUrl
      ? `url:${parts.normalizedUrl}`
      : parts.anchorId
        ? `product:${parts.anchorId}`
        : fingerprintHash
          ? `fp:${fingerprintHash}`
          : '';
    return normalizeProductIntelKbKey(keyRaw);
  }

  function buildLegacyProductIntelKbKey({ productUrl, parsedProduct, lang = 'EN', productHint = '' } = {}) {
    const parts = buildProductIntelKbKeyParts({ productUrl, parsedProduct, productHint, lang });
    const fingerprintHash = parts.fingerprintSeed
      ? crypto.createHash('sha256').update(parts.fingerprintSeed).digest('hex')
      : '';
    const keyRaw = parts.normalizedUrl
      ? `url:${parts.normalizedUrl}|lang:${parts.langCode}`
      : parts.anchorId
        ? `product:${parts.anchorId}|lang:${parts.langCode}`
        : fingerprintHash
          ? `fp:${fingerprintHash}|lang:${parts.langCode}`
          : '';
    return normalizeProductIntelKbKey(keyRaw);
  }

  function buildProductIntelKbReadCandidates({ productUrl, parsedProduct, lang = 'EN', productHint = '' } = {}) {
    const out = [];
    const push = (rawKey) => {
      const key = String(rawKey || '').trim();
      if (!key) return;
      if (out.includes(key)) return;
      out.push(key);
    };

    push(buildProductIntelKbKey({ productUrl, parsedProduct, lang, productHint }));
    push(buildLegacyProductIntelKbKey({ productUrl, parsedProduct, lang, productHint }));
    push(buildLegacyProductIntelKbKey({ productUrl, parsedProduct, lang: 'EN', productHint }));
    push(buildLegacyProductIntelKbKey({ productUrl, parsedProduct, lang: 'CN', productHint }));

    return out;
  }

  function parseTimestampMs(raw) {
    const text = String(raw || '').trim();
    if (!text) return 0;
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : 0;
  }

  function getProductAnalysisSocialSummaryCount(payload) {
    let count = 0;
    for (const block of ['competitors', 'related_products', 'dupes']) {
      const blockObj = isPlainObject(payload?.[block]) ? payload[block] : {};
      const candidates = Array.isArray(blockObj.candidates) ? blockObj.candidates : [];
      for (const candidate of candidates) {
        const summary = isPlainObject(candidate?.social_summary_user_visible)
          ? candidate.social_summary_user_visible
          : null;
        const themes = Array.isArray(summary?.themes) ? summary.themes.filter(Boolean) : [];
        if (themes.length) count += 1;
      }
    }
    return count;
  }

  function getProductAnalysisSocialChannels(payload) {
    const provenance = isPlainObject(payload?.provenance) ? payload.provenance : {};
    const evidence = isPlainObject(payload?.evidence) ? payload.evidence : {};
    const socialSignals = isPlainObject(evidence.social_signals) ? evidence.social_signals : {};
    const platformScores = isPlainObject(socialSignals.platform_scores) ? socialSignals.platform_scores : {};
    return extractWhitelistedSocialChannels({
      channels: [
        ...(Array.isArray(provenance.social_channels_used) ? provenance.social_channels_used : []),
        ...Object.keys(platformScores),
      ],
    });
  }

  function resolveProductAnalysisSocialState(payload) {
    const provenance = isPlainObject(payload?.provenance) ? payload.provenance : {};
    const nowMs = Date.now();
    const ttlMs = Number(RECO_DOGFOOD_CONFIG?.social?.ttl_ms) > 0
      ? Number(RECO_DOGFOOD_CONFIG.social.ttl_ms)
      : 72 * 60 * 60 * 1000;
    const freshUntilMs = parseTimestampMs(provenance.social_fresh_until);
    const generatedAtMs = parseTimestampMs(provenance.generated_at);
    const isFreshByWindow = freshUntilMs > nowMs;
    const isFreshByGeneratedAt = generatedAtMs > 0 && generatedAtMs + ttlMs > nowMs;
    const socialSummaryCount = getProductAnalysisSocialSummaryCount(payload);
    const socialChannels = getProductAnalysisSocialChannels(payload);
    const hasCoverage = socialSummaryCount > 0 && socialChannels.length >= 2;
    const fresh = (isFreshByWindow || isFreshByGeneratedAt) && hasCoverage;
    return {
      shouldRefresh: !fresh,
      fetchMode: fresh ? 'kb_hit' : 'stale_kb',
      socialChannels,
      socialSummaryCount,
      socialFreshUntil: freshUntilMs > 0 ? new Date(freshUntilMs).toISOString() : null,
    };
  }

  function applyProductAnalysisSocialProvenance(payload, patch = {}) {
    const p = isPlainObject(payload) ? payload : {};
    const provenance = isPlainObject(p.provenance) ? p.provenance : {};
    const next = {
      ...provenance,
      ...(isPlainObject(patch) ? patch : {}),
    };
    const socialChannels = extractWhitelistedSocialChannels({
      channels: Array.isArray(next.social_channels_used) ? next.social_channels_used : [],
    });
    if (socialChannels.length) next.social_channels_used = socialChannels;
    else delete next.social_channels_used;
    return {
      ...p,
      provenance: next,
    };
  }

  function shouldRefreshCompetitorSnapshot(payload, sourceMeta = null) {
    const p = isPlainObject(payload) ? payload : {};
    const provenance = isPlainObject(p.provenance) ? p.provenance : {};
    const competitorMeta = isPlainObject(provenance.competitor_meta) ? provenance.competitor_meta : {};
    const sourceMetaObj = isPlainObject(sourceMeta) ? sourceMeta : {};
    const sourceToken = String(
      competitorMeta.source ||
      sourceMetaObj.competitor_source ||
      sourceMetaObj.competitor_snapshot_meta?.source ||
      '',
    ).trim().toLowerCase();
    if (sourceToken !== 'snapshot') return false;
    if (competitorMeta.very_stale === true || competitorMeta.stale === true || competitorMeta.degraded === true) {
      return true;
    }
    const ageSec = Number(competitorMeta.snapshot_age_sec);
    if (Number.isFinite(ageSec) && ageSec > 0) {
      return ageSec >= Math.trunc((Number(AURORA_COMP_SNAPSHOT_SOFT_TTL_MS || 259200000) || 259200000) / 1000);
    }
    return true;
  }

  function collectProductIntelEvidenceSourceTypes(payload) {
    const p = isPlainObject(payload) ? payload : {};
    const evidence = isPlainObject(p.evidence) ? p.evidence : {};
    const sources = Array.isArray(evidence.sources) ? evidence.sources : [];
    return uniqCaseInsensitiveStrings(
      sources
        .map((item) => (isPlainObject(item) ? String(item.type || '').trim().toLowerCase() : ''))
        .filter(Boolean),
      8,
    );
  }

  function getProductAnalysisEvidenceCoverageScore(payload) {
    const p = isPlainObject(payload) ? payload : {};
    const evidence = isPlainObject(p.evidence) ? p.evidence : {};
    const science = isPlainObject(evidence.science) ? evidence.science : {};
    const social = isPlainObject(evidence.social_signals || evidence.socialSignals) ? (evidence.social_signals || evidence.socialSignals) : {};
    const keyIngredients = Array.isArray(science.key_ingredients || science.keyIngredients) ? (science.key_ingredients || science.keyIngredients) : [];
    const mechanisms = Array.isArray(science.mechanisms) ? science.mechanisms : [];
    const fitNotes = Array.isArray(science.fit_notes || science.fitNotes) ? (science.fit_notes || science.fitNotes) : [];
    const riskNotes = Array.isArray(science.risk_notes || science.riskNotes) ? (science.risk_notes || science.riskNotes) : [];
    const expertNotes = Array.isArray(evidence.expert_notes || evidence.expertNotes) ? (evidence.expert_notes || evidence.expertNotes) : [];
    const socialSignals = [
      ...(Array.isArray(social.typical_positive || social.typicalPositive) ? (social.typical_positive || social.typicalPositive) : []),
      ...(Array.isArray(social.typical_negative || social.typicalNegative) ? (social.typical_negative || social.typicalNegative) : []),
      ...(Array.isArray(social.risk_for_groups || social.riskForGroups) ? (social.risk_for_groups || social.riskForGroups) : []),
    ];
    const sources = Array.isArray(evidence.sources) ? evidence.sources : [];
    let score = 0;
    if (keyIngredients.length) score += 0.35;
    if (mechanisms.length || fitNotes.length) score += 0.2;
    if (riskNotes.length) score += 0.15;
    if (expertNotes.length) score += 0.1;
    if (socialSignals.length) score += 0.1;
    if (sources.length) score += 0.1;
    return Math.max(0, Math.min(1, Number(score.toFixed(3))));
  }

  function hasProfileEchoFormulaIntent(lines = []) {
    if (!Array.isArray(lines) || !lines.length) return false;
    const profileEchoPattern = /\b(your profile|profile priorities|skinType=|sensitivity=|barrier=|你的情况|你的画像|画像：)\b/i;
    return lines.some((line) => profileEchoPattern.test(String(line || '').trim()));
  }

  function hasProfileEchoSummary(payload) {
    const assessment = isPlainObject(payload?.assessment) ? payload.assessment : null;
    if (!assessment) return false;
    const summary = String(assessment.summary ?? assessment.quick_summary ?? assessment.quickSummary ?? '').trim();
    if (!summary) return false;
    if (/\b(your profile|profile priorities|你的情况|你的画像|匹配点)\b/i.test(summary)) return true;
    if (/\b(skintype\s*=|sensitivity\s*=|barrier\s*=)\b/i.test(summary)) return true;
    const normalized = summary.toLowerCase();
    const profileTokenCount = [
      /\b(oily|dry|combo|combination|normal)\b/.test(normalized),
      /\b(sensitivity|sensitive|low|medium|high)\b/.test(normalized),
      /\b(barrier|healthy|impaired)\b/.test(normalized),
      /肤质|敏感|屏障|油皮|干皮|混合皮|低敏|中敏|高敏/.test(summary),
    ].filter(Boolean).length;
    const productSignal = /\b(ingredient|formula|efficacy|mechanis|retino|acid|niacinamide|ceramide|peptide|spf|sunscreen|cleanser|moisturizer|serum|防晒|保湿|修护|控痘|去角质)\b/i
      .test(summary);
    return !productSignal && profileTokenCount >= 2 && summary.length <= 140;
  }

  function hasValidFormulaIntentInPayload(payload) {
    const assessment = isPlainObject(payload?.assessment) ? payload.assessment : null;
    if (!assessment) return false;
    const formulaIntent = uniqCaseInsensitiveStrings(
      [
        ...(Array.isArray(assessment.formula_intent) ? assessment.formula_intent : []),
        ...(Array.isArray(assessment.formulaIntent) ? assessment.formulaIntent : []),
      ],
      6,
    ).map((line) => String(line || '').trim()).filter(Boolean);
    if (!formulaIntent.length) return false;
    if (hasProfileEchoFormulaIntent(formulaIntent)) return false;
    return true;
  }

  function hasValidSummary(payload) {
    const assessment = isPlainObject(payload?.assessment) ? payload.assessment : null;
    if (!assessment) return false;
    const summary = String(assessment.summary ?? assessment.quick_summary ?? assessment.quickSummary ?? '').trim();
    if (!summary) return false;
    if (hasProfileEchoSummary(payload)) return false;
    if (summary.length < 16) return false;
    if (/^(unknown|未知|insufficient evidence|analysis limited|i couldn['’]t retrieve)/i.test(summary)) return false;
    const productSignalRe =
      /(ingredient|formula|efficacy|mechanis|filter|spf|uva|uvb|retino|acid|niacinamide|ceramide|peptide|sunscreen|cleanser|moisturizer|serum|irritat|dry|hydrat|barrier|acne|comedone|香精|防晒|保湿|修护|刺激|干燥|控痘|屏障|去角质)/i;
    return productSignalRe.test(summary);
  }

  function hasStructuredHowToUse(payload) {
    const assessment = isPlainObject(payload?.assessment) ? payload.assessment : null;
    if (!assessment) return false;
    const howToUse = isPlainObject(assessment.how_to_use ?? assessment.howToUse)
      ? (assessment.how_to_use ?? assessment.howToUse)
      : null;
    if (!howToUse) return false;
    const timing = String(howToUse.timing || howToUse.time || '').trim();
    const frequency = String(howToUse.frequency || '').trim();
    const steps = asStringArray(howToUse.steps);
    const observationWindow = String(howToUse.observation_window || howToUse.observationWindow || '').trim();
    const stopSigns = asStringArray(howToUse.stop_signs || howToUse.stopSigns);
    return !!(timing && frequency && steps.length && observationWindow && stopSigns.length);
  }

  function hasValidNarrativeQuality(payload) {
    return hasValidFormulaIntentInPayload(payload) && hasValidSummary(payload) && hasStructuredHowToUse(payload);
  }

  function shouldRetryForNarrativeQuality(payload) {
    if (!AURORA_PRODUCT_INTEL_NARRATIVE_QUALITY_RETRY_ENABLED) return false;
    if (AURORA_PRODUCT_INTEL_NARRATIVE_QUALITY_RETRY_MAX < 1) return false;
    const assessment = isPlainObject(payload?.assessment) ? payload.assessment : null;
    if (!assessment) return false;
    return !hasValidNarrativeQuality(payload);
  }

  function collectNarrativeRetryCodes(beforePayload, afterPayload) {
    const out = [];
    if (hasValidFormulaIntentInPayload(afterPayload) && !hasValidFormulaIntentInPayload(beforePayload)) {
      out.push('formula_intent_retry_used');
    }
    if (hasValidSummary(afterPayload) && !hasValidSummary(beforePayload)) {
      out.push('summary_quality_retry_used');
    }
    if (hasStructuredHowToUse(afterPayload) && !hasStructuredHowToUse(beforePayload)) {
      out.push('how_to_use_retry_used');
    }
    return out;
  }

  return {
    buildProductIntelKbKeyParts,
    resolveProductIntelKbKeyQuality,
    buildProductIntelKbKey,
    buildProductIntelKbReadCandidates,
    resolveProductAnalysisSocialState,
    applyProductAnalysisSocialProvenance,
    shouldRefreshCompetitorSnapshot,
    collectProductIntelEvidenceSourceTypes,
    getProductAnalysisEvidenceCoverageScore,
    hasProfileEchoSummary,
    hasValidFormulaIntentInPayload,
    hasValidSummary,
    hasStructuredHowToUse,
    hasValidNarrativeQuality,
    shouldRetryForNarrativeQuality,
    collectNarrativeRetryCodes,
  };
}

module.exports = {
  createProductIntelSupportRuntime,
};
