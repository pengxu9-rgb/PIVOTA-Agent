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

function normalizeMode(value) {
  const raw = String(value || 'live').trim().toLowerCase();
  if (raw === 'live' || raw === 'production-live' || raw === 'staging-live') return 'live';
  if (raw === 'local' || raw === 'local-mock') return 'local';
  return raw;
}

function normalizeLlmBaseline(value) {
  const raw = String(value || 'auto').trim().toLowerCase();
  if (raw === 'force-on' || raw === 'force_on' || raw === 'on') return 'force-on';
  if (raw === 'force-off' || raw === 'force_off' || raw === 'off') return 'force-off';
  return 'auto';
}

function nowStamp() {
  return new Date().toISOString().replace(/[.:]/g, '-');
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function hasNonEmptyValue(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function lowerIncludes(haystack, needle) {
  return String(haystack || '').toLowerCase().includes(String(needle || '').toLowerCase());
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
  const base = isPlainObject(caseDef && caseDef.expected) ? caseDef.expected : {};
  const modePatch =
    mode === 'local'
      ? isPlainObject(caseDef && caseDef.expected_local)
        ? caseDef.expected_local
        : {}
      : isPlainObject(caseDef && caseDef.expected_live)
        ? caseDef.expected_live
        : {};
  return { ...base, ...modePatch };
}

function mergeTurnExpected(caseDef, turnDef, mode) {
  const caseExpected = mergeExpected(caseDef, mode);
  const turnBase = isPlainObject(turnDef && turnDef.expected_turn) ? turnDef.expected_turn : {};
  const turnModePatch =
    mode === 'local'
      ? isPlainObject(turnDef && turnDef.expected_local)
        ? turnDef.expected_local
        : {}
      : isPlainObject(turnDef && turnDef.expected_live)
        ? turnDef.expected_live
        : {};
  return { ...caseExpected, ...turnBase, ...turnModePatch };
}

function normalizeTurns(caseDef) {
  if (Array.isArray(caseDef && caseDef.turns) && caseDef.turns.length > 0) {
    return caseDef.turns.map((turn, idx) => {
      const fallbackAction = isPlainObject(turn && turn.action) ? turn.action : null;
      return {
        turn_id: String((turn && turn.turn_id) || `turn_${idx + 1}`),
        language: String((turn && turn.language) || (caseDef && caseDef.language) || 'EN').toUpperCase(),
        message: asString(turn && turn.message),
        action: fallbackAction,
        chat_overrides: isPlainObject(turn && turn.chat_overrides) ? turn.chat_overrides : null,
        wait_after_ms: Number.isFinite(Number(turn && turn.wait_after_ms)) ? Number(turn.wait_after_ms) : 0,
        expected_turn: isPlainObject(turn && turn.expected_turn) ? turn.expected_turn : undefined,
        expected_live: isPlainObject(turn && turn.expected_live) ? turn.expected_live : undefined,
        expected_local: isPlainObject(turn && turn.expected_local) ? turn.expected_local : undefined,
      };
    });
  }
  return [
    {
      turn_id: 'turn_1',
      language: String((caseDef && caseDef.language) || 'EN').toUpperCase(),
      message: asString(caseDef && caseDef.message),
      action: null,
      chat_overrides: null,
      wait_after_ms: 0,
      expected_turn: undefined,
      expected_live: undefined,
      expected_local: undefined,
    },
  ];
}

function setByPath(target, dotPath, value) {
  if (!isPlainObject(target) || !dotPath) return;
  const parts = String(dotPath)
    .split('.')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!parts.length) return;
  let cur = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!isPlainObject(cur[key])) cur[key] = {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

function getByPath(source, dotPath) {
  const parts = String(dotPath || '')
    .split('.')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!parts.length) return source;
  let cur = source;
  for (const part of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(part)) return undefined;
      cur = cur[Number(part)];
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function isDeepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeContextPath(pathLike) {
  const raw = String(pathLike || '').trim();
  if (!raw) return '';
  if (raw.startsWith('profile.')) return raw;
  if (raw.startsWith('context.')) return raw.slice('context.'.length);
  return `profile.${raw}`;
}

function getContextValue(context, rawPath) {
  const pathNorm = normalizeContextPath(rawPath);
  if (!pathNorm) return undefined;
  if (pathNorm.startsWith('profile.')) {
    return getByPath(isPlainObject(context) ? context.profile : null, pathNorm.slice('profile.'.length));
  }
  return getByPath(context, pathNorm);
}

function applyTemplateVars(input, vars) {
  if (typeof input === 'string') {
    return input.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
      const v = vars[String(key)];
      return v == null ? '' : String(v);
    });
  }
  if (Array.isArray(input)) return input.map((item) => applyTemplateVars(item, vars));
  if (isPlainObject(input)) {
    const out = {};
    for (const [k, v] of Object.entries(input)) out[k] = applyTemplateVars(v, vars);
    return out;
  }
  return input;
}

function mergeProfile(base, patch) {
  const src = isPlainObject(base) ? deepClone(base) : {};
  if (!isPlainObject(patch)) return src;
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(src[k])) src[k] = mergeProfile(src[k], v);
    else src[k] = deepClone(v);
  }
  return src;
}

function extractMeta(body) {
  if (isPlainObject(body && body.meta)) return body.meta;
  if (isPlainObject(body && body.session_patch && body.session_patch.meta)) return body.session_patch.meta;
  return null;
}

function extractAssistantText(body) {
  if (typeof body?.assistant_text === 'string' && body.assistant_text.trim()) return body.assistant_text;
  if (typeof body?.assistant_message?.content === 'string') return body.assistant_message.content;
  return '';
}

function extractEventRows(body) {
  const rows = asArray(body && body.events);
  return rows
    .map((evt) => ({
      raw: evt,
      event_name: String(evt?.event_name || evt?.name || '').trim(),
      data: isPlainObject(evt?.data) ? evt.data : {},
    }))
    .filter((evt) => evt.event_name);
}

function extractCardRows(body) {
  const cards = asArray(body && body.cards);
  return cards.map((card) => ({
    raw: card,
    type: String(card?.type || '').trim(),
    payload: isPlainObject(card?.payload) ? card.payload : {},
  }));
}

function extractLlmMeta(body) {
  const fromSession = isPlainObject(body?.session_patch?.llm) ? body.session_patch.llm : null;
  const events = extractEventRows(body);
  const llmEvt = events.find((evt) => evt.event_name === 'llm_route');
  const fromEvent = llmEvt && isPlainObject(llmEvt.data) ? llmEvt.data : null;
  const merged = {
    llm_provider_requested:
      (fromSession && fromSession.llm_provider_requested) || (fromEvent && fromEvent.llm_provider_requested) || null,
    llm_model_requested:
      (fromSession && fromSession.llm_model_requested) || (fromEvent && fromEvent.llm_model_requested) || null,
    llm_provider_effective:
      (fromSession && fromSession.llm_provider_effective) || (fromEvent && fromEvent.llm_provider_effective) || null,
    llm_model_effective: (fromSession && fromSession.llm_model_effective) || (fromEvent && fromEvent.llm_model_effective) || null,
  };
  const hasAny = Object.values(merged).some((v) => hasNonEmptyValue(v));
  return hasAny ? merged : null;
}

function extractProfilePatchFromResponse(body) {
  if (isPlainObject(body?.session_patch?.profile)) return body.session_patch.profile;
  const profileCard = extractCardRows(body).find((card) => card.type === 'profile');
  if (profileCard && isPlainObject(profileCard.payload?.profile)) return profileCard.payload.profile;
  return null;
}

function extractRecoCandidate(cardRows) {
  const recoCard = cardRows.find((card) => card.type === 'recommendations' || card.type === 'product_picks');
  if (!recoCard) return { anchor_product_id: null, candidate_product_id: null };
  const payload = recoCard.payload || {};
  const recs = asArray(payload.recommendations);
  const first = recs[0];
  const candidateProductId =
    String(
      first?.product_id || first?.sku_id || first?.product?.product_id || first?.sku?.product_id || first?.product?.sku_id || '',
    ).trim() || null;
  const anchor = String(payload.anchor_product_id || payload.anchorProductId || '').trim() || null;
  return {
    anchor_product_id: anchor,
    candidate_product_id: candidateProductId,
  };
}

function headerMapForCase({ caseDef, turnDef, runId }) {
  const lang = String(turnDef.language || caseDef.language || 'EN').toUpperCase();
  const caseId = String(caseDef.case_id || 'case').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  return {
    'X-Aurora-UID': `beauty_gate_uid_${runId}_${caseId}`.slice(0, 64),
    'X-Trace-ID': `beauty_gate_trace_${runId}_${caseId}`.slice(0, 64),
    'X-Brief-ID': `beauty_gate_brief_${runId}`.slice(0, 64),
    'X-Lang': lang,
    'Content-Type': 'application/json',
  };
}

function buildChatBody({ caseDef, turnDef, context, llmBaseline }) {
  const language = String(turnDef.language || caseDef.language || 'EN').toUpperCase();
  const base = {
    language,
    debug: true,
    session: {
      state: 'idle',
      profile: isPlainObject(context.profile) ? context.profile : {},
    },
  };
  if (turnDef.message) base.message = String(turnDef.message);
  const action = isPlainObject(turnDef.action) ? turnDef.action : null;
  if (action && action.type === 'chat_action') {
    base.action = isPlainObject(action.action) ? action.action : isPlainObject(action.payload) ? action.payload : {};
    if (!base.message && typeof base.action?.data?.reply_text === 'string') base.message = base.action.data.reply_text;
  }

  const overrides = isPlainObject(turnDef.chat_overrides) ? turnDef.chat_overrides : {};
  if (typeof overrides.llm_provider === 'string') base.llm_provider = overrides.llm_provider;
  if (typeof overrides.llm_model === 'string') base.llm_model = overrides.llm_model;

  if (!base.llm_provider && llmBaseline === 'force-off') base.llm_provider = 'openai';
  if (!base.llm_model && llmBaseline === 'force-off') base.llm_model = 'gpt-4o-mini';

  return base;
}

function buildTurnRequest({ caseDef, turnDef, context, llmBaseline, vars }) {
  const action = isPlainObject(turnDef.action) ? turnDef.action : null;
  if (!action) {
    return {
      method: 'POST',
      path: '/v1/chat',
      body: buildChatBody({ caseDef, turnDef, context, llmBaseline }),
      kind: 'chat_message',
    };
  }

  const type = String(action.type || 'chat_action').trim();
  const payloadRaw = isPlainObject(action.payload) ? action.payload : {};
  const payload = applyTemplateVars(payloadRaw, vars);

  if (type === 'chat_action') {
    return {
      method: 'POST',
      path: '/v1/chat',
      body: buildChatBody({ caseDef, turnDef, context, llmBaseline }),
      kind: 'chat_action',
    };
  }
  if (type === 'profile_update') {
    return { method: 'POST', path: '/v1/profile/update', body: payload, kind: 'profile_update' };
  }
  if (type === 'employee_feedback') {
    return { method: 'POST', path: '/v1/reco/employee-feedback', body: payload, kind: 'employee_feedback' };
  }
  if (type === 'interleave_click') {
    return { method: 'POST', path: '/v1/reco/interleave/click', body: payload, kind: 'interleave_click' };
  }
  if (type === 'tracker_log') {
    return { method: 'POST', path: '/v1/tracker/log', body: payload, kind: 'tracker_log' };
  }
  if (type === 'session_bootstrap') {
    return { method: 'GET', path: '/v1/session/bootstrap', query: payload, kind: 'session_bootstrap' };
  }
  if (type === 'http') {
    return {
      method: String(action.method || 'POST').toUpperCase(),
      path: String(action.path || '/v1/chat'),
      body: applyTemplateVars(action.body, vars),
      query: applyTemplateVars(action.query, vars),
      headers: applyTemplateVars(action.headers, vars),
      kind: 'http',
    };
  }

  return {
    method: 'POST',
    path: '/v1/chat',
    body: buildChatBody({ caseDef, turnDef, context, llmBaseline }),
    kind: `unknown_action_${type}`,
  };
}

function buildUrlWithQuery(baseUrl, requestSpec) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const pathName = String(requestSpec.path || '/').startsWith('/') ? String(requestSpec.path) : `/${String(requestSpec.path)}`;
  const url = new URL(`${base}${pathName}`);
  if (isPlainObject(requestSpec.query)) {
    for (const [k, v] of Object.entries(requestSpec.query)) {
      if (v == null) continue;
      url.searchParams.set(String(k), String(v));
    }
  }
  return url.toString();
}

function isInfraStatus(status) {
  const code = Number(status);
  if (!Number.isFinite(code)) return false;
  return code === 408 || code === 425 || code === 429 || code === 500 || code === 502 || code === 503 || code === 504 || code === 520 || code === 522 || code === 524;
}

function infraReasonFromError(err) {
  if (!err) return null;
  const name = String(err.name || '').toLowerCase();
  const code = String(err.code || '').toUpperCase();
  const msg = String(err.message || '').toLowerCase();
  if (name === 'aborterror' || msg.includes('timeout') || code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ECONNRESET' || msg.includes('econnreset')) return 'connection_reset';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (msg.includes('fetch failed') || msg.includes('network')) return 'network';
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs) || 20000));
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    const body = safeJson(text) || {};
    const headers = {};
    if (res?.headers && typeof res.headers.forEach === 'function') {
      res.headers.forEach((value, key) => {
        headers[String(key).toLowerCase()] = String(value);
      });
    }
    return {
      status: Number(res.status || 0),
      body,
      raw_text: text,
      headers,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callLiveWithRetry({ baseUrl, requestSpec, headers, timeoutMs, retryCount, retryBackoffMs }) {
  const retries = Math.max(0, Number.isFinite(Number(retryCount)) ? Number(retryCount) : 2);
  const backoff = Math.max(50, Number.isFinite(Number(retryBackoffMs)) ? Number(retryBackoffMs) : 300);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const url = buildUrlWithQuery(baseUrl, requestSpec);
      const method = String(requestSpec.method || 'POST').toUpperCase();
      const mergedHeaders = {
        ...headers,
        ...(isPlainObject(requestSpec.headers) ? requestSpec.headers : {}),
      };
      const hasBody = method !== 'GET' && requestSpec.body !== undefined;
      const out = await fetchJsonWithTimeout(
        url,
        {
          method,
          headers: mergedHeaders,
          ...(hasBody ? { body: JSON.stringify(requestSpec.body) } : {}),
        },
        timeoutMs,
      );
      if (isInfraStatus(out.status) && attempt < retries) {
        await sleep(backoff * (attempt + 1));
        continue;
      }
      return {
        ok: true,
        attempt: attempt + 1,
        response: out,
        infra_flake: isInfraStatus(out.status),
        infra_reason: isInfraStatus(out.status) ? `http_${out.status}` : null,
        error: null,
      };
    } catch (err) {
      const reason = infraReasonFromError(err);
      if (reason && attempt < retries) {
        await sleep(backoff * (attempt + 1));
        continue;
      }
      return {
        ok: false,
        attempt: attempt + 1,
        response: null,
        infra_flake: Boolean(reason),
        infra_reason: reason || 'unexpected_error',
        error: String(err && err.message ? err.message : err),
      };
    }
  }

  return {
    ok: false,
    attempt: retries + 1,
    response: null,
    infra_flake: true,
    infra_reason: 'exhausted',
    error: 'retry exhausted',
  };
}

async function withTempEnv(envPatch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(envPatch || {})) {
    prev[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = String(v);
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

function matchesExpectedValue(actual, expected) {
  if (Array.isArray(expected)) return expected.map((x) => String(x)).includes(String(actual));
  if (expected === null) return actual == null;
  if (typeof expected === 'boolean') return Boolean(actual) === expected;
  if (typeof expected === 'number') return Number(actual) === expected;
  return String(actual) === String(expected);
}

function assertMustHaveMap(ruleObj, actualObj, label, errors) {
  if (Array.isArray(ruleObj)) {
    for (const key of ruleObj) {
      const actual = getByPath(actualObj, key);
      if (!hasNonEmptyValue(actual)) errors.push(`${label}.${key} expected non-empty`);
    }
    return;
  }
  if (!isPlainObject(ruleObj)) return;
  for (const [key, expected] of Object.entries(ruleObj)) {
    const actual = getByPath(actualObj, key);
    if (!matchesExpectedValue(actual, expected)) {
      errors.push(`${label}.${key} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    }
  }
}

function assertNotContainsText(text, phrases, label, errors) {
  const source = String(text || '').toLowerCase();
  for (const phrase of asArray(phrases)) {
    if (source.includes(String(phrase || '').toLowerCase())) {
      errors.push(`${label} contains forbidden phrase: ${String(phrase)}`);
    }
  }
}

function assertAny(rows, expectedAny) {
  const expected = asArray(expectedAny).map((x) => String(x));
  if (!expected.length) return true;
  const actualSet = new Set(asArray(rows).map((x) => String(x)));
  return expected.some((x) => actualSet.has(x));
}

function assertAll(rows, expectedAll) {
  const expected = asArray(expectedAll).map((x) => String(x));
  if (!expected.length) return true;
  const actualSet = new Set(asArray(rows).map((x) => String(x)));
  return expected.every((x) => actualSet.has(x));
}

function evaluateTurn({ caseDef, turnDef, expected, requestSpec, response, beforeContext, afterContext, mode, llmBaseline }) {
  const errors = [];
  const warnings = [];

  const status = Number(response?.status || 0);
  const body = isPlainObject(response?.body) ? response.body : {};
  const assistantText = extractAssistantText(body);
  const meta = extractMeta(body);
  const llmMeta = extractLlmMeta(body);
  const eventRows = extractEventRows(body);
  const eventNames = eventRows.map((evt) => evt.event_name);
  const cards = extractCardRows(body);
  const cardTypes = cards.map((card) => card.type).filter(Boolean);

  if (status < 200 || status >= 300) {
    errors.push(`status expected 2xx, got ${status}`);
  }

  if (expected.must_have_non_empty === true) {
    const nonEmpty = Boolean(assistantText.trim()) || cardTypes.length > 0 || Object.keys(body).length > 0;
    if (!nonEmpty) errors.push('non_empty response assertion failed');
  }

  if (asArray(expected.must_have_card_types).length && !assertAll(cardTypes, expected.must_have_card_types)) {
    errors.push(`must_have_card_types failed: expected all ${JSON.stringify(expected.must_have_card_types)} actual=${JSON.stringify(cardTypes)}`);
  }
  if (asArray(expected.must_have_any_card_types).length && !assertAny(cardTypes, expected.must_have_any_card_types)) {
    errors.push(`must_have_any_card_types failed: expected any ${JSON.stringify(expected.must_have_any_card_types)} actual=${JSON.stringify(cardTypes)}`);
  }

  if (asArray(expected.must_have_events).length && !assertAll(eventNames, expected.must_have_events)) {
    errors.push(`must_have_events failed: expected all ${JSON.stringify(expected.must_have_events)} actual=${JSON.stringify(eventNames)}`);
  }
  if (asArray(expected.must_have_any_events).length && !assertAny(eventNames, expected.must_have_any_events)) {
    errors.push(`must_have_any_events failed: expected any ${JSON.stringify(expected.must_have_any_events)} actual=${JSON.stringify(eventNames)}`);
  }

  if (expected.must_have_meta != null) {
    if (!isPlainObject(meta)) errors.push('meta expected but missing');
    else assertMustHaveMap(expected.must_have_meta, meta, 'meta', errors);
  }

  if (expected.must_have_llm_meta != null) {
    if (!isPlainObject(llmMeta)) errors.push('llm_meta expected but missing');
    else assertMustHaveMap(expected.must_have_llm_meta, llmMeta, 'llm_meta', errors);
  }

  if (asArray(expected.must_have_response_paths).length) {
    for (const p of expected.must_have_response_paths) {
      const actual = getByPath(body, p);
      if (!hasNonEmptyValue(actual)) errors.push(`response path missing: ${String(p)}`);
    }
  }

  if (expected.action_should_succeed === true) {
    const okFlag = body && Object.prototype.hasOwnProperty.call(body, 'ok') ? Boolean(body.ok) : true;
    if (!(status >= 200 && status < 300 && okFlag)) {
      errors.push(`action_should_succeed failed: status=${status}, ok=${String(okFlag)}`);
    }
  }

  if (asArray(expected.must_update_profile_fields).length) {
    for (const rawPath of expected.must_update_profile_fields) {
      const beforeVal = getContextValue(beforeContext, rawPath);
      const afterVal = getContextValue(afterContext, rawPath);
      if (!hasNonEmptyValue(afterVal)) {
        errors.push(`must_update_profile_fields missing value at ${String(rawPath)}`);
        continue;
      }
      if (isDeepEqual(beforeVal, afterVal)) {
        errors.push(`must_update_profile_fields unchanged at ${String(rawPath)}`);
      }
    }
  }

  if (asArray(expected.must_preserve_context_keys).length) {
    for (const rawPath of expected.must_preserve_context_keys) {
      const beforeVal = getContextValue(beforeContext, rawPath);
      const afterVal = getContextValue(afterContext, rawPath);
      if (!hasNonEmptyValue(beforeVal)) {
        warnings.push(`must_preserve_context_keys skipped empty before value at ${String(rawPath)}`);
        continue;
      }
      if (!hasNonEmptyValue(afterVal)) {
        errors.push(`must_preserve_context_keys missing after value at ${String(rawPath)}`);
        continue;
      }
      if (!isDeepEqual(beforeVal, afterVal)) {
        errors.push(`must_preserve_context_keys changed at ${String(rawPath)} before=${JSON.stringify(beforeVal)} after=${JSON.stringify(afterVal)}`);
      }
    }
  }

  if (isPlainObject(expected.must_not_have)) {
    const rule = expected.must_not_have;
    if (asArray(rule.assistant_contains).length) {
      assertNotContainsText(assistantText, rule.assistant_contains, 'assistant_text', errors);
    }
    if (asArray(rule.card_types).length) {
      for (const t of rule.card_types) {
        if (cardTypes.includes(String(t))) errors.push(`must_not_have.card_types includes forbidden type ${String(t)}`);
      }
    }
    if (asArray(rule.events).length) {
      for (const e of rule.events) {
        if (eventNames.includes(String(e))) errors.push(`must_not_have.events includes forbidden event ${String(e)}`);
      }
    }
    if (asArray(rule.response_paths).length) {
      for (const p of rule.response_paths) {
        const v = getByPath(body, p);
        if (hasNonEmptyValue(v)) errors.push(`must_not_have.response_paths found forbidden path ${String(p)}`);
      }
    }
  } else if (Array.isArray(expected.must_not_have)) {
    const blob = JSON.stringify(body || {});
    for (const token of expected.must_not_have) {
      if (lowerIncludes(blob, token)) errors.push(`must_not_have token found: ${String(token)}`);
    }
  }

  const llmDeviation = (() => {
    if (!isPlainObject(llmMeta)) return false;
    if (llmBaseline !== 'force-off') return false;
    if (!llmMeta.llm_provider_requested || !llmMeta.llm_provider_effective) return false;
    return String(llmMeta.llm_provider_requested).toLowerCase() !== String(llmMeta.llm_provider_effective).toLowerCase();
  })();

  if (llmDeviation) warnings.push('llm baseline force-off deviated from requested provider');

  const attribution = (() => {
    if (status === 0 || isInfraStatus(status) || response?.infra_flake) return 'timeout_infra';
    if (errors.some((err) => err.startsWith('llm_meta.') || err.includes('llm_provider_effective')) || String(caseDef.category).startsWith('llm_route')) {
      return 'strategy_diff';
    }
    return 'functional_assertion';
  })();

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    attribution,
    status,
    assistant_text: assistantText,
    card_types: cardTypes,
    event_names: eventNames,
    meta,
    llm_meta: llmMeta,
    response_body: body,
    request: {
      method: requestSpec.method,
      path: requestSpec.path,
      body: requestSpec.body || null,
      query: requestSpec.query || null,
      kind: requestSpec.kind,
    },
    infra_flake: Boolean(response?.infra_flake),
    infra_reason: response?.infra_reason || null,
    attempts: Number(response?.attempt || 1),
    mode,
  };
}

async function runLocalCases({ cases, llmBaseline, timeoutMs }) {
  const express = require('express');
  const supertest = require('supertest');

  const envPatch = {
    AURORA_BFF_USE_MOCK: 'true',
    AURORA_CHAT_RESPONSE_META_ENABLED: 'true',
    AURORA_PROFILE_V2_ENABLED: 'true',
    AURORA_QA_PLANNER_V1_ENABLED: 'true',
    AURORA_SAFETY_ENGINE_V1_ENABLED: 'true',
    AURORA_BFF_RETENTION_DAYS: '0',
    AURORA_DIAG_FORCE_GEMINI: llmBaseline === 'force-off' ? 'false' : 'true',
  };

  return withTempEnv(envPatch, async () => {
    const routesPath = require.resolve('../src/auroraBff/routes');
    delete require.cache[routesPath];
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const request = supertest(app);
    const runId = nowStamp();
    const out = [];

    for (const caseDef of cases) {
      const turns = normalizeTurns(caseDef);
      const context = {
        profile: mergeProfile({}, isPlainObject(caseDef.seed_profile) ? caseDef.seed_profile : {}),
        recent_logs: [],
      };
      const vars = {
        case_id: caseDef.case_id,
      };
      const headersSeed = headerMapForCase({ caseDef, turnDef: turns[0], runId });
      vars.uid = headersSeed['X-Aurora-UID'];

      let seedStatus = null;
      if (isPlainObject(caseDef.seed_profile) && Object.keys(caseDef.seed_profile).length) {
        const seedResp = await request.post('/v1/profile/update').set(headersSeed).send(caseDef.seed_profile).timeout({ deadline: timeoutMs });
        seedStatus = seedResp.status;
        const patch = extractProfilePatchFromResponse(seedResp.body);
        if (isPlainObject(patch)) context.profile = mergeProfile(context.profile, patch);
      }

      const turnResults = [];
      for (let idx = 0; idx < turns.length; idx += 1) {
        const turn = turns[idx];
        const headers = headerMapForCase({ caseDef, turnDef: turn, runId });
        const expected = mergeTurnExpected(caseDef, turn, 'local');
        const beforeContext = deepClone(context);
        const requestSpec = buildTurnRequest({
          caseDef,
          turnDef: turn,
          context,
          llmBaseline,
          vars,
        });

        let res;
        if (String(requestSpec.method).toUpperCase() === 'GET') {
          let req = request.get(requestSpec.path).set(headers).timeout({ deadline: timeoutMs });
          if (isPlainObject(requestSpec.query)) req = req.query(requestSpec.query);
          res = await req;
        } else {
          let req = request
            .post(requestSpec.path)
            .set(headers)
            .send(requestSpec.body || {})
            .timeout({ deadline: timeoutMs });
          if (String(requestSpec.method).toUpperCase() !== 'POST') req = req;
          res = await req;
        }

        const responseWrap = {
          status: Number(res.status || 0),
          body: isPlainObject(res.body) ? res.body : {},
          headers: isPlainObject(res.headers) ? res.headers : {},
          infra_flake: false,
          infra_reason: null,
          attempt: 1,
        };

        const patch = extractProfilePatchFromResponse(responseWrap.body);
        if (isPlainObject(patch)) context.profile = mergeProfile(context.profile, patch);
        if (Array.isArray(responseWrap.body?.session_patch?.recent_logs)) {
          context.recent_logs = responseWrap.body.session_patch.recent_logs;
        }

        vars.last_request_id = asString(responseWrap.body?.request_id) || vars.last_request_id;
        vars.last_trace_id = asString(responseWrap.body?.trace_id) || vars.last_trace_id;
        const recoHint = extractRecoCandidate(extractCardRows(responseWrap.body));
        if (recoHint.anchor_product_id) vars.last_anchor_product_id = recoHint.anchor_product_id;
        if (recoHint.candidate_product_id) vars.last_candidate_product_id = recoHint.candidate_product_id;

        const evalOut = evaluateTurn({
          caseDef,
          turnDef: turn,
          expected,
          requestSpec,
          response: responseWrap,
          beforeContext,
          afterContext: context,
          mode: 'local',
          llmBaseline,
        });

        turnResults.push({
          case_id: caseDef.case_id,
          turn_id: turn.turn_id,
          turn_index: idx + 1,
          category: caseDef.category,
          language: turn.language,
          ...evalOut,
        });

        if (Number(turn.wait_after_ms) > 0) await sleep(Number(turn.wait_after_ms));
      }

      const caseErrors = turnResults.flatMap((t) => t.errors || []);
      out.push({
        case_id: caseDef.case_id,
        category: caseDef.category,
        language: String(caseDef.language || 'EN').toUpperCase(),
        focus_points: asArray(caseDef.focus_points),
        seed_profile_status: seedStatus,
        passed: caseErrors.length === 0,
        turn_results: turnResults,
      });
    }

    delete require.cache[routesPath];
    return out;
  });
}

async function runLiveCases({ cases, base, llmBaseline, timeoutMs, retryCount, retryBackoffMs }) {
  const runId = nowStamp();
  const out = [];

  for (const caseDef of cases) {
    const turns = normalizeTurns(caseDef);
    const context = {
      profile: mergeProfile({}, isPlainObject(caseDef.seed_profile) ? caseDef.seed_profile : {}),
      recent_logs: [],
    };
    const vars = {
      case_id: caseDef.case_id,
    };

    const headersSeed = headerMapForCase({ caseDef, turnDef: turns[0], runId });
    vars.uid = headersSeed['X-Aurora-UID'];

    let seedStatus = null;
    if (isPlainObject(caseDef.seed_profile) && Object.keys(caseDef.seed_profile).length) {
      const seedReq = {
        method: 'POST',
        path: '/v1/profile/update',
        body: caseDef.seed_profile,
      };
      const seedResp = await callLiveWithRetry({
        baseUrl: base,
        requestSpec: seedReq,
        headers: headersSeed,
        timeoutMs,
        retryCount,
        retryBackoffMs,
      });
      seedStatus = seedResp?.response?.status || 0;
      const patch = extractProfilePatchFromResponse(seedResp?.response?.body || {});
      if (isPlainObject(patch)) context.profile = mergeProfile(context.profile, patch);
    }

    const turnResults = [];
    for (let idx = 0; idx < turns.length; idx += 1) {
      const turn = turns[idx];
      const headers = headerMapForCase({ caseDef, turnDef: turn, runId });
      const expected = mergeTurnExpected(caseDef, turn, 'live');
      const beforeContext = deepClone(context);
      const requestSpec = buildTurnRequest({
        caseDef,
        turnDef: turn,
        context,
        llmBaseline,
        vars,
      });

      const result = await callLiveWithRetry({
        baseUrl: base,
        requestSpec,
        headers,
        timeoutMs,
        retryCount,
        retryBackoffMs,
      });

      const body = isPlainObject(result?.response?.body) ? result.response.body : {};
      const patch = extractProfilePatchFromResponse(body);
      if (isPlainObject(patch)) context.profile = mergeProfile(context.profile, patch);
      if (Array.isArray(body?.session_patch?.recent_logs)) context.recent_logs = body.session_patch.recent_logs;

      vars.last_request_id = asString(body?.request_id) || vars.last_request_id;
      vars.last_trace_id = asString(body?.trace_id) || vars.last_trace_id;
      const recoHint = extractRecoCandidate(extractCardRows(body));
      if (recoHint.anchor_product_id) vars.last_anchor_product_id = recoHint.anchor_product_id;
      if (recoHint.candidate_product_id) vars.last_candidate_product_id = recoHint.candidate_product_id;

      const evalOut = evaluateTurn({
        caseDef,
        turnDef: turn,
        expected,
        requestSpec,
        response: {
          ...(result.response || { status: 0, body: {} }),
          infra_flake: Boolean(result.infra_flake),
          infra_reason: result.infra_reason,
          attempt: result.attempt,
        },
        beforeContext,
        afterContext: context,
        mode: 'live',
        llmBaseline,
      });

      turnResults.push({
        case_id: caseDef.case_id,
        turn_id: turn.turn_id,
        turn_index: idx + 1,
        category: caseDef.category,
        language: turn.language,
        ...evalOut,
      });

      if (Number(turn.wait_after_ms) > 0) await sleep(Number(turn.wait_after_ms));
    }

    const caseErrors = turnResults.flatMap((t) => t.errors || []);
    out.push({
      case_id: caseDef.case_id,
      category: caseDef.category,
      language: String(caseDef.language || 'EN').toUpperCase(),
      focus_points: asArray(caseDef.focus_points),
      seed_profile_status: seedStatus,
      passed: caseErrors.length === 0,
      turn_results: turnResults,
    });
  }

  return out;
}

function summarizeResults(results) {
  const cases = asArray(results);
  const turns = cases.flatMap((c) => asArray(c.turn_results));
  const totalCases = cases.length;
  const passedCases = cases.filter((c) => c.passed).length;
  const totalTurns = turns.length;
  const passedTurns = turns.filter((t) => t.passed).length;
  const timeoutFailures = turns.filter((t) => !t.passed && t.attribution === 'timeout_infra').length;
  const strategyDiffFailures = turns.filter((t) => !t.passed && t.attribution === 'strategy_diff').length;
  const functionalFailures = turns.filter((t) => !t.passed && t.attribution === 'functional_assertion').length;
  const llmAssertTurns = turns.filter((t) => isPlainObject(t.llm_meta) || String(t.category || '').startsWith('llm_route')).length;

  const byCategory = {};
  for (const row of cases) {
    const key = String(row.category || 'unknown');
    if (!byCategory[key]) byCategory[key] = { total: 0, passed: 0, failed: 0 };
    byCategory[key].total += 1;
    if (row.passed) byCategory[key].passed += 1;
    else byCategory[key].failed += 1;
  }

  const byFocusPoint = {};
  for (const row of cases) {
    for (const point of asArray(row.focus_points)) {
      const key = String(point || '').trim();
      if (!key) continue;
      if (!byFocusPoint[key]) byFocusPoint[key] = { total: 0, passed: 0, failed: 0 };
      byFocusPoint[key].total += 1;
      if (row.passed) byFocusPoint[key].passed += 1;
      else byFocusPoint[key].failed += 1;
    }
  }

  return {
    total_cases: totalCases,
    passed_cases: passedCases,
    failed_cases: totalCases - passedCases,
    case_pass_rate: totalCases > 0 ? Number((passedCases / totalCases).toFixed(4)) : 0,
    total_turns: totalTurns,
    passed_turns: passedTurns,
    failed_turns: totalTurns - passedTurns,
    turn_pass_rate: totalTurns > 0 ? Number((passedTurns / totalTurns).toFixed(4)) : 0,
    timeout_failures: timeoutFailures,
    timeout_rate: totalTurns > 0 ? Number((timeoutFailures / totalTurns).toFixed(4)) : 0,
    functional_assertion_failures: functionalFailures,
    functional_assertion_failure_rate: totalTurns > 0 ? Number((functionalFailures / totalTurns).toFixed(4)) : 0,
    strategy_diff_failures: strategyDiffFailures,
    llm_route_deviation_rate:
      llmAssertTurns > 0 ? Number((strategyDiffFailures / llmAssertTurns).toFixed(4)) : 0,
    by_category: byCategory,
    by_focus_point: byFocusPoint,
  };
}

function buildMarkdownReport(payload) {
  const lines = [];
  lines.push(`# Aurora Beauty Follow-up Gate`);
  lines.push('');
  lines.push(`- generated_at: ${payload.generated_at}`);
  lines.push(`- mode: ${payload.mode}`);
  lines.push(`- base: ${payload.base || 'local'}`);
  lines.push(`- llm_baseline: ${payload.llm_baseline}`);
  lines.push(`- cases_file: ${payload.cases_file}`);
  lines.push(`- total_cases: ${payload.summary.total_cases}`);
  lines.push(`- passed_cases: ${payload.summary.passed_cases}`);
  lines.push(`- failed_cases: ${payload.summary.failed_cases}`);
  lines.push(`- case_pass_rate: ${payload.summary.case_pass_rate}`);
  lines.push(`- total_turns: ${payload.summary.total_turns}`);
  lines.push(`- failed_turns: ${payload.summary.failed_turns}`);
  lines.push(`- timeout_rate: ${payload.summary.timeout_rate}`);
  lines.push(`- functional_assertion_failure_rate: ${payload.summary.functional_assertion_failure_rate}`);
  lines.push(`- llm_route_deviation_rate: ${payload.summary.llm_route_deviation_rate}`);
  lines.push('');

  const failedTurns = payload.cases
    .flatMap((c) => c.turn_results.map((t) => ({ case_id: c.case_id, turn: t })))
    .filter((row) => !row.turn.passed);

  if (!failedTurns.length) {
    lines.push('All turns passed.');
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  lines.push('## Failed Turns');
  lines.push('');
  for (const row of failedTurns) {
    lines.push(`### ${row.case_id} / ${row.turn.turn_id}`);
    lines.push(`- category: ${row.turn.category}`);
    lines.push(`- attribution: ${row.turn.attribution}`);
    lines.push(`- status: ${row.turn.status}`);
    if (row.turn.infra_flake) lines.push(`- infra_flake: true (${row.turn.infra_reason || 'unknown'})`);
    for (const err of asArray(row.turn.errors)) lines.push(`- error: ${err}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function loadPromptAuditIfAny(pathLike) {
  if (!pathLike) return null;
  try {
    const raw = fs.readFileSync(pathLike, 'utf8');
    return safeJson(raw);
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const mode = normalizeMode(args.mode || 'live');
  const llmBaseline = normalizeLlmBaseline(args['llm-baseline'] || 'auto');
  const base = String(args.base || process.env.AURORA_BASE_URL || 'https://pivota-agent-production.up.railway.app').trim();
  const casesPath = String(args.cases || path.join('tests', 'golden', 'aurora_beauty_followup_20.jsonl')).trim();
  const expectedCount = Number.parseInt(String(args['expected-count'] || '20'), 10);
  const reportDir = String(args['report-dir'] || 'reports').trim();
  const reportPrefix = String(args['report-prefix'] || 'aurora_beauty_followup_gate').trim();
  const timeoutMs = Number.parseInt(String(args['timeout-ms'] || '30000'), 10);
  const liveRetryCount = Number.parseInt(String(args['live-retry-count'] || '2'), 10);
  const liveRetryBackoffMs = Number.parseInt(String(args['live-retry-backoff-ms'] || '450'), 10);
  const promptAuditPath = args['prompt-audit'] ? String(args['prompt-audit']).trim() : '';

  if (mode !== 'live' && mode !== 'local') {
    throw new Error(`Unsupported --mode: ${mode}`);
  }

  const cases = loadJsonlCases(casesPath);
  if (!Number.isFinite(expectedCount) || expectedCount <= 0) {
    throw new Error(`Invalid --expected-count: ${String(args['expected-count'] || '')}`);
  }
  if (cases.length !== expectedCount) {
    throw new Error(`Casepack expects exactly ${expectedCount} cases, got ${cases.length}`);
  }

  let caseResults;
  if (mode === 'live') {
    caseResults = await runLiveCases({
      cases,
      base,
      llmBaseline,
      timeoutMs,
      retryCount: liveRetryCount,
      retryBackoffMs: liveRetryBackoffMs,
    });
  } else {
    caseResults = await runLocalCases({
      cases,
      llmBaseline,
      timeoutMs,
    });
  }

  const summary = summarizeResults(caseResults);
  const generatedAt = new Date().toISOString();
  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = nowStamp();
  const reportJsonPath = path.join(reportDir, `${reportPrefix}_${stamp}.json`);
  const reportMdPath = path.join(reportDir, `${reportPrefix}_${stamp}.md`);

  const payload = {
    schema_version: 'aurora.beauty.followup.gate.v1',
    generated_at: generatedAt,
    mode,
    base: mode === 'live' ? base : null,
    cases_file: casesPath,
    llm_baseline: llmBaseline,
    timeout_ms: timeoutMs,
    live_retry_count: liveRetryCount,
    live_retry_backoff_ms: liveRetryBackoffMs,
    summary,
    cases: caseResults,
    prompt_audit: loadPromptAuditIfAny(promptAuditPath),
  };

  fs.writeFileSync(reportJsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(reportMdPath, buildMarkdownReport(payload), 'utf8');

  process.stdout.write(
    `${JSON.stringify({ report_json: reportJsonPath, report_md: reportMdPath, summary, mode, llm_baseline: llmBaseline })}\n`,
  );

  if (Number(summary.failed_turns || 0) > 0) process.exit(2);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[aurora_beauty_followup_gate] fatal: ${String(err && err.stack ? err.stack : err)}\n`);
    process.exit(1);
  });
}

module.exports = {
  __internal: {
    parseArgs,
    toBool,
    normalizeMode,
    normalizeLlmBaseline,
    loadJsonlCases,
    mergeExpected,
    mergeTurnExpected,
    normalizeTurns,
    evaluateTurn,
    summarizeResults,
    extractMeta,
    extractLlmMeta,
    extractProfilePatchFromResponse,
  },
};
