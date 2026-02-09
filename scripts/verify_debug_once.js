#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const { runGeminiShadowVerify } = require('../src/auroraBff/diagVerify');

function parseArgs(argv) {
  const out = {
    image: '',
    lang: 'EN',
    quality: 'pass',
    dryRun: false,
    traceId: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next) continue;
    if (token === '--image') {
      out.image = next;
      index += 1;
      continue;
    }
    if (token === '--lang') {
      out.lang = next;
      index += 1;
      continue;
    }
    if (token === '--quality') {
      out.quality = next;
      index += 1;
      continue;
    }
    if (token === '--trace-id') {
      out.traceId = next;
      index += 1;
    }
  }
  return out;
}

function normalizeLang(raw) {
  return String(raw || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
}

function normalizeQuality(raw) {
  const token = String(raw || '')
    .trim()
    .toLowerCase();
  if (token === 'pass' || token === 'degraded' || token === 'fail') return token;
  return 'pass';
}

function suggestionForReason(reason) {
  const token = String(reason || '').trim().toUpperCase();
  if (!token || token === 'OK') return 'Verifier call succeeded. Review structured output and compare with metrics.';
  if (token.includes('MISSING_KEY') || token === 'UPSTREAM_4XX') return 'Check Gemini API key/project permission and endpoint auth scope.';
  if (token === 'RATE_LIMIT' || token.includes('RATE_LIMITED')) return 'Reduce QPS or raise per-minute limit; retry after backoff.';
  if (token === 'QUOTA' || token.includes('QUOTA_EXCEEDED')) return 'Increase API quota/billing budget or switch to a higher quota project.';
  if (token === 'TIMEOUT') return 'Increase DIAG_VERIFY_TIMEOUT_MS and inspect upstream latency/network path.';
  if (token === 'UPSTREAM_5XX') return 'Treat as transient upstream failure; retry and monitor provider health.';
  if (token === 'SCHEMA_INVALID') return 'Inspect provider JSON and schema constraints; tighten prompt/schema alignment.';
  if (token === 'IMAGE_FETCH_FAILED' || token.includes('IMAGE_INVALID')) {
    return 'Verify image format/size/content-type and ensure the image bytes are readable.';
  }
  if (token === 'NETWORK_ERROR') return 'Check DNS/TLS/connectivity between app host and verifier provider endpoint.';
  if (token === 'VERIFY_BUDGET_GUARD') return 'Increase DIAG_VERIFY_MAX_CALLS_PER_MIN/DIAG_VERIFY_MAX_CALLS_PER_DAY or wait for window reset.';
  return 'Inspect structured verifier logs (reason/http_status/error_class) and compare with provider response metadata.';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.image) {
    throw new Error('missing required argument: --image <path>');
  }

  const absImagePath = path.resolve(process.cwd(), args.image);
  const imageBuffer = await fs.readFile(absImagePath);
  const traceId = String(args.traceId || '').trim() || `verify_debug_${Date.now()}`;
  const language = normalizeLang(args.lang);
  const qualityGrade = normalizeQuality(args.quality);
  const requestPayloadBytesLen = imageBuffer.length > 0 ? Math.ceil((imageBuffer.length / 3)) * 4 : 0;

  if (args.dryRun) {
    const dryRun = {
      dry_run: true,
      provider: 'gemini_provider',
      trace_id: traceId,
      image_path: absImagePath,
      image_bytes_len: imageBuffer.length,
      request_payload_bytes_len: requestPayloadBytesLen,
      language,
      quality_grade: qualityGrade,
      verify_enabled_flag: String(process.env.DIAG_GEMINI_VERIFY || '').trim() || 'false',
      timeout_ms: Number(process.env.DIAG_VERIFY_TIMEOUT_MS || process.env.DIAG_GEMINI_VERIFY_TIMEOUT_MS || 12000),
      note: 'No upstream request executed in dry-run mode.',
    };
    process.stdout.write(`${JSON.stringify(dryRun, null, 2)}\n`);
    return;
  }

  let failEvent = null;
  const verify = await runGeminiShadowVerify({
    imageBuffer,
    language,
    photoQuality: { grade: qualityGrade, reasons: [] },
    usedPhotos: true,
    diagnosisV1: { photo_findings: [], quality: { grade: qualityGrade } },
    diagnosisInternal: {},
    profileSummary: {},
    recentLogsSummary: {},
    inferenceId: traceId,
    traceId,
    logger: {
      info: () => {},
      warn: () => {},
    },
    metricsHooks: {
      onVerifyFail: (event) => {
        failEvent = event;
      },
    },
  });

  const reason = String(
    (failEvent && (failEvent.reason || failEvent.final_reason)) ||
      verify.verify_fail_reason ||
      verify.final_reason ||
      (verify.ok ? 'OK' : 'UNKNOWN'),
  ).trim() || 'UNKNOWN';
  const httpStatus = Number.isFinite(Number((failEvent && failEvent.provider_status_code) || verify.provider_status_code))
    ? Number((failEvent && failEvent.provider_status_code) || verify.provider_status_code)
    : null;
  const latencyMs = Number.isFinite(Number((failEvent && failEvent.latency_ms) || verify.latency_ms))
    ? Number((failEvent && failEvent.latency_ms) || verify.latency_ms)
    : null;
  const attempts = Number.isFinite(Number((failEvent && failEvent.attempts) || verify.attempts))
    ? Number((failEvent && failEvent.attempts) || verify.attempts)
    : null;

  const output = {
    provider: 'gemini_provider',
    trace_id: traceId,
    decision: verify.decision,
    reason,
    http_status: httpStatus,
    http_status_class: (failEvent && failEvent.http_status_class) || null,
    latency_ms: latencyMs,
    attempts,
    next_step: suggestionForReason(reason),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
