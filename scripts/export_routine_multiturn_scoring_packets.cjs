#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATASET_PATH = path.join(ROOT, 'datasets', 'routine_expert_multiturn_seed.json');
const DEFAULT_RUNS_DIR = path.join(ROOT, 'reports', 'routine-expert-multiturn', 'runs');
const DEFAULT_OUT_ROOT = path.join(ROOT, 'reports', 'routine-expert-multiturn', 'scoring-packets');

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
  if (!fs.existsSync(absPath)) {
    throw new Error(`${label} not found: ${absPath}`);
  }
  const raw = fs.readFileSync(absPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} invalid JSON: ${absPath} (${err.message})`);
  }
}

function sha256File(absPath) {
  const bytes = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function relativeToRoot(absPath) {
  const rel = path.relative(ROOT, absPath);
  return rel && !rel.startsWith('..') ? rel : absPath;
}

function resolveLatestRunPath(runsDir) {
  if (!fs.existsSync(runsDir)) {
    throw new Error(`runs directory not found: ${runsDir}`);
  }
  const entries = fs
    .readdirSync(runsDir)
    .filter((name) => /^multiturn-run-\d{8}_\d{6}\.json$/.test(name))
    .map((name) => {
      const abs = path.join(runsDir, name);
      const stat = fs.statSync(abs);
      return { name, abs, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));

  if (!entries.length) {
    throw new Error(`no run report found in: ${runsDir}`);
  }
  return entries[0].abs;
}

function safeText(v) {
  return typeof v === 'string' ? v : '';
}

function caseFileName(id) {
  return String(id || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 120);
}

function deriveRunToken(runPath) {
  const base = path.basename(runPath);
  const m = base.match(/^multiturn-run-(\d{8}_\d{6})\.json$/);
  if (m && m[1]) return m[1];
  return new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
}

function buildDatasetIndex(dataset) {
  const cases = Array.isArray(dataset && dataset.cases) ? dataset.cases : [];
  const map = new Map();
  for (const c of cases) {
    const id = String(c && c.id ? c.id : '').trim();
    if (!id) continue;
    map.set(id, c);
  }
  return map;
}

function normalizeCards(cards) {
  const rows = Array.isArray(cards) ? cards : [];
  return rows.map((card) => ({
    type: safeText(card && card.type),
    title: safeText(card && card.title),
    text: safeText(card && card.text),
  }));
}

function toTurnPacket(runTurn, datasetTurn) {
  const response = runTurn && typeof runTurn.response === 'object' ? runTurn.response : null;
  const cards = response && Array.isArray(response.cards) ? response.cards : [];
  const assistantMessage =
    response &&
    response.assistant_message &&
    typeof response.assistant_message === 'object' &&
    typeof response.assistant_message.content === 'string'
      ? response.assistant_message.content
      : '';

  return {
    turn_id: Number(runTurn && runTurn.turn_id),
    user: safeText(runTurn && runTurn.user),
    user_intent: safeText(datasetTurn && datasetTurn.user_intent),
    expected_context_write: Array.isArray(datasetTurn && datasetTurn.expected_context_write)
      ? datasetTurn.expected_context_write
      : [],
    expected_agent_contract: Array.isArray(datasetTurn && datasetTurn.expected_agent_contract)
      ? datasetTurn.expected_agent_contract
      : [],
    status: Number(runTurn && runTurn.status),
    ok: Boolean(runTurn && runTurn.ok),
    latency_ms: Number(runTurn && runTurn.latency_ms),
    attempts: Number(runTurn && runTurn.attempts),
    request_state: safeText(runTurn && runTurn.request_state),
    response_state: safeText(runTurn && runTurn.response_state),
    cards_count: Number(runTurn && runTurn.cards_count),
    card_types: cards.map((c) => safeText(c && c.type)).filter(Boolean),
    cards_preview: normalizeCards(cards),
    assistant_message: assistantMessage,
    response_raw: response,
    error: runTurn && runTurn.error ? String(runTurn.error) : null,
    contract_pass: Boolean(runTurn && runTurn.contract_pass),
    stall_hit: Boolean(runTurn && runTurn.stall_hit),
    missing_modules: Array.isArray(runTurn && runTurn.missing_modules) ? runTurn.missing_modules : [],
    critical_fail_reasons: Array.isArray(runTurn && runTurn.critical_fail_reasons) ? runTurn.critical_fail_reasons : [],
    contract_clause_total: Number(runTurn && runTurn.contract_clause_total),
    contract_clause_hit_count: Number(runTurn && runTurn.contract_clause_hit_count),
    contract_clause_hit_rate: Number(runTurn && runTurn.contract_clause_hit_rate),
    contract_clause_min_pass: Number(runTurn && runTurn.contract_clause_min_pass),
    contract_clause_checks: Array.isArray(runTurn && runTurn.contract_clause_checks) ? runTurn.contract_clause_checks : [],
  };
}

function buildPacket({ runReport, runPath, dataset, datasetPath }) {
  const datasetIndex = buildDatasetIndex(dataset);
  const runCases = Array.isArray(runReport && runReport.cases) ? runReport.cases : [];
  const casePackets = [];
  let turnsTotal = 0;

  for (const runCase of runCases) {
    const caseId = String(runCase && runCase.id ? runCase.id : '').trim();
    const datasetCase = datasetIndex.get(caseId) || null;
    const datasetTurns = Array.isArray(datasetCase && datasetCase.conversation) ? datasetCase.conversation : [];
    const runTurns = Array.isArray(runCase && runCase.turns) ? runCase.turns : [];
    const turnPackets = runTurns.map((turn) => {
      const match = datasetTurns.find((t) => Number(t && t.turn_id) === Number(turn && turn.turn_id)) || null;
      return toTurnPacket(turn, match);
    });
    turnsTotal += turnPackets.length;

    const criticalReasons = new Set();
    let stallTurns = 0;
    let missingModulesTurns = 0;
    let contractPassTurns = 0;
    for (const turn of turnPackets) {
      if (turn.contract_pass) contractPassTurns += 1;
      if (turn.stall_hit) stallTurns += 1;
      if (Array.isArray(turn.missing_modules) && turn.missing_modules.length > 0) missingModulesTurns += 1;
      for (const reason of Array.isArray(turn.critical_fail_reasons) ? turn.critical_fail_reasons : []) {
        criticalReasons.add(String(reason || 'unknown'));
      }
    }

    casePackets.push({
      id: caseId,
      language: safeText(runCase && runCase.language),
      scenario_key: safeText(runCase && runCase.scenario_key),
      tags: Array.isArray(datasetCase && datasetCase.tags) ? datasetCase.tags : [],
      seed_profile: datasetCase && datasetCase.seed_profile ? datasetCase.seed_profile : null,
      final_expectations: datasetCase && datasetCase.final_expectations ? datasetCase.final_expectations : null,
      scoring_hooks: datasetCase && datasetCase.scoring_hooks ? datasetCase.scoring_hooks : null,
      profile_update_ok: Boolean(runCase && runCase.profile_update && runCase.profile_update.ok),
      profile_update_status: Number(runCase && runCase.profile_update && runCase.profile_update.status),
      total_turns: Number(runCase && runCase.total_turns),
      ok_turns: Number(runCase && runCase.ok_turns),
      contract_pass_turns: contractPassTurns,
      stall_turns: stallTurns,
      missing_modules_turns: missingModulesTurns,
      critical_fail_reasons: Array.from(criticalReasons),
      case_contract_pass: turnPackets.length > 0 && turnPackets.every((row) => row.contract_pass),
      final_state: safeText(runCase && runCase.final_state),
      turns: turnPackets,
    });
  }

  return {
    schema_version: 'routine_expert_multiturn_scoring_packet.v2',
    compat: { v1_fields_present: true },
    generated_at: new Date().toISOString(),
    source: {
      run_report: relativeToRoot(runPath),
      dataset: relativeToRoot(datasetPath),
      run_report_sha256: sha256File(runPath),
      dataset_sha256: sha256File(datasetPath),
      run_schema_version: safeText(runReport && runReport.schema_version),
      dataset_schema_version: safeText(dataset && dataset.schema_version),
    },
    summary: runReport && runReport.summary ? runReport.summary : null,
    case_count: casePackets.length,
    turn_count: turnsTotal,
    rubric_dimensions: Array.isArray(dataset && dataset.rubric_dimensions) ? dataset.rubric_dimensions : [],
    cases: casePackets,
  };
}

function mdList(title, rows) {
  const arr = Array.isArray(rows) ? rows : [];
  if (!arr.length) return `${title}: none`;
  const lines = [title];
  for (const row of arr) lines.push(`- ${row}`);
  return lines.join('\n');
}

function toBundleMarkdown(packet) {
  const lines = [];
  lines.push('# Routine Expert Multiturn Scoring Bundle');
  lines.push('');
  lines.push(`- Generated: ${packet.generated_at}`);
  lines.push(`- Run report: ${packet.source.run_report}`);
  lines.push(`- Dataset: ${packet.source.dataset}`);
  lines.push(`- Run report sha256: ${packet.source.run_report_sha256}`);
  lines.push(`- Dataset sha256: ${packet.source.dataset_sha256}`);
  lines.push(`- Cases: ${packet.case_count}`);
  lines.push(`- Turns: ${packet.turn_count}`);
  lines.push('');
  if (packet.summary) {
    lines.push('## Run Summary');
    lines.push('');
    for (const [k, v] of Object.entries(packet.summary)) {
      lines.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
    }
    lines.push('');
  }

  for (const c of packet.cases) {
    lines.push(`## Case ${c.id} (${c.language || 'NA'})`);
    lines.push('');
    lines.push(`- scenario_key: ${c.scenario_key || 'NA'}`);
    lines.push(`- tags: ${(c.tags || []).join(', ') || 'none'}`);
    lines.push(`- profile_update_ok: ${c.profile_update_ok}`);
    lines.push(`- transport_ok: ${c.ok_turns}/${c.total_turns}`);
    lines.push(`- contract_pass: ${c.contract_pass_turns}/${c.total_turns}`);
    lines.push(`- stall_turns: ${c.stall_turns}`);
    lines.push(`- missing_modules_turns: ${c.missing_modules_turns}`);
    lines.push(`- critical_fail_reasons: ${(c.critical_fail_reasons || []).join(', ') || 'none'}`);
    lines.push('');

    for (const t of c.turns) {
      lines.push(`### Turn ${Number.isFinite(t.turn_id) ? t.turn_id : '?'}`);
      lines.push('');
      lines.push(`- status: ${t.status} ok=${t.ok} latency_ms=${t.latency_ms} attempts=${t.attempts}`);
      lines.push(`- states: ${t.request_state || 'NA'} -> ${t.response_state || 'NA'}`);
      lines.push(`- cards: ${t.cards_count} (${(t.card_types || []).join(', ') || 'none'})`);
      lines.push(`- user_intent: ${t.user_intent || 'NA'}`);
      lines.push(`- contract_pass: ${t.contract_pass} stall_hit=${t.stall_hit}`);
      lines.push(`- missing_modules: ${(t.missing_modules || []).join(', ') || 'none'}`);
      lines.push(`- critical_fail_reasons: ${(t.critical_fail_reasons || []).join(', ') || 'none'}`);
      lines.push('');
      lines.push('User:');
      lines.push('');
      lines.push(t.user || '');
      lines.push('');
      lines.push('Assistant:');
      lines.push('');
      lines.push(t.assistant_message || '');
      lines.push('');
      lines.push(mdList('Expected context write', t.expected_context_write));
      lines.push('');
      lines.push(mdList('Expected agent contract', t.expected_agent_contract));
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

function toCaseMarkdown(c) {
  const lines = [];
  lines.push(`# Case ${c.id}`);
  lines.push('');
  lines.push(`- language: ${c.language || 'NA'}`);
  lines.push(`- scenario_key: ${c.scenario_key || 'NA'}`);
  lines.push(`- tags: ${(c.tags || []).join(', ') || 'none'}`);
  lines.push(`- transport_ok: ${c.ok_turns}/${c.total_turns}`);
  lines.push(`- contract_pass: ${c.contract_pass_turns}/${c.total_turns}`);
  lines.push(`- stall_turns: ${c.stall_turns}`);
  lines.push(`- missing_modules_turns: ${c.missing_modules_turns}`);
  lines.push(`- critical_fail_reasons: ${(c.critical_fail_reasons || []).join(', ') || 'none'}`);
  lines.push('');

  for (const t of c.turns) {
    lines.push(`## Turn ${Number.isFinite(t.turn_id) ? t.turn_id : '?'}`);
    lines.push('');
    lines.push(`- status: ${t.status} ok=${t.ok} latency_ms=${t.latency_ms} attempts=${t.attempts}`);
    lines.push(`- cards: ${t.cards_count} (${(t.card_types || []).join(', ') || 'none'})`);
    lines.push(`- user_intent: ${t.user_intent || 'NA'}`);
    lines.push(`- contract_pass: ${t.contract_pass} stall_hit=${t.stall_hit}`);
    lines.push(`- missing_modules: ${(t.missing_modules || []).join(', ') || 'none'}`);
    lines.push(`- critical_fail_reasons: ${(t.critical_fail_reasons || []).join(', ') || 'none'}`);
    lines.push('');
    lines.push('User:');
    lines.push('');
    lines.push(t.user || '');
    lines.push('');
    lines.push('Assistant:');
    lines.push('');
    lines.push(t.assistant_message || '');
    lines.push('');
    lines.push(mdList('Expected context write', t.expected_context_write));
    lines.push('');
    lines.push(mdList('Expected agent contract', t.expected_agent_contract));
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function maybeCreateZip(outDir) {
  const zipPath = `${outDir}.zip`;
  const proc = spawnSync('zip', ['-rq', zipPath, '.'], { cwd: outDir, encoding: 'utf8' });
  if (proc.status !== 0) {
    return {
      ok: false,
      zip_path: zipPath,
      error: (proc.stderr || proc.stdout || `zip exited ${proc.status}`).trim(),
    };
  }
  return {
    ok: true,
    zip_path: zipPath,
    sha256: sha256File(zipPath),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const datasetPath = path.resolve(args.dataset || DEFAULT_DATASET_PATH);
  const runPath = args.run ? path.resolve(args.run) : resolveLatestRunPath(path.resolve(args['runs-dir'] || DEFAULT_RUNS_DIR));
  const outRoot = path.resolve(args['out-dir'] || DEFAULT_OUT_ROOT);

  const dataset = readJson(datasetPath, 'dataset');
  const runReport = readJson(runPath, 'run report');
  const packet = buildPacket({ runReport, runPath, dataset, datasetPath });
  const token = deriveRunToken(runPath);
  const outDir = path.join(outRoot, token);
  fs.mkdirSync(outDir, { recursive: true });

  const bundleJsonPath = path.join(outDir, 'aurora_multiturn_scoring_bundle.json');
  const bundleMdPath = path.join(outDir, 'aurora_multiturn_scoring_bundle.md');
  fs.writeFileSync(bundleJsonPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');
  fs.writeFileSync(bundleMdPath, toBundleMarkdown(packet), 'utf8');

  const caseFiles = [];
  for (const c of packet.cases) {
    const name = caseFileName(c.id || 'unknown_case');
    const mdPath = path.join(outDir, `case-${name}.md`);
    const jsonPath = path.join(outDir, `case-${name}.json`);
    fs.writeFileSync(mdPath, toCaseMarkdown(c), 'utf8');
    fs.writeFileSync(jsonPath, `${JSON.stringify(c, null, 2)}\n`, 'utf8');
    caseFiles.push({
      id: c.id,
      markdown: relativeToRoot(mdPath),
      json: relativeToRoot(jsonPath),
      markdown_sha256: sha256File(mdPath),
      json_sha256: sha256File(jsonPath),
    });
  }

  const checksums = {
    bundle_json: sha256File(bundleJsonPath),
    bundle_markdown: sha256File(bundleMdPath),
  };

  const zipResult = maybeCreateZip(outDir);

  const manifest = {
    schema_version: 'routine_expert_multiturn_scoring_manifest.v2',
    compat: { v1_fields_present: true },
    generated_at: new Date().toISOString(),
    source_run_report: relativeToRoot(runPath),
    source_dataset: relativeToRoot(datasetPath),
    source_run_report_sha256: sha256File(runPath),
    source_dataset_sha256: sha256File(datasetPath),
    output_dir: relativeToRoot(outDir),
    bundle_json: relativeToRoot(bundleJsonPath),
    bundle_markdown: relativeToRoot(bundleMdPath),
    checksums,
    case_files: caseFiles,
    zip: {
      ok: zipResult.ok,
      path: relativeToRoot(zipResult.zip_path),
      sha256: zipResult.sha256 || null,
      error: zipResult.error || null,
    },
  };
  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`[multiturn-export] run_report=${runPath}`);
  console.log(`[multiturn-export] dataset=${datasetPath}`);
  console.log(`[multiturn-export] out_dir=${outDir}`);
  console.log(`[multiturn-export] bundle_json=${bundleJsonPath}`);
  console.log(`[multiturn-export] bundle_markdown=${bundleMdPath}`);
  console.log(`[multiturn-export] manifest=${manifestPath}`);
  if (zipResult.ok) console.log(`[multiturn-export] zip=${zipResult.zip_path}`);
  else console.log(`[multiturn-export] zip_failed=${zipResult.error}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[multiturn-export] fatal=${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  }
}

module.exports = {
  __internal: {
    buildPacket,
    normalizeCards,
    toTurnPacket,
    relativeToRoot,
    sha256File,
    maybeCreateZip,
  },
};
