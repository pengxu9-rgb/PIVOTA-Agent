function createPdpCorePrewarmRuntime({
  getAuroraPdpPrefetchStateSnapshot,
  runPdpCorePrewarmPassBase,
  targets,
  gatewayUrl,
  port,
  timeoutMs,
  intervalMs,
  axiosClient,
  logger,
} = {}) {
  function snapshotPdpV2CoreHotCacheStats() {
    if (!getAuroraPdpPrefetchStateSnapshot) {
      return {
        available: false,
        reason: 'aurora_bff_prefetch_snapshot_not_exported',
      };
    }

    try {
      const snapshot = getAuroraPdpPrefetchStateSnapshot();
      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        return {
          available: true,
          ...snapshot,
        };
      }
      return {
        available: true,
        snapshot: snapshot == null ? null : snapshot,
      };
    } catch (err) {
      return {
        available: false,
        reason: 'aurora_bff_prefetch_snapshot_failed',
        error: String(err && err.message ? err.message : err || 'unknown_error'),
      };
    }
  }

  async function runPdpCorePrewarmPass() {
    return runPdpCorePrewarmPassBase({
      targets,
      gatewayUrl,
      port,
      timeoutMs,
      intervalMs,
      axios: axiosClient,
      logger,
    });
  }

  return {
    snapshotPdpV2CoreHotCacheStats,
    runPdpCorePrewarmPass,
  };
}

module.exports = {
  createPdpCorePrewarmRuntime,
};
