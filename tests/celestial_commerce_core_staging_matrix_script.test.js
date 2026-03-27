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

describe('Celestial commerce-core staging matrix script', () => {
  test('builds a mixed live/manual matrix report', async () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-staging-matrix-'));
    const casesPath = path.join(outDir, 'matrix.json');
    const scriptPath = path.join(repoRoot, 'scripts', 'run_celestial_commerce_core_staging_matrix.js');

    const matrix = {
      semantic_cases: [
        {
          id: 'search_case',
          title: 'search case',
          family: 'broad_discovery',
          endpoint: '/api/gateway',
          request: {
            operation: 'find_products_multi',
            payload: { search: { query: 'serum', limit: 5, in_stock_only: true } },
            metadata: { source: 'search' },
          },
          correctness: {
            mode: 'auto',
            require_primary_path: true,
            expect_http_status: 200,
            allow_zero_results: false,
            must_return_one_of_titles: ['Test Serum'],
          },
          ownership: {
            must_equal_paths: {
              'metadata.query_source': 'cache_cross_merchant_search',
            },
          },
          observability: {
            must_have_paths: ['metadata.service_version.commit'],
          },
        },
        {
          id: 'manual_case',
          title: 'manual case',
          family: 'aurora_guidance_only_cache_hit',
          execution_mode: 'manual',
          endpoint: '/agent/shop/v1/invoke',
          request: {
            operation: 'find_products_multi',
            payload: { search: { query: 'panthenol repair serum' } },
            metadata: { source: 'aurora-bff', ui_surface: 'ingredient_plan_guidance_only' },
          },
          manual_review: {
            expected_outcome: 'manual review required',
          },
        },
      ],
      governance_cases: [
        {
          id: 'mcp_case',
          title: 'mcp governance case',
          family: 'governance_merchant_sweep',
          endpoint: '/agent/shop/v1/invoke',
          headers: {
            'X-Pivota-Invocation-Surface': 'mcp',
          },
          request: {
            operation: 'find_products',
            payload: { search: { query: 'serum' } },
            metadata: {
              source: 'shopping_agent',
              merchant_filters: ['merchant_a', 'merchant_b'],
              repeated_merchant_queries: 2,
            },
          },
          correctness: {
            mode: 'auto',
            expect_http_status: 200,
          },
          ownership: {
            must_have_reason_codes: ['merchant_sweep_blocked'],
            must_equal_headers: {
              'x-gateway-governance-observed-action': 'block',
            },
          },
          observability: {
            must_equal_headers: {
              'x-gateway-governance-mode': 'shadow',
              'x-gateway-governance-would-enforce': 'true',
            },
            must_equal_paths: {
              'metadata.gateway_invocation.surface': 'mcp',
            },
          },
        },
      ],
    };
    fs.writeFileSync(casesPath, JSON.stringify(matrix, null, 2));

    const server = http.createServer(async (req, res) => {
      const body = await readJsonBody(req);
      if (req.url === '/api/gateway') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            products: [
              {
                title: 'Test Serum',
              },
            ],
            metadata: {
              query_source: 'cache_cross_merchant_search',
              route_health: {
                primary_path_used: 'cache_stage',
                fallback_triggered: false,
              },
              service_version: {
                commit: 'abc123',
              },
              search_trace: {
                final_decision: 'cache_returned',
              },
            },
          }),
        );
        return;
      }

      if (req.url === '/agent/shop/v1/invoke') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Gateway-Governance-Mode', 'shadow');
        res.setHeader('X-Gateway-Governance-Observed-Action', 'block');
        res.setHeader('X-Gateway-Governance-Would-Enforce', 'true');
        res.setHeader('X-Gateway-Invocation-Surface', 'mcp');
        res.setHeader('X-Invoke-Auth-Degraded', 'true');
        res.setHeader('X-Invoke-Auth-Degraded-Reason', 'AUTH_INTROSPECT_UNAVAILABLE');
        res.setHeader('X-Invoke-Introspect-Auth-Source', 'emergency_fallback');
        res.end(
          JSON.stringify({
            products: [],
            metadata: {
              gateway_invocation: {
                surface: 'mcp',
                auth_degraded: true,
                auth_degraded_reason: 'AUTH_INTROSPECT_UNAVAILABLE',
                introspect_auth_source: 'emergency_fallback',
              },
              gateway_governance: {
                mode: 'shadow',
                observed_action: 'block',
                query_governance: {
                  reason_codes: ['merchant_sweep_blocked'],
                },
              },
              echo_source: body?.metadata?.source || null,
            },
          }),
        );
        return;
      }

      res.statusCode = 404;
      res.end('not found');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [scriptPath, '--base-url', baseUrl, '--cases', casesPath, '--out-dir', outDir],
        {
          cwd: repoRoot,
          encoding: 'utf8',
        },
      );
      const payload = JSON.parse(String(stdout || '').trim());
      const json = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));
      const markdown = fs.readFileSync(payload.markdown_path, 'utf8');

      expect(payload.ok).toBe(true);
      expect(json.summary.total_cases).toBe(3);
      expect(json.summary.pass_count).toBe(2);
      expect(json.summary.review_required_count).toBe(1);
      expect(json.summary.auth_degraded_count).toBe(1);
      expect(json.summary.blocking_failures).toBe(0);
      expect(markdown).toContain('Auth degraded: 1');
      expect(markdown).toContain('# Celestial Commerce Core Staging Acceptance Matrix');
      expect(markdown).toContain('manual_case');
      expect(markdown).toContain('mcp_case');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('marks auth-gated live cases as review required when staging auth is missing', async () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-staging-auth-'));
    const casesPath = path.join(outDir, 'matrix.json');
    const scriptPath = path.join(repoRoot, 'scripts', 'run_celestial_commerce_core_staging_matrix.js');

    const matrix = {
      semantic_cases: [
        {
          id: 'auth_required_case',
          title: 'auth required live case',
          family: 'broad_discovery',
          endpoint: '/agent/shop/v1/invoke',
          requires_auth: true,
          auth_profile: 'public',
          request: {
            operation: 'find_products_multi',
            payload: { search: { query: 'serum', limit: 5, in_stock_only: true } },
            metadata: { source: 'search' },
          },
          correctness: {
            mode: 'auto',
            expect_http_status: 200,
          },
        },
      ],
      governance_cases: [],
    };
    fs.writeFileSync(casesPath, JSON.stringify(matrix, null, 2));

    const server = http.createServer((_req, res) => {
      res.statusCode = 500;
      res.end('should not be called');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [scriptPath, '--base-url', baseUrl, '--cases', casesPath, '--out-dir', outDir],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            STAGING_AUTH_TOKEN: '',
            STAGING_AGENT_API_KEY: '',
            STAGING_PUBLIC_AUTH_TOKEN: '',
            STAGING_PUBLIC_AGENT_API_KEY: '',
          },
        },
      );
      const payload = JSON.parse(String(stdout || '').trim());
      const json = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));

      expect(payload.ok).toBe(true);
      expect(json.summary.total_cases).toBe(1);
      expect(json.summary.pass_count).toBe(0);
      expect(json.summary.fail_count).toBe(0);
      expect(json.summary.review_required_count).toBe(1);
      expect(json.summary.blocking_failures).toBe(0);
      expect(json.results[0].overall_status).toBe('review_required');
      expect(json.results[0].outcome_kind).toBe('staging_auth_missing');
      expect(json.results[0].correctness.reasons).toContain(
        'missing_staging_auth_profile:public',
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('marks staging auth introspection outages as review required instead of blocker failures', async () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-staging-introspect-'));
    const casesPath = path.join(outDir, 'matrix.json');
    const scriptPath = path.join(repoRoot, 'scripts', 'run_celestial_commerce_core_staging_matrix.js');

    const matrix = {
      semantic_cases: [
        {
          id: 'auth_introspect_unavailable_case',
          title: 'staging auth infra unavailable',
          family: 'broad_discovery',
          endpoint: '/agent/shop/v1/invoke',
          requires_auth: true,
          auth_profile: 'default',
          request: {
            operation: 'find_products_multi',
            payload: { search: { query: 'serum', limit: 5, in_stock_only: true } },
            metadata: { source: 'search' },
          },
          correctness: {
            mode: 'auto',
            expect_http_status: 200,
          },
        },
      ],
      governance_cases: [],
    };
    fs.writeFileSync(casesPath, JSON.stringify(matrix, null, 2));

    const server = http.createServer((_req, res) => {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: 'AUTH_INTROSPECT_UNAVAILABLE',
          message: 'Authentication service unavailable',
        }),
      );
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [scriptPath, '--base-url', baseUrl, '--cases', casesPath, '--out-dir', outDir],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            STAGING_AUTH_TOKEN: 'ak_live_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          },
        },
      );
      const payload = JSON.parse(String(stdout || '').trim());
      const json = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));

      expect(payload.ok).toBe(true);
      expect(json.summary.total_cases).toBe(1);
      expect(json.summary.fail_count).toBe(0);
      expect(json.summary.review_required_count).toBe(1);
      expect(json.summary.infra_blocked_count).toBe(1);
      expect(json.summary.blocking_failures).toBe(0);
      expect(json.results[0].overall_status).toBe('review_required');
      expect(json.results[0].outcome_kind).toBe('staging_auth_introspect_unavailable');
      expect(json.results[0].correctness.reasons).toContain(
        'staging_auth_introspect_unavailable',
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('uses per-case timeout override when provided by the acceptance matrix', async () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-staging-timeout-'));
    const casesPath = path.join(outDir, 'matrix.json');
    const scriptPath = path.join(repoRoot, 'scripts', 'run_celestial_commerce_core_staging_matrix.js');

    const matrix = {
      semantic_cases: [
        {
          id: 'slow_case',
          title: 'slow case',
          family: 'broad_discovery',
          endpoint: '/agent/shop/v1/invoke',
          timeout_ms: 400,
          request: {
            operation: 'find_products_multi',
            payload: { search: { query: 'serum', limit: 5, in_stock_only: true } },
            metadata: { source: 'search' },
          },
          correctness: {
            mode: 'auto',
            expect_http_status: 200,
            allow_zero_results: false,
            must_return_one_of_titles: ['Slow Serum'],
          },
          ownership: {
            must_equal_paths: {
              'metadata.query_source': 'cache_cross_merchant_search',
            },
          },
          observability: {
            must_have_paths: ['metadata.service_version.commit'],
          },
        },
      ],
      governance_cases: [],
    };
    fs.writeFileSync(casesPath, JSON.stringify(matrix, null, 2));

    const server = http.createServer(async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          products: [{ title: 'Slow Serum' }],
          metadata: {
            query_source: 'cache_cross_merchant_search',
            service_version: { commit: 'slow123' },
            search_trace: { final_decision: 'cache_returned' },
          },
        }),
      );
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [scriptPath, '--base-url', baseUrl, '--cases', casesPath, '--out-dir', outDir, '--timeout-ms', '50'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
        },
      );
      const payload = JSON.parse(String(stdout || '').trim());
      const json = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));

      expect(payload.ok).toBe(true);
      expect(json.summary.total_cases).toBe(1);
      expect(json.summary.pass_count).toBe(1);
      expect(json.summary.fail_count).toBe(0);
      expect(json.results[0].overall_status).toBe('pass');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('retries blocking live cases once and records retry recovery when the second attempt passes', async () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-staging-retry-'));
    const casesPath = path.join(outDir, 'matrix.json');
    const scriptPath = path.join(repoRoot, 'scripts', 'run_celestial_commerce_core_staging_matrix.js');

    const matrix = {
      semantic_cases: [
        {
          id: 'retry_case',
          title: 'retry case',
          family: 'exactish_lookup',
          blocking: true,
          endpoint: '/agent/shop/v1/invoke',
          request: {
            operation: 'find_products_multi',
            payload: { search: { query: 'niacinamide serum', limit: 5, in_stock_only: true } },
            metadata: { source: 'shopping_agent' },
          },
          correctness: {
            mode: 'auto',
            expect_http_status: 200,
            allow_zero_results: false,
            must_return_one_of_titles: ['Recovered Serum'],
          },
          ownership: {
            must_equal_paths: {
              'metadata.contract_bridge.resolved_contract': 'shop_invoke_strict',
            },
            must_have_paths: ['metadata.matched_ingredient_ids.0'],
          },
          observability: {
            must_have_paths: ['metadata.service_version.commit'],
          },
        },
      ],
      governance_cases: [],
    };
    fs.writeFileSync(casesPath, JSON.stringify(matrix, null, 2));

    let requestCount = 0;
    const server = http.createServer((_req, res) => {
      requestCount += 1;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      if (requestCount === 1) {
        res.end(
          JSON.stringify({
            products: [],
            reason_codes: ['FILTERED_TO_EMPTY'],
            metadata: {
              query_source: 'agent_products_error_fallback',
              search_trace: { final_decision: 'strict_empty' },
              service_version: { commit: 'retry123' },
            },
          }),
        );
        return;
      }

      res.end(
        JSON.stringify({
          products: [{ title: 'Recovered Serum' }],
          metadata: {
            query_source: 'cache_multi_intent',
            contract_bridge: { resolved_contract: 'shop_invoke_strict' },
            matched_ingredient_ids: ['niacinamide'],
            service_version: { commit: 'retry123' },
            search_trace: { final_decision: 'cache_returned' },
          },
        }),
      );
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [scriptPath, '--base-url', baseUrl, '--cases', casesPath, '--out-dir', outDir],
        {
          cwd: repoRoot,
          encoding: 'utf8',
        },
      );
      const payload = JSON.parse(String(stdout || '').trim());
      const json = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));

      expect(payload.ok).toBe(true);
      expect(json.summary.total_cases).toBe(1);
      expect(json.summary.pass_count).toBe(1);
      expect(json.summary.fail_count).toBe(0);
      expect(json.summary.retry_recovered_count).toBe(1);
      expect(json.results[0].overall_status).toBe('pass');
      expect(json.results[0].retry_recovered).toBe(true);
      expect(json.results[0].attempt_count).toBe(2);
      expect(json.results[0].attempt_history[0].overall_status).toBe('fail');
      expect(requestCount).toBe(2);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('fails a live case when only fallback succeeded but primary path is required', async () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-staging-primary-'));
    const casesPath = path.join(outDir, 'matrix.json');
    const scriptPath = path.join(repoRoot, 'scripts', 'run_celestial_commerce_core_staging_matrix.js');

    const matrix = {
      semantic_cases: [
        {
          id: 'fallback_only_case',
          title: 'fallback only case',
          family: 'exact_product_lookup',
          blocking: false,
          endpoint: '/agent/shop/v1/invoke',
          request: {
            operation: 'find_products_multi',
            payload: { search: { query: 'IPSA Time Reset Aqua', limit: 5, in_stock_only: true } },
            metadata: { source: 'shopping_agent' },
          },
          correctness: {
            mode: 'auto',
            require_primary_path: true,
            expect_http_status: 200,
            allow_zero_results: false,
            must_return_one_of_titles: ['IPSA Time Reset Aqua'],
          },
          ownership: {
            must_have_paths: ['metadata.query_source'],
          },
          observability: {
            must_have_paths: ['metadata.service_version.commit'],
          },
        },
      ],
      governance_cases: [],
    };
    fs.writeFileSync(casesPath, JSON.stringify(matrix, null, 2));

    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          products: [{ title: 'IPSA Time Reset Aqua' }],
          metadata: {
            query_source: 'agent_products_resolver_fallback',
            proxy_search_fallback: {
              applied: true,
              reason: 'resolver_after_primary',
            },
            route_health: {
              primary_path_used: 'resolver_fallback',
              fallback_triggered: true,
              fallback_reason: 'resolver_after_primary',
            },
            service_version: { commit: 'fallback123' },
            search_trace: {
              query_class: 'lookup',
              final_decision: 'resolver_returned',
            },
          },
        }),
      );
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [scriptPath, '--base-url', baseUrl, '--cases', casesPath, '--out-dir', outDir],
        {
          cwd: repoRoot,
          encoding: 'utf8',
        },
      );
      const payload = JSON.parse(String(stdout || '').trim());
      const json = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));

      expect(payload.ok).toBe(true);
      expect(json.summary.total_cases).toBe(1);
      expect(json.summary.fail_count).toBe(1);
      expect(json.summary.blocking_failures).toBe(0);
      expect(json.summary.primary_path_degraded_count).toBe(1);
      expect(json.results[0].overall_status).toBe('fail');
      expect(json.results[0].response_excerpt.primary_path_degraded).toBe(true);
      expect(json.results[0].correctness.reasons).toEqual(
        expect.arrayContaining([expect.stringContaining('primary_path_degraded:')]),
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
