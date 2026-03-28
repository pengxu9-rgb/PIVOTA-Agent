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
          rail_mode: 'authoritative_commerce',
          require_primary_path: true,
          allow_strict_empty: false,
          allowed_query_sources: ['cache_cross_merchant_search'],
          endpoint: '/agent/shop/v1/invoke',
          request: {
            operation: 'find_products_multi',
            payload: { search: { query: 'serum', limit: 5, in_stock_only: true } },
            metadata: { source: 'search' },
          },
          correctness: {
            mode: 'auto',
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
          rail_mode: 'authoritative_commerce',
          endpoint: '/agent/shop/v1/invoke',
          request: {
            operation: 'find_products_multi',
            payload: { search: { query: 'hydrating serum' } },
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
          rail_mode: 'authoritative_commerce',
          require_primary_path: true,
          allow_strict_empty: false,
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
      if (req.url === '/agent/shop/v1/invoke') {
        if (req.headers.authorization !== 'Bearer ak_live_stage_key') {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Gateway-Governance-Mode', 'shadow');
        res.setHeader('X-Gateway-Governance-Observed-Action', 'block');
        res.setHeader('X-Gateway-Governance-Would-Enforce', 'true');
        res.setHeader('X-Gateway-Invocation-Surface', 'mcp');
        if (body?.metadata?.source === 'search') {
          res.end(
            JSON.stringify({
              products: [{ title: 'Test Serum' }],
              metadata: {
                query_source: 'cache_cross_merchant_search',
                service_version: {
                  commit: 'abc123',
                },
                route_health: {
                  fallback_triggered: false,
                  primary_path_used: 'cache_stage',
                },
                search_trace: {
                  final_decision: 'cache_returned',
                },
              },
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            products: [],
            metadata: {
              gateway_invocation: {
                surface: 'mcp',
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
          env: {
            ...process.env,
            STAGING_AUTH_TOKEN: 'ak_live_stage_key',
          },
        },
      );
      const payload = JSON.parse(String(stdout || '').trim());
      const json = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));
      const markdown = fs.readFileSync(payload.markdown_path, 'utf8');

      expect(payload.ok).toBe(true);
      expect(json.summary.total_cases).toBe(3);
      expect(json.summary.pass_count).toBe(2);
      expect(json.summary.review_required_count).toBe(1);
      expect(json.summary.blocking_failures).toBe(0);
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
          rail_mode: 'authoritative_commerce',
          require_primary_path: true,
          allow_strict_empty: false,
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
          rail_mode: 'authoritative_commerce',
          require_primary_path: true,
          allow_strict_empty: false,
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
});
