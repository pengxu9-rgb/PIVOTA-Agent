#!/usr/bin/env node

/**
 * Aurora synthetic matrix production probe.
 *
 * Default matrix size: 120 cases.
 * Outputs:
 * - reports/synthetic_matrix_<timestamp>.json
 * - reports/synthetic_matrix_<timestamp>.md
 * - reports/synthetic_matrix_failures_<timestamp>.ndjson
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const DEFAULT_BASE = process.env.BASE || process.env.AURORA_BASE || 'https://pivota-agent-production.up.railway.app';
const DEFAULT_CASES = Number.parseInt(process.env.CASES || process.env.MATRIX_CASES || '120', 10);
const DEFAULT_CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '4', 10);
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.TIMEOUT_MS || '30000', 10);
const DEFAULT_SEED = Number.parseInt(process.env.SEED || '20260223', 10);

const AUTH_TOKEN = String(process.env.AUTH_TOKEN || process.env.AURORA_AUTH_TOKEN || '').trim();
const AGENT_API_KEY = String(process.env.AGENT_API_KEY || '').trim();

const NOW = new Date();
const ts = `${NOW.getUTCFullYear()}${String(NOW.getUTCMonth() + 1).padStart(2, '0')}${String(NOW.getUTCDate()).padStart(2, '0')}_${String(NOW.getUTCHours()).padStart(2, '0')}${String(NOW.getUTCMinutes()).padStart(2, '0')}${String(NOW.getUTCSeconds()).padStart(2, '0')}`;
const REPORT_DIR = path.resolve(process.cwd(), 'reports');

const dims = {
  language: ['EN', 'CN'],
  photo_mode: ['usable', 'forced_fail', 'no_photo'],
  profile_mode: ['complete', 'missing_core'],
  special_state: ['none', 'pregnancy', 'lactation', 'high_risk_medications'],
  scenario: ['normal', 'travel', 'weather_stress'],
  checkin_trend: ['improve', 'worse', 'volatile'],
};

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7W2f8AAAAASUVORK5CYII=',
  'base64',
);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token.startsWith('--')) continue;
    const key = token.replace(/^--/, '');
    const val = String(argv[i + 1] || '').trim();
    if (!val || val.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = val;
    i += 1;
  }
  return out;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(list, rng) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
  return list;
}

function clampInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function buildCaseGrid() {
  const out = [];
  for (const language of dims.language) {
    for (const photo_mode of dims.photo_mode) {
      for (const profile_mode of dims.profile_mode) {
        for (const special_state of dims.special_state) {
          for (const scenario of dims.scenario) {
            for (const checkin_trend of dims.checkin_trend) {
              out.push({
                language,
                photo_mode,
                profile_mode,
                special_state,
                scenario,
                checkin_trend,
              });
            }
          }
        }
      }
    }
  }
  return out;
}

function pickCases(totalCases, seed) {
  const all = buildCaseGrid();
  const rng = mulberry32(seed);
  shuffleInPlace(all, rng);
  return all.slice(0, Math.min(totalCases, all.length)).map((base, idx) => ({
    case_id: `mx_${String(idx + 1).padStart(3, '0')}`,
    ...base,
  }));
}

function cleanBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return value == null ? '' : String(value);
}

function hasCardType(env, type) {
  const wanted = String(type || '').trim().toLowerCase();
  return asArray(env?.cards).some((card) => String(card?.type || '').trim().toLowerCase() === wanted);
}

function getCardPayload(env, type) {
  const wanted = String(type || '').trim().toLowerCase();
  const card = asArray(env?.cards).find((row) => String(row?.type || '').trim().toLowerCase() === wanted);
  return asObject(card?.payload);
}

function hasRecoOutput(env) {
  return hasCardType(env, 'recommendations') || hasCardType(env, 'confidence_notice');
}

function buildCommonHeaders({ uid, traceId, briefId, language }) {
  const headers = {
    Accept: 'application/json',
    'X-Aurora-UID': uid,
    'X-Trace-ID': traceId,
    'X-Brief-ID': briefId,
    'X-Lang': language,
    'X-Aurora-Lang': language === 'CN' ? 'cn' : 'en',
  };
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  if (AGENT_API_KEY) headers['X-Agent-Api-Key'] = AGENT_API_KEY;
  return headers;
}

async function httpJson({ baseUrl, pathName, method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const url = `${cleanBaseUrl(baseUrl)}${pathName.startsWith('/') ? pathName : `/${pathName}`}`;
  try {
    const init = {
      method,
      headers: {
        ...headers,
      },
      signal: controller.signal,
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return {
      ok: res.ok,
      status: res.status,
      data,
      error: res.ok ? null : `http_${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: err && err.name === 'AbortError' ? 'timeout' : asString(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function uploadUsablePhoto({ baseUrl, headers, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const form = new FormData();
  form.set('slot_id', 'daylight');
  form.set('consent', 'true');
  form.set('photo', new Blob([TINY_PNG], { type: 'image/png' }), 'synthetic-face.png');
  const url = `${cleanBaseUrl(baseUrl)}/v1/photos/upload`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    const payload = getCardPayload(data, 'photo_confirm');
    const photoId = asString(payload?.photo_id).trim();
    const slotId = asString(payload?.slot_id || 'daylight').trim() || 'daylight';
    const qcStatus = asString(payload?.qc_status).trim() || 'unknown';
    return {
      ok: res.ok && Boolean(photoId),
      status: res.status,
      envelope: data,
      photo: photoId ? { slot_id: slotId, photo_id: photoId, qc_status: qcStatus } : null,
      error: res.ok ? (photoId ? null : 'photo_id_missing') : `http_${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      envelope: null,
      photo: null,
      error: err && err.name === 'AbortError' ? 'timeout' : asString(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function profilePatchForCase(testCase) {
  const isCN = testCase.language === 'CN';
  const patch = {};
  if (testCase.profile_mode === 'complete') {
    patch.skinType = 'combination';
    patch.sensitivity = 'medium';
    patch.barrierStatus = 'impaired';
    patch.goals = ['acne', 'dehydration'];
    patch.budgetTier = '$$';
  } else {
    patch.skinType = 'combination';
    patch.goals = ['acne'];
  }

  if (testCase.special_state === 'pregnancy') patch.pregnancy_status = 'pregnant';
  if (testCase.special_state === 'lactation') patch.lactation_status = 'lactating';
  if (testCase.special_state === 'high_risk_medications') patch.high_risk_medications = ['isotretinoin'];

  if (testCase.scenario === 'travel') {
    patch.itinerary = isCN
      ? '下周将去寒冷干燥地区出差，户外时间较长。'
      : 'Traveling next week to a cold and dry destination with long outdoor exposure.';
    patch.travel_plan = {
      destination: 'Denver',
      start_date: '2026-03-01',
      end_date: '2026-03-05',
      indoor_outdoor_ratio: 0.35,
    };
  }

  if (testCase.scenario === 'weather_stress') {
    patch.itinerary = isCN
      ? '最近环境偏干冷并伴有大风。'
      : 'Recent environment is dry/cold with high wind.';
  }

  return patch;
}

function analysisBodyForCase(testCase, uploadedPhoto) {
  const body = {
    use_photo: false,
    currentRoutine:
      testCase.profile_mode === 'complete'
        ? 'AM: cleanser + moisturizer + SPF; PM: cleanser + niacinamide + moisturizer'
        : 'AM: cleanser + moisturizer',
  };

  if (testCase.photo_mode === 'usable' && uploadedPhoto) {
    body.use_photo = true;
    body.photos = [uploadedPhoto];
    return body;
  }

  if (testCase.photo_mode === 'forced_fail') {
    body.use_photo = true;
    body.photos = [
      {
        slot_id: 'daylight',
        photo_id: `forced_fail_${randomUUID().slice(0, 8)}`,
        qc_status: 'passed',
      },
    ];
    return body;
  }

  body.use_photo = false;
  return body;
}

function checkinBodyForTrend(trend) {
  if (trend === 'improve') {
    return { redness: 1, acne: 1, hydration: 4, notes: 'improving trend' };
  }
  if (trend === 'worse') {
    return { redness: 4, acne: 4, hydration: 1, notes: 'worsening trend' };
  }
  return { redness: 3, acne: 2, hydration: 2, notes: 'volatile trend' };
}

function followupMessageForScenario(testCase) {
  const isCN = testCase.language === 'CN';
  if (testCase.scenario === 'travel') {
    return isCN
      ? '我下周要出差去寒冷干燥地区，请针对行程给我护肤建议。'
      : 'I am traveling next week to a cold and dry destination, please tailor my routine.';
  }
  if (testCase.scenario === 'weather_stress') {
    return isCN
      ? '最近天气干冷又有风，请给我针对性建议。'
      : 'It has been cold, dry, and windy lately; please tailor recommendations.';
  }
  return isCN
    ? '基于我最新打卡刷新推荐。'
    : 'Refresh recommendations based on my latest check-in.';
}

function summarizeCaseOutcome(result) {
  const failures = [];
  const firstRecoMeta = asObject(result.reco_first?.data?.recommendation_meta);
  const secondRecoMeta = asObject(result.reco_second?.data?.recommendation_meta);

  if (!result.bootstrap?.ok) failures.push('bootstrap_failed');
  if (!result.profile_update?.ok) failures.push('profile_update_failed');

  if (!hasCardType(result.analysis?.data, 'analysis_summary')) failures.push('analysis_summary_missing');
  if (!asObject(result.analysis?.data)?.analysis_meta) failures.push('analysis_meta_missing');

  if (!hasRecoOutput(result.reco_first?.data)) failures.push('reco_first_missing_output');
  if (!hasRecoOutput(result.reco_second?.data)) failures.push('reco_second_missing_output');

  if ((result.tracker_refresh_hint?.should_refresh ?? false) !== true) {
    failures.push('reco_refresh_hint_missing_or_false');
  }

  if (!secondRecoMeta || secondRecoMeta.used_recent_logs !== true) {
    failures.push('reco_second_missing_recent_logs_signal');
  }

  if (result.case.scenario === 'travel') {
    const hasEnvCard = hasCardType(result.reco_followup?.data, 'env_stress');
    const followupMeta = asObject(result.reco_followup?.data?.recommendation_meta);
    if (!hasEnvCard && !(followupMeta && followupMeta.used_itinerary === true)) {
      failures.push('travel_signal_not_reflected');
    }
  }

  if (result.case.special_state !== 'none') {
    const hasSafetyNotice =
      asArray(result.reco_first?.data?.cards).some((card) => {
        if (String(card?.type || '').trim().toLowerCase() !== 'confidence_notice') return false;
        const reason = asString(card?.payload?.reason).toLowerCase();
        return reason === 'safety_block' || reason === 'safety_boundary';
      }) ||
      asArray(result.reco_second?.data?.cards).some((card) => {
        if (String(card?.type || '').trim().toLowerCase() !== 'confidence_notice') return false;
        const reason = asString(card?.payload?.reason).toLowerCase();
        return reason === 'safety_block' || reason === 'safety_boundary';
      });
    const hasSafetyMeta =
      (firstRecoMeta && firstRecoMeta.used_safety_flags === true) ||
      (secondRecoMeta && secondRecoMeta.used_safety_flags === true);
    if (!hasSafetyNotice && !hasSafetyMeta) failures.push('safety_signal_not_reflected');
  }

  if (result.case.photo_mode === 'forced_fail') {
    const analysisMeta = asObject(result.analysis?.data?.analysis_meta);
    const degradeReason = asString(analysisMeta?.degrade_reason || '').toLowerCase();
    if (!degradeReason.includes('photo')) failures.push('forced_fail_not_degraded_by_photo');
  }

  return {
    failures,
    passed: failures.length === 0,
  };
}

async function runCase({ baseUrl, testCase, timeoutMs }) {
  const uid = `mx_uid_${testCase.case_id}_${Math.random().toString(16).slice(2, 8)}`;
  const traceId = `mx_trace_${randomUUID().slice(0, 12)}`;
  const briefId = `mx_brief_${randomUUID().slice(0, 12)}`;
  const headers = buildCommonHeaders({ uid, traceId, briefId, language: testCase.language });

  const result = {
    case: testCase,
    context: { uid, trace_id: traceId, brief_id: briefId },
    started_at: new Date().toISOString(),
    bootstrap: null,
    profile_update: null,
    photo_upload: null,
    analysis: null,
    reco_first: null,
    tracker_log: null,
    tracker_refresh_hint: null,
    reco_second: null,
    reco_followup: null,
    recommendation_meta: {
      first: null,
      second: null,
      followup: null,
    },
    finished_at: null,
    duration_ms: 0,
  };

  const t0 = Date.now();
  try {
    result.bootstrap = await httpJson({ baseUrl, pathName: '/v1/session/bootstrap', method: 'GET', headers, timeoutMs });

    const profilePatch = profilePatchForCase(testCase);
    result.profile_update = await httpJson({
      baseUrl,
      pathName: '/v1/profile/update',
      method: 'POST',
      headers,
      body: profilePatch,
      timeoutMs,
    });

    let uploadedPhoto = null;
    if (testCase.photo_mode === 'usable') {
      result.photo_upload = await uploadUsablePhoto({ baseUrl, headers, timeoutMs });
      uploadedPhoto = result.photo_upload.photo;
    }

    const analysisBody = analysisBodyForCase(testCase, uploadedPhoto);
    result.analysis = await httpJson({
      baseUrl,
      pathName: '/v1/analysis/skin',
      method: 'POST',
      headers,
      body: analysisBody,
      timeoutMs,
    });

    const recoAction = {
      action: {
        action_id: 'chip.start.reco_products',
        kind: 'chip',
        data: {
          reply_text:
            testCase.language === 'CN'
              ? '请给我个性化护肤推荐。'
              : 'Please provide personalized skincare recommendations.',
          include_alternatives: true,
        },
      },
      session: { state: 'S7_PRODUCT_RECO' },
    };

    result.reco_first = await httpJson({
      baseUrl,
      pathName: '/v1/chat',
      method: 'POST',
      headers,
      body: recoAction,
      timeoutMs,
    });
    result.recommendation_meta.first = asObject(result.reco_first.data?.recommendation_meta);

    const trendPayload = checkinBodyForTrend(testCase.checkin_trend);
    result.tracker_log = await httpJson({
      baseUrl,
      pathName: '/v1/tracker/log',
      method: 'POST',
      headers,
      body: trendPayload,
      timeoutMs,
    });
    result.tracker_refresh_hint = asObject(result.tracker_log.data?.reco_refresh_hint);

    result.reco_second = await httpJson({
      baseUrl,
      pathName: '/v1/chat',
      method: 'POST',
      headers,
      body: {
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text:
              testCase.language === 'CN'
                ? '根据我最新打卡刷新推荐。'
                : 'Refresh recommendations based on my latest check-in.',
            include_alternatives: true,
          },
        },
        session: { state: 'S7_PRODUCT_RECO' },
      },
      timeoutMs,
    });
    result.recommendation_meta.second = asObject(result.reco_second.data?.recommendation_meta);

    result.reco_followup = await httpJson({
      baseUrl,
      pathName: '/v1/chat',
      method: 'POST',
      headers,
      body: {
        message: followupMessageForScenario(testCase),
        session: { state: 'S7_PRODUCT_RECO' },
      },
      timeoutMs,
    });
    result.recommendation_meta.followup = asObject(result.reco_followup.data?.recommendation_meta);
  } finally {
    result.finished_at = new Date().toISOString();
    result.duration_ms = Math.max(0, Date.now() - t0);
  }

  const verdict = summarizeCaseOutcome(result);
  result.verdict = verdict;
  return result;
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runOne() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        results[idx] = {
          case: items[idx],
          verdict: { passed: false, failures: ['runner_exception'] },
          error: asString(err?.message || err),
        };
      }
    }
  }

  const slots = [];
  for (let i = 0; i < Math.max(1, concurrency); i += 1) {
    slots.push(runOne());
  }
  await Promise.all(slots);
  return results;
}

function summarizeResults(results) {
  const total = results.length;
  const passed = results.filter((r) => r?.verdict?.passed).length;
  const failed = total - passed;
  const failures = results.filter((r) => !(r?.verdict?.passed));

  const countBy = (field) => {
    const out = {};
    for (const row of results) {
      const key = asString(row?.case?.[field] ?? 'unknown') || 'unknown';
      out[key] = out[key] || { total: 0, passed: 0 };
      out[key].total += 1;
      if (row?.verdict?.passed) out[key].passed += 1;
    }
    return out;
  };

  const analysisMetaCoverage = results.filter((r) => asObject(r?.analysis?.data?.analysis_meta)).length;
  const recoMetaCoverageFirst = results.filter((r) => asObject(r?.reco_first?.data?.recommendation_meta)).length;
  const recoMetaCoverageSecond = results.filter((r) => asObject(r?.reco_second?.data?.recommendation_meta)).length;
  const refreshHintCoverage = results.filter((r) => asObject(r?.tracker_log?.data?.reco_refresh_hint)?.should_refresh === true).length;

  const travelCases = results.filter((r) => r?.case?.scenario === 'travel');
  const travelUsedItinerary = travelCases.filter((r) => {
    const meta = asObject(r?.reco_followup?.data?.recommendation_meta);
    const hasEnv = hasCardType(r?.reco_followup?.data, 'env_stress');
    return hasEnv || (meta && meta.used_itinerary === true);
  }).length;

  const specialCases = results.filter((r) => r?.case?.special_state && r.case.special_state !== 'none');
  const specialSafetySeen = specialCases.filter((r) => {
    const first = asObject(r?.reco_first?.data?.recommendation_meta);
    const second = asObject(r?.reco_second?.data?.recommendation_meta);
    const hasSafetyMeta = (first && first.used_safety_flags === true) || (second && second.used_safety_flags === true);
    const hasNotice = hasCardType(r?.reco_first?.data, 'confidence_notice') || hasCardType(r?.reco_second?.data, 'confidence_notice');
    return hasSafetyMeta || hasNotice;
  }).length;

  return {
    total,
    passed,
    failed,
    pass_rate: total > 0 ? Number((passed / total).toFixed(4)) : 0,
    meta_coverage: {
      analysis_meta_rate: total > 0 ? Number((analysisMetaCoverage / total).toFixed(4)) : 0,
      recommendation_meta_first_rate: total > 0 ? Number((recoMetaCoverageFirst / total).toFixed(4)) : 0,
      recommendation_meta_second_rate: total > 0 ? Number((recoMetaCoverageSecond / total).toFixed(4)) : 0,
      reco_refresh_hint_rate: total > 0 ? Number((refreshHintCoverage / total).toFixed(4)) : 0,
    },
    travel_itinerary_reflected_rate:
      travelCases.length > 0 ? Number((travelUsedItinerary / travelCases.length).toFixed(4)) : 0,
    special_state_safety_reflected_rate:
      specialCases.length > 0 ? Number((specialSafetySeen / specialCases.length).toFixed(4)) : 0,
    by_language: countBy('language'),
    by_photo_mode: countBy('photo_mode'),
    by_profile_mode: countBy('profile_mode'),
    by_special_state: countBy('special_state'),
    by_scenario: countBy('scenario'),
    by_checkin_trend: countBy('checkin_trend'),
    top_failure_reasons: (() => {
      const map = new Map();
      for (const row of failures) {
        for (const reason of asArray(row?.verdict?.failures)) {
          const key = asString(reason || '').trim() || 'unknown';
          map.set(key, (map.get(key) || 0) + 1);
        }
      }
      return Array.from(map.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([reason, count]) => ({ reason, count }));
    })(),
  };
}

function markdownReport({ config, summary, results }) {
  const lines = [];
  lines.push('# Aurora Synthetic Matrix Report');
  lines.push('');
  lines.push(`- Timestamp: ${new Date().toISOString()}`);
  lines.push(`- Base: ${config.base}`);
  lines.push(`- Cases: ${summary.total}`);
  lines.push(`- Passed: ${summary.passed}`);
  lines.push(`- Failed: ${summary.failed}`);
  lines.push(`- Pass rate: ${(summary.pass_rate * 100).toFixed(2)}%`);
  lines.push('');
  lines.push('## Meta Coverage');
  lines.push(`- analysis_meta: ${(summary.meta_coverage.analysis_meta_rate * 100).toFixed(2)}%`);
  lines.push(`- recommendation_meta (first reco): ${(summary.meta_coverage.recommendation_meta_first_rate * 100).toFixed(2)}%`);
  lines.push(`- recommendation_meta (second reco): ${(summary.meta_coverage.recommendation_meta_second_rate * 100).toFixed(2)}%`);
  lines.push(`- reco_refresh_hint: ${(summary.meta_coverage.reco_refresh_hint_rate * 100).toFixed(2)}%`);
  lines.push(`- travel itinerary reflected: ${(summary.travel_itinerary_reflected_rate * 100).toFixed(2)}%`);
  lines.push(`- special-state safety reflected: ${(summary.special_state_safety_reflected_rate * 100).toFixed(2)}%`);
  lines.push('');

  lines.push('## Top Failure Reasons');
  if (!summary.top_failure_reasons.length) {
    lines.push('- none');
  } else {
    for (const row of summary.top_failure_reasons) {
      lines.push(`- ${row.reason}: ${row.count}`);
    }
  }
  lines.push('');

  lines.push('## Failed Cases (first 30)');
  const failed = results.filter((row) => !(row?.verdict?.passed)).slice(0, 30);
  if (!failed.length) {
    lines.push('- none');
  } else {
    for (const row of failed) {
      const c = row.case || {};
      lines.push(
        `- ${c.case_id} | ${c.language} | ${c.photo_mode} | ${c.profile_mode} | ${c.special_state} | ${c.scenario} | ${c.checkin_trend} | ${asArray(row?.verdict?.failures).join(', ')}`,
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const base = cleanBaseUrl(args.base || DEFAULT_BASE);
  const cases = clampInt(args.cases, DEFAULT_CASES);
  const concurrency = clampInt(args.concurrency, DEFAULT_CONCURRENCY);
  const timeoutMs = clampInt(args.timeout_ms, DEFAULT_TIMEOUT_MS);
  const seed = clampInt(args.seed, DEFAULT_SEED);

  const matrix = pickCases(cases, seed);

  console.log(`[matrix] base=${base}`);
  console.log(`[matrix] cases=${matrix.length} seed=${seed} concurrency=${concurrency} timeout_ms=${timeoutMs}`);

  const startedAt = Date.now();
  const results = await runWithConcurrency(matrix, concurrency, async (testCase, idx) => {
    const result = await runCase({ baseUrl: base, testCase, timeoutMs });
    const label = result?.verdict?.passed ? 'PASS' : 'FAIL';
    console.log(`[${label}] ${String(idx + 1).padStart(3, '0')}/${matrix.length} ${testCase.case_id}`);
    return result;
  });

  const summary = summarizeResults(results);
  const payload = {
    status: summary.failed === 0 ? 'passed' : 'completed_with_failures',
    config: {
      base,
      cases: matrix.length,
      concurrency,
      timeout_ms: timeoutMs,
      seed,
      dims,
    },
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    duration_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
    summary,
    results,
  };

  const failedRows = results
    .filter((row) => !(row?.verdict?.passed))
    .map((row) => ({
      case: row.case,
      failures: asArray(row?.verdict?.failures),
      analysis_meta: asObject(row?.analysis?.data?.analysis_meta),
      recommendation_meta_first: asObject(row?.reco_first?.data?.recommendation_meta),
      recommendation_meta_second: asObject(row?.reco_second?.data?.recommendation_meta),
      recommendation_meta_followup: asObject(row?.reco_followup?.data?.recommendation_meta),
      refresh_hint: asObject(row?.tracker_log?.data?.reco_refresh_hint),
      status_codes: {
        bootstrap: row?.bootstrap?.status ?? null,
        profile_update: row?.profile_update?.status ?? null,
        photo_upload: row?.photo_upload?.status ?? null,
        analysis: row?.analysis?.status ?? null,
        reco_first: row?.reco_first?.status ?? null,
        tracker_log: row?.tracker_log?.status ?? null,
        reco_second: row?.reco_second?.status ?? null,
        reco_followup: row?.reco_followup?.status ?? null,
      },
    }));

  await mkdir(REPORT_DIR, { recursive: true });

  const jsonPath = path.join(REPORT_DIR, `synthetic_matrix_${ts}.json`);
  const mdPath = path.join(REPORT_DIR, `synthetic_matrix_${ts}.md`);
  const ndjsonPath = path.join(REPORT_DIR, `synthetic_matrix_failures_${ts}.ndjson`);

  await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, `${markdownReport({ config: payload.config, summary: payload.summary, results })}\n`, 'utf8');
  const ndjson = failedRows.map((row) => JSON.stringify(row)).join('\n');
  await writeFile(ndjsonPath, ndjson ? `${ndjson}\n` : '', 'utf8');

  console.log(`[done] ${jsonPath}`);
  console.log(`[done] ${mdPath}`);
  console.log(`[done] ${ndjsonPath}`);

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[fatal]', err && err.stack ? err.stack : err);
  process.exit(1);
});
