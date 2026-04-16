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

function compactRankedTarget(target) {
  const obj = asObject(target) || {};
  const candidates = asArray(obj.product_candidates);
  return {
    target_id: asString(obj.target_id) || null,
    target_role: asString(obj.target_role) || null,
    ingredient_query: asString(obj.ingredient_query || obj.product_query || obj.query) || null,
    resolved_target_step: asString(obj.resolved_target_step) || null,
    target_confidence: asString(obj.target_confidence) || null,
    source: asString(obj.source) || null,
    verified_product_count: Number.isFinite(Number(obj.verified_product_count))
      ? Number(obj.verified_product_count)
      : candidates.length,
    product_candidate_count: candidates.length,
  };
}

function summarizeLatestRecoContext(root) {
  const sessionPatch = asObject(root && root.session_patch) || {};
  const state = asObject(sessionPatch.state) || {};
  const ctx = asObject(state.latest_reco_context) || null;
  if (!ctx) {
    return {
      present: false,
      source_detail: null,
      trigger_source: null,
      context_origin: null,
      artifact_id: null,
      resolved_target_step: null,
      resolved_target_step_confidence: null,
      resolved_target_step_source: null,
      ranked_target_ids: [],
      ranked_targets: [],
      product_candidate_count: 0,
    };
  }
  const rankedTargets = asArray(ctx.ranked_targets).map(compactRankedTarget);
  const directCandidates = asArray(ctx.product_candidates);
  return {
    present: true,
    source_detail: asString(ctx.source_detail) || null,
    trigger_source: asString(ctx.trigger_source) || null,
    context_origin: asString(ctx.context_origin) || null,
    artifact_id: asString(ctx.artifact_id) || null,
    resolved_target_step: asString(ctx.resolved_target_step) || null,
    resolved_target_step_confidence: asString(ctx.resolved_target_step_confidence) || null,
    resolved_target_step_source: asString(ctx.resolved_target_step_source) || null,
    ranked_target_ids: rankedTargets.map((target) => target.target_id).filter(Boolean),
    ranked_targets: rankedTargets,
    product_candidate_count: rankedTargets.reduce((sum, target) => sum + Number(target.product_candidate_count || 0), directCandidates.length),
  };
}

function summarizeSearchStageLedger(ledgerInput) {
  const ledger = asObject(ledgerInput) || {};
  const primarySearch = asObject(ledger.primary_search) || {};
  const finalSelection = asObject(ledger.final_selection) || {};
  const attempts = asArray(primarySearch.query_pack_attempts).map((attempt) => {
    const obj = asObject(attempt) || {};
    return {
      query: asString(obj.query) || null,
      ladder_level: asString(obj.ladder_level) || null,
      role_id: asString(obj.role_id) || null,
      source_scope: asString(obj.source_scope) || null,
      result_count: Number.isFinite(Number(obj.result_count)) ? Number(obj.result_count) : null,
      reason: asString(obj.reason) || null,
      transport_owner: asString(obj.primary_transport_owner) || null,
    };
  });
  return {
    keys: Object.keys(ledger),
    final_selection: {
      selection_owner: asString(finalSelection.selection_owner) || null,
      mainline_status: asString(finalSelection.mainline_status) || null,
      selected_product_ids: asArray(finalSelection.selected_product_ids).filter(Boolean),
      selected_titles: asArray(finalSelection.selected_titles).filter(Boolean),
      source_tier_counts: asObject(finalSelection.source_tier_counts) || null,
    },
    primary_search: {
      routine_support_strategy: asString(primarySearch.routine_support_strategy) || null,
      planned_level_count: Number.isFinite(Number(primarySearch.planned_level_count)) ? Number(primarySearch.planned_level_count) : null,
      executed_level_count: Number.isFinite(Number(primarySearch.executed_level_count)) ? Number(primarySearch.executed_level_count) : null,
      executed_query_count: Number.isFinite(Number(primarySearch.executed_query_count)) ? Number(primarySearch.executed_query_count) : null,
      support_executed_query_count: Number.isFinite(Number(primarySearch.support_executed_query_count)) ? Number(primarySearch.support_executed_query_count) : null,
      executed_support_levels: asArray(primarySearch.executed_support_levels).filter(Boolean),
      query_attempts: attempts.slice(0, 18),
    },
    candidate_pool_summary: asObject(ledger.candidate_pool_summary) || null,
    candidate_drop_stage: asObject(ledger.candidate_drop_stage) || null,
  };
}

function summarizeAnalysisEnvelope(resp) {
  const root = asObject(resp) || {};
  const cards = asArray(root.cards);
  return {
    request_id: asString(root.request_id) || null,
    trace_id: asString(root.trace_id) || null,
    card_types: cards.map((c) => asString(c && c.type)).filter(Boolean),
    latest_reco_context: summarizeLatestRecoContext(root),
  };
}

function hasAnyOverlap(left = [], right = []) {
  const rightSet = new Set(asArray(right).map((value) => String(value || '').trim()).filter(Boolean));
  return asArray(left).some((value) => rightSet.has(String(value || '').trim()));
}

function buildContextBridgeSummary(spec, analysisSummary, chatSummary) {
  const profilePatch = asObject(spec && spec.profilePatch) || null;
  const chatProfile = asObject(spec && spec.chatBody && spec.chatBody.context && spec.chatBody.context.profile) || {};
  const analysisContext = asObject(analysisSummary && analysisSummary.latest_reco_context) || {};
  const chatContext = asObject(chatSummary && chatSummary.latest_reco_context) || {};
  const analysisTargetIds = asArray(analysisContext.ranked_target_ids);
  const chatTargetIds = asArray(chatSummary && chatSummary.selected_target_ids).length
    ? asArray(chatSummary && chatSummary.selected_target_ids)
    : asArray(chatContext.ranked_target_ids);
  const expectation = asObject(spec && spec.contextExpectations) || {};
  const expectedAny = asArray(expectation.expected_role_ids_any).filter(Boolean);
  const avoidAny = asArray(expectation.avoid_role_ids).filter(Boolean);
  const evidenceFlags = [];
  if (analysisContext.present) evidenceFlags.push('analysis_handoff_context_created');
  if (asString(chatSummary && chatSummary.recos_requested_source_detail) === 'analysis_handoff') {
    evidenceFlags.push('chat_triggered_from_analysis_handoff');
  }
  const analysisUsage = asObject(chatSummary && chatSummary.analysis_context_usage) || {};
  if (analysisUsage.analysis_context_available || asString(analysisUsage.context_source_mode) && asString(analysisUsage.context_source_mode) !== 'none') {
    evidenceFlags.push('recommendation_meta_analysis_context_usage');
  }
  if (analysisTargetIds.length && hasAnyOverlap(analysisTargetIds, chatTargetIds)) {
    evidenceFlags.push('analysis_target_overlap_selected_targets');
  }
  if (!Object.keys(chatProfile).length && profilePatch) {
    evidenceFlags.push('chat_body_profile_empty_after_profile_update');
  }
  if (spec && spec.carrySessionPatchToChat) {
    evidenceFlags.push('prior_session_patch_carried_to_chat');
  }
  return {
    profile_patch_keys: profilePatch ? Object.keys(profilePatch).sort() : [],
    chat_profile_keys: Object.keys(chatProfile).sort(),
    analysis_handoff_present: Boolean(analysisContext.present),
    analysis_handoff_source_detail: asString(analysisContext.source_detail) || null,
    analysis_handoff_target_ids: analysisTargetIds,
    chat_latest_context_source_detail: asString(chatContext.source_detail) || null,
    chat_latest_context_target_ids: asArray(chatContext.ranked_target_ids),
    chat_selected_target_ids: chatTargetIds,
    context_evidence_flags: evidenceFlags,
    expected_role_ids_any: expectedAny,
    expected_role_hit: expectedAny.length ? hasAnyOverlap(expectedAny, chatTargetIds) : null,
    avoid_role_ids: avoidAny,
    avoided_role_violation: avoidAny.length ? hasAnyOverlap(avoidAny, chatTargetIds) : null,
  };
}

function mergeSessionPatchIntoChatSession(baseSession, sessionPatch) {
  const patch = asObject(sessionPatch) || null;
  if (!patch) return asObject(baseSession) ? { ...baseSession } : {};
  const next = asObject(baseSession) ? { ...baseSession } : {};
  const patchState = asObject(patch.state) || {};
  const baseState = asObject(next.state) || {};
  const nextState = { ...baseState, ...patchState };
  if (Object.keys(nextState).length) {
    next.state = nextState;
  }
  if (asObject(patch.profile)) {
    next.profile = { ...(asObject(next.profile) || {}), ...patch.profile };
  }
  if (asObject(patch.meta)) {
    next.meta = { ...(asObject(next.meta) || {}), ...patch.meta };
  }
  if (Array.isArray(patch.recent_logs)) {
    next.recent_logs = patch.recent_logs;
  }
  if (typeof patch.next_state === 'string' && patch.next_state.trim()) {
    next.next_state = patch.next_state.trim();
  }
  return next;
}

function buildCarriedSessionFromStepResponses(baseSession, responses = []) {
  let session = asObject(baseSession) ? { ...baseSession } : {};
  const applied = [];
  for (const row of asArray(responses)) {
    const body = asObject(row && row.body) || {};
    const patch = asObject(body.session_patch) || null;
    if (!patch) continue;
    session = mergeSessionPatchIntoChatSession(session, patch);
    applied.push({
      card_types: asArray(body.cards).map((card) => asString(card && card.type)).filter(Boolean),
      patch_keys: Object.keys(patch).sort(),
      state_keys: Object.keys(asObject(patch.state) || {}).sort(),
      has_profile: Boolean(asObject(patch.profile)),
      has_meta: Boolean(asObject(patch.meta)),
    });
  }
  return { session, applied };
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
  const recoMetadata = asObject(recoPayload.metadata) || {};
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
  const latestRecoContext = summarizeLatestRecoContext(root);
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
    mainline_status: asString(recoMeta.mainline_status || root.mainline_status) || null,
    query_source: asString(recoMeta.query_source) || null,
    decision_owner: asString(recoMeta.decision_owner) || null,
    semantic_owner: asString(recoMeta.semantic_owner) || null,
    owner_source: asString(recoMeta.owner_source) || null,
    selector_winner_source: asString(recoMeta.selector_winner_source) || null,
    primary_target_id: asString(recoMeta.primary_target_id) || null,
    displayed_target_ids: asArray(recoMeta.displayed_target_ids).filter(Boolean),
    selected_target_ids: asArray(recoMeta.selected_target_ids).filter(Boolean),
    source_tier_counts: asObject(recoMeta.source_tier_counts) || null,
    analysis_context_usage: asObject(recoMeta.analysis_context_usage) || null,
    latest_reco_context: latestRecoContext,
    search_stage_ledger_summary: summarizeSearchStageLedger(recoMetadata.search_stage_ledger),
    confidence_notice_reason: asString(confidencePayload.reason) || null,
    recos_requested_source: asString(recoRequestedData.source) || null,
    recos_requested_source_detail: asString(recoRequestedData.source_detail) || null,
    event_names: mergedEventNames,
    llm_trace: asObject(recoMeta.llm_trace) || null,
    debug_prompt_trace: asObject(debugPayload.llm_prompt_trace) || null,
    assistant_present: Boolean(assistantText),
    assistant_length: assistantText.length,
    assistant_preview: assistantText ? assistantText.slice(0, 360) : null,
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
  contextExpectations = null,
  carrySessionPatchToChat = false,
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
    contextExpectations: contextExpectations || null,
    carrySessionPatchToChat: Boolean(carrySessionPatchToChat),
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
    carried_chat_session: null,
    chat: null,
  };

  if (spec.profilePatch) {
    output.profile_update = await postJson('/v1/profile/update', spec.profilePatch, headers);
  }
  if (spec.analysisSkinBody) {
    output.analysis_skin = await postJson('/v1/analysis/skin', spec.analysisSkinBody, headers);
  }

  const chatBody = { ...(spec.chatBody || {}), ...(DEBUG ? { debug: true } : {}) };
  if (spec.carrySessionPatchToChat) {
    const carried = buildCarriedSessionFromStepResponses(chatBody.session, [
      output.profile_update,
      output.analysis_skin,
    ]);
    chatBody.session = carried.session;
    output.carried_chat_session = {
      applied: carried.applied,
      session_keys: Object.keys(asObject(carried.session) || {}).sort(),
      state_keys: Object.keys(asObject(carried.session && carried.session.state) || {}).sort(),
      meta_keys: Object.keys(asObject(carried.session && carried.session.meta) || {}).sort(),
      has_profile: Boolean(asObject(carried.session && carried.session.profile)),
    };
  }
  output.chat = await postJson('/v1/chat', chatBody, headers);

  const analysisSummary = output.analysis_skin ? summarizeAnalysisEnvelope(output.analysis_skin.body) : null;
  const chatSummary = summarizeEnvelope(output.chat.body);
  const contextBridge = buildContextBridgeSummary(spec, analysisSummary, chatSummary);
  return {
    ...output,
    summary: {
      status: output.chat.status,
      latency_ms: output.chat.latencyMs,
      x_service_commit: output.chat.headers.xServiceCommit,
      ...chatSummary,
      analysis_summary: analysisSummary,
      context_bridge: contextBridge,
      carried_chat_session: output.carried_chat_session,
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
  buildBeautyRecoCase({
    id: 'context_routine_makeup_pilling_daytime',
    title: 'Profile + analysis routine context -> daytime pilling buy',
    profilePatch: {
      skinType: 'combination',
      sensitivity: 'high',
      barrierStatus: 'impaired',
      goals: ['smooth layering', 'barrier support', 'daily sunscreen'],
      budgetTier: '$50',
      region: 'US',
      currentRoutine: {
        am: {
          cleanser: 'Gentle cleanser',
          moisturizer: 'rich barrier cream that pills under makeup',
        },
        pm: {
          cleanser: 'Gentle cleanser',
          treatment: 'retinoid serum three nights per week',
          moisturizer: 'barrier cream',
        },
      },
    },
    analysisSkinBody: {
      use_photo: false,
      currentRoutine: {
        am: {
          cleanser: 'Gentle cleanser',
          moisturizer: 'rich barrier cream that pills under makeup',
        },
        pm: {
          cleanser: 'Gentle cleanser',
          treatment: 'retinoid serum three nights per week',
          moisturizer: 'barrier cream',
        },
      },
      concerns: ['makeup pilling', 'tightness after retinoid', 'needs daytime SPF'],
    },
    carrySessionPatchToChat: true,
    profile: null,
    message: 'Based on my routine and the skin analysis, what should I buy for daytime so my makeup stops pilling?',
    contextExpectations: {
      expected_role_ids_any: [
        'daily_sunscreen_finish_fit',
        'daily_sunscreen',
        'layering_compatible_moisturizer_or_spf',
        'lightweight_moisturizer',
      ],
      avoid_role_ids: ['acne_clogged_pore_treatment'],
    },
    axes: {
      skin_profile: 'combination_sensitive',
      primary_concern: 'layering_compatibility',
      user_intent: 'buy',
      scenario: 'profile_analysis_routine_context',
      constraint: 'daytime_makeup_layering',
    },
    tags: ['context', 'analysis_seeded', 'routine'],
  }),
  buildBeautyRecoCase({
    id: 'context_retinoid_barrier_next_buy',
    title: 'Profile + analysis routine context -> retinoid barrier next buy',
    profilePatch: {
      skinType: 'dry',
      sensitivity: 'high',
      barrierStatus: 'impaired',
      goals: ['barrier support', 'reduce flaking', 'keep routine gentle'],
      budgetTier: '$50',
      region: 'US',
      currentRoutine: {
        am: {
          cleanser: 'Gentle cleanser',
          sunscreen: 'SPF 50 sunscreen',
        },
        pm: {
          cleanser: 'Gentle cleanser',
          treatment: 'retinoid serum three nights per week',
        },
      },
    },
    analysisSkinBody: {
      use_photo: false,
      currentRoutine: {
        am: {
          cleanser: 'Gentle cleanser',
          sunscreen: 'SPF 50 sunscreen',
        },
        pm: {
          cleanser: 'Gentle cleanser',
          treatment: 'retinoid serum three nights per week',
        },
      },
      concerns: ['tight skin after retinoid', 'flaking around mouth', 'wants no extra active'],
    },
    carrySessionPatchToChat: true,
    profile: null,
    message: "Given the skin analysis and what I'm already using, what should I add next? I don't want another active.",
    contextExpectations: {
      expected_role_ids_any: [
        'hydrating_barrier_moisturizer',
        'barrier_moisturizer',
        'lightweight_moisturizer',
      ],
      avoid_role_ids: ['oil_control_treatment', 'acne_clogged_pore_treatment', 'tone_mark_treatment'],
    },
    axes: {
      skin_profile: 'dry_sensitive',
      primary_concern: 'barrier_support',
      user_intent: 'buy',
      scenario: 'profile_analysis_routine_context',
      constraint: 'no_extra_active',
    },
    tags: ['context', 'analysis_seeded', 'routine'],
  }),
  buildBeautyRecoCase({
    id: 'context_retinoid_barrier_product_buy',
    title: 'Profile + analysis routine context -> explicit retinoid barrier product buy',
    profilePatch: {
      skinType: 'dry',
      sensitivity: 'high',
      barrierStatus: 'impaired',
      goals: ['barrier support', 'reduce flaking', 'keep routine gentle'],
      budgetTier: '$50',
      region: 'US',
      currentRoutine: {
        am: {
          cleanser: 'Gentle cleanser',
          sunscreen: 'SPF 50 sunscreen',
        },
        pm: {
          cleanser: 'Gentle cleanser',
          treatment: 'retinoid serum three nights per week',
        },
      },
    },
    analysisSkinBody: {
      use_photo: false,
      currentRoutine: {
        am: {
          cleanser: 'Gentle cleanser',
          sunscreen: 'SPF 50 sunscreen',
        },
        pm: {
          cleanser: 'Gentle cleanser',
          treatment: 'retinoid serum three nights per week',
        },
      },
      concerns: ['tight skin after retinoid', 'flaking around mouth', 'wants no extra active'],
    },
    carrySessionPatchToChat: true,
    profile: null,
    message: "Given the skin analysis and what I'm already using, what moisturizer product should I buy next? I don't want another active.",
    contextExpectations: {
      expected_role_ids_any: [
        'hydrating_barrier_moisturizer',
        'barrier_moisturizer',
        'lightweight_moisturizer',
      ],
      avoid_role_ids: ['oil_control_treatment', 'acne_clogged_pore_treatment', 'tone_mark_treatment'],
    },
    axes: {
      skin_profile: 'dry_sensitive',
      primary_concern: 'barrier_support',
      user_intent: 'buy',
      scenario: 'profile_analysis_routine_context',
      constraint: 'explicit_moisturizer_product',
    },
    tags: ['context', 'analysis_seeded', 'routine'],
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
  buildCarriedSessionFromStepResponses,
  parseArgs,
  summarizeAnalysisEnvelope,
  summarizeCoverage,
  summarizeEnvelope,
  summarizeQuality,
  summarizeLatestRecoContext,
  summarizeSearchStageLedger,
  selectCases,
};
