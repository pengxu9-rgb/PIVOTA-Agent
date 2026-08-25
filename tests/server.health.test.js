const request = require('supertest');

async function withEnv(patch, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(patch || {})) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('health endpoints', () => {
  jest.setTimeout(15000);

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.dontMock('../src/services/discoveryFeed');
  });

  it('serves /health as an alias of /healthz', async () => {
    const app = require('../src/server');

    const [healthz, health] = await Promise.all([
      request(app).get('/healthz').expect(200),
      request(app).get('/health').expect(200),
    ]);

    expect(healthz.body.ok).toBe(true);
    expect(health.body.ok).toBe(true);
    expect(typeof health.body.api_mode).toBe('string');
    expect(health.body.version?.service).toBe(healthz.body.version?.service);
    expect(health.body.version?.commit).toBe(healthz.body.version?.commit);
  });

  it('returns 404 for deprecated lite health endpoints', async () => {
    const app = require('../src/server');

    await Promise.all([
      request(app).get('/healthz/lite').expect(404),
      request(app).get('/health/lite').expect(404),
    ]);
  });

  it('/healthz/gemini returns strict readiness false when no Gemini keys exist', async () => {
    await withEnv(
      {
        GEMINI_API_KEY: undefined,
        GEMINI_API_KEY_1: undefined,
        GEMINI_API_KEY_2: undefined,
        GEMINI_API_KEY_3: undefined,
        AURORA_SKIN_GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
        // 'missing_keys' is the AI-Studio-path answer. Naming the Vertex vars keeps this case
        // testing the mode it says it tests instead of inheriting whatever the runner has set.
        VERTEX_AI_ENABLED: undefined,
        GOOGLE_CLOUD_PROJECT: undefined,
        K_SERVICE: undefined,
      },
      async () => {
        jest.resetModules();
        const app = require('../src/server');
        const resp = await request(app).get('/healthz/gemini').expect(200);
        expect(resp.body.ok).toBe(false);
        expect(resp.body.ready).toBe(false);
        expect(Array.isArray(resp.body.reasons)).toBe(true);
        expect(resp.body.reasons.includes('missing_keys')).toBe(true);
      },
    );
  });

  it('/healthz/gemini returns strict readiness true when key exists and circuit is closed', async () => {
    await withEnv(
      {
        GEMINI_API_KEY: 'test_gemini_health_key',
        GOOGLE_API_KEY: undefined,
        VERTEX_AI_ENABLED: undefined,
        GOOGLE_CLOUD_PROJECT: undefined,
        K_SERVICE: undefined,
      },
      async () => {
        jest.resetModules();
        const app = require('../src/server');
        const resp = await request(app).get('/healthz/gemini').expect(200);
        expect(resp.body.ok).toBe(true);
        expect(resp.body.ready).toBe(true);
        expect(Array.isArray(resp.body.reasons)).toBe(true);
        expect(resp.body.reasons.length).toBe(0);
        expect(resp.body.circuit_open).toBe(false);
        expect(resp.body.auth_mode).toBe('ai_studio_api_key');
      },
    );
  });

  // The three below drive the real handler. An earlier attempt at this asserted a re-implemented
  // copy of the endpoint's predicate in a separate file, which stayed green when the shipped code
  // was reverted. These fail if src/server.js's /healthz/gemini branch is changed back.

  it('/healthz/gemini does not report missing_keys under Vertex, where the key pool is meant to be empty', async () => {
    await withEnv(
      {
        GEMINI_API_KEY: undefined,
        GEMINI_API_KEY_1: undefined,
        GEMINI_API_KEY_2: undefined,
        GEMINI_API_KEY_3: undefined,
        AURORA_SKIN_GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
        VERTEX_AI_ENABLED: 'true',
        GOOGLE_CLOUD_PROJECT: 'pivota-prod',
        GOOGLE_APPLICATION_CREDENTIALS_JSON: undefined,
        K_SERVICE: 'gateway',
      },
      async () => {
        jest.resetModules();
        const app = require('../src/server');
        const resp = await request(app).get('/healthz/gemini').expect(200);
        // The original bug: an empty pool is correct here, so this reason is simply wrong.
        expect(resp.body.reasons).not.toContain('missing_keys');
        expect(resp.body.key_count).toBe(0);
      },
    );
  });

  it('/healthz/gemini stays red on Cloud Run when no credential can be minted', async () => {
    // K_SERVICE alone satisfies credentialSourceConfigured(), so a readiness check derived from
    // configuration reports GREEN on a container with no usable credential at all. Trading the
    // false red above for that false green would be a worse bug, on the platform prod runs on.
    await withEnv(
      {
        GEMINI_API_KEY: undefined,
        GEMINI_API_KEY_1: undefined,
        GEMINI_API_KEY_2: undefined,
        GEMINI_API_KEY_3: undefined,
        AURORA_SKIN_GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
        VERTEX_AI_ENABLED: 'true',
        GOOGLE_CLOUD_PROJECT: 'pivota-prod',
        GOOGLE_APPLICATION_CREDENTIALS_JSON: undefined,
        K_SERVICE: 'gateway',
      },
      async () => {
        jest.resetModules();
        const app = require('../src/server');
        const resp = await request(app).get('/healthz/gemini').expect(200);
        expect(resp.body.ok).toBe(false);
        expect(resp.body.ready).toBe(false);
        expect(resp.body.credential_state).not.toBe('ok');
        expect(resp.body.reasons).toContain('vertex_credentials_unverified');
      },
    );
  });

  it('/healthz/gemini names Vertex as the transport even when its credential is broken', async () => {
    // Reporting 'ai_studio_api_key' for a misconfigured Vertex deployment sends the reader after
    // GEMINI_API_KEY - a variable that is deliberately unused there. auth_mode has to follow the
    // wire path, which vertexEnabled() alone decides.
    await withEnv(
      {
        GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
        VERTEX_AI_ENABLED: 'true',
        GOOGLE_CLOUD_PROJECT: undefined,
        K_SERVICE: undefined,
      },
      async () => {
        jest.resetModules();
        const app = require('../src/server');
        const resp = await request(app).get('/healthz/gemini').expect(200);
        expect(resp.body.auth_mode).toBe('vertex_adc');
        expect(resp.body.ok).toBe(false);
        expect(resp.body.reasons).toContain('vertex_credentials_unavailable');
        expect(resp.body.credential_detail).toMatch(/GOOGLE_CLOUD_PROJECT/);
        expect(resp.body.credential_detail).not.toMatch(/GEMINI_API_KEY/);
      },
    );
  });

  it('/healthz exposes aurora chat rollout and analysis contract fields', async () => {
    await withEnv(
      {
        AURORA_CHAT_SKILL_ROUTER_V2: 'true',
        AURORA_ANALYSIS_STORY_V2_ENABLED: 'true',
        AURORA_ANALYSIS_CARD_CONTRACT_MODE: 'story_only',
      },
      async () => {
        jest.resetModules();
        const app = require('../src/server');
        const resp = await request(app).get('/healthz').expect(200);

        expect(resp.body.aurora_chat_contract).toEqual(
          expect.objectContaining({
            response_format: expect.any(String),
            response_contract: expect.any(String),
            analysis_story_v2_enabled: true,
            analysis_card_contract_mode: 'story_only',
            skill_router_v2: true,
            v1_chat_v2_delegation_mode: 'compatible_only',
          }),
        );
      },
    );
  });

  it('/healthz exposes discovery readiness and marks products unavailable when discovery config is missing', async () => {
    await withEnv(
      {
        DISCOVERY_PRODUCTS_SEARCH_BASE_URL: undefined,
        DISCOVERY_PRODUCTS_SEARCH_API_KEY: undefined,
        PIVOTA_BACKEND_BASE_URL: undefined,
        PIVOTA_API_BASE: undefined,
        DATABASE_URL: undefined,
      },
      async () => {
        jest.resetModules();
        const app = require('../src/server');
        const resp = await request(app).get('/healthz').expect(200);

        expect(resp.body.discovery).toEqual(
          expect.objectContaining({
            products_search_ready: false,
            db_backed_providers_ready: false,
            discovery_ready: false,
          }),
        );
        expect(resp.body.products_available).toBe(false);
      },
    );
  });

  it('/healthz returns a bounded response when discovery health probe stalls', async () => {
    await withEnv(
      {
        HEALTHZ_DISCOVERY_TIMEOUT_MS: '100',
        DATABASE_URL: undefined,
        PIVOTA_API_BASE: undefined,
        PIVOTA_BACKEND_BASE_URL: undefined,
      },
      async () => {
        jest.doMock('../src/services/discoveryFeed', () => {
          const actual = jest.requireActual('../src/services/discoveryFeed');
          return {
            ...actual,
            getDiscoveryHealthSnapshot: jest.fn(() => new Promise(() => {})),
          };
        });
        jest.resetModules();
        const app = require('../src/server');
        const startedAt = Date.now();
        const resp = await request(app).get('/healthz').expect(200);

        expect(Date.now() - startedAt).toBeLessThan(1000);
        expect(resp.body.ok).toBe(true);
        expect(resp.body.discovery).toEqual(
          expect.objectContaining({
            discovery_ready: false,
            warning: 'healthz_discovery_probe_timeout',
            timeout_ms: 100,
            timed_out: true,
          }),
        );
        expect(resp.body.catalog_sync).toEqual(
          expect.objectContaining({
            healthz_discovery_timeout_ms: 100,
          }),
        );
      },
    );
  });

  it('/healthz marks single_provider_mode when products_search is configured without db-backed providers', async () => {
    await withEnv(
      {
        DISCOVERY_PRODUCTS_SEARCH_BASE_URL: 'https://catalog.test',
        DISCOVERY_PRODUCTS_SEARCH_API_KEY: 'health-test-key',
        DATABASE_URL: undefined,
      },
      async () => {
        jest.resetModules();
        const app = require('../src/server');
        const resp = await request(app).get('/healthz').expect(200);

        expect(resp.body.discovery).toEqual(
          expect.objectContaining({
            products_search_ready: true,
            db_backed_providers_ready: false,
            single_provider_mode: true,
            discovery_ready: false,
          }),
        );
        expect(resp.body.products_available).toBe(false);
      },
    );
  });
});
