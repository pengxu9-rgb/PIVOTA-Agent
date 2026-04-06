function createLegacyRecoPdpEnrichmentRuntime(deps = {}) {
  const {
    isPlainObject,
    isRecoUngroundedItem,
    dedupeRecoRecommendationsStrict,
    enrichRecommendationsWithPdpOpenContract,
  } = deps;

  async function applyLegacyRecoPdpEnrichment({
    payload,
    recommendations = [],
    deadlineAtMs = null,
    logger,
    fastExternalFallbackReasonCode = null,
    lightEnrich = false,
    deferUntilSafeWinner = false,
  } = {}) {
    const basePayload =
      isPlainObject(payload) ? { ...payload } : { recommendations: [] };
    const recoRows = Array.isArray(recommendations) ? recommendations : [];

    if (deferUntilSafeWinner) {
      const prePdpDeduped = dedupeRecoRecommendationsStrict(recoRows, { maxItems: 8 });
      return {
        payload: {
          ...basePayload,
          recommendations: prePdpDeduped.recommendations,
          metadata: {
            ...(isPlainObject(basePayload?.metadata) ? basePayload.metadata : {}),
            pdp_open_path_stats: { deferred_until_safe_winner: true },
            resolve_fail_reason_counts: {},
            time_to_pdp_ms_stats: {},
            reco_post_pdp_dedupe_dropped: Number(prePdpDeduped.dropped_count || 0),
          },
        },
        applied: false,
        latencyMs: 0,
      };
    }

    const groundedRecoRows = [];
    const ungroundedRecoRows = [];
    recoRows.forEach((row, index) => {
      if (isRecoUngroundedItem(row)) {
        ungroundedRecoRows.push({ index, row });
      } else {
        groundedRecoRows.push({ index, row });
      }
    });

    const skipPdpOpenEnrichByBudget =
      Number.isFinite(deadlineAtMs) && Date.now() >= deadlineAtMs - 250;
    const startedAt = Date.now();
    const pdpOpenOut = !groundedRecoRows.length
      ? {
          recommendations: [],
          path_stats: { internal: 0, external: 0, none: 0, unknown: 0 },
          fail_reason_counts: {},
          time_to_pdp_ms_stats: { count: 0, mean: 0, p50: 0, p90: 0, max: 0 },
        }
      : skipPdpOpenEnrichByBudget
        ? {
            recommendations: groundedRecoRows.map((entry) => entry.row),
            path_stats: { skipped_due_budget: true },
            fail_reason_counts: {},
            time_to_pdp_ms_stats: {},
          }
        : await enrichRecommendationsWithPdpOpenContract({
            recommendations: groundedRecoRows.map((entry) => entry.row),
            logger,
            fastExternalFallbackReasonCode,
            lightEnrich,
          });

    const recombinedRecommendations = [];
    let groundedCursor = 0;
    let ungroundedCursor = 0;
    for (let index = 0; index < recoRows.length; index += 1) {
      const ungroundedEntry = ungroundedRecoRows[ungroundedCursor];
      if (ungroundedEntry && ungroundedEntry.index === index) {
        recombinedRecommendations.push(ungroundedEntry.row);
        ungroundedCursor += 1;
        continue;
      }
      const groundedEntry = groundedRecoRows[groundedCursor];
      if (groundedEntry && groundedEntry.index === index) {
        recombinedRecommendations.push(
          pdpOpenOut.recommendations[groundedCursor] || groundedEntry.row,
        );
        groundedCursor += 1;
      }
    }

    const pdpDeduped = dedupeRecoRecommendationsStrict(recombinedRecommendations, {
      maxItems: 8,
    });
    return {
      payload: {
        ...basePayload,
        recommendations: pdpDeduped.recommendations,
        metadata: {
          ...(isPlainObject(basePayload?.metadata) ? basePayload.metadata : {}),
          pdp_open_path_stats: pdpOpenOut.path_stats,
          resolve_fail_reason_counts: pdpOpenOut.fail_reason_counts,
          time_to_pdp_ms_stats: pdpOpenOut.time_to_pdp_ms_stats,
          reco_post_pdp_dedupe_dropped: Number(pdpDeduped.dropped_count || 0),
        },
      },
      applied: groundedRecoRows.length > 0,
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
  }

  return {
    applyLegacyRecoPdpEnrichment,
  };
}

module.exports = {
  createLegacyRecoPdpEnrichmentRuntime,
};
