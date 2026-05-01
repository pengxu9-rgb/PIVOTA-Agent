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
      } catch (_err) {
        resolve({});
      }
    });
  });
}

describe('beauty cross-agent batch runner', () => {
  test('default casepack has the required v1 schema fields', () => {
    const repoRoot = path.join(__dirname, '..');
    const datasetPath = path.join(repoRoot, 'datasets', 'beauty_cross_agent_multiturn_seed.json');
    const { validateDataset } = require('../scripts/run_beauty_cross_agent_batch.cjs');
    const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

    expect(dataset.schema_version).toBe('beauty_cross_agent_multiturn.v1');
    expect(dataset.cases).toHaveLength(13);
    expect(validateDataset(dataset)).toEqual([]);
    for (const testCase of dataset.cases) {
      expect(testCase).toEqual(
        expect.objectContaining({
          case_id: expect.any(String),
          persona: expect.any(Object),
          profile: expect.any(Object),
          turns: expect.any(Array),
          agent_routes: expect.any(Object),
          shopping_queries: expect.any(Array),
          creator_queries: expect.any(Array),
          expected_assertions: expect.any(Array),
          risk_guards: expect.any(Object),
        }),
      );
    }
  });

  test('flags pivot beauty aurora reply surface drift as a schema violation', () => {
    const { validateResponseSchema } = require('../scripts/run_beauty_cross_agent_batch.cjs');
    const body = {
      assistant_text: 'Seattle -> Seoul travel skincare plan: prepare SPF and barrier repair.',
      assistant_message: {
        role: 'assistant',
        content: 'Seattle -> Seoul travel skincare plan: prepare SPF and barrier repair.',
      },
      reply: 'I need a bit more context before narrowing products: skin_type.',
      cards: [{ type: 'travel', payload: { status: 'success' } }],
      session_patch: {
        meta: {
          pivot_contract_version: 'pivot.agent.v1',
        },
      },
    };

    expect(validateResponseSchema('aurora_chat', body, null)).toEqual({
      valid: false,
      reason: 'aurora_reply_surface_mismatch',
    });
  });

  test('writes JSON, markdown, raw responses, and human review CSV against a local fake service', async () => {
    const repoRoot = path.join(__dirname, '..');
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beauty-cross-agent-out-'));
    const datasetPath = path.join(outRoot, 'cases.json');
    const scriptPath = path.join(repoRoot, 'scripts', 'run_beauty_cross_agent_batch.cjs');

    const dataset = {
      schema_version: 'beauty_cross_agent_multiturn.v1',
      generated_at: '2026-04-29T00:00:00Z',
      defaults: {
        language: 'CN',
        market: 'US',
        creator_id: 'nina-studio',
        creator_view: 'GLOBAL_BEAUTY',
      },
      thresholds: {
        http_success_rate_min: 0.95,
        schema_violation_max: 0,
        high_risk_guard_pass_rate_min: 1,
      },
      cases: [
        {
          case_id: 'local_case',
          persona: { language: 'CN', summary: 'local test' },
          profile: { skinType: 'dry_sensitive' },
          turns: [
            {
              turn_id: 't1',
              route: 'aurora_chat',
              message: '帮我做一个旅行修护防晒清单。',
            },
          ],
          agent_routes: {
            aurora: ['/v1/chat'],
            shopping: '/agent/shop/v1/invoke',
            creator: '/agent/creator/v1/invoke',
            creator_categories: '/creator/nina-studio/categories?view=GLOBAL_BEAUTY',
          },
          shopping_queries: [
            {
              query: 'daily sunscreen sensitive skin',
              target_terms: ['sunscreen', 'spf'],
              blocked_terms: ['retinol'],
              min_relevant_top6: 1,
            },
          ],
          creator_queries: [
            {
              query: 'daily sunscreen sensitive skin',
              target_terms: ['sunscreen', 'spf'],
              blocked_terms: ['retinol'],
              min_relevant_top6: 1,
            },
          ],
          expected_assertions: ['sunscreen'],
          risk_guards: {
            severity: 'high',
            assistant_must_include_any: [['旅行', 'travel'], ['防晒', 'sunscreen'], ['补涂', 'reapply']],
            assistant_must_not_include_any: ['不需要防晒'],
            product_must_not_include_any: ['retinol'],
          },
          creator_category_check: {
            view: 'GLOBAL_BEAUTY',
            must_have_category_terms: ['skin-care', 'sunscreen'],
            require_products: true,
          },
        },
      ],
    };
    fs.writeFileSync(datasetPath, JSON.stringify(dataset, null, 2));

    const server = http.createServer(async (req, res) => {
      const body = await readJsonBody(req);
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/chat') {
        res.statusCode = 200;
        res.setHeader('X-Request-Id', 'aurora-local-request');
        res.end(
          JSON.stringify({
            cards: [
              {
                card_type: 'text_response',
                title: 'UI chrome should not be scored',
                sections: [
                  {
                    type: 'text_answer',
                    title: 'Section chrome should not be scored',
                    text_en: '旅行时先用温和修护，白天防晒并补涂，选择轻薄 sunscreen。',
                  },
                ],
              },
            ],
            follow_up_questions: [],
            suggested_quick_replies: [],
            ops: {},
            safety: {},
            telemetry: {},
            session_patch: { meta: { local: true } },
          }),
        );
        return;
      }
      if (
        req.method === 'POST' &&
        (req.url === '/agent/shop/v1/invoke' || req.url === '/agent/creator/v1/invoke')
      ) {
        res.statusCode = 200;
        res.setHeader('X-Request-Id', req.url.includes('/creator/') ? 'creator-local-request' : 'shop-local-request');
        res.end(
          JSON.stringify({
            products: [
              { product_id: 'spf_1', title: 'Daily Sunscreen SPF 50' },
              { product_id: 'spf_2', title: 'Sensitive Skin Sunscreen Lotion' },
            ],
            metadata: {
              query_source: req.url.includes('/creator/') ? 'cache_creator_search' : 'agent_products_search',
              search_decision: {
                decision_authority: req.url.includes('/creator/') ? 'cache_creator_search' : 'agent_products_search',
              },
              echo_query: body?.payload?.search?.query || '',
            },
          }),
        );
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/creator/nina-studio/categories')) {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            categories: [
              {
                name: 'Skin Care',
                slug: 'skin-care',
                product_count: 4,
                children: [{ name: 'Sunscreen', slug: 'sunscreen', product_count: 2 }],
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'NOT_FOUND' }));
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
          '--dataset',
          datasetPath,
          '--out-dir',
          outRoot,
          '--run-id',
          'local_run',
          '--delay-ms',
          '0',
          '--agent-api-key',
          'agent_key_local_test',
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
        },
      );
      const payload = JSON.parse(String(stdout || '').trim());
      expect(payload.ok).toBe(true);
      expect(payload.summary.total_cases).toBe(1);
      expect(payload.summary.product_relevance_pass_count).toBe(2);
      expect(payload.summary.degraded_response_count).toBe(0);
      expect(fs.existsSync(payload.json_path)).toBe(true);
      expect(fs.existsSync(payload.markdown_path)).toBe(true);
      expect(fs.existsSync(payload.human_review_csv)).toBe(true);

      const report = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));
      expect(report.results[0].assessment.pass).toBe(true);
      expect(report.results[0].rows[0].assistant_text).toContain('旅行时先用温和修护');
      expect(report.results[0].rows[0].assistant_text).not.toContain('UI chrome should not be scored');
      expect(report.results[0].rows[0].assistant_text).not.toContain('Section chrome should not be scored');
      expect(report.results[0].rows.map((row) => row.agent)).toEqual([
        'aurora_chat',
        'shopping',
        'creator',
        'creator_category',
      ]);
      expect(fs.readFileSync(payload.markdown_path, 'utf8')).toContain('Beauty Cross-Agent Batch Report');
      expect(fs.readFileSync(payload.human_review_csv, 'utf8')).toContain('content_quality_1_5');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('marks error fallback 200 responses as failed degraded results', async () => {
    const { computeSummary } = require('../scripts/run_beauty_cross_agent_batch.cjs');
    const dataset = {
      thresholds: {
        http_success_rate_min: 0.95,
        schema_violation_max: 0,
        high_risk_guard_pass_rate_min: 1,
        degraded_response_max: 0,
      },
    };
    const results = [
      {
        case_id: 'fallback_case',
        rows: [
          {
            ok: true,
            schema_valid: true,
            product_assessment: { pass: false },
            degradation: {
              degraded: true,
              reasons: ['error_fallback', 'empty_fallback', 'timeout_or_abort'],
            },
          },
        ],
        assessment: {
          pass: false,
          risk_guard: { severity: 'high', pass: true },
        },
      },
    ];
    const summary = computeSummary(dataset, results);
    expect(summary.http_success_rate).toBe(1);
    expect(summary.degraded_response_count).toBe(1);
    expect(summary.error_fallback_empty_count).toBe(1);
    expect(summary.timeout_fallback_count).toBe(1);
    expect(summary.ok).toBe(false);
  });

  test('does not flag successful responses with timeout false telemetry as degraded', () => {
    const { classifyResponseDegradation } = require('../scripts/run_beauty_cross_agent_batch.cjs');
    const degradation = classifyResponseDegradation(
      {
        status: 'success',
        products: [{ product_id: 'spf_1', title: 'Daily Sunscreen SPF 50' }],
        metadata: {
          query_source: 'agent_products_beauty_external_seed_mainline',
          search_trace: {
            upstream_stage: {
              called: false,
              timeout: false,
              status: null,
            },
          },
          route_health: {
            fallback_triggered: false,
            fallback_adopted: false,
          },
        },
      },
      {
        status: 200,
        transport_error: '',
      },
    );

    expect(degradation).toEqual({ degraded: false, reasons: [] });
  });

  test('flags explicit timeout true telemetry as degraded', () => {
    const { classifyResponseDegradation } = require('../scripts/run_beauty_cross_agent_batch.cjs');
    const degradation = classifyResponseDegradation(
      {
        status: 'success',
        products: [{ product_id: 'spf_1', title: 'Daily Sunscreen SPF 50' }],
        metadata: {
          query_source: 'agent_products_beauty_external_seed_mainline',
          search_trace: {
            upstream_stage: {
              called: true,
              timeout: true,
            },
          },
        },
      },
      {
        status: 200,
        transport_error: '',
      },
    );

    expect(degradation).toEqual({ degraded: true, reasons: ['timeout_or_abort'] });
  });

  test('assistant must-not guard ignores explicit avoidance wording', () => {
    const { evaluateRiskGuards } = require('../scripts/run_beauty_cross_agent_batch.cjs');
    const guardedCase = {
      risk_guards: {
        severity: 'medium',
        assistant_must_not_include_any: ['large routine'],
      },
    };

    const safe = evaluateRiskGuards(guardedCase, [
      {
        agent: 'aurora_chat',
        assistant_text: 'Do not expand local shopping into a large routine; keep sunscreen and repair cream first.',
      },
    ]);
    const unsafe = evaluateRiskGuards(guardedCase, [
      {
        agent: 'aurora_chat',
        assistant_text: 'Build a large routine with many new steps before travel.',
      },
    ]);

    expect(safe.pass).toBe(true);
    expect(unsafe.pass).toBe(false);
  });

  test('checks response language against requested language', () => {
    const { evaluateResponseLanguageMatch } = require('../scripts/run_beauty_cross_agent_batch.cjs');

    expect(evaluateResponseLanguageMatch({
      expectedLanguage: 'CN',
      text: '行程：Seattle -> Seoul。出发前带已耐受洁面、防晒和修护，飞行中重点保湿。',
    }).pass).toBe(true);

    expect(evaluateResponseLanguageMatch({
      expectedLanguage: 'CN',
      text: 'Trip: Seattle to Seoul. Pack sunscreen and moisturizer before flight.',
    }).pass).toBe(false);

    expect(evaluateResponseLanguageMatch({
      expectedLanguage: 'EN',
      text: 'Trip: Seattle to Seoul. Pack sunscreen and moisturizer before the flight.',
    }).pass).toBe(true);
  });

  test('scores travel-local quality across assistant text and product authority', () => {
    const {
      evaluateTravelLocalQuality,
      evaluateProductRelevance,
    } = require('../scripts/run_beauty_cross_agent_batch.cjs');
    const queryDef = {
      query: 'Seoul local skincare sunscreen',
      target_terms: ['sunscreen', 'spf'],
      min_relevant_top6: 2,
      travel_local_quality: {
        min_local_or_travel_authority_top6: 2,
        require_trip_context_reason: true,
      },
    };
    const products = [
      {
        title: 'Round Lab SPF 50 Sunscreen',
        raw: {
          product_class: 'sunscreen',
          trip_context_reason: 'Seoul local reason: use for local UV and walking sun exposure.',
          local_authority: { brand_home_market: 'KR', local_purchase_markets: ['KR'] },
        },
      },
      {
        title: 'Beauty of Joseon SPF 50 Sunscreen',
        raw: {
          product_class: 'sunscreen',
          trip_context_reason: 'Seoul local reason: use for local UV and reapplication.',
          local_authority: { brand_home_market: 'KR' },
        },
      },
    ];
    const assessment = evaluateProductRelevance(queryDef, products);
    expect(assessment.pass).toBe(true);
    expect(assessment.travel_local_quality.local_or_travel_authority_top6).toBe(2);

    const caseAssessment = evaluateTravelLocalQuality(
      {
        travel_local_quality: {
          origin_terms: ['Seattle'],
          destination_terms: ['Seoul'],
          date_terms: ['2026-05-20'],
          flight_risk_groups: [['机舱', 'cabin'], ['干燥', 'dry']],
          destination_risk_groups: [['UV'], ['fine dust', '城市污染'], ['步行', 'walking'], ['口罩', 'mask']],
          section_groups: [['出发前'], ['在 Seoul 当地买'], ['避开'], ['应急修护']],
        },
      },
      [
        {
          agent: 'aurora_chat',
          assistant_text: [
            '行程：Seattle -> Seoul（2026-05-20 到 2026-05-27）。',
            '机舱干燥会放大紧绷，Seoul 的 UV、fine dust/城市污染、步行暴晒和口罩摩擦都要考虑。',
            '出发前带：洁面、防晒、修护。',
            '在 Seoul 当地买：按缺口补防晒。',
            '旅途中先避开：不要叠加强刺激。',
            '应急修护：刺痛泛红先停活性。',
          ].join('\n'),
        },
        {
          agent: 'shopping',
          step_id: 'shopping_1',
          product_assessment: assessment,
        },
      ],
    );
    expect(caseAssessment.pass).toBe(true);
  });
});
