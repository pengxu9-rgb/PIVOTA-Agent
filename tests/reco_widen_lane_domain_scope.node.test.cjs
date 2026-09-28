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

// PIN THE CONFIGURATION THIS FILE DESCRIBES. The wide template id is read ONCE at module load, so
// a test asserting the DEFAULT-OFF contract against a module loaded under an ambient
// RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID is asserting something else entirely -- and prod exports exactly
// that variable. Six tests across two files failed under prod's own configuration for this reason,
// on main, while CI stayed green: CI ran the disarmed lane and prod runs the armed one. The tests
// that want the ARMED lane arm it explicitly (withWideTemplate below); this makes their disarmed
// counterparts mean what they say wherever they run.
delete process.env.RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID;
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { __internal } = require('../src/auroraBff/routes');
const { makeRecommendProducts } = require('../src/agentSignals/recommendProducts');

// The wide template id is read ONCE at module load, so arming it means reloading the module. The
// prompt-file cache is module-scoped too, which is what makes this honest rather than sticky.
function withRoutesEnv(env, fn) {
  const moduleId = require.resolve('../src/auroraBff/routes');
  const before = {};
  for (const [k, v] of Object.entries(env)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[moduleId];
  try {
    const out = fn(require('../src/auroraBff/routes').__internal);
    // SYNC ONLY, and said out loud rather than left as a trap. The finally below restores the env and
    // busts the cache immediately; an async fn's assertions would then run against a module reloaded
    // under the RESTORED env, and pass for the wrong reason with nothing visible to explain it.
    if (out && typeof out.then === 'function') {
      throw new Error('withRoutesEnv is synchronous: an async fn would assert against the restored env');
    }
    return out;
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[moduleId];
  }
}
const withWideTemplate = (templateId, fn) =>
  withRoutesEnv({ RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID: templateId }, fn);

// The async twin, for the tests that drive the real lane. Kept separate from the sync one rather
// than making that one polymorphic: the whole point of the guard there is that awaiting is not
// optional, and a single function silently doing both is how that guarantee gets lost.
async function withRoutesEnvAsync(env, fn) {
  const moduleId = require.resolve('../src/auroraBff/routes');
  const before = {};
  for (const [k, v] of Object.entries(env)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[moduleId];
  try {
    return await fn(require('../src/auroraBff/routes').__internal);
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[moduleId];
  }
}
const PROMPT_ARGS = {
  profile: {},
  requestText: 'a bronzer for contouring my cheekbones, warm undertone',
  lang: 'EN',
  globalStatus: {},
  candidates: [],
};

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

test('the real lane records the beauty ASK but, by default, still loads the narrow template', async () => {
  // The ask is threaded end to end (bridge -> engine -> mainline -> prompt builder) and shows up on
  // the trace; what it does NOT do, while v1_3 is unregistered upstream, is change the template.
  const wide = await runLane({ entryType: 'direct', recoTriggerSource: 'agent_tool', promptDomainScope: 'beauty' });
  assert.equal(wide.llmTrace.prompt_domain_scope, 'beauty', 'the ask must still reach the trace');
  assert.equal(wide.llmTrace.template_id, 'reco_main_v1_2', 'but the default must not arm v1_3');
  assert.equal(wide.llmTrace.wide_template_active, false);
  assert.equal(wide.norm.payload.prompt_template_id, 'reco_main_v1_2');

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
    assert.equal(spec.domain_scope, 'beauty', `expected the beauty ask for ${JSON.stringify(scope)}`);
    // The token still has to be recognised while the template is pinned, or arming the env var later
    // would arm nothing — the rot this test exists to catch.
    withWideTemplate('reco_main_v1_3', (armed) => {
      const s2 = armed.resolveRecoMainPromptSpec({ promptDomainScope: scope });
      assert.equal(s2.template_id, 'reco_main_v1_3', `expected wide for ${JSON.stringify(scope)} when armed`);
      assert.equal(s2.wide_template_active, true);
    });
  }
  for (const scope of narrow) {
    const spec = __internal.resolveRecoMainPromptSpec({ promptDomainScope: scope });
    assert.equal(spec.template_id, 'reco_main_v1_2', `expected narrow for ${JSON.stringify(scope)}`);
    assert.equal(spec.domain_scope, 'skincare');
    withWideTemplate('reco_main_v1_3', (armed) => {
      const s2 = armed.resolveRecoMainPromptSpec({ promptDomainScope: scope });
      assert.equal(s2.template_id, 'reco_main_v1_2', `must stay narrow for ${JSON.stringify(scope)} even when armed`);
      assert.equal(s2.wide_template_active, false);
    });
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
  withWideTemplate('reco_main_v1_3', (armed) => {
    const s2 = armed.resolveRecoMainPromptSpec({ promptDomainScope: 'beauty', ingredientContext: { query: 'niacinamide' } });
    assert.equal(s2.template_id, 'reco_main_v1_2', 'ingredient mode keeps its own template even when armed');
    assert.equal(s2.wide_template_active, false);
  });
});

test('by DEFAULT the beauty ask changes nothing on the wire — byte for byte', () => {
  // THE POINT OF THIS PR. v1_3 400s at the decision service, so the ask must be fully inert, not
  // half-applied: a "beauty recommendation plan" task line wrapped around v1_2's skincare-only
  // system prompt would be worse than either end state.
  const wide = __internal.buildAuroraProductRecommendationsPromptBundle({ ...PROMPT_ARGS, promptDomainScope: 'beauty' });
  const narrow = __internal.buildAuroraProductRecommendationsPromptBundle({ ...PROMPT_ARGS });
  assert.equal(wide.query, narrow.query, 'the beauty ask must not alter one byte of the query');
  assert.deepEqual(wide.user_payload.hard_rules, narrow.user_payload.hard_rules);
  assert.equal(wide.prompt_spec.template_id, 'reco_main_v1_2');
  assert.equal(wide.prompt_spec.wide_template_active, false);
  // The narrow boundary is what actually ships today, so say so rather than inferring it.
  assert.match(wide.query, /Recommend skincare only/);
  assert.match(wide.query, /Task: Generate a user-adaptive skincare recommendation plan/);
  assert.doesNotMatch(wide.query, /user-adaptive beauty recommendation plan/);
});

test('when ARMED, the widened prompt reaches the wire: query text and hard_rules change', () => {
  withWideTemplate('reco_main_v1_3', (armed) => {
    const wide = armed.buildAuroraProductRecommendationsPromptBundle({ ...PROMPT_ARGS, promptDomainScope: 'beauty' });
    const narrow = armed.buildAuroraProductRecommendationsPromptBundle({ ...PROMPT_ARGS });
    assert.equal(wide.prompt_spec.wide_template_active, true);
    assert.equal(armed.buildAuroraProductRecommendationsQuery({ ...PROMPT_ARGS, promptDomainScope: 'beauty' }), wide.query);

    assert.match(wide.query, /Recommend skincare \(including body care\), makeup, and fragrance\./);
    assert.match(wide.query, /Never substitute an adjacent category/);
    // Tools stay refused even armed: measured on prod 2026-09-09, `makeup brush` answers total 0 with
    // final_decision 'clarify' and every search_quality tier count zero.
    assert.match(wide.query, /Never recommend beauty tools, brushes, sponges, applicators, or devices/);
    assert.match(wide.query, /For a tool, brush or device request, return recommendations: \[\]/);
    assert.doesNotMatch(wide.query, /Recommend skincare only/);
    assert.match(wide.query, /Task: Generate a user-adaptive beauty recommendation plan/);

    // The chat lane's own template must stay narrow in the same process.
    assert.match(narrow.query, /Recommend skincare only/);
    assert.match(narrow.query, /Task: Generate a user-adaptive skincare recommendation plan/);

    const wideRules = wide.user_payload.hard_rules.join(' | ');
    assert.match(wideRules, /Recommend skincare \(including body care\), makeup and fragrance only/);
    assert.match(wideRules, /a bronzer request is not answered with a serum/);
    assert.match(wideRules, /Never beauty tools, brushes, sponges, applicators or devices/);
    assert.doesNotMatch(wideRules, /non-skincare categories/);
    assert.match(narrow.user_payload.hard_rules.join(' | '), /Do not recommend non-skincare categories/);
  });
});

test('the v1_3 prompt widens the domain and pins category fidelity', () => {
  const text = readPrompt('reco_main_v1_3.system.txt');
  assert.match(text, /precision beauty recommendation planner/i);
  assert.match(text, /Recommend skincare \(including body care\), makeup, and fragrance\./i);
  // HAIRCARE IS STAGED, not excluded on principle (#2163). It has the largest raw total measured (126)
  // and the worst currency profile: only 15/20 sampled rows are USD, and non-USD is unservable on the
  // USD-only US offer path, so effective coverage is far below the total and nothing in the total says
  // so. The reason lives in the prompt rather than only in a PR, so it cannot be dropped as arbitrary.
  assert.match(text, /Do not recommend haircare yet\./);
  assert.match(text, /not servable on the US offer path/);
  assert.match(text, /Haircare is staged behind that fix, not excluded on principle\./);
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
  withWideTemplate('reco_main_no_such_template_v9', (reloaded) => {
    const args = { profile: {}, requestText: 'a bronzer', lang: 'EN', globalStatus: {}, candidates: [] };
    const wide = reloaded.buildAuroraProductRecommendationsPromptBundle({ ...args, promptDomainScope: 'beauty' });
    assert.equal(wide.prompt_spec.template_id, 'reco_main_no_such_template_v9');
    assert.match(wide.query, /precision beauty recommendation planner/i);
    assert.match(wide.query, /Recommend skincare \(including body care\), makeup and fragrance only\./i);
    assert.doesNotMatch(wide.query, /Recommend skincare only/);
    // The fallback must carry the tools refusal too, or an unreadable template turns a refused
    // category into an invited one.
    assert.match(wide.query, /Never beauty tools, brushes, sponges or devices/i);
    const rules = wide.user_payload.hard_rules.join(' | ');
    assert.match(rules, /Recommend skincare \(including body care\), makeup and fragrance only/);
    // the fallback is a second copy of the domain rule — it has to carry the staging too, or a failed
    // template read quietly re-enables haircare
    assert.match(rules, /Haircare is staged and not covered yet/);
    assert.match(rules, /a bronzer request is not answered with a serum/);
    assert.match(rules, /Never beauty tools, brushes, sponges, applicators or devices/);
    assert.doesNotMatch(rules, /Recommend skincare only/);

    // The NARROW fallback must stay narrow: this is the chat lane's behaviour when its own template
    // is unreadable, and widening it here would be the shared-prompt bug by another route.
    const narrowSpec = reloaded.resolveRecoMainPromptSpec({});
    assert.equal(narrowSpec.template_id, 'reco_main_v1_2');
  });
});

test('the NARROW in-code fallback stays narrow when the CHAT template is the unreadable one', () => {
  // The previous version of this claim asserted only `template_id === 'reco_main_v1_2'` while that
  // file was perfectly readable — so the narrow fallback never executed and three mutations of its
  // text survived. Point the CHAT lane's own id at a missing file so the branch actually runs.
  withRoutesEnv({ RECO_MAIN_PROMPT_TEMPLATE_ID: 'reco_main_no_such_narrow_v9' }, (reloaded) => {
    const bundle = reloaded.buildAuroraProductRecommendationsPromptBundle({ ...PROMPT_ARGS });
    assert.equal(bundle.prompt_spec.template_id, 'reco_main_no_such_narrow_v9');
    assert.equal(bundle.prompt_spec.wide_template_active, false);
    assert.match(bundle.query, /You are a precision skincare recommendation planner/);
    assert.match(bundle.query, /Recommend skincare only\. Never recommend makeup, brushes, tools, devices, fragrance, or haircare\./);
    const rules = bundle.user_payload.hard_rules.join(' | ');
    assert.match(rules, /Recommend skincare only; never recommend makeup, tools, devices, fragrance, or haircare\./);
    assert.doesNotMatch(rules, /makeup, fragrance and haircare only/);
  });
});

test('the fallback SCHEMA follows the loaded template, not the ask — no cross-lane cache poisoning', () => {
  // loadRecoPromptTemplateFile caches by FILENAME while the fallback CONTENT is scope-dependent, so
  // if the fallback branch keyed off the ask instead of the template, whichever lane ran first would
  // poison the other through a shared cache entry. Both lanes name the same missing file here, so a
  // scope-keyed branch would hand the second caller the first caller's rules.
  withRoutesEnv({ RECO_MAIN_PROMPT_TEMPLATE_ID: 'reco_main_no_such_shared_v9' }, (reloaded) => {
    const wideFirst = reloaded.buildAuroraProductRecommendationsPromptBundle({ ...PROMPT_ARGS, promptDomainScope: 'beauty' });
    const narrowSecond = reloaded.buildAuroraProductRecommendationsPromptBundle({ ...PROMPT_ARGS });
    assert.equal(wideFirst.prompt_spec.template_id, narrowSecond.prompt_spec.template_id);
    assert.deepEqual(
      wideFirst.user_payload.hard_rules,
      narrowSecond.user_payload.hard_rules,
      'one template, one set of hard_rules — order of callers must not change them',
    );
    assert.match(narrowSecond.user_payload.hard_rules.join(' | '), /Recommend skincare only;/);
  });
});

test('repointing the CHAT template cannot half-arm this door', () => {
  // Regression: the wide id used to default to the literal 'reco_main_v1_2', so bumping the chat
  // lane's template left the two ids DIFFERENT and armed wide_template_active — a beauty task line
  // wrapped around a skincare-only system prompt, the exact state resolveRecoMainPromptSpec exists to
  // prevent. It now inherits RECO_MAIN_PROMPT_TEMPLATE_ID, so "off" holds by construction.
  for (const narrowId of ['reco_main_v1_0', 'reco_main_v1_1', 'reco_main_v1_2']) {
    withRoutesEnv({ RECO_MAIN_PROMPT_TEMPLATE_ID: narrowId }, (reloaded) => {
      const spec = reloaded.resolveRecoMainPromptSpec({ promptDomainScope: 'beauty' });
      assert.equal(spec.template_id, narrowId, `the door must follow the chat template (${narrowId})`);
      assert.equal(spec.wide_template_active, false, `bumping the chat template must not arm the door (${narrowId})`);
      const wide = reloaded.buildAuroraProductRecommendationsPromptBundle({ ...PROMPT_ARGS, promptDomainScope: 'beauty' });
      const narrow = reloaded.buildAuroraProductRecommendationsPromptBundle({ ...PROMPT_ARGS });
      assert.equal(wide.query, narrow.query, `the ask must stay inert at ${narrowId}`);
    });
  }
  // ...and arming still works on top of a bumped chat template.
  withRoutesEnv({ RECO_MAIN_PROMPT_TEMPLATE_ID: 'reco_main_v1_1', RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID: 'reco_main_v1_3' }, (reloaded) => {
    const spec = reloaded.resolveRecoMainPromptSpec({ promptDomainScope: 'beauty' });
    assert.equal(spec.template_id, 'reco_main_v1_3');
    assert.equal(spec.wide_template_active, true);
  });
});

test('the step-aware catalog-first branch forwards the ask too — the second prompt-state call site', async () => {
  // The other buildRecoLlmPromptState call site. Deleting `promptDomainScope` there left the whole
  // suite green, so the day the wide id is armed with this flag on, that sub-lane would silently keep
  // the narrow template while the rest of the door widened: a half-armed door, invisible to CI.
  await withRoutesEnvAsync({ AURORA_BFF_RECO_STEP_AWARE_CATALOG_FIRST_ENABLED: 'true' }, async (reloaded) => {
    const res = await reloaded.generateProductRecommendations({
      ctx: { ...BASE_CTX },
      profile: null,
      recentLogs: [],
      message: 'I need a moisturizer step for my routine',
      focus: 'I need a moisturizer step for my routine',
      includeAlternatives: false,
      debug: true,
      logger: null,
      budgetMs: 4000,
      entryType: 'direct',
      recoTriggerSource: 'agent_tool',
      promptDomainScope: 'beauty',
    });
    assert.equal(res.llmTrace.prompt_domain_scope, 'beauty',
      'the step-aware branch must carry the ask as far as the default path does');
    // Still inert while v1_3 is unregistered upstream — the ask travels, the template does not change.
    assert.equal(res.llmTrace.template_id, 'reco_main_v1_2');
    assert.equal(res.llmTrace.wide_template_active, false);
  });
});
