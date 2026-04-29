const axios = require('axios');
const { getAxiosKeepAliveConfig } = require('../http/axiosKeepAlive');

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/$/, '');
}

function isProductionLikeEnvironment() {
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
  const railwayEnv = String(process.env.RAILWAY_ENVIRONMENT || '').trim().toLowerCase();
  const vercelEnv = String(process.env.VERCEL_ENV || '').trim().toLowerCase();
  return nodeEnv === 'production' || railwayEnv === 'production' || vercelEnv === 'production';
}

function isTestRuntimeEnvironment() {
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
  const nodeTestContext = String(process.env.NODE_TEST_CONTEXT || '').trim();
  return nodeEnv === 'test' || Boolean(nodeTestContext);
}

const REQUESTED_AURORA_MOCK = String(process.env.AURORA_BFF_USE_MOCK || '').toLowerCase() === 'true';
const USE_AURORA_MOCK = REQUESTED_AURORA_MOCK && isTestRuntimeEnvironment() && !isProductionLikeEnvironment();
if (REQUESTED_AURORA_MOCK && isProductionLikeEnvironment()) {
  // Never allow mock upstreams to service production-like traffic.
  console.warn('[auroraDecisionClient] Ignoring AURORA_BFF_USE_MOCK in production-like environment');
} else if (REQUESTED_AURORA_MOCK && !isTestRuntimeEnvironment()) {
  console.warn('[auroraDecisionClient] Ignoring AURORA_BFF_USE_MOCK outside test runtime');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postWithRetry(url, body, { timeoutMs, retries, retryDelayMs, headers } = {}) {
  const maxRetries = Number.isFinite(retries) ? retries : 1;
  const delayMs = Number.isFinite(retryDelayMs) ? retryDelayMs : 200;

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const resp = await axios.post(url, body, {
        timeout: Number(timeoutMs) > 0 ? Number(timeoutMs) : 12000,
        validateStatus: () => true,
        ...(headers && typeof headers === 'object' ? { headers } : {}),
        ...getAxiosKeepAliveConfig(),
      });
      if (resp.status >= 200 && resp.status < 300) return resp;
      // Retry only on 5xx.
      if (resp.status >= 500 && attempt < maxRetries) {
        await sleep(delayMs * (attempt + 1));
        continue;
      }
      const err = new Error(`Upstream status ${resp.status}`);
      err.status = resp.status;
      err.responseBody = resp.data;
      throw err;
    } catch (err) {
      lastErr = err;
      const status = err && err.status;
      const shouldRetry = (status == null || status >= 500) && attempt < maxRetries;
      if (shouldRetry) {
        await sleep(delayMs * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('Upstream request failed');
}

function buildContextPrefix({ profile, recentLogs, ingredient_kb_context, skin_analysis_context, ...meta } = {}) {
  const lines = [];
  if (profile) lines.push(`profile=${JSON.stringify(profile)}`);
  if (Array.isArray(recentLogs) && recentLogs.length) lines.push(`recent_logs=${JSON.stringify(recentLogs)}`);
  if (ingredient_kb_context && typeof ingredient_kb_context === 'string' && ingredient_kb_context.trim()) {
    lines.push(ingredient_kb_context.trim());
  }
  if (skin_analysis_context && typeof skin_analysis_context === 'string' && skin_analysis_context.trim()) {
    lines.push(skin_analysis_context.trim());
  }
  const metaCompact = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (v == null) continue;
    const s = typeof v === 'string' ? v.trim() : v;
    if (typeof s === 'string' && !s) continue;
    metaCompact[k] = s;
  }
  if (Object.keys(metaCompact).length) lines.push(`meta=${JSON.stringify(metaCompact)}`);
  return lines.length ? `${lines.join('\n')}\n\n` : '';
}

function truncateText(value, maxChars) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function normalizeResumeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const item of history) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const qid = truncateText(item.question_id, 80);
    const option = truncateText(item.option, 60);
    if (!qid || !option) continue;
    out.push({ question_id: qid, option });
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeKnownProfileFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  const out = {};

  const skinType = truncateText(fields.skinType, 40);
  if (skinType) out.skinType = skinType;

  const sensitivity = truncateText(fields.sensitivity, 40);
  if (sensitivity) out.sensitivity = sensitivity;

  const barrierStatus = truncateText(fields.barrierStatus, 40);
  if (barrierStatus) out.barrierStatus = barrierStatus;

  const budgetTier = truncateText(fields.budgetTier, 40);
  if (budgetTier) out.budgetTier = budgetTier;

  if (Array.isArray(fields.goals)) {
    const goals = [];
    for (const rawGoal of fields.goals) {
      const goal = truncateText(rawGoal, 40);
      if (!goal) continue;
      goals.push(goal);
      if (goals.length >= 5) break;
    }
    if (goals.length) out.goals = goals;
  }

  return Object.keys(out).length ? out : null;
}

function buildResumeContextPrefix(resumeContext) {
  if (!resumeContext || typeof resumeContext !== 'object' || Array.isArray(resumeContext)) return '';
  if (resumeContext.enabled === false) return '';

  const resumeText = truncateText(resumeContext.resume_user_text, 300) || '(no message)';
  const flowId = truncateText(resumeContext.flow_id, 40);
  const includeHistory = resumeContext.include_history !== false;
  const history = includeHistory ? normalizeResumeHistory(resumeContext.clarification_history) : [];
  const knownProfileFields = normalizeKnownProfileFields(resumeContext.known_profile_fields);
  const templateVersion = String(resumeContext.template_version || 'v1').trim().toLowerCase();

  let lines = null;
  if (templateVersion === 'v2') {
    lines = ['[RESUME CONTEXT — AUTHORITATIVE]'];
    if (flowId) lines.push(`Flow: ${flowId}`);
    lines.push(`Original user request (answer this): "${resumeText}"`);
    lines.push('');
    if (includeHistory) {
      if (history.length) {
        lines.push('Answered clarifications (do NOT ask again):');
        for (const item of history) {
          lines.push(`- ${item.question_id} = "${item.option}"`);
        }
      } else {
        lines.push('Answered clarifications: none listed (but if already answered via UI, do NOT ask again).');
      }
    } else {
      lines.push('Clarifications were answered via UI; do NOT ask again.');
    }
    lines.push('');
    lines.push('Profile fields now known (authoritative; use directly):');
    if (knownProfileFields) {
      if (knownProfileFields.skinType) lines.push(`- skinType = "${knownProfileFields.skinType}"`);
      if (knownProfileFields.sensitivity) lines.push(`- sensitivity = "${knownProfileFields.sensitivity}"`);
      if (knownProfileFields.barrierStatus) lines.push(`- barrierStatus = "${knownProfileFields.barrierStatus}"`);
      if (Array.isArray(knownProfileFields.goals)) {
        for (const goal of knownProfileFields.goals) {
          lines.push(`- goals = "${goal}"`);
        }
      }
      if (knownProfileFields.budgetTier) lines.push(`- budgetTier = "${knownProfileFields.budgetTier}"`);
    }
    lines.push('(If a field is not listed here, treat it as unknown.)');
    lines.push('');
    lines.push('Instruction:');
    lines.push('1) Do NOT repeat any questions above.');
    lines.push('2) Do NOT restart intake or request a full profile.');
    lines.push('3) Proceed to answer the original request now.');
    lines.push('4) If truly necessary, ask at most ONE new question, and it must NOT be something already answered/known.');
  } else {
    lines = ['[RESUME CONTEXT]'];
    if (flowId) lines.push(`Flow: ${flowId}`);
    lines.push(`Original user request: "${resumeText}"`);
    if (history.length) {
      lines.push('Clarification answers (in order):');
      for (const item of history) {
        lines.push(`- ${item.question_id}: ${item.option}`);
      }
    } else {
      lines.push('Clarifications were answered via UI; proceed without asking again.');
    }
    lines.push(
      'Instruction: Do not ask for these clarifications again. Continue answering the original request using the provided answers and profile.',
    );
  }
  return `${lines.join('\n')}\n\n`;
}

function loadMockAuroraChatForTest() {
  if (!isTestRuntimeEnvironment() || isProductionLikeEnvironment()) {
    const err = new Error('AURORA_BFF_USE_MOCK is only available in test runtime');
    err.code = 'AURORA_MOCK_NOT_ALLOWED';
    throw err;
  }
  return require('./testAdapters/mockAuroraDecisionClient').mockAuroraChat;
}

async function auroraChat({
  baseUrl,
  query,
  timeoutMs,
  retries,
  llm_provider,
  llm_model,
  anchor_product_id,
  anchor_product_url,
  intent_hint,
  disallow_clarify,
  required_structured_keys,
  messages,
  debug,
  allow_recommendations,
  resume_context,
  trace_id,
  request_id,
  prompt_hash,
  prompt_template_id,
} = {}) {
  const queryText = String(query || '');
  const resumePrefix = buildResumeContextPrefix(resume_context);
  const finalQuery = resumePrefix ? `${resumePrefix}${queryText}` : queryText;
  if (USE_AURORA_MOCK) {
    return loadMockAuroraChatForTest()({ query: finalQuery, anchor_product_id, messages });
  }
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    const err = new Error('AURORA_DECISION_BASE_URL not configured');
    err.code = 'AURORA_NOT_CONFIGURED';
    throw err;
  }
  const url = `${base}/api/upstream/chat`;
  const payload = { query: finalQuery };
  if (llm_provider) payload.llm_provider = llm_provider;
  if (llm_model) payload.llm_model = llm_model;
  if (anchor_product_id) payload.anchor_product_id = anchor_product_id;
  if (anchor_product_url) payload.anchor_product_url = anchor_product_url;
  if (intent_hint) payload.intent_hint = intent_hint;
  if (typeof disallow_clarify === 'boolean') payload.disallow_clarify = disallow_clarify;
  if (Array.isArray(required_structured_keys) && required_structured_keys.length) {
    payload.required_structured_keys = required_structured_keys;
  }
  if (Array.isArray(messages) && messages.length) payload.messages = messages;
  if (typeof debug === 'boolean') payload.debug = debug;
  if (typeof allow_recommendations === 'boolean') payload.allow_recommendations = allow_recommendations;
  if (trace_id) payload.parent_trace_id = trace_id;
  if (request_id) payload.parent_request_id = request_id;
  if (prompt_hash) payload.prompt_hash = prompt_hash;
  if (prompt_template_id) payload.prompt_template_id = prompt_template_id;
  const upstreamHeaders = {
    ...(trace_id ? { 'X-Parent-Trace-Id': String(trace_id) } : {}),
    ...(request_id ? { 'X-Parent-Request-Id': String(request_id) } : {}),
    ...(prompt_hash ? { 'X-Prompt-Hash': String(prompt_hash) } : {}),
    ...(prompt_template_id ? { 'X-Prompt-Template': String(prompt_template_id) } : {}),
  };
  const normalizedRetries = Number.isFinite(Number(retries)) ? Math.max(0, Math.trunc(Number(retries))) : 1;
  const resp = await postWithRetry(url, payload, {
    timeoutMs,
    retries: normalizedRetries,
    retryDelayMs: 250,
    headers: Object.keys(upstreamHeaders).length ? upstreamHeaders : undefined,
  });
  const data = resp && resp.data;
  const normalized = data && typeof data === 'object' ? { ...data } : { raw: data };
  const headers = resp && resp.headers && typeof resp.headers === 'object' ? resp.headers : {};
  const headerProvider =
    String(
      headers['x-llm-provider']
      || headers['x-aurora-llm-provider']
      || headers['x-upstream-llm-provider']
      || '',
    ).trim();
  const headerModel =
    String(
      headers['x-llm-model']
      || headers['x-aurora-llm-model']
      || headers['x-upstream-llm-model']
      || '',
    ).trim();
  if (!normalized.llm_provider && headerProvider) normalized.llm_provider = headerProvider;
  if (!normalized.llm_model && headerModel) normalized.llm_model = headerModel;
  return normalized;
}

module.exports = {
  normalizeBaseUrl,
  buildContextPrefix,
  auroraChat,
};
