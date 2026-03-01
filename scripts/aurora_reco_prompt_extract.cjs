#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const BASE_URL = String(process.env.AURORA_BASE_URL || 'https://pivota-agent-production.up.railway.app').replace(/\/+$/, '');
const LANG = String(process.env.AURORA_LANG || 'EN').toUpperCase() === 'CN' ? 'CN' : 'EN';
const REPORT_DIR = String(process.env.AURORA_REPORT_DIR || path.join(process.cwd(), 'reports'));
const UID = String(process.env.AURORA_UID || `aurora_prompt_probe_${Date.now()}`).slice(0, 64);
const TRACE = String(process.env.AURORA_TRACE_ID || `trace_prompt_probe_${Date.now()}`).slice(0, 64);
const BRIEF = String(process.env.AURORA_BRIEF_ID || `brief_prompt_probe_${Date.now()}`).slice(0, 64);

function nowTag() {
  return new Date().toISOString().replace(/[:.]/g, '-');
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

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const headers = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'X-Aurora-Uid': UID,
  'X-Trace-ID': TRACE,
  'X-Brief-ID': BRIEF,
  'X-Lang': LANG,
  'X-Aurora-Lang': LANG === 'CN' ? 'cn' : 'en',
  'X-Debug': '1',
  'X-Aurora-Debug': '1',
};

async function postJson(routePath, body) {
  const startedAt = Date.now();
  const res = await fetch(`${BASE_URL}${routePath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    latencyMs: Date.now() - startedAt,
    xServiceCommit: res.headers.get('x-service-commit') || null,
    body: safeJson(text),
  };
}

function collectFromEnvelope(label, route, resp) {
  const root = asObject(resp && resp.body) || {};
  const cards = asArray(root.cards);
  const recoCard = cards.find((c) => asString(c && c.type).trim().toLowerCase() === 'recommendations');
  const debugCard = cards.find((c) => asString(c && c.type).trim().toLowerCase() === 'aurora_debug');
  const recoPayload = asObject(recoCard && recoCard.payload) || {};
  const recoMeta = asObject(recoPayload.recommendation_meta) || {};
  const debugPayload = asObject(debugCard && debugCard.payload) || {};
  const llmTrace = asObject(recoMeta.llm_trace) || asObject(debugPayload.llm_prompt_trace) || null;
  const promptRaw = asString(debugPayload.llm_prompt_query_raw) || null;
  return {
    label,
    route,
    status: resp.status,
    latency_ms: resp.latencyMs,
    x_service_commit: resp.xServiceCommit,
    request_id: asString(root.request_id) || null,
    trace_id: asString(root.trace_id) || null,
    source_mode: asString(recoMeta.source_mode) || null,
    trigger_source: asString(recoMeta.trigger_source) || null,
    prompt_hash: asString(llmTrace && llmTrace.prompt_hash) || null,
    template_id: asString(llmTrace && llmTrace.template_id) || null,
    prompt_chars: Number(llmTrace && llmTrace.prompt_chars) || 0,
    token_est: Number(llmTrace && llmTrace.token_est) || 0,
    cache_hit: Boolean(llmTrace && llmTrace.cache_hit),
    latency_ms_llm: llmTrace && llmTrace.latency_ms != null ? Number(llmTrace.latency_ms) : null,
    system_prompt_raw: null,
    prompt_raw: promptRaw,
    prompt_raw_chars: promptRaw ? promptRaw.length : 0,
    prompt_preview: asString(debugPayload.llm_prompt_query_preview || '').slice(0, 1200) || null,
  };
}

function collectFromAlternatives(label, resp) {
  const root = asObject(resp && resp.body) || {};
  const debugPayload = asObject(root.debug) || {};
  const attempts = asArray(debugPayload.attempts);
  const firstAttempt = asObject(attempts[0]) || {};
  const llmTrace = asObject(firstAttempt.llm_trace) || asObject(root.llm_trace) || null;
  const promptRaw = asString(firstAttempt.llm_prompt_query_raw) || null;
  return {
    label,
    route: '/v1/reco/alternatives',
    status: resp.status,
    latency_ms: resp.latencyMs,
    x_service_commit: resp.xServiceCommit,
    request_id: asString(root.request_id) || null,
    trace_id: asString(root.trace_id) || null,
    alternatives_count: asArray(root.alternatives).length,
    prompt_hash: asString(llmTrace && llmTrace.prompt_hash) || null,
    template_id: asString(llmTrace && llmTrace.template_id) || null,
    prompt_chars: Number(llmTrace && llmTrace.prompt_chars) || 0,
    token_est: Number(llmTrace && llmTrace.token_est) || 0,
    cache_hit: Boolean(llmTrace && llmTrace.cache_hit),
    latency_ms_llm: llmTrace && llmTrace.latency_ms != null ? Number(llmTrace.latency_ms) : null,
    system_prompt_raw: null,
    prompt_raw: promptRaw,
    prompt_raw_chars: promptRaw ? promptRaw.length : 0,
    prompt_preview: asString(firstAttempt.llm_prompt_query_preview || '').slice(0, 1200) || null,
  };
}

function uniqByPromptHash(items) {
  const map = new Map();
  for (const item of items) {
    const key = item.prompt_hash || `${item.template_id || 'unknown'}:${item.route}`;
    if (!map.has(key)) map.set(key, item);
  }
  return Array.from(map.values());
}

async function main() {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available. Please run with Node 20+.');
  }
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const chatReco = await postJson('/v1/chat', {
    action: {
      action_id: 'chip.start.reco_products',
      kind: 'chip',
      data: {
        trigger_source: 'chip',
        reply_text: 'Recommend acne-control products with low irritation and include alternatives.',
        include_alternatives: true,
      },
    },
    debug: true,
  });

  const chatIngredient = await postJson('/v1/chat', {
    message: 'Recommend products that focus on azelaic acid + niacinamide for acne marks.',
    debug: true,
  });

  const recoGenerate = await postJson('/v1/reco/generate', {
    focus: 'Acne control with low irritation.',
    include_alternatives: false,
  });

  const alternatives = await postJson('/v1/reco/alternatives', {
    product_input: 'La Roche-Posay Effaclar Duo',
    max_total: 6,
    include_debug: true,
  });

  const rows = [
    collectFromEnvelope('chat_reco', '/v1/chat', chatReco),
    collectFromEnvelope('chat_ingredient', '/v1/chat', chatIngredient),
    collectFromEnvelope('reco_generate', '/v1/reco/generate', recoGenerate),
    collectFromAlternatives('alternatives_lazy', alternatives),
  ];
  const deduped = uniqByPromptHash(rows.filter((row) => row.prompt_hash || row.template_id));

  for (const row of rows) {
    console.log(
      `[${row.label}] status=${row.status} prompt_hash=${row.prompt_hash || '-'} template=${row.template_id || '-'} token_est=${
        row.token_est || 0
      } llm_ms=${row.latency_ms_llm == null ? '-' : row.latency_ms_llm} raw_chars=${row.prompt_raw_chars || 0}`,
    );
  }

  const report = {
    started_at: new Date().toISOString(),
    base_url: BASE_URL,
    lang: LANG,
    ids: {
      aurora_uid: UID,
      trace_id: TRACE,
      brief_id: BRIEF,
    },
    prompts: rows,
    unique_prompts: deduped,
  };

  const outPath = path.join(REPORT_DIR, `aurora_reco_prompt_extract_${nowTag()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${outPath}`);
}

main().catch((err) => {
  console.error('aurora_reco_prompt_extract failed:', err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
