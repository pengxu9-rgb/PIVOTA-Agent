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

describe('Celestial commerce beauty cross-agent matrix runner', () => {
  test('runs continuous waves and produces a stable cross-surface summary', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(
      repoRoot,
      'scripts',
      'run_celestial_commerce_core_beauty_cross_agent_matrix.js',
    );
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beauty-cross-agent-matrix-'));
    const casesPath = path.join(outDir, 'cases.json');

    fs.writeFileSync(
      casesPath,
      JSON.stringify(
        {
          schema_version: 'celestial.commerce_core.acceptance_corpus.v1',
          cases: [
            {
              id: 'beauty_compare_case',
              family: 'beauty_cross_agent_category_compare',
              targets: {
                beauty_cross_agent: {
                  title: 'beauty compare',
                  prompt: 'I have oily skin, what sunscreen should I buy?',
                  expected_domain: 'beauty',
                  expected_beauty_mode: 'category_compare',
                  expected_delegated_layer: 'decisioning',
                  expected_next_actions_any: ['compare_same_type', 'show_alternatives'],
                  expected_compare_axes_any: ['lighter / smoother finish', 'matte / shine control'],
                  expected_lead_pick_titles_any: ['Brand Fluid Sunscreen'],
                  expect_beauty_expert: true,
                  expect_non_beauty_isolation: false,
                  invoke: {
                    sources: ['shopping_agent', 'creator_agent'],
                    requires_auth: true,
                    auth_profile: 'default',
                    operation: 'find_products_multi',
                    payload: {
                      search: {
                        query: 'I have oily skin, what sunscreen should I buy?',
                        catalog_surface: 'beauty',
                        limit: 6,
                      },
                    },
                    metadata: {
                      catalog_surface: 'beauty',
                      beauty_domain_hint: 'beauty',
                      allow_orchestration_delegate: true,
                    },
                  },
                  aurora: {
                    surfaces: ['v1_chat', 'v2_chat'],
                    request: {
                      message: 'I have oily skin, what sunscreen should I buy?',
                      language: 'EN',
                      session: {
                        state: 'IDLE_CHAT',
                        profile: { skinType: 'oily' },
                      },
                      context: {
                        locale: 'en',
                        profile: { skinType: 'oily' },
                      },
                      client_state: { state: 'IDLE_CHAT' },
                    },
                  },
                },
              },
            },
            {
              id: 'non_beauty_case',
              family: 'cross_agent_non_beauty_control',
              targets: {
                beauty_cross_agent: {
                  title: 'non beauty',
                  prompt: 'I need a carry-on suitcase under $200',
                  expected_domain: 'non_beauty',
                  expected_beauty_mode: null,
                  expected_delegated_layer: 'decisioning',
                  expect_beauty_expert: false,
                  expect_non_beauty_isolation: true,
                  invoke: {
                    sources: ['shopping_agent', 'creator_agent'],
                    requires_auth: true,
                    auth_profile: 'default',
                    operation: 'find_products_multi',
                    payload: {
                      search: {
                        query: 'I need a carry-on suitcase under $200',
                        limit: 6,
                      },
                    },
                    metadata: {
                      allow_orchestration_delegate: true,
                    },
                  },
                },
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    const invokeBeautyResponse = {
      layer: 'orchestration',
      reply: 'Fluid Sunscreen makes more sense if you want lighter wear instead of a more matte finish.',
      beauty_expert_v1: {
        contract_version: 'beauty_expert_v1',
        mode: 'category_compare',
        reco_bundle: {
          lead_picks: [{ title: 'Fluid Sunscreen' }],
          support_picks: [{ title: 'Matte Sunscreen' }],
        },
        compare_axes: [
          { label: 'lighter / smoother finish' },
          { label: 'matte / shine control' },
        ],
        next_actions: [{ type: 'compare_same_type' }, { type: 'show_alternatives' }],
        delegation_trace: {
          entry_layer: 'orchestration',
          delegated_layer: 'decisioning',
          projection_type: 'normalized_only',
        },
      },
    };
    const auroraBeautyResponse = {
      assistant_message: {
        role: 'assistant',
        format: 'text',
        content:
          'Fluid Sunscreen makes more sense if you want lighter wear instead of a more matte finish. Matte Sunscreen leans more matte if you want less slip.',
      },
      cards: [
        {
          type: 'recommendations',
          sections: [
            {
              products: [
                {
                  title: 'Fluid Sunscreen',
                  why_this_one: 'Keeps the finish lighter and smoother under makeup.',
                },
                {
                  title: 'Matte Sunscreen',
                  why_this_one: 'Leans more matte and shine-controlling if you want less slip.',
                },
              ],
            },
          ],
        },
      ],
      beauty_expert_v1: {
        contract_version: 'beauty_expert_v1',
        mode: 'category_compare',
        reco_bundle: {
          lead_picks: [{ title: 'Fluid Sunscreen' }],
          support_picks: [{ title: 'Matte Sunscreen' }],
        },
        compare_axes: [
          { label: 'lighter / smoother finish' },
          { label: 'matte / shine control' },
        ],
        next_actions: [{ type: 'compare_same_type' }, { type: 'show_alternatives' }],
        delegation_trace: {
          entry_layer: 'orchestration',
          delegated_layer: 'decisioning',
          projection_type: 'aurora_cards',
        },
      },
    };

    const server = http.createServer(async (req, res) => {
      const body = await readJsonBody(req);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/agent/shop/v1/invoke' || req.url === '/agent/creator/v1/invoke') {
        if (req.headers.authorization !== 'Bearer ak_live_stage_key') {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
          return;
        }
        if (String(body?.payload?.search?.catalog_surface || '').trim().toLowerCase() === 'beauty') {
          res.statusCode = 200;
          res.end(JSON.stringify(invokeBeautyResponse));
          return;
        }
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            layer: 'decisioning',
            products: [{ title: 'Carry-On Suitcase' }],
            reply: 'Carry-On Suitcase keeps the price under your budget.',
          }),
        );
        return;
      }
      if (req.url === '/v1/chat' || req.url === '/v2/chat') {
        res.statusCode = 200;
        res.end(JSON.stringify(auroraBeautyResponse));
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
        [
          scriptPath,
          '--invoke-base-url',
          baseUrl,
          '--aurora-base-url',
          baseUrl,
          '--cases',
          casesPath,
          '--out-dir',
          outDir,
          '--invoke-timeout-ms',
          '5000',
          '--aurora-timeout-ms',
          '5000',
        ],
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
      const report = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));

      expect(payload.ok).toBe(true);
      expect(report.summary.total_cases).toBe(2);
      expect(report.summary.total_executions).toBe(14);
      expect(report.summary.repeated_run_instability).toHaveLength(0);
      expect(report.summary.failure_buckets.beauty_route_miss).toEqual([]);
      expect(report.summary.failure_buckets.beauty_mode_miss).toEqual([]);
      expect(report.summary.failure_buckets.beauty_truth_split).toEqual([]);
      expect(report.summary.per_surface['invoke:shopping_agent'].total_runs).toBe(4);
      expect(report.summary.per_surface['invoke:creator_agent'].total_runs).toBe(4);
      expect(report.summary.per_surface['aurora:v1_chat'].total_runs).toBe(3);
      expect(report.summary.per_surface['aurora:v2_chat'].total_runs).toBe(3);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('skips invoke runs without auth and still completes Aurora waves', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(
      repoRoot,
      'scripts',
      'run_celestial_commerce_core_beauty_cross_agent_matrix.js',
    );
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beauty-cross-agent-auth-missing-'));
    const casesPath = path.join(outDir, 'cases.json');

    fs.writeFileSync(
      casesPath,
      JSON.stringify(
        {
          schema_version: 'celestial.commerce_core.acceptance_corpus.v1',
          cases: [
            {
              id: 'beauty_guided_case',
              family: 'beauty_cross_agent_guided',
              targets: {
                beauty_cross_agent: {
                  title: 'guided beauty',
                  prompt: 'What should I use for my skin?',
                  expected_domain: 'beauty',
                  expected_beauty_mode: 'guided_beauty_reco',
                  expected_delegated_layer: 'decisioning',
                  expected_next_actions_any: ['consider_skin_analysis', 'ask_missing_constraint'],
                  expect_beauty_expert: true,
                  expect_non_beauty_isolation: false,
                  invoke: {
                    sources: ['shopping_agent', 'creator_agent'],
                    requires_auth: true,
                    auth_profile: 'default',
                    operation: 'find_products_multi',
                    payload: {
                      search: {
                        query: 'What should I use for my skin?',
                        catalog_surface: 'beauty',
                      },
                    },
                    metadata: {
                      catalog_surface: 'beauty',
                      beauty_domain_hint: 'beauty',
                      allow_orchestration_delegate: true,
                    },
                  },
                  aurora: {
                    surfaces: ['v1_chat'],
                    request: {
                      message: 'What should I use for my skin?',
                      language: 'EN',
                      session: { state: 'IDLE_CHAT' },
                      context: { locale: 'en' },
                      client_state: { state: 'IDLE_CHAT' },
                    },
                  },
                },
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    const server = http.createServer(async (_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          assistant_message: {
            role: 'assistant',
            format: 'text',
            content: 'I still need more context tied to your current skincare situation before I can narrow products reliably.',
          },
          beauty_expert_v1: {
            contract_version: 'beauty_expert_v1',
            mode: 'guided_beauty_reco',
            reco_bundle: {
              lead_picks: [],
              support_picks: [],
            },
            compare_axes: [],
            next_actions: [
              { type: 'consider_skin_analysis' },
              { type: 'ask_missing_constraint' },
            ],
            delegation_trace: {
              entry_layer: 'orchestration',
              delegated_layer: 'decisioning',
              projection_type: 'aurora_cards',
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
          '--invoke-base-url',
          baseUrl,
          '--aurora-base-url',
          baseUrl,
          '--cases',
          casesPath,
          '--out-dir',
          outDir,
          '--invoke-timeout-ms',
          '5000',
          '--aurora-timeout-ms',
          '5000',
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            STAGING_AUTH_TOKEN: '',
            STAGING_AGENT_API_KEY: '',
            CELESTIAL_COMMERCE_STAGING_AUTH_TOKEN: '',
            CELESTIAL_COMMERCE_STAGING_AGENT_API_KEY: '',
          },
        },
      );

      const payload = JSON.parse(String(stdout || '').trim());
      const report = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));

      expect(payload.ok).toBe(true);
      expect(report.summary.total_executions).toBe(9);
      expect(report.summary.per_surface['invoke:shopping_agent'].skipped_runs).toBe(3);
      expect(report.summary.per_surface['invoke:creator_agent'].skipped_runs).toBe(3);
      expect(report.summary.per_surface['aurora:v1_chat'].total_runs).toBe(3);
      expect(report.summary.failure_buckets.clarify_policy_miss).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
