#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  normalizeRuntimeShadowEvent,
} = require('../src/modules/signals/readiness/buildGatewayGovernanceShadowSummary');

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !String(next).startsWith('--')) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch (_error) {
    return null;
  }
}

function unwrapRailwayRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const message = String(record.message || '').trim();
  if (!message || !message.startsWith('{')) return record;

  const parsedMessage = parseJsonLine(message);
  if (!parsedMessage || typeof parsedMessage !== 'object' || Array.isArray(parsedMessage)) {
    return record;
  }

  return {
    ...record,
    ...parsedMessage,
    message,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..');
  const railwayBin = String(args['railway-bin'] || process.env.RAILWAY_BIN || 'railway').trim();
  const outPath = path.resolve(
    String(
      args.out || path.join(repoRoot, 'tmp', 'gateway_governance_raw_log_export.ndjson'),
    ).trim(),
  );
  const metadataOutPath = args['metadata-out']
    ? path.resolve(String(args['metadata-out']).trim())
    : null;
  const project = String(
    args.project ||
      process.env.GATEWAY_GOVERNANCE_RAILWAY_PROJECT ||
      'Pivota Agent',
  ).trim();
  const environment = String(
    args.environment ||
      process.env.GATEWAY_GOVERNANCE_RAILWAY_ENVIRONMENT ||
      'production',
  ).trim();
  const service = String(
    args.service ||
      process.env.GATEWAY_GOVERNANCE_RAILWAY_SERVICE ||
      'PIVOTA-Agent',
  ).trim();
  const workspace = String(
    args.workspace || process.env.GATEWAY_GOVERNANCE_RAILWAY_WORKSPACE || '',
  ).trim();
  const lines = toPositiveInteger(
    args.lines || process.env.GATEWAY_GOVERNANCE_FETCH_LINES,
    500,
  );
  const filter = String(
    args.filter || process.env.GATEWAY_GOVERNANCE_FETCH_FILTER || '',
  ).trim();

  if (!project) throw new Error('project is required');
  if (!environment) throw new Error('environment is required');
  if (!service) throw new Error('service is required');

  const cliEnv = { ...process.env };
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'railway-governance-link-'));
  const linkArgs = ['link', '--project', project, '--environment', environment, '--service', service];
  if (workspace) linkArgs.push('--workspace', workspace);
  execFileSync(railwayBin, linkArgs, {
    cwd: linkDir,
    env: cliEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logsArgs = ['logs', '--json', '--lines', String(lines), '--service', service, '--environment', environment];
  if (filter) logsArgs.push('--filter', filter);
  const stdout = execFileSync(railwayBin, logsArgs, {
    cwd: linkDir,
    env: cliEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, stdout || '');

  const rows = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let parsedJsonLines = 0;
  let governanceCandidateRecords = 0;
  let shadowCandidateRecords = 0;
  let nonHealthRecords = 0;

  for (const line of rows) {
    const parsed = parseJsonLine(line);
    if (!parsed) continue;
    parsedJsonLines += 1;
    const normalizedSource = unwrapRailwayRecord(parsed);
    if (
      normalizedSource &&
      typeof normalizedSource === 'object' &&
      !Array.isArray(normalizedSource)
    ) {
      const requestPath = String(normalizedSource.path || '').trim();
      if (requestPath && requestPath !== '/healthz' && requestPath !== '/metrics') {
        nonHealthRecords += 1;
      }
    }
    const normalized = normalizeRuntimeShadowEvent(normalizedSource);
    if (!normalized) continue;
    governanceCandidateRecords += 1;
    if (normalized.mode === 'shadow') shadowCandidateRecords += 1;
  }

  const payload = {
    generated_at_utc: new Date().toISOString(),
    railway_project: project,
    railway_environment: environment,
    railway_service: service,
    railway_workspace: workspace,
    lines_requested: lines,
    filter,
    out_path: outPath,
    total_log_lines: rows.length,
    parsed_json_lines: parsedJsonLines,
    governance_candidate_records: governanceCandidateRecords,
    shadow_candidate_records: shadowCandidateRecords,
    non_health_records: nonHealthRecords,
  };

  if (metadataOutPath) {
    fs.mkdirSync(path.dirname(metadataOutPath), { recursive: true });
    fs.writeFileSync(metadataOutPath, `${JSON.stringify(payload, null, 2)}\n`);
    payload.metadata_out_path = metadataOutPath;
  }

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main();
