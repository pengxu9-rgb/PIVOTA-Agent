function createProductIntelRecoContractRuntime(options = {}) {
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
    normalizeMaybePercentScore = (value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return null;
      if (numeric > 1) return Math.max(0, Math.min(1, numeric / 100));
      return Math.max(0, Math.min(1, numeric));
    },
    getRecoCandidateSourceTypeToken = (candidate) =>
      String(candidate?.source?.type || candidate?.source_type || candidate?.sourceType || '').trim().toLowerCase(),
    getProductAnalysisInternalMissingCodes = () => [],
    normalizeRecoBlockForContract = (value) => value,
    normalizeRecoConfidenceEntry = (value) => value,
    normalizeRecoConfidenceByBlock = (value) => value,
    normalizeRecoProvenance = (value) => value,
    validateRecoBlocksResponse = () => ({ ok: true, errors: [] }),
    applyProductAnalysisGapContract = (payload) => payload,
    getRecoGuardrailCircuitState = () => ({
      open_until_ms: 0,
      consecutive_violations: 0,
      last_violations: [],
    }),
    getRecoGuardrailCircuitSnapshot = () => ({ open: false, open_until_ms: 0 }),
    markRecoGuardrailCircuitViolation = () => ({ opened: false, snapshot: { open: false, open_until_ms: 0 } }),
    markRecoGuardrailCircuitSuccess = () => {},
    recordRecoGuardrailCircuitOpen = () => {},
    recordRecoGuardrailViolation = () => {},
    recordRecoCandidate = () => {},
    recordRecoExplanationAlignment = () => {},
    setRecoGuardrailRates = () => {},
    AURORA_BFF_RECO_GUARD_ENABLED = false,
    AURORA_PRODUCT_GUARDRAIL_TELEMETRY_ONLY = false,
    AURORA_BFF_RECO_GUARD_CIRCUIT_ENABLED = false,
    AURORA_BFF_RECO_GUARD_STRICT_DEFAULT_MODE = true,
  } = options;

  const RECO_GUARD_FEATURE_REASON_KEYWORDS = {
    category_use_case_match: ['category', 'use-case', 'scenario', '品类', '场景'],
    ingredient_functional_similarity: ['ingredient', 'active', '成分', '活性'],
    skin_fit_similarity: ['skin profile', 'skin type', 'sensitive', '肤质', '敏感'],
    social_reference_strength: ['social', 'public', 'community', '社交', '反馈'],
    price_distance: ['price', 'budget', 'cost', '价格', '预算'],
    quality: ['source quality', 'evidence', '来源质量', '证据'],
    brand_constraint: ['cross-brand', '品牌'],
    brand_affinity: ['brand affinity', '品牌关联'],
    co_view: ['co-view', '共现'],
    kb_routine: ['routine', '组合', '搭配'],
  };

  function normalizeRecoGuardMode(mode) {
    const token = String(mode || '').trim().toLowerCase();
    if (token === 'main_path' || token === 'sync_repair' || token === 'async_backfill') return token;
    return AURORA_BFF_RECO_GUARD_STRICT_DEFAULT_MODE ? 'main_path' : 'unknown';
  }

  function normalizeRecoGuardBrandId(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  function getRecoGuardAnchorBrandId(payload) {
    const p = isPlainObject(payload) ? payload : {};
    const assessment = isPlainObject(p.assessment) ? p.assessment : {};
    const anchor = isPlainObject(assessment.anchor_product || assessment.anchorProduct)
      ? (assessment.anchor_product || assessment.anchorProduct)
      : {};
    return pickFirstTrimmed(
      anchor.brand_id,
      anchor.brandId,
      anchor.brand,
      anchor.brand_name,
      anchor.brandName,
      p.anchor_brand_id,
      p.anchorBrandId,
    );
  }

  function getRecoGuardCandidateBrandId(candidate) {
    const row = isPlainObject(candidate) ? candidate : {};
    return pickFirstTrimmed(row.brand_id, row.brandId, row.brand, row.brand_name, row.brandName);
  }

  function getRecoGuardCandidateSourceType(candidate) {
    return getRecoCandidateSourceTypeToken(candidate);
  }

  function getRecoGuardTopFeatureKeys(block) {
    const token = String(block || '').trim().toLowerCase();
    if (token === 'related_products') return ['brand_affinity', 'co_view', 'kb_routine'];
    if (token === 'dupes') {
      return [
        'category_use_case_match',
        'ingredient_functional_similarity',
        'skin_fit_similarity',
        'social_reference_strength',
        'price_distance',
        'brand_constraint',
      ];
    }
    return [
      'category_use_case_match',
      'ingredient_functional_similarity',
      'skin_fit_similarity',
      'social_reference_strength',
      'price_distance',
      'quality',
      'brand_constraint',
    ];
  }

  function normalizeRecoGuardWhyCandidateText(whyCandidate) {
    if (!whyCandidate) return '';
    if (Array.isArray(whyCandidate)) return whyCandidate.map((item) => String(item || '').toLowerCase()).join(' | ');
    if (isPlainObject(whyCandidate)) {
      const reasons = Array.isArray(whyCandidate.reasons_user_visible) ? whyCandidate.reasons_user_visible : [];
      const summary = typeof whyCandidate.summary === 'string' ? whyCandidate.summary : '';
      return [summary, ...reasons].map((item) => String(item || '').toLowerCase()).join(' | ');
    }
    return String(whyCandidate || '').toLowerCase();
  }

  function isRecoGuardExplanationAlignedAt3(candidate, block) {
    const row = isPlainObject(candidate) ? candidate : {};
    const scoreBreakdown = isPlainObject(row.score_breakdown) ? row.score_breakdown : {};
    const scored = [];
    for (const key of getRecoGuardTopFeatureKeys(block)) {
      const value = normalizeMaybePercentScore(scoreBreakdown[key]);
      if (value == null) continue;
      scored.push({ key, value });
    }
    if (!scored.length) return false;
    scored.sort((a, b) => {
      if (b.value !== a.value) return b.value - a.value;
      return a.key.localeCompare(b.key);
    });
    const reasonsText = normalizeRecoGuardWhyCandidateText(row.why_candidate);
    if (!reasonsText.trim()) return false;
    return scored.slice(0, 3).every((item) =>
      (RECO_GUARD_FEATURE_REASON_KEYWORDS[item.key] || []).some((keyword) =>
        reasonsText.includes(String(keyword || '').trim().toLowerCase()),
      ),
    );
  }

  function observeRecoGuardrailBlockMetrics(payload, { mode = 'main_path', anchorBrandId = '' } = {}) {
    const p = isPlainObject(payload) ? payload : {};
    const modeToken = normalizeRecoGuardMode(mode);
    const anchorBrandToken = normalizeRecoGuardBrandId(anchorBrandId || getRecoGuardAnchorBrandId(p));
    let competitorsTotal = 0;
    let competitorsSameBrand = 0;
    let competitorsOnPage = 0;
    let alignmentTotal = 0;
    let alignmentAligned = 0;

    for (const block of ['competitors', 'related_products', 'dupes']) {
      const blockObj = isPlainObject(p[block]) ? p[block] : {};
      const candidates = Array.isArray(blockObj.candidates) ? blockObj.candidates : [];
      for (const candidate of candidates) {
        const sourceType = getRecoGuardCandidateSourceType(candidate) || 'unknown';
        const candidateBrandToken = normalizeRecoGuardBrandId(getRecoGuardCandidateBrandId(candidate));
        const brandRelation =
          anchorBrandToken && candidateBrandToken
            ? anchorBrandToken === candidateBrandToken
              ? 'same_brand'
              : 'cross_brand'
            : 'unknown';
        recordRecoCandidate({
          block,
          sourceType,
          brandRelation,
          mode: modeToken,
        });

        const aligned = isRecoGuardExplanationAlignedAt3(candidate, block);
        recordRecoExplanationAlignment({
          block,
          aligned,
          mode: modeToken,
        });
        alignmentTotal += 1;
        if (aligned) alignmentAligned += 1;

        if (block === 'competitors') {
          competitorsTotal += 1;
          if (sourceType === 'on_page_related') competitorsOnPage += 1;
          if (brandRelation === 'same_brand') competitorsSameBrand += 1;
        }
      }
    }

    const sameBrandRate = competitorsTotal > 0 ? competitorsSameBrand / competitorsTotal : 0;
    const onPageRate = competitorsTotal > 0 ? competitorsOnPage / competitorsTotal : 0;
    const alignmentRate = alignmentTotal > 0 ? alignmentAligned / alignmentTotal : 0;
    setRecoGuardrailRates({
      competitorsSameBrandRate: sameBrandRate,
      competitorsOnPageSourceRate: onPageRate,
      explanationAlignmentAt3: alignmentRate,
    });
    return {
      competitors_total: competitorsTotal,
      competitors_same_brand_hits: competitorsSameBrand,
      competitors_on_page_hits: competitorsOnPage,
      explanation_alignment_at3: alignmentRate,
    };
  }

  function applyRecoGuardrailToProductAnalysisPayload(
    payload,
    { logger, requestId = 'unknown', mode = 'main_path' } = {},
  ) {
    const p = isPlainObject(payload) ? payload : null;
    if (!p) return payload;
    const modeToken = normalizeRecoGuardMode(mode);
    const anchorBrandId = normalizeRecoGuardBrandId(getRecoGuardAnchorBrandId(p));
    const telemetry = observeRecoGuardrailBlockMetrics(p, { mode: modeToken, anchorBrandId });
    if (!AURORA_BFF_RECO_GUARD_ENABLED) return p;
    const telemetryOnly = AURORA_PRODUCT_GUARDRAIL_TELEMETRY_ONLY;
    const circuitGuardEnabled = AURORA_BFF_RECO_GUARD_CIRCUIT_ENABLED && !telemetryOnly;

    const competitorsObj = isPlainObject(p.competitors) ? p.competitors : {};
    const rawCandidates = Array.isArray(competitorsObj.candidates) ? competitorsObj.candidates : [];
    const nowMs = Date.now();
    const circuitBefore = getRecoGuardrailCircuitSnapshot(modeToken, nowMs);
    let circuitOpen = Boolean(circuitBefore.open);
    let circuitUntilMs = Number(circuitBefore.open_until_ms || 0);
    let autoRollbackFlag = false;
    let circuitRecovered = false;
    const violations = [];
    let filteredCandidates = [];
    if (telemetryOnly) {
      circuitOpen = false;
      circuitUntilMs = 0;
    }

    for (const candidate of rawCandidates) {
      const sourceType = getRecoGuardCandidateSourceType(candidate);
      const candidateBrandId = normalizeRecoGuardBrandId(getRecoGuardCandidateBrandId(candidate));
      const sameBrandBlocked =
        AURORA_BFF_RECO_GUARD_STRICT_DEFAULT_MODE &&
        Boolean(anchorBrandId) &&
        Boolean(candidateBrandId) &&
        anchorBrandId === candidateBrandId;
      const onPageBlocked = sourceType === 'on_page_related';
      const legacySourceBlocked = sourceType === 'aurora_alternatives';
      if (!sameBrandBlocked && !onPageBlocked && !legacySourceBlocked) {
        filteredCandidates.push(candidate);
        continue;
      }
      if (sameBrandBlocked) {
        violations.push({
          violation_type: 'same_brand',
          source_type: sourceType || 'unknown',
          candidate_brand_id: candidateBrandId || '',
        });
      }
      if (onPageBlocked) {
        violations.push({
          violation_type: 'on_page_source',
          source_type: sourceType || 'unknown',
          candidate_brand_id: candidateBrandId || '',
        });
      }
      if (legacySourceBlocked) {
        violations.push({
          violation_type: 'legacy_alternatives_source',
          source_type: sourceType || 'unknown',
          candidate_brand_id: candidateBrandId || '',
        });
      }
      if (telemetryOnly) {
        const row = isPlainObject(candidate) ? { ...candidate } : candidate;
        if (isPlainObject(row)) {
          row.guardrail_flags = uniqCaseInsensitiveStrings(
            [
              ...(Array.isArray(row.guardrail_flags) ? row.guardrail_flags : []),
              ...(sameBrandBlocked ? ['same_brand'] : []),
              ...(onPageBlocked ? ['on_page_source'] : []),
              ...(legacySourceBlocked ? ['legacy_alternatives_source'] : []),
            ],
            8,
          );
          row.low_relevance = true;
        }
        filteredCandidates.push(row);
      }
    }

    if (circuitOpen && circuitGuardEnabled) {
      if (!violations.length && filteredCandidates.length) {
        const state = getRecoGuardrailCircuitState(modeToken);
        state.open_until_ms = 0;
        state.consecutive_violations = 0;
        state.last_violations = [];
        circuitOpen = false;
        circuitUntilMs = 0;
        circuitRecovered = true;
        logger?.info?.(
          {
            event_name: 'reco_guardrail_circuit_recovered',
            request_id: requestId,
            mode: modeToken,
            block: 'competitors',
            candidates_after: filteredCandidates.length,
          },
          'aurora bff: reco guardrail circuit recovered',
        );
      } else {
        autoRollbackFlag = true;
        filteredCandidates = [];
      }
    }

    const violationTypes = uniqCaseInsensitiveStrings(
      violations.map((item) => item.violation_type),
      8,
    );
    let circuitOpenedNow = false;
    if (violations.length && !circuitOpen && circuitGuardEnabled) {
      const circuitUpdate = markRecoGuardrailCircuitViolation(modeToken, violationTypes, nowMs);
      circuitOpenedNow = Boolean(circuitUpdate.opened);
      circuitOpen = Boolean(circuitUpdate.snapshot.open);
      circuitUntilMs = Number(circuitUpdate.snapshot.open_until_ms || 0);
      if (circuitOpenedNow) {
        autoRollbackFlag = true;
        filteredCandidates = [];
        recordRecoGuardrailCircuitOpen({ mode: modeToken });
        logger?.warn?.(
          {
            event_name: 'reco_guardrail_circuit_opened',
            request_id: requestId,
            mode: modeToken,
            block: 'competitors',
            circuit_open: true,
            circuit_until_ms: circuitUntilMs,
            auto_rollback_flag: true,
          },
          'aurora bff: reco guardrail circuit opened',
        );
      }
    } else if (!circuitOpen && circuitGuardEnabled) {
      markRecoGuardrailCircuitSuccess(modeToken);
    }

    const effectiveCandidates = circuitOpen && circuitGuardEnabled ? [] : filteredCandidates;
    const hasSanitizeAction = !telemetryOnly && (effectiveCandidates.length !== rawCandidates.length || violations.length > 0);
    const guardrailApplied = !telemetryOnly && Boolean(hasSanitizeAction || (circuitOpen && circuitGuardEnabled));

    for (const violation of violations) {
      recordRecoGuardrailViolation({
        block: 'competitors',
        violationType: violation.violation_type,
        mode: modeToken,
        action: telemetryOnly ? 'telemetry_only' : (circuitOpen ? 'circuit_drop' : 'sanitize'),
      });
      logger?.warn?.(
        {
          event_name: 'reco_guardrail_violation',
          request_id: requestId,
          mode: modeToken,
          block: 'competitors',
          violation_type: violation.violation_type,
          source_type: violation.source_type || 'unknown',
          anchor_brand_id: anchorBrandId || '',
          candidate_brand_id: violation.candidate_brand_id || '',
          action: telemetryOnly ? 'telemetry_only' : (circuitOpen ? 'circuit_drop' : 'sanitize'),
          circuit_open: Boolean(circuitOpen),
          circuit_until_ms: circuitOpen ? circuitUntilMs : 0,
          auto_rollback_flag: Boolean(autoRollbackFlag),
        },
        'aurora bff: reco guardrail violation',
      );
    }

    const existingCodes = getProductAnalysisInternalMissingCodes(p);
    const guardCodes = [];
    if (guardrailApplied) guardCodes.push('reco_guardrail_applied');
    if (telemetryOnly && violationTypes.length) guardCodes.push('reco_guardrail_telemetry_only');
    if (violationTypes.includes('same_brand') && !telemetryOnly) guardCodes.push('reco_guardrail_same_brand_filtered');
    if (violationTypes.includes('on_page_source') && !telemetryOnly) guardCodes.push('reco_guardrail_on_page_filtered');
    if (circuitOpen) guardCodes.push('reco_guardrail_circuit_open');
    if (circuitRecovered) guardCodes.push('reco_guardrail_circuit_recovered');
    const nextInternalCodes = uniqCaseInsensitiveStrings(
      [...existingCodes, ...guardCodes],
      32,
    );

    const confidenceByBlock = normalizeRecoConfidenceByBlock(p.confidence_by_block);
    if (guardrailApplied && !telemetryOnly) {
      const prevCompetitorConfidence = isPlainObject(confidenceByBlock.competitors)
        ? confidenceByBlock.competitors
        : normalizeRecoConfidenceEntry(null, 'competitors_default');
      const reasons = uniqCaseInsensitiveStrings(
        [
          ...(Array.isArray(prevCompetitorConfidence.reasons) ? prevCompetitorConfidence.reasons : []),
          ...(violationTypes.includes('same_brand') ? ['guardrail_same_brand_filtered'] : []),
          ...(violationTypes.includes('on_page_source') ? ['guardrail_on_page_filtered'] : []),
          ...(violationTypes.includes('legacy_alternatives_source') ? ['guardrail_legacy_alternatives_source_filtered'] : []),
          ...(circuitOpen ? ['guardrail_circuit_open'] : []),
        ],
        8,
      );
      confidenceByBlock.competitors = {
        score: Math.min(circuitOpen ? 0.05 : 0.2, Number(prevCompetitorConfidence.score) || 1),
        level: 'low',
        reasons: reasons.length ? reasons : ['guardrail_applied'],
      };
    }

    const provenanceObj = isPlainObject(p.provenance) ? p.provenance : {};
    const nextProvenance = {
      ...provenanceObj,
      guardrail_applied: guardrailApplied,
      guardrail_mode: telemetryOnly ? 'telemetry_only' : 'enforce',
      guardrail_violations: uniqCaseInsensitiveStrings(
        [
          ...(Array.isArray(provenanceObj.guardrail_violations) ? provenanceObj.guardrail_violations : []),
          ...violationTypes,
          ...(circuitOpen ? ['circuit_open'] : []),
        ],
        8,
      ),
      guardrail_circuit_open: Boolean(circuitOpen),
      guardrail_circuit_until_ms: circuitOpen ? circuitUntilMs : 0,
      auto_rollback_flag: Boolean(autoRollbackFlag),
    };

    logger?.info?.(
      {
        event_name: 'reco_guardrail_gate_result',
        request_id: requestId,
        mode: modeToken,
        block: 'competitors',
        violation_count: violations.length,
        action: telemetryOnly ? 'telemetry_only' : (circuitOpen ? 'circuit_drop' : hasSanitizeAction ? 'sanitize' : 'pass'),
        circuit_open: Boolean(circuitOpen),
        circuit_until_ms: circuitOpen ? circuitUntilMs : 0,
        auto_rollback_flag: Boolean(autoRollbackFlag),
        candidates_before: rawCandidates.length,
        candidates_after: effectiveCandidates.length,
        competitors_same_brand_rate: telemetry.competitors_total > 0
          ? telemetry.competitors_same_brand_hits / telemetry.competitors_total
          : 0,
        competitors_on_page_source_rate: telemetry.competitors_total > 0
          ? telemetry.competitors_on_page_hits / telemetry.competitors_total
          : 0,
        explanation_alignment_at3: telemetry.explanation_alignment_at3,
      },
      'aurora bff: reco guardrail gate result',
    );

    return applyProductAnalysisGapContract({
      ...p,
      competitors: {
        ...competitorsObj,
        candidates: effectiveCandidates,
      },
      confidence_by_block: confidenceByBlock,
      provenance: nextProvenance,
      internal_debug_codes: nextInternalCodes,
      missing_info_internal: nextInternalCodes,
    });
  }

  function finalizeProductAnalysisRecoContract(payload, { logger, requestId = 'unknown', mode = 'main_path' } = {}) {
    const p = isPlainObject(payload) ? payload : {};
    const internalCodes = uniqCaseInsensitiveStrings(
      [
        ...getProductAnalysisInternalMissingCodes(p),
        ...(Array.isArray(p.missing_info_internal) ? p.missing_info_internal : []),
        ...(Array.isArray(p.internal_debug_codes) ? p.internal_debug_codes : []),
      ],
      32,
    );
    const normalized = applyProductAnalysisGapContract({
      ...p,
      competitors: normalizeRecoBlockForContract({
        ...(isPlainObject(p.competitors) ? p.competitors : {}),
        block_type: 'competitors',
      }),
      related_products: normalizeRecoBlockForContract({
        ...(isPlainObject(p.related_products) ? p.related_products : {}),
        block_type: 'related_products',
      }),
      dupes: normalizeRecoBlockForContract({
        ...(isPlainObject(p.dupes) ? p.dupes : {}),
        block_type: 'dupes',
      }),
      confidence_by_block: normalizeRecoConfidenceByBlock(p.confidence_by_block),
      provenance: normalizeRecoProvenance(p.provenance, p),
      missing_info_internal: internalCodes,
      internal_debug_codes: internalCodes,
    });

    const validation = validateRecoBlocksResponse(normalized);
    if (validation.ok) {
      return applyRecoGuardrailToProductAnalysisPayload(normalized, {
        logger,
        requestId,
        mode,
      });
    }

    const fallbackCodes = uniqCaseInsensitiveStrings(
      [...internalCodes, 'reco_blocks_schema_invalid'],
      32,
    );
    logger?.warn?.(
      {
        errors: Array.isArray(validation.errors) ? validation.errors.slice(0, 8) : [],
      },
      'aurora bff: reco blocks schema invalid; soft-fail fallback applied',
    );
    const fallbackPayload = applyProductAnalysisGapContract({
      ...normalized,
      competitors: { candidates: [] },
      related_products: { candidates: [] },
      dupes: { candidates: [] },
      confidence_by_block: normalizeRecoConfidenceByBlock({}),
      provenance: normalizeRecoProvenance(normalized.provenance, normalized),
      missing_info_internal: fallbackCodes,
      internal_debug_codes: fallbackCodes,
    });
    return applyRecoGuardrailToProductAnalysisPayload(fallbackPayload, {
      logger,
      requestId,
      mode,
    });
  }

  return {
    applyRecoGuardrailToProductAnalysisPayload,
    finalizeProductAnalysisRecoContract,
  };
}

module.exports = {
  createProductIntelRecoContractRuntime,
};
