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

describe('Celestial commerce-core aurora manual review runner', () => {
  test('accepts bounded cache-stage guidance supplement as a pass', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(
      repoRoot,
      'scripts',
      'run_celestial_commerce_core_aurora_manual_review.js',
    );
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-aurora-manual-'));
    const casesPath = path.join(outDir, 'manual-cases.json');

    fs.writeFileSync(
      casesPath,
      JSON.stringify(
        {
          semantic_cases: [
            {
              id: 'aurora_guidance_only_direct_supplement_manual',
              title: 'bounded supplement manual case',
              family: 'aurora_guidance_only_direct_supplement',
              execution_mode: 'manual',
              request: {
                operation: 'find_products_multi',
                payload: {
                  search: {
                    query: 'soothing repair serum',
                    limit: 6,
                    in_stock_only: true,
                    ui_surface: 'ingredient_plan_guidance_only',
                  },
                },
                metadata: {
                  source: 'aurora-bff',
                  ui_surface: 'ingredient_plan_guidance_only',
                  query_target_step_family: 'serum',
                  query_step_strength: 'focused',
                  decision_mode: 'guidance_only',
                  source_policy: 'guided_only',
                },
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    const server = http.createServer(async (req, res) => {
      const body = await readJsonBody(req);
      expect(body?.payload?.search?.query).toBe('soothing repair serum');
      expect(req.headers.authorization).toBe('Bearer ak_live_test_stage_key');

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Request-Id', 'aurora-manual-test');
      res.end(
        JSON.stringify({
          products: [
            { title: 'Winona Soothing Repair Serum' },
            { title: 'Soothing & Barrier Support Serum' },
          ],
          metadata: {
            query_source: 'cache_cross_merchant_search_supplemented',
            search_trace: {
              final_decision: 'cache_returned',
            },
            source_breakdown: {
              internal_count: 1,
              external_seed_count: 5,
            },
            route_debug: {
              cross_merchant_cache: {
                supplement: {
                  attempted: true,
                  applied: true,
                  reason: 'supplemented_external_seed',
                  retrieval_mode: 'guidance_recall_first',
                  query_variants: [
                    'soothing repair serum',
                    'barrier repair serum',
                    'hydrating serum',
                  ],
                },
              },
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
        [
          scriptPath,
          '--base-url',
          baseUrl,
          '--endpoint',
          '/',
          '--cases',
          casesPath,
          '--out-dir',
          outDir,
          '--auth-token',
          'ak_live_test_stage_key',
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
        },
      );
      const payload = JSON.parse(String(stdout || '').trim());
      const summary = JSON.parse(fs.readFileSync(payload.json, 'utf8'));

      expect(payload.ok).toBe(true);
      expect(summary.pass_count).toBe(1);
      expect(summary.fail_count).toBe(0);
      expect(summary.review_required_count).toBe(0);
      expect(summary.case_count).toBe(1);
      expect(summary.all_cases_resolved).toBe(true);
      expect(summary.results[0]).toEqual(
        expect.objectContaining({
          verdict: 'pass',
          query_source: 'cache_cross_merchant_search_supplemented',
          final_decision: 'cache_returned',
        }),
      );
      expect(Array.isArray(summary.results[0].checklist)).toBe(true);
      expect(summary.results[0].checklist).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: expect.stringContaining('HTTP 200'),
            status: 'pass',
          }),
        ]),
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
