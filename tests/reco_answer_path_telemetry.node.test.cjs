'use strict';

// WHICH ANSWER PATH SERVED THE TURN, as a number you can count rather than one you poll for.
//
// #2155 turns on this: the domain rules live in an LLM prompt, and only the LLM path reads one. The
// catalog path answers without ever consulting it, which is how a bronzer need comes back as
// cleansers. Deciding whether to fix the prompt or the recall depends entirely on which path serves
// what share — and until now the only way to find out was to call the lane by hand and read
// `confidence_basis` off the response body. Measured that way on 2026-09-09: the consumer lane
// answered `llm_primary` 16/16 across skincare, makeup, haircare and fragrance needs, while the
// agent door used both. Sixteen hand samples is not a rate.
//
// The counter lives in the LANE, not a route handler, because `recommend_products` emits no
// reco_requested event at all — a handler-side signal would miss the door the defect was filed
// against. And it is labelled by entry type because one number across both doors would have hidden
// the difference above.

process.env.AURORA_BFF_USE_MOCK = 'false';
process.env.AURORA_DECISION_BASE_URL = 'https://decision.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const CLIENT_ID = require.resolve('../src/auroraBff/auroraDecisionClient');
const ROUTES_ID = require.resolve('../src/auroraBff/routes');
const metrics = require('../src/auroraBff/visionMetrics');

function pathCounts() {
  const out = {};
  for (const line of metrics.renderVisionMetricsPrometheus().split('\n')) {
    const m = /^aurora_reco_answer_path_total\{entry_type="([^"]+)",basis="([^"]+)"\} (\d+)/.exec(line);
    if (m) out[`${m[1]}/${m[2]}`] = Number(m[3]);
  }
  return out;
}

async function runLane({ entryType, chat }) {
  delete require.cache[ROUTES_ID];
  delete require.cache[CLIENT_ID];
  const client = require('../src/auroraBff/auroraDecisionClient');
  const original = client.auroraChat;
  client.auroraChat = chat;
  try {
    const { __internal } = require('../src/auroraBff/routes');
    return await __internal.generateProductRecommendations({
      ctx: { request_id: 'r', trace_id: 't', aurora_uid: 'agent:test', lang: 'EN',
        trigger_source: 'agent_tool', state: null, backend_auth_headers: {} },
      profile: null, recentLogs: [], message: 'a gentle retinol', focus: 'a gentle retinol',
      includeAlternatives: false, debug: true, logger: null, budgetMs: 4000,
      entryType, recoTriggerSource: 'agent_tool',
    });
  } finally {
    client.auroraChat = original;
    delete require.cache[ROUTES_ID];
    delete require.cache[CLIENT_ID];
  }
}

const answering = async () => ({ answer: JSON.stringify({
  recommendations: [{ brand: 'X', name: 'Y', step: 'treatment', query_terms: ['t'], reasons: ['r'] }],
  confidence: 0.7, warnings: [], missing_info: [] }) });
const deadLeg = async () => { const e = new Error('Upstream status 400'); e.status = 400; throw e; };

test('the lane counts the path it answered from, per door', async () => {
  const before = pathCounts();
  await runLane({ entryType: 'direct', chat: answering });
  const afterDirect = pathCounts();
  assert.equal((afterDirect['direct/model_self_report'] || 0) - (before['direct/model_self_report'] || 0), 1,
    'an LLM answer on the agent-door entry type must count as model_self_report');

  await runLane({ entryType: 'chat', chat: answering });
  const afterChat = pathCounts();
  assert.equal((afterChat['chat/model_self_report'] || 0) - (afterDirect['chat/model_self_report'] || 0), 1,
    'the doors must be countable apart — that is the whole point of the label');
  // and the direct count did NOT move when the chat turn ran
  assert.equal(afterChat['direct/model_self_report'], afterDirect['direct/model_self_report']);
});

test('a turn no path could serve counts as none, not as a missing row', async () => {
  // A silently uncounted failure is the defect class that made the 2026-09-09 incident invisible;
  // the path counter must not repeat it by simply not incrementing.
  const before = pathCounts();
  await runLane({ entryType: 'direct', chat: deadLeg });
  const after = pathCounts();
  assert.equal((after['direct/none'] || 0) - (before['direct/none'] || 0), 1);
});

test('the label vocabulary is closed — an unexpected basis cannot mint a new series', () => {
  // Prometheus label cardinality is a real cost, and `confidence_basis` is a string that could grow.
  const before = pathCounts();
  metrics.recordAuroraRecoAnswerPath({ entryType: 'direct', basis: 'some_future_value' });
  const after = pathCounts();
  assert.equal((after['direct/unknown'] || 0) - (before['direct/unknown'] || 0), 1);
  assert.ok(!Object.keys(after).some((k) => k.endsWith('/some_future_value')));
});

test('the counter agrees with what the wire says on the same turn', () => {
  // The number and the response body must be derived from ONE thing. If the counter had its own
  // derivation it could drift from `confidence_basis`, and a dashboard would disagree with the
  // payload a partner is holding.
  const { deriveRecoConfidenceBasis } = require('../src/auroraBff/recoConfidenceBasis');
  for (const source of ['llm_primary', 'catalog_grounded', 'catalog_transient_fallback', 'legacy_notice', null]) {
    const basis = deriveRecoConfidenceBasis(source);
    const before = pathCounts();
    metrics.recordAuroraRecoAnswerPath({ entryType: 'direct', basis });
    const after = pathCounts();
    assert.equal((after[`direct/${basis}`] || 0) - (before[`direct/${basis}`] || 0), 1,
      `basis ${basis} from source ${source} must be a countable series`);
  }
});

test('the event carries the path too, distinctly from source_mode', () => {
  // `source` on the event is source_mode — a PRESENTATION label with its own fallback ladder, which
  // can read 'step_aware_mainline' on a turn the LLM actually answered. They must not be confused.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'auroraBff', 'routes.js'), 'utf8');
  assert.match(src, /confidence_basis: pickFirstTrimmed\(meta\.confidence_basis\)/,
    'the reco_requested event must carry the path for the doors that emit it');
});
