'use strict';

// #2155 — `recommend_products` advertises BEAUTY; the lane it calls was bounded to SKINCARE by its
// prompt ("Never recommend makeup, brushes, beauty tools, devices, fragrance, haircare"). Measured
// 2026-09-08 on commerce.mcp.pivota.cc: "a bronzer for contouring my cheekbones, warm undertone"
// returned The Ordinary Soothing & Barrier Support Serum at fit 'high', with the exclusion stated in
// metadata.warnings.
//
// The prompt is SHARED. prompts/reco_main_v1_2.system.txt is loaded by the agent door AND by the
// Aurora consumer chat lane (legacyRecoMainlineExecution -> buildRecoLlmPromptState), so widening it
// in place would also widen the chat surface — the one just fixed end-to-end for acne. The fix
// therefore selects a DIFFERENT template per door: `promptDomainScope: 'beauty'` (set by the agent
// bridge only) loads reco_main_v1_3; everything else keeps reco_main_v1_2 byte-for-byte.
//
// The first test drives the REAL lane through every hop (bridge arg -> generation engine -> mainline
// execution -> routes prompt builder) with no fakes at all, so deleting the forward at ANY hop turns
// it red. The engine's ~100-dependency DI surface makes a hand-built fake a likelier source of a
// false green than of a catch, which is why it is not used here.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { __internal } = require('../src/auroraBff/routes');
const { makeRecommendProducts } = require('../src/agentSignals/recommendProducts');

const PROMPTS = path.join(__dirname, '..', 'prompts');
const readPrompt = (name) => fs.readFileSync(path.join(PROMPTS, name), 'utf8');

const BASE_CTX = {
  request_id: 'req_2155',
  trace_id: 'trace_2155',
  aurora_uid: 'agent:test',
  lang: 'EN',
  ui_lang: 'EN',
  trigger_source: 'text',
  state: null,
  backend_auth_headers: {},
};

async function runLane(extra) {
  return __internal.generateProductRecommendations({
    ctx: { ...BASE_CTX },
    profile: null,
    recentLogs: [],
    message: 'Recommend a bronzer for contouring my cheekbones, warm undertone.',
    focus: 'a bronzer for contouring my cheekbones, warm undertone',
    includeAlternatives: false,
    debug: true,
    logger: null,
    budgetMs: 4000,
    ...extra,
  });
}

test('the real lane loads the WIDE template only when the caller asks for the beauty scope', async () => {
  const wide = await runLane({ entryType: 'direct', recoTriggerSource: 'agent_tool', promptDomainScope: 'beauty' });
  assert.equal(wide.llmTrace.template_id, 'reco_main_v1_3');
  assert.equal(wide.llmTrace.prompt_domain_scope, 'beauty');
  assert.equal(wide.norm.payload.prompt_template_id, 'reco_main_v1_3');

  // The consumer direct lane (POST /v1/reco/generate) shares entryType 'direct' with the agent tool
  // and must NOT widen — this is the whole reason the scope is threaded instead of read off entryType.
  const consumerDirect = await runLane({ entryType: 'direct', recoTriggerSource: 'typed_reco' });
  assert.equal(consumerDirect.llmTrace.template_id, 'reco_main_v1_2');
  assert.equal(consumerDirect.llmTrace.prompt_domain_scope, 'skincare');

  const chat = await runLane({ entryType: 'chat' });
  assert.equal(chat.llmTrace.template_id, 'reco_main_v1_2');
  assert.equal(chat.llmTrace.prompt_domain_scope, 'skincare');
});

test('the agent bridge sets the beauty scope, and a calling agent cannot set it at all', async () => {
  const seen = [];
  const recommend = makeRecommendProducts({
    generate: async (args) => {
      seen.push(args);
      return { norm: { payload: { recommendations: [] } } };
    },
    isEnabled: () => true,
    logger: null,
    verifyPrice: null,
  });

  await recommend({ payload: { need: 'a bronzer for contouring my cheekbones' } }, { agent_id: 'a1' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].promptDomainScope, 'beauty');

  // It is a property of WHICH DOOR the caller came through, not a request field. A tool argument of
  // the same name must not reach the lane — otherwise any agent could pick its own prompt.
  await recommend(
    { payload: { need: 'a bronzer for contouring my cheekbones', promptDomainScope: 'anything-else' } },
    { agent_id: 'a1' },
  );
  assert.equal(seen.length, 2);
  assert.equal(seen[1].promptDomainScope, 'beauty');
});

test('only the exact token widens; every other value keeps the skincare template', () => {
  const wide = ['beauty', ' beauty ', 'BEAUTY', 'Beauty'];
  const narrow = ['', 'skincare', 'beauty!', 'beauty_wide', 'bea uty', null, undefined, 0, {}, ['beauty']];

  for (const scope of wide) {
    const spec = __internal.resolveRecoMainPromptSpec({ promptDomainScope: scope });
    assert.equal(spec.template_id, 'reco_main_v1_3', `expected wide for ${JSON.stringify(scope)}`);
    assert.equal(spec.domain_scope, 'beauty');
  }
  for (const scope of narrow) {
    const spec = __internal.resolveRecoMainPromptSpec({ promptDomainScope: scope });
    assert.equal(spec.template_id, 'reco_main_v1_2', `expected narrow for ${JSON.stringify(scope)}`);
    assert.equal(spec.domain_scope, 'skincare');
  }
  assert.equal(__internal.resolveRecoMainPromptSpec().template_id, 'reco_main_v1_2');
  assert.equal(__internal.resolveRecoMainPromptSpec({}).template_id, 'reco_main_v1_2');
});

test('ingredient mode keeps its own template and reports the narrow scope', () => {
  const spec = __internal.resolveRecoMainPromptSpec({
    promptDomainScope: 'beauty',
    ingredientContext: { query: 'niacinamide' },
  });
  assert.equal(spec.ingredient_mode, true);
  assert.equal(spec.template_id, 'reco_main_v1_2');
  assert.equal(spec.domain_scope, 'skincare');
});

test('the widened prompt reaches the wire: the query text and hard_rules actually change', () => {
  const args = {
    profile: {},
    requestText: 'a bronzer for contouring my cheekbones, warm undertone',
    lang: 'EN',
    globalStatus: {},
    candidates: [],
  };
  const wide = __internal.buildAuroraProductRecommendationsPromptBundle({ ...args, promptDomainScope: 'beauty' });
  const narrow = __internal.buildAuroraProductRecommendationsPromptBundle({ ...args });

  // The exported query builder returns the same string this bundle carries: assert once that the
  // two agree, so testing the bundle is testing what the lane actually sends.
  assert.equal(__internal.buildAuroraProductRecommendationsQuery({ ...args, promptDomainScope: 'beauty' }), wide.query);

  // The SYSTEM prompt is the thing that produced the bronzer -> serum answer. Assert the boundary is
  // gone from the wide query and still present in the narrow one, in the query STRING that is sent —
  // not merely in the file, and not merely in the template id.
  assert.match(wide.query, /Recommend skincare \(including body care\), makeup, fragrance, and haircare/);
  assert.match(wide.query, /Never substitute an adjacent category/);
  // TOOLS ARE STILL REFUSED, and the widened query must carry that. Measured on prod 2026-09-09,
  // `makeup brush` answers total 0 with final_decision 'clarify' and every search_quality tier count
  // zero; `gua sha facial tool` returns mis-filed rows inside a total of 0. Inviting the model into a
  // category with no serving lane swaps a wrong answer for an empty one, not for a right one.
  assert.match(wide.query, /Never recommend beauty tools, brushes, sponges, applicators, or devices/);
  assert.match(wide.query, /For a tool, brush or device request, return recommendations: \[\]/);
  assert.doesNotMatch(wide.query, /Recommend skincare only/);
  assert.doesNotMatch(wide.query, /Never recommend makeup, brushes, beauty tools/);
  assert.match(narrow.query, /Recommend skincare only/);
  assert.match(narrow.query, /Never recommend makeup, brushes, beauty tools/);

  // The task line is part of the same query and contradicted a widened system prompt.
  assert.match(wide.query, /Task: Generate a user-adaptive beauty recommendation plan/);
  assert.match(narrow.query, /Task: Generate a user-adaptive skincare recommendation plan/);

  // hard_rules survive the payload builder verbatim (only meta/profile/global_status/candidates are
  // overwritten), so a stale rule here would contradict the system prompt inside one request.
  const wideRules = wide.user_payload.hard_rules.join(' | ');
  const narrowRules = narrow.user_payload.hard_rules.join(' | ');
  assert.match(wideRules, /Recommend skincare \(including body care\), makeup, fragrance, and haircare only/);
  assert.match(wideRules, /a bronzer request is not answered with a serum/);
  assert.match(wideRules, /Never beauty tools, brushes, sponges, applicators or devices/);
  assert.doesNotMatch(wideRules, /non-skincare categories/);
  assert.match(narrowRules, /Do not recommend non-skincare categories/);
});

test('the v1_3 prompt widens the domain and pins category fidelity', () => {
  const text = readPrompt('reco_main_v1_3.system.txt');
  assert.match(text, /precision beauty recommendation planner/i);
  assert.match(text, /Recommend skincare \(including body care\), makeup, fragrance, and haircare\./i);
  // The widened set is exactly what was MEASURED servable on prod 2026-09-09 (skincare control;
  // makeup 19-70 per query at 90-100% in-category; fragrance 73; haircare 77 on a need-shaped query,
  // 20/20 USD and 20/20 in stock). Tools were measured UNSERVABLE and must stay out — a widening that
  // invites a category the catalog cannot answer is a new empty-shortlist defect, not a fix.
  assert.match(text, /Never recommend beauty tools, brushes, sponges, applicators, or devices/i);
  assert.match(text, /For a tool, brush or device request, return recommendations: \[\]/i);
  // Widening the DOMAIN alone would have removed the exclusion warning and kept the serum. The
  // defect in #2155 is a category substitution, so the replacement prompt must forbid it by name.
  assert.match(text, /CATEGORY FIDELITY/);
  assert.match(text, /If the request names a bronzer, do not return a serum/i);
  assert.match(text, /return recommendations: \[\] and say so in missing_info/i);
  // Still a BEAUTY lane, not an open one.
  assert.match(text, /Never recommend supplements, ingestibles, medication, or anything outside beauty/i);
  assert.doesNotMatch(text, /Recommend skincare only/);
});

test('the chat lane template is untouched — the whole reason v1_3 exists', () => {
  const text = readPrompt('reco_main_v1_2.system.txt');
  assert.match(text, /Recommend skincare only\./);
  assert.match(text, /Never recommend makeup, brushes, beauty tools, devices, fragrance, haircare, or supplements\./);
  const schema = JSON.parse(readPrompt('reco_main_v1_2.user_schema.json'));
  assert.ok(schema.hard_rules.includes('Do not recommend non-skincare categories.'));
});

// The in-code fallback schema and fallback system prompt are NOT dead code: they are what the lane
// sends when prompts/<template_id>.{system.txt,user_schema.json} cannot be read — a mis-set
// RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID, or an image that shipped without the prompts directory. Both
// carried a hardcoded "Recommend skincare only", which would have re-narrowed the wide door with
// nothing in the diff to show it. Driven here by pointing the wide template at a file that does not
// exist and reloading the module, since both the env var and the template cache are module-scoped.
test('an unreadable wide template still sends a WIDE fallback, not the skincare one', () => {
  const moduleId = require.resolve('../src/auroraBff/routes');
  const before = process.env.RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID;
  process.env.RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID = 'reco_main_no_such_template_v9';
  delete require.cache[moduleId];
  try {
    const reloaded = require('../src/auroraBff/routes').__internal;
    const args = { profile: {}, requestText: 'a bronzer', lang: 'EN', globalStatus: {}, candidates: [] };
    const wide = reloaded.buildAuroraProductRecommendationsPromptBundle({ ...args, promptDomainScope: 'beauty' });
    assert.equal(wide.prompt_spec.template_id, 'reco_main_no_such_template_v9');
    assert.match(wide.query, /precision beauty recommendation planner/i);
    assert.match(wide.query, /Recommend skincare \(including body care\), makeup, fragrance and haircare/i);
    assert.doesNotMatch(wide.query, /Recommend skincare only/);
    // The fallback must carry the tools refusal too, or an unreadable template turns a refused
    // category into an invited one.
    assert.match(wide.query, /Never beauty tools, brushes, sponges or devices/i);
    const rules = wide.user_payload.hard_rules.join(' | ');
    assert.match(rules, /Recommend skincare \(including body care\), makeup, fragrance and haircare only/);
    assert.match(rules, /a bronzer request is not answered with a serum/);
    assert.match(rules, /Never beauty tools, brushes, sponges, applicators or devices/);
    assert.doesNotMatch(rules, /Recommend skincare only/);

    // The NARROW fallback must stay narrow: this is the chat lane's behaviour when its own template
    // is unreadable, and widening it here would be the shared-prompt bug by another route.
    const narrowSpec = reloaded.resolveRecoMainPromptSpec({});
    assert.equal(narrowSpec.template_id, 'reco_main_v1_2');
  } finally {
    if (before === undefined) delete process.env.RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID;
    else process.env.RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID = before;
    delete require.cache[moduleId];
  }
});
