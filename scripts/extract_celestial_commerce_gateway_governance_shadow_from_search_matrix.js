#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

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

function readJson(inputPath) {
  return JSON.parse(fs.readFileSync(inputPath, 'utf8'));
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(String(args.input || '').trim());
  const outPath = path.resolve(String(args.out || '').trim());

  if (!inputPath) throw new Error('input is required');
  if (!outPath) throw new Error('out is required');

  const payload = readJson(inputPath);
  const generatedAt = String(payload?.summary?.generated_at || '').trim() || new Date().toISOString();
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const events = [];

  for (const row of rows) {
    const governance =
      row?.gateway_governance && typeof row.gateway_governance === 'object' && !Array.isArray(row.gateway_governance)
        ? row.gateway_governance
        : null;
    if (!governance) continue;

    const mode = String(governance.mode || '').trim();
    const invocationSurface = String(governance.invocation_surface || '').trim();
    const observedAction = String(governance.observed_action || '').trim() || 'allow';
    const effectiveAction =
      String(governance.effective_action || '').trim() || (mode === 'shadow' ? 'allow' : observedAction);
    const reasonCodes = toStringArray(governance.reason_codes);

    if (!mode && !invocationSurface && reasonCodes.length === 0) continue;

    events.push({
      source: 'authoritative_commerce_smoke',
      mode: mode || 'unknown',
      invocation_surface: invocationSurface || null,
      observed_action: observedAction,
      effective_action: effectiveAction,
      would_enforce: governance.would_enforce === true,
      reason_codes: reasonCodes,
      observed_phase: String(governance.observed_phase || '').trim() || null,
      entry_layer: String(governance.entry_layer || '').trim() || null,
      request_id: `${String(row.case_id || 'case').trim() || 'case'}:${Number(row.round || 1) || 1}`,
      event_timestamp_utc: String(governance.event_timestamp_utc || '').trim() || generatedAt,
      case_id: String(row.case_id || '').trim() || null,
      family: String(row.family || '').trim() || null,
      query: String(row.query || '').trim() || null,
    });
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const output = events.map((item) => JSON.stringify(item)).join('\n');
  fs.writeFileSync(outPath, output ? `${output}\n` : '');

  const summary = {
    generated_at_utc: new Date().toISOString(),
    input_path: inputPath,
    out_path: outPath,
    total_rows: rows.length,
    governance_candidate_records: events.length,
    shadow_candidate_records: events.filter((item) => item.mode === 'shadow').length,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main();
