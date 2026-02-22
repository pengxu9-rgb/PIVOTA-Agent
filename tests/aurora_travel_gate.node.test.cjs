const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { __internal } = require('../scripts/aurora_travel_gate');

const CASES_PATH = path.join(__dirname, 'golden', 'aurora_travel_weather_20.jsonl');

test('travel gate dataset has fixed 20-case distribution', () => {
  const cases = __internal.loadJsonlCases(CASES_PATH);
  assert.equal(cases.length, 20);

  const byCategory = cases.reduce((acc, item) => {
    const key = String(item.category || 'unknown');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  assert.equal(byCategory.missing_fields, 8);
  assert.equal(byCategory.complete_fields, 8);
  assert.equal(byCategory.api_fail, 4);

  const byLanguage = cases.reduce((acc, item) => {
    const key = String(item.language || 'unknown').toUpperCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  assert.equal(byLanguage.EN, 10);
  assert.equal(byLanguage.CN, 10);
});

test('evaluateCase passes for a valid missing-fields response', () => {
  const caseDef = {
    case_id: 'travel_missing_unit_case',
    category: 'missing_fields',
    language: 'EN',
    expected: {
      intent_canonical: 'travel_planning',
      gate_type: 'soft',
      required_fields_any: ['travel_plan.destination', 'travel_plan.start_date'],
      must_not_have_card_types: ['env_stress'],
      assistant_contains_any: ['destination', 'travel dates'],
    },
    expected_local: {
      max_fetch_calls: 0,
    },
  };

  const body = {
    assistant_message: { content: 'For a travel skincare plan, I need destination and travel dates first.' },
    cards: [],
    events: [
      {
        event_name: 'travel_planning_gate',
        data: { missing_fields: ['travel_plan.destination', 'travel_plan.start_date', 'travel_plan.end_date'] },
      },
    ],
  };

  const meta = {
    intent_canonical: 'travel_planning',
    gate_type: 'soft',
    env_source: null,
    degraded: false,
    rollout_variant: 'v2_core',
    rollout_bucket: 3,
    policy_version: 'aurora_chat_v2_p0',
  };

  const headers = {
    'x-aurora-variant': 'v2_core',
    'x-aurora-bucket': '3',
    'x-aurora-policy-version': 'aurora_chat_v2_p0',
  };

  const out = __internal.evaluateCase({
    caseDef,
    mode: 'local-mock',
    status: 200,
    body,
    headers,
    meta,
    strictMeta: true,
    fetchCalls: 0,
  });

  assert.equal(out.passed, true);
  assert.equal(out.errors.length, 0);
});

test('evaluateCase catches header/meta mismatch', () => {
  const caseDef = {
    case_id: 'travel_complete_unit_case',
    category: 'complete_fields',
    language: 'EN',
    expected: {
      intent_canonical: 'travel_planning',
      gate_type: 'none',
      env_source_in: ['weather_api'],
      must_have_card_types: ['env_stress'],
      assistant_contains_any: ['EPI'],
    },
    expected_local: {
      min_fetch_calls: 2,
      degraded: false,
    },
  };

  const body = {
    assistant_message: { content: 'Environmental Pressure Index (EPI): 72/100.' },
    cards: [{ type: 'env_stress' }],
    events: [],
  };

  const meta = {
    intent_canonical: 'travel_planning',
    gate_type: 'none',
    env_source: 'weather_api',
    degraded: false,
    rollout_variant: 'v2_core',
    rollout_bucket: 2,
    policy_version: 'aurora_chat_v2_p0',
  };

  const headers = {
    'x-aurora-variant': 'legacy',
    'x-aurora-bucket': '2',
    'x-aurora-policy-version': 'aurora_chat_v2_p0',
  };

  const out = __internal.evaluateCase({
    caseDef,
    mode: 'local-mock',
    status: 200,
    body,
    headers,
    meta,
    strictMeta: true,
    fetchCalls: 2,
  });

  assert.equal(out.passed, false);
  assert.ok(out.errors.some((msg) => /header\/meta mismatch/i.test(msg)));
});
