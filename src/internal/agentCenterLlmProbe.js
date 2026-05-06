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
  // V1.6 — category-level discoverability. Asks open category queries
  // ("best Korean eye patches 2026") instead of product-named queries
  // ("where can I buy Revive Under Eye Patch"). The product-named test
  // is a tautology: the model sees the product in the query and answers
  // yes. Category queries test whether the merchant brand/URL appears
  // in grounded sources for a query that doesn't already name the
  // product — the honest BD-pitch baseline of "AI-channel discoverability".
  'category_visibility_test',
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
  category_visibility_test: 'category_discoverability_gap',
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
  // Accept any of three env var names so we ride existing production
  // shared-secret conventions instead of asking ops to provision yet
  // another secret. Priority:
  //
  //   1. PROMOTIONS_ADMIN_KEY  — already set on both pivota-backend
  //      and PIVOTA-Agent in production for admin/ops routes
  //      (utils/auth.py + admin migration scripts). Same shared-secret
  //      pattern, same value on both ends; zero operational change to
  //      enable internal-probe auth.
  //   2. AGENT_API_KEY         — gateway-proxy + agent-commerce convention
  //      (pivota-agent-ui /api/gateway already reads this).
  //   3. PIVOTA_INTERNAL_API_KEY — V1 dedicated name; kept as final fallback.
  const expected = String(
    process.env.PROMOTIONS_ADMIN_KEY ||
      process.env.AGENT_API_KEY ||
      process.env.PIVOTA_INTERNAL_API_KEY ||
      '',
  ).trim();
  if (!expected) {
    return res.status(503).json({
      ok: false,
      // Error code names the canonical env var so ops sees the right
      // thing to fix in Railway logs.
      error: 'internal_probe_key_not_configured',
      detail:
        'Set PROMOTIONS_ADMIN_KEY (preferred — already shared with admin routes) ' +
        'or AGENT_API_KEY or PIVOTA_INTERNAL_API_KEY on this service.',
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
    // Category visibility is the harshest test by design — most merchants
    // start invisible to category queries (they only show up when the
    // query already names them). Mock at 25 to make findings always fire
    // in dev, matching the production-tendency-toward-low.
    category_visibility_test: { visibility_score: 25, attribution_echo_rate: 0 },
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
  if (scan_mode === 'category_visibility_test') {
    // The product is intentionally NOT named in the query — that's the
    // whole point. The query is a category-open buyer query the typical
    // consumer would ask. We check whether the merchant brand or URL
    // appears in grounded sources. Scoring uses post-hoc grounding match
    // (in `buildGeminiProbe`'s scoring branch); the self-report fields
    // here are diagnostic only.
    const brand = (context.product && context.product.vendor) || '(merchant brand)';
    const merchantUrl = context.merchant_pdp_url || '';
    return {
      system:
        'You are a shopping-research analyst with live web search. For each ' +
        'category query a consumer might ask, decide whether the specified ' +
        'merchant brand surfaces in your grounded answer at all. Reply with ' +
        'strict JSON; the canonical signal is the cited sources, not your ' +
        'own assertion.',
      userPerQuery: (q) =>
        `Category query: ${JSON.stringify(q)}\n` +
        `Merchant brand: ${JSON.stringify(brand)}\n` +
        `Merchant store URL (optional): ${JSON.stringify(merchantUrl)}\n` +
        'Reply JSON: {"brand_appears": true|false, "competitors_appearing": [...], "evidence_excerpt": "..."}',
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
 * Returns the chunks normalized to `{ uri, title, host }` shape. The raw
 * Gemini grounding payload exposes `web.uri` (a vertexaisearch.cloud.google.com
 * REDIRECTOR — NOT the actual destination) and `web.title` (the human-readable
 * source name like "Sephora", "Olive Young Global", "Beauty of Joseon Official
 * Store"). Title is the canonical signal for "what site did the model cite";
 * URI is useful for de-duplication but rarely matches a real merchant URL
 * because of the redirector wrapper.
 *
 * We surface both so callers can pick the right one for their use case
 * (host-based comparison, brand-based competitor extraction, etc).
 */
function normalizeGroundingChunks(groundingMetadata) {
  if (!groundingMetadata) return [];
  const raw = groundingMetadata.groundingChunks || groundingMetadata.grounding_chunks || [];
  const out = [];
  for (const ch of raw) {
    const uri = ch?.web?.uri || ch?.web?.url || ch?.uri || ch?.url || '';
    const title = ch?.web?.title || ch?.title || '';
    const norm = normalizeUrl(uri);
    out.push({
      uri: typeof uri === 'string' ? uri : '',
      title: typeof title === 'string' ? title : '',
      host: norm?.host || null,
    });
  }
  return out;
}

const _VERTEX_REDIRECTOR_HOSTS = new Set([
  'vertexaisearch.cloud.google.com',
  'vertex-ai-search.cloud.google.com',
]);

function _chunkIsRedirector(chunk) {
  return !!chunk.host && _VERTEX_REDIRECTOR_HOSTS.has(chunk.host);
}

/**
 * Returns true if `targetUrl` matches any cited source. Tries:
 *   1. Direct URI match (when Gemini happens to cite a non-redirected URL)
 *   2. Title contains the merchant brand or host — captures the common case
 *      where the redirector hides the real destination but the title says
 *      "Beauty of Joseon Official Store".
 *
 * `merchantBrand` is optional — when provided we also accept title matches
 * against the brand string (case-insensitive). For the typical BD path we
 * pass product.vendor as the brand.
 */
function groundingContainsUrl(groundingMetadata, targetUrl, merchantBrand) {
  const target = normalizeUrl(targetUrl);
  if (!target && !merchantBrand) return false;
  if (!groundingMetadata) return false;
  const chunks = normalizeGroundingChunks(groundingMetadata);
  const brandLower = typeof merchantBrand === 'string' && merchantBrand.trim()
    ? merchantBrand.trim().toLowerCase()
    : null;
  for (const ch of chunks) {
    if (target && ch.host && !_chunkIsRedirector(ch)) {
      // Direct URL match (rare with grounding redirectors, but still
      // possible when Gemini cites a non-redirector URL).
      if (ch.host === target.host) {
        if (target.path === '/' || target.path === ch.path?.path) return true;
        // Path-aware via re-normalizing the chunk's URI.
        const n = normalizeUrl(ch.uri);
        if (n && n.host === target.host && n.path === target.path) return true;
      }
    }
    // Title match — works through the redirector wrapper.
    if (ch.title && target?.host) {
      const titleLower = ch.title.toLowerCase();
      // The merchant's host (e.g. "beautyofjoseon.com") often appears in
      // the page title for the merchant's own store.
      if (titleLower.includes(target.host)) return true;
    }
    if (ch.title && brandLower && ch.title.toLowerCase().includes(brandLower)) {
      return true;
    }
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
 * Build category-open buyer queries that DO NOT name the product. These
 * are the honest test of AI-channel discoverability: if a consumer asks
 * "best Korean eye patches" without naming the brand, does the merchant
 * surface in grounded sources at all?
 *
 * Requires `product.product_type`. Returns [] when product_type is
 * missing — caller falls back to the standard product-named queries
 * (which is a tautology, but better than nothing for V1.6 transition).
 */
function buildCategoryQueries(product) {
  if (!product || !_isNonEmptyString(product.product_type)) return [];
  const productType = product.product_type.trim();
  // Use the singular product_type form. Pluralization heuristic for
  // common English categories — "best Korean eye patches", not "best
  // Korean eye patch". Conservative: only pluralizes the obvious cases;
  // when unsure we keep the singular (still parseable by the LLM).
  const plural = _pluralize(productType);

  const queries = [];
  // Generic best-of — the most-likely category query a real consumer asks.
  queries.push(`best ${plural} 2026`);
  queries.push(`top ${plural} this year`);
  // Comparative — under-$N is a high-intent buyer pattern.
  queries.push(`best ${plural} under $50`);
  // Authority signal — what reviewers/experts recommend.
  queries.push(`what ${plural} do dermatologists recommend`);
  // Niche / regional anchor — picks up brands with cultural or regional
  // relevance ("Korean", "Japanese", "Italian", etc.). When vendor name
  // hints regional origin we use that as a hint; otherwise omit.
  const vendor = _isNonEmptyString(product.vendor) ? product.vendor.trim() : null;
  if (vendor) {
    // Just include the vendor as a soft constraint — Gemini grounded
    // search will surface comparable brands (so this is closer to a
    // peer-set query than a brand-specific one).
    queries.push(`top ${plural} like ${vendor}`);
  }
  return queries;
}

function _pluralize(word) {
  const w = word.toLowerCase();
  if (w.endsWith('s')) return word; // already plural-ish
  if (w.endsWith('y') && !/[aeiou]y$/.test(w)) {
    return word.slice(0, -1) + 'ies'; // serum doesn't apply, but candy → candies
  }
  if (w.endsWith('sh') || w.endsWith('ch') || w.endsWith('x') || w.endsWith('z')) {
    return word + 'es';
  }
  return word + 's';
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
  //   2. For category_visibility_test, auto-generate CATEGORY-OPEN
  //      queries from product.product_type (don't name the product —
  //      that defeats the test)
  //   3. For all other modes, auto-generate from product attributes
  //      (real buyer-style phrasing including the product title)
  //   4. `context.product_entity_id` last resort — V1 fallback
  let queries;
  if (context.queries.length) {
    queries = context.queries.slice(0, max_runs);
  } else if (scan_mode === 'category_visibility_test') {
    const cat = buildCategoryQueries(context.product);
    queries = cat.length
      ? cat.slice(0, max_runs)
      : [context.product_entity_id || ''].filter(Boolean);
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
  const generationConfig = {
    temperature: 0,
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
    // Pre-parse the chunks once per run — used by scoring + raw_runs.
    const chunks = normalizeGroundingChunks(groundingMetadata);
    const hasAnyGrounding = chunks.length > 0;
    const merchantBrand = context.product?.vendor || context.product?.title || null;

    // Per-mode scoring — derived from EVIDENCE (cited sources via grounding
    // metadata) rather than the LLM's self-reported parsed fields. The
    // model still produces self-reports; we keep them in raw_runs for
    // debugging but don't trust them for the score.
    let urlMatch = null;
    if (scan_mode === 'open_product_visibility_test') {
      // FIX (post-BoJ-run audit): self-report-only scoring is tautological —
      // the model sees a query mentioning the product and answers "yes"
      // even with empty grounding_chunks. Real visibility requires Gemini
      // to actually retrieve grounded sources from live web search.
      // Positive ONLY when self-report is true AND grounding has chunks.
      if (parsed && parsed.product_visible === true && hasAnyGrounding) {
        positives += 1;
      }
    } else if (scan_mode === 'merchant_store_attribution_test') {
      const target = context.merchant_pdp_url || '';
      // FIX (post-BoJ-run audit): drop textContainsUrl from positive
      // scoring. The model's prose often references the verified URL while
      // EXPLAINING THAT IT'S NOT IN THE SEARCH RESULTS — that's a false
      // positive. Only trust the structured grounding metadata.
      const inGrounding = Boolean(target) && groundingContainsUrl(
        groundingMetadata, target, merchantBrand,
      );
      urlMatch = {
        target_url: target,
        in_grounding: inGrounding,
        // Keep `in_text` in the audit trail for debugging but it does NOT
        // count toward the score anymore.
        in_text: Boolean(target) && textContainsUrl(rawText, target),
        llm_self_report: parsed && parsed.merchant_url_found === true,
      };
      if (inGrounding) positives += 1;
    } else if (scan_mode === 'pivota_pdp_attribution_test') {
      const target = context.pivota_pdp_url || '';
      const inGrounding = Boolean(target) && groundingContainsUrl(
        groundingMetadata, target, merchantBrand,
      );
      const inText = Boolean(target) && textContainsUrl(rawText, target);
      // Echo: model mentions the host in prose but no grounding evidence.
      // Drop `inText` from positive scoring (same reason as merchant
      // attribution) — only `inGrounding` counts as real attribution.
      const echoOnly = !inGrounding && Boolean(target) && textMentionsHostOnly(rawText, target);
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
      if (inGrounding) positives += 1;
      if (echoOnly) echoes += 1;
    } else if (scan_mode === 'search_grounded_product_discovery_test') {
      const target = context.pivota_pdp_url || context.merchant_pdp_url || '';
      if (target) {
        const inGrounding = groundingContainsUrl(groundingMetadata, target, merchantBrand);
        urlMatch = {
          target_url: target,
          in_grounding: inGrounding,
          in_text: textContainsUrl(rawText, target),
          llm_self_report: parsed && parsed.product_visible === true,
        };
        if (inGrounding) positives += 1;
      } else if (parsed && parsed.product_visible === true && hasAnyGrounding) {
        // Same anti-tautology guard as open_visibility.
        positives += 1;
      }
    } else if (scan_mode === 'category_visibility_test') {
      // Category visibility: positive when the merchant's brand or URL
      // appears in any grounded source for a query that DOES NOT name
      // the product. Self-report (`brand_appears`) is diagnostic only —
      // grounding is the authoritative signal (same anti-hallucination
      // discipline as the other modes).
      const target = context.merchant_pdp_url || '';
      const brandHit = Boolean(merchantBrand) && groundingContainsUrl(
        groundingMetadata, target || '', merchantBrand,
      );
      urlMatch = {
        target_brand: merchantBrand || null,
        target_url: target || null,
        in_grounding: brandHit,
        // For category mode, we don't trust prose URL match at all
        // (the category query never names the product, so URLs in
        // prose are even-more-likely model fabrications).
        in_text: false,
        llm_self_report: parsed && parsed.brand_appears === true,
      };
      if (brandHit) positives += 1;
    }
    rawRuns.push({
      query: q,
      raw: rawText,
      parsed,
      // Surface BOTH uri AND title per chunk. Title is the canonical
      // "what site did Gemini cite" signal — uri is usually a Vertex AI
      // redirector (vertexaisearch.cloud.google.com) that doesn't reveal
      // the destination. Backend uses title to extract real competitor
      // hosts ("Sephora", "Olive Young Global", etc.).
      grounding_chunks: chunks.map((c) => c.uri).filter(Boolean),
      grounding_sources: chunks.map((c) => ({ uri: c.uri, title: c.title })),
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
  if (scan_mode === 'category_visibility_test' && visibilityScore < 50) {
    // Category visibility is the strictest signal — most merchants
    // start invisible at the category level. We surface this as
    // `category_discoverability_gap` separately from the product-named
    // `ai_visibility_loss` so BD can distinguish "Gemini knows your
    // product when named" from "Gemini doesn't surface you in category
    // queries".
    findings.push({
      issue_type: 'category_discoverability_gap',
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
    normalizeGroundingChunks,
    textMentionsHostOnly,
    unwrapJson,
    buildAutoQueries,
    buildCategoryQueries,
    PRIMARY_ISSUE_TYPE_BY_SCAN_MODE,
    ALLOWED_SCAN_MODES,
  },
};
