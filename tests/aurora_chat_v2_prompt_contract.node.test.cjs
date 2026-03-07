const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LlmGateway = require('../src/auroraBff/services/llm_gateway');

function readPromptManifest() {
  const filePath = path.join(__dirname, '..', 'src', 'auroraBff', 'prompts', 'prompt_manifest.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('product_analyze prompt version is aligned between runtime registry and manifest', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const runtimeTemplate = gateway._promptRegistry.get('product_analyze');
  const manifestTemplate = readPromptManifest().templates.find((entry) => entry.template_id === 'product_analyze');

  assert.equal(runtimeTemplate?.version, '1.1.0');
  assert.equal(manifestTemplate?.version, '1.1.0');
});

test('travel_apply_mode and ingredient_report prompt versions are aligned between runtime registry and manifest', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const manifest = readPromptManifest();
  const travelRuntime = gateway._promptRegistry.get('travel_apply_mode');
  const ingredientRuntime = gateway._promptRegistry.get('ingredient_report');
  const travelManifest = manifest.templates.find((entry) => entry.template_id === 'travel_apply_mode');
  const ingredientManifest = manifest.templates.find((entry) => entry.template_id === 'ingredient_report');

  assert.equal(travelRuntime?.version, '1.1.0');
  assert.equal(travelManifest?.version, '1.1.0');
  assert.equal(ingredientRuntime?.version, '2.1.0');
  assert.equal(ingredientManifest?.version, '2.1.0');
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
  assert.match(text, /usage\.time_of_day MUST be "AM only"/i);
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
