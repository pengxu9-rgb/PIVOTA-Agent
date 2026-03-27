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
        allow_zero_results: false,
        must_have_one_of_metadata: ['service_version.commit', 'service_version.build_id'],
        must_have_metadata: ['query_source'],
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
        allow_zero_results: true,
        must_have_one_of_metadata: ['service_version.commit', 'service_version.build_id'],
        must_have_metadata: ['search_trace.final_decision'],
        must_equal_metadata: {
          'search_trace.final_decision': 'clarify',
        },
        must_have_clarification: true,
        must_have_reason_codes: ['AMBIGUITY_CLARIFY'],
      },
    ];
    fs.writeFileSync(queryFile, JSON.stringify(cases, null, 2));

    const server = http.createServer(async (req, res) => {
      const body = await readJsonBody(req);
      if (req.url !== '/api/gateway') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }

      const query = body?.payload?.search?.query;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      if (query === 'serum') {
        res.end(
          JSON.stringify({
            products: [{ title: 'Test Serum' }],
            metadata: {
              service_version: { commit: 'abc123' },
              query_source: 'cache_cross_merchant_search',
              search_trace: { final_decision: 'cache_returned' },
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
            search_trace: { final_decision: 'clarify' },
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
          AUTH_TOKEN: '',
          AGENT_API_KEY: '',
          COMMERCE_CORE_PROD_AUTH_TOKEN: '',
          COMMERCE_CORE_PROD_AGENT_API_KEY: '',
          ENDPOINT: '',
          COMMERCE_CORE_PROD_SMOKE_ENDPOINT: '',
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
      expect(report.summary.total_requests).toBe(2);
      expect(report.summary.gate_failure_rate).toBe(0);
      expect(report.per_case.search_case.fail).toBe(0);
      expect(report.per_case.clarify_case.fail).toBe(0);
      expect(markdown).toContain('# Search Stability Matrix');
      expect(markdown).toContain('clarify_case');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('auto-selects authenticated invoke when canary auth is configured', async () => {
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
        allow_zero_results: false,
        must_have_one_of_metadata: ['service_version.commit', 'service_version.build_id'],
        must_have_metadata: ['query_source'],
        must_equal_metadata: {
          query_source: 'cache_cross_merchant_search_supplemented',
        },
        must_return_one_of_titles: ['Auth Serum'],
      },
      {
        id: 'exact_lookup_case',
        family: 'exact_product_lookup',
        query: 'IPSA Time Reset Aqua',
        source: 'shopping_agent',
        allow_zero_results: false,
        must_have_one_of_metadata: ['service_version.commit', 'service_version.build_id'],
        must_have_metadata: [
          'query_source',
          'search_trace.query_class',
          'search_trace.final_decision',
        ],
        must_equal_metadata: {
          'search_trace.query_class': 'lookup',
        },
        must_one_of_metadata: {
          query_source: [
            'cache_cross_merchant_search',
            'agent_products_resolver_fallback',
          ],
          'search_trace.final_decision': ['cache_returned', 'resolver_returned'],
        },
        must_return_one_of_titles: ['IPSA Time Reset Aqua'],
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
      const query = body?.payload?.search?.query;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      if (query === 'IPSA Time Reset Aqua') {
        res.end(
          JSON.stringify({
            products: [{ title: 'IPSA Time Reset Aqua' }],
            metadata: {
              service_version: { commit: 'def456' },
              query_source: 'cache_cross_merchant_search',
              search_trace: {
                query_class: 'lookup',
                final_decision: 'cache_returned',
              },
            },
          }),
        );
        return;
      }

      res.end(
        JSON.stringify({
          products: [{ title: 'Auth Serum' }],
          metadata: {
            service_version: { commit: 'def456' },
            query_source: 'cache_cross_merchant_search_supplemented',
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
      expect(report.summary.total_requests).toBe(2);
      expect(report.summary.auth_mode).toBe('bearer');
      expect(report.summary.endpoint).toBe('/agent/shop/v1/invoke');
      expect(report.summary.gate_failure_rate).toBe(0);
      expect(report.per_case.invoke_case.fail).toBe(0);
      expect(report.per_case.exact_lookup_case.fail).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('recovers a flaky production canary case on retry and records the recovery', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(
      repoRoot,
      'scripts',
      'probe_celestial_commerce_core_prod_canary.sh',
    );
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-prod-canary-retry-'));
    const queryFile = path.join(outDir, 'prod-canary-retry.json');
    const cases = [
      {
        id: 'retry_case',
        family: 'merchant_query',
        query: 'IPSA products',
        source: 'aurora-bff',
        allow_zero_results: false,
        must_have_one_of_metadata: ['service_version.commit', 'service_version.build_id'],
        must_have_metadata: ['query_source', 'search_trace.final_decision'],
        must_equal_metadata: {
          'search_trace.final_decision': 'cache_returned',
        },
        must_return_one_of_titles: ['IPSA Time Reset Aqua'],
      },
    ];
    fs.writeFileSync(queryFile, JSON.stringify(cases, null, 2));

    let requestCount = 0;
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

      expect(body?.metadata?.source).toBe('aurora-bff');
      requestCount += 1;
      res.statusCode = requestCount === 1 ? 500 : 200;
      res.setHeader('Content-Type', 'application/json');
      if (requestCount === 1) {
        res.end(JSON.stringify({ error: 'INTERNAL_ERROR', message: 'transient failure' }));
        return;
      }

      res.end(
        JSON.stringify({
          products: [{ title: 'IPSA Time Reset Aqua' }],
          metadata: {
            service_version: { build_id: 'retry-build' },
            query_source: 'cache_cross_merchant_search',
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
      expect(report.summary.gate_failure_rate).toBe(0);
      expect(report.summary.retry_recovered_count).toBe(1);
      expect(report.per_case.retry_case.fail).toBe(0);
      expect(report.rows[0].retry_recovered).toBe(true);
      expect(report.rows[0].attempt_count).toBe(2);
      expect(requestCount).toBe(2);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
