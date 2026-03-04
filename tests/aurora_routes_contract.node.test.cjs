const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

const {
  TRAVEL_PLANS_REQUIRED_ROUTE_CONTRACTS,
  assertRequiredRouteContracts,
  findMissingRouteContracts,
  collectMountedRouteContracts,
} = require('../src/auroraBff/requiredRouteContracts');

function buildApp() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const routesModule = require('../src/auroraBff/routes');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  routesModule.mountAuroraBffRoutes(app, { logger: null });
  return { app, moduleId, routesModule };
}

test('required route contracts: travel plans endpoints are mounted', () => {
  const { app, moduleId } = buildApp();
  try {
    const result = assertRequiredRouteContracts(app, TRAVEL_PLANS_REQUIRED_ROUTE_CONTRACTS, {
      scope: 'travel_plans',
    });
    assert.equal(result.ok, true);
    assert.equal(Array.isArray(result.missing_routes), true);
    assert.equal(result.missing_routes.length, 0);

    const mounted = collectMountedRouteContracts(app);
    const mountedSet = new Set(mounted.map((item) => `${item.method} ${item.path}`));
    for (const route of TRAVEL_PLANS_REQUIRED_ROUTE_CONTRACTS) {
      assert.equal(mountedSet.has(`${route.method} ${route.path}`), true, `${route.method} ${route.path} should be mounted`);
    }
  } finally {
    delete require.cache[moduleId];
  }
});

test('required route contracts: missing routes are detected on bare app', () => {
  const app = express();
  const missing = findMissingRouteContracts(app, TRAVEL_PLANS_REQUIRED_ROUTE_CONTRACTS);
  assert.equal(missing.length, TRAVEL_PLANS_REQUIRED_ROUTE_CONTRACTS.length);
  assert.throws(
    () =>
      assertRequiredRouteContracts(app, TRAVEL_PLANS_REQUIRED_ROUTE_CONTRACTS, {
        scope: 'travel_plans',
      }),
    (err) => err && err.code === 'REQUIRED_ROUTE_CONTRACTS_MISSING',
  );
});

test('routes __internal exposes required route contract health snapshot', () => {
  const { moduleId, routesModule } = buildApp();
  try {
    const health = routesModule.__internal.getRequiredRouteContractsHealth();
    assert.equal(Boolean(health && health.checked), true);
    assert.equal(Boolean(health && health.ok), true);
    assert.equal(Array.isArray(health && health.missing_routes), true);
    assert.equal((health && health.missing_routes && health.missing_routes.length) || 0, 0);
  } finally {
    delete require.cache[moduleId];
  }
});
