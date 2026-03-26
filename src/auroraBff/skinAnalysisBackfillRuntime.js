function createSkinAnalysisBackfillRuntime(options = {}) {
  const {
    PRODUCT_INTEL_KB_ASYNC_BACKFILL_ENABLED = false,
    AURORA_RULE_RELAX_MODE = 'disabled',
    uniqCaseInsensitiveStrings = (items, max = 16) => {
      const out = [];
      const seen = new Set();
      for (const item of Array.isArray(items) ? items : []) {
        const value = String(item || '').trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
        if (out.length >= max) break;
      }
      return out;
    },
    createArtifactId = null,
    saveDiagnosisArtifact = null,
    setImmediateImpl = setImmediate,
  } = options;

  function scheduleSkinAnalysisKbBackfill({
    ctx,
    identity,
    analysisSummaryPayload,
    analysisMeta = null,
    logger,
  } = {}) {
    if (!PRODUCT_INTEL_KB_ASYNC_BACKFILL_ENABLED) {
      return {
        attempted: false,
        queued: false,
        blocked_reason: 'kb_backfill_disabled',
      };
    }

    const payload =
      analysisSummaryPayload &&
      typeof analysisSummaryPayload === 'object' &&
      !Array.isArray(analysisSummaryPayload)
        ? analysisSummaryPayload
        : null;
    if (!payload || !payload.analysis || typeof payload.analysis !== 'object') {
      return {
        attempted: false,
        queued: false,
        blocked_reason: 'analysis_summary_missing',
      };
    }

    const identityObj = identity && typeof identity === 'object' ? identity : {};
    const confidenceScoreRaw = Number(
      payload.analysis?.overall_confidence?.score ??
        payload.analysis?.confidence?.score ??
        (payload.low_confidence === true ? 0.35 : NaN),
    );
    const confidenceScore = Number.isFinite(confidenceScoreRaw)
      ? Math.max(0, Math.min(1, confidenceScoreRaw))
      : null;
    const confidenceLevel =
      confidenceScore == null
        ? null
        : confidenceScore >= 0.75
          ? 'high'
          : confidenceScore >= 0.45
            ? 'medium'
            : 'low';
    const qualityGrade =
      String(payload?.quality_report?.photo_quality?.grade || 'unknown').trim().toLowerCase() || 'unknown';
    const guardrailFlags = uniqCaseInsensitiveStrings(
      [
        ...(Array.isArray(payload?.quality_report?.llm?.vision?.reasons) ? payload.quality_report.llm.vision.reasons : []),
        ...(Array.isArray(payload?.quality_report?.llm?.report?.reasons) ? payload.quality_report.llm.report.reasons : []),
      ],
      16,
    );

    let snapshot = null;
    try {
      snapshot = JSON.parse(JSON.stringify(payload));
    } catch {
      snapshot = null;
    }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return {
        attempted: false,
        queued: false,
        blocked_reason: 'analysis_snapshot_unserializable',
      };
    }

    const artifact = {
      artifact_id: createArtifactId(),
      created_at: new Date().toISOString(),
      artifact_type: 'skin_analysis_kb_snapshot_v1',
      analysis_summary: snapshot,
      overall_confidence: {
        score: confidenceScore,
        level: confidenceLevel,
      },
      provenance: {
        source_chain: ['skin_analysis', 'analysis_summary'],
        confidence_band: confidenceLevel || 'unknown',
        quality_grade: qualityGrade,
        guardrail_flags: guardrailFlags,
        gate_relax_mode: AURORA_RULE_RELAX_MODE,
        model_provenance:
          analysisMeta && typeof analysisMeta === 'object' && !Array.isArray(analysisMeta) ? analysisMeta : {},
      },
    };

    setImmediateImpl(() => {
      Promise.resolve(
        saveDiagnosisArtifact({
          auroraUid: identityObj.auroraUid || ctx?.aurora_uid || null,
          userId: identityObj.userId || null,
          sessionId: ctx?.brief_id || null,
          artifact,
          artifactId: artifact.artifact_id,
        }),
      ).catch((err) => {
        logger?.warn?.(
          {
            err: err?.message || String(err),
            request_id: ctx?.request_id || null,
            trace_id: ctx?.trace_id || null,
          },
          'aurora bff: skin analysis async kb backfill failed',
        );
      });
    });

    return {
      attempted: true,
      queued: true,
      blocked_reason: null,
      artifact_type: artifact.artifact_type,
    };
  }

  return {
    scheduleSkinAnalysisKbBackfill,
  };
}

module.exports = {
  createSkinAnalysisBackfillRuntime,
};
