const noopMountRoute = () => {};

const AURORA_DEGRADED_PATH_PREFIXES = Object.freeze([
  '/v1/chat',
  '/v1/session/',
  '/v1/profile/',
  '/v1/tracker/',
  '/v1/product/',
  '/v1/dupe/',
  '/v1/reco/generate',
  '/v1/reco/employee-feedback',
  '/v1/reco/interleave/',
  '/v1/reco/async-updates',
  '/v1/photos/',
  '/v1/analysis/skin',
  '/v1/routine/simulate',
  '/v1/affiliate/outcome',
  '/v1/auth/',
  '/v1/ops/pdp-prefetch/',
  '/v1/offers/resolve',
]);

function resolveAuroraRoutesFailClosed(env = process.env) {
  const raw = String(
    env?.AURORA_ROUTES_FAIL_CLOSED ||
      env?.AURORA_BFF_FAIL_CLOSED ||
      '',
  )
    .trim()
    .toLowerCase();
  if (!raw) {
    return false;
  }
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

function buildAuroraDegradedPathMatcher(prefixes = AURORA_DEGRADED_PATH_PREFIXES) {
  return (pathname) => {
    const path = String(pathname || '').trim();
    if (!path) return false;
    return prefixes.some((prefix) =>
      prefix.endsWith('/')
        ? path.startsWith(prefix)
        : path === prefix || path.startsWith(`${prefix}/`),
    );
  };
}

function bootstrapOptionalRouteOwners({
  logger,
  env = process.env,
  requireLookReplicator = () => require('./lookReplicator'),
  requireAuroraRoutes = () => require('./auroraBff/routes'),
} = {}) {
  const auroraRoutesFailClosed = resolveAuroraRoutesFailClosed(env);
  const isAuroraDegradedPath = buildAuroraDegradedPathMatcher();

  let mountLookReplicatorRoutes = noopMountRoute;
  try {
    ({ mountLookReplicatorRoutes } = requireLookReplicator());
  } catch (err) {
    logger.error(
      { err: err?.message || String(err) },
      'lookReplicator module failed to load; disabling look replicator routes',
    );
  }

  let mountAuroraBffRoutes = noopMountRoute;
  let auroraBffInternal = {};
  let auroraRoutesReady = false;
  let auroraRoutesLoadError = null;

  try {
    const auroraRoutes = requireAuroraRoutes();
    mountAuroraBffRoutes =
      typeof auroraRoutes?.mountAuroraBffRoutes === 'function'
        ? auroraRoutes.mountAuroraBffRoutes
        : noopMountRoute;
    auroraBffInternal =
      auroraRoutes?.__internal && typeof auroraRoutes.__internal === 'object'
        ? auroraRoutes.__internal
        : {};

    if (mountAuroraBffRoutes === noopMountRoute) {
      const exportErr = new Error(
        'auroraBff routes module loaded but mountAuroraBffRoutes export is missing',
      );
      exportErr.code = 'AURORA_ROUTES_EXPORT_MISSING';
      throw exportErr;
    }

    auroraRoutesReady = true;
  } catch (err) {
    auroraRoutesReady = false;
    auroraRoutesLoadError = String(
      err?.stack || err?.message || err || 'unknown_error',
    ).slice(0, 1200);
    logger.error(
      {
        err: err?.message || String(err),
        fail_closed: auroraRoutesFailClosed,
        aurora_routes_ready: false,
      },
      'auroraBff routes failed to load; disabling aurora routes for this process',
    );
  }

  return {
    auroraRoutesFailClosed,
    auroraRoutesReady,
    auroraRoutesLoadError,
    auroraBffInternal,
    mountLookReplicatorRoutes,
    mountAuroraBffRoutes,
    getAuroraPdpPrefetchStateSnapshot:
      typeof auroraBffInternal.getPdpPrefetchStateSnapshot === 'function'
        ? auroraBffInternal.getPdpPrefetchStateSnapshot
        : null,
    getAuroraRequiredRouteContractsHealth:
      typeof auroraBffInternal.getRequiredRouteContractsHealth === 'function'
        ? auroraBffInternal.getRequiredRouteContractsHealth
        : null,
    isAuroraDegradedPath,
  };
}

module.exports = {
  AURORA_DEGRADED_PATH_PREFIXES,
  buildAuroraDegradedPathMatcher,
  bootstrapOptionalRouteOwners,
  noopMountRoute,
  resolveAuroraRoutesFailClosed,
};
