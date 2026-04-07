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

describe('Celestial commerce-core production smoke wrapper', () => {
  test('auto-selects authenticated invoke when prod auth is configured', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'smoke_celestial_commerce_core_prod.sh');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-prod-smoke-auth-'));
    const queryFile = path.join(outDir, 'prod-smoke-auth.json');
    fs.writeFileSync(
      queryFile,
      JSON.stringify(
        [
          {
            id: 'invoke_case',
            family: 'broad_commerce_search',
            query: 'serum',
            source: 'shopping_agent',
            allow_zero_results: false,
            must_have_metadata: ['service_version.commit', 'query_source'],
            must_equal_metadata: {
              query_source: 'agent_products_search',
            },
            must_return_one_of_titles: ['Auth Smoke Serum'],
          },
        ],
        null,
        2,
      ),
    );

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
          products: [{ title: 'Auth Smoke Serum' }],
          metadata: {
            service_version: { commit: 'smoke123' },
            query_source: 'agent_products_search',
            route_health: { fallback_triggered: false },
            search_decision: {
              decision_authority: 'agent_products_search',
              decision_locked: true,
            },
            search_trace: { final_decision: 'products_returned' },
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
          COMMERCE_CORE_PROD_AUTH_TOKEN: 'ak_live_test_prod_key',
          OUT_DIR: outDir,
          QUERY_FILE: queryFile,
          VERIFY_DEPLOY: '0',
          ROUNDS: '1',
          TIMEOUT_MS: '5000',
        },
      });
      const payload = JSON.parse(String(stdout || '').trim());
      const report = JSON.parse(fs.readFileSync(payload.json, 'utf8'));

      expect(payload.ok).toBe(true);
      expect(report.summary.total_requests).toBe(1);
      expect(report.summary.endpoint).toBe('/agent/shop/v1/invoke');
      expect(report.summary.auth_mode).toBe('bearer');
      expect(report.summary.gate_failure_rate).toBe(0);
      expect(report.per_case.invoke_case.fail).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('fails the gate when returned products violate the query budget', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'smoke_celestial_commerce_core_prod.sh');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-prod-budget-gate-'));
    const queryFile = path.join(outDir, 'prod-smoke-budget.json');
    fs.writeFileSync(
      queryFile,
      JSON.stringify(
        [
          {
            id: 'budget_case',
            family: 'strict_ingredient_budget',
            query: 'vitamin c serum under $30',
            source: 'search',
            allow_zero_results: false,
            must_have_metadata: ['service_version.commit', 'query_source', 'budget_fx_applied'],
            must_equal_metadata: {
              budget_fx_applied: true,
              budget_fx_candidate_currency: 'USD',
            },
            must_respect_budget: true,
          },
        ],
        null,
        2,
      ),
    );

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

      expect(body?.payload?.search?.query).toBe('vitamin c serum under $30');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          products: [
            {
              title: 'Budget Breaker Serum',
              price: 70,
              currency: 'USD',
            },
          ],
          metadata: {
            service_version: { commit: 'smoke123' },
            query_source: 'agent_products_ingredient_recall_direct',
            budget_fx_applied: true,
            budget_fx_rate: 1,
            budget_fx_candidate_currency: 'USD',
            contract_bridge: { resolved_contract: 'shop_invoke_strict' },
            search_trace: { final_decision: 'products_returned' },
          },
        }),
      );
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await expect(
        execFileAsync('bash', [scriptPath], {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            BASE_URL: baseUrl,
            COMMERCE_CORE_PROD_AUTH_TOKEN: 'ak_live_test_prod_key',
            OUT_DIR: outDir,
            QUERY_FILE: queryFile,
            VERIFY_DEPLOY: '0',
            ROUNDS: '1',
            TIMEOUT_MS: '5000',
          },
        }),
      ).rejects.toMatchObject({
        stdout: expect.stringContaining('"ok": false'),
      });

      const reportPath = fs
        .readdirSync(outDir)
        .find((entry) => entry.startsWith('search_stability_matrix_') && entry.endsWith('.json'));
      const report = JSON.parse(fs.readFileSync(path.join(outDir, reportPath), 'utf8'));
      expect(report.summary.gate_failure_rate).toBe(1);
      expect(report.per_case.budget_case.latest_reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('over_budget_product:Budget Breaker Serum@70USD:max=30USD'),
        ]),
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('accepts token-based title gates for live vitamin-c serum variants', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'smoke_celestial_commerce_core_prod.sh');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-prod-token-gate-'));
    const queryFile = path.join(outDir, 'prod-smoke-token-gate.json');
    fs.writeFileSync(
      queryFile,
      JSON.stringify(
        [
          {
            id: 'token_title_case',
            family: 'strict_ingredient_budget',
            query: 'vitamin c serum under $30',
            source: 'search',
            allow_zero_results: false,
            must_have_metadata: [
              'service_version.commit',
              'query_source',
              'budget_fx_applied',
              'strict_constraint_query',
              'strict_constraint_reason',
              'matched_ingredient_ids.0',
              'route_health.fallback_triggered',
              'search_decision.decision_locked',
              'contract_bridge.resolved_contract',
            ],
            allowed_contract_paths: ['shop_invoke_strict', 'agent_v1_search_beauty_mainline'],
            must_equal_metadata: {
              strict_constraint_query: true,
              strict_constraint_reason: 'multi_constraint',
              budget_fx_applied: true,
              budget_fx_candidate_currency: 'USD',
              budget_fx_unresolved: false,
              'route_health.fallback_triggered': false,
              'search_decision.decision_locked': true,
            },
            must_respect_budget: true,
            must_return_one_of_title_token_sets: [['vitamin c', 'serum']],
          },
        ],
        null,
        2,
      ),
    );

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

      expect(body?.payload?.search?.query).toBe('vitamin c serum under $30');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          products: [
            {
              title: 'Vitamin C Complex Serum - Travel Size',
              price: 12,
              currency: 'USD',
            },
          ],
          metadata: {
            service_version: { commit: 'smoke123' },
            query_source: 'agent_products_ingredient_recall_direct',
            strict_constraint_query: true,
            strict_constraint_reason: 'multi_constraint',
            matched_ingredient_ids: ['ascorbic_acid'],
            budget_fx_applied: true,
            budget_fx_rate: 1,
            budget_fx_source: 'static_usd',
            budget_fx_candidate_currency: 'USD',
            budget_fx_unresolved: false,
            contract_bridge: { resolved_contract: 'agent_v1_search_beauty_mainline' },
            route_health: { fallback_triggered: false },
            search_decision: {
              decision_authority: 'agent_products_ingredient_recall_direct',
              decision_locked: true,
            },
            search_trace: { final_decision: 'products_returned' },
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
          COMMERCE_CORE_PROD_AUTH_TOKEN: 'ak_live_test_prod_key',
          OUT_DIR: outDir,
          QUERY_FILE: queryFile,
          VERIFY_DEPLOY: '0',
          ROUNDS: '1',
          TIMEOUT_MS: '5000',
        },
      });
      const payload = JSON.parse(String(stdout || '').trim());
      const report = JSON.parse(fs.readFileSync(payload.json, 'utf8'));

      expect(payload.ok).toBe(true);
      expect(report.summary.gate_failure_rate).toBe(0);
      expect(report.per_case.token_title_case.fail).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
