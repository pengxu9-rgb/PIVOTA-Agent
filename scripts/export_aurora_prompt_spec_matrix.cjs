#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  ARCHETYPE_LIBRARY,
  NODE_SPECS,
} = require('./aurora_prompt_spec_library.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(DEFAULT_ROOT, 'docs/aurora_prompt_node_spec_matrix.md');

function groupBy(items, getKey) {
  const grouped = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  return grouped;
}

function summarizeNodes(nodes) {
  const clusterMap = groupBy(nodes, (node) => node.cluster);
  const priorityMap = groupBy(nodes, (node) => node.rewrite_priority);
  const surfaceMap = groupBy(nodes, (node) => (String(node.runtime_surface).includes('Aurora Chat v2') ? 'Aurora v2' : 'legacy Node'));

  return {
    total: nodes.length,
    clusters: [...clusterMap.entries()].map(([cluster, rows]) => ({ cluster, count: rows.length })),
    priorities: ['P0', 'P1', 'P2'].map((priority) => ({ priority, count: (priorityMap.get(priority) || []).length })),
    surfaces: [...surfaceMap.entries()].map(([surface, rows]) => ({ surface, count: rows.length })),
  };
}

function renderList(items, emptyValue = 'none') {
  return Array.isArray(items) && items.length > 0 ? items.join('; ') : emptyValue;
}

function renderMarkdown({ generatedAtUtc, archetypes, nodes }) {
  const summary = summarizeNodes(nodes);
  const lines = [
    '# Aurora Prompt Node Spec Matrix',
    '',
    `Generated: ${generatedAtUtc}`,
    '',
    'This file is the implementation-ready prompt spec library for Aurora v2 plus legacy Node prompt nodes. It is the source of truth for node goals, consumer contracts, rewrite priorities, and the best matching prompt archetype.',
    '',
    '## Summary',
    '',
    `- Total nodes: ${summary.total}`,
    `- Surfaces: ${summary.surfaces.map((entry) => `${entry.surface}=${entry.count}`).join(', ')}`,
    `- Priorities: ${summary.priorities.map((entry) => `${entry.priority}=${entry.count}`).join(', ')}`,
    `- Clusters: ${summary.clusters.map((entry) => `${entry.cluster}=${entry.count}`).join(' | ')}`,
    '',
    '## Archetype Library',
    '',
    '| Archetype | Purpose | Required Sections |',
    '| --- | --- | --- |',
  ];

  for (const archetype of archetypes) {
    lines.push(
      `| ${archetype.archetype_id} | ${archetype.description} | ${archetype.required_sections.join(', ')} |`
    );
  }

  lines.push('', '## Node Index', '', '| Priority | Node ID | Cluster | Archetype | Consumer | Prompt Source |', '| --- | --- | --- | --- | --- | --- |');

  for (const node of nodes) {
    lines.push(
      `| ${node.rewrite_priority} | ${node.node_id} | ${node.cluster} | ${node.archetype} | ${node.consumer} | ${node.prompt_source} |`
    );
  }

  lines.push('', '## Detailed Specs', '');

  const clusters = groupBy(nodes, (node) => node.cluster);
  for (const [cluster, clusterNodes] of clusters.entries()) {
    lines.push(`### ${cluster}`, '');
    for (const node of clusterNodes) {
      lines.push(`#### ${node.node_id}`, '');
      lines.push(`- Priority: ${node.rewrite_priority}`);
      lines.push(`- Runtime surface: ${node.runtime_surface}`);
      lines.push(`- Call mode: ${node.call_mode}`);
      lines.push(`- Entrypoint: ${node.entrypoint}`);
      lines.push(`- Consumer: ${node.consumer}`);
      lines.push(`- Prompt source: ${node.prompt_source}`);
      lines.push(`- Current version/variant: ${node.current_version_or_variant}`);
      lines.push(`- Dormant variants: ${renderList(node.dormant_variants)}`);
      lines.push(`- Provider path: ${node.provider_path}`);
      lines.push(`- Archetype: ${node.archetype}`);
      lines.push(`- Goal: ${node.goal}`);
      lines.push(`- Output contract: schema=${node.output_contract.schema || 'none'} | schema_required=${renderList(node.output_contract.schema_required)} | consumer_required=${renderList(node.output_contract.consumer_required)}`);
      lines.push(`- Deterministic boundary: ${renderList(node.deterministic_boundary)}`);
      lines.push(`- Hard rules: ${renderList(node.hard_rules)}`);
      lines.push(`- Missing-data policy: ${renderList(node.missing_data_policy)}`);
      lines.push(`- Forbidden behaviors: ${renderList(node.forbidden_behaviors)}`);
      lines.push(`- Best prompt skeleton: ${renderList(node.best_prompt_skeleton)}`);
      lines.push(`- Locale policy: ${node.locale_policy}`);
      lines.push(`- Example policy: ${node.example_policy}`);
      lines.push(`- Eval assets: ${renderList(node.current_eval_assets)}`);
      lines.push('');
    }
  }

  lines.push('## Rewrite Policy', '');
  lines.push('- Do not rewrite multiple P0 nodes in one change.');
  lines.push('- For v2 nodes, update runtime prompt text, manifest version, and prompt contract tests together.');
  lines.push('- For legacy nodes, add or preserve stable prompt tracing before changing prompt behavior.');
  lines.push('- Use English prompt bodies with locale-controlled outputs; do not introduce full bilingual prompt bodies by default.');
  lines.push('');

  return `${lines.join('\n').trim()}\n`;
}

function writePromptSpecMatrix({ rootDir = DEFAULT_ROOT, outputPath = OUTPUT_PATH } = {}) {
  const markdown = renderMarkdown({
    generatedAtUtc: new Date().toISOString(),
    archetypes: ARCHETYPE_LIBRARY,
    nodes: NODE_SPECS,
  });
  fs.writeFileSync(outputPath, markdown, 'utf8');
  return { outputPath };
}

if (require.main === module) {
  const { outputPath } = writePromptSpecMatrix();
  process.stdout.write(`Wrote Aurora prompt spec matrix to ${path.relative(DEFAULT_ROOT, outputPath)}\n`);
  process.stdout.write(`Nodes: ${NODE_SPECS.length}, archetypes: ${ARCHETYPE_LIBRARY.length}\n`);
}

module.exports = {
  renderMarkdown,
  summarizeNodes,
  writePromptSpecMatrix,
};
