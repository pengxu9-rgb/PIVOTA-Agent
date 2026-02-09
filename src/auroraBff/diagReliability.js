const fs = require('node:fs');
const path = require('node:path');

const RELIABILITY_SCHEMA_VERSION = 'aurora.diag.reliability.v1';
const VERIFY_FAIL_REASON_ALLOWLIST = new Set([
  'TIMEOUT',
  'RATE_LIMIT',
  'QUOTA',
  'UPSTREAM_4XX',
  'UPSTREAM_5XX',
  'SCHEMA_INVALID',
  'IMAGE_FETCH_FAILED',
  'UNKNOWN',
]);

const reliabilityCache = {
  path: '',
  mtimeMs: 0,
  table: null,
};

function safeToken(value, fallback = 'unknown') {
  const token = String(value || '').trim();
  return token || fallback;
}

function normalizeToken(value) {
  return safeToken(value, '').toLowerCase();
}

function normalizeIssueType(value) {
  return normalizeToken(value) || 'other';
}

function clampNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function parseBool(value, fallback = false) {
  const token = normalizeToken(value);
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(token)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(token)) return false;
  return fallback;
}

function round3(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(3));
}

function mean(values) {
  const nums = (Array.isArray(values) ? values : []).map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return round3(nums.reduce((acc, value) => acc + value, 0) / nums.length);
}

function quantile(values, q) {
  const nums = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!nums.length) return null;
  const qClamped = clampNumber(q, 0.5, 0, 1);
  const rank = (nums.length - 1) * qClamped;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return round3(nums[low]);
  const weight = rank - low;
  return round3(nums[low] * (1 - weight) + nums[high] * weight);
}

function stddev(values) {
  const nums = (Array.isArray(values) ? values : []).map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (nums.length < 2) return null;
  const avg = nums.reduce((acc, value) => acc + value, 0) / nums.length;
  let sq = 0;
  for (const value of nums) sq += (value - avg) ** 2;
  return round3(Math.sqrt(sq / nums.length));
}

function bucketKeyFromDimensions({ issue_type, quality_grade, lighting_bucket, tone_bucket } = {}) {
  return [
    normalizeIssueType(issue_type),
    normalizeToken(quality_grade) || 'unknown',
    normalizeToken(lighting_bucket) || 'unknown',
    normalizeToken(tone_bucket) || 'unknown',
  ].join('|');
}

function qltKey({ quality_grade, lighting_bucket, tone_bucket } = {}) {
  return [
    normalizeToken(quality_grade) || 'unknown',
    normalizeToken(lighting_bucket) || 'unknown',
    normalizeToken(tone_bucket) || 'unknown',
  ].join('|');
}

function parseStatusCode(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.trunc(numeric);
}

function normalizeVerifyFailReason(rawReason, providerStatusCode) {
  const token = safeToken(rawReason, 'UNKNOWN').toUpperCase();
  const statusCode = parseStatusCode(providerStatusCode, 0);
  if (VERIFY_FAIL_REASON_ALLOWLIST.has(token)) return token;
  if (token.includes('TIMEOUT')) return 'TIMEOUT';
  if (token.includes('RATE_LIMIT')) return 'RATE_LIMIT';
  if (token.includes('QUOTA') || token.includes('INSUFFICIENT_QUOTA')) return 'QUOTA';
  if (token.includes('SCHEMA_INVALID') || token.includes('CANONICAL_SCHEMA_INVALID')) return 'SCHEMA_INVALID';
  if (token.includes('IMAGE_FETCH') || token.includes('MISSING_IMAGE') || token.includes('PHOTO_DOWNLOAD')) return 'IMAGE_FETCH_FAILED';
  if (token.includes('UPSTREAM_5XX') || statusCode >= 500) return 'UPSTREAM_5XX';
  if (token.includes('UPSTREAM_4XX') || statusCode >= 400) return 'UPSTREAM_4XX';
  if (statusCode === 429) return 'RATE_LIMIT';
  return 'UNKNOWN';
}

function extractVerifyRows(modelOutputs, { datePrefix = '' } = {}) {
  const out = [];
  for (const row of Array.isArray(modelOutputs) ? modelOutputs : []) {
    if (datePrefix && !String(row?.created_at || '').startsWith(datePrefix)) continue;
    const provider = normalizeToken(row?.provider);
    if (provider !== 'gemini_provider') continue;
    const output = row && typeof row.output_json === 'object' ? row.output_json : {};
    const decision = normalizeToken(output?.decision || (output?.ok === false ? 'verify' : 'verify'));
    const reason = normalizeVerifyFailReason(output?.verify_fail_reason || output?.final_reason || output?.failure_reason, output?.provider_status_code);
    const isGuard = decision === 'skip' && reason === 'VERIFY_BUDGET_GUARD';
    const finalReason = safeToken(output?.final_reason, '').toUpperCase();
    const hasFailureSignal =
      output?.ok === false ||
      output?.schema_failed === true ||
      Boolean(String(output?.failure_reason || '').trim()) ||
      (finalReason && finalReason !== 'OK');
    out.push({
      created_at: String(row?.created_at || ''),
      issue_type: 'other',
      quality_grade: normalizeToken(row?.quality_grade) || 'unknown',
      lighting_bucket: normalizeToken(row?.lighting_bucket) || 'unknown',
      tone_bucket: normalizeToken(row?.skin_tone_bucket || row?.tone_bucket) || 'unknown',
      latency_ms: Number.isFinite(Number(output?.latency_ms)) ? Number(output.latency_ms) : null,
      is_guard: isGuard,
      is_failure: !isGuard && hasFailureSignal,
      fail_reason: !isGuard && hasFailureSignal ? reason : null,
    });
  }
  return out;
}

function extractAgreementRows(agreementSamples, { datePrefix = '' } = {}) {
  const out = [];
  for (const sample of Array.isArray(agreementSamples) ? agreementSamples : []) {
    if (datePrefix && !String(sample?.created_at || '').startsWith(datePrefix)) continue;
    const qualityGrade = normalizeToken(sample?.quality_grade) || 'unknown';
    const toneBucket = normalizeToken(sample?.skin_tone_bucket || sample?.tone_bucket) || 'unknown';
    const lightingBucket = normalizeToken(sample?.lighting_bucket) || 'unknown';
    const overall = Number.isFinite(Number(sample?.metrics?.overall)) ? Number(sample.metrics.overall) : null;
    const byType = Array.isArray(sample?.metrics?.by_type) ? sample.metrics.by_type : [];
    if (!byType.length) {
      out.push({
        issue_type: 'other',
        quality_grade: qualityGrade,
        lighting_bucket: lightingBucket,
        tone_bucket: toneBucket,
        agreement: overall,
      });
      continue;
    }
    for (const issue of byType) {
      out.push({
        issue_type: normalizeIssueType(issue?.type),
        quality_grade: qualityGrade,
        lighting_bucket: lightingBucket,
        tone_bucket: toneBucket,
        agreement: overall,
      });
    }
  }
  return out;
}

function extractGoldRows(goldLabels, { datePrefix = '' } = {}) {
  const out = [];
  for (const row of Array.isArray(goldLabels) ? goldLabels : []) {
    const createdAt = String(row?.created_at || '');
    if (datePrefix && createdAt && !createdAt.startsWith(datePrefix)) continue;
    const qualityGrade = normalizeToken(row?.quality_grade) || 'unknown';
    const toneBucket = normalizeToken(row?.skin_tone_bucket || row?.tone_bucket) || 'unknown';
    const lightingBucket = normalizeToken(row?.lighting_bucket) || 'unknown';
    const concerns = Array.isArray(row?.concerns) ? row.concerns : [];
    const issueTypes = concerns.length
      ? Array.from(new Set(concerns.map((concern) => normalizeIssueType(concern?.type)).filter(Boolean)))
      : ['other'];
    for (const issueType of issueTypes) {
      out.push({
        issue_type: issueType || 'other',
        quality_grade: qualityGrade,
        lighting_bucket: lightingBucket,
        tone_bucket: toneBucket,
      });
    }
  }
  return out;
}

function resolveVoteGateConfig(overrides = {}) {
  const source = { ...process.env, ...overrides };
  return {
    voteEnabled: parseBool(
      Object.prototype.hasOwnProperty.call(overrides, 'voteEnabled') ? overrides.voteEnabled : source.DIAG_VERIFY_ENABLE_VOTE,
      false,
    ),
    maxFailRate: clampNumber(
      Object.prototype.hasOwnProperty.call(overrides, 'maxFailRate') ? overrides.maxFailRate : source.DIAG_VERIFY_VOTE_MAX_FAIL_RATE,
      0.2,
      0.01,
      1,
    ),
    minAgreement: clampNumber(
      Object.prototype.hasOwnProperty.call(overrides, 'minAgreement') ? overrides.minAgreement : source.DIAG_VERIFY_VOTE_MIN_AGREEMENT,
      0.7,
      0,
      1,
    ),
    minAgreementSamples: Math.max(
      1,
      Math.trunc(
        clampNumber(
          Object.prototype.hasOwnProperty.call(overrides, 'minAgreementSamples')
            ? overrides.minAgreementSamples
            : source.DIAG_VERIFY_VOTE_MIN_AGREEMENT_SAMPLES,
          20,
          1,
          1000000,
        ),
      ),
    ),
    maxAgreementStddev: clampNumber(
      Object.prototype.hasOwnProperty.call(overrides, 'maxAgreementStddev')
        ? overrides.maxAgreementStddev
        : source.DIAG_VERIFY_VOTE_MAX_AGREEMENT_STDDEV,
      0.2,
      0,
      1,
    ),
    minGoldSamples: Math.max(
      0,
      Math.trunc(
        clampNumber(
          Object.prototype.hasOwnProperty.call(overrides, 'minGoldSamples')
            ? overrides.minGoldSamples
            : source.DIAG_VERIFY_VOTE_MIN_GOLD_SAMPLES,
          50,
          0,
          1000000,
        ),
      ),
    ),
  };
}

function evaluateBucketEligibility(bucket = {}, { gateConfig, hasGoldData } = {}) {
  const gate = gateConfig || resolveVoteGateConfig();
  const reasons = [];
  const verifyCalls = Number(bucket.verify_calls_total || 0);
  const failRate = Number.isFinite(Number(bucket.verify_fail_rate)) ? Number(bucket.verify_fail_rate) : null;
  const agreementMean = Number.isFinite(Number(bucket.agreement_mean)) ? Number(bucket.agreement_mean) : null;
  const agreementSamples = Number(bucket.agreement_samples || 0);
  const agreementStddev = Number.isFinite(Number(bucket.agreement_stddev)) ? Number(bucket.agreement_stddev) : null;
  const goldSamples = Number(bucket.gold_samples || 0);

  if (!gate.voteEnabled) reasons.push('VOTE_DISABLED');
  if (verifyCalls <= 0) reasons.push('NO_VERIFY_CALLS');
  if (failRate == null || failRate > gate.maxFailRate) reasons.push('VERIFY_FAIL_RATE_HIGH');
  if (agreementSamples < gate.minAgreementSamples) reasons.push('AGREEMENT_SAMPLES_LOW');
  if (agreementMean == null || agreementMean < gate.minAgreement) reasons.push('AGREEMENT_LOW');
  if (agreementStddev == null || agreementStddev > gate.maxAgreementStddev) reasons.push('AGREEMENT_UNSTABLE');
  if (hasGoldData && goldSamples < gate.minGoldSamples) reasons.push('GOLD_SUPPORT_LOW');

  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

function buildReliabilityTable({
  modelOutputs = [],
  agreementSamples = [],
  goldLabels = [],
  datePrefix = '',
  gateConfig,
} = {}) {
  const verifyRows = extractVerifyRows(modelOutputs, { datePrefix });
  const agreementRows = extractAgreementRows(agreementSamples, { datePrefix });
  const goldRows = extractGoldRows(goldLabels, { datePrefix });
  const gate = resolveVoteGateConfig(gateConfig || {});

  const verifyByQlt = new Map();
  for (const row of verifyRows) {
    const qKey = qltKey(row);
    if (!verifyByQlt.has(qKey)) {
      verifyByQlt.set(qKey, {
        verify_calls_total: 0,
        verify_fail_total: 0,
        verify_guard_total: 0,
        latencies: [],
      });
    }
    const acc = verifyByQlt.get(qKey);
    if (row.is_guard) {
      acc.verify_guard_total += 1;
      continue;
    }
    acc.verify_calls_total += 1;
    if (row.is_failure) acc.verify_fail_total += 1;
    if (Number.isFinite(Number(row.latency_ms))) acc.latencies.push(Number(row.latency_ms));
  }

  const agreementsByBucket = new Map();
  const issuesByQlt = new Map();
  const ensureIssue = (qKey, issueType) => {
    if (!issuesByQlt.has(qKey)) issuesByQlt.set(qKey, new Set());
    issuesByQlt.get(qKey).add(issueType);
  };

  for (const row of agreementRows) {
    const issueType = normalizeIssueType(row.issue_type);
    const bKey = bucketKeyFromDimensions(row);
    if (!agreementsByBucket.has(bKey)) agreementsByBucket.set(bKey, []);
    if (Number.isFinite(Number(row.agreement))) agreementsByBucket.get(bKey).push(Number(row.agreement));
    ensureIssue(qltKey(row), issueType);
  }

  const goldByBucket = new Map();
  for (const row of goldRows) {
    const issueType = normalizeIssueType(row.issue_type);
    const bKey = bucketKeyFromDimensions(row);
    goldByBucket.set(bKey, (goldByBucket.get(bKey) || 0) + 1);
    ensureIssue(qltKey(row), issueType);
  }

  const qltUniverse = new Set([...verifyByQlt.keys(), ...issuesByQlt.keys()]);
  const hasGoldData = goldRows.length > 0;
  const buckets = [];

  for (const qKey of qltUniverse) {
    const [qualityGrade, lightingBucket, toneBucket] = qKey.split('|');
    const issueSet = issuesByQlt.get(qKey);
    const issueTypes = issueSet && issueSet.size ? Array.from(issueSet).sort() : ['other'];
    const verifyStats = verifyByQlt.get(qKey) || {
      verify_calls_total: 0,
      verify_fail_total: 0,
      verify_guard_total: 0,
      latencies: [],
    };

    for (const issueType of issueTypes) {
      const bKey = bucketKeyFromDimensions({
        issue_type: issueType,
        quality_grade: qualityGrade,
        lighting_bucket: lightingBucket,
        tone_bucket: toneBucket,
      });
      const agreements = agreementsByBucket.get(bKey) || [];
      const bucket = {
        bucket_key: bKey,
        issue_type: issueType,
        quality_grade: qualityGrade,
        lighting_bucket: lightingBucket,
        tone_bucket: toneBucket,
        verify_calls_total: verifyStats.verify_calls_total,
        verify_fail_total: verifyStats.verify_fail_total,
        verify_guard_total: verifyStats.verify_guard_total,
        verify_fail_rate: verifyStats.verify_calls_total > 0 ? round3(verifyStats.verify_fail_total / verifyStats.verify_calls_total) : null,
        latency_p50_ms: quantile(verifyStats.latencies, 0.5),
        latency_p95_ms: quantile(verifyStats.latencies, 0.95),
        agreement_samples: agreements.length,
        agreement_mean: mean(agreements),
        agreement_p50: quantile(agreements, 0.5),
        agreement_p90: quantile(agreements, 0.9),
        agreement_stddev: stddev(agreements),
        gold_samples: Number(goldByBucket.get(bKey) || 0),
      };
      const decision = evaluateBucketEligibility(bucket, { gateConfig: gate, hasGoldData });
      bucket.eligible_for_vote = decision.eligible;
      bucket.ineligible_reasons = decision.reasons;
      buckets.push(bucket);
    }
  }

  buckets.sort((left, right) => {
    const l = String(left.bucket_key || '');
    const r = String(right.bucket_key || '');
    return l.localeCompare(r);
  });

  const summary = {
    bucket_count: buckets.length,
    has_gold_data: hasGoldData,
    verify_calls_total: verifyRows.filter((row) => !row.is_guard).length,
    verify_fail_total: verifyRows.filter((row) => !row.is_guard && row.is_failure).length,
    verify_guard_total: verifyRows.filter((row) => row.is_guard).length,
    agreement_rows_total: agreementRows.length,
    gold_rows_total: goldRows.length,
    eligible_bucket_count: buckets.filter((bucket) => bucket.eligible_for_vote).length,
  };

  return {
    schema_version: RELIABILITY_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    date_prefix: datePrefix || null,
    gate_config: gate,
    summary,
    buckets,
  };
}

function getReliabilityTablePath(inputPath) {
  const configured = String(inputPath || process.env.DIAG_VERIFY_RELIABILITY_TABLE_PATH || '').trim();
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), 'reports', 'reliability', 'reliability.json');
}

function loadReliabilityTable(inputPath) {
  const resolved = getReliabilityTablePath(inputPath);
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch (_err) {
    return null;
  }

  if (
    reliabilityCache.table &&
    reliabilityCache.path === resolved &&
    Number.isFinite(stat.mtimeMs) &&
    reliabilityCache.mtimeMs === stat.mtimeMs
  ) {
    return reliabilityCache.table;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.buckets)) return null;
    reliabilityCache.path = resolved;
    reliabilityCache.mtimeMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
    reliabilityCache.table = parsed;
    return parsed;
  } catch (_err) {
    return null;
  }
}

function findBucket(table, bucket) {
  if (!table || !Array.isArray(table.buckets)) return null;
  const targetKey = bucketKeyFromDimensions(bucket || {});
  return table.buckets.find((item) => String(item?.bucket_key || '') === targetKey) || null;
}

function getVerifierVoteDecision(bucket, options = {}) {
  const table = options.table || loadReliabilityTable(options.reliabilityPath);
  if (!table) {
    return {
      eligible: false,
      reasons: ['RELIABILITY_TABLE_MISSING'],
      bucket: null,
    };
  }
  const bucketRow = findBucket(table, bucket);
  if (!bucketRow) {
    return {
      eligible: false,
      reasons: ['BUCKET_NOT_FOUND'],
      bucket: null,
    };
  }
  const gate = resolveVoteGateConfig(options.gateConfig || {});
  const decision = evaluateBucketEligibility(bucketRow, {
    gateConfig: gate,
    hasGoldData: Boolean(table?.summary?.has_gold_data),
  });
  return {
    eligible: decision.eligible,
    reasons: decision.reasons,
    bucket: bucketRow,
  };
}

function shouldUseVerifierInVote(bucket, options = {}) {
  return Boolean(getVerifierVoteDecision(bucket, options).eligible);
}

module.exports = {
  RELIABILITY_SCHEMA_VERSION,
  bucketKeyFromDimensions,
  buildReliabilityTable,
  evaluateBucketEligibility,
  extractAgreementRows,
  extractGoldRows,
  extractVerifyRows,
  getReliabilityTablePath,
  getVerifierVoteDecision,
  loadReliabilityTable,
  normalizeIssueType,
  resolveVoteGateConfig,
  shouldUseVerifierInVote,
  should_use_verifier_in_vote: shouldUseVerifierInVote,
};
