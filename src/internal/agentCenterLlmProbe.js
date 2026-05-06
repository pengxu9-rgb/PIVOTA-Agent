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

// V1.5: bumped from 3/8 → 10/20. With temperature=0 the V1 default of 3
// runs produced essentially three identical answers; the score had only
// four discrete values (0/33/66/100) regardless of true variance. 10 runs
// at temperature 0.3 (see Gemini config below) gives meaningful samples
// while staying within token budgets that don't break Gemini's grounding
// cap. Hard limit raised to 20 to give ops headroom for tighter probes.
const DEFAULT_MAX_RUNS = 10;
const HARD_MAX_RUNS = 20;

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

  // Optional product attributes — used by the auto-query generator when
  // `queries` is empty. All fields are optional; if `title` is present we
  // can derive ~10 realistic buyer-style queries instead of falling back
  // to product_entity_id (which is meaningless to an LLM).
  let product = null;
  if (_isPlainObject(context.product)) {
    const title = _isNonEmptyString(context.product.title) ? context.product.title.trim() : null;
    if (title) {
      product = {
        title,
        vendor: _isNonEmptyString(context.product.vendor) ? context.product.vendor.trim() : null,
        product_type: _isNonEmptyString(context.product.product_type)
          ? context.product.product_type.trim()
          : null,
      };
    }
  }

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
        product,
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
  // Prompt's "Product:" field: prefer the product title (real, meaningful
  // to the LLM) over the entity_id (meaningless string like "m1|shopify|P1").
  const product =
    (context.product && context.product.title) ||
    context.product_entity_id ||
    '(product)';
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
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try {
    return JSON.parse(s);
  } catch (_err) {
    // With Google Search grounding enabled we can't request strict JSON
    // (responseMimeType: 'application/json' is incompatible with the
    // grounding tool), so the model often interleaves prose around the
    // JSON object. Fall back to extracting the first {...} block.
    const objMatch = s.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]);
      } catch (_err2) {
        return null;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// URL normalization + post-hoc match — replaces LLM self-reporting for
// attribution scoring. The LLM (especially with grounding) routinely
// hallucinates a `pivota_url_found: true` even when the URL never appears
// in either its prose answer or the cited sources. We trust evidence from
// (1) raw response text and (2) groundingMetadata.groundingChunks instead.
// ---------------------------------------------------------------------------

const _TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src',
];

/**
 * Strip protocol + tracking params + trailing slash; lowercase host.
 * Returns `{ host, path, full }` shape or null if not a parseable URL.
 *
 * Two URLs are considered "the same" when their normalized form matches.
 * Most useful for PDP comparison: a verified Pivota PDP URL vs a URL the
 * model emits — same host + path + meaningful query = same destination.
 */
function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;
  let parsed;
  try {
    // URL constructor requires a scheme; accept bare hosts like
    // `merchant.com/p/123` by prepending https://.
    parsed = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(`https://${raw}`);
  } catch (_err) {
    return null;
  }
  const host = parsed.host.toLowerCase().replace(/^www\./, '');
  // Drop tracking params; keep the rest because product variants etc.
  // depend on them.
  for (const p of _TRACKING_PARAMS) parsed.searchParams.delete(p);
  let path = parsed.pathname || '/';
  if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1);
  const search = parsed.searchParams.toString();
  const full = host + path + (search ? `?${search}` : '');
  return { host, path, full };
}

/**
 * Returns true if `targetUrl` appears in `text`. Extracts every URL token
 * from `text`, normalizes each, and compares against the normalized target.
 * Use the broader match (path-prefix host match) when the target has a
 * meaningful path, so query-string drift doesn't cause false negatives.
 */
function textContainsUrl(text, targetUrl) {
  const target = normalizeUrl(targetUrl);
  if (!target || !text) return false;
  const candidates = String(text).match(/https?:\/\/[^\s'"<>)\]]+/gi) || [];
  for (const c of candidates) {
    const n = normalizeUrl(c);
    if (!n) continue;
    if (n.full === target.full) return true;
    // Path-aware match: same host + same canonical path is enough — query
    // string drift (e.g. variant params) shouldn't count as different.
    if (target.path !== '/' && n.host === target.host && n.path === target.path) return true;
  }
  return false;
}

/**
 * Returns true if `targetUrl` appears in any cited source URL inside the
 * Gemini groundingMetadata. Cited sources are the gold-standard signal that
 * the model actually retrieved the URL from a live search — much stronger
 * than a URL appearing in prose.
 */
function groundingContainsUrl(groundingMetadata, targetUrl) {
  const target = normalizeUrl(targetUrl);
  if (!target || !groundingMetadata) return false;
  const chunks = groundingMetadata.groundingChunks || groundingMetadata.grounding_chunks || [];
  for (const ch of chunks) {
    const u = ch?.web?.uri || ch?.web?.url || ch?.uri || ch?.url;
    if (!u) continue;
    const n = normalizeUrl(u);
    if (!n) continue;
    if (n.full === target.full) return true;
    if (target.path !== '/' && n.host === target.host && n.path === target.path) return true;
  }
  return false;
}

/**
 * "Echo" = the response mentions Pivota's brand/host but NOT the verified
 * PDP URL. This is the signal that the LLM has heard of Pivota but isn't
 * actually citing the merchant's verified PDP — useless attribution.
 */
function textMentionsHostOnly(text, targetUrl) {
  const target = normalizeUrl(targetUrl);
  if (!target || !text) return false;
  const t = String(text).toLowerCase();
  if (!t.includes(target.host)) return false;
  return !textContainsUrl(text, targetUrl);
}

// ---------------------------------------------------------------------------
// Auto query generator — V1 fell back to `product_entity_id` (e.g.
// "m1|shopify|P123") which is meaningless to an LLM. When the operator
// hasn't written queries manually but the product has a title, we derive
// realistic buyer-style queries from the product attributes. This is the
// difference between asking "do you know about m1|shopify|P123?" (always
// no) and asking "where can I buy Vitamin C Tonic 50ml?" (real signal).
// ---------------------------------------------------------------------------

/**
 * Build ~10 buyer-style queries from product attributes. Returns an empty
 * array if `product.title` is missing — caller decides what to do.
 *
 * Templates fall into three buckets:
 *   - direct buying intent ("where can I buy X", "shop X online")
 *   - comparative ("X reviews", "X alternatives", "is X worth it")
 *   - category-anchored ("best <product_type> for <vendor>")
 *
 * Order is deterministic — useful for snapshot tests and reproducible runs.
 */
function buildAutoQueries(product) {
  if (!product || !_isNonEmptyString(product.title)) return [];
  const title = product.title.trim();
  const vendor = _isNonEmptyString(product.vendor) ? product.vendor.trim() : null;
  const productType = _isNonEmptyString(product.product_type) ? product.product_type.trim() : null;

  const queries = [];
  // Direct buying intent — what an LLM-using shopper actually asks.
  queries.push(`where can I buy ${title}`);
  queries.push(`shop ${title} online`);
  queries.push(`${title} for sale`);
  // Reviews / comparison — surfaces when LLMs cite review pages, which
  // often leads them to merchant PDPs.
  queries.push(`${title} reviews`);
  queries.push(`is ${title} worth it`);
  queries.push(`${title} alternatives`);
  // Pricing — common comparison pattern for shoppers.
  queries.push(`best price for ${title}`);
  queries.push(`${title} discount`);
  // Vendor-anchored — improves recall when the vendor brand is searchable
  // even if the exact product title isn't a household name.
  if (vendor) {
    queries.push(`${vendor} ${title}`);
    queries.push(`buy ${vendor} ${productType || title} online`);
  }
  // Category-anchored — picks up "best X" listicles the LLM might cite.
  if (productType) {
    queries.push(`best ${productType}${vendor ? ` from ${vendor}` : ''}`);
  }
  return queries;
}

/**
 * Validate that attribution-mode scan_targets have the URL they're trying
 * to attribute. Returns a `missing_input` finding (issue payload) when the
 * required URL is missing, or null when inputs are OK.
 */
function _checkAttributionInputs(scan_mode, context) {
  if (scan_mode === 'pivota_pdp_attribution_test') {
    if (!context || !_isNonEmptyString(context.pivota_pdp_url)) {
      return {
        issue_type: 'missing_pivota_pdp_url',
        severity: 'medium',
        evidence: {
          kind: 'missing_input',
          message:
            'pivota_pdp_attribution_test requires context.pivota_pdp_url ' +
            '(the verified Pivota PDP URL to test attribution against). Provide it ' +
            'and re-run; the test was aborted to avoid a false-negative score.',
          required_field: 'context.pivota_pdp_url',
        },
      };
    }
  } else if (scan_mode === 'merchant_store_attribution_test') {
    if (!context || !_isNonEmptyString(context.merchant_pdp_url)) {
      return {
        issue_type: 'missing_merchant_pdp_url',
        severity: 'medium',
        evidence: {
          kind: 'missing_input',
          message:
            "merchant_store_attribution_test requires context.merchant_pdp_url " +
            "(the merchant's own store URL to test attribution against). Provide it " +
            'and re-run; the test was aborted to avoid a false-negative score.',
          required_field: 'context.merchant_pdp_url',
        },
      };
    }
  }
  return null;
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

  // Guard: attribution modes can't produce a meaningful score without the
  // URL we're trying to attribute. Running anyway always produces
  // visibility=0 (because no URL → no match), which then triggers a
  // misleading `pivota_pdp_attribution_gap` / `merchant_store_attribution_gap`
  // finding even though the real issue is missing input. Return cleanly
  // with a `missing_input` finding so the UI can guide the operator.
  const missingInputFinding = _checkAttributionInputs(scan_mode, context);
  if (missingInputFinding) {
    return {
      scan_mode,
      provider: 'gemini',
      runs_count: 0,
      scores: { visibility_score: 0, attribution_echo_rate: 0 },
      findings: [missingInputFinding],
      usage: { input_tokens: 0, output_tokens: 0 },
      raw_runs: [],
      aborted: 'missing_input',
    };
  }

  // Query precedence:
  //   1. Operator-written queries (`context.queries`) — always wins
  //   2. Auto-generated from `context.product` attributes — V1.5 default
  //      when product info is available (real buyer-style phrasing)
  //   3. `context.product_entity_id` as a last resort — V1 behavior, kept
  //      so existing scan_targets don't suddenly produce empty results
  let queries;
  if (context.queries.length) {
    queries = context.queries.slice(0, max_runs);
  } else {
    const auto = buildAutoQueries(context.product);
    queries = auto.length
      ? auto.slice(0, max_runs)
      : [context.product_entity_id || ''].filter(Boolean);
  }
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

  // Google Search grounding: lets Gemini retrieve live web pages instead of
  // answering from training data — turns the visibility test from "did
  // Gemini's training data include this product when phrased exactly like
  // this" into "is this product currently surfaceable on the live web".
  // Note: responseMimeType: 'application/json' is NOT compatible with
  // grounding (Gemini interleaves tool calls with text), so we drop strict
  // JSON mode and rely on `unwrapJson`'s prose-fallback to extract the
  // structured fields from the response.
  // V1.5: temperature=0.3 (was 0). At 0 every run produced ~identical
  // answers, defeating the point of running multiple queries. 0.3 gives
  // Gemini room to surface different sources/phrasings across runs while
  // staying low enough that the score reflects the product's real
  // visibility (not random noise). Determinism for tests is preserved by
  // monkey-patching the client, not by the temperature.
  const generationConfig = {
    temperature: 0.3,
    tools: [{ googleSearch: {} }],
  };

  for (const q of queries) {
    const userText = prompt.userPerQuery(q);
    let parsed = null;
    let rawText = '';
    let groundingMetadata = null;
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
          config: generationConfig,
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
      // Gemini API returns groundingMetadata on the first candidate when
      // the model used the search tool. Capture it — we both score
      // against it and ship it back in raw_runs for evidence.
      const cand0 = Array.isArray(resp?.candidates) ? resp.candidates[0] : null;
      groundingMetadata = cand0?.groundingMetadata || cand0?.grounding_metadata || null;
      parsed = unwrapJson(rawText);
      if (resp?.usageMetadata) {
        inputTokens += Number(resp.usageMetadata.promptTokenCount || 0);
        outputTokens += Number(resp.usageMetadata.candidatesTokenCount || 0);
      }
    } catch (err) {
      rawText = `__error__:${err && err.message ? err.message : String(err)}`;
    }
    // Per-mode scoring — derived from EVIDENCE (raw text + cited sources)
    // rather than the LLM's self-reported parsed fields. The model still
    // produces self-reports; we keep them in raw_runs for debugging but
    // don't trust them for the score.
    let urlMatch = null;
    if (scan_mode === 'open_product_visibility_test') {
      if (parsed && parsed.product_visible === true) positives += 1;
    } else if (scan_mode === 'merchant_store_attribution_test') {
      const target = context.merchant_pdp_url || '';
      const hit = Boolean(target) && (
        groundingContainsUrl(groundingMetadata, target) || textContainsUrl(rawText, target)
      );
      urlMatch = {
        target_url: target,
        in_grounding: Boolean(target) && groundingContainsUrl(groundingMetadata, target),
        in_text: Boolean(target) && textContainsUrl(rawText, target),
        llm_self_report: parsed && parsed.merchant_url_found === true,
      };
      if (hit) positives += 1;
    } else if (scan_mode === 'pivota_pdp_attribution_test') {
      const target = context.pivota_pdp_url || '';
      const inGrounding = Boolean(target) && groundingContainsUrl(groundingMetadata, target);
      const inText = Boolean(target) && textContainsUrl(rawText, target);
      const hit = inGrounding || inText;
      const echoOnly = !hit && Boolean(target) && textMentionsHostOnly(rawText, target);
      urlMatch = {
        target_url: target,
        in_grounding: inGrounding,
        in_text: inText,
        echo_only: echoOnly,
        llm_self_report: {
          pivota_url_found: parsed && parsed.pivota_url_found === true,
          pivota_echo_only: parsed && parsed.pivota_echo_only === true,
        },
      };
      if (hit) positives += 1;
      if (echoOnly) echoes += 1;
    } else if (scan_mode === 'search_grounded_product_discovery_test') {
      // Use LLM self-report as a fallback signal but require grounding
      // evidence when context.pivota_pdp_url or merchant_pdp_url is given.
      // If neither is given, fall back to the LLM's `product_visible` field.
      const target = context.pivota_pdp_url || context.merchant_pdp_url || '';
      if (target) {
        const hit = groundingContainsUrl(groundingMetadata, target) || textContainsUrl(rawText, target);
        urlMatch = {
          target_url: target,
          in_grounding: groundingContainsUrl(groundingMetadata, target),
          in_text: textContainsUrl(rawText, target),
          llm_self_report: parsed && parsed.product_visible === true,
        };
        if (hit) positives += 1;
      } else if (parsed && parsed.product_visible === true) {
        positives += 1;
      }
    }
    rawRuns.push({
      query: q,
      raw: rawText,
      parsed,
      // Trim grounding chunks to URI-only to keep the payload small while
      // preserving the audit trail of which sources Gemini actually cited.
      grounding_chunks: groundingMetadata
        ? (groundingMetadata.groundingChunks || groundingMetadata.grounding_chunks || [])
            .map((ch) => ch?.web?.uri || ch?.web?.url || ch?.uri || ch?.url)
            .filter(Boolean)
        : [],
      url_match: urlMatch,
    });
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
    buildGeminiProbe,
    requireInternalKey,
    handleProbeRequest,
    normalizeUrl,
    textContainsUrl,
    groundingContainsUrl,
    textMentionsHostOnly,
    unwrapJson,
    buildAutoQueries,
    PRIMARY_ISSUE_TYPE_BY_SCAN_MODE,
    ALLOWED_SCAN_MODES,
  },
};
