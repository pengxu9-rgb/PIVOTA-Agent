const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ARCHETYPE_LIBRARY,
  NODE_SPECS,
  getArchetypeMap,
} = require('../scripts/aurora_prompt_spec_library.cjs');
const LlmGateway = require('../src/auroraBff/services/llm_gateway');
const { FREEFORM_PROMPT_VERSION } = require('../src/auroraBff/services/llm_gateway');
const {
  renderMarkdown,
  summarizeNodes,
} = require('../scripts/export_aurora_prompt_spec_matrix.cjs');

const ROOT_DIR = path.resolve(__dirname, '..');
const HARD_RULE_SHORT_TERM_ALLOWLIST = new Set(['spf', 'am', 'pm', 'uv']);
const HARD_RULE_DOMAIN_ANCHORS = new Set([
  'spf', 'am', 'pm', 'uv', 'sunscreen', 'retinoid', 'pregnancy', 'safety', 'evidence',
  'photo', 'visual', 'ingredient', 'candidate', 'anchor', 'confidence', 'concerns', 'skills',
  'question', 'goal',
]);
const HARD_RULE_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'must', 'should', 'do', 'not', 'or', 'and', 'if', 'when', 'for', 'in', 'of', 'be',
  'to', 'no', 'use', 'only', 'with',
]);

function extractHardRulesBlock(text) {
  const match = text.match(/\[HARD_RULES\]([\s\S]*?)\[\/HARD_RULES\]/);
  return match ? match[1].toLowerCase() : '';
}

function extractOutputContractBlock(text) {
  const match = text.match(/\[OUTPUT_CONTRACT\]([\s\S]*?)\[\/OUTPUT_CONTRACT\]/);
  return match ? match[1].toLowerCase() : '';
}

function extractKeyTerms(rule) {
  const cleaned = rule.toLowerCase().replace(/[^a-z0-9_\s]/g, ' ');
  return [...new Set(
    cleaned
      .split(/\s+/)
      .filter((w) => w)
      .filter((w) => (w.length >= 3 || HARD_RULE_SHORT_TERM_ALLOWLIST.has(w)) && !HARD_RULE_STOP_WORDS.has(w))
  )];
}

function matchHardRuleTerms(rule, hardRulesBlock) {
  const terms = extractKeyTerms(rule);
  const hits = terms.filter((term) => hardRulesBlock.includes(term));
  const anchorHits = hits.filter((term) => HARD_RULE_DOMAIN_ANCHORS.has(term));
  const requiredHits =
    terms.length <= 1
      ? terms.length
      : anchorHits.length > 0
        ? 1
        : Math.min(2, terms.length);
  return {
    terms,
    hits,
    anchorHits,
    requiredHits,
    matched: hits.length >= requiredHits,
  };
}

test('aurora prompt spec library has unique node ids and valid archetype links', () => {
  const seen = new Set();
  const archetypeMap = getArchetypeMap();

  for (const node of NODE_SPECS) {
    assert.equal(seen.has(node.node_id), false, `duplicate node_id: ${node.node_id}`);
    seen.add(node.node_id);
    assert.equal(archetypeMap.has(node.archetype), true, `unknown archetype: ${node.archetype}`);
    assert.ok(Array.isArray(node.best_prompt_skeleton) && node.best_prompt_skeleton.length >= 3, `weak prompt skeleton: ${node.node_id}`);
    assert.ok(Array.isArray(node.current_eval_assets) && node.current_eval_assets.length >= 1, `missing eval assets: ${node.node_id}`);
  }
});

test('aurora prompt spec library prompt source paths exist', () => {
  for (const node of NODE_SPECS) {
    const promptSource = String(node.prompt_source || '');
    const filePath = promptSource.split('::')[0];
    assert.ok(filePath, `missing prompt source path: ${node.node_id}`);
    assert.equal(fs.existsSync(path.join(ROOT_DIR, filePath)), true, `prompt source missing on disk: ${node.node_id}`);
  }
});

test('aurora prompt spec library v2 versions align with prompt manifest', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'src/auroraBff/prompts/prompt_manifest.json'), 'utf8')
  );
  const manifestMap = new Map((manifest.templates || []).map((entry) => [entry.template_id, entry.version]));

  for (const node of NODE_SPECS.filter((entry) => entry.node_id.startsWith('v2.'))) {
    const templateId = node.node_id.replace(/^v2\./, '');
    if (templateId === 'chat.freeform') continue;
    assert.equal(manifestMap.has(templateId), true, `missing manifest template for ${node.node_id}`);
    assert.equal(node.current_version_or_variant, manifestMap.get(templateId), `version mismatch for ${node.node_id}`);
  }
});

test('aurora prompt spec library freeform version aligns with runtime system prompt version', () => {
  const freeformSpec = NODE_SPECS.find((entry) => entry.node_id === 'v2.chat.freeform');
  assert.ok(freeformSpec);
  assert.equal(freeformSpec.current_version_or_variant, FREEFORM_PROMPT_VERSION);
});

test('aurora prompt spec matrix summary matches expected scope', () => {
  const summary = summarizeNodes(NODE_SPECS);
  assert.equal(summary.total, 28);
  assert.deepEqual(summary.priorities, [
    { priority: 'P0', count: 11 },
    { priority: 'P1', count: 9 },
    { priority: 'P2', count: 8 },
  ]);
  assert.deepEqual(summary.surfaces, [
    { surface: 'Aurora v2', count: 14 },
    { surface: 'legacy Node', count: 14 },
  ]);
});

test('aurora prompt spec matrix markdown includes key nodes and archetypes', () => {
  const markdown = renderMarkdown({
    generatedAtUtc: '2026-03-08T00:00:00.000Z',
    archetypes: ARCHETYPE_LIBRARY,
    nodes: NODE_SPECS,
  });

  assert.match(markdown, /# Aurora Prompt Node Spec Matrix/);
  assert.match(markdown, /## Archetype Library/);
  assert.match(markdown, /v2\.product_analyze/);
  assert.match(markdown, /legacy\.reco\.main_selector/);
  assert.match(markdown, /multimodal extractor \/ report synthesizer/);
});

test('v2 spec hard_rules keywords are present in runtime prompt HARD_RULES section', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const v2Nodes = NODE_SPECS.filter((n) => n.node_id.startsWith('v2.') && n.node_id !== 'v2.chat.freeform');

  const mismatches = [];

  for (const node of v2Nodes) {
    const templateId = node.node_id.replace(/^v2\./, '');
    const template = gateway._promptRegistry.get(templateId);
    if (!template) continue;

    const hardRulesBlock = extractHardRulesBlock(String(template.text || ''));
    if (!hardRulesBlock) continue;

    for (const specRule of (node.hard_rules || [])) {
      const result = matchHardRuleTerms(specRule, hardRulesBlock);
      if (!result.matched && result.terms.length > 0) {
        mismatches.push({
          node: node.node_id,
          specRule,
          terms: result.terms.slice(0, 5),
          hits: result.hits,
          requiredHits: result.requiredHits,
        });
      }
    }
  }

  assert.equal(
    mismatches.length,
    0,
    `spec hard_rules not found in prompt text:\n${mismatches.map((m) => `  ${m.node}: "${m.specRule}" (looked for: ${m.terms.join(', ')}, hits: ${m.hits.join(', ') || 'none'}, required_hits=${m.requiredHits})`).join('\n')}`,
  );
});

test('v2 spec output_contract schema_required fields match prompt OUTPUT_CONTRACT block', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const v2Nodes = NODE_SPECS.filter((n) => n.node_id.startsWith('v2.') && n.node_id !== 'v2.chat.freeform');

  const mismatches = [];

  for (const node of v2Nodes) {
    const templateId = node.node_id.replace(/^v2\./, '');
    const template = gateway._promptRegistry.get(templateId);
    if (!template) continue;

    const contractBlock = extractOutputContractBlock(String(template.text || ''));
    if (!contractBlock) continue;

    for (const field of (node.output_contract?.schema_required || [])) {
      const fieldLower = field.toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (fieldLower && !contractBlock.includes(fieldLower)) {
        mismatches.push({ node: node.node_id, field });
      }
    }
  }

  assert.equal(mismatches.length, 0, `spec schema_required fields not found in prompt OUTPUT_CONTRACT:\n${mismatches.map((m) => `  ${m.node}: missing "${m.field}"`).join('\n')}`);
});

test('v2 spec input params match prompt INPUT_CONTEXT placeholders', () => {
  const gateway = new LlmGateway({ stubResponses: true });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'src/auroraBff/prompts/prompt_manifest.json'), 'utf8')
  );

  function extractPlaceholders(text) {
    const matches = text.match(/\{\{(\w+)\}\}/g) || [];
    return matches.map((m) => m.replace(/\{\{|\}\}/g, ''));
  }

  const mismatches = [];

  for (const entry of (manifest.templates || [])) {
    const template = gateway._promptRegistry.get(entry.template_id);
    if (!template) continue;

    const placeholders = new Set(extractPlaceholders(String(template.text || '')));
    for (const param of (entry.input_params || [])) {
      if (!placeholders.has(param)) {
        mismatches.push({ template: entry.template_id, param });
      }
    }
    for (const placeholder of placeholders) {
      if (!(entry.input_params || []).includes(placeholder)) {
        mismatches.push({ template: entry.template_id, param: `{{${placeholder}}} in prompt but not in manifest` });
      }
    }
  }

  assert.equal(mismatches.length, 0, `manifest input_params vs prompt placeholder mismatch:\n${mismatches.map((m) => `  ${m.template}: ${m.param}`).join('\n')}`);
});

test('spec hard-rule matcher keeps short skincare acronyms instead of skipping them', () => {
  const result = matchHardRuleTerms(
    'SPF/sunscreen: usage.time_of_day MUST be "AM only".',
    'spf rule: sunscreen is an am-only step with reapply guidance.',
  );

  assert.equal(result.terms.includes('spf'), true);
  assert.equal(result.terms.includes('am'), true);
  assert.equal(result.matched, true);
});

test('spec hard-rule matcher does not pass multi-term rules on a single generic overlap alone', () => {
  const result = matchHardRuleTerms(
    'Evidence: when uncertainty is high, keep the verdict cautious rather than assertive.',
    'missing-data policy: stay cautious and conservative when details are sparse.',
  );

  assert.equal(result.hits.includes('cautious'), true);
  assert.equal(result.requiredHits >= 2, true);
  assert.equal(result.matched, false);
});
