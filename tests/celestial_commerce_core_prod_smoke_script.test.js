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
              query_source: 'cache_cross_merchant_search',
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
});
