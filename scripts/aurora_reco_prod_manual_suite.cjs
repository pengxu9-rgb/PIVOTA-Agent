#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_URL = String(process.env.AURORA_BASE_URL || 'https://pivota-agent-production.up.railway.app').replace(/\/+$/, '');
const LANG = String(process.env.AURORA_LANG || 'EN').toUpperCase() === 'CN' ? 'CN' : 'EN';
const DEBUG = !['0', 'false', 'off', 'no'].includes(String(process.env.AURORA_DEBUG || '1').trim().toLowerCase());
const REPORT_DIR = String(process.env.AURORA_REPORT_DIR || path.join(process.cwd(), 'reports'));
const UID_PREFIX = String(process.env.AURORA_UID_PREFIX || 'aurora_prod_reco_probe').trim();

function parseArgs(argv) {
  const tokens = Array.isArray(argv) ? argv : [];
  const startIndex = tokens[0] && String(tokens[0]).startsWith('--') ? 0 : 2;
  const out = {};
  for (let i = startIndex; i < tokens.length; i += 1) {
    const cur = String(tokens[i] || '');
    if (!cur.startsWith('--')) continue;
    const key = cur.slice(2);
    const next = String(tokens[i + 1] || '');
    if (!next || next.startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function nowTag() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function shortId(prefix) {
  const seed = `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return seed.slice(0, 63);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function asString(v) {
  return typeof v === 'string' ? v : '';
}

function pickCard(cards, type) {
  return asArray(cards).find((c) => asString(c && c.type).trim().toLowerCase() === String(type).trim().toLowerCase()) || null;
}

const QUALITY_COPY_PATTERNS = [
  { flag: 'templated_full_routine', re: /\bto build out a full routine\b/i },
  { flag: 'templated_different_steps', re: /\bthese different steps\b/i },
  { flag: 'secondary_sunscreen_step', re: /\bsecondary sunscreen step\b/i },
  { flag: 'secondary_supporting_step', re: /\bsecondary supporting moisturizer step\b/i },
  { flag: 'secondary_protection', re: /\bsecondary protection\b/i },
  { flag: 'retry_add_context', re: /\badd more context\b/i },
  { flag: 'borderline_matches', re: /\bborderline matches\b/i },
  { flag: 'framework_no_candidates', re: /\bcurrent care framework did not recall usable candidates\b/i },
];

function makeHeaders(ids) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Aurora-Uid': ids.auroraUid,
    'X-Trace-ID': ids.traceId,
    'X-Brief-ID': ids.briefId,
    'X-Lang': LANG,
    'X-Aurora-Lang': LANG === 'CN' ? 'cn' : 'en',
    ...(DEBUG ? { 'X-Debug': '1', 'X-Aurora-Debug': '1' } : {}),
  };
}

async function postJson(routePath, body, headers) {
  const startedAt = Date.now();
  const res = await fetch(`${BASE_URL}${routePath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    latencyMs: Date.now() - startedAt,
    headers: {
      xServiceCommit: res.headers.get('x-service-commit') || null,
      xRailwayEdge: res.headers.get('x-railway-edge') || null,
    },
    body: safeJson(text),
    rawText: text,
  };
}

function summarizeEnvelope(resp) {
  const root = asObject(resp) || {};
  const cards = asArray(root.cards);
  const cardTypes = cards.map((c) => asString(c && c.type)).filter(Boolean);
  const recoCard = pickCard(cards, 'recommendations');
  const confidenceCard = pickCard(cards, 'confidence_notice');
  const debugCard = pickCard(cards, 'aurora_debug');
  const recoPayload = asObject(recoCard && recoCard.payload) || {};
  const recoMeta = asObject(recoPayload.recommendation_meta) || {};
  const recos = asArray(recoPayload.recommendations);
  const assistantMessage = asObject(root.assistant_message) || null;
  const assistantText = asString(assistantMessage && assistantMessage.content);
  const externalRecoCount = recos.filter((row) => {
    const pdpOpen = asObject(row && row.pdp_open);
    const pathToken = asString(pdpOpen && pdpOpen.path).trim().toLowerCase();
    return pathToken === 'external';
  }).length;
  const matchedRoleIds = Array.from(
    new Set(
      recos
        .map((row) => asString(row && (row.matched_role_id || row.role_scope)).trim())
        .filter(Boolean),
    ),
  );
  const productsWithWhy = recos.filter((row) => Boolean(asString(row && row.why_this_one).trim())).length;
  const productsWithEvidence = recos.filter((row) => {
    const keyFeatures = asArray(row && row.key_features).filter(Boolean);
    return (
      Boolean(asString(row && row.why_this_one).trim()) ||
      Boolean(asString(row && row.best_for).trim()) ||
      keyFeatures.length > 0
    );
  }).length;
  const productsWithInsights = recos.filter((row) => {
    const hasCompareHighlights = asArray(row && row.compare_highlights).length > 0;
    return Boolean(row && (row.product_intel || row.pivota_insights || hasCompareHighlights));
  }).length;
  const assistantQualityFlags = QUALITY_COPY_PATTERNS
    .filter(({ re }) => re.test(assistantText))
    .map(({ flag }) => flag);
  if (!assistantText && recos.length > 0) assistantQualityFlags.push('assistant_missing');
  if (assistantText && recos.length === 0 && cardTypes.includes('confidence_notice')) assistantQualityFlags.push('confidence_notice_only');
  if (recos.length === 0) assistantQualityFlags.push('empty_recommendations');
  if (recos.length > 0 && recos.length < 3) assistantQualityFlags.push('underfilled_recommendations');
  if (productsWithInsights === 0 && recos.length > 0) assistantQualityFlags.push('no_reviewed_insights');
  if (productsWithEvidence < recos.length && recos.length > 0) assistantQualityFlags.push('partial_product_evidence');
  const rootEvents = asArray(root.events);
  const eventNameFrom = (eventObj) =>
    asString(
      eventObj && (
        eventObj.event_name ||
        eventObj.name ||
        eventObj.event_type
      ),
    );
  const eventDataFrom = (eventObj) =>
    asObject(
      eventObj && (
        eventObj.data ||
        eventObj.event_data
      ),
    ) || {};
  const eventNames = rootEvents
    .map((e) => eventNameFrom(e))
    .filter(Boolean);
  const experimentEvents = asArray(asObject(root.ops)?.experiment_events);
  const experimentEventNames = experimentEvents
    .map((e) => eventNameFrom(e))
    .filter(Boolean);
  const mergedEventNames = [...eventNames, ...experimentEventNames];
  const recoRequestedEvent = [...rootEvents, ...experimentEvents].find((e) => eventNameFrom(e) === 'recos_requested');
  const recoRequestedData = eventDataFrom(recoRequestedEvent);
  const confidencePayload = asObject(confidenceCard && confidenceCard.payload) || {};
  const debugPayload = asObject(debugCard && debugCard.payload) || {};
  return {
    request_id: asString(root.request_id) || null,
    trace_id: asString(root.trace_id) || null,
    card_types: cardTypes,
    recommendations_count: recos.length,
    external_recommendations_count: externalRecoCount,
    source_mode: asString(recoMeta.source_mode) || null,
    source: asString(recoPayload.source) || null,
    trigger_source: asString(recoMeta.trigger_source) || null,
    recompute_from_profile_update: Boolean(recoMeta.recompute_from_profile_update),
    confidence_notice_reason: asString(confidencePayload.reason) || null,
    recos_requested_source: asString(recoRequestedData.source) || null,
    recos_requested_source_detail: asString(recoRequestedData.source_detail) || null,
    event_names: mergedEventNames,
    llm_trace: asObject(recoMeta.llm_trace) || null,
    debug_prompt_trace: asObject(debugPayload.llm_prompt_trace) || null,
    assistant_present: Boolean(assistantText),
    assistant_length: assistantText.length,
    matched_role_ids: matchedRoleIds,
    matched_role_count: matchedRoleIds.length,
    products_with_why_this_one: productsWithWhy,
    products_with_evidence: productsWithEvidence,
    products_with_reviewed_insights: productsWithInsights,
    assistant_quality_flags: assistantQualityFlags,
  };
}

function buildIds(caseId) {
  const salt = crypto.createHash('sha1').update(`${caseId}_${Date.now()}_${Math.random()}`).digest('hex').slice(0, 12);
  return {
    auroraUid: `${UID_PREFIX}_${caseId}_${salt}`.slice(0, 64),
    traceId: shortId(`trace_${caseId}`),
    briefId: shortId(`brief_${caseId}`),
  };
}

function buildBeautyRecoChatBody(message, profile = null) {
  return {
    message,
    client_state: 'IDLE_CHAT',
    session: { state: 'idle' },
    context: {
      locale: 'en',
      profile: profile || {},
    },
    language: LANG,
  };
}

function buildBeautyRecoCase({
  id,
  title,
  message,
  profile = null,
  profilePatch = null,
  analysisSkinBody = null,
  axes = {},
  tags = [],
} = {}) {
  return {
    id,
    title,
    axes: {
      skin_profile: axes.skin_profile || 'unspecified',
      primary_concern: axes.primary_concern || 'unspecified',
      user_intent: axes.user_intent || 'generic',
      scenario: axes.scenario || 'baseline',
      constraint: axes.constraint || 'none',
    },
    tags: Array.isArray(tags) ? tags : [],
    profilePatch: profilePatch || null,
    analysisSkinBody: analysisSkinBody || null,
    chatBody: buildBeautyRecoChatBody(message, profile),
  };
}

function pushCoverageCount(map, key) {
  const normalized = String(key || 'unspecified').trim() || 'unspecified';
  map[normalized] = (map[normalized] || 0) + 1;
}

function summarizeCoverage(cases = []) {
  const out = {
    total_cases: Array.isArray(cases) ? cases.length : 0,
    by_skin_profile: {},
    by_primary_concern: {},
    by_user_intent: {},
    by_scenario: {},
    by_constraint: {},
  };
  for (const spec of Array.isArray(cases) ? cases : []) {
    const axes = isPlainObject(spec?.axes) ? spec.axes : {};
    pushCoverageCount(out.by_skin_profile, axes.skin_profile);
    pushCoverageCount(out.by_primary_concern, axes.primary_concern);
    pushCoverageCount(out.by_user_intent, axes.user_intent);
    pushCoverageCount(out.by_scenario, axes.scenario);
    pushCoverageCount(out.by_constraint, axes.constraint);
  }
  return out;
}

function summarizeQuality(cases = []) {
  const out = {
    total_cases: Array.isArray(cases) ? cases.length : 0,
    assistant_missing_cases: 0,
    empty_recommendation_cases: 0,
    underfilled_recommendation_cases: 0,
    confidence_notice_only_cases: 0,
    no_reviewed_insights_cases: 0,
    templated_copy_cases: 0,
    by_flag: {},
  };
  for (const spec of Array.isArray(cases) ? cases : []) {
    const summary = isPlainObject(spec?.summary) ? spec.summary : {};
    const flags = asArray(summary.assistant_quality_flags).filter(Boolean);
    const push = (key) => {
      out.by_flag[key] = (out.by_flag[key] || 0) + 1;
    };
    for (const flag of flags) push(flag);
    if (flags.includes('assistant_missing')) out.assistant_missing_cases += 1;
    if (flags.includes('empty_recommendations')) out.empty_recommendation_cases += 1;
    if (flags.includes('underfilled_recommendations')) out.underfilled_recommendation_cases += 1;
    if (flags.includes('confidence_notice_only')) out.confidence_notice_only_cases += 1;
    if (flags.includes('no_reviewed_insights')) out.no_reviewed_insights_cases += 1;
    if (
      flags.includes('templated_full_routine') ||
      flags.includes('templated_different_steps') ||
      flags.includes('secondary_sunscreen_step') ||
      flags.includes('secondary_supporting_step') ||
      flags.includes('secondary_protection')
    ) {
      out.templated_copy_cases += 1;
    }
  }
  return out;
}

function selectCases(allCases, args = {}) {
  const list = Array.isArray(allCases) ? allCases.slice() : [];
  const requestedIds = String(args.case || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const filtered = requestedIds.length
    ? list.filter((spec) => requestedIds.includes(String(spec?.id || '')))
    : list;
  const limit = Number(args.limit);
  if (Number.isFinite(limit) && limit > 0) {
    return filtered.slice(0, Math.trunc(limit));
  }
  return filtered;
}

async function runCase(spec) {
  const ids = buildIds(spec.id);
  const headers = makeHeaders(ids);
  const output = {
    case_id: spec.id,
    title: spec.title,
    headers: ids,
    profile_update: null,
    analysis_skin: null,
    chat: null,
  };

  if (spec.profilePatch) {
    output.profile_update = await postJson('/v1/profile/update', spec.profilePatch, headers);
  }
  if (spec.analysisSkinBody) {
    output.analysis_skin = await postJson('/v1/analysis/skin', spec.analysisSkinBody, headers);
  }

  const chatBody = { ...(spec.chatBody || {}), ...(DEBUG ? { debug: true } : {}) };
  output.chat = await postJson('/v1/chat', chatBody, headers);

  const chatSummary = summarizeEnvelope(output.chat.body);
  return {
    ...output,
    summary: {
      status: output.chat.status,
      latency_ms: output.chat.latencyMs,
      x_service_commit: output.chat.headers.xServiceCommit,
      ...chatSummary,
    },
  };
}

const CASES = [
  buildBeautyRecoCase({
    id: 'oily_buy_basic',
    title: 'Oily skin -> what product should I buy?',
    message: 'im oily skin. what product should i buy?',
    profile: {
      skinType: 'oily',
      sensitivity: 'low',
      barrierStatus: 'stable',
      goals: ['oil control'],
    },
    axes: {
      skin_profile: 'oily',
      primary_concern: 'oil_control',
      user_intent: 'buy',
      scenario: 'baseline',
      constraint: 'none',
    },
    tags: ['gold', 'mainline'],
  }),
  buildBeautyRecoCase({
    id: 'oily_use_first_noon_shine',
    title: 'Oily skin -> greasy by noon -> use first',
    message: 'My face gets greasy by noon. What skincare product should I use first?',
    profile: {
      skinType: 'oily',
      sensitivity: 'low',
      barrierStatus: 'stable',
      goals: ['oil control'],
    },
    axes: {
      skin_profile: 'oily',
      primary_concern: 'oil_control',
      user_intent: 'use_first',
      scenario: 'midday_shine',
      constraint: 'none',
    },
    tags: ['gold', 'mainline'],
  }),
  buildBeautyRecoCase({
    id: 'oily_sunscreen_under_makeup_buy',
    title: 'Oily skin -> sunscreen under makeup',
    message: 'I have oily skin and wear makeup every day. What sunscreen product should I buy?',
    profile: {
      skinType: 'oily',
      sensitivity: 'medium',
      barrierStatus: 'stable',
      goals: ['oil control', 'sun protection'],
    },
    axes: {
      skin_profile: 'oily',
      primary_concern: 'daily_sunscreen',
      user_intent: 'buy',
      scenario: 'under_makeup',
      constraint: 'finish',
    },
  }),
  buildBeautyRecoCase({
    id: 'combo_tzone_buy_routine',
    title: 'Combination skin -> T-zone oily cheeks normal',
    message: 'My T-zone gets shiny but my cheeks are normal. What skincare products should I buy?',
    profile: {
      skinType: 'combination',
      sensitivity: 'low',
      barrierStatus: 'stable',
      goals: ['oil control', 'balanced hydration'],
    },
    axes: {
      skin_profile: 'combination',
      primary_concern: 'balanced_routine',
      user_intent: 'buy',
      scenario: 'tzone_shine',
      constraint: 'routine',
    },
  }),
  buildBeautyRecoCase({
    id: 'dry_barrier_use_first',
    title: 'Dry tight skin -> first product',
    message: 'My skin feels dry and tight after washing. What product should I use first?',
    profile: {
      skinType: 'dry',
      sensitivity: 'medium',
      barrierStatus: 'impaired',
      goals: ['barrier support', 'hydration'],
    },
    axes: {
      skin_profile: 'dry',
      primary_concern: 'barrier_support',
      user_intent: 'use_first',
      scenario: 'post_cleanse_tightness',
      constraint: 'low_irritation',
    },
  }),
  buildBeautyRecoCase({
    id: 'dry_winter_buy',
    title: 'Dry winter skin -> buy',
    message: 'My skin gets flaky in winter. What skincare product should I buy?',
    profile: {
      skinType: 'dry',
      sensitivity: 'medium',
      barrierStatus: 'impaired',
      goals: ['hydration', 'barrier support'],
    },
    axes: {
      skin_profile: 'dry',
      primary_concern: 'dryness',
      user_intent: 'buy',
      scenario: 'winter_flaking',
      constraint: 'none',
    },
  }),
  buildBeautyRecoCase({
    id: 'sensitive_redness_buy',
    title: 'Sensitive redness -> low irritation buy',
    message: 'My skin gets red easily and stings with strong products. What should I buy first?',
    profile: {
      skinType: 'sensitive',
      sensitivity: 'high',
      barrierStatus: 'impaired',
      goals: ['redness support', 'barrier support'],
    },
    axes: {
      skin_profile: 'sensitive',
      primary_concern: 'redness',
      user_intent: 'buy',
      scenario: 'easy_stinging',
      constraint: 'low_irritation',
    },
  }),
  buildBeautyRecoCase({
    id: 'acne_clogged_pores_use_first',
    title: 'Acne-prone clogged pores -> use first',
    message: 'I get clogged pores and small breakouts around my forehead. What product should I use first?',
    profile: {
      skinType: 'oily',
      sensitivity: 'medium',
      barrierStatus: 'stable',
      goals: ['breakout control', 'oil control'],
    },
    axes: {
      skin_profile: 'acne_prone',
      primary_concern: 'clogged_pores',
      user_intent: 'use_first',
      scenario: 'forehead_breakouts',
      constraint: 'none',
    },
  }),
  buildBeautyRecoCase({
    id: 'post_breakout_marks_buy',
    title: 'Post-breakout marks -> buy',
    message: 'My acne is calmer now but I still have post-breakout marks. What product should I buy?',
    profile: {
      skinType: 'combination',
      sensitivity: 'medium',
      barrierStatus: 'stable',
      goals: ['dark spot support', 'even tone'],
    },
    axes: {
      skin_profile: 'combination',
      primary_concern: 'post_acne_marks',
      user_intent: 'buy',
      scenario: 'post_breakout',
      constraint: 'none',
    },
  }),
  buildBeautyRecoCase({
    id: 'budget_acne_buy',
    title: 'Budget-conscious acne control',
    message: 'I have acne-prone oily skin and want one product under $20 to buy first. What should I get?',
    profile: {
      skinType: 'oily',
      sensitivity: 'medium',
      barrierStatus: 'stable',
      goals: ['breakout control', 'oil control'],
      budgetTier: '$',
    },
    axes: {
      skin_profile: 'oily',
      primary_concern: 'acne_control',
      user_intent: 'buy',
      scenario: 'budget_first_buy',
      constraint: 'budget',
    },
  }),
  buildBeautyRecoCase({
    id: 'retinoid_support_moisturizer_use',
    title: 'Drying active support -> moisturizer guidance',
    message: 'I am using a strong nighttime treatment and my skin feels stripped. What moisturizer product should I use?',
    profile: {
      skinType: 'combination',
      sensitivity: 'high',
      barrierStatus: 'impaired',
      goals: ['barrier support', 'hydration'],
    },
    axes: {
      skin_profile: 'combination',
      primary_concern: 'support_moisturizer',
      user_intent: 'use',
      scenario: 'active_irritation_support',
      constraint: 'barrier_friendly',
    },
  }),
  buildBeautyRecoCase({
    id: 'hot_humid_commute_sunscreen_use',
    title: 'Hot humid commute -> daily sunscreen use',
    message: 'I commute in hot humid weather and hate heavy SPF. What sunscreen product should I use?',
    profile: {
      skinType: 'combination',
      sensitivity: 'low',
      barrierStatus: 'stable',
      goals: ['sun protection', 'lightweight finish'],
    },
    axes: {
      skin_profile: 'combination',
      primary_concern: 'daily_sunscreen',
      user_intent: 'use',
      scenario: 'hot_humid_weather',
      constraint: 'lightweight_finish',
    },
  }),
  buildBeautyRecoCase({
    id: 'makeup_pilling_use',
    title: 'Pilling under makeup -> product use',
    message: 'My daytime products pill under makeup. What skincare product should I use instead?',
    profile: {
      skinType: 'combination',
      sensitivity: 'medium',
      barrierStatus: 'stable',
      goals: ['smooth layering', 'lightweight hydration'],
    },
    axes: {
      skin_profile: 'combination',
      primary_concern: 'layering_compatibility',
      user_intent: 'use',
      scenario: 'makeup_pilling',
      constraint: 'layering',
    },
  }),
  buildBeautyRecoCase({
    id: 'dull_dehydrated_buy',
    title: 'Dull dehydrated skin -> buy',
    message: 'My skin looks dull and dehydrated lately. What skincare product should I buy first?',
    profile: {
      skinType: 'normal',
      sensitivity: 'low',
      barrierStatus: 'stable',
      goals: ['hydration', 'brightness'],
    },
    axes: {
      skin_profile: 'normal',
      primary_concern: 'dullness_dehydration',
      user_intent: 'buy',
      scenario: 'overall_dullness',
      constraint: 'none',
    },
  }),
  buildBeautyRecoCase({
    id: 'analysis_then_reco',
    title: 'Analysis then recommendation',
    analysisSkinBody: {
      use_photo: false,
      currentRoutine: 'cleanser + moisturizer + sunscreen',
    },
    profile: {
      skinType: 'combination',
      sensitivity: 'medium',
      barrierStatus: 'stable',
      goals: ['balanced routine'],
    },
    message: 'Based on my current situation, what skincare product should I buy first?',
    axes: {
      skin_profile: 'combination',
      primary_concern: 'situational_reco',
      user_intent: 'buy',
      scenario: 'analysis_seeded',
      constraint: 'none',
    },
  }),
];

async function main() {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available. Please run with Node 20+.');
  }
  const args = parseArgs(process.argv);
  if (String(args.list || '').trim().toLowerCase() === 'true') {
    for (const spec of CASES) {
      const axes = isPlainObject(spec?.axes) ? spec.axes : {};
      console.log(
        `${spec.id}\t${spec.title}\tintent=${axes.user_intent || '-'}\tskin=${axes.skin_profile || '-'}\tconcern=${axes.primary_concern || '-'}\tscenario=${axes.scenario || '-'}`,
      );
    }
    return;
  }
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const selectedCases = selectCases(CASES, args);
  if (!selectedCases.length) {
    throw new Error('No cases selected for aurora_reco_prod_manual_suite.');
  }
  const startedAt = new Date().toISOString();
  const runs = [];
  for (const spec of selectedCases) {
    // eslint-disable-next-line no-await-in-loop
    const run = await runCase(spec);
    runs.push(run);
    const s = run.summary;
    const statusToken = s.status >= 200 && s.status < 300 ? 'OK' : `HTTP_${s.status}`;
    console.log(
      `[${spec.id}] ${statusToken} ${s.latency_ms}ms reco=${s.recommendations_count} source_mode=${s.source_mode || '-'} reason=${
        s.confidence_notice_reason || '-'
      } commit=${s.x_service_commit || '-'}`,
    );
  }

  const report = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    base_url: BASE_URL,
    lang: LANG,
    debug: DEBUG,
    selected_case_ids: selectedCases.map((spec) => spec.id),
    coverage_summary: summarizeCoverage(selectedCases),
    cases: runs.map((r) => ({
      case_id: r.case_id,
      title: r.title,
      axes: selectedCases.find((spec) => spec.id === r.case_id)?.axes || null,
      ids: r.headers,
      summary: r.summary,
      profile_update_status: r.profile_update ? r.profile_update.status : null,
      analysis_skin_status: r.analysis_skin ? r.analysis_skin.status : null,
    })),
    raw: runs,
  };
  report.quality_summary = summarizeQuality(report.cases);

  const outPath = path.join(REPORT_DIR, `aurora_reco_prod_manual_suite_${nowTag()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('aurora_reco_prod_manual_suite failed:', err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  CASES,
  buildBeautyRecoCase,
  buildBeautyRecoChatBody,
  parseArgs,
  summarizeCoverage,
  summarizeQuality,
  selectCases,
};
