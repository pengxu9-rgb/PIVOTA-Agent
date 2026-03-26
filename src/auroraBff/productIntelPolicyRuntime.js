function createProductIntelPolicyRuntime(options = {}) {
  const {
    isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
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
    normalizeInciIngredientName = (value) => String(value || '').trim().toLowerCase(),
    pickFirstTrimmed = (...values) => {
      for (const raw of values) {
        const value = String(raw || '').trim();
        if (value) return value;
      }
      return '';
    },
    collectProductIntelEvidenceSourceTypes = () => [],
    getProductAnalysisEvidenceCoverageScore = () => 0,
    hasValidFormulaIntentInPayload = () => false,
    getProductAnalysisInternalMissingCodes = () => [],
    AURORA_RULE_RELAX_MODE = 'strict',
    AURORA_KB_WRITE_POLICY = 'strict',
    AURORA_KB_SERVE_POLICY = 'strict',
  } = options;

  function collectProductIntelInciTokens(payload) {
    const p = isPlainObject(payload) ? payload : {};
    const evidence = isPlainObject(p.evidence) ? p.evidence : {};
    const science = isPlainObject(evidence.science) ? evidence.science : {};
    const ingredientIntel = isPlainObject(p.ingredient_intel) ? p.ingredient_intel : {};
    const inciNormalized = Array.isArray(ingredientIntel.inci_normalized) ? ingredientIntel.inci_normalized : [];
    return uniqCaseInsensitiveStrings(
      [
        ...(Array.isArray(science.key_ingredients || science.keyIngredients)
          ? (science.key_ingredients || science.keyIngredients)
          : []),
        ...inciNormalized.map((item) => {
          if (typeof item === 'string') return item;
          if (isPlainObject(item)) return pickFirstTrimmed(item.name, item.inci, item.value);
          return '';
        }),
      ]
        .map((item) => normalizeInciIngredientName(item))
        .filter(Boolean),
      120,
    );
  }

  function resolveProductAnalysisConfidenceBand(payload) {
    const p = isPlainObject(payload) ? payload : {};
    const confidenceObj = isPlainObject(p.confidence) ? p.confidence : {};
    const confidenceRaw = Number(
      confidenceObj.score != null
        ? confidenceObj.score
        : confidenceObj.value != null
          ? confidenceObj.value
          : p.confidence_score != null
            ? p.confidence_score
            : p.confidence,
    );
    const score = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : null;
    if (score == null) return 'unknown';
    if (score >= 0.75) return 'high';
    if (score >= 0.45) return 'medium';
    return 'low';
  }

  function resolveProductAnalysisQualityBand(payload) {
    const p = isPlainObject(payload) ? payload : {};
    const assessment = isPlainObject(p.assessment) ? p.assessment : {};
    const verdict = String(assessment.verdict || '').trim().toLowerCase();
    if (verdict === 'unknown' || verdict === '未知' || !verdict) return 'low';
    const coverage = getProductAnalysisEvidenceCoverageScore(p);
    if (coverage >= 0.68) return 'high';
    if (coverage >= 0.34) return 'medium';
    return 'low';
  }

  function collectProductGuardrailFlags(payload) {
    const p = isPlainObject(payload) ? payload : {};
    const provenance = isPlainObject(p.provenance) ? p.provenance : {};
    const violations = Array.isArray(provenance.guardrail_violations) ? provenance.guardrail_violations : [];
    const internal = getProductAnalysisInternalMissingCodes(p).filter((token) =>
      /^guardrail_/i.test(String(token || '').trim()));
    return uniqCaseInsensitiveStrings([...violations, ...internal], 16);
  }

  function annotateProductIntelRelaxedProvenance(payload, { quarantineReasons = [] } = {}) {
    const p = isPlainObject(payload) ? payload : null;
    if (!p) return payload;
    const provenance = isPlainObject(p.provenance) ? p.provenance : {};
    const existingSourceChain = Array.isArray(provenance.source_chain) ? provenance.source_chain : [];
    const existingFlags = Array.isArray(provenance.guardrail_flags) ? provenance.guardrail_flags : [];
    const nextQuarantineReasons = uniqCaseInsensitiveStrings(
      [
        ...(Array.isArray(provenance.kb_quarantine_reasons) ? provenance.kb_quarantine_reasons : []),
        ...(Array.isArray(quarantineReasons) ? quarantineReasons : []),
      ],
      12,
    );
    p.provenance = {
      ...provenance,
      source_chain: uniqCaseInsensitiveStrings(
        [
          ...existingSourceChain,
          'llm_extraction',
        ],
        12,
      ),
      confidence_band: resolveProductAnalysisConfidenceBand(p),
      quality_band: resolveProductAnalysisQualityBand(p),
      guardrail_flags: uniqCaseInsensitiveStrings(
        [
          ...existingFlags,
          ...collectProductGuardrailFlags(p),
        ],
        20,
      ),
      gate_relax_mode: AURORA_RULE_RELAX_MODE,
      kb_write_policy: AURORA_KB_WRITE_POLICY,
      kb_serve_policy: AURORA_KB_SERVE_POLICY,
      ...(nextQuarantineReasons.length ? { kb_quarantine_reasons: nextQuarantineReasons } : {}),
    };
    return p;
  }

  function shouldPersistProductIntelKb(payload, sourceMeta = null) {
    const p = isPlainObject(payload) ? payload : null;
    if (!p) {
      return { attempted: false, persisted: false, blocked_reason: 'payload_missing' };
    }
    const sourceTypes = collectProductIntelEvidenceSourceTypes(p);
    const hasInciDecoder = sourceTypes.includes('inci_decoder');
    const hasAuthoritativeEvidence = sourceTypes.includes('official_page') || sourceTypes.includes('regulatory');
    let blockedReason = null;
    if (!hasAuthoritativeEvidence) {
      blockedReason = hasInciDecoder ? 'incidecoder_unverified_not_persisted' : 'authoritative_source_missing';
    }
    if (!blockedReason && hasInciDecoder) {
      const sourceMetaObj = isPlainObject(sourceMeta) ? sourceMeta : {};
      const overlapFromMeta = Number(sourceMetaObj?.inci_decoder_overlap_count);
      const overlapCount = Number.isFinite(overlapFromMeta) ? Math.max(0, Math.trunc(overlapFromMeta)) : 0;
      if (overlapCount <= 0) {
        const inciTokens = collectProductIntelInciTokens(p);
        const hasSufficientInci = inciTokens.length >= 4;
        if (!hasSufficientInci) {
          blockedReason = 'incidecoder_unverified_not_persisted';
        }
      }
    }
    if (AURORA_KB_WRITE_POLICY === 'allow_all') {
      return {
        attempted: true,
        persisted: true,
        blocked_reason: blockedReason,
        audit_blocked_reason: blockedReason,
        policy: AURORA_KB_WRITE_POLICY,
      };
    }
    return {
      attempted: true,
      persisted: !blockedReason,
      blocked_reason: blockedReason,
      audit_blocked_reason: blockedReason,
      policy: AURORA_KB_WRITE_POLICY,
    };
  }

  function annotateProductIntelKbWriteDecision(payload, decision) {
    const p = isPlainObject(payload) ? payload : null;
    if (!p) return payload;
    const d = isPlainObject(decision) ? decision : {};
    const blockedReason =
      d.persisted === false && d.blocked_reason
        ? String(d.blocked_reason)
        : null;
    const provenance = isPlainObject(p.provenance) ? p.provenance : {};
    const missingInfo = uniqCaseInsensitiveStrings(
      [
        ...(Array.isArray(p.missing_info) ? p.missing_info : []),
        ...(Array.isArray(p.user_facing_gaps) ? p.user_facing_gaps : []),
        ...(blockedReason === 'incidecoder_unverified_not_persisted' ? ['incidecoder_unverified_not_persisted'] : []),
      ],
      16,
    );
    const internalCodes = uniqCaseInsensitiveStrings(
      [
        ...getProductAnalysisInternalMissingCodes(p),
        ...(blockedReason === 'incidecoder_unverified_not_persisted' ? ['incidecoder_unverified_not_persisted'] : []),
      ],
      24,
    );
    p.provenance = {
      ...provenance,
      gate_relax_mode: AURORA_RULE_RELAX_MODE,
      kb_write_policy: AURORA_KB_WRITE_POLICY,
      kb_serve_policy: AURORA_KB_SERVE_POLICY,
      confidence_band: resolveProductAnalysisConfidenceBand(p),
      quality_band: resolveProductAnalysisQualityBand(p),
      guardrail_flags: uniqCaseInsensitiveStrings(
        [
          ...(Array.isArray(provenance.guardrail_flags) ? provenance.guardrail_flags : []),
          ...collectProductGuardrailFlags(p),
        ],
        20,
      ),
      kb_write: {
        attempted: d.attempted === true,
        persisted: d.persisted === true,
        blocked_reason: d.blocked_reason ? String(d.blocked_reason) : null,
        audit_blocked_reason: d.audit_blocked_reason ? String(d.audit_blocked_reason) : null,
        policy: d.policy ? String(d.policy) : AURORA_KB_WRITE_POLICY,
      },
    };
    if (missingInfo.length) p.missing_info = missingInfo;
    if (internalCodes.length) {
      p.internal_debug_codes = internalCodes;
      p.missing_info_internal = internalCodes;
    }
    return p;
  }

  function isUnknownProductAnalysisPayload(payload) {
    const assessment = isPlainObject(payload?.assessment) ? payload.assessment : {};
    const verdict = String(assessment?.verdict || '').trim().toLowerCase();
    return !verdict || verdict === 'unknown' || verdict === '未知';
  }

  function shouldTriggerProductIntelEscalation(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return true;
    if (!hasValidFormulaIntentInPayload(payload)) return true;
    if (!isUnknownProductAnalysisPayload(payload)) return false;
    return getProductAnalysisEvidenceCoverageScore(payload) < 0.45;
  }

  function isProductIntelPayloadCandidateBetter(nextPayload, currentPayload) {
    const nextAssessment = isPlainObject(nextPayload?.assessment);
    const currentAssessment = isPlainObject(currentPayload?.assessment);
    if (nextAssessment && !currentAssessment) return true;
    if (!nextAssessment) return false;
    const nextScore = getProductAnalysisEvidenceCoverageScore(nextPayload);
    const currentScore = getProductAnalysisEvidenceCoverageScore(currentPayload);
    if (nextScore > currentScore + 0.08) return true;
    if (!isUnknownProductAnalysisPayload(nextPayload) && isUnknownProductAnalysisPayload(currentPayload)) return true;
    return false;
  }

  function appendProductIntelSourceChain(payload, chainEntries = []) {
    const p = isPlainObject(payload) ? payload : {};
    const provenance = isPlainObject(p.provenance) ? p.provenance : {};
    const existing = Array.isArray(provenance.source_chain) ? provenance.source_chain : [];
    const merged = uniqCaseInsensitiveStrings(
      [
        ...existing,
        ...(Array.isArray(chainEntries) ? chainEntries : []),
      ],
      10,
    );
    return {
      ...p,
      provenance: {
        ...provenance,
        ...(merged.length ? { source_chain: merged } : {}),
      },
    };
  }

  function attachProductIntelLlmRouteProvenance(payload, llmRouteMeta = null) {
    const p = isPlainObject(payload) ? payload : payload;
    if (!isPlainObject(p)) return payload;
    const route = isPlainObject(llmRouteMeta) ? llmRouteMeta : {};
    const provider = String(route.provider || route.llm_provider || '').trim();
    const model = String(route.model || route.llm_model || '').trim();
    const stage = String(route.stage || '').trim() || 'stage_1';
    const triggerReason = String(route.trigger_reason || route.triggerReason || '').trim() || 'primary';
    const provenance = isPlainObject(p.provenance) ? p.provenance : {};
    return {
      ...p,
      provenance: {
        ...provenance,
        llm_route: {
          stage,
          provider: provider || null,
          model: model || null,
          trigger_reason: triggerReason,
        },
      },
    };
  }

  return {
    collectProductIntelInciTokens,
    resolveProductAnalysisConfidenceBand,
    resolveProductAnalysisQualityBand,
    collectProductGuardrailFlags,
    annotateProductIntelRelaxedProvenance,
    shouldPersistProductIntelKb,
    annotateProductIntelKbWriteDecision,
    isUnknownProductAnalysisPayload,
    shouldTriggerProductIntelEscalation,
    isProductIntelPayloadCandidateBetter,
    appendProductIntelSourceChain,
    attachProductIntelLlmRouteProvenance,
  };
}

module.exports = {
  createProductIntelPolicyRuntime,
};
