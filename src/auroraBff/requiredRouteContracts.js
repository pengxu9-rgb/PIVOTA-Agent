const TRAVEL_PLANS_REQUIRED_ROUTE_CONTRACTS = Object.freeze([
  Object.freeze({ method: 'GET', path: '/v1/travel-plans' }),
  Object.freeze({ method: 'GET', path: '/v1/travel-plans/:trip_id' }),
  Object.freeze({ method: 'POST', path: '/v1/travel-plans' }),
  Object.freeze({ method: 'PATCH', path: '/v1/travel-plans/:trip_id' }),
  Object.freeze({ method: 'POST', path: '/v1/travel-plans/:trip_id/archive' }),
]);

const AURORA_REQUIRED_ROUTE_CONTRACTS = Object.freeze([
  ...TRAVEL_PLANS_REQUIRED_ROUTE_CONTRACTS,
]);

function normalizeHttpMethod(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeRoutePath(value) {
  return String(value || '').trim();
}

function normalizeRouteContract(contract) {
  if (!contract || typeof contract !== 'object') return null;
  const method = normalizeHttpMethod(contract.method);
  const path = normalizeRoutePath(contract.path);
  if (!method || !path) return null;
  return { method, path };
}

function routeKey(contract) {
  const normalized = normalizeRouteContract(contract);
  if (!normalized) return '';
  return `${normalized.method} ${normalized.path}`;
}

function collectMountedRouteContracts(app) {
  const out = [];
  const stack =
    app && app._router && Array.isArray(app._router.stack)
      ? app._router.stack
      : [];

  for (const layer of stack) {
    if (!layer || !layer.route) continue;
    const path = normalizeRoutePath(layer.route.path);
    if (!path) continue;
    const methods =
      layer.route.methods && typeof layer.route.methods === 'object'
        ? layer.route.methods
        : {};
    for (const [method, enabled] of Object.entries(methods)) {
      if (!enabled) continue;
      const normalized = normalizeRouteContract({ method, path });
      if (!normalized) continue;
      out.push(normalized);
    }
  }

  return out;
}

function findMissingRouteContracts(app, requiredContracts) {
  const required = Array.isArray(requiredContracts)
    ? requiredContracts.map(normalizeRouteContract).filter(Boolean)
    : [];
  const mounted = collectMountedRouteContracts(app);
  const mountedSet = new Set(mounted.map(routeKey).filter(Boolean));
  return required.filter((contract) => !mountedSet.has(routeKey(contract)));
}

function assertRequiredRouteContracts(app, requiredContracts, options = {}) {
  const scope = normalizeRoutePath(options.scope) || 'aurora_required_routes';
  const missing = findMissingRouteContracts(app, requiredContracts);
  const mounted = collectMountedRouteContracts(app);

  if (missing.length > 0) {
    const error = new Error(
      `Missing required route contracts (${scope}): ${missing.map(routeKey).join(', ')}`,
    );
    error.code = 'REQUIRED_ROUTE_CONTRACTS_MISSING';
    error.scope = scope;
    error.missing_routes = missing;
    error.mounted_routes = mounted;
    throw error;
  }

  return {
    ok: true,
    scope,
    required_routes: (Array.isArray(requiredContracts) ? requiredContracts : [])
      .map(normalizeRouteContract)
      .filter(Boolean),
    mounted_routes: mounted,
    missing_routes: [],
  };
}

module.exports = {
  TRAVEL_PLANS_REQUIRED_ROUTE_CONTRACTS,
  AURORA_REQUIRED_ROUTE_CONTRACTS,
  normalizeRouteContract,
  collectMountedRouteContracts,
  findMissingRouteContracts,
  assertRequiredRouteContracts,
};
