#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  base: 'https://pivota-agent-production.up.railway.app',
  endpoint: '/v1/chat',
  samples: 10,
  concurrency: 3,
  timeoutMs: 10000,
  retryCount: 1,
  retryBackoffMs: 350,
  outDir: 'reports',
  stateFile: 'tmp/aurora_rollout_probe_state.json',
  webhookToken: '',
  message: 'Travel next week skincare plan please',
  lang: 'EN',
  includePolicyDebugHeader: true,
  failOnHigh: false,
  failOnWarn: false,
  elevatedFailureWindowMs: 10 * 60 * 1000,
  splitDriftMinSamples: 200,
  splitCoreMinPct: 2.0,
  splitCoreMaxPct: 10.0,
  splitSafetyMinPct: 0.2,
  splitSafetyMaxPct: 3.0,
  splitWeatherMinPct: 0.2,
  splitWeatherMaxPct: 3.0,
});

function toInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function toFloat(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function toBool(value, fallback = false) {
  if (value == null) return fallback;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y' || raw === 'on';
}

function normalizeBase(raw) {
  return String(raw || DEFAULTS.base).trim().replace(/\/+$/, '');
}

function parseArgs(argv) {
  const windowMinutesRaw = process.env.AURORA_PROBE_WINDOW_MINUTES;
  const envWindowMs = toInt(process.env.AURORA_ROLLOUT_PROBE_ELEVATED_WINDOW_MS, NaN);
  const windowMinutesMs =
    Number.isFinite(Number(windowMinutesRaw)) && Number(windowMinutesRaw) > 0
      ? Math.trunc(Number(windowMinutesRaw) * 60 * 1000)
      : NaN;

  const out = {
    base: normalizeBase(
      process.env.AURORA_ROLLOUT_PROBE_BASE || process.env.AURORA_PROBE_BASE_URL || process.env.BASE || DEFAULTS.base,
    ),
    endpoint: String(process.env.AURORA_ROLLOUT_PROBE_ENDPOINT || DEFAULTS.endpoint),
    samples: toInt(process.env.AURORA_ROLLOUT_PROBE_SAMPLES || process.env.AURORA_PROBE_SAMPLES, DEFAULTS.samples),
    concurrency: toInt(
      process.env.AURORA_ROLLOUT_PROBE_CONCURRENCY || process.env.AURORA_PROBE_CONCURRENCY,
      DEFAULTS.concurrency,
    ),
    timeoutMs: toInt(process.env.AURORA_ROLLOUT_PROBE_TIMEOUT_MS, DEFAULTS.timeoutMs),
    retryCount: toInt(
      process.env.AURORA_ROLLOUT_PROBE_RETRY_COUNT || process.env.AURORA_PROBE_RETRY_COUNT,
      DEFAULTS.retryCount,
    ),
    retryBackoffMs: toInt(process.env.AURORA_ROLLOUT_PROBE_RETRY_BACKOFF_MS, DEFAULTS.retryBackoffMs),
    outDir: String(process.env.AURORA_ROLLOUT_PROBE_OUT_DIR || DEFAULTS.outDir),
    stateFile: String(process.env.AURORA_ROLLOUT_PROBE_STATE_FILE || DEFAULTS.stateFile),
    webhookUrl: String(
      process.env.AURORA_ROLLOUT_PROBE_ALERT_WEBHOOK_URL ||
        process.env.AURORA_PROBE_WEBHOOK_URL ||
        process.env.ALERT_WEBHOOK_URL ||
        '',
    ).trim(),
    webhookToken: String(
      process.env.AURORA_ROLLOUT_PROBE_WEBHOOK_TOKEN || process.env.AURORA_PROBE_WEBHOOK_TOKEN || DEFAULTS.webhookToken,
    ).trim(),
    message: String(process.env.AURORA_ROLLOUT_PROBE_MESSAGE || DEFAULTS.message),
    lang: String(process.env.AURORA_ROLLOUT_PROBE_LANG || DEFAULTS.lang).trim().toUpperCase() === 'CN' ? 'CN' : 'EN',
    includePolicyDebugHeader: toBool(process.env.AURORA_ROLLOUT_PROBE_POLICY_DEBUG, DEFAULTS.includePolicyDebugHeader),
    failOnHigh: toBool(process.env.AURORA_ROLLOUT_PROBE_FAIL_ON_HIGH, DEFAULTS.failOnHigh),
    failOnWarn: toBool(process.env.AURORA_ROLLOUT_PROBE_FAIL_ON_WARN, DEFAULTS.failOnWarn),
    elevatedFailureWindowMs: Number.isFinite(envWindowMs)
      ? envWindowMs
      : Number.isFinite(windowMinutesMs)
        ? windowMinutesMs
        : DEFAULTS.elevatedFailureWindowMs,
    splitDriftMinSamples: toInt(
      process.env.AURORA_ROLLOUT_PROBE_SPLIT_DRIFT_MIN_SAMPLES,
      DEFAULTS.splitDriftMinSamples,
    ),
    splitCoreMinPct: toFloat(process.env.AURORA_ROLLOUT_PROBE_CORE_MIN_PCT, DEFAULTS.splitCoreMinPct),
    splitCoreMaxPct: toFloat(process.env.AURORA_ROLLOUT_PROBE_CORE_MAX_PCT, DEFAULTS.splitCoreMaxPct),
    splitSafetyMinPct: toFloat(process.env.AURORA_ROLLOUT_PROBE_SAFETY_MIN_PCT, DEFAULTS.splitSafetyMinPct),
    splitSafetyMaxPct: toFloat(process.env.AURORA_ROLLOUT_PROBE_SAFETY_MAX_PCT, DEFAULTS.splitSafetyMaxPct),
    splitWeatherMinPct: toFloat(process.env.AURORA_ROLLOUT_PROBE_WEATHER_MIN_PCT, DEFAULTS.splitWeatherMinPct),
    splitWeatherMaxPct: toFloat(process.env.AURORA_ROLLOUT_PROBE_WEATHER_MAX_PCT, DEFAULTS.splitWeatherMaxPct),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = String(argv[i + 1] || '');
    if (token === '--base' && next) {
      out.base = normalizeBase(next);
      i += 1;
      continue;
    }
    if (token === '--endpoint' && next) {
      out.endpoint = next;
      i += 1;
      continue;
    }
    if (token === '--samples' && next) {
      out.samples = toInt(next, out.samples);
      i += 1;
      continue;
    }
    if (token === '--concurrency' && next) {
      out.concurrency = toInt(next, out.concurrency);
      i += 1;
      continue;
    }
    if (token === '--timeout-ms' && next) {
      out.timeoutMs = toInt(next, out.timeoutMs);
      i += 1;
      continue;
    }
    if (token === '--retry-count' && next) {
      out.retryCount = toInt(next, out.retryCount);
      i += 1;
      continue;
    }
    if (token === '--retry-backoff-ms' && next) {
      out.retryBackoffMs = toInt(next, out.retryBackoffMs);
      i += 1;
      continue;
    }
    if (token === '--out-dir' && next) {
      out.outDir = next;
      i += 1;
      continue;
    }
    if (token === '--state-file' && next) {
      out.stateFile = next;
      i += 1;
      continue;
    }
    if (token === '--webhook-url' && next) {
      out.webhookUrl = next;
      i += 1;
      continue;
    }
    if (token === '--webhook' && next) {
      out.webhookUrl = next;
      i += 1;
      continue;
    }
    if (token === '--webhook-token' && next) {
      out.webhookToken = next;
      i += 1;
      continue;
    }
    if (token === '--message' && next) {
      out.message = next;
      i += 1;
      continue;
    }
    if (token === '--lang' && next) {
      out.lang = String(next).trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
      i += 1;
      continue;
    }
    if (token === '--policy-debug' && next) {
      out.includePolicyDebugHeader = toBool(next, out.includePolicyDebugHeader);
      i += 1;
      continue;
    }
    if (token === '--fail-on-high' && next) {
      out.failOnHigh = toBool(next, out.failOnHigh);
      i += 1;
      continue;
    }
    if (token === '--fail-on-warn' && next) {
      out.failOnWarn = toBool(next, out.failOnWarn);
      i += 1;
      continue;
    }
    if (token === '--window-minutes' && next) {
      const minutes = Number(next);
      if (Number.isFinite(minutes) && minutes > 0) {
        out.elevatedFailureWindowMs = Math.trunc(minutes * 60 * 1000);
      }
      i += 1;
      continue;
    }
  }

  out.samples = Math.max(1, Math.min(10000, out.samples));
  out.concurrency = Math.max(1, Math.min(64, out.concurrency));
  out.timeoutMs = Math.max(1000, Math.min(60000, out.timeoutMs));
  out.retryCount = Math.max(0, Math.min(3, out.retryCount));
  out.retryBackoffMs = Math.max(50, Math.min(5000, out.retryBackoffMs));
  out.elevatedFailureWindowMs = Math.max(60 * 1000, Math.min(24 * 60 * 60 * 1000, out.elevatedFailureWindowMs));
  return out;
}

function isoNow() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomToken(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch (_err) {
    return null;
  }
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function toNumberIfFinite(value) {
  if (value == null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractHeaders(headers) {
  return {
    variant: headers.get('x-aurora-variant'),
    bucketRaw: headers.get('x-aurora-bucket'),
    policyVersion: headers.get('x-aurora-policy-version'),
  };
}

function classifyAttempt(attempt) {
  const reasons = [];
  let infraFlake = false;
  let retryable = false;
  let hardFail = false;
  let parseError = false;

  if (attempt.error) {
    reasons.push('network_error');
    hardFail = true;
    retryable = true;
    infraFlake = true;
  }

  if (!attempt.error && attempt.status !== 200) {
    reasons.push(`non_200:${attempt.status}`);
    hardFail = true;
    retryable = attempt.status >= 500 || attempt.status === 429 || attempt.status === 403;
    if (attempt.status === 429 || attempt.status === 403) infraFlake = true;
  }

  if (!attempt.error && attempt.json == null) {
    reasons.push('json_parse_error');
    hardFail = true;
    parseError = true;
    retryable = true;
  }

  const text = String(attempt.text || '');
  if (/54113/.test(text)) {
    reasons.push('infra_54113');
    infraFlake = true;
    retryable = true;
  }

  const meta = isObject(attempt.json) ? attempt.json.meta : null;
  const headerBucket = toNumberIfFinite(attempt.headers.bucketRaw);
  const metaBucket = meta && Object.prototype.hasOwnProperty.call(meta, 'rollout_bucket')
    ? toNumberIfFinite(meta.rollout_bucket)
    : null;
  const metaVariant = meta && Object.prototype.hasOwnProperty.call(meta, 'rollout_variant') ? String(meta.rollout_variant || '') : '';
  const metaPolicy = meta && Object.prototype.hasOwnProperty.call(meta, 'policy_version') ? String(meta.policy_version || '') : '';

  const invariants = {
    metaNull: !isObject(meta),
    bucketOutOfRange:
      headerBucket != null
        ? !(headerBucket >= 0 && headerBucket <= 99)
        : true,
    variantMismatch:
      isObject(meta) && attempt.headers.variant != null
        ? String(attempt.headers.variant || '') !== metaVariant
        : false,
    bucketMismatch:
      isObject(meta) && headerBucket != null && metaBucket != null
        ? headerBucket !== metaBucket
        : false,
    policyMismatch:
      isObject(meta) && attempt.headers.policyVersion != null
        ? String(attempt.headers.policyVersion || '') !== metaPolicy
        : false,
  };

  if (invariants.metaNull) reasons.push('meta_null');
  if (invariants.bucketOutOfRange) reasons.push('bucket_out_of_range');
  if (invariants.variantMismatch) reasons.push('variant_mismatch');
  if (invariants.bucketMismatch) reasons.push('bucket_mismatch');
  if (invariants.policyMismatch) reasons.push('policy_mismatch');

  return {
    reasons,
    retryable,
    infraFlake,
    hardFail,
    parseError,
    invariants,
    meta,
    headerBucket,
    metaBucket,
  };
}

async function runAttempt({ cfg, index }) {
  const sessionId = randomToken(`rollout_probe_session_${index}`);
  const uid = randomToken(`rollout_probe_uid_${index}`);
  const payload = {
    message: cfg.message,
    session: { state: 'idle', session_id: sessionId },
    language: cfg.lang,
  };

  const headers = {
    'content-type': 'application/json',
    'x-aurora-uid': uid,
    'x-lang': cfg.lang,
  };
  if (cfg.includePolicyDebugHeader) headers['x-aurora-policy-debug'] = '1';

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.base}${cfg.endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    const json = parseJsonSafe(text);
    const elapsedMs = Date.now() - started;
    return {
      ok: true,
      status: res.status,
      elapsedMs,
      text,
      json,
      headers: extractHeaders(res.headers),
      request: { uid, sessionId },
    };
  } catch (err) {
    const elapsedMs = Date.now() - started;
    return {
      ok: false,
      status: 0,
      elapsedMs,
      text: '',
      json: null,
      headers: { variant: null, bucketRaw: null, policyVersion: null },
      error: String(err && err.message ? err.message : err),
      request: { uid, sessionId },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runSampleWithRetry({ cfg, index }) {
  const attempts = [];
  const first = await runAttempt({ cfg, index });
  const firstClass = classifyAttempt(first);
  attempts.push({ attempt: first, eval: firstClass });

  if (
    (firstClass.hardFail || firstClass.invariants.metaNull || firstClass.invariants.bucketOutOfRange || firstClass.invariants.variantMismatch || firstClass.invariants.bucketMismatch || firstClass.invariants.policyMismatch) &&
    firstClass.retryable &&
    cfg.retryCount > 0
  ) {
    await sleep(cfg.retryBackoffMs);
    const second = await runAttempt({ cfg, index });
    const secondClass = classifyAttempt(second);
    attempts.push({ attempt: second, eval: secondClass });
  }

  const final = attempts[attempts.length - 1];
  const recovered = attempts.length > 1 && !final.eval.hardFail && !final.eval.invariants.metaNull &&
    !final.eval.invariants.bucketOutOfRange && !final.eval.invariants.variantMismatch &&
    !final.eval.invariants.bucketMismatch && !final.eval.invariants.policyMismatch;

  return {
    index,
    attempts: attempts.map((row, idx) => ({
      idx,
      status: row.attempt.status,
      elapsed_ms: row.attempt.elapsedMs,
      error: row.attempt.error || null,
      headers: row.attempt.headers,
      reasons: row.eval.reasons,
      infra_flake: row.eval.infraFlake,
      retryable: row.eval.retryable,
    })),
    recovered_after_retry: recovered,
    final: {
      status: final.attempt.status,
      elapsed_ms: final.attempt.elapsedMs,
      error: final.attempt.error || null,
      headers: final.attempt.headers,
      meta: final.eval.meta,
      invariants: final.eval.invariants,
      reasons: final.eval.reasons,
      infra_flake: final.eval.infraFlake,
      parse_error: final.eval.parseError,
      request: final.attempt.request,
    },
  };
}

function pct(part, total) {
  if (!total) return 0;
  return Number(((part / total) * 100).toFixed(2));
}

function aggregateRows(rows) {
  const total = rows.length;
  const counts = {
    success_200: 0,
    non_200_count: 0,
    parse_error_count: 0,
    network_error_count: 0,
    meta_null_count: 0,
    variant_mismatch_count: 0,
    bucket_mismatch_count: 0,
    policy_mismatch_count: 0,
    bucket_out_of_range_count: 0,
    infra_flake_count: 0,
    recovered_after_retry_count: 0,
  };
  const variantCounts = {};
  const policyCounts = {};
  const bucketValues = [];
  const failures = [];

  for (const row of rows) {
    const f = row.final || {};
    const inv = isObject(f.invariants) ? f.invariants : {};
    const reasons = Array.isArray(f.reasons) ? f.reasons : [];

    if (row.recovered_after_retry) counts.recovered_after_retry_count += 1;
    if (f.status === 200) counts.success_200 += 1;
    else counts.non_200_count += 1;
    if (f.error) counts.network_error_count += 1;
    if (f.parse_error) counts.parse_error_count += 1;
    if (f.infra_flake) counts.infra_flake_count += 1;
    if (inv.metaNull) counts.meta_null_count += 1;
    if (inv.variantMismatch) counts.variant_mismatch_count += 1;
    if (inv.bucketMismatch) counts.bucket_mismatch_count += 1;
    if (inv.policyMismatch) counts.policy_mismatch_count += 1;
    if (inv.bucketOutOfRange) counts.bucket_out_of_range_count += 1;

    const variant = (f.headers && f.headers.variant) || 'missing';
    const policy = (f.headers && f.headers.policyVersion) || 'missing';
    variantCounts[variant] = (variantCounts[variant] || 0) + 1;
    policyCounts[policy] = (policyCounts[policy] || 0) + 1;
    const bucketN = toNumberIfFinite(f.headers && f.headers.bucketRaw);
    if (bucketN != null) bucketValues.push(bucketN);

    const hasInvariantFailure =
      inv.metaNull || inv.variantMismatch || inv.bucketMismatch || inv.policyMismatch || inv.bucketOutOfRange;
    if (f.status !== 200 || f.error || f.parse_error || hasInvariantFailure) {
      failures.push({
        index: row.index,
        status: f.status,
        reasons,
        headers: f.headers,
        meta: f.meta,
        request: f.request,
      });
    }
  }

  return {
    total_requests: total,
    ...counts,
    mismatch_count:
      counts.variant_mismatch_count + counts.bucket_mismatch_count + counts.policy_mismatch_count,
    header_variant_counts: variantCounts,
    header_variant_pct: Object.fromEntries(Object.entries(variantCounts).map(([k, v]) => [k, pct(v, total)])),
    header_policy_version_counts: policyCounts,
    bucket_min: bucketValues.length ? Math.min(...bucketValues) : null,
    bucket_max: bucketValues.length ? Math.max(...bucketValues) : null,
    failures,
  };
}

function evaluateAlertChecks({ summary, state, cfg, nowMs }) {
  const checks = [];
  const add = (id, severity, triggered, value, threshold, note) => {
    checks.push({ id, severity, triggered, value, threshold, note: note || '' });
  };

  add('meta_missing', 'high', summary.meta_null_count > 0, summary.meta_null_count, '> 0', 'meta must always be present');
  add('header_meta_mismatch', 'high', summary.mismatch_count > 0, summary.mismatch_count, '> 0', 'header/meta drift detected');
  add(
    'bucket_out_of_range',
    'high',
    summary.bucket_out_of_range_count > 0,
    summary.bucket_out_of_range_count,
    '> 0',
    'bucket must stay in [0,99]',
  );

  const currentFailureCount = summary.non_200_count + summary.parse_error_count;
  const windowStart = nowMs - cfg.elevatedFailureWindowMs;
  const recentFailureRuns = (Array.isArray(state.runs) ? state.runs : []).filter((run) =>
    Number(run.ts_ms) >= windowStart && Number(run.non_200_or_parse_error_count) > 0,
  ).length;
  const elevatedTriggered = currentFailureCount > 0 && recentFailureRuns >= 2;
  add(
    'elevated_failures',
    'high',
    elevatedTriggered,
    `${currentFailureCount} (recent_failure_runs=${recentFailureRuns})`,
    '>=2 runs with non_200_or_parse_error in 10m',
    'transient CDN failures need 2-run confirmation',
  );

  const infraOnlySingleRunWarn =
    currentFailureCount > 0 &&
    !elevatedTriggered &&
    summary.infra_flake_count > 0 &&
    summary.infra_flake_count === currentFailureCount;
  add(
    'infra_flake_single_run',
    'warn',
    infraOnlySingleRunWarn,
    summary.infra_flake_count,
    '> 0 on single run (no page)',
    'expected for intermittent CDN/WAF noise',
  );

  if (summary.total_requests >= cfg.splitDriftMinSamples) {
    const pctMap = summary.header_variant_pct || {};
    const corePct = Number(pctMap.v2_core || 0);
    const safetyPct = Number(pctMap.v2_safety || 0);
    const weatherPct = Number(pctMap.v2_weather || 0);
    const coreDrift = corePct < cfg.splitCoreMinPct || corePct > cfg.splitCoreMaxPct;
    const safetyDrift = safetyPct < cfg.splitSafetyMinPct || safetyPct > cfg.splitSafetyMaxPct;
    const weatherDrift = weatherPct < cfg.splitWeatherMinPct || weatherPct > cfg.splitWeatherMaxPct;
    add(
      'variant_split_drift',
      'warn',
      coreDrift || safetyDrift || weatherDrift,
      `core=${corePct} safety=${safetyPct} weather=${weatherPct}`,
      `core:[${cfg.splitCoreMinPct},${cfg.splitCoreMaxPct}] safety:[${cfg.splitSafetyMinPct},${cfg.splitSafetyMaxPct}] weather:[${cfg.splitWeatherMinPct},${cfg.splitWeatherMaxPct}]`,
      'warn only',
    );
  }

  let severity = 'none';
  if (checks.some((row) => row.triggered && row.severity === 'high')) severity = 'high';
  else if (checks.some((row) => row.triggered && row.severity === 'warn')) severity = 'warn';

  return { checks, severity };
}

async function loadState(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) return { runs: [] };
    if (!Array.isArray(parsed.runs)) parsed.runs = [];
    return parsed;
  } catch (_err) {
    return { runs: [] };
  }
}

async function saveState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
}

function updateState(state, runRecord, nowMs) {
  const runs = Array.isArray(state.runs) ? state.runs.slice() : [];
  runs.push(runRecord);
  const keepAfter = nowMs - 24 * 60 * 60 * 1000;
  state.runs = runs.filter((row) => Number(row.ts_ms) >= keepAfter).slice(-500);
  return state;
}

function renderMarkdown({ summary, alerts, cfg, reportPath, generatedAt }) {
  const lines = [];
  lines.push('# Aurora Rollout Probe');
  lines.push('');
  lines.push(`- generated_at_utc: ${generatedAt}`);
  lines.push(`- base: ${cfg.base}`);
  lines.push(`- endpoint: ${cfg.endpoint}`);
  lines.push(`- samples: ${cfg.samples}`);
  lines.push(`- report_json: ${reportPath}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- total_requests: ${summary.total_requests}`);
  lines.push(`- success_200: ${summary.success_200}`);
  lines.push(`- non_200_count: ${summary.non_200_count}`);
  lines.push(`- parse_error_count: ${summary.parse_error_count}`);
  lines.push(`- meta_null_count: ${summary.meta_null_count}`);
  lines.push(`- mismatch_count: ${summary.mismatch_count}`);
  lines.push(`- bucket_out_of_range_count: ${summary.bucket_out_of_range_count}`);
  lines.push(`- recovered_after_retry_count: ${summary.recovered_after_retry_count}`);
  lines.push('');
  lines.push('## Variant Split');
  lines.push('');
  lines.push('| variant | count | pct |');
  lines.push('| --- | ---: | ---: |');
  for (const [variant, count] of Object.entries(summary.header_variant_counts || {})) {
    lines.push(`| ${variant} | ${count} | ${summary.header_variant_pct && summary.header_variant_pct[variant] != null ? summary.header_variant_pct[variant] : 0}% |`);
  }
  lines.push('');
  lines.push('## Alert Checks');
  lines.push('');
  lines.push('| id | severity | triggered | value | threshold | note |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const row of alerts.checks) {
    lines.push(`| ${row.id} | ${row.severity} | ${row.triggered ? 'yes' : 'no'} | ${row.value} | ${row.threshold} | ${row.note} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function buildWebhookPayload({ summary, alerts, cfg, reportPath, generatedAt }) {
  const firstFailure = Array.isArray(summary.failures) && summary.failures.length ? summary.failures[0] : null;
  const triggered = alerts.checks.filter((row) => row.triggered);
  const headline = `[aurora-rollout-probe] ${alerts.severity.toUpperCase()} base=${cfg.base} non200=${summary.non_200_count} parse=${summary.parse_error_count} meta_null=${summary.meta_null_count} mismatch=${summary.mismatch_count}`;
  return {
    text: headline,
    source: 'aurora_rollout_probe',
    generated_at_utc: generatedAt,
    severity: alerts.severity,
    base: cfg.base,
    endpoint: cfg.endpoint,
    report_path: reportPath,
    summary: {
      total_requests: summary.total_requests,
      success_200: summary.success_200,
      non_200_count: summary.non_200_count,
      parse_error_count: summary.parse_error_count,
      meta_null_count: summary.meta_null_count,
      mismatch_count: summary.mismatch_count,
      bucket_out_of_range_count: summary.bucket_out_of_range_count,
      recovered_after_retry_count: summary.recovered_after_retry_count,
      header_variant_counts: summary.header_variant_counts,
      header_variant_pct: summary.header_variant_pct,
    },
    triggered_checks: triggered,
    first_failure_example: firstFailure,
  };
}

async function postWebhook(url, payload, timeoutMs = 8000, token = '') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (token) {
      headers.authorization = `Bearer ${token}`;
      headers['x-aurora-probe-token'] = token;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`webhook status=${res.status} body=${String(text || '').slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function runProbe(cfg) {
  const rows = [];
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= cfg.samples) return;
      const row = await runSampleWithRetry({ cfg, index });
      rows.push(row);
    }
  }

  await Promise.all(Array.from({ length: cfg.concurrency }, () => worker()));
  rows.sort((a, b) => a.index - b.index);
  return rows;
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const startedAt = isoNow();
  const rows = await runProbe(cfg);
  const summary = aggregateRows(rows);
  const nowMs = Date.now();

  const state = await loadState(cfg.stateFile);
  updateState(
    state,
    {
      ts_ms: nowMs,
      non_200_or_parse_error_count: summary.non_200_count + summary.parse_error_count,
      report_hint: `${summary.non_200_count}/${summary.parse_error_count}/${summary.meta_null_count}/${summary.mismatch_count}`,
    },
    nowMs,
  );
  const alerts = evaluateAlertChecks({ summary, state, cfg, nowMs });
  await saveState(cfg.stateFile, state);

  const generatedAt = isoNow();
  const stamp = generatedAt.replace(/[:.]/g, '-');
  await fs.mkdir(cfg.outDir, { recursive: true });
  const reportJsonPath = path.join(cfg.outDir, `aurora_rollout_probe_${stamp}.json`);
  const reportMdPath = path.join(cfg.outDir, `aurora_rollout_probe_${stamp}.md`);
  const payload = {
    started_at_utc: startedAt,
    finished_at_utc: generatedAt,
    config: {
      base: cfg.base,
      endpoint: cfg.endpoint,
      samples: cfg.samples,
      concurrency: cfg.concurrency,
      timeout_ms: cfg.timeoutMs,
      retry_count: cfg.retryCount,
      retry_backoff_ms: cfg.retryBackoffMs,
      include_policy_debug_header: cfg.includePolicyDebugHeader,
    },
    summary: {
      ...summary,
      failures: summary.failures.slice(0, 10),
    },
    alerts,
    rows,
  };

  await fs.writeFile(reportJsonPath, JSON.stringify(payload, null, 2));
  await fs.writeFile(reportMdPath, renderMarkdown({ summary, alerts, cfg, reportPath: reportJsonPath, generatedAt }));

  let webhookError = null;
  if (cfg.webhookUrl && (alerts.severity === 'high' || alerts.severity === 'warn')) {
    try {
      await postWebhook(
        cfg.webhookUrl,
        buildWebhookPayload({ summary, alerts, cfg, reportPath: reportJsonPath, generatedAt }),
        8000,
        cfg.webhookToken,
      );
    } catch (err) {
      webhookError = String(err && err.message ? err.message : err);
    }
  }

  const stdoutSummary = {
    started_at: startedAt,
    finished_at: generatedAt,
    base: cfg.base,
    total_requests: summary.total_requests,
    success_200: summary.success_200,
    non_200_count: summary.non_200_count,
    parse_error_count: summary.parse_error_count,
    meta_null_count: summary.meta_null_count,
    mismatch_count: summary.mismatch_count,
    bucket_out_of_range_count: summary.bucket_out_of_range_count,
    header_variant_counts: summary.header_variant_counts,
    header_variant_pct: summary.header_variant_pct,
    bucket_min: summary.bucket_min,
    bucket_max: summary.bucket_max,
    recovered_after_retry_count: summary.recovered_after_retry_count,
    alert_severity: alerts.severity,
    triggered_alerts: alerts.checks.filter((row) => row.triggered).map((row) => row.id),
    webhook_error: webhookError,
    report_json: reportJsonPath,
    report_md: reportMdPath,
  };
  process.stdout.write(`${JSON.stringify(stdoutSummary, null, 2)}\n`);

  if (alerts.severity === 'high' && cfg.failOnHigh) process.exit(2);
  if (alerts.severity === 'warn' && cfg.failOnWarn) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[aurora_rollout_probe] fatal: ${String(err && err.stack ? err.stack : err)}\n`);
    process.exit(1);
  });
}

module.exports = {
  __internal: {
    parseArgs,
    classifyAttempt,
    aggregateRows,
    evaluateAlertChecks,
    updateState,
    parseJsonSafe,
    toBool,
    toInt,
    toFloat,
  },
};
