const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { inferCanonicalIntent, INTENT_ENUM } = require('../src/auroraBff/intentCanonical');
const { resolveQaPlan } = require('../src/auroraBff/qaPlanner');
const routes = require('../src/auroraBff/routes');
const runScript = require('../scripts/run_routine_multiturn_seed_cases.cjs');
const exportScript = require('../scripts/export_routine_multiturn_scoring_packets.cjs');

test('intentCanonical extracts destination + time_window from free text travel input', () => {
  const out = inferCanonicalIntent({
    message: '我下周去哈尔滨出差，零下20度大风，帮我调护肤。',
  });
  assert.equal(out.intent, INTENT_ENUM.TRAVEL_PLANNING);
  assert.equal(out.entities.time_window, 'next_week');
  assert.equal(String(out.entities.destination || '').includes('哈尔滨'), true);
});

test('qaPlanner allows non-blocking travel answer when destination/time_window exist', () => {
  const plan = resolveQaPlan({
    intent: INTENT_ENUM.TRAVEL_PLANNING,
    profile: {
      travel_plan: {
        destination: 'Harbin',
        time_window: 'next_week',
      },
      region: 'CN',
      skinType: 'oily',
      sensitivity: 'low',
      barrierStatus: 'healthy',
      goals: ['pores'],
    },
    message: 'Please adjust for travel weather next week.',
    language: 'EN',
    session: {},
  });

  assert.ok(plan.gate_type === 'none' || plan.gate_type === 'soft');
  assert.equal(plan.can_answer_now, true);
  assert.equal(plan.next_step, 'tool_call');
  assert.ok(plan.required_fields.every((f) => String(f).startsWith('travel_plan.')));
});

test('routes quality contract flags stall + module fail for routine envelope', () => {
  const q = routes.__internal.evaluateQualityContractForEnvelope({
    envelope: {
      cards: [],
    },
    policyMeta: {
      intent_canonical: 'routine',
    },
    assistantText: 'Please retry shortly and upload photos first.',
  });

  assert.equal(q.contract_pass, false);
  assert.equal(q.stall_hit, true);
  assert.ok(Array.isArray(q.critical_fail_reasons));
  assert.ok(q.critical_fail_reasons.includes('stall_fail'));
  assert.ok(q.critical_fail_reasons.includes('module_fail'));
});

test('travel/env suppression keeps routine expert summary when preserve flag enabled', () => {
  const cards = [
    {
      type: 'analysis_summary',
      payload: {
        analysis: {
          routine_expert: {
            snapshot: { focus: 'barrier' },
            key_issues: ['barrier'],
            phase_plan: { phase_1: 'repair' },
            plan_7d: { day_1: 'cleanse' },
            primary_question: 'Do you already have ceramide cream?',
          },
        },
      },
    },
    { type: 'analysis_story_v2', payload: { summary: 'story' } },
    { type: 'travel', payload: { schema_version: 'aurora.ui.env_stress.v1' } },
  ];

  const suppressed = routes.__internal.suppressAnalysisCardsForTravelEnvTurn(cards, {
    canonicalIntent: 'travel_planning',
    preserveRoutineExpertSummary: true,
  });
  assert.deepEqual(suppressed.map((card) => card.type), ['analysis_summary', 'travel']);
});

test('travel/env suppression removes analysis summary when preserve flag disabled', () => {
  const cards = [
    {
      type: 'analysis_summary',
      payload: {
        analysis: {
          routine_expert: {
            snapshot: { focus: 'barrier' },
          },
        },
      },
    },
    { type: 'analysis_story_v2', payload: { summary: 'story' } },
    { type: 'travel', payload: { schema_version: 'aurora.ui.env_stress.v1' } },
  ];

  const suppressed = routes.__internal.suppressAnalysisCardsForTravelEnvTurn(cards, {
    canonicalIntent: 'travel_planning',
    preserveRoutineExpertSummary: false,
  });
  assert.deepEqual(suppressed.map((card) => card.type), ['travel']);
});

test('routes catalog domain guard rejects makeup brush parse card', () => {
  const bad = {
    type: 'product_parse',
    payload: {
      product: {
        name: 'Blush Brush',
        category: 'makeup brush',
      },
    },
  };
  const good = {
    type: 'product_parse',
    payload: {
      product: {
        name: 'Lightweight Gel Sunscreen',
        category: 'skincare sunscreen',
      },
    },
  };

  assert.equal(routes.__internal.isSkincareCatalogCard(bad), false);
  assert.equal(routes.__internal.isSkincareCatalogCard(good), true);
});

test('run script v2 contract evaluator marks stall + missing modules on final turn', () => {
  const evaluated = runScript.__internal.evaluateTurnContract({
    runTurn: {
      ok: true,
      user: 'Can I restart glycolic acid tonight?',
      response: {
        assistant_message: {
          content: 'Please retry shortly and upload photos first.',
        },
        cards: [],
      },
    },
    datasetTurn: {
      expected_agent_contract: [
        'Check if warmth and redness have fully subsided before reintroduction',
      ],
    },
    isFinalTurn: true,
    finalExpectations: {
      must_output_modules: ['snapshot', 'key_issues', 'phase_plan', 'plan_7d', 'primary_question'],
    },
  });

  assert.equal(evaluated.contract_pass, false);
  assert.equal(evaluated.stall_hit, true);
  assert.ok(evaluated.critical_fail_reasons.includes('stall_fail'));
  assert.ok(evaluated.critical_fail_reasons.includes('module_fail'));
  assert.ok(Array.isArray(evaluated.missing_modules));
  assert.ok(evaluated.missing_modules.length >= 1);
});

test('export script v2 packet includes sha256 source and contract fields', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-export-v2-'));
  const runPath = path.join(tmpDir, 'run.json');
  const datasetPath = path.join(tmpDir, 'dataset.json');

  const runReport = {
    schema_version: 'routine_expert_multiturn_run.v2',
    summary: {
      turns_total: 1,
      turns_ok: 1,
      contract_pass_rate: 0,
      stall_rate: 1,
      missing_modules_rate: 1,
      critical_fail_rate: 1,
    },
    cases: [
      {
        id: 'routine_mt_001',
        language: 'CN',
        scenario_key: 'demo',
        profile_update: { ok: true, status: 200 },
        total_turns: 1,
        ok_turns: 1,
        final_state: 'idle',
        turns: [
          {
            turn_id: 1,
            user: 'test',
            status: 200,
            ok: true,
            latency_ms: 20,
            attempts: 1,
            request_state: 'idle',
            response_state: 'idle',
            cards_count: 0,
            response: { cards: [], assistant_message: { content: 'Please retry shortly' } },
            contract_pass: false,
            stall_hit: true,
            missing_modules: ['snapshot'],
            critical_fail_reasons: ['stall_fail', 'module_fail'],
            contract_clause_total: 1,
            contract_clause_hit_count: 0,
            contract_clause_hit_rate: 0,
            contract_clause_min_pass: 1,
            contract_clause_checks: [],
          },
        ],
      },
    ],
  };

  const dataset = {
    schema_version: 'routine_expert_multiturn_benchmark.v1',
    rubric_dimensions: ['accuracy', 'context_memory'],
    cases: [
      {
        id: 'routine_mt_001',
        language: 'CN',
        scenario_key: 'demo',
        conversation: [{ turn_id: 1, user: 'test', user_intent: 'build_routine', expected_agent_contract: [] }],
        final_expectations: { must_output_modules: ['snapshot'] },
        scoring_hooks: {},
      },
    ],
  };

  fs.writeFileSync(runPath, JSON.stringify(runReport, null, 2));
  fs.writeFileSync(datasetPath, JSON.stringify(dataset, null, 2));

  const packet = exportScript.__internal.buildPacket({ runReport, runPath, dataset, datasetPath });
  assert.equal(packet.schema_version, 'routine_expert_multiturn_scoring_packet.v2');
  assert.ok(packet.source.run_report_sha256 && packet.source.run_report_sha256.length === 64);
  assert.ok(packet.source.dataset_sha256 && packet.source.dataset_sha256.length === 64);
  assert.equal(packet.cases.length, 1);
  assert.equal(packet.cases[0].turns[0].stall_hit, true);
  assert.ok(packet.cases[0].turns[0].critical_fail_reasons.includes('stall_fail'));
});
