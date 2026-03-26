function createProductIntelBackfillRuntime(options = {}) {
  const {
    PRODUCT_INTEL_KB_ASYNC_BACKFILL_ENABLED = false,
    annotateProductIntelKbWriteDecision = () => null,
    buildProductIntelKbKey = () => '',
    annotateProductIntelRelaxedProvenance = () => null,
    shouldPersistProductIntelKb = () => ({
      attempted: false,
      persisted: false,
      blocked_reason: 'unsupported',
    }),
    resolveProductIntelKbKeyQuality = () => 'none',
    collectProductGuardrailFlags = () => [],
    resolveProductAnalysisConfidenceBand = () => 'unknown',
    resolveProductAnalysisQualityBand = () => 'low',
    AURORA_KB_WRITE_POLICY = 'strict',
    AURORA_KB_SERVE_POLICY = 'strict',
    AURORA_RULE_RELAX_MODE = 'strict',
    scheduleDetachedAsyncJob = () => null,
    upsertProductIntelKbEntry = async () => undefined,
  } = options;

  function clonePayload(payload) {
    try {
      return JSON.parse(JSON.stringify(payload));
    } catch {
      return null;
    }
  }

  function scheduleProductIntelKbBackfill({
    productUrl,
    parsedProduct = null,
    productHint = '',
    payload = null,
    lang = 'EN',
    source = 'url_realtime_product_intel',
    sourceMeta = null,
    logger,
  } = {}) {
    if (!PRODUCT_INTEL_KB_ASYNC_BACKFILL_ENABLED) {
      annotateProductIntelKbWriteDecision(payload, {
        attempted: false,
        persisted: false,
        blocked_reason: 'kb_backfill_disabled',
      });
      return { attempted: false, persisted: false, blocked_reason: 'kb_backfill_disabled' };
    }

    const kbKey = buildProductIntelKbKey({ productUrl, parsedProduct, lang, productHint });
    if (!kbKey) {
      annotateProductIntelKbWriteDecision(payload, {
        attempted: false,
        persisted: false,
        blocked_reason: 'kb_key_missing',
      });
      return { attempted: false, persisted: false, blocked_reason: 'kb_key_missing' };
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { attempted: false, persisted: false, blocked_reason: 'payload_missing' };
    }

    annotateProductIntelRelaxedProvenance(payload);

    let analysisSnapshot = clonePayload(payload);
    if (!analysisSnapshot || typeof analysisSnapshot !== 'object' || Array.isArray(analysisSnapshot)) {
      annotateProductIntelKbWriteDecision(payload, {
        attempted: false,
        persisted: false,
        blocked_reason: 'payload_snapshot_failed',
      });
      return { attempted: false, persisted: false, blocked_reason: 'payload_snapshot_failed' };
    }

    const sourceMetaObj = sourceMeta && typeof sourceMeta === 'object' && !Array.isArray(sourceMeta) ? sourceMeta : null;
    const persistDecision = shouldPersistProductIntelKb(payload, sourceMetaObj);
    annotateProductIntelKbWriteDecision(payload, persistDecision);
    if (!persistDecision.persisted) {
      logger?.debug?.(
        {
          kb_key: kbKey,
          blocked_reason: persistDecision.blocked_reason || 'kb_write_blocked',
        },
        'aurora bff: skipped product-intel kb backfill by strict gate',
      );
      return persistDecision;
    }

    analysisSnapshot = clonePayload(payload);
    if (!analysisSnapshot || typeof analysisSnapshot !== 'object' || Array.isArray(analysisSnapshot)) {
      return { attempted: false, persisted: false, blocked_reason: 'payload_snapshot_failed' };
    }

    annotateProductIntelRelaxedProvenance(analysisSnapshot);
    const keyQuality = resolveProductIntelKbKeyQuality({ productUrl, parsedProduct, productHint, lang });
    const guardrailFlags = collectProductGuardrailFlags(analysisSnapshot);
    const confidenceBand = resolveProductAnalysisConfidenceBand(analysisSnapshot);
    const qualityBand = resolveProductAnalysisQualityBand(analysisSnapshot);
    const mergedSourceMeta = {
      ...(sourceMetaObj || {}),
      key_quality:
        sourceMetaObj && typeof sourceMetaObj.key_quality === 'string' && sourceMetaObj.key_quality.trim()
          ? sourceMetaObj.key_quality.trim()
          : keyQuality,
      kb_write: {
        attempted: persistDecision.attempted === true,
        persisted: persistDecision.persisted === true,
        blocked_reason: persistDecision.blocked_reason ? String(persistDecision.blocked_reason) : null,
        audit_blocked_reason: persistDecision.audit_blocked_reason ? String(persistDecision.audit_blocked_reason) : null,
        policy: persistDecision.policy ? String(persistDecision.policy) : AURORA_KB_WRITE_POLICY,
      },
      kb_write_policy: AURORA_KB_WRITE_POLICY,
      kb_serve_policy: AURORA_KB_SERVE_POLICY,
      gate_relax_mode: AURORA_RULE_RELAX_MODE,
      confidence_band: confidenceBand,
      quality_grade: qualityBand,
      guardrail_flags: guardrailFlags,
    };

    scheduleDetachedAsyncJob(async () => {
      try {
        await upsertProductIntelKbEntry({
          kb_key: kbKey,
          analysis: analysisSnapshot,
          source,
          source_meta: mergedSourceMeta,
          last_success_at: new Date().toISOString(),
          last_error: null,
        });
      } catch (err) {
        logger?.warn?.(
          { err: err?.message || String(err), kb_key: kbKey },
          'aurora bff: async product-intel kb backfill failed',
        );
      }
    });

    return persistDecision;
  }

  return {
    scheduleProductIntelKbBackfill,
  };
}

module.exports = {
  createProductIntelBackfillRuntime,
};
