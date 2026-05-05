/**
 * Internal LLM probe endpoint for the pivota-backend Agent Center.
 *
 * pivota-backend's Agent Center calls this endpoint to run LLM-driven probes
 * on merchant products / Pivota PDPs. We expose two providers:
 *
 *   - `mock`: deterministic stub responses keyed by scan_mode. Used by
 *     default and in CI; lets the whole agent-center pipeline be tested
 *     end-to-end without burning tokens.
 *   - `gemini`: real Gemini calls via @google/genai. Requires
 *     GEMINI_API_KEY in env. Routes through the existing
 *     geminiGlobalGate semaphore + circuit breaker (no new rate-limit
 *     surface introduced).
 *
 * Auth: shared-secret header `X-Pivota-Internal-Key` matched against
 * `process.env.PIVOTA_INTERNAL_API_KEY`. Distinct from the human-ops
 * `X-ADMIN-KEY` so service-to-service auth and human-admin auth can
 * rotate independently.
 *
 * The response shape is the V1 contract for the Agent Center Demand Test
 * Agent. See `pivota-backend/docs/agent-center-v1.md` for the full
 * per-agent contract and how findings flow into `agent_center_issues`.
 */

'use strict';

const ALLOWED_SCAN_MODES = new Set([
  'open_product_visibility_test',
  'merchant_store_attribution_test',
  'pivota_pdp_attribution_test',
  'search_grounded_product_discovery_test',
]);

const ALLOWED_PROVIDERS = new Set(['mock', 'gemini']);

// Mapping from scan_mode → the dominant issue type the V1 spec assigns when a
// gap is detected. Mirrors `ISSUE_TYPE_BY_SCAN_MODE` in
// `pivota-backend/services/agent_center_demand_test_service.py`.
const PRIMARY_ISSUE_TYPE_BY_SCAN_MODE = {
  open_product_visibility_test: 'ai_visibility_loss',
  merchant_store_attribution_test: 'merchant_store_attribution_gap',
  pivota_pdp_attribution_test: 'pivota_pdp_attribution_gap',
  search_grounded_product_discovery_test: 'ai_visibility_loss',
};

const DEFAULT_MAX_RUNS = 3;
const HARD_MAX_RUNS = 8;

const DEFAULT_GEMINI_TIMEOUT_MS = 25_000;
const GEMINI_MODEL = process.env.PIVOTA_AGENT_CENTER_GEMINI_MODEL || 'gemini-2.5-flash';

let cachedGeminiClient = null;
let geminiInitFailed = false;

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function requireInternalKey(req, res, next) {
  const expected = String(process.env.PIVOTA_INTERNAL_API_KEY || '').trim();
  if (!expected) {
    // Refusing to serve the route at all is safer than letting it run
    // unauthenticated when ops forgot to configure the secret.
    return res.status(503).json({
      ok: false,
      error: 'pivota_internal_api_key_not_configured',
    });
  }
  const provided = String(
    req.header('X-Pivota-Internal-Key') || req.header('x-pivota-internal-key') || '',
  ).trim();
  if (!provided || provided !== expected) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return next();
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

function _isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function _isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate the request body. Returns { ok: true, normalized } on success or
 * { ok: false, error } with a 400-friendly message on failure.
 */
function validateRequest(body) {
  if (!_isPlainObject(body)) {
    return { ok: false, error: 'request body must be a JSON object' };
  }
  const { scan_mode, scan_target_id, merchant_id, store_id, context, options } = body;

  if (!_isNonEmptyString(scan_mode) || !ALLOWED_SCAN_MODES.has(scan_mode)) {
    return {
      ok: false,
      error: `unsupported scan_mode: ${scan_mode}. Allowed: ${[...ALLOWED_SCAN_MODES].join(', ')}`,
    };
  }
  if (!_isNonEmptyString(scan_target_id)) {
    return { ok: false, error: 'scan_target_id is required' };
  }
  if (!_isNonEmptyString(merchant_id) || !_isNonEmptyString(store_id)) {
    return { ok: false, error: 'merchant_id and store_id are required' };
  }
  if (!_isPlainObject(context)) {
    return { ok: false, error: 'context must be an object' };
  }

  let provider = 'mock';
  let maxRuns = DEFAULT_MAX_RUNS;
  if (_isPlainObject(options)) {
    if (options.provider !== undefined) {
      if (!ALLOWED_PROVIDERS.has(options.provider)) {
        return {
          ok: false,
          error: `unsupported provider: ${options.provider}. Allowed: ${[...ALLOWED_PROVIDERS].join(', ')}`,
        };
      }
      provider = options.provider;
    }
    if (options.max_runs !== undefined) {
      const n = Number(options.max_runs);
      if (!Number.isFinite(n) || n < 1) {
        return { ok: false, error: 'max_runs must be a positive integer' };
      }
      maxRuns = Math.min(HARD_MAX_RUNS, Math.trunc(n));
    }
  }

  // Per-mode required context bits. The mock provider tolerates anything; the
  // gemini provider needs the URL fields to actually run a probe.
  const queries = Array.isArray(context.queries) ? context.queries.filter(_isNonEmptyString) : [];
  const merchantPdpUrl = _isNonEmptyString(context.merchant_pdp_url) ? context.merchant_pdp_url : null;
  const pivotaPdpUrl = _isNonEmptyString(context.pivota_pdp_url) ? context.pivota_pdp_url : null;
  const productEntityId = _isNonEmptyString(context.product_entity_id) ? context.product_entity_id : null;

  return {
    ok: true,
    normalized: {
      scan_mode,
      scan_target_id,
      merchant_id,
      store_id,
      provider,
      max_runs: maxRuns,
      context: {
        queries,
        merchant_pdp_url: merchantPdpUrl,
        pivota_pdp_url: pivotaPdpUrl,
        product_entity_id: productEntityId,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Mock provider — deterministic stub findings per scan_mode
// ---------------------------------------------------------------------------

function buildMockProbe(input) {
  const { scan_mode, max_runs } = input;
  const runs = Math.max(1, Math.min(max_runs, HARD_MAX_RUNS));

  // Visibility scores chosen so that each scan_mode reliably produces at least
  // one finding; the backend stub-runner consumer asserts that issue creation
  // is triggered for known scan_modes.
  const scoresByMode = {
    open_product_visibility_test: { visibility_score: 33, attribution_echo_rate: 0 },
    merchant_store_attribution_test: { visibility_score: 66, attribution_echo_rate: 33 },
    pivota_pdp_attribution_test: { visibility_score: 66, attribution_echo_rate: 50 },
    search_grounded_product_discovery_test: { visibility_score: 33, attribution_echo_rate: 0 },
  };
  const scores = scoresByMode[scan_mode] || { visibility_score: 50, attribution_echo_rate: 0 };

  const issueType = PRIMARY_ISSUE_TYPE_BY_SCAN_MODE[scan_mode];
  const findings = issueType
    ? [
        {
          issue_type: issueType,
          severity: 'medium',
          evidence: {
            mock: true,
            note: `Mock probe synthesised this finding for scan_mode=${scan_mode}.`,
          },
        },
      ]
    : [];

  return {
    scan_mode,
    provider: 'mock',
    runs_count: runs,
    scores,
    findings,
    usage: { input_tokens: 0, output_tokens: 0 },
    raw_runs: [],
  };
}

// ---------------------------------------------------------------------------
// Gemini provider — real LLM calls via @google/genai + geminiGlobalGate
// ---------------------------------------------------------------------------

function getGeminiClient() {
  if (cachedGeminiClient) return cachedGeminiClient;
  if (geminiInitFailed) return null;
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;
  try {
    const { GoogleGenAI } = require('@google/genai');
    cachedGeminiClient = new GoogleGenAI({ apiKey });
    return cachedGeminiClient;
  } catch (_err) {
    geminiInitFailed = true;
    return null;
  }
}

function buildPromptForScanMode(input) {
  const { scan_mode, context } = input;
  const product = context.product_entity_id || '(product)';
  const queries = context.queries.length ? context.queries : [product];

  if (scan_mode === 'open_product_visibility_test') {
    return {
      system:
        'You are a shopping-research analyst. For each query a user might ask, decide whether the named product is one of the answers. Reply with strict JSON.',
      userPerQuery: (q) =>
        `Query: ${JSON.stringify(q)}\nProduct: ${JSON.stringify(product)}\n` +
        'Reply JSON: {"product_visible": true|false, "competitors_listed": [...], "evidence_excerpt": "..."}',
    };
  }
  if (scan_mode === 'merchant_store_attribution_test') {
    return {
      system:
        "You are a shopping-research analyst. Given a query, return whether the merchant's own store URL is mentioned as a buying path.",
      userPerQuery: (q) =>
        `Query: ${JSON.stringify(q)}\nMerchant store URL: ${JSON.stringify(context.merchant_pdp_url || '')}\n` +
        'Reply JSON: {"merchant_url_found": true|false, "evidence_excerpt": "..."}',
    };
  }
  if (scan_mode === 'pivota_pdp_attribution_test') {
    return {
      system:
        'You are a shopping-research analyst. Given a query, return whether the verified Pivota PDP URL is mentioned. Only the exact verified URL counts; mentions of "Pivota" without the URL are echoes, not attribution.',
      userPerQuery: (q) =>
        `Query: ${JSON.stringify(q)}\nVerified Pivota PDP URL: ${JSON.stringify(context.pivota_pdp_url || '')}\n` +
        'Reply JSON: {"pivota_url_found": true|false, "pivota_echo_only": true|false, "evidence_excerpt": "..."}',
    };
  }
  // search_grounded_product_discovery_test — same shape as visibility but with grounding hint
  return {
    system:
      'You are a shopping-research analyst with web search grounding. For the given query, list the URLs you would cite as buying paths.',
    userPerQuery: (q) =>
      `Query: ${JSON.stringify(q)}\nProduct: ${JSON.stringify(product)}\n` +
      'Reply JSON: {"cited_urls": [...], "product_visible": true|false, "evidence_excerpt": "..."}',
  };
}

function unwrapJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  // Strip ```json ... ``` fences if present
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  try {
    return JSON.parse(s);
  } catch (_err) {
    return null;
  }
}

async function withTimeout(promise, timeoutMs) {
  if (!timeoutMs) return promise;
  let timer = null;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('LLM_PROBE_TIMEOUT')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function buildGeminiProbe(input) {
  const client = getGeminiClient();
  if (!client) {
    // Fall back to mock so callers still get a useful response, with a
    // clearly-marked provider so they know it didn't go through Gemini.
    const mocked = buildMockProbe(input);
    return { ...mocked, provider: 'mock_fallback_no_gemini_key' };
  }

  const { scan_mode, max_runs, context } = input;
  const queries = context.queries.length
    ? context.queries.slice(0, max_runs)
    : [context.product_entity_id || ''].filter(Boolean);
  if (!queries.length) {
    return {
      scan_mode,
      provider: 'gemini',
      runs_count: 0,
      scores: { visibility_score: 0, attribution_echo_rate: 0 },
      findings: [],
      usage: { input_tokens: 0, output_tokens: 0 },
      raw_runs: [],
    };
  }

  const prompt = buildPromptForScanMode(input);
  const rawRuns = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let positives = 0;
  let echoes = 0;

  for (const q of queries) {
    const userText = prompt.userPerQuery(q);
    let parsed = null;
    let rawText = '';
    try {
      const resp = await withTimeout(
        client.models.generateContent({
          model: GEMINI_MODEL,
          contents: [
            {
              role: 'user',
              parts: [{ text: `${prompt.system}\n\n${userText}` }],
            },
          ],
          config: { temperature: 0, responseMimeType: 'application/json' },
        }),
        DEFAULT_GEMINI_TIMEOUT_MS,
      );
      if (typeof resp?.text === 'function') {
        rawText = await resp.text();
      } else if (typeof resp?.text === 'string') {
        rawText = resp.text;
      } else if (Array.isArray(resp?.candidates)) {
        const parts = resp.candidates[0]?.content?.parts || [];
        rawText = parts.map((p) => p?.text || '').join('');
      }
      parsed = unwrapJson(rawText);
      if (resp?.usageMetadata) {
        inputTokens += Number(resp.usageMetadata.promptTokenCount || 0);
        outputTokens += Number(resp.usageMetadata.candidatesTokenCount || 0);
      }
    } catch (err) {
      rawText = `__error__:${err && err.message ? err.message : String(err)}`;
    }
    rawRuns.push({ query: q, raw: rawText, parsed });

    // Per-mode scoring
    if (parsed && typeof parsed === 'object') {
      if (scan_mode === 'open_product_visibility_test' && parsed.product_visible === true) positives += 1;
      if (scan_mode === 'merchant_store_attribution_test' && parsed.merchant_url_found === true) positives += 1;
      if (scan_mode === 'pivota_pdp_attribution_test') {
        if (parsed.pivota_url_found === true) positives += 1;
        if (parsed.pivota_echo_only === true) echoes += 1;
      }
      if (scan_mode === 'search_grounded_product_discovery_test' && parsed.product_visible === true) positives += 1;
    }
  }

  const runsCount = queries.length;
  const visibilityScore = runsCount > 0 ? Math.round((positives / runsCount) * 100) : 0;
  const echoRate = runsCount > 0 ? Math.round((echoes / runsCount) * 100) : 0;

  // Generate findings only when scores fall below the spec thresholds. The
  // exact thresholds are intentionally simple in V1; tightening them is
  // follow-up work alongside real prompt engineering.
  const findings = [];
  if (scan_mode === 'pivota_pdp_attribution_test' && visibilityScore < 50) {
    findings.push({
      issue_type: 'pivota_pdp_attribution_gap',
      severity: visibilityScore < 25 ? 'high' : 'medium',
      evidence: { visibility_score: visibilityScore, runs: rawRuns },
    });
  }
  if (scan_mode === 'pivota_pdp_attribution_test' && echoRate > 0 && positives === 0) {
    findings.push({
      issue_type: 'unverified_pivota_attribution',
      severity: 'medium',
      evidence: { attribution_echo_rate: echoRate, runs: rawRuns },
    });
  }
  if (scan_mode === 'open_product_visibility_test' && visibilityScore < 50) {
    findings.push({
      issue_type: 'ai_visibility_loss',
      severity: visibilityScore < 25 ? 'high' : 'medium',
      evidence: { visibility_score: visibilityScore, runs: rawRuns },
    });
  }
  if (scan_mode === 'merchant_store_attribution_test' && visibilityScore < 50) {
    findings.push({
      issue_type: 'merchant_store_attribution_gap',
      severity: visibilityScore < 25 ? 'high' : 'medium',
      evidence: { visibility_score: visibilityScore, runs: rawRuns },
    });
  }
  if (scan_mode === 'search_grounded_product_discovery_test' && visibilityScore < 50) {
    findings.push({
      issue_type: 'ai_visibility_loss',
      severity: visibilityScore < 25 ? 'high' : 'medium',
      evidence: { visibility_score: visibilityScore, runs: rawRuns },
    });
  }

  return {
    scan_mode,
    provider: 'gemini',
    runs_count: runsCount,
    scores: { visibility_score: visibilityScore, attribution_echo_rate: echoRate },
    findings,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    raw_runs: rawRuns,
  };
}

// ---------------------------------------------------------------------------
// Express handler
// ---------------------------------------------------------------------------

async function handleProbeRequest(req, res) {
  let validated;
  try {
    validated = validateRequest(req.body);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err && err.message ? err.message : 'invalid_request' });
  }
  if (!validated.ok) {
    return res.status(400).json({ ok: false, error: validated.error });
  }
  const { normalized } = validated;

  let result;
  try {
    if (normalized.provider === 'gemini') {
      result = await buildGeminiProbe(normalized);
    } else {
      result = buildMockProbe(normalized);
    }
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: 'llm_probe_failed',
      detail: err && err.message ? err.message : String(err),
    });
  }
  return res.status(200).json({ ok: true, result });
}

/**
 * Mount the probe under `/internal/agent-center/llm-probe`. Call once during
 * server bootstrap with the Express app.
 */
function mountAgentCenterLlmProbe(app) {
  if (!app || typeof app.post !== 'function') {
    throw new Error('mountAgentCenterLlmProbe expects an Express app');
  }
  app.post('/internal/agent-center/llm-probe', requireInternalKey, handleProbeRequest);
}

module.exports = {
  mountAgentCenterLlmProbe,
  // Exported for testing only.
  _internals: {
    validateRequest,
    buildMockProbe,
    requireInternalKey,
    handleProbeRequest,
    PRIMARY_ISSUE_TYPE_BY_SCAN_MODE,
    ALLOWED_SCAN_MODES,
  },
};
