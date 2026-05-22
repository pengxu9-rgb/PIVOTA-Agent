const ENV_KEYS = [
  'RAILWAY_GIT_COMMIT_SHA',
  'GIT_COMMIT_SHA',
  'SOURCE_VERSION',
  'AURORA_GIT_SHA',
  'RAILWAY_GIT_BRANCH',
  'GIT_BRANCH',
  'RAILWAY_DEPLOYMENT_ID',
  'DEPLOYMENT_ID',
  'RAILWAY_SERVICE_NAME',
  'SERVICE_NAME',
];

const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIGINAL_ENV[key];
    }
  }
}

describe('service version metadata', () => {
  beforeEach(() => {
    jest.resetModules();
    restoreEnv();
    process.env.RAILWAY_GIT_COMMIT_SHA = 'abcdef1234567890';
    process.env.RAILWAY_GIT_BRANCH = 'main';
    process.env.RAILWAY_DEPLOYMENT_ID = 'dep_test';
    process.env.RAILWAY_SERVICE_NAME = 'pivota-agent-gateway-test';
  });

  afterEach(() => {
    jest.resetModules();
    restoreEnv();
  });

  test('fills missing service version fields from runtime metadata', () => {
    const app = require('../src/server');

    const metadata = app._debug.completeServiceVersionMetadata({});

    expect(metadata).toEqual(
      expect.objectContaining({
        service: 'pivota-agent-gateway-test',
        commit: 'abcdef123456',
        build_id: 'abcdef123456',
        branch: 'main',
        deployment_id: 'dep_test',
      }),
    );
    expect(typeof metadata.started_at).toBe('string');
    expect(metadata.started_at.length).toBeGreaterThan(0);
  });

  test('treats blank existing fields as missing while preserving non-empty upstream fields', () => {
    const app = require('../src/server');

    const metadata = app._debug.completeServiceVersionMetadata({
      service: '',
      commit: '',
      buildId: 'external-build',
      deploymentId: '',
      extra: 'kept',
    });

    expect(metadata.service).toBe('pivota-agent-gateway-test');
    expect(metadata.commit).toBe('abcdef123456');
    expect(metadata.build_id).toBe('external-build');
    expect(metadata.deployment_id).toBe('dep_test');
    expect(metadata.extra).toBe('kept');
  });

  test('keeps explicit upstream commit when it is present', () => {
    const app = require('../src/server');

    const metadata = app._debug.completeServiceVersionMetadata({
      commit: 'upstream123',
      branch: 'release',
    });

    expect(metadata.commit).toBe('upstream123');
    expect(metadata.branch).toBe('release');
    expect(metadata.build_id).toBe('abcdef123456');
  });

  test('backfills service version on pivot beauty contract responses', () => {
    const app = require('../src/server');

    const response = app._debug.applyPivotBeautyContractToInvokeSearchResponse({
      operation: 'find_products_multi',
      req: {
        body: {
          operation: 'find_products_multi',
          payload: {
            search: {
              query: 'vitamin c serum under €30',
            },
          },
          metadata: {
            source: 'search',
          },
        },
      },
      body: {
        status: 'success',
        success: true,
        products: [{ title: 'Vitamin-C Tonic Original Size' }],
        total: 1,
        page_size: 1,
        metadata: {
          query_source: 'agent_products_beauty_external_seed_mainline',
          service_version: {},
          route_health: {
            primary_path_used: 'beauty_external_seed_mainline',
          },
          search_decision: {
            final_decision: 'products_returned',
          },
        },
      },
      gatewayRequestId: 'req_test',
    });

    expect(response.metadata.service_version).toEqual(
      expect.objectContaining({
        service: 'pivota-agent-gateway-test',
        commit: 'abcdef123456',
        build_id: 'abcdef123456',
        branch: 'main',
        deployment_id: 'dep_test',
      }),
    );
    expect(response.metadata.search_decision.decision_locked).toBe(true);
  });
});
