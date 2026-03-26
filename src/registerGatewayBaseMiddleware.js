function registerGatewayBaseMiddleware({
  app,
  expressModule,
  publicDir,
  env = process.env,
  logger,
  serviceGitShaShort,
  serviceBuildId,
  serviceGitBranch,
  serviceDeploymentId,
  serviceName,
} = {}) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const defaults = [
      'https://agent.pivota.cc',
      'https://creator.pivota.cc',
      'https://look-replicator.pivota.cc',
      'https://aurora.pivota.cc',
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173',
    ];

    const fromEnv = String(env.ALLOWED_ORIGINS || env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const allowedOrigins = new Set([...defaults, ...fromEnv]);

    res.header('Vary', 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method');

    const isAllowedOrigin = origin && origin !== 'null' && allowedOrigins.has(origin);
    if (isAllowedOrigin) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
    }

    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');

    const baseAllowedHeaders = [
      'content-type',
      'authorization',
      'x-api-key',
      'x-agent-api-key',
      'x-checkout-token',
      'x-aurora-uid',
      'x-aurora-lang',
      'x-trace-id',
      'x-brief-id',
      'x-lang',
      'x-session-id',
    ];
    const requested = String(req.headers['access-control-request-headers'] || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const allowedHeaders = Array.from(new Set([...baseAllowedHeaders, ...requested]))
      .map((h) =>
        h
          .split('-')
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join('-'),
      )
      .join(', ');
    res.header('Access-Control-Allow-Headers', allowedHeaders);

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    return next();
  });

  app.use(
    expressModule.json({
      limit: '10mb',
      verify: (req, res, buf) => {
        try {
          JSON.parse(buf);
        } catch (e) {
          throw new Error('Invalid JSON');
        }
      },
    }),
  );

  app.use((req, res, next) => {
    if (serviceGitShaShort) {
      res.setHeader('X-Service-Commit', serviceGitShaShort);
      res.setHeader('X-Aurora-Git-Sha', serviceGitShaShort);
    }
    if (serviceDeploymentId) res.setHeader('X-Service-Deployment-Id', serviceDeploymentId);
    if (serviceGitBranch) res.setHeader('X-Service-Branch', serviceGitBranch);
    res.setHeader('X-Aurora-Build', serviceBuildId);
    res.setHeader('X-Service-Name', serviceName);
    return next();
  });

  app.use(expressModule.static(publicDir));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - start,
        build_id: serviceBuildId,
        service_commit: serviceGitShaShort,
      });
    });
    next();
  });
}

module.exports = {
  registerGatewayBaseMiddleware,
};
