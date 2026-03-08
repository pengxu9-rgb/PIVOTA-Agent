#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const PROMPT_MANIFEST_PATH = path.join(DEFAULT_ROOT, 'src/auroraBff/prompts/prompt_manifest.json');
const OUTPUT_PATH = path.join(DEFAULT_ROOT, 'docs/aurora_chat_v2_prompt_inventory.md');

const SOURCE_FILES = [
  'src/auroraBff/orchestrator/skill_router.js',
  'src/auroraBff/skills/diagnosis_v2_start.js',
  'src/auroraBff/skills/diagnosis_v2_answer.js',
  'src/auroraBff/skills/routine_intake_products.js',
  'src/auroraBff/skills/routine_audit_optimize.js',
  'src/auroraBff/skills/reco_step_based.js',
  'src/auroraBff/skills/tracker_checkin_insights.js',
  'src/auroraBff/skills/product_analyze.js',
  'src/auroraBff/skills/ingredient_report.js',
  'src/auroraBff/skills/dupe_suggest.js',
  'src/auroraBff/skills/dupe_compare.js',
  'src/auroraBff/skills/travel_apply_mode.js',
];

const PRIORITY_BY_TEMPLATE = {
  diagnosis_v2_answer_blueprint: 'P0',
  ingredient_report: 'P0',
  product_analyze: 'P0',
  routine_audit_optimize: 'P0',
  tracker_checkin_insights: 'P0',
  travel_apply_mode: 'P0',
  ingredient_query_answer: 'P1',
  intent_classifier: 'P1',
  reco_step_based: 'P1',
  diagnosis_v2_start_personalized: 'P2',
  dupe_compare: 'P2',
  dupe_suggest: 'P2',
  routine_categorize_products: 'P2',
};

const AUDIT_FOCUS_BY_TEMPLATE = {
  diagnosis_v2_start_personalized: 'Opening personalization quality, user-history grounding, and over-claim avoidance.',
  diagnosis_v2_answer_blueprint: 'Schema completeness, no-photo guardrails, question sequencing, and safety-first blueprinting.',
  routine_categorize_products: 'Step classification accuracy, duplicate assignment, and null-safe handling of unknown products.',
  routine_audit_optimize: 'Safety edits, strong-active reductions, and conservative optimization when routine data is incomplete.',
  reco_step_based: 'Recommendation relevance, empty-pool behavior, concern/ingredient routing, and next_actions quality.',
  tracker_checkin_insights: 'No-photo visual-claim suppression, trend grounding, and conservative change summaries.',
  product_analyze: 'Structured usage guidance, SPF hard rules, retinoid caution, and no-guess ingredient reasoning.',
  ingredient_report: 'Ingredient-level claims only, uncertain-evidence wording, and guaranteed ingredient_claims coverage.',
  ingredient_query_answer: 'Free-form ingredient education quality, concise directness, and follow-up ingredient grounding.',
  intent_classifier: 'Routing precision, false-positive skill jumps, and stable fallback to free-form chat.',
  dupe_suggest: 'Candidate quality ranking, empty-state behavior, and no fabricated similarity claims.',
  dupe_compare: 'Comparison fairness, tradeoff framing, and strict support in candidate evidence.',
  travel_apply_mode: 'High-UV adjustments, reduce_actives triggering, packing guidance, and climate uncertainty handling.',
  'chat.freeform': 'Answer quality, tone, safety, factual caution, and SSE chunk/result consistency.',
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function slugPriority(priority) {
  return priority || 'P3';
}

function buildManifestMap(rootDir = DEFAULT_ROOT) {
  const manifest = readJson(path.join(rootDir, 'src/auroraBff/prompts/prompt_manifest.json'));
  return new Map((manifest.templates || []).map((entry) => [entry.template_id, entry]));
}

function inferEntrypoint(relPath, text, templateId) {
  const skillIdMatch = text.match(/super\(\s*['"]([^'"]+)['"]/);
  if (skillIdMatch) return skillIdMatch[1];
  if (relPath.endsWith('skill_router.js') && templateId === 'intent_classifier') {
    return 'skill_router._classifyIntent';
  }
  return relPath;
}

function findSchemaAfterIndex(text, startIndex) {
  const slice = text.slice(startIndex);
  const schemaMatch = slice.match(/schema:\s*['"]([^'"]+)['"]/);
  return schemaMatch ? schemaMatch[1] : null;
}

function collectRowsFromFile(relPath, manifestMap, rootDir = DEFAULT_ROOT) {
  const absPath = path.join(rootDir, relPath);
  const text = fs.readFileSync(absPath, 'utf8');
  const rows = [];
  const templateMatches = [...text.matchAll(/templateId:\s*['"]([^'"]+)['"]/g)];

  for (const match of templateMatches) {
    const templateId = match[1];
    const manifestEntry = manifestMap.get(templateId) || {};
    rows.push({
      priority: slugPriority(PRIORITY_BY_TEMPLATE[templateId]),
      template_id: templateId,
      version: manifestEntry.version || null,
      task_mode: manifestEntry.task_mode || null,
      call_mode: 'structured',
      output_schema: findSchemaAfterIndex(text, match.index || 0) || manifestEntry.output_schema || null,
      entrypoint: inferEntrypoint(relPath, text, templateId),
      source_file: relPath,
      input_params: Array.isArray(manifestEntry.input_params) ? manifestEntry.input_params : [],
      audit_focus: AUDIT_FOCUS_BY_TEMPLATE[templateId] || 'Review schema fidelity, groundedness, and failure modes.',
    });
  }

  if (relPath.endsWith('skill_router.js') && text.includes('this._llmGateway.chat({')) {
    const gatewayPath = path.join(rootDir, 'src/auroraBff/services/llm_gateway.js');
    const gatewayText = fs.existsSync(gatewayPath) ? fs.readFileSync(gatewayPath, 'utf8') : '';
    const freeformVersion = gatewayText.match(/const FREEFORM_PROMPT_VERSION = ['"]([^'"]+)['"]/)?.[1] || 'inline';
    rows.push({
      priority: 'P1',
      template_id: 'chat.freeform',
      version: freeformVersion,
      task_mode: 'chat',
      call_mode: 'freeform_chat',
      output_schema: null,
      entrypoint: 'skill_router._handleFreeFormChat',
      source_file: relPath,
      input_params: ['user_message', 'system_prompt', 'context', 'locale'],
      audit_focus: AUDIT_FOCUS_BY_TEMPLATE['chat.freeform'],
    });
  }

  return rows;
}

function sortRows(rows) {
  return [...rows].sort((left, right) => {
    const priorityCompare = String(left.priority).localeCompare(String(right.priority));
    if (priorityCompare !== 0) return priorityCompare;
    return String(left.template_id).localeCompare(String(right.template_id));
  });
}

function collectAuroraPromptInventory(rootDir = DEFAULT_ROOT) {
  const manifestMap = buildManifestMap(rootDir);
  const rows = SOURCE_FILES.flatMap((relPath) => collectRowsFromFile(relPath, manifestMap, rootDir));
  const seen = new Set();
  const uniqueRows = rows.filter((row) => {
    const key = [row.template_id, row.entrypoint, row.source_file].join('::');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const manifestTemplates = [...manifestMap.keys()].sort();
  const inventoryTemplates = uniqueRows
    .filter((row) => row.template_id !== 'chat.freeform')
    .map((row) => row.template_id)
    .sort();

  return {
    generated_at_utc: new Date().toISOString(),
    scope: 'Aurora Chat v2 prompt surface in the Node BFF. Legacy routes.js prompt calls outside the v2 surface remain a follow-up audit scope.',
    summary: {
      manifest_templates: manifestTemplates.length,
      inventory_rows: uniqueRows.length,
      structured_rows: uniqueRows.filter((row) => row.call_mode === 'structured').length,
      freeform_rows: uniqueRows.filter((row) => row.call_mode !== 'structured').length,
      manifest_templates_covered: inventoryTemplates.length,
    },
    coverage: {
      missing_from_inventory: manifestTemplates.filter((templateId) => !inventoryTemplates.includes(templateId)),
      extra_inventory_rows: uniqueRows
        .map((row) => row.template_id)
        .filter((templateId) => !manifestTemplates.includes(templateId))
        .sort(),
    },
    rows: sortRows(uniqueRows),
  };
}

function renderMarkdown(report) {
  const lines = [
    '# Aurora Chat v2 Prompt Inventory',
    '',
    `Generated: ${report.generated_at_utc}`,
    '',
    report.scope,
    '',
    '## Summary',
    '',
    `- Manifest templates: ${report.summary.manifest_templates}`,
    `- Inventory rows: ${report.summary.inventory_rows}`,
    `- Structured rows: ${report.summary.structured_rows}`,
    `- Free-form rows: ${report.summary.freeform_rows}`,
    `- Manifest templates covered: ${report.summary.manifest_templates_covered}/${report.summary.manifest_templates}`,
    '',
    '## Coverage',
    '',
    `- Missing from inventory: ${report.coverage.missing_from_inventory.length ? report.coverage.missing_from_inventory.join(', ') : 'none'}`,
    `- Extra inventory rows: ${report.coverage.extra_inventory_rows.length ? report.coverage.extra_inventory_rows.join(', ') : 'none'}`,
    '',
    '## Prompt Table',
    '',
    '| Priority | Template / Call | Version | Mode | Schema | Entrypoint | Source |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const row of report.rows) {
    lines.push(
      `| ${row.priority} | ${row.template_id} | ${row.version || '-'} | ${row.call_mode} | ${row.output_schema || '-'} | ${row.entrypoint} | ${row.source_file} |`
    );
  }

  lines.push('', '## Audit Queue', '');

  for (const priority of ['P0', 'P1', 'P2']) {
    const priorityRows = report.rows.filter((row) => row.priority === priority);
    if (priorityRows.length === 0) continue;
    lines.push(`### ${priority}`, '');
    for (const row of priorityRows) {
      const inputParams = row.input_params.length ? row.input_params.join(', ') : '-';
      lines.push(`- \`${row.template_id}\` via \`${row.entrypoint}\` in \`${row.source_file}\``);
      lines.push(`  Inputs: ${inputParams}`);
      lines.push(`  Schema: ${row.output_schema || 'none'} | Task mode: ${row.task_mode || 'unknown'} | Focus: ${row.audit_focus}`);
    }
    lines.push('');
  }

  lines.push('## Production Review Fields', '');
  lines.push('- QPS and user-facing traffic share per template/call');
  lines.push('- Schema-fail rate, parse-fail rate, and quality-gate intervention rate');
  lines.push('- Median and p95 latency, timeout rate, and retry frequency');
  lines.push('- Empty-state rate, fallback rate, and safety-block rate');
  lines.push('- Human review sample score for groundedness, usefulness, and tone');
  lines.push('- Regression links to fixtures, live probes, and notable bad-case examples');
  lines.push('');
  lines.push('## Next Scope', '');
  lines.push('- Legacy `src/auroraBff/routes.js` prompt calls outside Aurora Chat v2 are not included here.');
  lines.push('- Glow mirrors the v2 contract, but prompt authorship remains anchored in the Node BFF manifest and gateway registry.');
  lines.push('');

  return `${lines.join('\n').trim()}\n`;
}

function writeInventory({ rootDir = DEFAULT_ROOT, outputPath = OUTPUT_PATH } = {}) {
  const report = collectAuroraPromptInventory(rootDir);
  const markdown = renderMarkdown(report);
  fs.writeFileSync(outputPath, markdown, 'utf8');
  return { report, outputPath };
}

if (require.main === module) {
  const { report, outputPath } = writeInventory();
  process.stdout.write(`Wrote Aurora prompt inventory to ${path.relative(DEFAULT_ROOT, outputPath)}\n`);
  process.stdout.write(`Rows: ${report.summary.inventory_rows}, coverage: ${report.summary.manifest_templates_covered}/${report.summary.manifest_templates}\n`);
}

module.exports = {
  collectAuroraPromptInventory,
  renderMarkdown,
  writeInventory,
};
