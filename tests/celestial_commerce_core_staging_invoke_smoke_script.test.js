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

describe('Celestial commerce-core staging invoke smoke wrapper', () => {
  test('runs the narrow staging invoke smoke through the staging matrix runner', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(
      repoRoot,
      'scripts',
      'smoke_celestial_commerce_core_staging_invoke.sh',
    );
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-staging-invoke-smoke-'));

    const server = http.createServer(async (req, res) => {
      const body = await readJsonBody(req);
      if (req.url !== '/agent/shop/v1/invoke') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }

      if (req.headers.authorization !== 'Bearer ak_live_test_staging_key') {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
        return;
      }

      expect(body?.metadata?.source).toBe('shopping_agent');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          products: [],
          metadata: {
            query_source: 'agent_products_search',
            service_version: {
              commit: 'staging123',
            },
            search_trace: {
              final_decision: 'cache_returned',
            },
            route_health: {
              fallback_triggered: false,
              primary_path_used: 'primary_search',
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
          OUT_DIR: outDir,
          STAGING_AUTH_TOKEN: 'ak_live_test_staging_key',
          TIMEOUT_MS: '5000',
        },
      });
      const payload = JSON.parse(String(stdout || '').trim());
      const report = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));

      expect(payload.ok).toBe(true);
      expect(report.summary.total_cases).toBe(1);
      expect(report.summary.pass_count).toBe(1);
      expect(report.summary.blocking_failures).toBe(0);
      expect(report.summary.authoritative_mode).toBe('authoritative_commerce');
      expect(report.summary.primary_path_degraded_count).toBe(0);
      expect(report.results[0].id).toBe('staging_invoke_auth_smoke');
      expect(report.results[0].overall_status).toBe('pass');
      expect(report.results[0].response_excerpt.primary_path_degraded).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('surfaces staging auth introspection outages as review required', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(
      repoRoot,
      'scripts',
      'smoke_celestial_commerce_core_staging_invoke.sh',
    );
    const outDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'commerce-core-staging-invoke-introspect-'),
    );

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
      const { stdout } = await execFileAsync('bash', [scriptPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          BASE_URL: baseUrl,
          OUT_DIR: outDir,
          STAGING_AUTH_TOKEN:
            'ak_live_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          TIMEOUT_MS: '5000',
        },
      });
      const payload = JSON.parse(String(stdout || '').trim());
      const report = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));

      expect(payload.ok).toBe(true);
      expect(report.summary.total_cases).toBe(1);
      expect(report.summary.review_required_count).toBe(1);
      expect(report.summary.infra_blocked_count).toBe(1);
      expect(report.results[0].overall_status).toBe('review_required');
      expect(report.results[0].outcome_kind).toBe('staging_auth_introspect_unavailable');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
