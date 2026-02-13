#!/usr/bin/env node

import fsp from 'node:fs/promises';
import path from 'node:path';
import { runTimestampKey } from './internal_batch_helpers.mjs';
import { readJsonlRows, toPosix } from './local_image_loader.mjs';

const HELP_TEXT = `preference_merge_adjudication.mjs

Usage:
  node scripts/preference_merge_adjudication.mjs --base_labels <preference_labels.ndjson> --adj_labels <preference_labels_adjudication.ndjson> [options]

Required:
  --base_labels <path>                    imported main preference labels ndjson
  --adj_labels <path>                     imported adjudication labels ndjson

Options:
  --out <path>                            merged output ndjson (default: sibling preference_labels_merged.ndjson)
  --run_id <id>                           run id (default: infer from paths)
  --report_dir <dir>                      qc report dir (default: reports)
  --help                                  show help
`;

function parseBool(value, fallback = false) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function parseArgs(argv) {
  const out = {
    help: false,
    base_labels: process.env.BASE_LABELS || process.env.BASE || '',
    adj_labels: process.env.ADJ_LABELS || process.env.ADJ || '',
    out: process.env.OUT || '',
    run_id: process.env.RUN_ID || '',
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || 'reports',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (!(key in out)) continue;
    if (!next || String(next).startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = String(next);
    i += 1;
  }

  out.help = parseBool(out.help, false);
  out.base_labels = String(out.base_labels || '').trim();
  out.adj_labels = String(out.adj_labels || '').trim();
  out.out = String(out.out || '').trim();
  out.run_id = String(out.run_id || '').trim();
  out.report_dir = String(out.report_dir || 'reports').trim() || 'reports';
  return out;
}

function inferRunId(args) {
  if (args.run_id) return args.run_id;
  for (const token of [args.base_labels, args.adj_labels, args.out]) {
    const base = path.basename(String(token || ''));
    const match = base.match(/(\d{15}|\d{8}_\d{6,9})/);
    if (match) return match[1];
  }
  return runTimestampKey();
}

function normalizeRow(row, source) {
  const sampleId = String(row && (row.sample_id || row.sample_hash) ? (row.sample_id || row.sample_hash) : '').trim();
  if (!sampleId) return null;
  const moduleId = String(row.module_id || 'overall').trim() || 'overall';
  const raterId = String(row.rater_id || row.annotator_id || 'unknown_rater').trim() || 'unknown_rater';
  return {
    ...row,
    sample_id: sampleId,
    sample_hash: sampleId,
    module_id: moduleId,
    rater_id: raterId,
    annotator_id: raterId,
    _pair_key: `${sampleId}\u0000${moduleId}`,
    _row_key: `${sampleId}\u0000${moduleId}\u0000${raterId}\u0000${String(row.annotation_id || '')}`,
    _source: source,
  };
}

function rowTimestamp(row) {
  return Date.parse(String(row.updated_at || row.created_at || '')) || 0;
}

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const sampleDelta = String(a.sample_id || '').localeCompare(String(b.sample_id || ''));
    if (sampleDelta !== 0) return sampleDelta;
    const moduleDelta = String(a.module_id || '').localeCompare(String(b.module_id || ''));
    if (moduleDelta !== 0) return moduleDelta;
    const sourceDelta = String(a.decision_source || '').localeCompare(String(b.decision_source || ''));
    if (sourceDelta !== 0) return sourceDelta;
    const tsDelta = rowTimestamp(b) - rowTimestamp(a);
    if (tsDelta !== 0) return tsDelta;
    return String(a._row_key || '').localeCompare(String(b._row_key || ''));
  });
}

function renderMarkdown({ runId, inputs, outputRel, qc }) {
  const lines = [];
  lines.push('# Preference Adjudication Merge QC');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- base_labels: \`${inputs.base}\``);
  lines.push(`- adj_labels: \`${inputs.adj}\``);
  lines.push(`- merged_out: \`${outputRel}\``);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('|---|---:|');
  lines.push(`| base_rows_total | ${qc.base_rows_total} |`);
  lines.push(`| adjudication_rows_total | ${qc.adjudication_rows_total} |`);
  lines.push(`| merged_rows_total | ${qc.merged_rows_total} |`);
  lines.push(`| adjudicated_pairs_count | ${qc.adjudicated_pairs_count} |`);
  lines.push(`| overridden_pairs_count | ${qc.overridden_pairs_count} |`);
  lines.push(`| missing_pairs_in_base_count | ${qc.missing_pairs_in_base_count} |`);
  lines.push('');

  lines.push('## Overridden Pairs (Top 50)');
  lines.push('');
  lines.push('| rank | sample_id | module_id |');
  lines.push('|---:|---|---|');
  if (!qc.overridden_pairs.length) {
    lines.push('| 1 | - | - |');
  } else {
    qc.overridden_pairs.slice(0, 50).forEach((row, idx) => {
      lines.push(`| ${idx + 1} | ${row.sample_id} | ${row.module_id} |`);
    });
  }
  lines.push('');

  lines.push('## Missing Base Pairs (Top 50)');
  lines.push('');
  lines.push('| rank | sample_id | module_id |');
  lines.push('|---:|---|---|');
  if (!qc.missing_pairs_in_base.length) {
    lines.push('| 1 | - | - |');
  } else {
    qc.missing_pairs_in_base.slice(0, 50).forEach((row, idx) => {
      lines.push(`| ${idx + 1} | ${row.sample_id} | ${row.module_id} |`);
    });
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    process.exit(0);
    return;
  }

  if (!args.base_labels) {
    process.stderr.write('preference_merge_adjudication: missing --base_labels\n');
    process.exit(2);
    return;
  }
  if (!args.adj_labels) {
    process.stderr.write('preference_merge_adjudication: missing --adj_labels\n');
    process.exit(2);
    return;
  }

  const runId = inferRunId(args);
  const basePath = path.resolve(args.base_labels);
  const adjPath = path.resolve(args.adj_labels);
  const outPath = path.resolve(args.out || path.join(path.dirname(basePath), 'preference_labels_merged.ndjson'));
  const reportDir = path.resolve(args.report_dir);
  const qcMdPath = path.resolve(path.join(reportDir, `preference_merge_adjudication_qc_${runId}.md`));
  const qcJsonPath = path.resolve(path.join(reportDir, `preference_merge_adjudication_qc_${runId}.json`));

  await Promise.all([
    fsp.mkdir(path.dirname(outPath), { recursive: true }),
    fsp.mkdir(reportDir, { recursive: true }),
  ]);

  const [baseRawRows, adjRawRows] = await Promise.all([
    readJsonlRows(basePath),
    readJsonlRows(adjPath),
  ]);

  const baseRows = baseRawRows.map((row) => normalizeRow(row, 'main')).filter(Boolean);
  const adjRows = adjRawRows.map((row) => normalizeRow(row, 'adjudication')).filter(Boolean);

  const basePairMap = new Map();
  for (const row of baseRows) {
    if (!basePairMap.has(row._pair_key)) basePairMap.set(row._pair_key, []);
    basePairMap.get(row._pair_key).push(row);
  }

  const adjPairMap = new Map();
  for (const row of adjRows) {
    if (!adjPairMap.has(row._pair_key)) adjPairMap.set(row._pair_key, []);
    adjPairMap.get(row._pair_key).push(row);
  }

  const adjudicatedPairs = [...adjPairMap.keys()].sort((a, b) => a.localeCompare(b));
  const overriddenPairs = adjudicatedPairs.filter((key) => basePairMap.has(key));
  const missingPairsInBase = adjudicatedPairs.filter((key) => !basePairMap.has(key));

  const overriddenSet = new Set(overriddenPairs);
  const mergedRows = [];
  const mergedAt = new Date().toISOString();

  for (const row of baseRows) {
    if (overriddenSet.has(row._pair_key)) continue;
    mergedRows.push({
      ...row,
      decision_source: 'main',
      merged_at: mergedAt,
      merge_run_id: runId,
    });
  }

  for (const row of adjRows) {
    mergedRows.push({
      ...row,
      decision_source: 'adjudication',
      is_adjudication: true,
      merged_at: mergedAt,
      merge_run_id: runId,
    });
  }

  const sortedMerged = sortRows(mergedRows).map((row) => {
    const out = { ...row };
    delete out._pair_key;
    delete out._row_key;
    delete out._source;
    return out;
  });

  const ndjson = sortedMerged.length
    ? `${sortedMerged.map((row) => JSON.stringify(row)).join('\n')}\n`
    : '';
  await fsp.writeFile(outPath, ndjson, 'utf8');

  const qc = {
    run_id: runId,
    base_rows_total: baseRows.length,
    adjudication_rows_total: adjRows.length,
    merged_rows_total: sortedMerged.length,
    adjudicated_pairs_count: adjudicatedPairs.length,
    overridden_pairs_count: overriddenPairs.length,
    missing_pairs_in_base_count: missingPairsInBase.length,
    overridden_pairs: overriddenPairs.map((key) => {
      const [sample_id, module_id] = key.split('\u0000');
      return { sample_id, module_id };
    }),
    missing_pairs_in_base: missingPairsInBase.map((key) => {
      const [sample_id, module_id] = key.split('\u0000');
      return { sample_id, module_id };
    }),
    generated_at: mergedAt,
    inputs: {
      base_labels: toPosix(path.relative(process.cwd(), basePath)),
      adj_labels: toPosix(path.relative(process.cwd(), adjPath)),
    },
    output_path: toPosix(path.relative(process.cwd(), outPath)),
  };

  await Promise.all([
    fsp.writeFile(qcJsonPath, `${JSON.stringify(qc, null, 2)}\n`, 'utf8'),
    fsp.writeFile(
      qcMdPath,
      renderMarkdown({
        runId,
        inputs: {
          base: qc.inputs.base_labels,
          adj: qc.inputs.adj_labels,
        },
        outputRel: qc.output_path,
        qc,
      }),
      'utf8',
    ),
  ]);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    run_id: runId,
    output_path: qc.output_path,
    qc_report_md: toPosix(path.relative(process.cwd(), qcMdPath)),
    qc_report_json: toPosix(path.relative(process.cwd(), qcJsonPath)),
    adjudicated_pairs_count: qc.adjudicated_pairs_count,
    overridden_pairs_count: qc.overridden_pairs_count,
    missing_pairs_in_base_count: qc.missing_pairs_in_base_count,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`preference_merge_adjudication_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});
