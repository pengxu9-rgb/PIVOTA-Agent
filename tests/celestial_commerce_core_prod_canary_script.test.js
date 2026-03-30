const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (_error) {
        resolve({});
      }
    });
  });
}

describe('Celestial commerce-core production canary wrapper', () => {
  test('runs a narrow read-only matrix through the existing stability runner', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(
      repoRoot,
      'scripts',
      'probe_celestial_commerce_core_prod_canary.sh',
    );
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-prod-canary-'));
    const queryFile = path.join(outDir, 'prod-canary.json');
    const cases = [
      {
        id: 'search_case',
        family: 'public_search_contract',
        query: 'serum',
        source: 'search',
        rail_mode: 'authoritative_commerce',
        require_primary_path: true,
        allow_strict_empty: false,
        allowed_query_sources: ['cache_cross_merchant_search'],
        allow_zero_results: false,
        must_have_metadata: ['service_version.commit', 'query_source'],
        must_equal_metadata: {
          query_source: 'cache_cross_merchant_search',
        },
        must_return_one_of_titles: ['Test Serum'],
      },
      {
        id: 'clarify_case',
        family: 'clarify_required',
        query: '有什么适合今晚约会的',
        source: 'shopping_agent',
        rail_mode: 'authoritative_commerce',
        require_primary_path: true,
        allow_strict_empty: false,
        allowed_query_sources: ['agent_products_search'],
        allow_zero_results: true,
        must_have_metadata: ['service_version.commit', 'search_trace.final_decision'],
        must_equal_metadata: {
          'search_trace.final_decision': 'clarify',
        },
        must_have_clarification: true,
        must_have_reason_codes: ['AMBIGUITY_CLARIFY'],
      },
      {
        id: 'aurora_shadow_case',
        family: 'clarify_required',
        query: '有什么适合今晚约会的',
        source: 'aurora-bff',
        rail_mode: 'authoritative_commerce',
        require_primary_path: true,
        allow_strict_empty: false,
        allowed_query_sources: ['agent_products_search'],
        allow_zero_results: true,
        must_have_metadata: ['service_version.commit', 'search_trace.final_decision'],
        must_equal_metadata: {
          'search_trace.final_decision': 'clarify',
        },
        must_have_clarification: true,
        must_have_reason_codes: ['layer_not_allowed'],
      },
    ];
    fs.writeFileSync(queryFile, JSON.stringify(cases, null, 2));

    const server = http.createServer(async (req, res) => {
      const body = await readJsonBody(req);
      if (req.url !== '/agent/shop/v1/invoke') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }

      if (req.headers.authorization !== 'Bearer ak_live_test_prod_key') {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Missing auth' }));
        return;
      }

      const query = body?.payload?.search?.query;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      const source = body?.metadata?.source;
      if (query === 'serum') {
        res.end(
          JSON.stringify({
            products: [{ title: 'Test Serum' }],
            metadata: {
              service_version: { commit: 'abc123' },
              query_source: 'cache_cross_merchant_search',
              route_health: {
                fallback_triggered: false,
                primary_path_used: 'cache_stage',
              },
              search_trace: { final_decision: 'cache_returned' },
              search_decision: {
                decision_authority: 'cache_cross_merchant_search',
                decision_locked: true,
                decision_lock_reason: 'cache_main_path',
              },
            },
          }),
        );
        return;
      }

      if (source === 'aurora-bff') {
        res.end(
          JSON.stringify({
            products: [],
            clarification: {
              question: '你更想要底妆、眼妆还是唇妆？',
            },
            reason_codes: ['layer_not_allowed'],
            metadata: {
              service_version: { commit: 'abc123' },
              query_source: 'agent_products_search',
              route_health: {
                fallback_triggered: false,
                primary_path_used: 'agent_products_search',
                observer_nodes: ['governance_shadow_block_observed'],
              },
              search_trace: { final_decision: 'clarify' },
              search_decision: {
                decision_authority: 'agent_products_search',
                decision_locked: true,
                decision_lock_reason: 'clarify_contract',
              },
            },
          }),
        );
        return;
      }

      res.end(
        JSON.stringify({
          products: [],
          clarification: {
            question: '你更想要底妆、眼妆还是唇妆？',
          },
          reason_codes: ['AMBIGUITY_CLARIFY'],
          metadata: {
            service_version: { commit: 'abc123' },
            query_source: 'agent_products_search',
            route_health: {
              fallback_triggered: false,
              primary_path_used: 'agent_products_search',
            },
            search_trace: { final_decision: 'clarify' },
            search_decision: {
              decision_authority: 'agent_products_search',
              decision_locked: true,
              decision_lock_reason: 'clarify_contract',
            },
          },
        }),
      );
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const { stdout } = await execFileAsync('bash', [scriptPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          BASE_URL: baseUrl,
          AUTH_TOKEN: 'ak_live_test_prod_key',
          OUT_DIR: outDir,
          QUERY_FILE: queryFile,
          VERIFY_DEPLOY: '0',
          FAIL_ON_GATE_FAILURES: '0',
          ROUNDS: '1',
          TIMEOUT_MS: '5000',
        },
      });
      const payload = JSON.parse(String(stdout || '').trim());
      const report = JSON.parse(fs.readFileSync(payload.json, 'utf8'));
      const markdown = fs.readFileSync(payload.markdown, 'utf8');

      expect(payload.ok).toBe(true);
      expect(report.summary.total_requests).toBe(3);
      expect(report.summary.endpoint).toBe('/agent/shop/v1/invoke');
      expect(report.summary.rail_mode).toBe('authoritative_commerce');
      expect(report.summary.gate_failure_rate).toBe(0);
      expect(report.per_case.search_case.fail).toBe(0);
      expect(report.per_case.clarify_case.fail).toBe(0);
      expect(report.per_case.aurora_shadow_case.fail).toBe(0);
      expect(markdown).toContain('# Search Stability Matrix');
      expect(markdown).toContain('clarify_case');
      expect(markdown).toContain('aurora_shadow_case');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('supports authenticated invoke canary runs', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(
      repoRoot,
      'scripts',
      'probe_celestial_commerce_core_prod_canary.sh',
    );
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-prod-canary-auth-'));
    const queryFile = path.join(outDir, 'prod-canary-auth.json');
    const cases = [
      {
        id: 'invoke_case',
        family: 'broad_commerce_search',
        query: 'serum',
        source: 'shopping_agent',
        rail_mode: 'authoritative_commerce',
        require_primary_path: true,
        allow_strict_empty: false,
        allowed_query_sources: ['cache_cross_merchant_search'],
        allow_zero_results: false,
        must_have_metadata: ['service_version.commit', 'query_source'],
        must_equal_metadata: {
          query_source: 'cache_cross_merchant_search',
        },
        must_return_one_of_titles: ['Auth Serum'],
      },
    ];
    fs.writeFileSync(queryFile, JSON.stringify(cases, null, 2));

    const server = http.createServer(async (req, res) => {
      const body = await readJsonBody(req);
      if (req.url !== '/agent/shop/v1/invoke') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }

      if (req.headers.authorization !== 'Bearer ak_live_test_prod_key') {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Missing or invalid API key' }));
        return;
      }

      expect(body?.metadata?.source).toBe('shopping_agent');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          products: [{ title: 'Auth Serum' }],
          metadata: {
            service_version: { commit: 'def456' },
            query_source: 'cache_cross_merchant_search',
            route_health: {
              fallback_triggered: false,
              primary_path_used: 'cache_stage',
            },
            search_trace: { final_decision: 'cache_returned' },
          },
        }),
      );
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const { stdout } = await execFileAsync('bash', [scriptPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          BASE_URL: baseUrl,
          ENDPOINT: '/agent/shop/v1/invoke',
          AUTH_TOKEN: 'ak_live_test_prod_key',
          OUT_DIR: outDir,
          QUERY_FILE: queryFile,
          VERIFY_DEPLOY: '0',
          FAIL_ON_GATE_FAILURES: '0',
          ROUNDS: '1',
          TIMEOUT_MS: '5000',
        },
      });
      const payload = JSON.parse(String(stdout || '').trim());
      const report = JSON.parse(fs.readFileSync(payload.json, 'utf8'));

      expect(payload.ok).toBe(true);
      expect(report.summary.total_requests).toBe(1);
      expect(report.summary.auth_mode).toBe('bearer');
      expect(report.summary.endpoint).toBe('/agent/shop/v1/invoke');
      expect(report.summary.gate_failure_rate).toBe(0);
      expect(report.per_case.invoke_case.fail).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
