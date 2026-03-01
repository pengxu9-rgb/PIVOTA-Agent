#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATASET = path.join(ROOT, 'datasets', 'routine_expert_benchmark_120.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'reports', 'routine-expert');

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

function loadDataset(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`dataset not found: ${abs}`);
  const raw = fs.readFileSync(abs, 'utf8');
  const parsed = JSON.parse(raw);
  const cases = Array.isArray(parsed && parsed.cases) ? parsed.cases : [];
  if (!cases.length) throw new Error(`dataset has no cases: ${abs}`);
  const declaredTotal = Number(parsed && parsed.totals && parsed.totals.total);
  const dimensions = normalizeDimensions(parsed && parsed.rubric_dimensions);
  return {
    abs,
    cases,
    dimensions: dimensions.length ? dimensions : DEFAULT_DIMENSIONS.slice(),
    schemaVersion: String(parsed && parsed.schema_version ? parsed.schema_version : '').trim() || null,
    declaredTotal: Number.isFinite(declaredTotal) && declaredTotal > 0 ? Math.trunc(declaredTotal) : null,
  };
}

function buildTemplate(cases, provider, dimensions) {
  const lower = provider.toLowerCase();
  const scoreSkeleton = Object.fromEntries(dimensions.map((dim) => [dim, 0]));
  return {
    schema_version: 'routine_expert_scores.v1',
    provider: lower,
    template: true,
    generated_at: new Date().toISOString(),
    instructions:
      'Fill score range 0~5 for each dimension. Keep safety_violation=true when policy violation exists. modules.* should reflect module presence.',
    dimensions,
    results: cases.map((c) => ({
      id: String(c && c.id ? c.id : '').trim(),
      language: String(c && c.language ? c.language : 'EN').toUpperCase() === 'CN' ? 'CN' : 'EN',
      tags: Array.isArray(c && c.tags) ? c.tags : [],
      scores: { ...scoreSkeleton },
      safety_violation: false,
      modules: {
        key_issues: false,
        plan_7d: false,
        phase_plan: false,
        primary_question: false,
        evidence_refs: false,
      },
      notes: '',
    })),
  };
}

function writeJson(filePath, obj, { force }) {
  const abs = path.resolve(filePath);
  if (fs.existsSync(abs) && !force) {
    console.log(`Skip existing file (use --force to overwrite): ${abs}`);
    return false;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  console.log(`Wrote: ${abs}`);
  return true;
}

function main() {
  const args = parseArgs(process.argv);
  const datasetPath = args.dataset || DEFAULT_DATASET;
  const outDir = path.resolve(args['out-dir'] || DEFAULT_OUT_DIR);
  const force = String(args.force || '').toLowerCase() === 'true';

  const { abs: datasetAbs, cases, dimensions, schemaVersion, declaredTotal } = loadDataset(datasetPath);
  console.log(`Using dataset: ${datasetAbs}`);
  if (schemaVersion) console.log(`Dataset schema: ${schemaVersion}`);
  console.log(`Dimensions: ${dimensions.join(', ')}`);
  if (Number.isFinite(declaredTotal) && declaredTotal !== cases.length) {
    console.warn(`WARN totals.total(${declaredTotal}) != cases.length(${cases.length}); using cases.length.`);
  }
  console.log(`Cases: ${cases.length}`);

  const aurora = buildTemplate(cases, 'aurora', dimensions);
  const gemini = buildTemplate(cases, 'gemini', dimensions);

  writeJson(path.join(outDir, 'aurora_scores.template.json'), aurora, { force });
  writeJson(path.join(outDir, 'gemini_scores.template.json'), gemini, { force });
}

main();
