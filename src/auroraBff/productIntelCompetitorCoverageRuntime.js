function createProductIntelCompetitorCoverageRuntime(options = {}) {
  const {
    sanitizeCompetitorCandidates,
    routeCompetitorCandidatePools,
    initCandidateFilterStats,
    hasCandidateFilterDropStats,
    collectRouterReasonCodeTokens,
    summarizeRouterReasonCodes,
    uniqCaseInsensitiveStrings,
    applyProductAnalysisGapContract,
    collectProductIntelEvidenceSourceTypes,
    getProductAnalysisEvidenceCoverageScore,
    PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT = 2,
    PRODUCT_INTEL_KB_QUARANTINE_ENABLED = false,
    AURORA_KB_SERVE_POLICY = 'strict',
  } = options;

  function getProductAnalysisInternalMissingCodes(payload) {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    if (!p) return [];
    return uniqCaseInsensitiveStrings(
      [
        ...(Array.isArray(p.internal_debug_codes) ? p.internal_debug_codes : []),
        ...(Array.isArray(p.missing_info_internal) ? p.missing_info_internal : []),
        ...(Array.isArray(p.missing_info) ? p.missing_info : []),
      ],
      32,
    );
  }

  function stripCompetitorMissingTokens(items) {
    const out = [];
    for (const raw of Array.isArray(items) ? items : []) {
      const token = String(raw || '').trim();
      if (!token) continue;
      if (token === 'competitors_missing') continue;
      if (token === 'competitors.competitors.candidates') continue;
      if (token === 'competitors_low_coverage') continue;
      if (token === 'alternatives_unavailable') continue;
      if (token === 'alternatives_limited') continue;
      if (token === 'competitor_candidates_filtered_noise') continue;
      if (token === 'competitors_non_skincare_filtered') continue;
      if (token === 'related_products_non_skincare_filtered') continue;
      if (token === 'dupes_non_skincare_filtered') continue;
      if (token === 'competitor_category_unknown_blocked') continue;
      if (token === 'competitor_sync_enrich_used') continue;
      if (token === 'competitor_sync_aurora_fallback_used') continue;
      if (/^competitor_recall_/i.test(token)) continue;
      out.push(token);
    }
    return Array.from(new Set(out));
  }

  function sanitizeCompetitorsInPayload(payload, { max = 10 } = {}) {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    if (!p) return payload;
    const competitorsObj = p.competitors && typeof p.competitors === 'object' && !Array.isArray(p.competitors)
      ? p.competitors
      : null;
    const rawCandidates = Array.isArray(competitorsObj?.candidates) ? competitorsObj.candidates : [];
    if (!rawCandidates.length) return payload;
    const assessment = p.assessment && typeof p.assessment === 'object' && !Array.isArray(p.assessment)
      ? p.assessment
      : null;
    const anchorProduct = assessment && typeof assessment.anchor_product === 'object' && !Array.isArray(assessment.anchor_product)
      ? assessment.anchor_product
      : null;
    const routedPools = routeCompetitorCandidatePools({
      anchorProduct,
      candidates: rawCandidates,
      maxCandidates: max,
    });
    const cleanCandidates = routedPools.compPool;
    const recoveredRelated = routedPools.relPool;
    const droppedStats = initCandidateFilterStats(routedPools?.candidateFilterStats);
    const routeReasonCodesRaw = Array.isArray(routedPools?.routeReasonCodesRaw)
      ? routedPools.routeReasonCodesRaw
      : collectRouterReasonCodeTokens(routedPools?.routed);
    const rawLen = rawCandidates.length;
    const cleanLen = cleanCandidates.length;
    const existingRelatedObj = p.related_products && typeof p.related_products === 'object' && !Array.isArray(p.related_products)
      ? p.related_products
      : null;
    const existingRelated = Array.isArray(existingRelatedObj?.candidates) ? existingRelatedObj.candidates : [];
    const mergedRelated = sanitizeCompetitorCandidates([...existingRelated, ...recoveredRelated], max);
    const hasChanged = cleanLen !== rawLen || mergedRelated.length !== existingRelated.length;
    if (!hasChanged) return payload;

    const missingInfo = getProductAnalysisInternalMissingCodes(p);
    const nextMissingInfo = cleanLen
      ? uniqCaseInsensitiveStrings(
        [
          ...stripCompetitorMissingTokens(missingInfo),
          ...(cleanLen < PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT ? ['competitors_low_coverage'] : []),
        ],
        16,
      )
      : uniqCaseInsensitiveStrings([...missingInfo, 'competitors_missing', 'competitor_candidates_filtered_noise'], 16);
    if (Number(droppedStats.competitors_dropped_non_skincare || 0) > 0) nextMissingInfo.push('competitors_non_skincare_filtered');
    if (Number(droppedStats.related_dropped_non_skincare || 0) > 0) nextMissingInfo.push('related_products_non_skincare_filtered');
    if (Number(droppedStats.dupes_dropped_non_skincare || 0) > 0) nextMissingInfo.push('dupes_non_skincare_filtered');
    if (routeReasonCodesRaw.some((code) => String(code || '').trim().toLowerCase() === 'competitor_category_unknown_blocked')) {
      nextMissingInfo.push('competitor_category_unknown_blocked');
    }
    const dedupedMissingInfo = uniqCaseInsensitiveStrings(nextMissingInfo, 20);
    const existingProvenance = p.provenance && typeof p.provenance === 'object' && !Array.isArray(p.provenance)
      ? p.provenance
      : {};
    const existingFilterStats = existingProvenance.candidate_filter_stats
      && typeof existingProvenance.candidate_filter_stats === 'object'
      && !Array.isArray(existingProvenance.candidate_filter_stats)
      ? initCandidateFilterStats(existingProvenance.candidate_filter_stats)
      : initCandidateFilterStats();
    const mergedFilterStats = {
      competitors_dropped_non_skincare: Number(existingFilterStats.competitors_dropped_non_skincare || 0) + Number(droppedStats.competitors_dropped_non_skincare || 0),
      related_dropped_non_skincare: Number(existingFilterStats.related_dropped_non_skincare || 0) + Number(droppedStats.related_dropped_non_skincare || 0),
      dupes_dropped_non_skincare: Number(existingFilterStats.dupes_dropped_non_skincare || 0) + Number(droppedStats.dupes_dropped_non_skincare || 0),
    };

    return applyProductAnalysisGapContract({
      ...p,
      competitors: {
        ...(competitorsObj || {}),
        candidates: cleanCandidates,
      },
      ...(mergedRelated.length
        ? {
          related_products: {
            ...(existingRelatedObj || {}),
            candidates: mergedRelated,
          },
        }
        : {}),
      missing_info: dedupedMissingInfo,
      provenance: {
        ...existingProvenance,
        ...(hasCandidateFilterDropStats(mergedFilterStats) ? { candidate_filter_stats: mergedFilterStats } : {}),
      },
      internal_debug_codes: uniqCaseInsensitiveStrings([
        ...dedupedMissingInfo,
        ...summarizeRouterReasonCodes(routedPools.routed),
      ], 32),
    });
  }

  function getCompetitorCandidatesFromPayload(payload, { max = 10 } = {}) {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    if (!p) return [];
    const competitors =
      p.competitors && typeof p.competitors === 'object' && !Array.isArray(p.competitors)
        ? p.competitors
        : null;
    return sanitizeCompetitorCandidates(competitors?.candidates, max);
  }

  function getEffectiveCompetitorCoverageFromPayload(payload, { max = 10 } = {}) {
    const candidates = getCompetitorCandidatesFromPayload(payload, { max });
    if (!candidates.length) return 0;
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    if (!p) return candidates.length;
    const assessment =
      p.assessment && typeof p.assessment === 'object' && !Array.isArray(p.assessment)
        ? p.assessment
        : null;
    const anchorProduct =
      assessment &&
      assessment.anchor_product &&
      typeof assessment.anchor_product === 'object' &&
      !Array.isArray(assessment.anchor_product)
        ? assessment.anchor_product
        : null;
    if (!anchorProduct) return candidates.length;
    const routedPools = routeCompetitorCandidatePools({
      anchorProduct,
      candidates,
      maxCandidates: Math.max(1, Math.min(12, Number(max) || 10)),
    });
    return Array.isArray(routedPools?.compPool) ? routedPools.compPool.length : 0;
  }

  function hasCompetitorCandidatesInPayload(payload, { minCount = 1 } = {}) {
    const threshold = Math.max(1, Math.min(10, Number(minCount) || 1));
    return getEffectiveCompetitorCoverageFromPayload(payload, { max: 10 }) >= threshold;
  }

  function hasLowCoverageCompetitorsInPayload(payload, { preferredCount = 2 } = {}) {
    const target = Math.max(1, Math.min(10, Number(preferredCount) || 2));
    const count = getEffectiveCompetitorCoverageFromPayload(payload, { max: 10 });
    return count > 0 && count < target;
  }

  function hasLowCoverageCompetitorToken(payload) {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    if (!p) return false;
    const missingInfo = getProductAnalysisInternalMissingCodes(p);
    return missingInfo.some((raw) => {
      const token = String(raw || '').trim().toLowerCase();
      return token === 'competitors_low_coverage'
        || token === 'alternatives_limited'
        || token === 'competitors_missing'
        || token === 'alternatives_unavailable'
        || token === 'competitor_sync_aurora_fallback_used';
    });
  }

  function shouldRepairCompetitorCoverage(payload, { preferredCount = 2 } = {}) {
    const target = Math.max(1, Math.min(10, Number(preferredCount) || 2));
    const count = getEffectiveCompetitorCoverageFromPayload(payload, { max: 10 });
    if (count === 0) return true;
    if (count >= target) return false;
    return hasLowCoverageCompetitorToken(payload);
  }

  function shouldServeProductIntelKbPayload(payload) {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    if (!p) return false;
    const assessment = p.assessment && typeof p.assessment === 'object' && !Array.isArray(p.assessment) ? p.assessment : null;
    if (!assessment) return false;

    const missingInfo = getProductAnalysisInternalMissingCodes(p);
    const hasCompetitors = hasCompetitorCandidatesInPayload(p);
    const competitorMissing = missingInfo.some((raw) => {
      const token = String(raw || '').trim().toLowerCase();
      if (!token) return false;
      return token === 'competitors_missing'
        || token === 'competitors.competitors.candidates'
        || token === 'alternatives_unavailable'
        || token === 'competitor_sync_aurora_fallback_used'
        || token.startsWith('competitor_recall_');
    });
    if (competitorMissing && !hasCompetitors) {
      return shouldRepairCompetitorCoverage(p, { preferredCount: PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT });
    }
    return true;
  }

  function shouldServeProductIntelKbEntry({
    kbEntry = null,
    payload = null,
    productUrl = '',
    anchorTrustContext = null,
  } = {}) {
    const serveWithLabels = AURORA_KB_SERVE_POLICY === 'serve_with_labels';
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    if (!p) {
      return {
        serve: false,
        quarantined: false,
        reason: 'payload_missing',
        reasons: ['payload_missing'],
      };
    }
    if (!PRODUCT_INTEL_KB_QUARANTINE_ENABLED) {
      return {
        serve: true,
        quarantined: false,
        reason: null,
        reasons: [],
      };
    }

    const reasons = [];
    const provenance = p.provenance && typeof p.provenance === 'object' && !Array.isArray(p.provenance) ? p.provenance : {};
    const sourceChain = Array.isArray(provenance.source_chain) ? provenance.source_chain : [];
    const sourceTypes = collectProductIntelEvidenceSourceTypes(p);
    const missingCodes = getProductAnalysisInternalMissingCodes(p).map((item) => String(item || '').trim().toLowerCase());
    const assessment = p.assessment && typeof p.assessment === 'object' && !Array.isArray(p.assessment) ? p.assessment : null;
    const verdictToken = String(assessment?.verdict || '').trim().toLowerCase();
    const isUnknownVerdict = verdictToken === 'unknown' || verdictToken === '未知';
    const hasDiagnosticCodes = missingCodes.some((token) =>
      /^(url_fetch_|on_page_fetch_blocked|regulatory_source_used|retail_source_|incidecoder_|catalog_|anchor_soft_blocked_|anchor_id_not_used_due_to_low_trust|version_verification_needed|analysis_limited|evidence_missing|kb_entry_quarantined)/.test(
        token,
      ),
    );

    if (!sourceChain.length) reasons.push('source_chain_missing');
    if (!sourceTypes.length) reasons.push('evidence_sources_missing');
    if (isUnknownVerdict && !hasDiagnosticCodes) reasons.push('unknown_without_diagnostic_codes');
    if (!sourceTypes.length && getProductAnalysisEvidenceCoverageScore(p) < 0.08) reasons.push('coverage_too_low');

    const trust = anchorTrustContext && typeof anchorTrustContext === 'object' && !Array.isArray(anchorTrustContext)
      ? anchorTrustContext
      : null;
    if (
      /^https?:\/\//i.test(String(productUrl || '').trim()) &&
      trust &&
      trust.usable_for_anchor_id === false &&
      String(trust.level || '').trim().toLowerCase() === 'soft_blocked'
    ) {
      reasons.push('anchor_untrusted_for_url');
    }

    const sourceMeta = kbEntry && kbEntry.source_meta && typeof kbEntry.source_meta === 'object' && !Array.isArray(kbEntry.source_meta)
      ? kbEntry.source_meta
      : null;
    if (sourceMeta && sourceMeta.kb_write && typeof sourceMeta.kb_write === 'object') {
      const persisted = sourceMeta.kb_write.persisted;
      if (persisted === false) reasons.push('kb_write_blocked');
    }

    if (!reasons.length) {
      return {
        serve: true,
        quarantined: false,
        reason: null,
        reasons: [],
      };
    }
    if (serveWithLabels) {
      return {
        serve: true,
        quarantined: true,
        reason: reasons[0],
        reasons,
      };
    }
    return {
      serve: false,
      quarantined: true,
      reason: reasons[0],
      reasons,
    };
  }

  return {
    sanitizeCompetitorsInPayload,
    getCompetitorCandidatesFromPayload,
    getEffectiveCompetitorCoverageFromPayload,
    hasCompetitorCandidatesInPayload,
    hasLowCoverageCompetitorsInPayload,
    hasLowCoverageCompetitorToken,
    shouldRepairCompetitorCoverage,
    getProductAnalysisInternalMissingCodes,
    stripCompetitorMissingTokens,
    shouldServeProductIntelKbPayload,
    shouldServeProductIntelKbEntry,
  };
}

module.exports = {
  createProductIntelCompetitorCoverageRuntime,
};
