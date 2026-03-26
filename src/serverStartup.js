function scheduleCreatorCatalogAutoSync({
  enabled,
  getIntervalConfig,
  initialDelayMs,
  runCreatorCatalogAutoSync,
  cacheTtlSeconds,
  logger,
  setTimeoutFn = setTimeout,
  setIntervalFn = setInterval,
} = {}) {
  if (!enabled) return { scheduled: false };

  const autoSyncIntervalConfig = getIntervalConfig();
  const intervalMin = autoSyncIntervalConfig.intervalMinutes;
  if (autoSyncIntervalConfig.clamped) {
    logger.warn(
      {
        configured_interval_minutes: autoSyncIntervalConfig.configuredMinutes,
        effective_interval_minutes: autoSyncIntervalConfig.intervalMinutes,
        max_allowed_interval_minutes: autoSyncIntervalConfig.maxIntervalMinutes,
        cache_ttl_seconds: cacheTtlSeconds,
      },
      'CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES exceeds ttl guardrail; clamping to safe interval',
    );
  }

  setTimeoutFn(() => {
    runCreatorCatalogAutoSync();
    setIntervalFn(runCreatorCatalogAutoSync, intervalMin * 60 * 1000);
  }, initialDelayMs);

  return {
    scheduled: true,
    initialDelayMs,
    intervalMinutes: intervalMin,
    clamped: Boolean(autoSyncIntervalConfig.clamped),
  };
}

function schedulePdpCorePrewarm({
  enabled,
  targets,
  initialDelayMs,
  intervalMs,
  runPdpCorePrewarmPass,
  logger,
  setTimeoutFn = setTimeout,
  setIntervalFn = setInterval,
} = {}) {
  if (!enabled) return { scheduled: false };

  const normalizedTargets = Array.isArray(targets) ? targets : [];
  if (!normalizedTargets.length) {
    logger.warn(
      { env: 'PDP_CORE_PREWARM_TARGETS', enabled: true },
      'PDP core prewarm is enabled but no targets were configured',
    );
    return { scheduled: false, missingTargets: true };
  }

  const runAndLog = () => {
    runPdpCorePrewarmPass().catch((err) => {
      logger.warn({ err: err?.message || String(err) }, 'PDP core prewarm pass failed');
    });
  };

  setTimeoutFn(() => {
    runAndLog();
    setIntervalFn(runAndLog, intervalMs);
  }, initialDelayMs);

  return {
    scheduled: true,
    initialDelayMs,
    intervalMs,
    targetCount: normalizedTargets.length,
  };
}

async function startGatewayServer({
  app,
  port,
  useMock,
  apiMode,
  pivotaApiBase,
  logger,
  auroraRoutesFailClosed,
  auroraRoutesReady,
  auroraRoutesLoadError,
  databaseUrl = process.env.DATABASE_URL,
  dbAutoMigrate = process.env.DB_AUTO_MIGRATE,
  nodeEnv = process.env.NODE_ENV,
  runMigrations,
  creatorCatalogAutoSyncEnabled,
  getCreatorCatalogAutoSyncIntervalConfig,
  creatorCatalogCacheTtlSeconds,
  creatorCatalogAutoSyncInitialDelayMs,
  runCreatorCatalogAutoSync,
  pdpCorePrewarmEnabled,
  pdpCorePrewarmTargets,
  pdpCorePrewarmInitialDelayMs,
  pdpCorePrewarmIntervalMs,
  runPdpCorePrewarmPass,
  setTimeoutFn = setTimeout,
  setIntervalFn = setInterval,
} = {}) {
  if (auroraRoutesFailClosed && !auroraRoutesReady) {
    logger.error(
      {
        aurora_routes_ready: false,
        aurora_routes_fail_closed: auroraRoutesFailClosed,
        aurora_routes_error: auroraRoutesLoadError,
      },
      'Aurora routes unavailable at startup; fail-closed is enabled',
    );
    throw new Error(`AURORA_ROUTES_UNAVAILABLE: ${auroraRoutesLoadError || 'unknown_error'}`);
  }

  const hasDb = Boolean(databaseUrl);
  const autoMigrateDisabled = String(dbAutoMigrate || '').toLowerCase() === 'false';
  const env = String(nodeEnv || '').toLowerCase();
  const shouldAutoMigrate = hasDb && !autoMigrateDisabled && env !== 'test';

  if (shouldAutoMigrate) {
    logger.info('Running DB migrations (auto)');
    await runMigrations();
    logger.info('DB migrations complete');
  }

  const server = app.listen(port, () => {
    logger.info(
      { port, use_mock: useMock, mode: apiMode },
      `Pivota Agent gateway listening on http://localhost:${port}, proxying to ${pivotaApiBase}`,
    );

    scheduleCreatorCatalogAutoSync({
      enabled: creatorCatalogAutoSyncEnabled,
      getIntervalConfig: getCreatorCatalogAutoSyncIntervalConfig,
      initialDelayMs: creatorCatalogAutoSyncInitialDelayMs,
      runCreatorCatalogAutoSync,
      cacheTtlSeconds: creatorCatalogCacheTtlSeconds,
      logger,
      setTimeoutFn,
      setIntervalFn,
    });

    schedulePdpCorePrewarm({
      enabled: pdpCorePrewarmEnabled,
      targets: pdpCorePrewarmTargets,
      initialDelayMs: pdpCorePrewarmInitialDelayMs,
      intervalMs: pdpCorePrewarmIntervalMs,
      runPdpCorePrewarmPass,
      logger,
      setTimeoutFn,
      setIntervalFn,
    });
  });

  server.on('error', (err) => {
    logger.error({ err: err?.message || String(err), port }, 'Gateway failed to bind');
  });

  return server;
}

module.exports = {
  scheduleCreatorCatalogAutoSync,
  schedulePdpCorePrewarm,
  startGatewayServer,
};
