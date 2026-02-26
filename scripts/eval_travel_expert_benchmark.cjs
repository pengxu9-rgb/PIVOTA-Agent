#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_AURORA = path.join(ROOT, 'reports', 'travel-expert-multiturn', 'aurora_scores.json');
const DEFAULT_GEMINI = path.join(ROOT, 'reports', 'travel-expert-multiturn', 'gemini_scores.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'reports');

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

function readJson(absPath, label) {
  if (!fs.existsSync(absPath)) throw new Error(`${label} not found: ${absPath}`);
  const raw = fs.readFileSync(absPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} invalid JSON: ${absPath} (${err.message})`);
  }
}

function scoreVector(result) {
  const node = result && result.scores && typeof result.scores === 'object' ? result.scores : {};
  const vals = Object.values(node).map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  });
  const total = vals.reduce((sum, n) => sum + n, 0);
  const avg = vals.length ? total / vals.length : 0;
  return { total, avg, count: vals.length };
}

function aggregateReport(raw, modelName) {
  const rows = Array.isArray(raw && raw.results) ? raw.results : [];
  const cases = rows.map((row) => {
    const vec = scoreVector(row);
    return {
      id: String(row && row.id ? row.id : ''),
      total_score: vec.total,
      avg_score: vec.avg,
      safety_violation: Boolean(row && row.safety_violation),
      notes: typeof (row && row.notes) === 'string' ? row.notes : '',
    };
  });
  const totalScore = cases.reduce((sum, c) => sum + c.total_score, 0);
  const avgScore = cases.length ? totalScore / cases.length : 0;
  const safetyViolations = cases.filter((c) => c.safety_violation).length;
  return {
    model: modelName,
    case_count: cases.length,
    avg_total_score: avgScore,
    safety_violations: safetyViolations,
    cases,
  };
}

function buildMarkdown(payload) {
  const lines = [];
  lines.push('# Travel Expert Benchmark');
  lines.push('');
  lines.push(`- generated_at: ${payload.generated_at}`);
  lines.push(`- aurora_avg_total_score: ${Number(payload.aurora.avg_total_score || 0).toFixed(3)}`);
  lines.push(`- gemini_avg_total_score: ${Number(payload.gemini.avg_total_score || 0).toFixed(3)}`);
  lines.push(`- delta(aurora-gemini): ${Number(payload.delta.avg_total_score || 0).toFixed(3)}`);
  lines.push(`- aurora_safety_violations: ${payload.aurora.safety_violations}`);
  lines.push(`- gemini_safety_violations: ${payload.gemini.safety_violations}`);
  lines.push('');
  lines.push('| Case ID | Aurora | Gemini | Delta |');
  lines.push('|---|---|---|---|');
  for (const row of payload.case_deltas) {
    lines.push(
      `| ${row.id} | ${Number(row.aurora_total || 0).toFixed(2)} | ${Number(row.gemini_total || 0).toFixed(2)} | ${Number(row.delta || 0).toFixed(2)} |`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv);
  const auroraPath = path.resolve(ROOT, String(args.aurora || DEFAULT_AURORA));
  const geminiPath = path.resolve(ROOT, String(args.gemini || DEFAULT_GEMINI));
  const outDir = path.resolve(ROOT, String(args['out-dir'] || DEFAULT_OUT_DIR));
  fs.mkdirSync(outDir, { recursive: true });

  const aurora = aggregateReport(readJson(auroraPath, 'aurora score file'), 'aurora');
  const gemini = aggregateReport(readJson(geminiPath, 'gemini score file'), 'gemini');

  const byGemini = new Map(gemini.cases.map((row) => [row.id, row]));
  const ids = Array.from(new Set([...aurora.cases.map((r) => r.id), ...gemini.cases.map((r) => r.id)])).sort();
  const caseDeltas = ids.map((id) => {
    const a = aurora.cases.find((row) => row.id === id) || { total_score: 0 };
    const g = byGemini.get(id) || { total_score: 0 };
    return {
      id,
      aurora_total: a.total_score,
      gemini_total: g.total_score,
      delta: Number(a.total_score || 0) - Number(g.total_score || 0),
    };
  });

  const dateToken = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const payload = {
    schema_version: 'travel_expert_benchmark_eval.v1',
    generated_at: new Date().toISOString(),
    aurora,
    gemini,
    delta: {
      avg_total_score: Number(aurora.avg_total_score || 0) - Number(gemini.avg_total_score || 0),
      safety_violations: Number(aurora.safety_violations || 0) - Number(gemini.safety_violations || 0),
    },
    case_deltas: caseDeltas,
  };

  const jsonPath = path.join(outDir, `travel-expert-benchmark-${dateToken}.json`);
  const mdPath = path.join(outDir, `travel-expert-benchmark-${dateToken}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, buildMarkdown(payload), 'utf8');

  process.stdout.write(`${JSON.stringify({ json: jsonPath, md: mdPath })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[eval_travel_expert_benchmark] fatal: ${String(err && err.stack ? err.stack : err)}\n`);
    process.exit(1);
  }
}
