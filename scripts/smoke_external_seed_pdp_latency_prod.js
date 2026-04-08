#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const DEFAULT_GATEWAY = 'https://agent.pivota.cc/api/gateway';
const DEFAULT_FIXTURE = path.join(__dirname, 'fixtures', 'external_seed_pdp_latency_gate.json');

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function parsePositiveInt(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeCase(rawCase, index, thresholds) {
  const merchantId = String(rawCase?.merchant_id || 'external_seed').trim() || 'external_seed';
  const productId = String(rawCase?.product_id || '').trim();
  if (!productId) {
    throw new Error(`cases[${index}].product_id is required`);
  }
  return {
    key: String(rawCase?.key || productId).trim() || productId,
    merchant_id: merchantId,
    product_id: productId,
    title: String(rawCase?.title || '').trim() || null,
    thresholds: {
      cold_pdp_max_ms: parsePositiveInt(rawCase?.cold_pdp_max_ms, thresholds.cold_pdp_max_ms),
      warm_pdp_max_ms: parsePositiveInt(rawCase?.warm_pdp_max_ms, thresholds.warm_pdp_max_ms),
      cold_similar_max_ms: parsePositiveInt(rawCase?.cold_similar_max_ms, thresholds.cold_similar_max_ms),
      warm_similar_max_ms: parsePositiveInt(rawCase?.warm_similar_max_ms, thresholds.warm_similar_max_ms),
      min_similar_count: parsePositiveInt(rawCase?.min_similar_count, thresholds.min_similar_count),
    },
  };
}

function loadConfig() {
  const fixturePath = path.resolve(
    String(
      argValue('cases-file') ||
        process.env.PDP_EXTERNAL_LATENCY_CASES_FILE ||
        DEFAULT_FIXTURE,
    ),
  );
  const fixture = readJsonFile(fixturePath);
  const thresholds = {
    cold_pdp_max_ms: parsePositiveInt(fixture?.thresholds?.cold_pdp_max_ms, 4500),
    warm_pdp_max_ms: parsePositiveInt(fixture?.thresholds?.warm_pdp_max_ms, 1500),
    cold_similar_max_ms: parsePositiveInt(fixture?.thresholds?.cold_similar_max_ms, 4500),
    warm_similar_max_ms: parsePositiveInt(fixture?.thresholds?.warm_similar_max_ms, 3500),
    min_similar_count: parsePositiveInt(fixture?.thresholds?.min_similar_count, 4),
  };
  const cases = (Array.isArray(fixture?.cases) ? fixture.cases : []).map((item, index) =>
    normalizeCase(item, index, thresholds),
  );
  if (!cases.length) {
    throw new Error(`No cases configured in ${fixturePath}`);
  }
  return {
    fixture_path: fixturePath,
    gateway: String(argValue('gateway') || process.env.PDP_EXTERNAL_LATENCY_GATEWAY || DEFAULT_GATEWAY).trim(),
    timeout_ms: parsePositiveInt(
      argValue('timeout-ms') || process.env.PDP_EXTERNAL_LATENCY_TIMEOUT_MS,
      parsePositiveInt(fixture?.timeout_ms, 12000),
    ),
    rounds: parsePositiveInt(
      argValue('rounds') || process.env.PDP_EXTERNAL_LATENCY_ROUNDS,
      parsePositiveInt(fixture?.rounds, 2),
    ),
    report_file: argValue('report-file') || process.env.PDP_EXTERNAL_LATENCY_REPORT_FILE || '',
    thresholds,
    cases,
  };
}

async function timedFetchJson(url, body, timeoutMs) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      ms: Date.now() - startedAt,
      json,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - startedAt,
      json: null,
      error:
        err && err.name === 'AbortError'
          ? 'TIMEOUT'
          : err instanceof Error
            ? err.message
            : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildGetPdpBody(target) {
  return {
    operation: 'get_pdp_v2',
    payload: {
      product_ref: {
        merchant_id: target.merchant_id,
        product_id: target.product_id,
      },
      options: {
        debug: true,
      },
      capabilities: {
        client: 'external_pdp_latency_gate',
      },
    },
  };
}

function buildFindSimilarBody(target) {
  return {
    operation: 'find_similar_products',
    payload: {
      similar: {
        merchant_id: target.merchant_id,
        product_id: target.product_id,
        limit: 6,
      },
      options: {
        debug: true,
      },
      capabilities: {
        client: 'external_pdp_latency_gate',
      },
    },
  };
}

function extractCommit(payload) {
  return String(payload?.metadata?.service_version?.commit || payload?.build_id || '').trim() || null;
}

function extractSimilarCount(payload) {
  if (Array.isArray(payload?.products)) return payload.products.length;
  if (Array.isArray(payload?.items)) return payload.items.length;
  return 0;
}

function summarizeOperation(result) {
  const payload = result?.json || null;
  return {
    ok: Boolean(result?.ok && payload?.status === 'success'),
    status: result?.status || 0,
    latency_ms: Math.max(0, Number(result?.ms || 0)),
    commit: extractCommit(payload),
    similar_count: extractSimilarCount(payload),
    underfill: Number.isFinite(Number(payload?.metadata?.underfill))
      ? Number(payload.metadata.underfill)
      : null,
    underfill_reason:
      typeof payload?.metadata?.underfill_reason === 'string' && payload.metadata.underfill_reason.trim()
        ? payload.metadata.underfill_reason.trim()
        : null,
    raw_error: result?.error || null,
  };
}

async function runCaseRound(gateway, timeoutMs, target) {
  const pdp = summarizeOperation(
    await timedFetchJson(gateway, buildGetPdpBody(target), timeoutMs),
  );
  const similar = summarizeOperation(
    await timedFetchJson(gateway, buildFindSimilarBody(target), timeoutMs),
  );
  return { pdp, similar };
}

function validateCase(target, rounds) {
  const failures = [];
  const warnings = [];
  const cold = rounds[0] || { pdp: {}, similar: {} };
  const warm = rounds[rounds.length - 1] || { pdp: {}, similar: {} };
  const seenCommits = new Set(
    rounds
      .flatMap((round) => [round?.pdp?.commit, round?.similar?.commit])
      .filter(Boolean),
  );

  if (!cold.pdp.ok) failures.push(`${target.key}: cold get_pdp_v2 failed (${cold.pdp.status || 0}) ${cold.pdp.raw_error || ''}`.trim());
  if (!cold.similar.ok) failures.push(`${target.key}: cold find_similar_products failed (${cold.similar.status || 0}) ${cold.similar.raw_error || ''}`.trim());
  if (!warm.pdp.ok) failures.push(`${target.key}: warm get_pdp_v2 failed (${warm.pdp.status || 0}) ${warm.pdp.raw_error || ''}`.trim());
  if (!warm.similar.ok) failures.push(`${target.key}: warm find_similar_products failed (${warm.similar.status || 0}) ${warm.similar.raw_error || ''}`.trim());

  if (seenCommits.size !== 1) {
    failures.push(`${target.key}: mixed_service_commits ${JSON.stringify(Array.from(seenCommits))}`);
  }
  if (!warm.pdp.commit) failures.push(`${target.key}: warm get_pdp_v2 missing service_version.commit`);
  if (!warm.similar.commit) failures.push(`${target.key}: warm find_similar_products missing service_version.commit`);

  if (cold.pdp.latency_ms > target.thresholds.cold_pdp_max_ms) {
    failures.push(`${target.key}: cold get_pdp_v2 latency ${cold.pdp.latency_ms}ms exceeds ${target.thresholds.cold_pdp_max_ms}ms`);
  }
  if (warm.pdp.latency_ms > target.thresholds.warm_pdp_max_ms) {
    failures.push(`${target.key}: warm get_pdp_v2 latency ${warm.pdp.latency_ms}ms exceeds ${target.thresholds.warm_pdp_max_ms}ms`);
  }
  if (cold.similar.latency_ms > target.thresholds.cold_similar_max_ms) {
    failures.push(`${target.key}: cold find_similar_products latency ${cold.similar.latency_ms}ms exceeds ${target.thresholds.cold_similar_max_ms}ms`);
  }
  if (warm.similar.latency_ms > target.thresholds.warm_similar_max_ms) {
    failures.push(`${target.key}: warm find_similar_products latency ${warm.similar.latency_ms}ms exceeds ${target.thresholds.warm_similar_max_ms}ms`);
  }
  if (warm.similar.similar_count < target.thresholds.min_similar_count) {
    failures.push(
      `${target.key}: warm similar_count ${warm.similar.similar_count} below ${target.thresholds.min_similar_count}`,
    );
  }
  if (Number(warm.similar.underfill || 0) > 0) {
    warnings.push(
      `${target.key}: underfill=${warm.similar.underfill} reason=${warm.similar.underfill_reason || 'unknown'}`,
    );
  }

  return { failures, warnings };
}

async function runGate(config) {
  const caseReports = [];
  const allFailures = [];
  const allWarnings = [];

  for (const target of config.cases) {
    const rounds = [];
    for (let round = 1; round <= config.rounds; round += 1) {
      const result = await runCaseRound(config.gateway, config.timeout_ms, target);
      rounds.push({
        round,
        pdp: result.pdp,
        similar: result.similar,
      });
    }
    const validation = validateCase(target, rounds);
    allFailures.push(...validation.failures);
    allWarnings.push(...validation.warnings);
    caseReports.push({
      key: target.key,
      title: target.title,
      merchant_id: target.merchant_id,
      product_id: target.product_id,
      rounds,
      latest_commit:
        rounds[rounds.length - 1]?.similar?.commit ||
        rounds[rounds.length - 1]?.pdp?.commit ||
        null,
      failures: validation.failures,
      warnings: validation.warnings,
    });
  }

  const commits = Array.from(
    new Set(
      caseReports
        .map((item) => item.latest_commit)
        .filter(Boolean),
    ),
  );

  return {
    ok: allFailures.length === 0,
    gateway: config.gateway,
    rounds: config.rounds,
    fixture_path: config.fixture_path,
    summary: {
      case_count: caseReports.length,
      failure_count: allFailures.length,
      warning_count: allWarnings.length,
      commits,
      stable_commit: commits.length === 1 ? commits[0] : null,
    },
    cases: caseReports,
    failures: allFailures,
    warnings: allWarnings,
  };
}

async function main() {
  const config = loadConfig();
  const report = await runGate(config);
  const output = JSON.stringify(report, null, 2);
  if (config.report_file) {
    fs.writeFileSync(path.resolve(config.report_file), output);
  }
  process.stdout.write(`${output}\n`);
  if (!report.ok) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    const message = err instanceof Error ? err.stack || err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_FIXTURE,
  DEFAULT_GATEWAY,
  buildFindSimilarBody,
  buildGetPdpBody,
  extractCommit,
  extractSimilarCount,
  loadConfig,
  runGate,
  summarizeOperation,
  timedFetchJson,
  validateCase,
};
