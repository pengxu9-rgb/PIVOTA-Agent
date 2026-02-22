#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const cur = argv[i];
    if (!String(cur).startsWith('--')) continue;
    const key = String(cur).slice(2);
    const next = argv[i + 1];
    if (!next || String(next).startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function toBool(value, fallback = false) {
  if (value == null) return fallback;
  const norm = String(value).trim().toLowerCase();
  if (!norm) return fallback;
  return norm === '1' || norm === 'true' || norm === 'yes' || norm === 'y' || norm === 'on';
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function loadJsonlCases(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`Failed to parse JSONL at line ${idx + 1}: ${String(err && err.message ? err.message : err)}`);
      }
    });
}

function mergeExpected(caseDef, mode) {
  const base = caseDef && caseDef.expected && typeof caseDef.expected === 'object' ? caseDef.expected : {};
  const modePatch =
    mode === 'local-mock'
      ? caseDef && caseDef.expected_local && typeof caseDef.expected_local === 'object'
        ? caseDef.expected_local
        : {}
      : caseDef && caseDef.expected_live && typeof caseDef.expected_live === 'object'
        ? caseDef.expected_live
        : {};
  return { ...base, ...modePatch };
}

function mkJsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function makeAbortError(message = 'timeout') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function buildWeatherDailyPayload() {
  return {
    time: ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'],
    temperature_2m_max: [28, 29, 30, 28, 27],
    temperature_2m_min: [22, 23, 24, 22, 21],
    uv_index_max: [8, 9, 10, 8, 7],
    precipitation_sum: [2.1, 0.5, 0.0, 1.7, 0.9],
    wind_speed_10m_max: [14, 16, 15, 13, 12],
    relative_humidity_2m_mean: [72, 75, 78, 74, 70],
  };
}

function buildMockFetch(caseDef) {
  const behavior = String(caseDef && caseDef.mock_behavior ? caseDef.mock_behavior : 'success').trim();
  let calls = 0;

  const mockFetch = async (input) => {
    calls += 1;
    const rawUrl = typeof input === 'string' ? input : input && input.url ? input.url : '';
    const url = new URL(String(rawUrl));
    const host = String(url.hostname || '');

    if (host.includes('geocoding-api.open-meteo.com')) {
      if (behavior === 'geocode_timeout') throw makeAbortError('geocode timeout');
      if (behavior === 'geocode_http_500') return mkJsonResponse(500, { error: 'geocode failed' });
      if (behavior === 'geocode_no_results') return mkJsonResponse(200, { results: [] });

      const name = String(url.searchParams.get('name') || 'Unknown');
      return mkJsonResponse(200, {
        results: [
          {
            name,
            latitude: 35.6762,
            longitude: 139.6503,
            country: 'MockCountry',
            timezone: 'Asia/Tokyo',
          },
        ],
      });
    }

    if (host.includes('api.open-meteo.com')) {
      if (behavior === 'forecast_timeout') throw makeAbortError('forecast timeout');
      if (behavior === 'forecast_http_500') return mkJsonResponse(503, { error: 'forecast failed' });

      return mkJsonResponse(200, {
        timezone: 'Asia/Tokyo',
        generationtime_ms: 0.42,
        daily: buildWeatherDailyPayload(),
      });
    }

    return mkJsonResponse(404, { error: 'unknown host in mock fetch' });
  };

  mockFetch.getCallCount = () => calls;
  return mockFetch;
}

function extractMeta(body) {
  if (body && body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)) return body.meta;
  if (
    body &&
    body.session_patch &&
    typeof body.session_patch === 'object' &&
    !Array.isArray(body.session_patch) &&
    body.session_patch.meta &&
    typeof body.session_patch.meta === 'object' &&
    !Array.isArray(body.session_patch.meta)
  ) {
    return body.session_patch.meta;
  }
  return null;
}

function extractTravelMissingFields(body) {
  const events = body && Array.isArray(body.events) ? body.events : [];
  const evt = events.find((item) => item && item.event_name === 'travel_planning_gate');
  const fields = evt && evt.data && Array.isArray(evt.data.missing_fields) ? evt.data.missing_fields : [];
  return fields.map((f) => String(f || '').trim()).filter(Boolean);
}

function assertIncludesAny(target, expectedAny) {
  if (!Array.isArray(expectedAny) || !expectedAny.length) return true;
  return expectedAny.some((item) => target.includes(String(item)));
}

function assertIncludesAll(target, expectedAll) {
  if (!Array.isArray(expectedAll) || !expectedAll.length) return true;
  return expectedAll.every((item) => target.includes(String(item)));
}

function buildHeaderMap(inputHeaders = {}) {
  const out = {};
  for (const [k, v] of Object.entries(inputHeaders || {})) {
    out[String(k).toLowerCase()] = String(v);
  }
  return out;
}

function checkHeaderMetaMismatch(headers, meta) {
  if (!meta || typeof meta !== 'object') return { mismatch: false, details: [] };
  const details = [];
  const variant = headers['x-aurora-variant'];
  const bucket = headers['x-aurora-bucket'];
  const policyVersion = headers['x-aurora-policy-version'];

  if (variant && String(meta.rollout_variant || '') && String(meta.rollout_variant) !== String(variant)) {
    details.push(`variant header=${variant} meta=${String(meta.rollout_variant)}`);
  }
  if (bucket && Number.isFinite(Number(meta.rollout_bucket)) && Number(meta.rollout_bucket) !== Number(bucket)) {
    details.push(`bucket header=${bucket} meta=${String(meta.rollout_bucket)}`);
  }
  if (policyVersion && String(meta.policy_version || '') && String(meta.policy_version) !== String(policyVersion)) {
    details.push(`policy_version header=${policyVersion} meta=${String(meta.policy_version)}`);
  }

  return { mismatch: details.length > 0, details };
}

function evaluateCase({ caseDef, mode, status, body, headers, meta, strictMeta, fetchCalls }) {
  const expectation = mergeExpected(caseDef, mode);
  const errors = [];
  const warnings = [];

  if (status !== 200) {
    errors.push(`HTTP status expected 200, got ${status}`);
  }

  if (strictMeta && !meta) {
    errors.push('meta is missing');
  }

  const assistantText = String(
    body &&
      body.assistant_message &&
      typeof body.assistant_message === 'object' &&
      typeof body.assistant_message.content === 'string'
      ? body.assistant_message.content
      : '',
  );

  const cards = body && Array.isArray(body.cards) ? body.cards : [];
  const cardTypes = cards.map((item) => String((item && item.type) || '')).filter(Boolean);
  const missingFields = extractTravelMissingFields(body);

  if (expectation.intent_canonical && meta && String(meta.intent_canonical || '') !== String(expectation.intent_canonical)) {
    errors.push(`intent_canonical expected=${expectation.intent_canonical} actual=${String(meta.intent_canonical || '')}`);
  }

  if (expectation.gate_type && meta && String(meta.gate_type || '') !== String(expectation.gate_type)) {
    errors.push(`gate_type expected=${expectation.gate_type} actual=${String(meta.gate_type || '')}`);
  }

  if (Array.isArray(expectation.required_fields_any) && expectation.required_fields_any.length) {
    if (!assertIncludesAny(missingFields, expectation.required_fields_any)) {
      errors.push(`required_fields_any not satisfied, expected any of [${expectation.required_fields_any.join(', ')}], actual [${missingFields.join(', ')}]`);
    }
  }

  if (Array.isArray(expectation.required_fields_all) && expectation.required_fields_all.length) {
    if (!assertIncludesAll(missingFields, expectation.required_fields_all)) {
      errors.push(`required_fields_all not satisfied, expected all of [${expectation.required_fields_all.join(', ')}], actual [${missingFields.join(', ')}]`);
    }
  }

  if (Array.isArray(expectation.must_have_card_types)) {
    for (const type of expectation.must_have_card_types) {
      if (!cardTypes.includes(String(type))) {
        errors.push(`missing required card type: ${String(type)}`);
      }
    }
  }

  if (Array.isArray(expectation.must_not_have_card_types)) {
    for (const type of expectation.must_not_have_card_types) {
      if (cardTypes.includes(String(type))) {
        errors.push(`forbidden card type present: ${String(type)}`);
      }
    }
  }

  if (Array.isArray(expectation.assistant_contains_any) && expectation.assistant_contains_any.length) {
    const lowerText = assistantText.toLowerCase();
    const hit = expectation.assistant_contains_any.some((item) => lowerText.includes(String(item).toLowerCase()));
    if (!hit) {
      errors.push(`assistant content missing any of [${expectation.assistant_contains_any.join(', ')}]`);
    }
  }

  if (Array.isArray(expectation.assistant_not_contains) && expectation.assistant_not_contains.length) {
    const lowerText = assistantText.toLowerCase();
    for (const phrase of expectation.assistant_not_contains) {
      if (lowerText.includes(String(phrase).toLowerCase())) {
        errors.push(`assistant content includes forbidden phrase: ${String(phrase)}`);
      }
    }
  }

  if (Array.isArray(expectation.env_source_in) && expectation.env_source_in.length && meta) {
    const source = String(meta.env_source || '');
    if (!expectation.env_source_in.includes(source)) {
      errors.push(`env_source expected one of [${expectation.env_source_in.join(', ')}], actual=${source || 'null'}`);
    }
  }

  if (typeof expectation.degraded === 'boolean' && meta) {
    if (Boolean(meta.degraded) !== expectation.degraded) {
      errors.push(`degraded expected=${String(expectation.degraded)} actual=${String(Boolean(meta.degraded))}`);
    }
  }

  if (mode === 'local-mock') {
    if (Number.isFinite(Number(expectation.min_fetch_calls))) {
      const min = Number(expectation.min_fetch_calls);
      if (Number(fetchCalls) < min) {
        errors.push(`fetch calls expected >= ${min}, actual=${Number(fetchCalls)}`);
      }
    }
    if (Number.isFinite(Number(expectation.max_fetch_calls))) {
      const max = Number(expectation.max_fetch_calls);
      if (Number(fetchCalls) > max) {
        errors.push(`fetch calls expected <= ${max}, actual=${Number(fetchCalls)}`);
      }
    }
  } else if (mode === 'staging-live') {
    if (caseDef.category === 'complete_fields' && meta && String(meta.env_source || '') !== 'weather_api') {
      warnings.push(`complete_fields env_source=${String(meta.env_source || 'null')} (allowed in live mode)`);
    }
  }

  const mismatch = checkHeaderMetaMismatch(headers, meta);
  if (mismatch.mismatch) {
    errors.push(`header/meta mismatch: ${mismatch.details.join('; ')}`);
  }

  return {
    case_id: caseDef.case_id,
    category: caseDef.category,
    language: caseDef.language,
    status,
    passed: errors.length === 0,
    errors,
    warnings,
    intent_canonical: meta ? meta.intent_canonical || null : null,
    gate_type: meta ? meta.gate_type || null : null,
    env_source: meta ? meta.env_source || null : null,
    degraded: meta ? Boolean(meta.degraded) : null,
    required_fields: missingFields,
    card_types: cardTypes,
    fetch_calls: Number(fetchCalls),
    mismatch_count: mismatch.mismatch ? 1 : 0,
    meta_missing: meta ? 0 : 1,
  };
}

function buildMarkdownReport(payload) {
  const lines = [];
  lines.push('# Aurora Travel20 Gate');
  lines.push('');
  lines.push(`- mode: ${payload.mode}`);
  lines.push(`- base: ${payload.base || 'local'}`);
  lines.push(`- total: ${payload.summary.total}`);
  lines.push(`- passed: ${payload.summary.passed}`);
  lines.push(`- failed: ${payload.summary.failed}`);
  lines.push(`- meta_null_count: ${payload.summary.meta_null_count}`);
  lines.push(`- mismatch_count: ${payload.summary.mismatch_count}`);
  lines.push('');

  const failed = payload.results.filter((item) => !item.passed);
  if (!failed.length) {
    lines.push('All cases passed.');
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  lines.push('## Failed Cases');
  lines.push('');
  for (const row of failed) {
    lines.push(`### ${row.case_id}`);
    lines.push(`- category: ${row.category}`);
    lines.push(`- language: ${row.language}`);
    lines.push(`- status: ${row.status}`);
    for (const err of row.errors) {
      lines.push(`- error: ${err}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function runCommandRequestBody(caseDef) {
  return {
    message: caseDef.message,
    session: {
      state: 'idle',
      profile: caseDef.session_profile && typeof caseDef.session_profile === 'object' ? caseDef.session_profile : {},
    },
    language: caseDef.language,
  };
}

function buildCaseHeaders(caseDef, runId) {
  return {
    'X-Aurora-UID': `travel_gate_uid_${runId}_${caseDef.case_id}`,
    'X-Trace-ID': `travel_gate_trace_${runId}_${caseDef.case_id}`,
    'X-Brief-ID': `travel_gate_brief_${runId}`,
    'X-Lang': caseDef.language,
    'Content-Type': 'application/json',
  };
}

async function withTempEnv(envPatch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(envPatch || {})) {
    prev[k] = process.env[k];
    process.env[k] = String(v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function runLocalMockCases(cases, strictMeta) {
  const express = require('express');
  const supertest = require('supertest');

  return withTempEnv(
    {
      AURORA_PROFILE_V2_ENABLED: 'true',
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_SAFETY_ENGINE_V1_ENABLED: 'true',
      AURORA_TRAVEL_WEATHER_LIVE_ENABLED: 'true',
      AURORA_LOOP_BREAKER_V2_ENABLED: 'true',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'true',
      AURORA_ROLLOUT_ENABLED: 'false',
    },
    async () => {
      const routesPath = require.resolve('../src/auroraBff/routes');
      delete require.cache[routesPath];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const runId = nowStamp();
      const out = [];
      for (const caseDef of cases) {
        const mockFetch = buildMockFetch(caseDef);
        const originalFetch = global.fetch;
        global.fetch = mockFetch;

        try {
          const res = await supertest(app)
            .post('/v1/chat')
            .set(buildCaseHeaders(caseDef, runId))
            .send(runCommandRequestBody(caseDef));

          const body = res && res.body && typeof res.body === 'object' ? res.body : {};
          const headers = buildHeaderMap(res && res.headers ? res.headers : {});
          const meta = extractMeta(body);
          const evaluated = evaluateCase({
            caseDef,
            mode: 'local-mock',
            status: Number(res && res.status ? res.status : 0),
            body,
            headers,
            meta,
            strictMeta,
            fetchCalls: mockFetch.getCallCount(),
          });
          out.push(evaluated);
        } finally {
          global.fetch = originalFetch;
        }
      }

      delete require.cache[routesPath];
      return out;
    },
  );
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    let body = {};
    try {
      body = await res.json();
    } catch (_err) {
      body = {};
    }
    const headers = {};
    if (res && res.headers && typeof res.headers.forEach === 'function') {
      res.headers.forEach((v, k) => {
        headers[String(k).toLowerCase()] = String(v);
      });
    }
    return {
      status: Number(res.status || 0),
      body,
      headers,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runStagingLiveCases(cases, base, strictMeta) {
  const runId = nowStamp();
  const out = [];
  for (const caseDef of cases) {
    const res = await fetchJsonWithTimeout(
      `${String(base).replace(/\/+$/, '')}/v1/chat`,
      {
        method: 'POST',
        headers: buildCaseHeaders(caseDef, runId),
        body: JSON.stringify(runCommandRequestBody(caseDef)),
      },
      20000,
    );

    const body = res && res.body && typeof res.body === 'object' ? res.body : {};
    const headers = buildHeaderMap(res && res.headers ? res.headers : {});
    const meta = extractMeta(body);

    const evaluated = evaluateCase({
      caseDef,
      mode: 'staging-live',
      status: Number(res && res.status ? res.status : 0),
      body,
      headers,
      meta,
      strictMeta,
      fetchCalls: null,
    });
    out.push(evaluated);
  }
  return out;
}

function summarizeResults(results) {
  const total = results.length;
  const passed = results.filter((item) => item.passed).length;
  const failed = total - passed;
  const metaNull = results.reduce((sum, item) => sum + (Number(item.meta_missing) || 0), 0);
  const mismatch = results.reduce((sum, item) => sum + (Number(item.mismatch_count) || 0), 0);

  const byCategory = {};
  for (const item of results) {
    const key = String(item.category || 'unknown');
    if (!byCategory[key]) {
      byCategory[key] = { total: 0, passed: 0, failed: 0 };
    }
    byCategory[key].total += 1;
    if (item.passed) byCategory[key].passed += 1;
    else byCategory[key].failed += 1;
  }

  return {
    total,
    passed,
    failed,
    meta_null_count: metaNull,
    mismatch_count: mismatch,
    by_category: byCategory,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const mode = String(args.mode || 'local-mock').trim();
  const strictMeta = toBool(args['strict-meta'], mode === 'local-mock');
  const base = String(args.base || process.env.AURORA_EVAL_BASE_URL || 'https://pivota-agent-staging.up.railway.app').trim();
  const reportDir = String(args['report-dir'] || 'reports').trim();
  const casesPath = String(args.cases || path.join('tests', 'golden', 'aurora_travel_weather_20.jsonl')).trim();

  if (mode !== 'local-mock' && mode !== 'staging-live') {
    throw new Error(`Unsupported --mode: ${mode}`);
  }

  const cases = loadJsonlCases(casesPath);
  if (cases.length !== 20) {
    throw new Error(`Travel gate expects exactly 20 cases, got ${cases.length}`);
  }

  let results;
  if (mode === 'local-mock') {
    results = await runLocalMockCases(cases, strictMeta);
  } else {
    results = await runStagingLiveCases(cases, base, strictMeta);
  }

  const summary = summarizeResults(results);
  const stamp = nowStamp();
  fs.mkdirSync(reportDir, { recursive: true });
  const reportJsonPath = path.join(reportDir, `aurora_travel_gate_${mode.replace(/[^a-z0-9_-]/gi, '_')}_${stamp}.json`);
  const reportMdPath = path.join(reportDir, `aurora_travel_gate_${mode.replace(/[^a-z0-9_-]/gi, '_')}_${stamp}.md`);

  const payload = {
    schema_version: 'aurora.chat.travel_gate.v1',
    mode,
    base: mode === 'staging-live' ? base : null,
    strict_meta: strictMeta,
    generated_at: new Date().toISOString(),
    summary,
    results,
  };

  fs.writeFileSync(reportJsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(reportMdPath, buildMarkdownReport(payload), 'utf8');

  process.stdout.write(`${JSON.stringify({ report_json: reportJsonPath, report_md: reportMdPath, summary })}\n`);

  if (summary.failed > 0) {
    process.exit(2);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[aurora_travel_gate] fatal: ${String(err && err.stack ? err.stack : err)}\n`);
    process.exit(1);
  });
}

module.exports = {
  __internal: {
    parseArgs,
    toBool,
    loadJsonlCases,
    mergeExpected,
    buildMockFetch,
    extractMeta,
    extractTravelMissingFields,
    evaluateCase,
    summarizeResults,
    checkHeaderMetaMismatch,
  },
};
