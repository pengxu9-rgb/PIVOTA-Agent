function createRecoAlternativesRouteHandlerRuntime(deps = {}) {
  const {
    buildRequestContext,
    requireAuroraUid,
    RecoAlternativesRequestSchema,
    resolveIdentity,
    getProfileForIdentity,
    getRecentSkinLogsForIdentity,
    buildProductInputText,
    extractAnchorIdFromProductLike,
    coerceBoolean,
    isExternalRecoAlternativesSeedProduct,
    fetchRecoAlternativesForExternalSeedProduct,
    fetchRecoAlternativesForProduct,
    summarizeProfileForContext,
    logger,
  } = deps;

  async function handleRecoAlternativesRoute(req, res) {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = RecoAlternativesRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
          ok: false,
          error: 'BAD_REQUEST',
          details: parsed.error.format(),
        });
      }

      const identity = await resolveIdentity(req, ctx);
      const profile = await getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }).catch(() => null);
      const recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7).catch(() => []);
      const productObj =
        parsed.data.product && typeof parsed.data.product === 'object' && !Array.isArray(parsed.data.product)
          ? parsed.data.product
          : null;
      const productInput = String(parsed.data.product_input || '').trim() || buildProductInputText(productObj, null);
      const anchorId = String(parsed.data.anchor_product_id || '').trim() || extractAnchorIdFromProductLike(productObj);
      const debugHeaderRaw = req.get('X-Debug') ?? req.get('X-Aurora-Debug');
      const includeDebugFromHeader = debugHeaderRaw == null || debugHeaderRaw === '' ? null : coerceBoolean(debugHeaderRaw);
      const includeDebug = includeDebugFromHeader == null ? Boolean(parsed.data.include_debug) : includeDebugFromHeader;
      const disableSyntheticLocalFallback = parsed.data.disable_synthetic_local_fallback !== false;
      const recommendationMode = String(parsed.data.recommendation_mode || '').trim() || 'pool_open_world_mixed';
      const maxTotal = Number.isFinite(Number(parsed.data.max_total))
        ? Math.max(1, Math.min(8, Math.trunc(Number(parsed.data.max_total))))
        : 6;
      const isExternalSeedCompare = isExternalRecoAlternativesSeedProduct(productObj);

      if (!productInput && !anchorId) {
        return res.status(400).json({
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
          ok: false,
          error: 'PRODUCT_IDENTITY_MISSING',
          field_missing: [{ field: 'product_input', reason: 'product_identity_missing' }],
        });
      }

      const out = isExternalSeedCompare
        ? await fetchRecoAlternativesForExternalSeedProduct({
          ctx,
          productInput,
          productObj,
          anchorId,
          maxTotal,
          logger,
        })
        : await fetchRecoAlternativesForProduct({
          ctx,
          profileSummary: summarizeProfileForContext(profile),
          recentLogs,
          productInput,
          productObj,
          anchorId,
          maxTotal,
          debug: includeDebug,
          logger,
          options: {
            recommendation_mode: recommendationMode,
            disable_fallback: true,
            disable_synthetic_local_fallback: disableSyntheticLocalFallback,
          },
        });

      return res.json({
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
        ok: out && out.ok !== false,
        alternatives: Array.isArray(out && out.alternatives) ? out.alternatives : [],
        field_missing: Array.isArray(out && out.field_missing) ? out.field_missing : [],
        source_mode: out && typeof out.source_mode === 'string' ? out.source_mode : 'llm',
        fallback_source: out && typeof out.fallback_source === 'string' ? out.fallback_source : null,
        refresh_pending: Boolean(out && out.refresh_pending === true),
        refresh_after_ms: Number.isFinite(Number(out?.refresh_after_ms)) ? Number(out?.refresh_after_ms) : 0,
        failure_class: out && typeof out.failure_class === 'string' ? out.failure_class : null,
        attempt_count: Number.isFinite(Number(out?.attempt_count)) ? Math.max(0, Math.trunc(Number(out?.attempt_count))) : 0,
        prompt_contract_ok: out && out.prompt_contract_ok !== false,
        prompt_contract_issues: Array.isArray(out && out.prompt_contract_issues) ? out.prompt_contract_issues : [],
        no_result_reason: out && out.no_result_reason ? String(out.no_result_reason) : null,
        timeout_root_cause: out && out.timeout_root_cause ? String(out.timeout_root_cause) : null,
        llm_trace: out && out.llm_trace && typeof out.llm_trace === 'object' ? out.llm_trace : null,
        ...(out && out.compare_meta && typeof out.compare_meta === 'object' ? { compare_meta: out.compare_meta } : {}),
        ...(includeDebug && out && out.debug && typeof out.debug === 'object' ? { debug: out.debug } : {}),
      });
    } catch (err) {
      logger?.warn(
        { err: err && err.message ? err.message : String(err), request_id: ctx.request_id, trace_id: ctx.trace_id },
        'aurora bff: reco alternatives endpoint failed',
      );
      return res.status(500).json({
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
        ok: false,
        error: err && err.code ? err.code : 'RECO_ALTERNATIVES_FAILED',
      });
    }
  }

  return {
    handleRecoAlternativesRoute,
  };
}

module.exports = {
  createRecoAlternativesRouteHandlerRuntime,
};
