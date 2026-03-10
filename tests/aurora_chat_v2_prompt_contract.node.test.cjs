const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LlmGateway = require('../src/auroraBff/services/llm_gateway');
const { AURORA_SYSTEM_PROMPT, FREEFORM_PROMPT_VERSION } = require('../src/auroraBff/services/llm_gateway');

function readPromptManifest() {
  const filePath = path.join(__dirname, '..', 'src', 'auroraBff', 'prompts', 'prompt_manifest.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('product_analyze prompt version is aligned between runtime registry and manifest', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const runtimeTemplate = gateway._promptRegistry.get('product_analyze');
  const manifestTemplate = readPromptManifest().templates.find((entry) => entry.template_id === 'product_analyze');

  assert.equal(runtimeTemplate?.version, '1.2.0');
  assert.equal(manifestTemplate?.version, '1.2.0');
});

test('diagnosis_v2_start_personalized prompt version is aligned between runtime registry and manifest', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const runtimeTemplate = gateway._promptRegistry.get('diagnosis_v2_start_personalized');
  const manifestTemplate = readPromptManifest().templates.find((entry) => entry.template_id === 'diagnosis_v2_start_personalized');

  assert.equal(runtimeTemplate?.version, '1.2.0');
  assert.equal(manifestTemplate?.version, '1.2.0');
});

test('diagnosis_v2_answer_blueprint prompt version is aligned between runtime registry and manifest', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const runtimeTemplate = gateway._promptRegistry.get('diagnosis_v2_answer_blueprint');
  const manifestTemplate = readPromptManifest().templates.find((entry) => entry.template_id === 'diagnosis_v2_answer_blueprint');

  assert.equal(runtimeTemplate?.version, '1.2.0');
  assert.equal(manifestTemplate?.version, '1.2.0');
});

test('routine_audit_optimize prompt version is aligned between runtime registry and manifest', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const runtimeTemplate = gateway._promptRegistry.get('routine_audit_optimize');
  const manifestTemplate = readPromptManifest().templates.find((entry) => entry.template_id === 'routine_audit_optimize');

  assert.equal(runtimeTemplate?.version, '1.2.0');
  assert.equal(manifestTemplate?.version, '1.2.0');
});

test('routine_categorize_products prompt version is aligned between runtime registry and manifest', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const runtimeTemplate = gateway._promptRegistry.get('routine_categorize_products');
  const manifestTemplate = readPromptManifest().templates.find((entry) => entry.template_id === 'routine_categorize_products');

  assert.equal(runtimeTemplate?.version, '1.2.0');
  assert.equal(manifestTemplate?.version, '1.2.0');
});

test('tracker_checkin_insights prompt version is aligned between runtime registry and manifest', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const runtimeTemplate = gateway._promptRegistry.get('tracker_checkin_insights');
  const manifestTemplate = readPromptManifest().templates.find((entry) => entry.template_id === 'tracker_checkin_insights');

  assert.equal(runtimeTemplate?.version, '1.2.0');
  assert.equal(manifestTemplate?.version, '1.2.0');
});

test('intent_classifier prompt version is aligned between runtime registry and manifest', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const runtimeTemplate = gateway._promptRegistry.get('intent_classifier');
  const manifestTemplate = readPromptManifest().templates.find((entry) => entry.template_id === 'intent_classifier');

  assert.equal(runtimeTemplate?.version, '1.3.0');
  assert.equal(manifestTemplate?.version, '1.3.0');
});

test('ingredient_query_answer prompt version is aligned between runtime registry and manifest', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const runtimeTemplate = gateway._promptRegistry.get('ingredient_query_answer');
  const manifestTemplate = readPromptManifest().templates.find((entry) => entry.template_id === 'ingredient_query_answer');

  assert.equal(runtimeTemplate?.version, '1.2.0');
  assert.equal(manifestTemplate?.version, '1.2.0');
});

test('reco_step_based prompt version is aligned between runtime registry and manifest', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const runtimeTemplate = gateway._promptRegistry.get('reco_step_based');
  const manifestTemplate = readPromptManifest().templates.find((entry) => entry.template_id === 'reco_step_based');

  assert.equal(runtimeTemplate?.version, '1.2.0');
  assert.equal(manifestTemplate?.version, '1.2.0');
});

test('dupe prompts are aligned between runtime registry and manifest', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const manifest = readPromptManifest();
  const suggestRuntime = gateway._promptRegistry.get('dupe_suggest');
  const compareRuntime = gateway._promptRegistry.get('dupe_compare');
  const suggestManifest = manifest.templates.find((entry) => entry.template_id === 'dupe_suggest');
  const compareManifest = manifest.templates.find((entry) => entry.template_id === 'dupe_compare');

  assert.equal(suggestRuntime?.version, '2.1.0');
  assert.equal(suggestManifest?.version, '2.1.0');
  assert.equal(compareRuntime?.version, '1.2.0');
  assert.equal(compareManifest?.version, '1.2.0');
});

test('travel_apply_mode and ingredient_report prompt versions are aligned between runtime registry and manifest', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const manifest = readPromptManifest();
  const travelRuntime = gateway._promptRegistry.get('travel_apply_mode');
  const ingredientRuntime = gateway._promptRegistry.get('ingredient_report');
  const travelManifest = manifest.templates.find((entry) => entry.template_id === 'travel_apply_mode');
  const ingredientManifest = manifest.templates.find((entry) => entry.template_id === 'ingredient_report');

  assert.equal(travelRuntime?.version, '1.2.0');
  assert.equal(travelManifest?.version, '1.2.0');
  assert.equal(ingredientRuntime?.version, '2.2.0');
  assert.equal(ingredientManifest?.version, '2.2.0');
});

test('chat.freeform system prompt version and contract are explicit', () => {
  const text = String(AURORA_SYSTEM_PROMPT || '');

  assert.equal(FREEFORM_PROMPT_VERSION, 'inline_system_prompt_v2');
  assert.match(text, /\[ROLE\]/i);
  assert.match(text, /Respond in plain natural language that can be streamed to the user as-is/i);
  assert.match(text, /Do not output JSON, markdown code fences/i);
  assert.match(text, /Answer the user’s actual question first/i);
  assert.match(text, /Retinoid rule: treat retinoids as PM-first/i);
  assert.match(text, /SPF rule: treat sunscreen as an AM-only step with reapply guidance/i);
  assert.match(text, /If the information is insufficient for a confident recommendation, say what is uncertain/i);
  assert.match(text, /No chain-of-thought, internal reasoning traces/i);
});

test('diagnosis_v2_answer_blueprint prompt encodes no-photo and conservative blueprint rules', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const template = gateway._promptRegistry.get('diagnosis_v2_answer_blueprint');
  const text = String(template?.text || '');

  assert.match(text, /single valid JSON object only/i);
  assert.match(text, /"blueprint_id": string/i);
  assert.match(text, /"visual_observations": \[\{"area": string, "note_en": string, "note_zh": string\|null\}\]\|null/i);
  assert.match(text, /No-photo rule/i);
  assert.match(text, /visual_observations MUST be null or \[\]/i);
  assert.match(text, /use "unknown" instead of guessing/i);
  assert.match(text, /Do NOT use disease diagnosis language/i);
  assert.match(text, /goals=\{\{goals\}\}/i);
  assert.match(text, /has_photo=\{\{has_photo\}\}/i);
});

test('diagnosis_v2_start_personalized prompt encodes concise intake question rules', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const template = gateway._promptRegistry.get('diagnosis_v2_start_personalized');
  const text = String(template?.text || '');

  assert.match(text, /single valid JSON object only/i);
  assert.match(text, /"follow_up_questions": \[/i);
  assert.match(text, /"question_en": string/i);
  assert.match(text, /Relevance rule/i);
  assert.match(text, /do not restate information the user has already effectively provided/i);
  assert.match(text, /do not ask open-ended essay questions/i);
  assert.match(text, /return follow_up_questions=\[\]/i);
  assert.match(text, /skin_type=\{\{skin_type\}\}/i);
  assert.match(text, /concerns=\{\{concerns\}\}/i);
});

test('routine_audit_optimize prompt encodes safety-first routine optimization rules', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const template = gateway._promptRegistry.get('routine_audit_optimize');
  const text = String(template?.text || '');

  assert.match(text, /single valid JSON object only/i);
  assert.match(text, /"optimized_am_steps": \[/i);
  assert.match(text, /"compatibility_issues": \[\{"concepts": string\[\], "risk": string, "note_en": string, "note_zh": string\|null\}\]/i);
  assert.match(text, /Deterministic-audit rule/i);
  assert.match(text, /do not leave retinoids in the AM routine/i);
  assert.match(text, /do not leave sunscreen in the PM routine/i);
  assert.match(text, /do not add fabricated products/i);
  assert.match(text, /audit_results=\{\{audit_results\}\}/i);
});

test('routine_categorize_products prompt encodes conservative classification rules', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const template = gateway._promptRegistry.get('routine_categorize_products');
  const text = String(template?.text || '');

  assert.match(text, /single valid JSON object only/i);
  assert.match(text, /"categorized_products": \[/i);
  assert.match(text, /"step_assignment": string/i);
  assert.match(text, /"unresolved": \[/i);
  assert.match(text, /Conservative-classification rule/i);
  assert.match(text, /put the item in unresolved instead of forcing a step/i);
  assert.match(text, /Sunscreen rule/i);
  assert.match(text, /assign step_assignment="sunscreen", time_of_day="am"/i);
  assert.match(text, /do not recommend new products, optimize the routine, or make efficacy promises/i);
  assert.match(text, /products=\{\{products\}\}/i);
  assert.match(text, /routine=\{\{routine\}\}/i);
});

test('tracker_checkin_insights prompt encodes no-photo and conservative attribution rules', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const template = gateway._promptRegistry.get('tracker_checkin_insights');
  const text = String(template?.text || '');

  assert.match(text, /single valid JSON object only/i);
  assert.match(text, /"trend_summary": \{"en": string, "zh": string\|null\}/i);
  assert.match(text, /"suggested_action": string/i);
  assert.match(text, /No-photo rule/i);
  assert.match(text, /do not describe visible changes/i);
  assert.match(text, /suggested_action must be one of/i);
  assert.match(text, /checkin_logs=\{\{checkin_logs\}\}/i);
  assert.match(text, /has_photo=\{\{has_photo\}\}/i);
});

test('intent_classifier prompt encodes conservative routing and explicit label rules', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const template = gateway._promptRegistry.get('intent_classifier');
  const text = String(template?.text || '');

  assert.match(text, /single valid JSON object only/i);
  assert.match(text, /"intent": string/i);
  assert.match(text, /"confidence": number/i);
  assert.match(text, /"target_step": string\|null/i);
  assert.match(text, /Use exactly one of these labels/i);
  assert.match(text, /general_chat/i);
  assert.match(text, /ingredient_query/i);
  assert.match(text, /Conservative-routing rule/i);
  assert.match(text, /Step-entity rule/i);
  assert.match(text, /keep confidence below 0\.5/i);
  assert.match(text, /do not invent entities/i);
  assert.match(text, /user_message=\{\{user_message\}\}/i);
});

test('intent_classifier stub extracts target_step for explicit product-type asks', async () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const result = await gateway.call({
    templateId: 'intent_classifier',
    taskMode: 'chat',
    params: { user_message: 'Recommend a facial mask that suits me.' },
    schema: 'IntentClassifierOutput',
  });

  assert.equal(result.parsed?.intent, 'recommend_products');
  assert.equal(result.parsed?.entities?.target_step, 'mask');
});

test('ingredient_query_answer prompt encodes answer-first and ingredient-education rules', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const template = gateway._promptRegistry.get('ingredient_query_answer');
  const text = String(template?.text || '');

  assert.match(text, /single valid JSON object only/i);
  assert.match(text, /"answer_en": string/i);
  assert.match(text, /"ingredients_mentioned": \[/i);
  assert.match(text, /Answer-first rule/i);
  assert.match(text, /do not turn the answer into product recommendations/i);
  assert.match(text, /ingredients_mentioned must contain at most 3/i);
  assert.match(text, /user_question=\{\{user_question\}\}/i);
});

test('reco_step_based prompt encodes grounded recommendation and empty-state rules', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const template = gateway._promptRegistry.get('reco_step_based');
  const text = String(template?.text || '');

  assert.match(text, /single valid JSON object only/i);
  assert.match(text, /"step_recommendations": \[/i);
  assert.match(text, /"step_name": \{"en": string, "zh": string\|null\}/i);
  assert.match(text, /"why": \{"en": string, "zh": string\|null\}/i);
  assert.match(text, /Grounding rule/i);
  assert.match(text, /Do not invent catalog products, brands, or IDs/i);
  assert.match(text, /Empty-result rule/i);
  assert.match(text, /return "step_recommendations": \[\]/i);
  assert.match(text, /Target fidelity rule/i);
  assert.match(text, /Avoid recommending strong or blocked actives/i);
  assert.match(text, /inventory=\{\{inventory\}\}/i);
  assert.match(text, /target_ingredient=\{\{target_ingredient\}\}/i);
  assert.match(text, /safety_flags=\{\{safety_flags\}\}/i);
});

test('dupe_suggest prompt encodes candidate-pool-only and tradeoff rules', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const template = gateway._promptRegistry.get('dupe_suggest');
  const text = String(template?.text || '');

  assert.match(text, /single valid JSON object only/i);
  assert.match(text, /"anchor_summary": \{/i);
  assert.match(text, /"candidates": \[/i);
  assert.match(text, /Candidate-pool-only rule/i);
  assert.match(text, /never invent or introduce a product that is not in candidates/i);
  assert.match(text, /Self-reference prohibition/i);
  assert.match(text, /same canonical product reference/i);
  assert.match(text, /why_not_the_same_product/i);
  assert.match(text, /"bucket": string/i);
  assert.match(text, /"tradeoff": string/i);
  assert.match(text, /anchor_identity=\{\{anchor_identity\}\}/i);
  assert.match(text, /anchor_fingerprint=\{\{anchor_fingerprint\}\}/i);
  assert.match(text, /candidates=\{\{candidates\}\}/i);
});

test('dupe_compare prompt encodes grounded comparison and uncertainty rules', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const template = gateway._promptRegistry.get('dupe_compare');
  const text = String(template?.text || '');

  assert.match(text, /single valid JSON object only/i);
  assert.match(text, /"comparisons": \[/i);
  assert.match(text, /"key_ingredients_match": number/i);
  assert.match(text, /Grounding rule/i);
  assert.match(text, /compare only the supplied anchor and targets/i);
  assert.match(text, /Completeness rule/i);
  assert.match(text, /every comparison must include key_ingredients_match/i);
  assert.match(text, /price_comparison should be one of cheaper, same, more_expensive, unknown/i);
  assert.match(text, /targets=\{\{targets\}\}/i);
});

test('product_analyze prompt encodes the structured contract and hard rules', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const template = gateway._promptRegistry.get('product_analyze');
  const text = String(template?.text || '');

  assert.match(text, /single valid JSON object only/i);
  assert.match(text, /Do not add extra top-level keys/i);
  assert.match(text, /"product_name": string/i);
  assert.match(text, /"risk_flags": \[/i);
  assert.match(text, /SPF \/ sunscreen rule/i);
  assert.match(text, /usage\.time_of_day MUST be "am"/i);
  assert.match(text, /usage\.reapply MUST be present/i);
  assert.match(text, /If a field is unknown, use null, \[\] or \{\} instead of omitting it/i);
  assert.match(text, /Do not hallucinate product composition/i);
  assert.match(text, /Do not guess unprovided actives, allergens, or concentration/i);
  assert.match(text, /ingredient_list=\{\{ingredient_list\}\}/i);
});

test('travel_apply_mode prompt encodes reduce_irritation and high-UV hard rules', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const template = gateway._promptRegistry.get('travel_apply_mode');
  const text = String(template?.text || '');

  assert.match(text, /single valid JSON object only/i);
  assert.match(text, /"reduce_irritation": boolean/i);
  assert.match(text, /High-UV rule/i);
  assert.match(text, /set reduce_irritation=true/i);
  assert.match(text, /Do not omit reduce_irritation/i);
  assert.match(text, /current_routine=\{\{current_routine\}\}/i);
});

test('ingredient_report prompt encodes cautious claims requirements for unverified ingredients', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const template = gateway._promptRegistry.get('ingredient_report');
  const text = String(template?.text || '');

  assert.match(text, /single valid JSON object only/i);
  assert.match(text, /"claims": \[\{"text_en": string, "text_zh": string\|null, "evidence_badge": string\}\]/i);
  assert.match(text, /Every claims item MUST include/i);
  assert.match(text, /do not mention "products containing"/i);
  assert.match(text, /do not invent product examples/i);
  assert.match(text, /ontology_match=\{\{ontology_match\}\}/i);
});

test('tracker_checkin_insights prompt uses has_photo (not has_photos) and interpolation leaves no raw placeholder', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const template = gateway._promptRegistry.get('tracker_checkin_insights');
  const text = String(template?.text || '');

  assert.match(text, /has_photo=\{\{has_photo\}\}/);
  assert.doesNotMatch(text, /has_photos/);

  const interpolated = gateway._interpolate(text, {
    checkin_logs: [],
    profile: {},
    routine: {},
    has_photo: false,
    locale: 'en',
  });
  assert.doesNotMatch(interpolated, /\{\{has_photo\}\}/);
  assert.match(interpolated, /has_photo=false/);
});

test('tracker_checkin_insights stub with escalate action produces safety_escalation section and no photo/checkin nudges', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const original = gateway._buildStubCheckinInsights;
  gateway._buildStubCheckinInsights = () => ({
    trend_summary: { en: 'Worsening irritation detected.', zh: null },
    sensation_trend: 'worsening',
    days_tracked: 5,
    attribution: null,
    suggested_action: 'escalate',
    detailed_review: null,
  });

  const TrackerCheckinInsightsSkill = require('../src/auroraBff/skills/tracker_checkin_insights');
  const skill = new TrackerCheckinInsightsSkill();
  const request = {
    context: {
      recent_logs: [
        { has_photo: false },
        { has_photo: false },
        { has_photo: false },
      ],
      profile: {},
      current_routine: {},
      locale: 'en',
    },
    params: {},
  };

  return skill.execute(request, gateway).then((result) => {
    gateway._buildStubCheckinInsights = original;

    const sectionTypes = result.cards.flatMap((c) => (c.sections || []).map((s) => s.type));
    assert.equal(sectionTypes.includes('safety_escalation'), true, 'must include safety_escalation section');

    const actionTypes = result.next_actions.map((a) => a.action_type);
    assert.equal(actionTypes.includes('trigger_photo'), false, 'must not include trigger_photo on escalate');

    const targetSkills = result.next_actions
      .filter((a) => a.target_skill_id)
      .map((a) => a.target_skill_id);
    assert.equal(targetSkills.includes('tracker.checkin_log'), false, 'must not include checkin_log on escalate');
  });
});

test('product_analyze deterministic SPF override emits canonical am token', () => {
  const ProductAnalyzeSkill = require('../src/auroraBff/skills/product_analyze');
  const skill = new ProductAnalyzeSkill();
  const analysis = {
    product_type: 'sunscreen',
    has_spf: true,
    key_ingredients: [],
    usage: { time_of_day: 'both', frequency: 'daily' },
  };
  const fixes = skill._applyDeterministicRules(analysis, [], { product_anchor: {} });
  assert.equal(fixes.usage.time_of_day, 'am');
});

test('product_analyze deterministic retinoid override emits canonical pm token', () => {
  const ProductAnalyzeSkill = require('../src/auroraBff/skills/product_analyze');
  const skill = new ProductAnalyzeSkill();
  const analysis = {
    product_type: 'serum',
    has_spf: false,
    key_ingredients: [{ name: 'Retinol', concept: 'RETINOID', role: 'active', strength: 'medium' }],
    usage: { time_of_day: 'both', frequency: 'daily' },
  };
  const fixes = skill._applyDeterministicRules(analysis, [], { product_anchor: {} });
  assert.equal(fixes.usage.time_of_day, 'pm');
});

test('validator rejects malformed RoutineAuditOutput with non-object array items', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const malformed = JSON.stringify({
    optimized_am_steps: [42],
    optimized_pm_steps: [],
    changes: [],
    compatibility_issues: [],
  });
  const result = gateway._validateAndParse(malformed, 'RoutineAuditOutput');
  assert.equal(result, null, 'non-object items in optimized_am_steps should be rejected');
});

test('validator accepts well-formed RoutineAuditOutput with step container shape', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const valid = JSON.stringify({
    optimized_am_steps: [
      {
        step_id: 'cleanser',
        products: [{ product_id: 'p1', name: 'Gentle Cleanser', brand: null, concepts: [], time_of_day: 'am' }],
      },
      {
        step_id: 'sunscreen',
        products: [{ product_id: 'p2', name: 'SPF 50', brand: 'TestBrand', concepts: ['SUNSCREEN'], time_of_day: 'am' }],
      },
    ],
    optimized_pm_steps: [
      {
        step_id: 'treatment',
        products: [{ product_id: 'p3', name: 'Retinol Serum', brand: null, concepts: ['RETINOID'], time_of_day: 'pm' }],
      },
    ],
    changes: [{ code: 'move_retinoid', action: 'move', reason_en: 'Moved retinoid to PM', reason_zh: null }],
    compatibility_issues: [],
  });
  const result = gateway._validateAndParse(valid, 'RoutineAuditOutput');
  assert.notEqual(result, null, 'step container shape should be accepted');
  assert.equal(result.optimized_am_steps.length, 2);
  assert.equal(result.optimized_am_steps[0].step_id, 'cleanser');
});

test('validator rejects RoutineAuditOutput step missing step_id', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const malformed = JSON.stringify({
    optimized_am_steps: [{ products: [] }],
    optimized_pm_steps: [],
    changes: [],
    compatibility_issues: [],
  });
  const result = gateway._validateAndParse(malformed, 'RoutineAuditOutput');
  assert.equal(result, null, 'step without step_id should be rejected');
});

test('validator rejects RoutineAuditOutput with non-object product entries', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const malformed = JSON.stringify({
    optimized_am_steps: [{ step_id: 'cleanser', products: ['not-an-object'] }],
    optimized_pm_steps: [],
    changes: [],
    compatibility_issues: [],
  });
  const result = gateway._validateAndParse(malformed, 'RoutineAuditOutput');
  assert.equal(result, null, 'string items in products array should be rejected');
});

test('validator rejects RoutineAuditOutput product with wrong scalar types', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const malformed = JSON.stringify({
    optimized_am_steps: [{
      step_id: 'cleanser',
      products: [{ product_id: 123, name: null }],
    }],
    optimized_pm_steps: [],
    changes: [],
    compatibility_issues: [],
  });
  const result = gateway._validateAndParse(malformed, 'RoutineAuditOutput');
  assert.equal(result, null, 'product with name: null (required string) should be rejected');
});

test('validator rejects DupeCompareOutput missing required comparison fields', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const malformed = JSON.stringify({
    anchor_summary: { name: 'Test', brand: null, key_ingredients: [] },
    comparisons: [
      {
        target: { name: 'Target 1' },
        key_ingredients_match: 0.8,
        price_comparison: 'same',
        verdict_en: 'Similar.',
      },
    ],
    mode: 'full',
  });
  const result = gateway._validateAndParse(malformed, 'DupeCompareOutput');
  assert.equal(result, null, 'comparison missing texture_comparison/suitability_comparison/similarity_rationale should be rejected');
});

test('validator rejects IntentClassifierOutput with invalid intent label', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const malformed = JSON.stringify({
    intent: 'fake_intent',
    confidence: 0.9,
    entities: { ingredients: [], products: [], concerns: [], user_question: 'test' },
  });
  const result = gateway._validateAndParse(malformed, 'IntentClassifierOutput');
  assert.equal(result, null, 'invalid intent label should be rejected');
});

test('validator rejects IngredientQueryOutput with overlong ingredients_mentioned', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const items = Array.from({ length: 5 }, (_, i) => ({
    name: `Ingredient ${i}`,
    inci: null,
    relevance: null,
    pros_en: [],
    pros_zh: [],
    cons_en: [],
    cons_zh: [],
    evidence_level: null,
    best_for: [],
  }));
  const malformed = JSON.stringify({
    answer_en: 'test',
    answer_zh: null,
    ingredients_mentioned: items,
    safety_notes: [],
    followup_suggestions: [],
  });
  const result = gateway._validateAndParse(malformed, 'IngredientQueryOutput');
  assert.equal(result, null, 'ingredients_mentioned with 5 items should be rejected (max 3)');
});

test('validator accepts well-formed CheckinInsightsOutput with escalate action', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const valid = JSON.stringify({
    trend_summary: { en: 'Worsening', zh: null },
    sensation_trend: 'worsening',
    days_tracked: 5,
    attribution: null,
    suggested_action: 'escalate',
    detailed_review: null,
  });
  const result = gateway._validateAndParse(valid, 'CheckinInsightsOutput');
  assert.notEqual(result, null, 'escalate should be a valid suggested_action');
  assert.equal(result.suggested_action, 'escalate');
});
