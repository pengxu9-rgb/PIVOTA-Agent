#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
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

function readRecords(inputPath) {
  const text = fs.readFileSync(inputPath, 'utf8');
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];

  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.ndjson' || ext === '.jsonl' || ext === '.log') {
    return trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  const parsed = JSON.parse(trimmed);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.events)) return parsed.events;
  if (Array.isArray(parsed.records)) return parsed.records;
  if (Array.isArray(parsed.runtime_events)) return parsed.runtime_events;
  if (Array.isArray(parsed.samples)) return parsed.samples;
  return [parsed];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(String(args.input || '').trim());
  const outPath = path.resolve(
    String(args.out || path.join(process.cwd(), 'tmp', 'gateway_governance_shadow_sample.ndjson')).trim(),
  );
  const mode = String(args.mode || 'shadow').trim().toLowerCase() || 'shadow';

  if (!inputPath) {
    throw new Error('--input is required');
  }
  if (!fs.existsSync(inputPath)) {
    throw new Error(`input not found: ${inputPath}`);
  }

  const rows = readRecords(inputPath);
  const extracted = [];
  let ignored = 0;
  let filteredNonShadow = 0;

  for (const row of rows) {
    const normalized = normalizeRuntimeShadowEvent(row);
    if (!normalized) {
      ignored += 1;
      continue;
    }
    if (mode === 'shadow' && normalized.mode !== 'shadow') {
      filteredNonShadow += 1;
      continue;
    }
    extracted.push(normalized);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const ndjson = extracted.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(outPath, ndjson ? `${ndjson}\n` : '');

  process.stdout.write(
    `${JSON.stringify({
      input_path: inputPath,
      out_path: outPath,
      mode,
      total_records: rows.length,
      extracted_records: extracted.length,
      filtered_non_shadow_records: filteredNonShadow,
      ignored_records: ignored,
    })}\n`,
  );
}

main();
