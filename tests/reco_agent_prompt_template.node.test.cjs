// The agent lane's prompt template (#2155).
//
// `reco_main_v1_2` is the SHARED reco prompt: routes.js and legacyRecoMainlineExecution.js both default
// to it, and it drives the Aurora consumer chat and POST /v1/reco/generate as well as this tool. Widening
// its DOMAIN BOUNDARY in place would have changed a consumer surface with its own quality bar. So the
// widening lives in a separate template selected by trigger source, and these pins exist because the
// failure mode is SILENT: a wrong selector, an unread file, or the fallback prompt left un-widened all
// produce a working lane that quietly answers a makeup need with skincare — the exact defect #2155 opened on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROMPTS = path.join(__dirname, '..', 'prompts');
const ROUTES = fs.readFileSync(path.join(__dirname, '..', 'src', 'auroraBff', 'routes.js'), 'utf8');
const EXEC = fs.readFileSync(path.join(__dirname, '..', 'src', 'auroraBff', 'legacyRecoMainlineExecution.js'), 'utf8');

const v12 = fs.readFileSync(path.join(PROMPTS, 'reco_main_v1_2.system.txt'), 'utf8');
const v13 = fs.readFileSync(path.join(PROMPTS, 'reco_main_v1_3.system.txt'), 'utf8');

test('1. the widened template exists, carries the schema the projector reads, and widens ONLY the domain', () => {
  // The schema names every field recommendationItemToSignal reads. A drifted copy would silently empty
  // the projection — the #2149-era failure where the bridge read fields the lane never emitted.
  const s12 = fs.readFileSync(path.join(PROMPTS, 'reco_main_v1_2.user_schema.json'));
  const s13 = fs.readFileSync(path.join(PROMPTS, 'reco_main_v1_3.user_schema.json'));
  assert.ok(s13.equals(s12), 'v1_3 must start as a byte-copy of v1_2 schema — the output contract is unchanged');

  assert.match(v13, /Recommend skincare, makeup, fragrance and haircare\./);
  assert.match(v13, /Never recommend brushes, applicators, beauty tools, devices, or supplements/);
  // Measured 2026-09-09: tool queries resolve no category and return nothing purchasable (total 0,
  // decision "clarify", 0/20 in stock), so a tool pick can only be an invention.
  assert.doesNotMatch(v13, /Recommend skincare only/);

  // and the SHARED template is untouched — consumer chat must not move
  assert.match(v12, /Recommend skincare only\./);
  assert.match(v12, /Never recommend makeup, brushes, beauty tools, devices, fragrance, haircare, or supplements\./);

  // the rest of the prompt is the same task: same output caps, same data rules
  for (const rule of ['recommendations max 5', 'Never invent product_id', 'query_terms max 4 per item'])
    assert.ok(v13.includes(rule) && v12.includes(rule), `both templates keep: ${rule}`);
});

test('2. only an agent-tool call gets the widened template', () => {
  assert.match(ROUTES, /const RECO_AGENT_PROMPT_TEMPLATE_ID = String\(\s*process\.env\.RECO_AGENT_PROMPT_TEMPLATE_ID \|\| 'reco_main_v1_3'/,
    'env-overridable, so the widening is revertible without a deploy (this repo ships by hand)');
  assert.match(ROUTES, /triggerSource === 'agent_tool' \? RECO_AGENT_PROMPT_TEMPLATE_ID : RECO_MAIN_PROMPT_TEMPLATE_ID/,
    'selection is on trigger source, and defaults to the shared template for every other caller');

  // the selector, isolated — the branch table this rests on
  const pick = (ingredientMode, triggerSource) => ingredientMode
    ? 'reco_main_v1_2'
    : (triggerSource === 'agent_tool' ? 'reco_main_v1_3' : 'reco_main_v1_2');
  assert.equal(pick(false, 'agent_tool'), 'reco_main_v1_3');
  for (const t of ['chat', 'travel_handoff', '', null, undefined, 'AGENT_TOOL'])
    assert.equal(pick(false, t), 'reco_main_v1_2', `trigger ${JSON.stringify(t)} must keep the shared template`);
  assert.equal(pick(true, 'agent_tool'), 'reco_main_v1_2', 'ingredient mode is a different task and is unchanged');
});

test('3. trigger source actually reaches the selector — all four hops', () => {
  // A break anywhere in this chain silently reverts the widening, because the default is the shared
  // template. Each hop is pinned by shape rather than by line number.
  assert.match(EXEC, /triggerSource: ctx && ctx\.trigger_source/, 'hop 1: execution -> buildRecoLlmPromptState');
  assert.equal((EXEC.match(/triggerSource: ctx && ctx\.trigger_source/g) || []).length, 2,
    'BOTH execution call sites pass it — one un-wired site is a silent half-revert');
  assert.match(ROUTES, /function buildRecoLlmPromptState\(\{[\s\S]{0,600}?triggerSource = null,/, 'hop 2 accepts it');
  assert.match(ROUTES, /function buildAuroraProductRecommendationsPromptBundle\(\{[^)]*triggerSource = null \} = \{\}\)/, 'hop 3 accepts it');
  assert.match(ROUTES, /function resolveRecoMainPromptSpec\(\{ ingredientContext, triggerSource = null \} = \{\}\)/, 'hop 4 accepts it');
  assert.match(ROUTES, /resolveRecoMainPromptSpec\(\{ ingredientContext, triggerSource \}\)/, 'hop 3 forwards to hop 4');
});

test('4. the INLINE FALLBACK prompt widens too — the copy that is not the template file', () => {
  // routes.js carries a second copy of the domain rule, used when the template file cannot be read.
  // Left un-widened it would answer a makeup need with skincare exactly when the template is missing —
  // the failure that is hardest to notice, since everything else still works.
  const fallback = ROUTES.slice(ROUTES.indexOf('const fallbackSystemPrompt'), ROUTES.indexOf('const fallbackSystemPrompt') + 1400);
  assert.match(fallback, /Recommend skincare, makeup, fragrance and haircare\./,
    'the fallback must widen for the agent lane');
  assert.match(fallback, /Recommend skincare only\. Never recommend makeup/,
    'and must still be skincare-only for every other caller');
  assert.equal((fallback.match(/triggerSource === 'agent_tool'/g) || []).length, 2,
    'both the planner line and the domain line branch');
});
