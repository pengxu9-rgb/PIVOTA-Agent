#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function parseArgs(argv) {
  const out = {
    cases: '',
    out: '',
    markdown: '',
    manualOverrides: '',
    models: ['gemini-3-flash-preview', 'gemini-3-pro-preview', 'gemini-3.1-pro-preview'],
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--cases' && next) {
      out.cases = next;
      i += 1;
    } else if (token === '--out' && next) {
      out.out = next;
      i += 1;
    } else if (token === '--markdown' && next) {
      out.markdown = next;
      i += 1;
    } else if (token === '--manual-overrides' && next) {
      out.manualOverrides = next;
      i += 1;
    } else if (token === '--models' && next) {
      out.models = next
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
    }
  }

  return out;
}

function resolvePath(rootDir, target) {
  if (!target) return '';
  if (path.isAbsolute(target)) return target;
  return path.join(rootDir, target);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, value);
}

function summarizeModel(report) {
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const qualityScores = rows
    .map((row) => Number(row?.quality_gate?.quality_score))
    .filter((value) => Number.isFinite(value));
  const avgQuality =
    qualityScores.length > 0
      ? Number((qualityScores.reduce((sum, value) => sum + value, 0) / qualityScores.length).toFixed(2))
      : 0;
  const selectedFieldCount = rows.reduce(
    (sum, row) => sum + Number(row?.selected?.selected_field_count || 0),
    0,
  );
  const weakHighlights = rows.filter((row) =>
    Array.isArray(row?.quality_gate?.fail_reasons) &&
    row.quality_gate.fail_reasons.includes('weak_highlights'),
  ).length;
  const sellerOnlyViolations = rows.filter((row) => row?.quality_gate?.seller_only_violation).length;

  const requestedModel =
    asString(report?.meta?.gemini_model_requested || report?.meta?.gemini_model) || 'unknown';
  const resolvedModels = Array.from(
    new Set(
      rows.flatMap((row) =>
        Array.isArray(row?.gemini?.meta?.resolved_models) ? row.gemini.meta.resolved_models.map(asString).filter(Boolean) : [],
      ),
    ),
  );

  return {
    model: requestedModel,
    requested_model: requestedModel,
    resolved_models: resolvedModels,
    cases: rows.length,
    gemini_completed: Number(report?.meta?.gemini_completed || 0),
    hybrid_selected: Number(report?.meta?.hybrid_selected || 0),
    baseline_only: Number(report?.meta?.baseline_only || 0),
    avg_quality_score: avgQuality,
    selected_field_count: selectedFieldCount,
    weak_highlights: weakHighlights,
    seller_only_violations: sellerOnlyViolations,
  };
}

function compareRowsByCase(modelReports) {
  const caseMap = new Map();
  for (const report of modelReports) {
    const model = asString(report?.meta?.gemini_model_requested || report?.meta?.gemini_model) || 'unknown';
    for (const row of report.rows || []) {
      const caseId = asString(row.case_id) || 'unnamed_case';
      const entry = caseMap.get(caseId) || { case_id: caseId, models: {} };
      entry.models[model] = {
        requested_model: asString(row?.gemini?.meta?.requested_model) || model,
        resolved_models: Array.isArray(row?.gemini?.meta?.resolved_models) ? row.gemini.meta.resolved_models : [],
        selected_mode: row?.selected?.selected_mode || 'baseline_only',
        quality_score: Number(row?.quality_gate?.quality_score || 0),
        fail_reasons: row?.quality_gate?.fail_reasons || [],
        selected_field_count: Number(row?.selected?.selected_field_count || 0),
        what_it_is: asString(row?.gemini?.candidate?.product_intel_core?.what_it_is?.body),
        highlights: (row?.gemini?.candidate?.product_intel_core?.why_it_stands_out || []).map((item) => ({
          headline: asString(item?.headline),
          body: asString(item?.body),
        })),
      };
      caseMap.set(caseId, entry);
    }
  }
  return Array.from(caseMap.values());
}

function buildMarkdown(summaryRows, caseComparisons, meta) {
  const lines = [
    '# Product Intel Model Bakeoff',
    '',
    `Generated: ${meta.generated_at}`,
    `Models: ${meta.models.join(', ')}`,
    `Cases: ${meta.case_count}`,
    '',
    '## Summary',
    '',
    '| Model | Avg Quality | Hybrid Selected | Baseline Only | Weak Highlights | Seller-only Violations |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const row of summaryRows) {
    lines.push(
      `| ${row.requested_model} (${row.resolved_models.join(', ') || 'unknown'}) | ${row.avg_quality_score} | ${row.hybrid_selected} | ${row.baseline_only} | ${row.weak_highlights} | ${row.seller_only_violations} |`,
    );
  }

  lines.push('', '## Per-case', '');
  for (const row of caseComparisons) {
    lines.push(`### ${row.case_id}`, '');
    for (const model of Object.keys(row.models)) {
      const item = row.models[model];
      lines.push(
        `- ${model} (resolved=${(item.resolved_models || []).join(', ') || 'unknown'}): quality=${item.quality_score}, selected=${item.selected_mode}, selected_fields=${item.selected_field_count}, fail_reasons=${JSON.stringify(item.fail_reasons)}`,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  const rootDir = path.resolve(__dirname, '..');
  const args = parseArgs(process.argv);
  if (!args.cases) {
    throw new Error('--cases is required');
  }

  const compareScript = path.join(rootDir, 'scripts', 'product_intel_pilot_compare.js');
  const casesPath = resolvePath(rootDir, args.cases);
  const casesPayload = readJson(casesPath);
  const caseCount = Array.isArray(casesPayload) ? casesPayload.length : 0;
  const tmpRoot = path.join(rootDir, 'reports', 'product-intel-bakeoff');
  fs.mkdirSync(tmpRoot, { recursive: true });

  const reports = [];
  for (const model of args.models) {
    const safeModel = model.replace(/[^a-z0-9._-]+/gi, '_');
    const outPath = path.join(tmpRoot, `${safeModel}.json`);
    const markdownPath = path.join(tmpRoot, `${safeModel}.md`);
    const result = spawnSync(
      process.execPath,
      [
        compareScript,
        '--cases',
        casesPath,
        '--out',
        outPath,
        '--markdown',
        markdownPath,
        '--model',
        model,
        ...(args.manualOverrides ? ['--manual-overrides', resolvePath(rootDir, args.manualOverrides)] : []),
      ],
      {
        cwd: rootDir,
        stdio: 'inherit',
        env: process.env,
      },
    );
    if (result.status !== 0) {
      throw new Error(`compare_failed:${model}`);
    }
    reports.push(readJson(outPath));
  }

  const summaryRows = reports.map(summarizeModel);
  const caseComparisons = compareRowsByCase(reports);
  const generatedAt = new Date().toISOString();
  const jsonOut = resolvePath(
    rootDir,
    args.out || `reports/product_intel_model_bakeoff_${generatedAt.replace(/[:.]/g, '-')}.json`,
  );
  const markdownOut = resolvePath(
    rootDir,
    args.markdown || `reports/product_intel_model_bakeoff_${generatedAt.replace(/[:.]/g, '-')}.md`,
  );

  const payload = {
    meta: {
      generated_at: generatedAt,
      models: args.models,
      resolved_models_observed: Array.from(
        new Set(summaryRows.flatMap((row) => row.resolved_models || []).map((value) => asString(value)).filter(Boolean)),
      ),
      case_count: caseCount,
    },
    summary: summaryRows,
    cases: caseComparisons,
    reports,
  };

  writeJson(jsonOut, payload);
  writeText(markdownOut, buildMarkdown(summaryRows, caseComparisons, payload.meta));
  process.stdout.write(`${JSON.stringify({ status: 'ok', json: jsonOut, markdown: markdownOut })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  summarizeModel,
  compareRowsByCase,
  buildMarkdown,
};
