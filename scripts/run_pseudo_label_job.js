#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  computeAgreementForPair,
  generatePseudoLabelsForPair,
  getStoreConfig,
  getStorePaths,
  readNdjsonFile,
} = require('../src/auroraBff/pseudoLabelFactory');

const DAILY_PSEUDO_SCHEMA_VERSION = 'aurora.diag.pseudo_label_daily.v1';
const DAILY_HARD_CASE_SCHEMA_VERSION = 'aurora.diag.hard_case_daily.v1';
const DAILY_JOB_SUMMARY_SCHEMA_VERSION = 'aurora.diag.pseudo_label_job_summary.v1';

function parseArgs(argv) {
  const out = {
    storeDir: '',
    outDir: '',
    date: '',
    minAgreement: '',
    regionIouThreshold: '',
    allowRoi: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--store-dir' && next) {
      out.storeDir = next;
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
    if (token === '--min-agreement' && next) {
      out.minAgreement = next;
      i += 1;
      continue;
    }
    if (token === '--region-iou-threshold' && next) {
      out.regionIouThreshold = next;
      i += 1;
      continue;
    }
    if (token === '--allow-roi' && next) {
      out.allowRoi = next;
      i += 1;
      continue;
    }
  }
  return out;
}

function clampNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function parseBool(value, fallback = false) {
  const token = String(value == null ? '' : value)
    .trim()
    .toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function round3(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(3));
}

function utcDateKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
}

function normalizeDateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return utcDateKey();
  if (/^\d{8}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.replace(/-/g, '');
  throw new Error(`invalid --date value: ${value}`);
}

function datePrefix(dateKey) {
  return `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
}

function lineJson(records) {
  if (!Array.isArray(records) || !records.length) return '';
  return `${records.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function hashToken(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function safeToken(value, fallback = 'unknown') {
  const token = String(value || '').trim();
  return token || fallback;
}

function selectDailyRows(rows, prefix) {
  return (Array.isArray(rows) ? rows : []).filter((row) => String(row?.created_at || '').startsWith(prefix));
}

function restoreConcern(concern = {}) {
  const out = {
    type: safeToken(concern.type, 'other'),
    severity: clampNumber(concern.severity, 0, 0, 4),
    confidence: clampNumber(concern.confidence, 0, 0, 1),
    evidence_text: String(concern.evidence_text || '').trim().slice(0, 500),
    quality_sensitivity: safeToken(concern.quality_sensitivity, 'medium'),
    source_model: safeToken(concern.source_model, 'unknown'),
    provenance: {
      source_ids: [],
    },
  };
  if (Array.isArray(concern.regions) && concern.regions.length) {
    out.regions = concern.regions;
    return out;
  }
  if (concern.region_hint_bbox && typeof concern.region_hint_bbox === 'object') {
    out.regions = [{ kind: 'bbox', bbox_norm: concern.region_hint_bbox }];
    return out;
  }
  out.regions = [];
  return out;
}

function outputFromRecord(record = {}) {
  const outputJson = record && typeof record.output_json === 'object' ? record.output_json : {};
  const concerns = Array.isArray(outputJson.concerns) ? outputJson.concerns.map((item) => restoreConcern(item)) : [];
  return {
    provider: safeToken(record.provider, 'unknown_provider'),
    model_name: safeToken(record.model_name, 'unknown_model'),
    model_version: safeToken(record.model_version, 'v1'),
    ok: Boolean(outputJson.ok),
    concerns,
  };
}

function chooseProviderPair(outputs) {
  const byProvider = new Map();
  for (const output of outputs) {
    if (!output || !output.provider) continue;
    if (!byProvider.has(output.provider)) byProvider.set(output.provider, output);
  }
  const preferredPairs = [
    ['gemini_provider', 'gpt_provider'],
    ['gemini_provider', 'cv_provider'],
    ['gpt_provider', 'cv_provider'],
  ];
  for (const [left, right] of preferredPairs) {
    if (byProvider.has(left) && byProvider.has(right)) {
      return [byProvider.get(left), byProvider.get(right)];
    }
  }
  const providers = Array.from(byProvider.keys()).sort();
  if (providers.length < 2) return null;
  return [byProvider.get(providers[0]), byProvider.get(providers[1])];
}

function summarizeIssueType(sample, generated, outputs) {
  const byType = Array.isArray(sample?.metrics?.by_type) ? sample.metrics.by_type : [];
  if (byType.length) {
    const scored = byType
      .map((item) => ({
        type: safeToken(item?.type, 'other'),
        iou: Number.isFinite(Number(item?.iou)) ? Number(item.iou) : 1,
        mae: Number.isFinite(Number(item?.severity_mae)) ? Number(item.severity_mae) : 0,
      }))
      .sort((a, b) => {
        if (a.iou !== b.iou) return a.iou - b.iou;
        if (a.mae !== b.mae) return b.mae - a.mae;
        return a.type.localeCompare(b.type);
      });
    if (scored.length) return scored[0].type;
  }

  if (Array.isArray(generated?.matches) && generated.matches.length) {
    return safeToken(generated.matches[0]?.type, 'other');
  }

  for (const output of outputs) {
    const concerns = Array.isArray(output?.concerns) ? output.concerns : [];
    if (concerns.length) return safeToken(concerns[0]?.type, 'other');
  }
  return 'other';
}

function summarizeFix(reason) {
  if (reason === 'LOW_AGREEMENT') return 'Recheck region alignment and issue type before labeling.';
  if (reason === 'QUALITY_NOT_ELIGIBLE') return 'Re-capture photo under daylight and avoid filters before labeling.';
  if (reason === 'NO_MATCHED_REGIONS') return 'No shared region match; verify issue region with manual QA.';
  if (reason === 'INSUFFICIENT_PROVIDER_OUTPUTS') return 'Need at least two provider outputs for agreement-based labeling.';
  return 'Manual review required.';
}

function resolveAssetId(records) {
  for (const row of records) {
    const output = row && typeof row.output_json === 'object' ? row.output_json : {};
    const candidates = [row.asset_id, output.asset_id, output.photo_id, output.upload_id, output.source_asset_id];
    for (const candidate of candidates) {
      const token = String(candidate || '').trim();
      if (token) return token;
    }
  }
  return null;
}

function buildDailyPseudoRecord({
  dateKey,
  inferenceId,
  qualityGrade,
  toneBucket,
  lightingBucket,
  deviceClass,
  outputs,
  agreementOverall,
  threshold,
  generated,
}) {
  return {
    schema_version: DAILY_PSEUDO_SCHEMA_VERSION,
    pseudo_label_id: `pld_${crypto.createHash('sha1').update(`${inferenceId}:${dateKey}`).digest('hex').slice(0, 16)}`,
    created_at: new Date().toISOString(),
    date_key: dateKey,
    inference_id: inferenceId,
    quality_grade: qualityGrade,
    skin_tone_bucket: toneBucket,
    lighting_bucket: lightingBucket,
    device_class: deviceClass,
    agreement_overall: round3(agreementOverall),
    agreement_threshold: round3(threshold),
    concerns: Array.isArray(generated?.concerns) ? generated.concerns : [],
    matches: Array.isArray(generated?.matches) ? generated.matches : [],
    sources: outputs.map((output) => ({
      provider: safeToken(output.provider, 'unknown_provider'),
      model_name: safeToken(output.model_name, 'unknown_model'),
      model_version: safeToken(output.model_version, 'v1'),
    })),
  };
}

function buildDailyHardCaseRecord({
  dateKey,
  inferenceId,
  qualityGrade,
  toneBucket,
  lightingBucket,
  deviceClass,
  reason,
  issueType,
  outputs,
  agreementOverall,
  includeRoi,
  records,
}) {
  const requestHash = hashToken(inferenceId);
  const assetHash = hashToken(resolveAssetId(records));
  const out = {
    schema_version: DAILY_HARD_CASE_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    date_key: dateKey,
    inference_id: inferenceId,
    request_id_hash: requestHash,
    asset_id_hash: assetHash,
    disagreement_reason: reason,
    issue_type: issueType,
    quality_summary: {
      quality_grade: qualityGrade,
      tone_bucket: toneBucket,
      lighting_bucket: lightingBucket,
      device_class: deviceClass,
    },
    suggested_fix_summary: summarizeFix(reason),
    agreement_overall: round3(agreementOverall),
    providers: outputs.map((output) => safeToken(output.provider, 'unknown_provider')),
  };

  if (includeRoi) {
    for (const row of records) {
      const output = row && typeof row.output_json === 'object' ? row.output_json : {};
      const roiUri = String(output.roi_uri || row.roi_uri || '').trim();
      if (roiUri) {
        out.roi_uri = roiUri;
        break;
      }
    }
  }
  return out;
}

async function runPseudoLabelJob(opts = {}) {
  const config = getStoreConfig();
  const dateKey = normalizeDateKey(opts.date);
  const dayPrefix = datePrefix(dateKey);
  const minAgreement = clampNumber(
    opts.minAgreement === '' ? config.agreementThreshold : opts.minAgreement,
    config.agreementThreshold,
    0.05,
    1,
  );
  const regionIouThreshold = clampNumber(
    opts.regionIouThreshold === '' ? config.regionIouThreshold : opts.regionIouThreshold,
    config.regionIouThreshold,
    0.05,
    0.95,
  );
  const includeRoi = parseBool(opts.allowRoi === '' ? config.allowRoi : opts.allowRoi, Boolean(config.allowRoi));
  const baseStoreDir = path.resolve(opts.storeDir || config.baseDir);
  const paths = getStorePaths({ ...config, baseDir: baseStoreDir });
  const outRoot = path.resolve(opts.outDir || path.join('reports', 'pseudo_label_job'), dateKey);
  const pseudoPath = path.join(outRoot, 'pseudo_labels_daily.ndjson');
  const hardPath = path.join(outRoot, 'hard_cases_daily.jsonl');
  const summaryPath = path.join(outRoot, 'job_summary.json');

  await fs.mkdir(outRoot, { recursive: true });

  const allModelOutputs = await readNdjsonFile(paths.modelOutputs);
  const allAgreementSamples = await readNdjsonFile(paths.agreementSamples);
  const modelOutputs = selectDailyRows(allModelOutputs, dayPrefix);
  const agreementSamples = selectDailyRows(allAgreementSamples, dayPrefix);
  const agreementByInference = new Map();
  for (const sample of agreementSamples) {
    const inferenceId = safeToken(sample.inference_id, '');
    if (!inferenceId) continue;
    agreementByInference.set(inferenceId, sample);
  }

  const byInference = new Map();
  for (const row of modelOutputs) {
    const inferenceId = safeToken(row.inference_id, '');
    if (!inferenceId) continue;
    if (!byInference.has(inferenceId)) byInference.set(inferenceId, []);
    byInference.get(inferenceId).push(row);
  }

  const pseudoRows = [];
  const hardRows = [];
  const counters = {
    inferences_total: byInference.size,
    pseudo_labels_written: 0,
    hard_cases_written: 0,
    skipped_quality: 0,
    skipped_low_agreement: 0,
    skipped_no_match: 0,
    skipped_insufficient_providers: 0,
  };

  for (const [inferenceId, records] of byInference.entries()) {
    const qualityGrade = safeToken(records[0]?.quality_grade, 'unknown').toLowerCase();
    const toneBucket = safeToken(records[0]?.skin_tone_bucket, 'unknown');
    const lightingBucket = safeToken(records[0]?.lighting_bucket, 'unknown');
    const deviceClass = safeToken(records[0]?.device_class, 'unknown');

    const outputs = records.map((record) => outputFromRecord(record));
    const pair = chooseProviderPair(outputs);
    if (!pair) {
      counters.skipped_insufficient_providers += 1;
      hardRows.push(
        buildDailyHardCaseRecord({
          dateKey,
          inferenceId,
          qualityGrade,
          toneBucket,
          lightingBucket,
          deviceClass,
          reason: 'INSUFFICIENT_PROVIDER_OUTPUTS',
          issueType: 'other',
          outputs,
          agreementOverall: 0,
          includeRoi,
          records,
        }),
      );
      continue;
    }

    const agreementSample = agreementByInference.get(inferenceId) || null;
    const derivedAgreement = computeAgreementForPair({ leftOutput: pair[0], rightOutput: pair[1] });
    const agreementOverall = Number.isFinite(Number(agreementSample?.metrics?.overall))
      ? Number(agreementSample.metrics.overall)
      : Number(derivedAgreement?.overall || 0);
    const generated = generatePseudoLabelsForPair({
      geminiOutput: pair[0],
      gptOutput: pair[1],
      qualityGrade,
      regionIouThreshold,
    });

    const qualityEligible = Boolean(generated.quality_eligible);
    const agreementPass = agreementOverall >= minAgreement;
    const hasMatchedConcerns = Array.isArray(generated.concerns) && generated.concerns.length > 0;
    const emitPseudo = qualityEligible && agreementPass && hasMatchedConcerns;
    if (emitPseudo) {
      pseudoRows.push(
        buildDailyPseudoRecord({
          dateKey,
          inferenceId,
          qualityGrade,
          toneBucket,
          lightingBucket,
          deviceClass,
          outputs: pair,
          agreementOverall,
          threshold: minAgreement,
          generated,
        }),
      );
      counters.pseudo_labels_written += 1;
      continue;
    }

    let reason = 'LOW_AGREEMENT';
    if (!qualityEligible) {
      reason = 'QUALITY_NOT_ELIGIBLE';
      counters.skipped_quality += 1;
    } else if (!agreementPass) {
      reason = 'LOW_AGREEMENT';
      counters.skipped_low_agreement += 1;
    } else if (!hasMatchedConcerns) {
      reason = 'NO_MATCHED_REGIONS';
      counters.skipped_no_match += 1;
    }

    hardRows.push(
      buildDailyHardCaseRecord({
        dateKey,
        inferenceId,
        qualityGrade,
        toneBucket,
        lightingBucket,
        deviceClass,
        reason,
        issueType: summarizeIssueType(agreementSample, generated, pair),
        outputs: pair,
        agreementOverall,
        includeRoi,
        records,
      }),
    );
  }

  counters.hard_cases_written = hardRows.length;

  await fs.writeFile(pseudoPath, lineJson(pseudoRows), 'utf8');
  await fs.writeFile(hardPath, lineJson(hardRows), 'utf8');

  const summary = {
    schema_version: DAILY_JOB_SUMMARY_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    date_key: dateKey,
    config: {
      min_agreement: round3(minAgreement),
      region_iou_threshold: round3(regionIouThreshold),
      allow_roi: includeRoi,
    },
    source: {
      store_dir: baseStoreDir,
      model_outputs_path: paths.modelOutputs,
      agreement_samples_path: paths.agreementSamples,
      model_outputs_total: modelOutputs.length,
      agreement_samples_total: agreementSamples.length,
      inferences_total: counters.inferences_total,
    },
    counters,
    outputs: {
      pseudo_labels_daily: pseudoPath,
      hard_cases_daily: hardPath,
      job_summary: summaryPath,
    },
  };
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

if (require.main === module) {
  runPseudoLabelJob(parseArgs(process.argv.slice(2)))
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    })
    .catch((err) => {
      process.stderr.write(`${String(err && err.stack ? err.stack : err)}\n`);
      process.exit(1);
    });
}

module.exports = {
  runPseudoLabelJob,
  parseArgs,
  normalizeDateKey,
};
