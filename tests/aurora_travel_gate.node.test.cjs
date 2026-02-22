const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { __internal } = require('../scripts/aurora_travel_gate');

const CASES_PATH = path.join(__dirname, 'golden', 'aurora_travel_weather_20.jsonl');
const SAFETY_CASES_PATH = path.join(__dirname, 'golden', 'aurora_safety_20.jsonl');
const ANCHOR_CASES_PATH = path.join(__dirname, 'golden', 'aurora_anchor_eval_20.jsonl');

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

test('safety20 dataset has fixed 20-case distribution', () => {
  const cases = __internal.loadJsonlCases(SAFETY_CASES_PATH);
  assert.equal(cases.length, 20);

  const byCategory = cases.reduce((acc, item) => {
    const key = String(item.category || 'unknown');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  assert.equal(byCategory.block, 10);
  assert.equal(byCategory.require_info, 10);

  const byLanguage = cases.reduce((acc, item) => {
    const key = String(item.language || 'unknown').toUpperCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  assert.equal(byLanguage.EN, 10);
  assert.equal(byLanguage.CN, 10);
});

test('anchor20 dataset has fixed 20-case distribution', () => {
  const cases = __internal.loadJsonlCases(ANCHOR_CASES_PATH);
  assert.equal(cases.length, 20);

  const byCategory = cases.reduce((acc, item) => {
    const key = String(item.category || 'unknown');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  assert.equal(byCategory.anchor_required, 8);
  assert.equal(byCategory.anchor_intake, 8);
  assert.equal(byCategory.anchor_followup, 4);

  const byLanguage = cases.reduce((acc, item) => {
    const key = String(item.language || 'unknown').toUpperCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  assert.equal(byLanguage.EN, 10);
  assert.equal(byLanguage.CN, 10);
});

test('normalizeCaseTurns returns turn list for both single-turn and multi-turn cases', () => {
  const single = __internal.normalizeCaseTurns({
    case_id: 'single_turn',
    language: 'EN',
    message: 'Can I use retinol?',
    session_profile: { skinType: 'oily' },
  });
  assert.equal(single.length, 1);
  assert.equal(single[0].turn_id, 'turn_1');
  assert.equal(single[0].message, 'Can I use retinol?');
  assert.equal(single[0].language, 'EN');
  assert.deepEqual(single[0].session_profile, { skinType: 'oily' });

  const multi = __internal.normalizeCaseTurns({
    case_id: 'multi_turn',
    language: 'EN',
    turns: [
      { turn_id: 'a', message: 'Is this toner good for me?' },
      { turn_id: 'b', message: 'Send a link', language: 'CN' },
    ],
  });
  assert.equal(multi.length, 2);
  assert.equal(multi[0].turn_id, 'a');
  assert.equal(multi[0].language, 'EN');
  assert.equal(multi[1].turn_id, 'b');
  assert.equal(multi[1].language, 'CN');
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

test('evaluateCase supports event assertions and assistant_not_contains_any', () => {
  const caseDef = {
    case_id: 'anchor_followup_unit_case',
    category: 'anchor_followup',
    language: 'EN',
    expected: {
      intent_canonical: 'evaluate_product',
      gate_type: 'hard',
      must_have_events: ['anchor_collection_waiting_input'],
      assistant_contains_any: ['product link'],
      assistant_not_contains_any: ['upstream is unavailable'],
    },
  };

  const turnDef = {
    turn_id: 'send_link',
    message: 'Send a link',
  };

  const body = {
    assistant_message: { content: 'Please paste the product link and I will continue.' },
    cards: [],
    events: [{ event_name: 'anchor_collection_waiting_input', data: { intent: 'evaluate_product' } }],
  };

  const meta = {
    intent_canonical: 'evaluate_product',
    gate_type: 'hard',
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
    turnDef,
    turnIndex: 1,
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
  assert.equal(out.turn_id, 'send_link');
});
