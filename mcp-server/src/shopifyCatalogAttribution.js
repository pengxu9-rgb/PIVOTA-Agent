// SHOPIFY PROMOTED PLACEMENTS ATTRIBUTION for the storefront escalation's store cart.
//
// WHAT IT IS FOR. Shopify pays a commission (Promoted Placements, base 0.3%) on a purchase that starts from a
// variant id carrying Shopify's catalog attribution: `gid://shopify/ProductVariant/<n>?shcgid=<catalog>&shclid=<click>`.
// Such an id comes only from Shopify's Global Catalog, only to an AUTHENTICATED caller enrolled in the program, and
// (for a lookup by id) only on the UCP `draft` version with `catalog.catalog_id` (shopify.dev/docs/agents/catalog/
// promoted-placement, "Attribute product lookups"; measured 2026-11-17: our 2026-04-08 profile gets bare ids, a draft
// profile gets 4/4 tracked). This module asks the catalog for the tracked id of the variants a store cart is about to
// carry, so the cart the buyer pays for is attributed to our saved catalog.
//
// WHAT IT NEVER DOES.
//   - It never contacts a merchant. Its only host is the Global Catalog endpoint, plus Shopify's token endpoint.
//   - It never reads UCP_AGENT_CLIENT_* (the store client's credential): those move every outbound STORE call to the
//     Token tier, which needs a buyer IP on every merchant call. This client has its own key names.
//   - It never logs, returns or puts in a URL the client id, the secret or the token, and never logs a variant id or
//     a click id (`shclid` identifies one buyer's click). Its log line carries counts, a reason and a latency.
//   - It never blocks a purchase. Every failure (no credential, a timeout, a 429, an `unauthorized` message, an
//     answer it cannot read) returns no tracked ids, and the caller builds today's cart.
//   - It never reuses a tracked id across buyers: there is no cache of ids, only of the bearer token.
//
// SWITCH: SHOPIFY_CATALOG_ATTRIBUTION = off (default; also the kill switch) | shadow | enforce, read per call.
//   shadow  the lookup runs and is counted; the cart is built exactly as today.
//   enforce the caller sends the tracked ids, ONLY for the stores SHOPIFY_CATALOG_ATTRIBUTION_STORES names
//           (comma-separated hosts; `*` = every store). Every other store, and every store when the list is unset
//           or empty, is treated as shadow: a forgotten env value can never take enforce fleet-wide.
//   SHOPIFY_CATALOG_ATTRIBUTION_DENY_HOSTS (comma-separated) turns it off for named stores in every mode.
// Configuration, all required for anything to run: SHOPIFY_CATALOG_CLIENT_ID, SHOPIFY_CATALOG_CLIENT_SECRET,
// SHOPIFY_CATALOG_ID (the saved catalog with Earn commission on), SHOPIFY_CATALOG_DRAFT_PROFILE_URL (our own
// draft-version agent profile, served at /.well-known/ucp-agent-catalog-draft).
//
// IDENTITY IS THE VARIANT ID, NOT THE SELLER NAME. A Shopify variant id belongs to exactly one shop, and the lookup is
// BY that id, so a returned variant with the same number is the variant we are carting. The answer's seller is not
// compared with the store's host on purpose: the catalog names a shop by its myshopify domain while our rows name the
// storefront's own domain (measured 2026-11-12: a store whose seller.domain is its myshopify name and whose checkout
// names its public domain), so a name check would refuse real matches without adding any safety.
//
// SCOPE. US buyers only (the caller passes the market; the saved catalog is a US catalog, and the standing rule is a
// price in the market's currency or none). Shopify stores only: an id the catalog does not return tracked stays bare.

export const CATALOG_ATTRIBUTION_FLAG = "SHOPIFY_CATALOG_ATTRIBUTION";
export const CATALOG_ATTRIBUTION_STORES_ENV = "SHOPIFY_CATALOG_ATTRIBUTION_STORES";
export const CATALOG_ATTRIBUTION_DENY_ENV = "SHOPIFY_CATALOG_ATTRIBUTION_DENY_HOSTS";
export const CATALOG_ENDPOINT = "https://catalog.shopify.com/api/ucp/mcp";
export const TOKEN_ENDPOINT = "https://api.shopify.com/auth/access_token";
export const ATTRIBUTION_BUDGET_MS = 800;
export const LOOKUP_BATCH = 10; // lookup_catalog takes 1-10 ids
export const ATTRIBUTION_MARKETS = Object.freeze(new Set(["US"]));
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const TOKEN_FALLBACK_TTL_MS = 50 * 60 * 1000; // when the token's own `exp` cannot be read
const TOKEN_FAILURE_BACKOFF_MS = 60 * 1000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 3000;
// THE BREAKER. A slow or failing catalog costs every US create up to the lookup budget. After BREAKER_FAILURES
// consecutive failed lookups (timeout, network, 429, 5xx), lookups are skipped for BREAKER_OPEN_MS
// (`skipped:breaker`), then one is tried again. An answered lookup closes it. An `unauthorized` answer counts too.
export const BREAKER_FAILURES = 3;
export const BREAKER_OPEN_MS = 60 * 1000;
const MAX_ID_LENGTH = 512;

const MODES = Object.freeze({ OFF: "off", SHADOW: "shadow", ENFORCE: "enforce" });
// A bare Shopify variant gid, anchored. NOT shopifyVariantResolver's toVariantGid, whose unanchored pattern accepts
// (and strips) anything around the gid.
const BARE_VARIANT_RE = /^gid:\/\/shopify\/ProductVariant\/(\d{1,20})$/;
// A tracked id: the bare gid, then a query string of unreserved characters only (no percent-encoding: nothing a
// store's create_cart could decode into something else). Its parameters are checked one by one below.
const TRACKED_VARIANT_RE = /^gid:\/\/shopify\/ProductVariant\/(\d{1,20})\?([A-Za-z0-9._~&=-]{1,400})$/;
const PARAM_VALUE_RE = /^[A-Za-z0-9._~-]{1,200}$/;

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hostList = (raw) => new Set(String(raw || "").split(",").map((h) => h.trim().toLowerCase().replace(/^www\./, "")).filter(Boolean));
const bare = (h) => String(h || "").trim().toLowerCase().replace(/^www\./, "");

/** The switch, read per call. Anything but the two on-words is off. */
export function catalogAttributionMode(env = process.env) {
  const v = String((env && env[CATALOG_ATTRIBUTION_FLAG]) || "").trim().toLowerCase();
  return v === MODES.SHADOW || v === MODES.ENFORCE ? v : MODES.OFF;
}

/** What the caller may do for this store: "off" | "shadow" | "enforce". */
export function modeForStore(env, sellerHost) {
  const mode = catalogAttributionMode(env);
  if (mode === MODES.OFF) return MODES.OFF;
  const host = bare(sellerHost);
  if (!host || hostList(env[CATALOG_ATTRIBUTION_DENY_ENV]).has(host)) return MODES.OFF;
  if (mode === MODES.ENFORCE) {
    const raw = String(env[CATALOG_ATTRIBUTION_STORES_ENV] || "").trim();
    if (raw === "*") return MODES.ENFORCE;
    return hostList(raw).has(host) ? MODES.ENFORCE : MODES.SHADOW;
  }
  return mode;
}

/** The numeric variant id of a bare gid, or null (anchored). */
export function bareVariantNumber(gid) {
  const m = typeof gid === "string" ? BARE_VARIANT_RE.exec(gid) : null;
  return m ? m[1] : null;
}

/**
 * Is `id` a tracked id for bare variant `expectedNumber`, attributed to OUR catalog? Exact: the same variant number,
 * and a query of EXACTLY two parameters, `shcgid` (equal to our catalog id) and `shclid`, each once, each a raw value
 * of unreserved characters. Any other parameter, a repeat, a different case, an empty key or a percent sign: not used
 * (the line stays bare). This id goes to the store byte for byte, so nothing beyond Shopify's two members is allowed.
 */
export function isTrackedIdFor(id, expectedNumber, catalogId) {
  if (typeof id !== "string" || id.length > MAX_ID_LENGTH || typeof catalogId !== "string") return false;
  const m = TRACKED_VARIANT_RE.exec(id);
  if (!m || m[1] !== expectedNumber) return false;
  const found = {};
  for (const part of m[2].split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return false;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if ((key !== "shcgid" && key !== "shclid") || key in found || !PARAM_VALUE_RE.test(value)) return false;
    found[key] = value;
  }
  return found.shcgid === catalogId && typeof found.shclid === "string";
}

function jwtExpiryMs(token) {
  try {
    const part = token.split(".")[1];
    const json = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (!Number.isFinite(json.exp) || json.exp <= 0) return null;
    // Seconds per RFC 7519; a value that is already a millisecond timestamp is read as one.
    return json.exp > 1e12 ? json.exp : json.exp * 1000;
  } catch { return null; }
}

const TOKEN_MAX_LIFETIME_MS = 60 * 60 * 1000;
const TOKEN_MIN_REUSE_MS = 30 * 1000;

async function fetchWithin(fetchImpl, url, init, ms) {
  if (!(ms > 0)) return { timedOut: true };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  timer.unref?.();
  try {
    // NEVER follow a redirect: a 307/308 would replay the body (the client secret) or the bearer token elsewhere.
    const res = await fetchImpl(url, { ...init, redirect: "error", signal: ac.signal });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  } catch (err) {
    return ac.signal.aborted ? { timedOut: true } : { error: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Every object in a tool answer (MCP content text or structuredContent) whose `id` is a Shopify variant gid. */
function variantObjectsOf(body) {
  const out = [];
  const seen = new Set();
  const walk = (x, depth) => {
    if (depth > 12 || x === null || typeof x !== "object" || seen.has(x)) return;
    seen.add(x);
    if (Array.isArray(x)) { for (const v of x) walk(v, depth + 1); return; }
    if (typeof x.id === "string" && x.id.startsWith("gid://shopify/ProductVariant/")) out.push(x);
    for (const v of Object.values(x)) {
      if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) {
        try { walk(JSON.parse(v), depth + 1); } catch { /* not JSON */ }
      } else walk(v, depth + 1);
    }
  };
  walk(body, 0);
  return out;
}

/** The message codes of a tool answer (e.g. `unauthorized` when the catalog cannot verify enrollment). */
function messageCodesOf(body) {
  const codes = [];
  const walk = (x, depth) => {
    if (depth > 12 || x === null || typeof x !== "object") return;
    if (Array.isArray(x)) { for (const v of x) walk(v, depth + 1); return; }
    if (Array.isArray(x.messages)) for (const m of x.messages) if (isPlainObject(m) && typeof m.code === "string") codes.push(m.code);
    for (const v of Object.values(x)) {
      if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) {
        try { walk(JSON.parse(v), depth + 1); } catch { /* not JSON */ }
      } else walk(v, depth + 1);
    }
  };
  walk(body, 0);
  return codes;
}

// Per-process outcome counts (the metric this lane is judged by): `tracked`, `untracked`, `skipped:<reason>`,
// `failed:<reason>`. Read through attributionOutcomes(); reset only by tests.
const outcomes = new Map();
const count = (k, n = 1) => outcomes.set(k, (outcomes.get(k) || 0) + n);
export function attributionOutcomes() { return Object.fromEntries(outcomes); }
export function resetAttributionOutcomes() { outcomes.clear(); }

/**
 * The client. One per process by default (defaultCatalogAttribution); tests build their own with a fake fetch.
 *   lookupTracked(gids, { market, sellerHost, budgetMs, log }) -> { tracked: Map<bareGid, trackedId>, reason }
 * `tracked` holds only ids that passed isTrackedIdFor. `reason` is null when the lookup answered, else why not.
 */
export function createCatalogAttribution({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let token = null; // { value, refreshAtMs }
  let inflight = null;
  let failedUntilMs = 0;
  let consecutiveFailures = 0;
  let breakerOpenUntilMs = 0;

  async function bearer(budgetMs) {
    if (token && now() < token.refreshAtMs) return token.value;
    if (now() < failedUntilMs) return null;
    if (!inflight) {
      const clientId = str(env.SHOPIFY_CATALOG_CLIENT_ID);
      const clientSecret = str(env.SHOPIFY_CATALOG_CLIENT_SECRET);
      if (!clientId || !clientSecret) return null;
      inflight = (async () => {
        const res = await fetchWithin(fetchImpl, TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
        }, TOKEN_EXCHANGE_TIMEOUT_MS);
        const value = res && res.status === 200 && isPlainObject(res.body) ? str(res.body.access_token) : null;
        if (!value) { failedUntilMs = now() + TOKEN_FAILURE_BACKOFF_MS; return null; }
        const t = now();
        const exp = jwtExpiryMs(value);
        // An already expired token is not used. Its life is capped at an hour whatever it claims; with no readable
        // expiry it is trusted for 50 minutes.
        if (exp !== null && exp <= t) { failedUntilMs = t + TOKEN_FAILURE_BACKOFF_MS; return null; }
        const lifetimeEnd = Math.min(exp !== null ? exp : t + TOKEN_FALLBACK_TTL_MS, t + TOKEN_MAX_LIFETIME_MS);
        // Refreshed 5 minutes early. A token that expires sooner than that is reused for a short while (half its
        // remaining life, at most 30 s) instead of being exchanged again on every call.
        const early = lifetimeEnd - TOKEN_REFRESH_SKEW_MS;
        token = { value, refreshAtMs: early > t ? early : t + Math.min(TOKEN_MIN_REUSE_MS, Math.floor((lifetimeEnd - t) / 2)) };
        return value;
      })().finally(() => { inflight = null; });
    }
    // The exchange runs on its own timeout; this call waits only as long as its own budget allows.
    const raced = await Promise.race([inflight, new Promise((r) => { const t = setTimeout(() => r(undefined), Math.max(0, budgetMs)); t.unref?.(); })]);
    return typeof raced === "string" ? raced : null;
  }

  async function lookupTracked(gids, { market, sellerHost, budgetMs = ATTRIBUTION_BUDGET_MS } = {}) {
    const tracked = new Map();
    const done = (reason) => { if (reason) count(reason); return { tracked, reason }; };
    if (!ATTRIBUTION_MARKETS.has(String(market || ""))) return done("skipped:market");
    const catalogId = str(env.SHOPIFY_CATALOG_ID);
    const profile = str(env.SHOPIFY_CATALOG_DRAFT_PROFILE_URL);
    if (!catalogId || !profile || !/^https:\/\//.test(profile)) return done("skipped:not_configured");
    const numbers = new Map();
    for (const g of Array.isArray(gids) ? gids : []) { const n = bareVariantNumber(g); if (n) numbers.set(g, n); }
    if (!numbers.size) return done("skipped:no_variant");
    if (!sellerHost) return done("skipped:no_store");
    if (!(budgetMs > 0)) return done("skipped:no_budget");
    if (now() < breakerOpenUntilMs) return done("skipped:breaker");
    const startedAt = now();
    const left = () => budgetMs - (now() - startedAt);
    const value = await bearer(left());
    if (!value) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= BREAKER_FAILURES) { breakerOpenUntilMs = now() + BREAKER_OPEN_MS; consecutiveFailures = 0; count("breaker:opened"); }
      return done("failed:no_token");
    }
    const ids = [...numbers.keys()];
    const batches = [];
    for (let i = 0; i < ids.length; i += LOOKUP_BATCH) batches.push(ids.slice(i, i + LOOKUP_BATCH));
    const answers = await Promise.all(batches.map((batch) => fetchWithin(fetchImpl, CATALOG_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${value}` },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "lookup_catalog", arguments: {
          meta: { "ucp-agent": { profile } },
          catalog: { ids: batch, catalog_id: catalogId, context: { address_country: market, currency: "USD" } },
        } },
      }),
    }, left())));
    let failure = null;
    let answered = 0;
    for (const a of answers) {
      if (!a || a.timedOut) { failure = failure || "failed:timeout"; continue; }
      if (a.error) { failure = failure || "failed:network"; continue; }
      if (a.status === 429) { failure = failure || "failed:rate_limited"; continue; }
      // The catalog no longer accepts this token: drop it, so the next call exchanges a fresh one.
      if (a.status === 401 || a.status === 403) { if (token && token.value === value) token = null; failure = failure || "failed:token_refused"; continue; }
      if (a.status !== 200 || !isPlainObject(a.body)) { failure = failure || "failed:http"; continue; }
      if (messageCodesOf(a.body).includes("unauthorized")) { failure = failure || "failed:unauthorized"; continue; }
      answered += 1;
      for (const v of variantObjectsOf(a.body)) {
        const n = (/^gid:\/\/shopify\/ProductVariant\/(\d{1,20})/.exec(v.id) || [])[1];
        for (const [g, want] of numbers) {
          if (want === n && !tracked.has(g) && isTrackedIdFor(v.id, want, catalogId)) tracked.set(g, v.id);
        }
      }
    }
    // The match rate counts only answered lookups: a failure is counted under its own reason, never as "untracked".
    if (failure) count(failure);
    if (failure && !answered) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= BREAKER_FAILURES) { breakerOpenUntilMs = now() + BREAKER_OPEN_MS; consecutiveFailures = 0; count("breaker:opened"); }
    } else if (answered) consecutiveFailures = 0;
    count("tracked", tracked.size);
    if (answered) count("untracked", Math.max(0, numbers.size - tracked.size));
    return { tracked, reason: failure };
  }

  return { lookupTracked };
}

let defaultClient = null;
/**
 * The process's client (its token cache and breaker are per process). Its fetch is read per call from
 * globalThis.fetch, so it never holds on to the fetch of whoever created it first.
 */
export function defaultCatalogAttribution() {
  if (!defaultClient) defaultClient = createCatalogAttribution({ fetchImpl: (...a) => globalThis.fetch(...a) });
  return defaultClient;
}
/** Tests only: forget the process client (its token, backoff and breaker). */
export function resetDefaultCatalogAttribution() { defaultClient = null; }
