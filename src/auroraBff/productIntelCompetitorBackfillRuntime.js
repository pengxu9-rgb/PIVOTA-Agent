function createProductIntelCompetitorBackfillRuntime(options = {}) {
  const {
    PRODUCT_INTEL_KB_ASYNC_BACKFILL_ENABLED = false,
    PRODUCT_URL_REALTIME_COMPETITOR_ASYNC_ENRICH_ENABLED = false,
    PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT = 2,
    AURORA_BFF_RECO_BLOCKS_BUDGET_MS = 0,
    PRODUCT_URL_REALTIME_COMPETITOR_BACKFILL_TIMEOUT_MS = 0,
    PRODUCT_URL_REALTIME_COMPETITOR_BACKFILL_MAX_CANDIDATES = 6,
    PRODUCT_URL_REALTIME_COMPETITOR_SYNC_ENRICH_TIMEOUT_MS = 0,
    PRODUCT_URL_REALTIME_COMPETITOR_SYNC_ENRICH_MAX_QUERIES = 3,
    PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES = 6,
    shouldRepairCompetitorCoverage = () => false,
    hasCompetitorCandidatesInPayload = () => false,
    hasLowCoverageCompetitorsInPayload = () => false,
    buildCompetitorSnapshotKey = () => '',
    pickFirstTrimmed = (...values) => {
      for (const raw of values) {
        const value = String(raw || '').trim();
        if (value) return value;
      }
      return '';
    },
    inferRecoPriceBand = (value) => String(value || '').trim(),
    normalizePriceObject = () => null,
    buildProfileSkinTags = () => [],
    canEnqueueCompetitorSnapshotBackfill = () => true,
    recordAuroraCompBackfillDedupDrop = () => {},
    markCompetitorSnapshotBackfillCooldown = () => {},
    recordAuroraCompBackfillEnqueued = () => {},
    scheduleDetachedAsyncJob = () => null,
    runRecoBlocksForUrl = async () => null,
    sanitizeCompetitorCandidates = (items) => (Array.isArray(items) ? items : []),
    summarizeRouterReasonCodes = () => [],
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
    stripCompetitorMissingTokens = (items) => (Array.isArray(items) ? items : []).filter(Boolean),
    getProductAnalysisInternalMissingCodes = () => [],
    enrichProductAnalysisPayload = (payload) => payload,
    writeCompetitorSnapshot = () => {},
    buildProductIntelKbKey = () => '',
    upsertProductIntelKbEntry = async () => undefined,
    getCompetitorCandidatesFromPayload = () => [],
    hasLowCoverageCompetitorToken = () => false,
    buildRealtimeCompetitorCandidates = async () => ({ candidates: [] }),
    routeCompetitorCandidatePools = () => ({ compPool: [], relPool: [], dupePool: [], routed: null }),
    logger = null,
  } = options;

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function clonePayload(payload) {
    try {
      return JSON.parse(JSON.stringify(payload));
    } catch {
      return null;
    }
  }

  function buildCandidateKey(row) {
    const id = pickFirstTrimmed(row?.product_id, row?.sku_id);
    const name = pickFirstTrimmed(row?.name, row?.display_name);
    return `${String(id || '').toLowerCase()}::${String(name || '').toLowerCase()}`;
  }

  function scheduleProductIntelCompetitorEnrichBackfill({
    productUrl,
    parsedProduct = null,
    payload = null,
    lang = 'EN',
    profileSummary = null,
    source = 'url_realtime_product_intel',
    sourceMeta = null,
    forceEnhance = false,
    refreshSnapshot = false,
    logger: callLogger = logger,
  } = {}) {
    if (!PRODUCT_INTEL_KB_ASYNC_BACKFILL_ENABLED || !PRODUCT_URL_REALTIME_COMPETITOR_ASYNC_ENRICH_ENABLED) return;
    const urlText = String(productUrl || '').trim();
    if (!/^https?:\/\//i.test(urlText)) return;
    if (!isObject(payload)) return;
    const needsCoverageRepair = shouldRepairCompetitorCoverage(payload, {
      preferredCount: PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT,
    });
    if (forceEnhance && !refreshSnapshot && !needsCoverageRepair) return;
    if (!forceEnhance && !refreshSnapshot && (
      hasCompetitorCandidatesInPayload(payload) &&
      !hasLowCoverageCompetitorsInPayload(payload, {
        preferredCount: PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT,
      })
    )) {
      return;
    }

    const payloadAssessment = isObject(payload.assessment) ? payload.assessment : null;
    const payloadAnchor = isObject(payloadAssessment?.anchor_product) ? payloadAssessment.anchor_product : null;
    const snapshotAnchor = payloadAnchor || (isObject(parsedProduct) ? parsedProduct : null);
    const snapshotKey = buildCompetitorSnapshotKey({
      anchor_product_id: pickFirstTrimmed(snapshotAnchor?.product_id, snapshotAnchor?.sku_id),
      normalized_query: pickFirstTrimmed(snapshotAnchor?.display_name, snapshotAnchor?.name),
      product_url: urlText,
      locale: lang,
      surface: 'product_analysis',
      objective: 'competitors',
      category: pickFirstTrimmed(snapshotAnchor?.category, snapshotAnchor?.category_name, snapshotAnchor?.category_taxonomy),
      price_band: inferRecoPriceBand(snapshotAnchor?.price_band, {
        price: normalizePriceObject(snapshotAnchor?.price)?.amount,
      }),
      skin_fit_bucket: buildProfileSkinTags(profileSummary).slice(0, 2).join('_'),
    });
    if (snapshotKey) {
      if (!canEnqueueCompetitorSnapshotBackfill(snapshotKey)) {
        recordAuroraCompBackfillDedupDrop({ mode: 'async_backfill' });
        return;
      }
      markCompetitorSnapshotBackfillCooldown(snapshotKey);
      recordAuroraCompBackfillEnqueued({ mode: 'async_backfill' });
    }

    const payloadSnapshot = clonePayload(payload);
    if (!isObject(payloadSnapshot)) return;

    scheduleDetachedAsyncJob(async () => {
      try {
        const assessment = isObject(payloadSnapshot.assessment) ? payloadSnapshot.assessment : null;
        const assessmentAnchor = isObject(assessment?.anchor_product) ? assessment.anchor_product : null;
        const anchorForReco = assessmentAnchor || (isObject(parsedProduct) ? parsedProduct : null);
        const keyIngredients = Array.isArray(payloadSnapshot?.evidence?.science?.key_ingredients)
          ? payloadSnapshot.evidence.science.key_ingredients
          : [];

        const dagOut = await runRecoBlocksForUrl({
          productUrl: urlText,
          anchorProduct: anchorForReco,
          parsedProduct,
          keyIngredients,
          profileSummary,
          lang,
          mode: 'async_backfill',
          logger: callLogger,
          existingPayload: payloadSnapshot,
          budgetMs: Math.max(
            AURORA_BFF_RECO_BLOCKS_BUDGET_MS,
            PRODUCT_URL_REALTIME_COMPETITOR_BACKFILL_TIMEOUT_MS,
          ),
          maxCandidates: PRODUCT_URL_REALTIME_COMPETITOR_BACKFILL_MAX_CANDIDATES,
        });
        if (!isObject(dagOut)) return;

        const asyncCandidates = sanitizeCompetitorCandidates(
          dagOut?.competitors?.candidates,
          PRODUCT_URL_REALTIME_COMPETITOR_BACKFILL_MAX_CANDIDATES,
        );
        const asyncRelated = sanitizeCompetitorCandidates(
          dagOut?.related_products?.candidates,
          PRODUCT_URL_REALTIME_COMPETITOR_BACKFILL_MAX_CANDIDATES,
        );
        const asyncDupes = sanitizeCompetitorCandidates(
          dagOut?.dupes?.candidates,
          PRODUCT_URL_REALTIME_COMPETITOR_BACKFILL_MAX_CANDIDATES,
        );
        if (!asyncCandidates.length && !asyncRelated.length && !asyncDupes.length) return;

        const routeReasonCodes = summarizeRouterReasonCodes({
          internal_reason_codes: Array.isArray(dagOut.internal_reason_codes) ? dagOut.internal_reason_codes : [],
        });
        const dagDiagnostics = isObject(dagOut.diagnostics) ? dagOut.diagnostics : null;
        const dagFallbacksUsed = uniqCaseInsensitiveStrings(
          [
            ...(Array.isArray(dagDiagnostics?.fallbacks_used) ? dagDiagnostics.fallbacks_used : []),
          ],
          12,
        );
        const dagTimedOutBlocks = Array.isArray(dagDiagnostics?.timed_out_blocks) ? dagDiagnostics.timed_out_blocks : [];

        const existingEvidence = isObject(payloadSnapshot.evidence) ? payloadSnapshot.evidence : {};
        const existingExpertNotes = Array.isArray(existingEvidence.expert_notes) ? existingEvidence.expert_notes : [];
        const existingEvidenceMissing = stripCompetitorMissingTokens(existingEvidence.missing_info || []);
        const existingProvenance = isObject(payloadSnapshot.provenance) ? payloadSnapshot.provenance : {};
        const asyncNote =
          String(lang || '').toUpperCase() === 'CN'
            ? `竞品异步补全（reco DAG）：${asyncCandidates.slice(0, 3).map((x) => x.name).join('、')}`
            : `Competitors backfilled async (reco DAG): ${asyncCandidates.slice(0, 3).map((x) => x.name).join(', ')}`;

        const mergedPayload = {
          ...payloadSnapshot,
          competitors: { candidates: asyncCandidates },
          ...(asyncRelated.length ? { related_products: { candidates: asyncRelated } } : {}),
          ...(asyncDupes.length ? { dupes: { candidates: asyncDupes } } : {}),
          evidence: {
            ...existingEvidence,
            expert_notes: uniqCaseInsensitiveStrings([...existingExpertNotes, asyncNote], 6),
            missing_info: existingEvidenceMissing,
          },
          ...(isObject(dagOut.confidence_patch) ? { confidence_by_block: dagOut.confidence_patch } : {}),
          provenance: {
            ...existingProvenance,
            source: 'url_realtime_product_intel_async_backfill',
            ...(isObject(dagOut.provenance_patch) ? dagOut.provenance_patch : {}),
          },
          internal_debug_codes: uniqCaseInsensitiveStrings(
            [
              ...stripCompetitorMissingTokens(getProductAnalysisInternalMissingCodes(payloadSnapshot)),
              ...(asyncCandidates.length < PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT
                ? ['competitors_low_coverage']
                : []),
              ...routeReasonCodes,
              ...dagFallbacksUsed.map((item) => `reco_dag_fallback_${String(item || '').trim().toLowerCase()}`),
              ...dagTimedOutBlocks.map((item) => `reco_dag_timeout_${String(item || '').trim().toLowerCase()}`),
              'competitor_async_backfill_used',
            ],
            32,
          ),
        };
        const enriched = enrichProductAnalysisPayload(mergedPayload, { lang, profileSummary });

        if (snapshotKey) {
          writeCompetitorSnapshot(
            snapshotKey,
            {
              competitors: asyncCandidates,
              related_products: asyncRelated,
              dupes: asyncDupes,
              competitor_queries: Array.isArray(dagOut.catalog_queries) ? dagOut.catalog_queries : [],
            },
            {
              created_at: new Date().toISOString(),
              source: 'reco_async_backfill',
              ranker_version:
                String(dagOut?.provenance_patch?.pipeline || '').trim() || 'reco_blocks_dag.v1',
              coverage: {
                competitors: asyncCandidates.length,
                related_products: asyncRelated.length,
                dupes: asyncDupes.length,
              },
              confidence:
                dagOut?.confidence_patch?.competitors?.score ??
                dagOut?.confidence_patch?.competitors?.level ??
                0.56,
              reason_flags: [
                ...(dagTimedOutBlocks.length ? ['async_backfill_after_timeout'] : []),
                ...(dagFallbacksUsed.length ? ['async_backfill_after_fallback'] : []),
              ],
            },
          );
        }

        const kbKey = buildProductIntelKbKey({
          productUrl: urlText,
          parsedProduct: assessmentAnchor || anchorForReco,
          lang,
        });
        if (!kbKey) return;

        await upsertProductIntelKbEntry({
          kb_key: kbKey,
          analysis: enriched,
          source,
          source_meta: {
            ...(isObject(sourceMeta) ? sourceMeta : {}),
            competitor_async_enriched: true,
            competitor_async_source: 'reco_blocks_dag',
            competitor_queries: Array.isArray(dagOut.catalog_queries) ? dagOut.catalog_queries : [],
            competitor_router_reason_codes: routeReasonCodes,
            reco_blocks_dag: dagDiagnostics
              ? {
                mode: String(dagDiagnostics.mode || 'async_backfill'),
                budget_ms: Number(dagDiagnostics.budget_ms || AURORA_BFF_RECO_BLOCKS_BUDGET_MS),
                timed_out_blocks: dagTimedOutBlocks,
                fallbacks_used: dagFallbacksUsed,
                block_stats:
                  isObject(dagOut.provenance_patch)
                    ? dagOut.provenance_patch.block_stats || null
                    : null,
              }
              : null,
          },
          last_success_at: new Date().toISOString(),
          last_error: null,
        });
      } catch (err) {
        callLogger?.warn?.(
          { err: err?.message || String(err), url: urlText },
          'aurora bff: async competitor enrich backfill failed',
        );
      }
    });
  }

  async function maybeSyncRepairLowCoverageCompetitors({
    productUrl,
    payload,
    parsedProduct = null,
    profileSummary = null,
    lang = 'EN',
    logger: callLogger = logger,
  } = {}) {
    const urlText = String(productUrl || '').trim();
    if (!/^https?:\/\//i.test(urlText)) return { payload, enhanced: false, reason: 'url_missing' };

    const payloadObj = isObject(payload) ? payload : null;
    if (!payloadObj) return { payload, enhanced: false, reason: 'payload_missing' };

    const preferredCount = PRODUCT_URL_REALTIME_COMPETITOR_PREFERRED_COUNT;
    const existingCandidates = getCompetitorCandidatesFromPayload(payloadObj, {
      max: PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
    });
    const lowCoverageTokenPresent = hasLowCoverageCompetitorToken(payloadObj);
    if (!existingCandidates.length) {
      // Zero coverage must always attempt bounded sync repair.
    } else if (existingCandidates.length >= preferredCount) {
      return { payload: payloadObj, enhanced: false, reason: 'coverage_ok' };
    } else if (!lowCoverageTokenPresent) {
      return { payload: payloadObj, enhanced: false, reason: 'coverage_token_missing' };
    }

    const assessment = isObject(payloadObj.assessment) ? payloadObj.assessment : null;
    const assessmentAnchor = isObject(assessment?.anchor_product) ? assessment.anchor_product : null;
    const anchorForRecall = assessmentAnchor || (isObject(parsedProduct) ? parsedProduct : null);
    const keyIngredients = Array.isArray(payloadObj?.evidence?.science?.key_ingredients)
      ? payloadObj.evidence.science.key_ingredients
      : [];

    let dagOut = null;
    try {
      dagOut = await runRecoBlocksForUrl({
        productUrl: urlText,
        anchorProduct: anchorForRecall,
        parsedProduct,
        keyIngredients,
        profileSummary,
        lang,
        mode: 'sync_repair',
        logger: callLogger,
        existingPayload: payloadObj,
        budgetMs: Math.max(
          AURORA_BFF_RECO_BLOCKS_BUDGET_MS,
          PRODUCT_URL_REALTIME_COMPETITOR_SYNC_ENRICH_TIMEOUT_MS + 900,
          2500,
        ),
        maxCandidates: PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
      });
    } catch (err) {
      callLogger?.warn?.(
        { err: err?.message || String(err), url: urlText },
        'aurora bff: sync competitor repair dag failed',
      );
      return { payload: payloadObj, enhanced: false, reason: 'reco_blocks_failed' };
    }

    if (!isObject(dagOut)) {
      return { payload: payloadObj, enhanced: false, reason: 'dag_disabled' };
    }

    let mergedCandidates = sanitizeCompetitorCandidates(
      dagOut?.competitors?.candidates,
      PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
    );
    let mergedRelatedCandidates = sanitizeCompetitorCandidates(
      dagOut?.related_products?.candidates,
      PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
    );
    let mergedDupeCandidates = sanitizeCompetitorCandidates(
      dagOut?.dupes?.candidates,
      PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
    );
    let syncDirectRecallUsed = false;

    if (!mergedCandidates.length) {
      try {
        const directRecallTimeoutMs = Math.max(2200, PRODUCT_URL_REALTIME_COMPETITOR_SYNC_ENRICH_TIMEOUT_MS + 900);
        const directRecall = await buildRealtimeCompetitorCandidates({
          productUrl: urlText,
          parsedProduct: anchorForRecall,
          keyIngredients: Array.isArray(keyIngredients) ? keyIngredients : [],
          anchorProduct: anchorForRecall,
          profileSummary,
          lang,
          mode: 'sync_repair',
          deadlineMs: Date.now() + directRecallTimeoutMs + 600,
          timeoutMs: directRecallTimeoutMs,
          maxQueries: Math.max(1, Math.min(4, PRODUCT_URL_REALTIME_COMPETITOR_SYNC_ENRICH_MAX_QUERIES + 1)),
          maxCandidates: PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
          logger: callLogger,
        });
        const directCandidates = sanitizeCompetitorCandidates(
          directRecall?.candidates,
          PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
        );
        if (directCandidates.length) {
          const rerouted = routeCompetitorCandidatePools({
            anchorProduct: anchorForRecall,
            candidates: directCandidates,
            maxCandidates: PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
          });
          mergedCandidates = sanitizeCompetitorCandidates(
            rerouted.compPool,
            PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
          );
          mergedRelatedCandidates = sanitizeCompetitorCandidates(
            [...mergedRelatedCandidates, ...(Array.isArray(rerouted.relPool) ? rerouted.relPool : [])],
            PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
          );
          mergedDupeCandidates = sanitizeCompetitorCandidates(
            [...mergedDupeCandidates, ...(Array.isArray(rerouted.dupePool) ? rerouted.dupePool : [])],
            PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
          );
          syncDirectRecallUsed = mergedCandidates.length > 0;
        }
      } catch (err) {
        callLogger?.warn?.(
          { err: err?.message || String(err), url: urlText },
          'aurora bff: sync repair direct recall failed',
        );
      }
    }

    if (!mergedCandidates.length && !mergedRelatedCandidates.length && !mergedDupeCandidates.length) {
      return { payload: payloadObj, enhanced: false, reason: 'reco_dag_empty' };
    }

    const existingKey = existingCandidates.map(buildCandidateKey);
    const mergedKey = mergedCandidates.map(buildCandidateKey);
    const existingRelatedObj = isObject(payloadObj.related_products) ? payloadObj.related_products : null;
    const existingRelatedCandidates = sanitizeCompetitorCandidates(
      existingRelatedObj?.candidates,
      PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
    );
    const existingRelatedKey = existingRelatedCandidates.map(buildCandidateKey);
    const mergedRelatedKey = mergedRelatedCandidates.map(buildCandidateKey);
    const existingDupeCandidates = sanitizeCompetitorCandidates(
      payloadObj?.dupes?.candidates,
      PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
    );
    const existingDupeKey = existingDupeCandidates.map(buildCandidateKey);
    const mergedDupeKey = mergedDupeCandidates.map(buildCandidateKey);

    const changed = mergedKey.join('|') !== existingKey.join('|');
    const relatedChanged = mergedRelatedKey.join('|') !== existingRelatedKey.join('|');
    const dupeChanged = mergedDupeKey.join('|') !== existingDupeKey.join('|');
    const coverageImproved = mergedCandidates.length >= preferredCount;
    if (!changed && !coverageImproved && !relatedChanged && !dupeChanged) {
      return { payload: payloadObj, enhanced: false, reason: 'no_delta' };
    }

    const dagDiagnostics = isObject(dagOut.diagnostics) ? dagOut.diagnostics : null;
    const dagFallbacksUsed = uniqCaseInsensitiveStrings(
      [
        ...(Array.isArray(dagDiagnostics?.fallbacks_used) ? dagDiagnostics.fallbacks_used : []),
        ...(syncDirectRecallUsed ? ['sync_direct_catalog_recall'] : []),
      ],
      12,
    );
    const dagTimedOutBlocks = Array.isArray(dagDiagnostics?.timed_out_blocks) ? dagDiagnostics.timed_out_blocks : [];
    const routeReasonCodes = summarizeRouterReasonCodes({
      internal_reason_codes: Array.isArray(dagOut.internal_reason_codes) ? dagOut.internal_reason_codes : [],
    });
    const existingMissingInfo = getProductAnalysisInternalMissingCodes(payloadObj);
    const mergedMissingInfo = uniqCaseInsensitiveStrings(
      [
        ...stripCompetitorMissingTokens(existingMissingInfo),
        ...(mergedCandidates.length < preferredCount ? ['competitors_low_coverage'] : []),
        ...routeReasonCodes,
        ...dagFallbacksUsed.map((item) => `reco_dag_fallback_${String(item || '').trim().toLowerCase()}`),
        ...dagTimedOutBlocks.map((item) => `reco_dag_timeout_${String(item || '').trim().toLowerCase()}`),
        ...(syncDirectRecallUsed ? ['competitor_sync_direct_recall_used'] : []),
        'competitor_sync_enrich_used',
      ],
      32,
    );

    const evidenceObj = isObject(payloadObj.evidence) ? payloadObj.evidence : {};
    const evidenceMissing = uniqCaseInsensitiveStrings(
      [
        ...stripCompetitorMissingTokens(evidenceObj.missing_info || []),
        ...(mergedCandidates.length < preferredCount ? ['competitors_low_coverage'] : []),
      ],
      16,
    );
    const existingExpertNotes = Array.isArray(evidenceObj.expert_notes) ? evidenceObj.expert_notes : [];
    const syncNote = (() => {
      const isCn = String(lang || '').toUpperCase() === 'CN';
      if (mergedCandidates.length) {
        return isCn
          ? `竞品主链路实时补全：${mergedCandidates.slice(0, 3).map((x) => x.name).join('、')}`
          : `Competitors refreshed on main path: ${mergedCandidates.slice(0, 3).map((x) => x.name).join(', ')}`;
      }
      if (mergedRelatedCandidates.length) {
        return isCn
          ? `同页相关产品已更新（related_products）：${mergedRelatedCandidates.slice(0, 3).map((x) => x.name).join('、')}`
          : `Related products refreshed on main path: ${mergedRelatedCandidates.slice(0, 3).map((x) => x.name).join(', ')}`;
      }
      if (mergedDupeCandidates.length) {
        return isCn
          ? `dupe 候选已补齐：${mergedDupeCandidates.slice(0, 3).map((x) => x.name).join('、')}`
          : `Dupe candidates refreshed: ${mergedDupeCandidates.slice(0, 3).map((x) => x.name).join(', ')}`;
      }
      return '';
    })();

    const existingProvenance = isObject(payloadObj.provenance) ? payloadObj.provenance : {};
    const nextProvenancePatch = isObject(dagOut.provenance_patch) ? dagOut.provenance_patch : null;

    const mergedPayload = {
      ...payloadObj,
      competitors: { candidates: mergedCandidates },
      ...(mergedRelatedCandidates.length ? { related_products: { candidates: mergedRelatedCandidates } } : {}),
      ...(mergedDupeCandidates.length ? { dupes: { candidates: mergedDupeCandidates } } : {}),
      evidence: {
        ...evidenceObj,
        expert_notes: uniqCaseInsensitiveStrings([...existingExpertNotes, syncNote], 8),
        missing_info: evidenceMissing,
      },
      ...(isObject(dagOut.confidence_patch) ? { confidence_by_block: dagOut.confidence_patch } : {}),
      provenance: {
        ...existingProvenance,
        source: 'url_realtime_product_intel_sync_repair',
        ...(nextProvenancePatch || {}),
      },
      internal_debug_codes: mergedMissingInfo,
    };
    return { payload: mergedPayload, enhanced: true, reason: null };
  }

  return {
    scheduleProductIntelCompetitorEnrichBackfill,
    maybeSyncRepairLowCoverageCompetitors,
  };
}

module.exports = {
  createProductIntelCompetitorBackfillRuntime,
};
