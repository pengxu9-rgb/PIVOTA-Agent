#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

function parseArgs(argv) {
  const out = {
    storeDir: '',
    hardCasesPath: '',
    outDir: '',
    date: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--store-dir' && next) {
      out.storeDir = next;
      i += 1;
      continue;
    }
    if (token === '--hard-cases' && next) {
      out.hardCasesPath = next;
      i += 1;
      continue;
    }
    if (token === '--out-dir' && next) {
      out.outDir = next;
      i += 1;
      continue;
    }
    if (token === '--date' && next) {
      out.date = next;
      i += 1;
      continue;
    }
  }
  return out;
}

function todayKeyUtc() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function normalizeDateKey(input) {
  const raw = String(input || '').trim();
  if (!raw) return todayKeyUtc();
  if (/^\d{8}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.replace(/-/g, '');
  throw new Error(`invalid --date value: ${input}`);
}

function datePrefix(dateKey) {
  return `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
}

async function readNdjson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_err) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_err) {
    return [];
  }
}

function toNumber(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric;
}

function round3(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(3));
}

function mean(values) {
  const nums = values.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return round3(nums.reduce((acc, v) => acc + v, 0) / nums.length);
}

function keyForSlice(slice) {
  return [
    slice.issue_type,
    slice.quality_grade,
    slice.tone_bucket,
    slice.lighting_bucket,
    slice.device_class,
  ].join('||');
}

function defaultToken(value, fallback = 'unknown') {
  const token = String(value || '').trim();
  return token || fallback;
}

function resolveDeviceClass(record) {
  const output = record && typeof record.output_json === 'object' ? record.output_json : {};
  const derived = record && typeof record.derived_features === 'object' ? record.derived_features : {};
  return defaultToken(output.device_class || derived.device_class || record.device_class, 'unknown');
}

function buildModelSlices(modelOutputs, dayPrefix) {
  const byInference = new Map();
  const rows = [];

  for (const row of modelOutputs) {
    const createdAt = String(row.created_at || '');
    if (!createdAt.startsWith(dayPrefix)) continue;

    const inferenceId = defaultToken(row.inference_id, 'unknown_inference');
    const quality = defaultToken(row.quality_grade, 'unknown');
    const tone = defaultToken(row.skin_tone_bucket, 'unknown');
    const lighting = defaultToken(row.lighting_bucket, 'unknown');
    const device = resolveDeviceClass(row);

    if (!byInference.has(inferenceId)) {
      byInference.set(inferenceId, {
        quality_grade: quality,
        tone_bucket: tone,
        lighting_bucket: lighting,
        device_class: device,
      });
    }

    const concerns = Array.isArray(row?.output_json?.concerns) ? row.output_json.concerns : [];
    if (!concerns.length) {
      rows.push({
        issue_type: 'none',
        quality_grade: quality,
        tone_bucket: tone,
        lighting_bucket: lighting,
        device_class: device,
        confidence: null,
        severity: null,
      });
      continue;
    }

    for (const concern of concerns) {
      rows.push({
        issue_type: defaultToken(concern?.type, 'other'),
        quality_grade: quality,
        tone_bucket: tone,
        lighting_bucket: lighting,
        device_class: device,
        confidence: toNumber(concern?.confidence),
        severity: toNumber(concern?.severity),
      });
    }
  }

  const agg = new Map();
  for (const row of rows) {
    const key = keyForSlice(row);
    if (!agg.has(key)) {
      agg.set(key, {
        issue_type: row.issue_type,
        quality_grade: row.quality_grade,
        tone_bucket: row.tone_bucket,
        lighting_bucket: row.lighting_bucket,
        device_class: row.device_class,
        count: 0,
        confidences: [],
        severities: [],
      });
    }
    const entry = agg.get(key);
    entry.count += 1;
    if (Number.isFinite(row.confidence)) entry.confidences.push(row.confidence);
    if (Number.isFinite(row.severity)) entry.severities.push(row.severity);
  }

  const slices = Array.from(agg.values())
    .map((entry) => ({
      issue_type: entry.issue_type,
      quality_grade: entry.quality_grade,
      tone_bucket: entry.tone_bucket,
      lighting_bucket: entry.lighting_bucket,
      device_class: entry.device_class,
      count: entry.count,
      confidence_avg: mean(entry.confidences),
      severity_avg: mean(entry.severities),
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return keyForSlice(a).localeCompare(keyForSlice(b));
    });

  return {
    slices,
    byInference,
    raw_rows: rows.length,
  };
}

function buildAgreementSlices(agreementSamples, dayPrefix, inferenceMeta) {
  const rows = [];

  for (const sample of agreementSamples) {
    const createdAt = String(sample.created_at || '');
    if (!createdAt.startsWith(dayPrefix)) continue;

    const inferenceId = defaultToken(sample.inference_id, 'unknown_inference');
    const quality = defaultToken(sample.quality_grade, 'unknown');
    const tone = defaultToken(sample.skin_tone_bucket, 'unknown');
    const lighting = defaultToken(sample.lighting_bucket, 'unknown');
    const inferred = inferenceMeta.get(inferenceId) || {};
    const device = defaultToken(sample.device_class || inferred.device_class, 'unknown');

    const metrics = sample && typeof sample.metrics === 'object' ? sample.metrics : {};
    const byType = Array.isArray(metrics.by_type) ? metrics.by_type : [];
    const overall = toNumber(metrics.overall, null);

    if (!byType.length) {
      rows.push({
        inference_id: inferenceId,
        issue_type: 'none',
        quality_grade: quality,
        tone_bucket: tone,
        lighting_bucket: lighting,
        device_class: device,
        agreement_overall: overall,
        iou: null,
        severity_mae: null,
        interval_overlap: null,
      });
      continue;
    }

    for (const item of byType) {
      rows.push({
        inference_id: inferenceId,
        issue_type: defaultToken(item?.type, 'other'),
        quality_grade: quality,
        tone_bucket: tone,
        lighting_bucket: lighting,
        device_class: device,
        agreement_overall: overall,
        iou: toNumber(item?.iou),
        severity_mae: toNumber(item?.severity_mae),
        interval_overlap: toNumber(item?.interval_overlap),
      });
    }
  }

  const agg = new Map();
  for (const row of rows) {
    const key = keyForSlice(row);
    if (!agg.has(key)) {
      agg.set(key, {
        issue_type: row.issue_type,
        quality_grade: row.quality_grade,
        tone_bucket: row.tone_bucket,
        lighting_bucket: row.lighting_bucket,
        device_class: row.device_class,
        count: 0,
        agreement: [],
        iou: [],
        severity_mae: [],
        interval_overlap: [],
      });
    }
    const entry = agg.get(key);
    entry.count += 1;
    if (Number.isFinite(row.agreement_overall)) entry.agreement.push(row.agreement_overall);
    if (Number.isFinite(row.iou)) entry.iou.push(row.iou);
    if (Number.isFinite(row.severity_mae)) entry.severity_mae.push(row.severity_mae);
    if (Number.isFinite(row.interval_overlap)) entry.interval_overlap.push(row.interval_overlap);
  }

  const slices = Array.from(agg.values())
    .map((entry) => ({
      issue_type: entry.issue_type,
      quality_grade: entry.quality_grade,
      tone_bucket: entry.tone_bucket,
      lighting_bucket: entry.lighting_bucket,
      device_class: entry.device_class,
      count: entry.count,
      agreement_overall_avg: mean(entry.agreement),
      iou_avg: mean(entry.iou),
      severity_mae_avg: mean(entry.severity_mae),
      interval_overlap_avg: mean(entry.interval_overlap),
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return keyForSlice(a).localeCompare(keyForSlice(b));
    });

  return {
    slices,
    raw_rows: rows.length,
    rows,
  };
}

function buildTopDisagreements(rows, limit = 12) {
  const scored = [];
  for (const row of rows) {
    const iou = Number.isFinite(row.iou) ? Math.max(0, Math.min(1, row.iou)) : 1;
    const mae = Number.isFinite(row.severity_mae) ? Math.max(0, Math.min(4, row.severity_mae)) : 0;
    const overlap = Number.isFinite(row.interval_overlap) ? Math.max(0, Math.min(1, row.interval_overlap)) : 1;
    const score = round3(((1 - iou) * 0.45) + ((mae / 4) * 0.4) + ((1 - overlap) * 0.15));
    if (score <= 0) continue;
    scored.push({
      inference_id: row.inference_id,
      issue_type: row.issue_type,
      quality_grade: row.quality_grade,
      tone_bucket: row.tone_bucket,
      lighting_bucket: row.lighting_bucket,
      device_class: row.device_class,
      disagreement_score: score,
      iou: row.iou,
      severity_mae: row.severity_mae,
      interval_overlap: row.interval_overlap,
      agreement_overall: row.agreement_overall,
    });
  }

  return scored
    .sort((a, b) => {
      if (b.disagreement_score !== a.disagreement_score) return b.disagreement_score - a.disagreement_score;
      return String(a.inference_id).localeCompare(String(b.inference_id));
    })
    .slice(0, limit);
}

function buildTopHardCaseReasons(hardCases, dayPrefix, limit = 10) {
  const counts = new Map();
  let total = 0;
  for (const item of hardCases) {
    const createdAt = String(item.created_at || '');
    if (!createdAt.startsWith(dayPrefix)) continue;
    total += 1;
    const reasons = Array.isArray(item.disagreement_reasons) ? item.disagreement_reasons : [];
    if (!reasons.length) {
      const fallbackReason = defaultToken(item?.final_reason || item?.verifier?.global_notes?.[0], 'UNKNOWN');
      counts.set(fallbackReason, (counts.get(fallbackReason) || 0) + 1);
      continue;
    }
    for (const reason of reasons) {
      const token = defaultToken(reason, 'UNKNOWN');
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }

  const top = Array.from(counts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.reason.localeCompare(b.reason);
    })
    .slice(0, limit);

  return { total_hard_cases: total, top };
}

function toMarkdownTable(rows, headers, getValues) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${getValues(row).map((v) => (v == null ? '' : String(v))).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..');
  const storeDir = path.resolve(repoRoot, args.storeDir || path.join('tmp', 'diag_pseudo_label_factory'));
  const hardCasesPath = path.resolve(repoRoot, args.hardCasesPath || path.join('tmp', 'diag_verify', 'hard_cases.ndjson'));
  const outDir = path.resolve(repoRoot, args.outDir || 'reports');

  const dateKey = normalizeDateKey(args.date);
  const prefix = datePrefix(dateKey);

  const modelOutputsPath = path.join(storeDir, 'model_outputs.ndjson');
  const agreementSamplesPath = path.join(storeDir, 'agreement_samples.ndjson');

  const modelOutputs = await readNdjson(modelOutputsPath);
  const agreementSamples = await readNdjson(agreementSamplesPath);
  const hardCases = await readNdjson(hardCasesPath);

  const modelPart = buildModelSlices(modelOutputs, prefix);
  const agreementPart = buildAgreementSlices(agreementSamples, prefix, modelPart.byInference);
  const topDisagreements = buildTopDisagreements(agreementPart.rows, 12);
  const hardCaseSummary = buildTopHardCaseReasons(hardCases, prefix, 10);

  const report = {
    schema_version: 'aurora.diag.verify_daily.v1',
    generated_at_utc: new Date().toISOString(),
    date_utc: prefix,
    inputs: {
      model_outputs_path: modelOutputsPath,
      agreement_samples_path: agreementSamplesPath,
      hard_cases_path: hardCasesPath,
      model_outputs_total: modelOutputs.length,
      agreement_samples_total: agreementSamples.length,
      hard_cases_total: hardCases.length,
      model_rows_for_date: modelPart.raw_rows,
      agreement_rows_for_date: agreementPart.raw_rows,
      hard_cases_for_date: hardCaseSummary.total_hard_cases,
    },
    slices: {
      model_outputs: modelPart.slices,
      agreement: agreementPart.slices,
    },
    top_disagreements: topDisagreements,
    top_hard_case_reasons: hardCaseSummary.top,
  };

  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `verify_daily_${dateKey}.json`);
  const mdPath = path.join(outDir, `verify_daily_${dateKey}.md`);

  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const mdLines = [];
  mdLines.push(`# Verify Daily Report (${prefix})`);
  mdLines.push('');
  mdLines.push(`Generated at: ${report.generated_at_utc}`);
  mdLines.push('');
  mdLines.push('## Summary');
  mdLines.push(`- model rows (date): ${modelPart.raw_rows}`);
  mdLines.push(`- agreement rows (date): ${agreementPart.raw_rows}`);
  mdLines.push(`- hard cases (date): ${hardCaseSummary.total_hard_cases}`);
  mdLines.push('');

  mdLines.push('## Slice: model_outputs (issue_type × quality_grade × tone_bucket × lighting_bucket × device_class)');
  mdLines.push('');
  if (modelPart.slices.length) {
    mdLines.push(
      toMarkdownTable(
        modelPart.slices.slice(0, 100),
        ['issue_type', 'quality_grade', 'tone_bucket', 'lighting_bucket', 'device_class', 'count', 'confidence_avg', 'severity_avg'],
        (row) => [row.issue_type, row.quality_grade, row.tone_bucket, row.lighting_bucket, row.device_class, row.count, row.confidence_avg, row.severity_avg],
      ),
    );
  } else {
    mdLines.push('_No rows for this date._');
  }
  mdLines.push('');

  mdLines.push('## Slice: agreement_samples (issue_type × quality_grade × tone_bucket × lighting_bucket × device_class)');
  mdLines.push('');
  if (agreementPart.slices.length) {
    mdLines.push(
      toMarkdownTable(
        agreementPart.slices.slice(0, 100),
        ['issue_type', 'quality_grade', 'tone_bucket', 'lighting_bucket', 'device_class', 'count', 'agreement_overall_avg', 'iou_avg', 'severity_mae_avg', 'interval_overlap_avg'],
        (row) => [
          row.issue_type,
          row.quality_grade,
          row.tone_bucket,
          row.lighting_bucket,
          row.device_class,
          row.count,
          row.agreement_overall_avg,
          row.iou_avg,
          row.severity_mae_avg,
          row.interval_overlap_avg,
        ],
      ),
    );
  } else {
    mdLines.push('_No rows for this date._');
  }
  mdLines.push('');

  mdLines.push('## Top disagreements');
  mdLines.push('');
  if (topDisagreements.length) {
    mdLines.push(
      toMarkdownTable(
        topDisagreements,
        ['inference_id', 'issue_type', 'quality_grade', 'tone_bucket', 'lighting_bucket', 'device_class', 'disagreement_score', 'iou', 'severity_mae', 'interval_overlap'],
        (row) => [
          row.inference_id,
          row.issue_type,
          row.quality_grade,
          row.tone_bucket,
          row.lighting_bucket,
          row.device_class,
          row.disagreement_score,
          row.iou,
          row.severity_mae,
          row.interval_overlap,
        ],
      ),
    );
  } else {
    mdLines.push('_No disagreements for this date._');
  }
  mdLines.push('');

  mdLines.push('## Top hard-case reasons');
  mdLines.push('');
  if (hardCaseSummary.top.length) {
    mdLines.push(
      toMarkdownTable(
        hardCaseSummary.top,
        ['reason', 'count'],
        (row) => [row.reason, row.count],
      ),
    );
  } else {
    mdLines.push('_No hard-case reasons for this date._');
  }
  mdLines.push('');

  await fs.writeFile(mdPath, `${mdLines.join('\n')}\n`, 'utf8');

  process.stdout.write(`${jsonPath}\n${mdPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
