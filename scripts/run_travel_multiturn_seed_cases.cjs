#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATASET = path.join(ROOT, 'tests', 'golden', 'aurora_travel_efgh_4.jsonl');
const DEFAULT_RUNS_DIR = path.join(ROOT, 'reports', 'travel-expert-multiturn', 'runs');
const DEFAULT_BASE_URL = process.env.BASE_URL || 'https://pivota-agent-production.up.railway.app';

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

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function relativeToRoot(absPath) {
  const rel = path.relative(ROOT, absPath);
  return rel && !rel.startsWith('..') ? rel : absPath;
}

function parseLastJsonLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const row = lines[i];
    if (!row.startsWith('{') || !row.endsWith('}')) continue;
    try {
      return JSON.parse(row);
    } catch (_err) {
      continue;
    }
  }
  return null;
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

function uniqueReasons(turnResults) {
  const out = new Set();
  for (const turn of Array.isArray(turnResults) ? turnResults : []) {
    for (const err of Array.isArray(turn && turn.errors) ? turn.errors : []) {
      const token = String(err || '').trim();
      if (!token) continue;
      out.add(token.slice(0, 220));
    }
  }
  return Array.from(out);
}

function buildRunReport({ gateReport, gateReportPath, datasetPath, baseUrl }) {
  const aliasMap = {
    travel_mt_001: 'E',
    travel_mt_002: 'F',
    travel_mt_003: 'G',
    travel_mt_004: 'H',
  };
  const rows = Array.isArray(gateReport && gateReport.results) ? gateReport.results : [];
  const cases = rows.map((row) => {
    const turns = Array.isArray(row && row.turn_results) ? row.turn_results : [];
    const totalTurns = turns.length;
    const okTurns = turns.filter((t) => Number(t && t.status) === 200).length;
    const contractPassTurns = turns.filter((t) => Boolean(t && t.passed)).length;
    return {
      id: String(row && row.case_id ? row.case_id : ''),
      alias: aliasMap[String(row && row.case_id ? row.case_id : '')] || '?',
      category: String(row && row.category ? row.category : ''),
      language: String(row && row.language ? row.language : '').toUpperCase() || 'EN',
      total_turns: totalTurns,
      ok_turns: okTurns,
      contract_pass_turns: contractPassTurns,
      failed: !Boolean(row && row.passed),
      critical_fail_reasons: uniqueReasons(turns),
      turns: turns.map((t) => ({
        turn_id: String(t && t.turn_id ? t.turn_id : ''),
        status: Number(t && t.status ? t.status : 0),
        ok: Number(t && t.status ? t.status : 0) === 200,
        contract_pass: Boolean(t && t.passed),
        errors: Array.isArray(t && t.errors) ? t.errors : [],
        warnings: Array.isArray(t && t.warnings) ? t.warnings : [],
        card_types: Array.isArray(t && t.card_types) ? t.card_types : [],
        event_names: Array.isArray(t && t.event_names) ? t.event_names : [],
        assistant_message: typeof (t && t.assistant_message) === 'string' ? t.assistant_message : '',
        response_body: t && t.response_body && typeof t.response_body === 'object' ? t.response_body : {},
        meta: t && t.meta && typeof t.meta === 'object' ? t.meta : null,
      })),
    };
  });

  const turnsTotal = cases.reduce((sum, c) => sum + Number(c.total_turns || 0), 0);
  const transportOkTurns = cases.reduce((sum, c) => sum + Number(c.ok_turns || 0), 0);
  const contractPassTurns = cases.reduce((sum, c) => sum + Number(c.contract_pass_turns || 0), 0);
  const failedCases = cases.filter((c) => c.failed).length;

  return {
    schema_version: 'travel_expert_multiturn_run.v2',
    generated_at: new Date().toISOString(),
    base_url: String(baseUrl || ''),
    dataset_path: relativeToRoot(datasetPath),
    gate_report_path: relativeToRoot(gateReportPath),
    summary: {
      total_cases: cases.length,
      failed_cases: failedCases,
      passed_cases: cases.length - failedCases,
      total_turns: turnsTotal,
      transport_success_rate: turnsTotal > 0 ? transportOkTurns / turnsTotal : 0,
      contract_pass_rate: turnsTotal > 0 ? contractPassTurns / turnsTotal : 0,
    },
    cases,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const datasetPath = path.resolve(ROOT, String(args.dataset || DEFAULT_DATASET));
  const outDir = path.resolve(ROOT, String(args['out-dir'] || DEFAULT_RUNS_DIR));
  const baseUrl = String(args['base-url'] || DEFAULT_BASE_URL).trim();
  const chatRetries = String(args['chat-retries'] || '2');
  const retryBackoffMs = String(args['retry-backoff-ms'] || '1200');
  const strictMeta = String(args['strict-meta'] || 'true');

  if (!fs.existsSync(datasetPath)) {
    throw new Error(`dataset not found: ${datasetPath}`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const gateScriptPath = path.join(ROOT, 'scripts', 'aurora_travel_gate.js');
  const gateArgs = [
    gateScriptPath,
    '--mode', 'staging-live',
    '--base', baseUrl,
    '--cases', datasetPath,
    '--expected-count', '4',
    '--report-dir', outDir,
    '--report-prefix', 'aurora_travel_efgh_gate',
    '--strict-meta', strictMeta,
    '--live-retry-count', chatRetries,
    '--live-retry-backoff-ms', retryBackoffMs,
  ];

  const run = spawnSync(process.execPath, gateArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const parsed = parseLastJsonLine(run.stdout);
  if (!parsed || !parsed.report_json) {
    const errTail = String(run.stderr || '').trim().slice(-1200);
    const outTail = String(run.stdout || '').trim().slice(-1200);
    throw new Error(`failed to parse gate output JSON.\nstdout_tail=${outTail}\nstderr_tail=${errTail}`);
  }

  const gateReportPath = path.resolve(ROOT, String(parsed.report_json));
  const gateReport = readJson(gateReportPath, 'gate report');
  const runReport = buildRunReport({
    gateReport,
    gateReportPath,
    datasetPath,
    baseUrl,
  });

  const token = nowStamp();
  const runPath = path.join(outDir, `multiturn-run-${token}.json`);
  fs.writeFileSync(runPath, `${JSON.stringify(runReport, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `${JSON.stringify({
      run_report: runPath,
      gate_report: gateReportPath,
      summary: runReport.summary,
      gate_exit_code: Number(run.status || 0),
    })}\n`,
  );

  if (run.status && run.status !== 0) {
    process.exit(Number(run.status));
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[run_travel_multiturn_seed_cases] fatal: ${String(err && err.stack ? err.stack : err)}\n`);
    process.exit(1);
  }
}
