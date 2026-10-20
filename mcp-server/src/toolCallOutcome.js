// WHAT A TOOL CALL ACTUALLY RETURNED, for the gateway's one-line `mcp tools/call complete` log.
//
// Measurement only: nothing here decides anything, and nothing reads these fields back. The MCP doors answer
// HTTP 200 for every tools/call (a tool failure rides inside the JSON-RPC body), so the platform's 5xx metrics
// cannot see a failing tool, and the completion line used to carry only the tool name, status and latency. These
// helpers turn the value a surface returned (or the error it threw) into a handful of bounded, argument-free
// fields: how many rows the caller saw, which lane answered, and whether the lane says it degraded.
//
// Every field is derived from the RESULT, never from the tool arguments, and every string is a short token
// checked against a strict pattern, so a free-text field (a query, a product title) can never reach the log.
//
// Callers hand fields to an `observe(fields)` sink. The sink is optional everywhere: a surface called without
// one (tests, the stdio server, the public tier's inner commerce call) behaves exactly as before.

const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

// The list a caller sees, in the order the result shapes use them. The FIRST array present wins, so a result
// carrying both `products` and a nested list is counted by its primary list.
const LIST_KEYS = Object.freeze(["products", "offers", "alternatives", "items", "recommendations", "results", "orders"]);

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const p = Object.getPrototypeOf(value);
  return p === Object.prototype || p === null;
}

function token(value) {
  return typeof value === "string" && TOKEN.test(value.trim()) ? value.trim() : null;
}

/**
 * Call `observe(fields)` without ever letting it throw into the surface it measures.
 * @param {((fields:object)=>void)|undefined|null} observe
 * @param {object} fields
 */
export function noteToolCall(observe, fields) {
  if (typeof observe !== "function" || !fields || typeof fields !== "object") return;
  try {
    observe(fields);
  } catch {
    // Measurement must never break the call it measures.
  }
}

/**
 * The number of rows in the result the CALLER receives — after the public tier's sourcing and chain filters
 * and after dialect shaping, because that is the value handed to this function. Omitted (not 0) for a result
 * that is not a list (a product detail, a checkout session), so a zero always means "an empty list".
 */
export function resultCountOf(value) {
  if (!isPlainObject(value)) return {};
  for (const key of LIST_KEYS) {
    if (Array.isArray(value[key])) return { result_count: value[key].length };
  }
  return {};
}

/**
 * Degradation and lane markers the SEARCH envelope carries, read before any projection strips them.
 *
 * `status`/`success` are the markers the search lane really sets (see isDegradedUpstream in
 * publicReadToolSurface.js for why `ok`/`error` are only defensive arms). A degraded envelope can still carry
 * rows — the lane has answered `status:"failed"` with a full product list — so this reports the marker and
 * leaves the row count to resultCountOf; neither one implies the other.
 */
export function describeUpstreamEnvelope(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  const status = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : "";
  if (status && !["success", "ok"].includes(status)) {
    out.upstream_degraded = true;
    const statusToken = token(status);
    if (statusToken) out.upstream_status = statusToken;
  }
  if (raw.success === false || raw.ok === false || Boolean(raw.error)) out.upstream_degraded = true;

  const meta = isPlainObject(raw.metadata) ? raw.metadata : null;
  if (meta) {
    const lane = token(meta.primary_lane);
    if (lane) out.lane = lane;
    const laneSource = token(meta.query_source);
    if (laneSource) out.lane_source = laneSource;
    const routeHealth = isPlainObject(meta.route_health) ? meta.route_health : null;
    const sourceBreakdown = isPlainObject(meta.source_breakdown) ? meta.source_breakdown : null;
    if (
      (routeHealth && routeHealth.fallback_triggered === true) ||
      meta.family_fallback_used === true ||
      (sourceBreakdown && sourceBreakdown.stale_cache_used === true)
    ) {
      out.fallback_used = true;
    }
  }
  return out;
}

/** Fields a thrown tool error carries beyond its code: today, whether the upstream call timed out. */
export function describeToolError(error) {
  const detail = error && typeof error === "object" && isPlainObject(error.detail) ? error.detail : null;
  return detail && detail.upstream_timeout === true ? { upstream_timeout: true } : {};
}

/**
 * The error code the CALLER saw, read back from the formatted MCP error result rather than recomputed, so the
 * log can never disagree with the wire. Anything that does not parse as an UPPER_SNAKE code is UNEXPECTED_ERROR.
 */
export function toolErrorCodeOf(result) {
  try {
    const text = result && Array.isArray(result.content) && result.content[0] ? result.content[0].text : null;
    const code = typeof text === "string" ? JSON.parse(text)?.error?.code : null;
    return typeof code === "string" && ERROR_CODE.test(code) ? code : "UNEXPECTED_ERROR";
  } catch {
    return "UNEXPECTED_ERROR";
  }
}

/** Map a cache's own state word onto the log's `cache_hit` field: true | false | 'stale'. */
export function cacheHitField(state) {
  if (state === "hit") return { cache_hit: true };
  if (state === "stale") return { cache_hit: "stale" };
  if (state === "miss") return { cache_hit: false };
  return {};
}
