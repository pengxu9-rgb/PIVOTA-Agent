const {
  scheduleCreatorCatalogAutoSync,
  schedulePdpCorePrewarm,
  startGatewayServer,
} = require('../src/serverStartup');

describe('serverStartup', () => {
  test('scheduleCreatorCatalogAutoSync schedules initial run and interval', () => {
    const setTimeoutFn = jest.fn((fn) => {
      fn();
      return 1;
    });
    const setIntervalFn = jest.fn(() => 2);
    const runCreatorCatalogAutoSync = jest.fn();
    const logger = { warn: jest.fn() };

    expect(
      scheduleCreatorCatalogAutoSync({
        enabled: true,
        getIntervalConfig: () => ({
          intervalMinutes: 15,
          clamped: true,
          configuredMinutes: 60,
          maxIntervalMinutes: 15,
        }),
        initialDelayMs: 1200,
        runCreatorCatalogAutoSync,
        cacheTtlSeconds: 3600,
        logger,
        setTimeoutFn,
        setIntervalFn,
      }),
    ).toEqual({
      scheduled: true,
      initialDelayMs: 1200,
      intervalMinutes: 15,
      clamped: true,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        configured_interval_minutes: 60,
        effective_interval_minutes: 15,
        max_allowed_interval_minutes: 15,
        cache_ttl_seconds: 3600,
      }),
      'CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES exceeds ttl guardrail; clamping to safe interval',
    );
    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 1200);
    expect(runCreatorCatalogAutoSync).toHaveBeenCalledTimes(1);
    expect(setIntervalFn).toHaveBeenCalledWith(runCreatorCatalogAutoSync, 15 * 60 * 1000);
  });

  test('schedulePdpCorePrewarm warns when enabled without targets', () => {
    const logger = { warn: jest.fn() };

    expect(
      schedulePdpCorePrewarm({
        enabled: true,
        targets: [],
        initialDelayMs: 3000,
        intervalMs: 60000,
        runPdpCorePrewarmPass: jest.fn(),
        logger,
      }),
    ).toEqual({
      scheduled: false,
      missingTargets: true,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      { env: 'PDP_CORE_PREWARM_TARGETS', enabled: true },
      'PDP core prewarm is enabled but no targets were configured',
    );
  });

  test('startGatewayServer fail-closes when aurora routes are unavailable', async () => {
    const logger = { error: jest.fn(), info: jest.fn(), warn: jest.fn() };

    await expect(
      startGatewayServer({
        app: { listen: jest.fn() },
        port: 8080,
        useMock: false,
        apiMode: 'REAL',
        pivotaApiBase: 'http://localhost:8080',
        logger,
        auroraRoutesFailClosed: true,
        auroraRoutesReady: false,
        auroraRoutesLoadError: 'boom',
        runMigrations: jest.fn(),
      }),
    ).rejects.toThrow('AURORA_ROUTES_UNAVAILABLE: boom');

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        aurora_routes_ready: false,
        aurora_routes_fail_closed: true,
        aurora_routes_error: 'boom',
      }),
      'Aurora routes unavailable at startup; fail-closed is enabled',
    );
  });

  test('startGatewayServer runs migrations, listens, and wires server error handler', async () => {
    const server = { on: jest.fn() };
    const app = {
      listen: jest.fn((port, cb) => {
        cb();
        return server;
      }),
    };
    const runMigrations = jest.fn().mockResolvedValue(undefined);
    const runCreatorCatalogAutoSync = jest.fn();
    const runPdpCorePrewarmPass = jest.fn().mockResolvedValue(undefined);
    const logger = { error: jest.fn(), info: jest.fn(), warn: jest.fn() };
    const setTimeoutFn = jest.fn((fn) => {
      fn();
      return 1;
    });
    const setIntervalFn = jest.fn(() => 2);

    const result = await startGatewayServer({
      app,
      port: 8080,
      useMock: false,
      apiMode: 'REAL',
      pivotaApiBase: 'http://pivota.test',
      logger,
      auroraRoutesFailClosed: false,
      auroraRoutesReady: true,
      auroraRoutesLoadError: null,
      databaseUrl: 'postgres://example',
      dbAutoMigrate: 'true',
      nodeEnv: 'production',
      runMigrations,
      creatorCatalogAutoSyncEnabled: true,
      getCreatorCatalogAutoSyncIntervalConfig: () => ({
        intervalMinutes: 10,
        clamped: false,
      }),
      creatorCatalogCacheTtlSeconds: 3600,
      creatorCatalogAutoSyncInitialDelayMs: 1500,
      runCreatorCatalogAutoSync,
      pdpCorePrewarmEnabled: true,
      pdpCorePrewarmTargets: [{ merchant_id: 'm1', product_id: 'p1' }],
      pdpCorePrewarmInitialDelayMs: 2500,
      pdpCorePrewarmIntervalMs: 300000,
      runPdpCorePrewarmPass,
      setTimeoutFn,
      setIntervalFn,
    });

    expect(result).toBe(server);
    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(app.listen).toHaveBeenCalledWith(8080, expect.any(Function));
    expect(logger.info).toHaveBeenCalledWith('Running DB migrations (auto)');
    expect(logger.info).toHaveBeenCalledWith('DB migrations complete');
    expect(logger.info).toHaveBeenCalledWith(
      { port: 8080, use_mock: false, mode: 'REAL' },
      'Pivota Agent gateway listening on http://localhost:8080, proxying to http://pivota.test',
    );
    expect(runCreatorCatalogAutoSync).toHaveBeenCalledTimes(1);
    expect(runPdpCorePrewarmPass).toHaveBeenCalledTimes(1);
    expect(setIntervalFn).toHaveBeenNthCalledWith(1, runCreatorCatalogAutoSync, 10 * 60 * 1000);
    expect(setIntervalFn).toHaveBeenNthCalledWith(2, expect.any(Function), 300000);
    expect(server.on).toHaveBeenCalledWith('error', expect.any(Function));

    const onErrorHandler = server.on.mock.calls[0][1];
    onErrorHandler(new Error('bind failed'));
    expect(logger.error).toHaveBeenCalledWith(
      { err: 'bind failed', port: 8080 },
      'Gateway failed to bind',
    );
  });
});
