#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATASET_PATH = path.join(ROOT, 'datasets', 'routine_expert_benchmark_120.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'reports');
const DEFAULT_DIMENSIONS = [
  'accuracy',
  'actionability',
  'risk_control',
  'phase_clarity',
  'personalization',
  'evidence_traceability',
];

function normalizeDimensions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const s = String(item || '')
      .trim()
      .toLowerCase();
    if (!s) continue;
    if (!/^[a-z0-9_]+$/.test(s)) continue;
    if (out.includes(s)) continue;
    out.push(s);
  }
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function loadJson(filePath, label) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`${label} not found: ${abs}`);
  }
  const raw = fs.readFileSync(abs, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${abs} (${err.message})`);
  }
}

function toResultList(obj) {
  if (Array.isArray(obj)) return obj;
  if (obj && typeof obj === 'object' && Array.isArray(obj.results)) return obj.results;
  return [];
}

function computeModuleCompleteness(entry) {
  if (Number.isFinite(Number(entry && entry.module_completeness))) {
    const v = Number(entry.module_completeness);
    return Math.max(0, Math.min(1, v));
  }
  const modules = entry && entry.modules && typeof entry.modules === 'object' ? entry.modules : null;
  if (!modules) return 0;
  const vals = Object.values(modules).map((v) => Boolean(v));
  if (!vals.length) return 0;
  return vals.filter(Boolean).length / vals.length;
}

function normalizeScoredResults(rows, label, dimensions) {
  const map = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || '').trim();
    if (!id) continue;
    const scoresObj = row.scores && typeof row.scores === 'object' ? row.scores : {};
    const scores = {};
    for (const dim of dimensions) {
      const raw = Number(scoresObj[dim]);
      if (!Number.isFinite(raw)) {
        throw new Error(`${label}: ${id} missing numeric score for ${dim}`);
      }
      scores[dim] = Math.max(0, Math.min(5, raw));
    }
    const total = dimensions.reduce((sum, dim) => sum + scores[dim], 0) / dimensions.length;
    map.set(id, {
      id,
      language: String(row.language || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN',
      tags: Array.isArray(row.tags) ? row.tags.map((v) => String(v || '').trim()).filter(Boolean) : [],
      scores,
      total,
      safety_violation: Boolean(row.safety_violation),
      module_completeness: computeModuleCompleteness(row),
    });
  }
  return map;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function summarizeByLanguage(rows) {
  const groups = { CN: [], EN: [] };
  for (const row of rows) groups[row.language].push(row.total);
  return {
    CN: mean(groups.CN),
    EN: mean(groups.EN),
  };
}

function formatPct(v) {
  return `${(v * 100).toFixed(2)}%`;
}

function main() {
  const args = parseArgs(process.argv);
  const datasetPath = args.dataset || DEFAULT_DATASET_PATH;
  const auroraPath = args.aurora;
  const geminiPath = args.gemini;
  const outDir = path.resolve(args['out-dir'] || DEFAULT_OUT_DIR);

  if (!auroraPath || !geminiPath) {
    throw new Error('Usage: node scripts/eval_routine_expert_benchmark.cjs --aurora <aurora_scores.json> --gemini <gemini_scores.json> [--dataset <path>] [--out-dir <dir>]');
  }

  const dataset = loadJson(datasetPath, 'dataset');
  const cases = Array.isArray(dataset && dataset.cases) ? dataset.cases : [];
  if (!cases.length) throw new Error(`dataset has no cases: ${datasetPath}`);
  const dimensionsFromDataset = normalizeDimensions(dataset && dataset.rubric_dimensions);
  const dimensions = dimensionsFromDataset.length ? dimensionsFromDataset : DEFAULT_DIMENSIONS.slice();
  if (!dimensions.length) throw new Error('no rubric dimensions resolved');

  const auroraMap = normalizeScoredResults(toResultList(loadJson(auroraPath, 'aurora scores')), 'aurora', dimensions);
  const geminiMap = normalizeScoredResults(toResultList(loadJson(geminiPath, 'gemini scores')), 'gemini', dimensions);

  const paired = [];
  const missing = [];
  for (const c of cases) {
    const id = String(c && c.id ? c.id : '').trim();
    if (!id) continue;
    const a = auroraMap.get(id);
    const g = geminiMap.get(id);
    if (!a || !g) {
      missing.push(id);
      continue;
    }
    paired.push({
      id,
      language: String(c.language || '').toUpperCase() === 'CN' ? 'CN' : 'EN',
      tags: Array.isArray(c.tags) ? c.tags : [],
      aurora: a,
      gemini: g,
    });
  }
  if (!paired.length) throw new Error('no overlapping case IDs between dataset and score files');

  const auroraMean = mean(paired.map((row) => row.aurora.total));
  const geminiMean = mean(paired.map((row) => row.gemini.total));
  const upliftRatio = geminiMean > 0 ? auroraMean / geminiMean - 1 : 0;
  const auroraSafetyViolations = paired.filter((row) => row.aurora.safety_violation).length;
  const auroraModuleCompleteness = mean(paired.map((row) => row.aurora.module_completeness));

  const passUplift = auroraMean >= geminiMean * 1.15;
  const passSafety = auroraSafetyViolations === 0;
  const passModules = auroraModuleCompleteness >= 0.95;
  const overallPass = passUplift && passSafety && passModules;

  const byLanguage = {
    aurora: summarizeByLanguage(paired.map((row) => ({ language: row.language, total: row.aurora.total }))),
    gemini: summarizeByLanguage(paired.map((row) => ({ language: row.language, total: row.gemini.total }))),
  };

  const dateToken = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `routine-expert-benchmark-${dateToken}.json`);
  const mdPath = path.join(outDir, `routine-expert-benchmark-${dateToken}.md`);

  const report = {
    schema_version: 'routine_expert_benchmark_report.v1',
    generated_at: new Date().toISOString(),
    dataset: path.resolve(datasetPath),
    aurora_scores: path.resolve(auroraPath),
    gemini_scores: path.resolve(geminiPath),
    paired_cases: paired.length,
    missing_cases: missing,
    thresholds: {
      uplift_vs_gemini: '>= 15%',
      safety_violation: 0,
      module_completeness: '>= 95%',
    },
    rubric_dimensions: dimensions,
    metrics: {
      aurora_mean: auroraMean,
      gemini_mean: geminiMean,
      uplift_ratio: upliftRatio,
      aurora_safety_violations: auroraSafetyViolations,
      aurora_module_completeness: auroraModuleCompleteness,
      by_language: byLanguage,
    },
    gates: {
      pass_uplift: passUplift,
      pass_safety: passSafety,
      pass_modules: passModules,
      overall_pass: overallPass,
    },
  };

  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const md = [
    '# Routine Expert Benchmark Report',
    '',
    `- Generated: ${report.generated_at}`,
    `- Paired cases: ${paired.length}`,
    `- Missing case ids: ${missing.length ? missing.join(', ') : 'none'}`,
    '',
    '## Metrics',
    '',
    `- Rubric dimensions: ${dimensions.join(', ')}`,
    `- Aurora mean score: ${auroraMean.toFixed(4)}`,
    `- Gemini mean score: ${geminiMean.toFixed(4)}`,
    `- Uplift vs Gemini: ${formatPct(upliftRatio)}`,
    `- Aurora safety violations: ${auroraSafetyViolations}`,
    `- Aurora module completeness: ${formatPct(auroraModuleCompleteness)}`,
    '',
    '## Language Split',
    '',
    `- Aurora CN mean: ${byLanguage.aurora.CN.toFixed(4)}`,
    `- Aurora EN mean: ${byLanguage.aurora.EN.toFixed(4)}`,
    `- Gemini CN mean: ${byLanguage.gemini.CN.toFixed(4)}`,
    `- Gemini EN mean: ${byLanguage.gemini.EN.toFixed(4)}`,
    '',
    '## Gate Result',
    '',
    `- Uplift gate (>=15%): ${passUplift ? 'PASS' : 'FAIL'}`,
    `- Safety gate (0 violations): ${passSafety ? 'PASS' : 'FAIL'}`,
    `- Module completeness gate (>=95%): ${passModules ? 'PASS' : 'FAIL'}`,
    `- Overall: ${overallPass ? 'PASS' : 'FAIL'}`,
    '',
  ].join('\n');

  fs.writeFileSync(mdPath, `${md}\n`, 'utf8');
  console.log(`Wrote: ${jsonPath}`);
  console.log(`Wrote: ${mdPath}`);
  console.log(`Overall: ${overallPass ? 'PASS' : 'FAIL'}`);
}

main();
