#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_URL = String(process.env.AURORA_BASE_URL || 'https://pivota-agent-production.up.railway.app').replace(/\/+$/, '');
const LANG = String(process.env.AURORA_LANG || 'EN').toUpperCase() === 'CN' ? 'CN' : 'EN';
const DEBUG = !['0', 'false', 'off', 'no'].includes(String(process.env.AURORA_DEBUG || '1').trim().toLowerCase());
const REPORT_DIR = String(process.env.AURORA_REPORT_DIR || path.join(process.cwd(), 'reports'));
const UID_PREFIX = String(process.env.AURORA_UID_PREFIX || 'aurora_prod_reco_probe').trim();

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

function asString(v) {
  return typeof v === 'string' ? v : '';
}

function pickCard(cards, type) {
  return asArray(cards).find((c) => asString(c && c.type).trim().toLowerCase() === String(type).trim().toLowerCase()) || null;
}

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
  const externalRecoCount = recos.filter((row) => {
    const pdpOpen = asObject(row && row.pdp_open);
    const pathToken = asString(pdpOpen && pdpOpen.path).trim().toLowerCase();
    return pathToken === 'external';
  }).length;
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
  {
    id: 'no_profile_goal_reco',
    title: 'No profile -> direct goal-driven recommendation',
    chatBody: {
      action: {
        action_id: 'chip.start.reco_products',
        kind: 'chip',
        data: {
          trigger_source: 'chip',
          reply_text: 'Recommend acne-control products with low irritation.',
          include_alternatives: true,
        },
      },
    },
  },
  {
    id: 'profile_goal_reco',
    title: 'Profile seeded -> recommendation',
    profilePatch: {
      skinType: 'oily',
      sensitivity: 'sensitive',
      barrierStatus: 'impaired',
      goals: ['acne', 'redness'],
      budgetTier: '$$',
    },
    chatBody: {
      action: {
        action_id: 'chip.start.reco_products',
        kind: 'chip',
        data: {
          trigger_source: 'chip',
          reply_text: 'Recommend products for acne and redness with a balanced budget.',
          include_alternatives: true,
        },
      },
    },
  },
  {
    id: 'ingredient_driven_reco',
    title: 'Ingredient-driven recommendation',
    chatBody: {
      message: 'I want azelaic acid and niacinamide products for acne marks. Please recommend products directly.',
    },
  },
  {
    id: 'analysis_then_reco',
    title: 'Analysis then recommendation',
    analysisSkinBody: {
      use_photo: false,
      currentRoutine: 'cleanser + moisturizer + sunscreen',
    },
    chatBody: {
      action: {
        action_id: 'chip.start.reco_products',
        kind: 'chip',
        data: {
          trigger_source: 'chip',
          reply_text: 'Based on my current situation, recommend products now.',
          include_alternatives: true,
        },
      },
    },
  },
];

async function main() {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available. Please run with Node 20+.');
  }
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  const runs = [];
  for (const spec of CASES) {
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
    cases: runs.map((r) => ({
      case_id: r.case_id,
      title: r.title,
      ids: r.headers,
      summary: r.summary,
      profile_update_status: r.profile_update ? r.profile_update.status : null,
      analysis_skin_status: r.analysis_skin ? r.analysis_skin.status : null,
    })),
    raw: runs,
  };

  const outPath = path.join(REPORT_DIR, `aurora_reco_prod_manual_suite_${nowTag()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${outPath}`);
}

main().catch((err) => {
  console.error('aurora_reco_prod_manual_suite failed:', err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
