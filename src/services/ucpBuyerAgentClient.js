'use strict';

/*
 * Pivota OUTBOUND UCP buyer-agent client.
 *
 * This is the buyer/agent side that DID NOT EXIST before this change — the repo only had the SELLER surface
 * (`safety-kernel/src/protocol/ucpProfile.js`, `/.well-known/ucp`, the ACP REST doors). Here Pivota acts as a
 * shopping agent that calls ANOTHER merchant's UCP MCP endpoint to search the catalog, build a cart, and
 * create a checkout — then STOPS, handing the shopper off to the merchant's own storefront checkout URL.
 *
 * Grounded in the live docs (fetched 2026-07-13):
 *   - shopify.dev/docs/agents/carts-and-checkout — tools: `get_product` (catalog), `create_cart`/`get_cart`/
 *     `update_cart`/`cancel_cart`, `create_checkout`/`get_checkout`/`update_checkout`/`cancel_checkout`, and
 *     `complete_checkout` (which THIS client never calls). Cart tools accept unauthenticated requests;
 *     checkout tools require auth or a signed request. Non-terminal checkout states carry a `continue_url`
 *     that hands the buyer to the merchant's storefront.
 *   - ucp.dev/2026-04-08/specification/cart-mcp — the MCP endpoint is discovered from the target business
 *     profile at `<business>/.well-known/ucp` (`services...endpoint`, e.g. "https://business.example.com/ucp/mcp").
 *     Every request carries `meta["ucp-agent"].profile` = the agent's hosted profile URL.
 *   - shopify.dev/docs/agents/profiles/auth-and-rate-limiting — trust tiers: ANONYMOUS (no auth header),
 *     SIGNED (RFC 9421 / ECDSA P-256 HTTP Message Signatures; pubkey in the agent profile — "No registration
 *     required", self-generated key), TOKEN (`Authorization: Bearer <jwt>` from the Dev Dashboard). Higher tiers
 *     unlock more; `complete_checkout` is trust-tier gated (TOKEN-only) and this client NEVER calls it at any tier.
 *
 * SIGNED-TIER SIGNATURE CONSTRUCTION (ucp.dev/2026-04-08/specification/signatures, fetched 2026-07-13):
 *   - Signature base covered components, in order (POST with body + idempotency): "@method" "@authority"
 *     "@path" ["@query" if present] "ucp-agent" "idempotency-key" "content-digest" "content-type".
 *   - Content-Digest: RFC 9530 `sha-256=:<base64(sha256(body))>:` — MUST be sha-256.
 *   - Signature-Input: `sig1=(<components>);created=<ts>;expires=<ts>;keyid="<jwk kid>"`. NO `alg` param — the
 *     algorithm is derived from the key's JWK `crv` (P-256 => ecdsa-p256-sha256).
 *   - Signature: `sig1=:<base64(raw r||s)>:` — ECDSA MUST be fixed-width raw r||s (IEEE P1363), NOT ASN.1/DER.
 *   - keyid matches a JWK `kid` published in our profile's `ucp.signing_keys`.
 *   - `ucp-agent` and `idempotency-key` are carried in the JSON-RPC `meta` (MCP requirement) AND mirrored as
 *     covered HTTP headers so the signature binds them; the body itself is bound via content-digest.
 *
 * HARD SAFETY BOUNDS (enforced in code, not just convention):
 *   - There is NO method that calls `complete_checkout`, submits payment, or opens/fetches a handoff URL.
 *     `refuseCompleteCheckout()` returns a hard refusal object and performs no network call.
 *   - Credentials AND the signing PRIVATE key come from ENV ONLY (never hardcoded). Neither value is ever
 *     logged/printed/returned; only booleans "present" and the derived tier are exposed via `describeTier()`.
 *   - Framework-agnostic: pure module using the global `fetch` (Node >= 18); `fetchImpl` is injectable for tests.
 */

const nodeCrypto = require('node:crypto');
const nodeDns = require('node:dns');
const nodeHttps = require('node:https');
const nodeNet = require('node:net');
const {
  buildUcpBuyerAgentProfile,
  DEFAULT_UCP_VERSION,
} = require('./ucpBuyerAgentProfile');

// MCP tool names (verbatim from the live spec). complete_checkout is listed for the refusal guard ONLY.
const TOOL = Object.freeze({
  GET_PRODUCT: 'get_product',
  // `search_catalog` is a DISTINCT tool from `get_product` — free text vs one id — and this client used to
  // send a `query` to the latter, which has no such member. Both names are verbatim from a live `tools/list`
  // (cosrx, 2026-08-13). `lookup_catalog` (batch by `catalog.ids`) exists there too and is deliberately not
  // listed: nothing here calls it, and an unused constant is a shape nobody has verified against a caller.
  SEARCH_CATALOG: 'search_catalog',
  CREATE_CART: 'create_cart',
  GET_CART: 'get_cart',
  CREATE_CHECKOUT: 'create_checkout',
  UPDATE_CHECKOUT: 'update_checkout',
  GET_CHECKOUT: 'get_checkout',
  COMPLETE_CHECKOUT: 'complete_checkout', // NEVER invoked by this client.
});

// READ-ONLY / idempotent tools that MAY be retried on a transient error. Everything else (create/update cart &
// checkout) is state-changing and must never be blind-retried.
const IDEMPOTENT_TOOLS = Object.freeze(new Set([
  TOOL.GET_PRODUCT, TOOL.SEARCH_CATALOG, TOOL.GET_CART, TOOL.GET_CHECKOUT,
]));

// H1 error taxonomy — canonical fallback reasons. EVERY warm-handoff failure maps to one of these, then to a
// clean null (cold-redirect fallback), tagged for observability (H2). No reason carries buyer PII or key material.
const FAILURE_REASON = Object.freeze({
  PROFILE_UNREACHABLE: 'profile_unreachable', // discovery threw a network/DNS error
  PROFILE_REDIRECTED: 'profile_redirected', // discovery got a 3xx: refused (UCP MUST NOT follow), a merchant misconfiguration
  NOT_UCP_REACHABLE: 'not_ucp_reachable', // discovery succeeded but the brand exposes no UCP MCP endpoint
  TIMEOUT: 'timeout', // a per-call timeout (AbortError) or the total handoff budget was exceeded
  OUT_OF_STOCK: 'out_of_stock', // product-state: sold out / no inventory / not available for sale
  VARIANT_INVALID: 'variant_invalid', // product-state: variant not found / discontinued / bad id
  TOOL_ERROR: 'tool_error', // a generic MCP tool / 5xx failure
  INVALID_INPUT: 'invalid_input', // schema / missing-argument rejection
  NO_CONTINUE_URL: 'no_continue_url', // cart built but carried no storefront handoff URL
  UNKNOWN: 'unknown',
});

// SYNTHETIC, clearly-fake US shipping address used ONLY to fetch shipping/tax quotes for the in-chat priced
// preview. This is NOT a real person and carries NO real buyer PII — it exists solely so create_checkout can
// compute shipping options + tax before the shopper decides. The street literally says "SAMPLE".
const SYNTHETIC_PREVIEW_ADDRESS = Object.freeze({
  first_name: 'Preview',
  last_name: 'Sample',
  address1: '1 SAMPLE PREVIEW ADDRESS',
  address2: '',
  city: 'San Francisco',
  province: 'CA',
  province_code: 'CA',
  country: 'United States',
  country_code: 'US',
  zip: '94105',
  phone: '+10000000000',
});
// A synthetic contact email for the same preview-only purpose (no real buyer inbox).
const SYNTHETIC_PREVIEW_EMAIL = 'preview-sample@example.com';

const TRUST_TIER = Object.freeze({
  ANONYMOUS: 'anonymous',
  SIGNED: 'signed',
  TOKEN: 'token',
});

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function normalizeBaseUrl(u, field) {
  const s = firstNonEmpty(u);
  if (!s) throw new Error(`${field} is required`);
  let parsed;
  try { parsed = new URL(s); } catch { throw new Error(`${field} must be a valid URL: ${s}`); }
  if (parsed.protocol !== 'https:') throw new Error(`${field} must be https: ${s}`);
  // No userinfo, and this branch deliberately does NOT echo the URL: the thing being refused is the
  // credential in it, and these messages flow into warm-handoff logs. (fetch would refuse it too, but with
  // the full URL in its TypeError.) A merchant-advertised endpoint or a configured base URL has no business
  // carrying credentials.
  if (parsed.username || parsed.password) throw new Error(`${field} must not contain userinfo`);
  return parsed;
}

function ipv4Number(address) {
  return address.split('.').reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0;
}

function inIpv4Range(address, base, prefix) {
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

function ipv6Value(address) {
  const raw = String(address || '').toLowerCase();
  const [leftRaw, rightRaw] = raw.split('::');
  if (raw.split('::').length > 2) throw new Error('invalid IPv6 address');
  const expand = (part) => (part ? part.split(':').filter(Boolean) : []).flatMap((piece) => {
    if (piece.includes('.')) {
      if (nodeNet.isIP(piece) !== 4) throw new Error('invalid embedded IPv4');
      const value = ipv4Number(piece);
      return [((value >>> 16) & 0xffff).toString(16), (value & 0xffff).toString(16)];
    }
    return [piece];
  });
  const left = expand(leftRaw);
  const right = expand(rightRaw);
  const missing = 8 - left.length - right.length;
  const groups = raw.includes('::')
    ? [...left, ...Array(Math.max(0, missing)).fill('0'), ...right]
    : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    throw new Error('invalid IPv6 address');
  }
  return groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group}`), 0n);
}

function inIpv6Range(value, base, prefix) {
  const baseValue = ipv6Value(base);
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (baseValue >> shift);
}

/** Reject addresses that must never be reachable through merchant-controlled URLs. */
// A refusal that says which refusal it was. Without a code every in-house
// rejection here — the SSRF guard, a refused redirect, the size cap, an
// unsupported status — reaches the probe as a bare Error and is recorded
// identically as `threw=unknown`, the same collapse of distinct causes that
// made the probe's reason string unreadable in the first place. The PIVOTA_
// prefix keeps them apart from libuv's errno codes, which share this field.
function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isForbiddenNetworkAddress(address) {
  const raw = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  const family = nodeNet.isIP(raw);
  if (family === 4) {
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
      ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
      ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4],
      // 240.0.0.0/4 is reserved ("Class E") and includes the limited-broadcast
      // address 255.255.255.255/32, listed explicitly for auditability.
      ['240.0.0.0', 4], ['255.255.255.255', 32],
    ].some(([base, prefix]) => inIpv4Range(raw, base, prefix));
  }
  if (family === 6) {
    try {
      const value = ipv6Value(raw);
      return [
        ['::', 128], ['::1', 128],
        // IPv4-compatible and mapped forms are never valid merchant origins.
        ['::', 96], ['::ffff:0:0', 96],
        ['64:ff9b::', 96], ['100::', 64],
        ['2001:db8::', 32], ['2001:2::', 48],
        ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
      ].some(([base, prefix]) => inIpv6Range(value, base, prefix));
    } catch {
      return true;
    }
  }
  return true; // Unknown address family fails closed.
}

function createPublicOnlyLookup(lookup = nodeDns.lookup) {
  return (hostname, options, callback) => {
    // Node's socket layer calls a custom lookup in TWO shapes: legacy
    // (hostname, callback) and (hostname, options, callback). Since Node 20,
    // autoSelectFamily (default ON) passes { all: true } and expects an ARRAY
    // of { address, family } records back — answering the legacy single-address
    // shape there fails every connection with "Invalid IP address: undefined".
    const cb = typeof options === 'function' ? options : callback;
    const opts = (typeof options === 'function' || !options) ? {} : options;
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return cb(error);
      const records = Array.isArray(addresses) ? addresses : [];
      // Reject mixed answers too. Falling back from a public address to a
      // private one after a connection failure is a common SSRF bypass.
      if (!records.length || records.some((entry) => isForbiddenNetworkAddress(entry.address))) {
        return cb(codedError('merchant endpoint resolved to a non-public address', 'PIVOTA_SSRF_REFUSED'));
      }
      if (opts.all) {
        return cb(null, records.map(({ address, family }) => ({ address, family })));
      }
      // SINGLE-ADDRESS SHAPE, WHICH HAS NO FALLBACK. Whichever record we return
      // decides the request outright. `verbatim: true` keeps the resolver's
      // order, commonly AAAA first for a dual-stack merchant — and on a host
      // with no IPv6 route that connect answers ENETUNREACH with no second
      // attempt, because Happy Eyeballs is what normally rescues it and is not
      // in play here. The store-audit crawl subnet is exactly such a host
      // (measured 2026-09-04: v6 connect => ENETUNREACH, v4 fine).
      //
      // Node uses this shape only when autoSelectFamily is OFF — an older
      // runtime, --no-network-family-autoselection, or
      // net.setDefaultAutoSelectFamily(false) — so this is a LATENT failure,
      // invisible until someone changes that flag, at which point every
      // dual-stack merchant drops out at once on a subnet where v6 is dead.
      //
      // Preferring IPv4 is not a claim that v6 is worse; it is that a branch
      // which cannot retry should pick the family routable from the widest set
      // of hosts we run on. A v6-only answer still returns v6 — filtering to
      // nothing would turn a reachable merchant into a resolution failure — and
      // the mixed public/private refusal above still runs first, so this cannot
      // become the private-address fallback that guard exists to stop.
      const preferred = records.find((entry) => entry.family === 4) || records[0];
      return cb(null, preferred.address, preferred.family);
    });
  };
}

// Response bodies from merchant-controlled origins are bounded so a probed
// endpoint cannot balloon this process's memory.
const MAX_MERCHANT_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Map a raw node HTTP response (status, headers, buffered body) onto a WHATWG
 * Response. Pure and exported so the null-body edge cases are testable without
 * a socket: `new Response(body, { status })` THROWS for 1xx (RangeError) and
 * for the null-body statuses 204/205/304 (TypeError) — inside an 'end' event
 * callback that would be an uncaught exception, i.e. a merchant-triggerable
 * process crash.
 */
function toFetchResponse(statusCode, headers, bodyBuffer) {
  const status = Number(statusCode) || 0;
  if (status < 200) {
    throw codedError(`merchant endpoint returned an unsupported status ${status}`, 'PIVOTA_UNSUPPORTED_STATUS');
  }
  if (status === 204 || status === 205 || status === 304) {
    return new Response(null, { status, headers });
  }
  return new Response(bodyBuffer, { status, headers });
}

function createPublicNetworkFetch(lookup) {
  const publicOnlyLookup = createPublicOnlyLookup(lookup);
  return (url, options = {}) => new Promise((resolve, reject) => {
    const parsed = normalizeBaseUrl(url, 'merchantEndpoint');
    if (nodeNet.isIP(parsed.hostname) && isForbiddenNetworkAddress(parsed.hostname)) {
      reject(codedError('merchant endpoint must resolve to a public address', 'PIVOTA_SSRF_LITERAL'));
      return;
    }
    const request = nodeHttps.request(parsed, {
      method: options.method || 'GET',
      headers: options.headers,
      lookup: publicOnlyLookup,
    }, (response) => {
      if (options.redirect === 'error' && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        reject(codedError('merchant endpoint redirected', 'PIVOTA_REDIRECT_REFUSED'));
        return;
      }
      const chunks = [];
      let receivedBytes = 0;
      response.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_MERCHANT_RESPONSE_BYTES) {
          const error = codedError('merchant endpoint response exceeded the size cap', 'PIVOTA_SIZE_CAP');
          reject(error);
          request.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve(toFetchResponse(response.statusCode, response.headers, Buffer.concat(chunks)));
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    });
    request.once('error', reject);
    const onAbort = () => {
      const error = new Error('merchant endpoint request aborted');
      error.name = 'AbortError';
      request.destroy(error);
    };
    if (options.signal) {
      if (options.signal.aborted) return onAbort();
      options.signal.addEventListener('abort', onAbort, { once: true });
      request.once('close', () => options.signal.removeEventListener('abort', onAbort));
    }
    if (options.body) request.write(options.body);
    request.end();
  });
}

/**
 * Create a UCP buyer-agent client.
 * @param {{
 *   credential?: string,        // JWT/token for the TOKEN tier. Defaults to env UCP_AGENT_CREDENTIAL. Never logged.
 *   forceAnonymous?: boolean,   // ignore all credential/signing env so an audit probe cannot escalate trust tier.
 *   profileUrl?: string,        // agent profile HTTPS URL the MERCHANT will FETCH. Defaults to env
 *                               // UCP_AGENT_PROFILE_URL, else `${UCP_BASE_URL}/.well-known/ucp-agent`.
 *                               // Never defaulted to an invented host — see the note at its resolution.
 *   ucpVersion?: string,
 *   fetchImpl?: Function,       // injectable fetch (default: global fetch). Tests pass a fixture fetch.
 *   userAgent?: string,
 *   timeoutMs?: number,
 * }} [options]
 */
function createUcpBuyerAgentClient(options = {}) {
  // Store Audit probes must be able to prove they are anonymous even in a
  // gateway process that has token/signing credentials configured for another
  // workload. This is a hard mode, not a best-effort preference: it ignores
  // every credential source below while retaining the buyer profile pointer.
  const forceAnonymous = options.forceAnonymous === true;
  // Merchant profiles choose both the storefront origin and the MCP endpoint.
  // Pin each connection through a resolver that refuses private/local ranges,
  // so DNS rebinding cannot pivot this crawl workload into the VPC.
  const merchantFetch = options.merchantFetchImpl
    // Test fakes never reach the network. Production uses the pinned HTTPS
    // transport rather than global fetch, whose DNS lookup cannot be bound.
    || (typeof options.fetchImpl === 'function'
      ? options.fetchImpl
      : createPublicNetworkFetch(options.dnsLookup || nodeDns.lookup));
  const credential = forceAnonymous
    ? undefined
    : firstNonEmpty(options.credential, process.env.UCP_AGENT_CREDENTIAL);
  // TOKEN tier via SELF-SERVE client-credential exchange (Shopify Dev Dashboard flow, verified 2026-07-13 from
  // shopify.dev/docs/agents/get-started/authentication): POST { client_id, client_secret,
  // grant_type:"client_credentials" } to the token endpoint -> a short-lived (60-min) JWT that feeds the
  // EXISTING Bearer token-tier path. The client_id/secret are env-only and NEVER logged; the minted JWT is
  // cached and refreshed before expiry and never logged either. A static `credential` (UCP_AGENT_CREDENTIAL)
  // still wins and short-circuits the exchange (existing behavior unchanged).
  const clientId = forceAnonymous
    ? undefined
    : firstNonEmpty(options.clientId, process.env.UCP_AGENT_CLIENT_ID);
  const clientSecret = forceAnonymous
    ? undefined
    : firstNonEmpty(options.clientSecret, process.env.UCP_AGENT_CLIENT_SECRET);
  const hasClientCredentials = Boolean(clientId && clientSecret);
  const tokenEndpoint = firstNonEmpty(
    options.tokenEndpoint,
    process.env.UCP_AGENT_TOKEN_ENDPOINT,
    'https://api.shopify.com/auth/access_token',
  );
  // Refresh the minted JWT this many ms BEFORE its stated expiry (default 5 min) so an in-flight request never
  // races the 60-min TTL boundary.
  const tokenRefreshSkewMs = Number.isFinite(options.tokenRefreshSkewMs)
    ? Number(options.tokenRefreshSkewMs)
    : 5 * 60 * 1000;
  // THE AGENT PROFILE POINTER IS FETCHED BY THE MERCHANT, so it must be a URL that actually serves this
  // agent's profile. It is resolved from CONFIGURATION only and never invented.
  //
  // What was wrong: the last resort here was the literal `https://agent.pivota.cc/.well-known/ucp-agent`.
  // agent.pivota.cc is the FRONTEND web app (see DEVELOPMENT_COMPLETE_REPORT.md / PROJECT_COMPLETION_SUMMARY.md),
  // not this gateway — it answers that path with the Next.js 404 page. So in any environment where
  // UCP_AGENT_PROFILE_URL was unset, every outbound UCP call handed the merchant a pointer that could not
  // resolve, and the merchant refused the whole call before looking at its arguments. Live-verified
  // 2026-08-13: a UCP endpoint answers `422 / -32001 { code: 'profile_unreachable' }` and nothing else runs.
  // Production happens to set the env var, which is exactly why this stayed invisible.
  //
  // The remaining fallback derives from the gateway's OWN configured origin — the same chain the seller
  // profile resolves (src/server.js getCommerceUcpRouteHandlers: UCP_BASE_URL -> AGENT_CHECKOUT_UCP_BASE_URL
  // -> the origin of MCP_OAUTH_RESOURCE). If nothing is configured the pointer stays ABSENT rather than
  // wrong: a merchant then names the missing field, which is a far more actionable failure than chasing a
  // 404 on a host that was never this service.
  //
  // AND IT IS GATED ON THE ROUTE ACTUALLY BEING LIT, because the origin alone does not tell us that.
  // Deriving from an origin says "this gateway is reachable here"; it does NOT say `/.well-known/ucp-agent`
  // answers there. That route is its own door (src/server.js registerUcpBuyerAgentProfileRoute) behind
  // UCP_BUYER_AGENT_PROFILE_ENABLED, default OFF — whereas UCP_BASE_URL gates a DIFFERENT door (the seller
  // profile, under AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED). An environment that sets UCP_BASE_URL for the
  // seller surface and leaves the buyer door dark is the DEFAULT state, and precisely the cohort this fix
  // exists for; ungated, it would derive a pointer that 404s on our OWN host — the same failure one hostname
  // over, while reporting success. A derived URL is only honest if the route behind it is serving.
  //
  // The flag is read in THIS process, which assumes the client and the profile route deploy together — true
  // of this gateway (one service, both mounted in src/server.js). If they are ever split, set
  // UCP_AGENT_PROFILE_URL explicitly: the explicit value is deliberately NOT gated, so an operator can
  // always name a URL served elsewhere.
  const buyerProfileDoorLit = ['1', 'true', 'on', 'yes']
    .includes(String(process.env.UCP_BUYER_AGENT_PROFILE_ENABLED || '').trim().toLowerCase());
  const derivableOrigins = [
    process.env.UCP_BASE_URL,
    process.env.AGENT_CHECKOUT_UCP_BASE_URL,
    process.env.MCP_OAUTH_RESOURCE,
  ];
  const profileUrl = firstNonEmpty(
    options.profileUrl,
    process.env.UCP_AGENT_PROFILE_URL,
    ...(buyerProfileDoorLit ? derivableOrigins.map(agentProfileUrlFromOrigin) : []),
  );
  // Which configured origins were REFUSED for naming generated infrastructure. A refusal is otherwise
  // completely silent — the operator's only symptom is a missing JSON field or, at the SIGNED tier, a throw
  // at call time. Recorded here so the throw can name the real cause, and warned once at construction so the
  // cause appears in logs BEFORE the first failed call rather than after it.
  const refusedInfraOrigins = profileUrl ? [] : derivableOrigins
    .filter((o) => typeof o === 'string' && o.trim() && isGeneratedInfraHost(safeHostnameOf(o)));
  if (refusedInfraOrigins.length && typeof options.logger?.warn === 'function') {
    options.logger.warn(
      { surface: 'ucp_buyer_agent', refused_origins: refusedInfraOrigins },
      'ucpBuyerAgentClient: refusing to derive an agent profile URL from a PaaS-generated host; '
      + 'set UCP_AGENT_PROFILE_URL to a branded URL. The profile pointer will be omitted.',
    );
  }
  const ucpVersion = firstNonEmpty(options.ucpVersion, process.env.UCP_AGENT_VERSION, DEFAULT_UCP_VERSION);
  const fetchImpl = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const userAgent = firstNonEmpty(options.userAgent, 'Pivota-UCP-BuyerAgent/1.0');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 15000;
  const signatureTtlSec = Number.isFinite(options.signatureTtlSec) ? Number(options.signatureTtlSec) : 300;

  // H1 resilience: bounded jittered-backoff retry applied ONLY to idempotent GET-shaped calls (well-known
  // discovery, tools/list, catalog get_product). Mutating cart/checkout POSTs are NEVER retried (default
  // retry=false on callTool) so we can't double-submit a state change. `retryAttempts` = extra attempts after
  // the first (so total tries = retryAttempts + 1). Set retryAttempts=0 to disable. A per-call timeout still
  // bounds every individual attempt.
  const retryAttempts = Number.isFinite(options.retryAttempts) ? Math.max(0, Number(options.retryAttempts)) : 2;
  const retryBaseDelayMs = Number.isFinite(options.retryBaseDelayMs) ? Math.max(0, Number(options.retryBaseDelayMs)) : 150;
  const retryMaxDelayMs = Number.isFinite(options.retryMaxDelayMs) ? Math.max(0, Number(options.retryMaxDelayMs)) : 2000;
  // Injectable sleep so tests don't wait on real timers.
  const sleepImpl = typeof options.sleepImpl === 'function'
    ? options.sleepImpl
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // SIGNED tier: load our OWN ECDSA P-256 private key from env ONLY (PEM or JWK). Never logged. The public half
  // lives in the hosted profile's `ucp.signing_keys`; `keyid` must match its JWK `kid`.
  const signingPrivateRaw = forceAnonymous
    ? undefined
    : firstNonEmpty(options.signingPrivateKey, process.env.UCP_AGENT_SIGNING_PRIVATE_KEY);
  let signingKeyObject;
  let signingKeyId;
  if (signingPrivateRaw) {
    const loaded = loadSigningPrivateKey(signingPrivateRaw);
    signingKeyObject = loaded.keyObject;
    signingKeyId = firstNonEmpty(options.signingKeyId, process.env.UCP_AGENT_SIGNING_KEY_ID, loaded.kid);
    if (!signingKeyId) {
      throw new Error('UCP signing key present but no keyid — set UCP_AGENT_SIGNING_KEY_ID or embed "kid" in the JWK.');
    }
  }
  const canSign = Boolean(signingKeyObject);
  // Optional explicit public JWK(s) to publish in the profile (else the profile module reads env). Never private.
  const signingKeysToPublish = Array.isArray(options.signingKeys) ? options.signingKeys : undefined;

  // Trust tier is derived by descending capability: TOKEN (a static Bearer token OR self-serve client
  // credentials we can exchange for one) beats a signing key (SIGNED) beats nothing (ANONYMOUS).
  // complete_checkout is refused at ALL of them by this client.
  const hasTokenTierCredential = Boolean(credential) || hasClientCredentials;
  const tier = hasTokenTierCredential
    ? TRUST_TIER.TOKEN
    : (canSign ? TRUST_TIER.SIGNED : TRUST_TIER.ANONYMOUS);

  // Cached minted JWT from the client-credential exchange: { token, expiresAt(ms) }. Never logged.
  let tokenCache = null;

  /**
   * Exchange client_id/client_secret for a short-lived JWT (client_credentials grant). Caches with a refresh
   * skew. NEVER logs/returns the secret or the JWT; on failure throws an error that carries only the HTTP
   * status (no credential material).
   */
  // Diagnostic view of the token endpoint (describeTier / verifyTokenTier / the probe script). Never the raw
  // configured string: it is operator-set and may carry userinfo, and those surfaces print. origin + path
  // only -- enough to see WHERE the exchange goes, never a credential that was (wrongly) put in the URL.
  // Returns undefined when the value does not parse, so a broken config is visible as absence, not echoed.
  function tokenEndpointForDisplay() {
    if (!hasClientCredentials) return undefined;
    let u;
    try { u = new URL(String(tokenEndpoint)); } catch { return undefined; }
    return `${u.origin}${u.pathname}`;
  }

  async function exchangeClientCredentials() {
    // The token endpoint is operator-configured (UCP_AGENT_TOKEN_ENDPOINT) and receives the CLIENT SECRET in
    // the request body, yet was previously not validated at all — an `http://` typo would post the secret
    // in plaintext, and userinfo would put it in a fetch TypeError. Validate here, at the moment the secret
    // would be sent (a client with no client-credentials never gets this far, so a bad default is inert),
    // and throw the same opaque, status-free shape as the failure below: never the URL, never the secret.
    let tokenUrl;
    try { tokenUrl = normalizeBaseUrl(tokenEndpoint, 'tokenEndpoint'); } catch { tokenUrl = null; }
    if (!tokenUrl) {
      throw new Error('ucpBuyerAgentClient: token endpoint refused (must be an https URL without userinfo).');
    }
    const doFetch = requireFetch();
    const res = await withTimeout((signal) => doFetch(tokenUrl.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': userAgent,
      },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
      // NEVER follow a redirect on a credential-carrying request. This body holds the client secret, and a
      // 307/308 REPLAYS the body verbatim at the redirect target — measured on node 24: undici does strip the
      // `Authorization` header cross-origin, but the JSON body (and any `signature` header) go through
      // untouched. So a token endpoint that redirects — compromised, misconfigured, or fronted by a catch-all
      // rewrite — would hand the secret to whatever origin it names. Refuse instead: the exchange fails
      // (opaque, status-only error above) and no secret leaves for anywhere we did not resolve. Same rule as
      // the profile fetch in discoverEndpoint, for a stronger reason: that one protects what we TRUST, this
      // one protects what we HOLD.
      redirect: 'error',
      signal,
    }), timeoutMs);
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    const accessToken = parsed && firstNonEmpty(parsed.access_token, parsed.token);
    if (!res.ok || !accessToken) {
      // Deliberately opaque — never echo the request body or any credential/JWT into the error/logs.
      throw new Error(`ucpBuyerAgentClient: token-credential exchange failed (status ${res.status}).`);
    }
    const ttlSec = Number.isFinite(parsed.expires_in) && Number(parsed.expires_in) > 0
      ? Number(parsed.expires_in)
      : 3600; // Shopify's documented default is a 60-min TTL.
    tokenCache = { token: accessToken, expiresAt: Date.now() + ttlSec * 1000 };
    return accessToken;
  }

  /**
   * Resolve the Bearer token to attach for the TOKEN tier. A static credential wins verbatim (unchanged path);
   * otherwise the cached client-credential JWT is reused until it enters the refresh window, then re-minted.
   * Returns null when there is no token-tier credential at all (ANONYMOUS/SIGNED send no Authorization header).
   */
  async function resolveBearerToken() {
    if (credential) return credential;
    if (!hasClientCredentials) return null;
    const now = Date.now();
    if (tokenCache && now < tokenCache.expiresAt - tokenRefreshSkewMs) return tokenCache.token;
    return exchangeClientCredentials();
  }

  function requireFetch() {
    if (!fetchImpl) {
      throw new Error('No fetch implementation available (Node >= 18 required, or pass options.fetchImpl).');
    }
    return fetchImpl;
  }

  async function fetchMerchantEndpoint(url, options) {
    const parsed = normalizeBaseUrl(url, 'merchantEndpoint');
    if (nodeNet.isIP(parsed.hostname) && isForbiddenNetworkAddress(parsed.hostname)) {
      throw new Error('merchant endpoint must resolve to a public address');
    }
    return merchantFetch(parsed.toString(), options);
  }

  /**
   * Run a single bounded HTTP attempt (per-call timeout) with OPTIONAL jittered-backoff retry on TRANSIENT
   * failures — a thrown network/DNS error, or a 5xx response. Retries are gated by `retry` (true ONLY for
   * idempotent GET-shaped calls); a per-call TIMEOUT (AbortError) is NOT retried so a slow brand can't multiply
   * the latency budget. When `retry` is false this is byte-identical to a single `withTimeout(run, timeoutMs)`.
   * @param {(signal: AbortSignal|undefined) => Promise<Response>} run
   * @param {{ retry?: boolean }} [opts]
   */
  async function fetchWithPolicy(run, { retry = false } = {}) {
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await withTimeout(run, timeoutMs);
      } catch (err) {
        // AbortError = our own per-call timeout: do NOT retry (bounds total latency). Any other throw is a
        // network/DNS transient — retry idempotent calls with backoff.
        const isTimeout = err && err.name === 'AbortError';
        if (retry && !isTimeout && attempt < retryAttempts) {
          attempt += 1;
          await sleepImpl(backoffDelay(attempt, retryBaseDelayMs, retryMaxDelayMs));
          continue;
        }
        throw err;
      }
      // Transient server-side error on an idempotent call => backoff + retry.
      if (retry && res && Number(res.status) >= 500 && attempt < retryAttempts) {
        attempt += 1;
        await sleepImpl(backoffDelay(attempt, retryBaseDelayMs, retryMaxDelayMs));
        continue;
      }
      return res;
    }
  }

  // The UCP-agent profile pointer. Carried in JSON-RPC meta (MCP requirement) and, when signing, mirrored as a
  // structured-field HTTP header `ucp-agent: profile="<url>"` so the RFC 9421 signature can cover it.
  //
  // With no pointer configured `profile` is left OFF the object rather than set to `undefined`.
  //
  // BE PRECISE ABOUT WHAT THIS BUYS, because an earlier version of this note overstated it: for the JSON
  // body the two are indistinguishable — `JSON.stringify({profile: undefined})` is `{}` — so the meta path
  // never emitted the string "undefined" and this branch is defensive, not load-bearing. Note also that
  // `requestMeta` always sets the `ucp-agent` key, so the wire carries `"ucp-agent":{}`; it is `profile`
  // that is absent, not the envelope.
  //
  // Where it IS load-bearing is `ucpAgentHeaderValue` below: that one interpolates, so an absent pointer
  // there really did produce the literal string `profile="undefined"`.
  function ucpAgentMeta() {
    return profileUrl ? { profile: profileUrl } : {};
  }
  function ucpAgentHeaderValue() {
    return profileUrl ? `profile="${profileUrl}"` : undefined;
  }

  function requestMeta(idempotencyKey) {
    // Referenced on every UCP request so the merchant can fetch our capability profile for negotiation.
    const meta = { 'ucp-agent': ucpAgentMeta() };
    if (idempotencyKey) meta['idempotency-key'] = idempotencyKey;
    return meta;
  }

  function authHeaders(bearer) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': userAgent,
    };
    // TOKEN tier only. Never logged. ANONYMOUS/SIGNED send no Authorization header. `bearer` is the static
    // credential OR the freshly-minted client-credential JWT resolved by resolveBearerToken().
    if (tier === TRUST_TIER.TOKEN && bearer) headers.authorization = `Bearer ${bearer}`;
    return headers;
  }

  /**
   * The agent capability profile we publish/serve. Requests catalog+cart+checkout scopes, never completion.
   * Publishes our PUBLIC signing JWK(s) (from options.signingKeys or env) so SIGNED-tier verifiers can find them.
   */
  function buildProfile() {
    return buildUcpBuyerAgentProfile({ profileUrl, ucpVersion, signingKeys: signingKeysToPublish });
  }

  /**
   * Non-secret description of the negotiating identity: tier + whether a credential is present (boolean),
   * the requested scopes, and the profile URL. NEVER includes the credential value.
   */
  function describeTier() {
    const profile = buildProfile();
    return {
      tier,
      has_credential: Boolean(credential),
      // Self-serve client-credential exchange is configured (client_id + client_secret present). Boolean only —
      // the secret and the minted JWT are NEVER exposed.
      has_client_credentials: hasClientCredentials,
      // True when SOME token-tier credential is available (static token OR exchangeable client credentials).
      has_token_tier_credential: hasTokenTierCredential,
      token_endpoint: tokenEndpointForDisplay(),
      // Boolean only — the private key value is NEVER exposed.
      has_signing_key: canSign,
      signing_key_id: canSign ? signingKeyId : undefined,
      // `signing_keys` is a SIBLING of `ucp`, per spec — the `ucp` object carries protocol metadata only.
      // Both placements are read so this self-report is correct whichever shape the profile was built in.
      published_signing_key_ids: (profile.signing_keys || profile.ucp.signing_keys || [])
        .map((k) => k && k.kid).filter(Boolean),
      profile_url: profileUrl,
      ucp_version: ucpVersion,
      requested_scopes: profile.agent.requested_scopes,
      // SIGNED tier is now implemented (RFC 9421). complete_checkout is STILL refused at ALL tiers by this client.
      supports_signed_tier: canSign,
      completes_checkout: false,
    };
  }

  /**
   * H3 token-tier verification. Resolves (mints/refreshes) the Bearer token via the client-credentials exchange
   * and reports — with BOOLEANS ONLY — whether the client operates at TOKEN tier end-to-end. The token value and
   * the client_secret are NEVER returned or logged; only `token_present` (a boolean derived from a non-empty
   * resolved token) and the tier/config booleans are exposed. On a failed exchange it returns
   * { ok:false, error: <status-only message> } and still leaks no credential material.
   *
   * This performs the auth exchange only — it does NOT call a merchant tool and does NOT complete checkout.
   * @returns {Promise<{ ok:boolean, tier:string, has_credential:boolean, has_client_credentials:boolean,
   *   has_token_tier_credential:boolean, token_present:boolean, minted_via_exchange:boolean,
   *   token_endpoint?:string, error?:string }>}
   */
  async function verifyTokenTier() {
    const base = {
      tier,
      has_credential: Boolean(credential),
      has_client_credentials: hasClientCredentials,
      has_token_tier_credential: hasTokenTierCredential,
      token_endpoint: tokenEndpointForDisplay(),
    };
    if (tier !== TRUST_TIER.TOKEN) {
      return { ok: false, ...base, token_present: false, minted_via_exchange: false };
    }
    try {
      const token = await resolveBearerToken();
      return {
        ok: Boolean(token),
        ...base,
        // Boolean ONLY — never the token string.
        token_present: Boolean(token),
        // True when the token came from the client-credentials exchange (vs. a static UCP_AGENT_CREDENTIAL).
        minted_via_exchange: !credential && hasClientCredentials,
      };
    } catch (err) {
      // exchangeClientCredentials throws a status-only error (no credential/JWT). Pass its message through as-is.
      return { ok: false, ...base, token_present: false, minted_via_exchange: false, error: err && err.message };
    }
  }

  /**
   * Discover a target business's UCP MCP endpoint from its `/.well-known/ucp` profile.
   * @param {string} businessBaseUrl  https origin of the merchant storefront (e.g. https://cosrx.com)
   * @returns {Promise<{ mcpEndpoint: string|undefined, businessProfile: object, wellKnownUrl: string }>}
   */
  async function discoverEndpoint(businessBaseUrl) {
    const base = normalizeBaseUrl(businessBaseUrl, 'businessBaseUrl');
    const wellKnownUrl = new URL('/.well-known/ucp', base.origin).toString();
    // Idempotent GET: safe to retry transient network/5xx with backoff (H1).
    const res = await fetchWithPolicy((signal) => fetchMerchantEndpoint(wellKnownUrl, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': userAgent },
      // UCP 2026-04-08, "Profile Requirements" -> Hosting/Fetching: a profile endpoint MUST NOT use
      // redirects, and an implementation MUST NOT follow a 3xx when fetching one. This URL is an IDENTITY
      // ANCHOR: the MCP endpoint we read out of the response is trusted, and cached per-domain by
      // ucpWarmHandoff, purely because it came from THIS origin. Following a redirect would move that
      // anchor to an origin we never resolved, silently — we would go on logging the resolved
      // `wellKnownUrl` while building carts against whatever the redirect target advertised.
      //
      // 'manual', not 'error', and the difference is deliberate. Both satisfy MUST NOT follow — measured on
      // node 24: 'manual' returns the 3xx itself (status 301, ok false, redirected false, the target is
      // never contacted). But 'error' rejects with undici's opaque `TypeError: fetch failed`, which (a)
      // fetchWithPolicy classes as a transient network error and RETRIES — three fetches of a deterministic
      // refusal — and (b) leaves the reason only on `err.cause`, as a wording ("unexpected redirect") that
      // is undici's to change. 'manual' lands in the `!res.ok` branch below with a first-class `status`,
      // is not retried (< 500), and reaches ucpWarmHandoff's `not_ucp_reachable` log — which already
      // carries `status` — as a 301/302 that says exactly what it is: a merchant misconfiguration someone
      // can go fix. Do NOT read `res.json()` on that path: a 3xx body is HTML, and `!res.ok` guards it.
      // One dependency to name: the fetch SPEC says 'manual' yields an opaque-redirect filtered response
      // (type "opaqueredirect", status 0). Node/undici deliberately do not filter and return the real
      // status (measured: type "basic", status 301, readable Location). The SAFETY property survives either
      // way — status 0 is still `!res.ok` and lands in the same branch — only the diagnostic status is the
      // deviation. If it ever regresses to 0, discovery still refuses; the log just says 0 instead of 301.
      // (The receiver's own profile fetch applies the same rule to ITS URL — ucpOrderWebhookReceiver.js;
      // it does not read the profile discovered here, which no caller consumes beyond the endpoint.)
      redirect: 'manual',
      signal,
    }), { retry: true });
    if (!res.ok) {
      // A 3xx here IS the refusal: the redirect was not followed, and its status is the diagnosis.
      return { mcpEndpoint: undefined, businessProfile: null, wellKnownUrl, status: res.status };
    }
    const businessProfile = await res.json();
    const mcpEndpoint = extractMcpEndpoint(businessProfile);
    return { mcpEndpoint, businessProfile, wellKnownUrl, status: res.status };
  }

  /**
   * Low-level MCP tool call (JSON-RPC 2.0 `tools/call`) against a discovered endpoint.
   * Never call this with TOOL.COMPLETE_CHECKOUT — a guard throws.
   */
  async function callTool(mcpEndpoint, toolName, args = {}, { retry = false } = {}) {
    if (toolName === TOOL.COMPLETE_CHECKOUT) {
      throw new Error('ucpBuyerAgentClient: complete_checkout is hard-disabled (cart-build + handoff only).');
    }
    // HARD BOUND: retry is permitted ONLY for read-only/idempotent tools. Never blind-retry a mutating
    // cart/checkout call (would risk a duplicate cart/checkout). Callers pass retry:true only for get_product.
    const retryOk = retry && IDEMPOTENT_TOOLS.has(toolName);
    const endpoint = normalizeBaseUrl(mcpEndpoint, 'mcpEndpoint').toString();
    // Idempotency key is minted for signed (state-changing) requests; it lives in meta AND is a covered header.
    const idempotencyKey = tier === TRUST_TIER.SIGNED ? cryptoId() : undefined;
    const meta = requestMeta(idempotencyKey);
    // LIVE-VERIFIED shape (cosrx create_cart inputSchema, 2026-07-13): the tool's own fields sit DIRECTLY
    // alongside `meta` inside params.arguments (e.g. { meta, cart: { line_items: [...] } }). They are NOT
    // wrapped under an `input` object, and `meta` lives at params.arguments.meta. Sending an `input` wrapper
    // (or hoisting meta to params._meta / body.meta only) fails the live schema validation.
    const argumentsWithMeta = { meta, ...args };
    const body = {
      jsonrpc: '2.0',
      id: cryptoId(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: argumentsWithMeta,
      },
    };
    const bodyString = JSON.stringify(body);

    // TOKEN tier: resolve (mint/refresh) the Bearer JWT before building headers. ANONYMOUS/SIGNED skip this and
    // stay byte-identical to before (no exchange, no Authorization header).
    const bearer = tier === TRUST_TIER.TOKEN ? await resolveBearerToken() : null;
    const headers = authHeaders(bearer);
    if (tier === TRUST_TIER.SIGNED) {
      // At SIGNED tier a missing profile cannot be shrugged off the way it can at anonymous tier.
      //
      // NOT for the reason an earlier version of this comment gave. `buildUcpSignatureBase` does
      // `if (ucpAgentValue) fields.push(['ucp-agent', ucpAgentValue])`, so an absent value is simply NOT
      // COVERED and the signature stays internally consistent — there is no tampering mismatch. The real
      // hazard is one layer out: `headers['ucp-agent'] = undefined` is stringified by undici into a literal
      // `ucp-agent: undefined` request header (`new Headers({'ucp-agent': undefined})` ->
      // `[["ucp-agent","undefined"]]`), so we would ship junk in a header the signature does not cover — a
      // request that is both malformed and unverifiable in that field. Refuse by name instead; the cause is
      // a missing config value, and that is what the message says.
      if (!ucpAgentHeaderValue()) {
        // Name the ACTUAL cause. There are two ways to arrive here and they need opposite fixes: nothing is
        // configured (point UCP_BASE_URL at the serving origin), or something IS configured but every origin
        // named a PaaS-generated host and was refused — in which case "set UCP_BASE_URL" is advice that
        // cannot work, because setting it to that same host is refused again.
        throw new Error(
          refusedInfraOrigins.length
            ? 'ucpBuyerAgentClient: signing requires an agent profile URL, and every configured origin named '
              + `a PaaS-generated host, which is refused as an identity anchor (${refusedInfraOrigins.join(', ')}). `
              + 'Set UCP_AGENT_PROFILE_URL to a branded https URL serving /.well-known/ucp-agent — an explicit '
              + 'value is not subject to this rule.'
            : 'ucpBuyerAgentClient: signing requires an agent profile URL — set UCP_AGENT_PROFILE_URL (or '
              + 'UCP_BASE_URL) to the https origin serving /.well-known/ucp-agent.',
        );
      }
      // Mirror the meta pointers as covered HTTP headers, then sign. The private key never leaves this scope.
      headers['ucp-agent'] = ucpAgentHeaderValue();
      headers['idempotency-key'] = idempotencyKey;
      const created = Math.floor(Date.now() / 1000);
      const expires = created + signatureTtlSec;
      const { headers: sigHeaders } = signUcpRequest({
        method: 'POST',
        url: endpoint,
        bodyString,
        ucpAgentValue: headers['ucp-agent'],
        idempotencyKey,
        keyObject: signingKeyObject,
        keyid: signingKeyId,
        created,
        expires,
      });
      Object.assign(headers, sigHeaders);
    }

    const res = await fetchWithPolicy((signal) => fetchMerchantEndpoint(endpoint, {
      method: 'POST',
      headers,
      body: bodyString,
      // Bearer token (TOKEN tier) or RFC 9421 signature (SIGNED tier), plus the cart/buyer payload and the
      // idempotency key: none of it may be replayed at a URL we did not resolve. A 307/308 replays the body
      // and non-Authorization headers cross-origin (measured; see exchangeClientCredentials), and ANY redirect
      // keeps the Bearer same-origin. The endpoint came from the merchant's profile and is authoritative —
      // a redirect on it is a failure to report, not a hop to take. This holds at EVERY tier, including
      // ANONYMOUS: with no credential there is still a cart payload (variant ids, attribution, buyer context,
      // and under the preview flag a synthetic address) that must not land on an origin we did not resolve.
      //
      // 'error' rather than 'manual' here (the profile GET uses 'manual', see discoverEndpoint), and the
      // reason is one layer OUT from this call: under 'manual' a 3xx returns `ok:false` with the redirect
      // page's HTML as `error.message`, and ucpWarmHandoff feeds that message into classifyUcpFailure —
      // measured: "Page not found. Redirecting..." classifies as variant_invalid, "Temporarily unavailable"
      // as out_of_stock. An infrastructure fault laundered into a product-state verdict. A throw is
      // deterministic tool_error, and it carries the reason on `.cause` for the log.
      redirect: 'error',
      signal,
    }), { retry: retryOk });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    // MCP tool-level failures come back HTTP-200 with { result: { isError: true, content:[{type:'text',...}] } }
    // (e.g. "Invalid arguments: ... missing required properties: line_items") — NOT a JSON-RPC top-level error.
    // Surface those as an `error` too so callers (preview/warm-handoff) treat them as failures, not empty prices.
    const mcpToolError = parsed && parsed.result && parsed.result.isError
      ? { code: 'mcp_tool_error', message: mcpErrorText(parsed.result) }
      : undefined;
    return {
      ok: res.ok,
      status: res.status,
      tool: toolName,
      tier,
      response: parsed,
      // JSON-RPC error (auth/tier refusal) OR an MCP tool error is surfaced without throwing so the probe logs it.
      error: (parsed && parsed.error) || mcpToolError || (res.ok ? undefined : { code: res.status, message: text }),
    };
  }

  /**
   * Read ONE product by id — `get_product`.
   *
   * LIVE-VERIFIED SHAPE (cosrx `tools/list`, 2026-08-13): `{ meta, catalog: { id } }`, with the tool's
   * `required = ["meta","catalog"]` and `catalog.required = ["id"]`. The id is NESTED under `catalog`.
   *
   * This replaces `catalogSearch`, which sent a FLAT `{ query, id, sku }` and conflated three different live
   * tools into one call:
   *   - `get_product`    takes `catalog.id`   — one product by id (this function)
   *   - `search_catalog` takes `catalog.query` — free text (searchCatalog below)
   *   - `lookup_catalog` takes `catalog.ids`   — a batch by id
   * `sku` was not a member of ANY of them, so it is gone rather than renamed; nothing in the live catalog
   * surface accepts one.
   *
   * WHERE TO POINT THIS. A per-merchant UCP endpoint does NOT serve the catalog tools to us — re-confirmed
   * 2026-08-13, when `get_product` / `search_catalog` / `lookup_catalog` each answered
   * `-32602 { data: "Tool not found: <tool>" }` while `get_cart` on the same connection ran fine. Product
   * discovery is the Global Catalog / our own crawled index; pointing this at a merchant endpoint gets a
   * refusal no argument shape can fix.
   */
  async function getProduct(mcpEndpoint, { productId } = {}) {
    // `catalog.id` is the tool's only required member, so an absent one is a caller bug, not a merchant
    // refusal to discover at runtime. `firstNonEmpty` accepts STRINGS only — the live schema types
    // `catalog.id` as `type: "string"`, so refusing a number is right, but the message has to say which
    // mistake was made or a caller who passed `12345` reads "requires productId" and supplies it again.
    const id = firstNonEmpty(productId);
    if (!id) {
      throw new Error(productId === undefined || productId === null
        ? 'getProduct requires productId'
        : 'getProduct requires productId as a non-empty string (catalog.id is typed string)');
    }
    // Read-only lookup: safe to retry on a transient error (H1).
    return callTool(mcpEndpoint, TOOL.GET_PRODUCT, { catalog: { id } }, { retry: true });
  }

  /**
   * Free-text catalog search — `search_catalog`, which is a DIFFERENT tool from `get_product`.
   *
   * LIVE-VERIFIED SHAPE (same listing): `{ meta, catalog: { query, ... } }`; the tool's
   * `required = ["meta","catalog"]` and `catalog` itself declares no required member, so a query-less call is
   * legal on the wire. `pagination` is passed through when supplied because the live schema declares it
   * (alongside `context`/`signals`/`filters`, which this client has no use for yet).
   *
   * Same targeting caveat as getProduct: not served by a per-merchant endpoint.
   */
  async function searchCatalog(mcpEndpoint, { query, pagination } = {}) {
    const catalog = {};
    const q = firstNonEmpty(query);
    if (q) catalog.query = q;
    if (isPlainObjectLocal(pagination)) catalog.pagination = pagination;
    return callTool(mcpEndpoint, TOOL.SEARCH_CATALOG, { catalog }, { retry: true });
  }

  /**
   * Build a cart. line_items = [{ item: { id: "gid://shopify/ProductVariant/<n>" }, quantity }].
   * LIVE-VERIFIED (cosrx, 2026-07-13): create_cart's tool field is a `cart` object wrapping `line_items`,
   * i.e. arguments = { meta, cart: { line_items: [...] } }. Cart tools accept unauthenticated (anonymous)
   * requests per the spec, and the returned cart carries a storefront `continue_url` (warm handoff).
   */
  async function createCart(mcpEndpoint, { lineItems, context, attribution } = {}) {
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      throw new Error('createCart requires a non-empty lineItems array');
    }
    const cart = { line_items: lineItems };
    if (context) cart.context = context;
    const args = { cart };
    if (attribution) args.attribution = attribution;
    return callTool(mcpEndpoint, TOOL.CREATE_CART, args);
  }

  /**
   * List the tools a merchant UCP endpoint exposes (JSON-RPC `tools/list`). Used to fetch the LIVE
   * create_checkout/update_checkout inputSchema (we do NOT guess the request shape). Read-only; carries the
   * agent profile in meta like every request. Never calls a state-changing tool.
   */
  async function listTools(mcpEndpoint) {
    const endpoint = normalizeBaseUrl(mcpEndpoint, 'mcpEndpoint').toString();
    const bearer = tier === TRUST_TIER.TOKEN ? await resolveBearerToken() : null;
    const headers = authHeaders(bearer);
    const body = {
      jsonrpc: '2.0',
      id: cryptoId(),
      method: 'tools/list',
      // The profile pointer is required at params.arguments.meta for both tools/list and tools/call (live-verified).
      params: { arguments: { meta: requestMeta() } },
    };
    const bodyString = JSON.stringify(body);
    // tools/list is read-only discovery: safe to retry on a transient error (H1).
    const res = await fetchWithPolicy((signal) => fetchMerchantEndpoint(endpoint, {
      // Same rule as callTool: this carries the tier credential too.
      method: 'POST', headers, body: bodyString, redirect: 'error', signal,
    }), { retry: true });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    return { ok: res.ok, status: res.status, tier, response: parsed,
      error: parsed && parsed.error ? parsed.error : (res.ok ? undefined : { code: res.status, message: text }) };
  }

  /**
   * Create a checkout from a cart (LIVE create_checkout schema). Requires `line_items` even when converting a
   * `cart_id`. `context` carries the destination HINTS (there is no shipping_address field). Checkout tools
   * require auth/signed per spec; at anonymous tier a refusal is a captured finding (not forced). NEVER pays or
   * completes; NEVER attaches a payment instrument.
   * @param {{ cartId?: string, lineItems?: Array, buyer?: object, context?: object, attribution?: object,
   *          checkout?: object }} params
   */
  async function createCheckout(mcpEndpoint, { cartId, lineItems, buyer, context, attribution, checkout } = {}) {
    const args = buildCheckoutArgs({ cartId, lineItems, buyer, context, attribution, checkout });
    return callTool(mcpEndpoint, TOOL.CREATE_CHECKOUT, args);
  }

  /**
   * Update an existing checkout to re-price (LIVE update_checkout schema requires top-level `id` + meta +
   * checkout). Same additive fields as createCheckout. NEVER pays or completes.
   * @param {{ checkoutId: string, cartId?: string, lineItems?: Array, buyer?: object, context?: object,
   *          attribution?: object, checkout?: object }} params
   */
  async function updateCheckout(mcpEndpoint, { checkoutId, cartId, lineItems, buyer, context, attribution, checkout } = {}) {
    if (!checkoutId) throw new Error('updateCheckout requires checkoutId');
    const args = buildCheckoutArgs({ cartId, lineItems, buyer, context, attribution, checkout });
    args.id = checkoutId; // top-level `id` per the live update_checkout schema.
    return callTool(mcpEndpoint, TOOL.UPDATE_CHECKOUT, args);
  }

  /**
   * PHASE 1 in-chat PRICED PREVIEW (docs/ucp_inchat_preview_build_2026-07-13.md). From a built cart (+ its
   * line_items), create a checkout using a SYNTHETIC sample US address (placeholder, no real PII) — mapped to
   * the schema's `context` destination HINTS — purely to price the order, then return the NORMALIZED priced
   * object { item, shipping_options, tax, total, currency, continue_url, ... }.
   *
   * LIVE-VERIFIED (cosrx, 2026-07-13): create_checkout returns the item + subtotal + total + currency +
   * continue_url + storefront policy links. Shipping options and tax are NOT returned at this step — Shopify
   * requires the full delivery address (collected on the storefront), surfaced as recoverable `messages`
   * (delivery_address_required). So shipping_options=[] / tax=null here is the HONEST merchant response, not a
   * client omission. This NEVER completes checkout and NEVER pays; the shopper pays on the storefront.
   * @param {{ cartId?: string, lineItems?: Array, address?: object, email?: string, context?: object }} params
   */
  async function createCheckoutPreview(mcpEndpoint, { cartId, lineItems, address, email, context } = {}) {
    if (!cartId && !(Array.isArray(lineItems) && lineItems.length)) {
      throw new Error('createCheckoutPreview requires cartId or lineItems');
    }
    const addr = isPlainObjectLocal(address) ? address : SYNTHETIC_PREVIEW_ADDRESS;
    const ctx = { currency: 'USD', ...addressToContextHints(addr), ...(isPlainObjectLocal(context) ? context : {}) };
    const buyer = { email: firstNonEmpty(email, SYNTHETIC_PREVIEW_EMAIL) };
    const result = await createCheckout(mcpEndpoint, { cartId, lineItems, buyer, context: ctx });
    if (!result || (result.status && result.status >= 400)) {
      return { ok: false, status: result && result.status, error: result && result.error, tool_result: result };
    }
    // A usable priced preview may come back with the merchant's `isError:true` / status `requires_escalation`
    // (Shopify flags that a full delivery address + payment must still be entered on the STOREFRONT). That is a
    // valid in-chat preview, NOT a failure — we surface it with `requires_escalation` + `messages`. Only a
    // payload with no priced content (e.g. an "invalid arguments" text error) is treated as a hard failure.
    const priced = normalizePricedCheckout(result);
    const usable = Boolean(priced && (priced.item || priced.continue_url || priced.total != null));
    if (!usable) {
      return { ok: false, status: result.status, error: result.error, tool_result: result };
    }
    const requiresEscalation = Boolean(result.error) || priced.status === 'requires_escalation'
      || (Array.isArray(priced.messages) && priced.messages.some((m) => m && m.code === 'delivery_address_required'));
    return { ok: true, status: result.status, tier, priced, requires_escalation: requiresEscalation, tool_result: result };
  }

  /**
   * HARD REFUSAL: Pivota never completes checkout / submits payment in this probe. This performs NO network
   * call. It documents that completion is trust-tier gated and hands off to the storefront instead.
   */
  function refuseCompleteCheckout() {
    return {
      refused: true,
      tool: TOOL.COMPLETE_CHECKOUT,
      reason: 'pivota_policy_no_autonomous_payment',
      detail:
        'Pivota buyer-agent never calls complete_checkout, submits payment, or opens a handoff URL. Payment '
        + 'completion is trust-tier gated by the merchant/platform; the shopper completes on the merchant\'s '
        + 'own storefront checkout via the returned continue_url/checkout_url.',
      tier,
    };
  }

  /**
   * Extract the storefront handoff URL from a cart/checkout response without opening it.
   * Per spec, non-terminal states carry `continue_url`; some variants also expose `checkout_url`.
   */
  function extractHandoffUrl(toolResult) {
    const payload = unwrapToolPayload(toolResult);
    if (!payload || typeof payload !== 'object') return undefined;
    return firstNonEmpty(payload.continue_url, payload.checkout_url, payload.permalink, payload.url);
  }

  return {
    TOOL,
    TRUST_TIER,
    FAILURE_REASON,
    tier,
    SYNTHETIC_PREVIEW_ADDRESS,
    buildProfile,
    describeTier,
    verifyTokenTier,
    classifyUcpFailure,
    discoverEndpoint,
    listTools,
    callTool,
    getProduct,
    searchCatalog,
    createCart,
    createCheckout,
    updateCheckout,
    createCheckoutPreview,
    normalizePricedCheckout,
    refuseCompleteCheckout,
    extractHandoffUrl,
  };
}

// Hostname suffixes a PaaS GENERATES for a deployment. They are infrastructure addresses, not identity: the
// platform owns them, and they change when a service is renamed, moved between projects, or recreated. A
// profile URL is the opposite — the UCP spec treats it as a stable identity anchor ("Profile URLs are
// expected to remain consistent across requests") and merchants bind the authenticated identity to it, so
// deriving one from a generated hostname publishes something we do not control as the thing that names us.
// Matched as a DOT-ANCHORED suffix, so every generated subdomain under them is covered — `.railway.app`
// already covers the `*.up.railway.app` form we actually shipped, so listing that separately would be a line
// no test could ever hold to account.
const GENERATED_INFRA_HOST_SUFFIXES = Object.freeze([
  '.railway.app',
  '.vercel.app',
  '.onrender.com',
  '.herokuapp.com',
  '.fly.dev',
  // Cloud Run. Absent, this refusal would simply stop firing the moment we deploy there, and a
  // generated `*.a.run.app` host would be published as the thing that names us.
  '.run.app',
]);

/**
 * Fold a hostname to the form host comparisons must use.
 *
 * Two normalizations, both load-bearing rather than cosmetic. DNS hostnames are case-insensitive but the
 * `Host` header is case-PRESERVING, so a caller chooses the casing. And the root-labelled FQDN form
 * (`host.example.com.`) is a legal `Host` that resolves to the same name — WHATWG `URL` preserves that
 * trailing dot in `.hostname`, so a suffix test against the un-normalized value misses it. Skipping either
 * one turns every host rule below into something a caller can step around by retyping the same hostname.
 */
function normalizeHostname(hostname) {
  if (typeof hostname !== 'string') return '';
  return hostname.trim().toLowerCase().replace(/\.+$/, '');
}

/** Hostname of an https URL string, or '' if it is not one. Never throws. */
function safeHostnameOf(maybeUrl) {
  try {
    return new URL(String(maybeUrl).trim()).hostname;
  } catch {
    return '';
  }
}

/**
 * True when `hostname` is a hostname a PaaS generated for a deployment.
 *
 * NOT the inverse of "a domain we own" — an arbitrary third-party hostname is not generated infrastructure
 * and returns false here. This answers one narrow question; it is never sufficient on its own to decide that
 * a hostname may be published as our identity.
 */
function isGeneratedInfraHost(hostname) {
  const h = normalizeHostname(hostname);
  if (!h) return false;
  return GENERATED_INFRA_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

/**
 * `https://origin` -> `https://origin/.well-known/ucp-agent`, or undefined if the origin is unusable.
 *
 * DERIVED, NOT INVENTED: the only input is an origin this service was already configured to serve from, so
 * the result can only ever name a host that answers this route. A non-https or unparseable origin yields
 * undefined rather than a guess — sending a pointer the merchant cannot fetch is what this exists to stop.
 *
 * A GENERATED INFRASTRUCTURE HOST IS ALSO REFUSED, even though it resolves today. Reachability is not the
 * bar here: this URL is an IDENTITY, and *.up.railway.app names a Railway deployment slot, not Pivota. It
 * survives a redeploy but not a project move or a rename, and the day it stops resolving is the day every
 * merchant that cached our identity has to re-verify it. Refusing to derive it leaves the pointer ABSENT,
 * which a merchant reports as a missing field — an actionable failure, unlike an anchor that quietly names
 * infrastructure. An operator who genuinely wants to publish a generated host can still set
 * UCP_AGENT_PROFILE_URL, which is deliberately not gated (see its resolution above).
 */
function agentProfileUrlFromOrigin(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return undefined;
  let url;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined; // the profile is fetched cross-origin; http is not servable
  if (isGeneratedInfraHost(url.hostname)) return undefined;
  return `${url.origin}/.well-known/ucp-agent`;
}

// The env vars that can name an origin this service was CONFIGURED to serve from. Order is irrelevant — this
// is a membership set, not a precedence chain (the precedence chain lives at the profileUrl resolution).
const PROFILE_ORIGIN_ENV_VARS = Object.freeze([
  'UCP_AGENT_PROFILE_URL',
  'UCP_BASE_URL',
  'AGENT_CHECKOUT_UCP_BASE_URL',
  'MCP_OAUTH_RESOURCE',
]);

/** Normalized hostnames of every https origin an operator configured for this service. */
function configuredProfileHostnames(env) {
  const source = env || process.env;
  const out = new Set();
  for (const key of PROFILE_ORIGIN_ENV_VARS) {
    const raw = source[key];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      const url = new URL(raw.trim());
      if (url.protocol !== 'https:') continue;
      const h = normalizeHostname(url.hostname);
      if (h) out.add(h);
    } catch { /* an unparseable env value configures nothing */ }
  }
  return out;
}

/**
 * The profile ROUTE's last-resort self-reference: mirror back the Host the fetch arrived on.
 *
 * THIS INPUT IS CALLER-CONTROLLED, which makes it a different problem from the derived chain even though it
 * produces the same field. The derived chain reads our own env, so screening out known-bad values there is
 * config hygiene. Here anyone who can reach the route chooses the string, so screening out known-bad values
 * is the wrong shape entirely: a suffix denylist passed `evil.example.com` — and every PaaS not on the list —
 * straight through as the URL that names us. Published under `Cache-Control: public`, that is a shared cache
 * away from a merchant reading an attacker's hostname as Pivota's identity anchor.
 *
 * So this is an ALLOWLIST: mirror the Host only when it is one an operator actually configured (any origin in
 * PROFILE_ORIGIN_ENV_VARS). Unconfigured hosts yield undefined and the profile omits `ucp.profile_url`, the
 * same "absent beats wrong" outcome as everywhere else in this resolution. The generated-infra rule still
 * applies on top, because an operator CAN configure a PaaS origin and it must not become our identity.
 *
 * Failing closed also disposes of the parsing edge cases: an IPv6 literal, a port, a trailing-dot FQDN or an
 * odd-cased Host either normalizes to a configured hostname or is refused. None of them can invent a host.
 *
 * @param {string|undefined} hostHeader raw Host / X-Forwarded-Host value (may carry a port).
 * @param {{env?: object}} [options] injectable env for tests.
 */
function agentProfileUrlFromRequestHost(hostHeader, options = {}) {
  if (typeof hostHeader !== 'string') return undefined;
  // X-Forwarded-Host can be a comma-separated chain; the FIRST entry is the host the client asked for.
  const host = hostHeader.split(',')[0].trim();
  if (!host) return undefined;
  // Compare on the normalized hostname; the emitted URL keeps the host as sent, port included.
  const hostname = normalizeHostname(host.replace(/:\d+$/, ''));
  if (!hostname) return undefined;
  if (isGeneratedInfraHost(hostname)) return undefined;
  if (!configuredProfileHostnames(options.env).has(hostname)) return undefined;
  return `https://${host}/.well-known/ucp-agent`;
}

function isPlainObjectLocal(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

/**
 * Assemble create/update_checkout tool fields to the LIVE create_checkout inputSchema (fetched from cosrx via
 * tools/list, 2026-07-13). Top-level is `{ meta, checkout }` (meta is added by callTool); the merchant re-prices
 * from the cart + line_items + context. Only defined fields are attached.
 *
 * LIVE schema notes (verified 2026-07-13): `checkout.required = ["line_items"]` — `line_items` MUST be present
 * even when converting a `cart_id`. There is NO `shipping_address` field; the destination is conveyed only as
 * `context` HINTS (address_country / address_region / postal_code / currency), and Shopify collects the full
 * delivery address on the storefront (so shipping/tax quotes are not returned at this step). We NEVER attach the
 * `payment` field (payment instruments/tokens are the gated bottom half — out of scope).
 */
function buildCheckoutArgs({ cartId, lineItems, buyer, context, attribution, checkout } = {}) {
  const checkoutBody = isPlainObjectLocal(checkout) ? { ...checkout } : {};
  if (cartId && checkoutBody.cart_id === undefined) checkoutBody.cart_id = cartId;
  if (Array.isArray(lineItems) && checkoutBody.line_items === undefined) checkoutBody.line_items = lineItems;
  if (isPlainObjectLocal(buyer) && checkoutBody.buyer === undefined) checkoutBody.buyer = buyer;
  if (isPlainObjectLocal(context) && checkoutBody.context === undefined) checkoutBody.context = context;
  if (isPlainObjectLocal(attribution) && checkoutBody.attribution === undefined) checkoutBody.attribution = attribution;
  // HARD BOUND: never emit a `payment` field from this client (no instruments, no tokens, no card).
  delete checkoutBody.payment;
  return { checkout: checkoutBody };
}

/** Map a full address object to the create_checkout `context` localization/pricing HINTS the live schema accepts. */
function addressToContextHints(addr) {
  if (!isPlainObjectLocal(addr)) return {};
  const hints = {};
  const country = firstNonEmpty(addr.country_code, addr.address_country, addr.country);
  const region = firstNonEmpty(addr.province_code, addr.address_region, addr.province, addr.region);
  const postal = firstNonEmpty(addr.zip, addr.postal_code, addr.postalCode);
  if (country) hints.address_country = country;
  if (region) hints.address_region = region;
  if (postal) hints.postal_code = postal;
  return hints;
}

/**
 * Normalize a create/update_checkout tool result into the in-chat priced preview shape:
 *   { item, shipping_options, tax, total, subtotal, shipping, currency, continue_url, status, messages, raw }
 *
 * Grounded in the LIVE cosrx create_checkout payload (2026-07-13): `totals` is an ARRAY of
 * { type, amount, display_text } (types e.g. subtotal, total, tax, shipping); amounts are MINOR units (integer
 * cents). `line_items[].item` = { id, title, price, image_url }; `currency` is top-level. `shipping_options`
 * and `tax` are absent until the storefront collects the full delivery address (reflected in `messages`), so
 * shipping_options=[] / tax=null is an HONEST passthrough of what the merchant returned — never fabricated.
 * Amounts are passed through EXACTLY as the merchant reported them (no math, no currency coercion).
 */
function normalizePricedCheckout(toolResult) {
  const payload = unwrapToolPayload(toolResult);
  if (!payload || typeof payload !== 'object') {
    return {
      item: null, shipping_options: [], tax: null, total: null, subtotal: null, shipping: null,
      currency: null, continue_url: null, checkout_id: null, status: null, messages: [], raw: null,
    };
  }
  const lineItems = Array.isArray(payload.line_items) ? payload.line_items
    : (Array.isArray(payload.items) ? payload.items : []);
  const firstLine = lineItems.length ? lineItems[0] : null;
  const item = firstLine ? normalizeLineItem(firstLine) : null;

  const shippingRaw = payload.shipping_options || payload.available_shipping_options
    || payload.shipping_rates || payload.available_shipping_rates || payload.delivery_options || [];
  const shipping_options = (Array.isArray(shippingRaw) ? shippingRaw : []).map(normalizeShippingOption);

  const totalsByType = indexTotals(payload.totals);
  const tax = pickMoney(payload.total_tax, payload.tax, totalsByType.tax, totalsByType.taxes);
  const subtotal = pickMoney(payload.subtotal, totalsByType.subtotal);
  // `fulfillment` FIRST — it is the wire name. UCP's totals type enum is "subtotal,
  // items_discount, discount, fulfillment, tax, fee, total"
  // (ucp.dev/2026-04-08/schemas/shopping/types/total.json); "Shipping" and "Delivery" appear
  // there only as `display_text` examples, i.e. the human label. Live on
  // cosrx-renewal.myshopify.com, `fulfillment` appears 12 times in its checkout schemas and
  // `"shipping"` as a totals type zero times — so this pick returned null on a merchant that
  // HAD quoted shipping. The same omission caused a real bug in pivota-backend (#1923), where a
  // landed quote read as unlanded and earned card headroom it should not have had.
  //
  // Latent here rather than live: `buildPreview` does not carry `shipping` into the warm-handoff
  // preview, so nothing consumes this value yet. Fixed now precisely because the day something
  // does, the bug would arrive silently.
  const shipping = pickMoney(
    payload.total_shipping, totalsByType.fulfillment, totalsByType.shipping, totalsByType.delivery,
  );
  const total = pickMoney(
    payload.total_amount, payload.grand_total, payload.total_price, totalsByType.total,
    (typeof payload.total === 'string' || typeof payload.total === 'number') ? payload.total : undefined,
  );
  const currency = firstNonEmpty(
    payload.currency, payload.currency_code, payload.presentment_currency,
  ) || null;
  const continue_url = firstNonEmpty(
    payload.continue_url, payload.checkout_url, payload.permalink, payload.url,
  ) || null;
  // THE MERCHANT'S HANDLE ON THIS CHECKOUT. It was in `raw` all along and simply never lifted
  // out, which is the whole reason the card rail and the link rail looked like separate worlds:
  // `CardIssueRequest` requires a UCP `checkout_id`, and nothing surfaced one. `update_checkout`
  // takes this same value as its required top-level `id`, so the merchant's own schema names it.
  //
  // It is what makes a card mintable against a checkout the buyer is about to finish on the
  // STOREFRONT: `continue_url` (already lifted above) is where the agent types, and re-reading
  // `get_checkout` on this id AFTER an address is entered is the only way to learn a total that
  // includes shipping and tax — which a pre-address preview cannot carry (see the audit's B7).
  // `id` first because the UCP checkout schema declares it required and response-only
  // (`ucp_request: "omit"`), and Shopify returns `gid://shopify/Checkout/...` there. The aliases
  // are not speculative: PIVOTA'S OWN door names this `session_id`
  // (mcp-server/test/ucpFulfillmentAddressContract.test.js reads `created.session_id ?? created.id`
  // and feeds it to `update_checkout`'s `id`), so an `id`-only read would return null against us.
  const checkout_id = firstNonEmpty(payload.id, payload.checkout_id, payload.session_id) || null;
  const status = firstNonEmpty(payload.status) || null;
  const messages = Array.isArray(payload.messages)
    ? payload.messages.map((m) => (isPlainObjectLocal(m)
      ? { code: m.code || null, severity: m.severity || null, content: m.content || null }
      : null)).filter(Boolean)
    : [];

  return { item, shipping_options, tax, total, subtotal, shipping, currency, continue_url, checkout_id, status, messages, raw: payload };
}

/**
 * Index a Shopify UCP `totals` value by `type` -> money. Handles the live ARRAY form
 * ([{ type, amount, display_text }]) and tolerates an object form ({ total, subtotal, tax }). Amount is passed
 * through as-is (minor units) — no coercion.
 */
function indexTotals(totals) {
  // A REPEATED DETAIL TYPE RESOLVES TO ABSENT, NOT TO THE LAST ONE.
  //
  // UCP states it plainly: "MUST contain exactly one subtotal and one total entry. Detail types
  // (tax, fee, discount, fulfillment) may appear multiple times for itemization."
  // (ucp.dev/2026-04-08/schemas/shopping/types/totals.json). This index is a single-value lookup,
  // so an itemised merchant has no single answer to give — and last-wins silently reported ONE
  // line of an itemisation as the whole figure: two fulfillment rows of 500 and 300 published
  // `shipping = 300` for an 800 charge, into a store-audit acceptance receipt.
  //
  // Summing them is the other obvious repair and is deliberately NOT done: `pickMoney` in this
  // file is documented "no math, no coercion", amounts arrive as numbers OR strings OR objects,
  // and inventing arithmetic over merchant money to paper over an ambiguity is a worse failure
  // than admitting the ambiguity. Absent reads downstream as "unknown", which is true.
  //
  // This also repairs the same pre-existing hazard for `tax`, which was last-wins before this
  // function ever looked at `fulfillment`.
  const out = {};
  const seen = new Set();
  if (Array.isArray(totals)) {
    for (const t of totals) {
      if (!isPlainObjectLocal(t) || !t.type) continue;
      // NORMALISED: `type` is a free-text string in the schema, so casing and stray whitespace
      // are the merchant's to choose, and an unnormalised key means a merchant sending "Tax" is
      // read as having quoted none. That one reaches the warm-handoff response today via
      // buildPreview -> pricedTotals.includes_tax.
      const key = String(t.type).trim().toLowerCase();
      // `amount` before `value`: `amount` is the schema's field, `value` is tolerated only for
      // merchants that use it instead.
      const amount = (t.amount !== undefined ? t.amount : t.value);
      if (seen.has(key)) { out[key] = undefined; continue; }
      seen.add(key);
      out[key] = amount;
    }
  } else if (isPlainObjectLocal(totals)) {
    // The object form gets the SAME normalisation. Fixing only the array branch left
    // `{ Tax: 190 }` reading as no tax — the exact bug this was meant to close.
    for (const [k, v] of Object.entries(totals)) out[String(k).trim().toLowerCase()] = v;
  }
  return out;
}

function normalizeLineItem(line) {
  const itemObj = isPlainObjectLocal(line.item) ? line.item : line;
  return {
    variant_gid: firstNonEmpty(itemObj.id, itemObj.variant_id, line.id) || null,
    title: firstNonEmpty(itemObj.title, itemObj.name, line.title) || null,
    image_url: firstNonEmpty(itemObj.image_url, itemObj.image, line.image_url) || null,
    quantity: Number.isFinite(line.quantity) ? line.quantity : (Number.isFinite(itemObj.quantity) ? itemObj.quantity : null),
    price: pickMoney(itemObj.price, line.price, line.unit_price, indexTotals(line.totals).subtotal),
  };
}

function normalizeShippingOption(opt) {
  if (!isPlainObjectLocal(opt)) return { id: null, title: null, price: null };
  return {
    id: firstNonEmpty(opt.id, opt.handle, opt.code) || null,
    title: firstNonEmpty(opt.title, opt.name, opt.label) || null,
    price: pickMoney(opt.price, opt.amount, opt.total),
  };
}

/** Pass through the first defined money-ish value (number/string/{amount|value}). No math, no coercion. */
function pickMoney(...values) {
  for (const v of values) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' || typeof v === 'string') return v;
    if (isPlainObjectLocal(v) && (v.amount !== undefined || v.value !== undefined)) return v;
  }
  return null;
}

// ---- helpers ---------------------------------------------------------------

function extractMcpEndpoint(businessProfile) {
  if (!businessProfile || typeof businessProfile !== 'object') return undefined;
  const services = businessProfile.services ?? businessProfile.ucp?.services;
  // services can be an array (seller-style [{transport,endpoint}]) or an object keyed by service name.
  const bindings = [];
  if (Array.isArray(services)) bindings.push(...services);
  else if (services && typeof services === 'object') {
    for (const v of Object.values(services)) {
      if (Array.isArray(v)) bindings.push(...v);
      else if (v && typeof v === 'object') bindings.push(v);
    }
  }
  const mcp = bindings.find((b) => b && String(b.transport).toLowerCase() === 'mcp' && (b.endpoint || b.url));
  return mcp ? firstNonEmpty(mcp.endpoint, mcp.url) : undefined;
}

function unwrapToolPayload(toolResult) {
  if (!toolResult || typeof toolResult !== 'object') return undefined;
  const r = toolResult.response ?? toolResult;
  // JSON-RPC success: { result: { ... } } or MCP content wrapper { result: { content: [...] } }.
  const result = r.result ?? r;
  if (result && Array.isArray(result.content)) {
    for (const c of result.content) {
      if (c && c.type === 'json' && c.json) return c.json;
      if (c && c.type === 'text' && typeof c.text === 'string') {
        try { return JSON.parse(c.text); } catch { /* not json */ }
      }
    }
  }
  if (result && (result.continue_url || result.checkout_url || result.id || result.line_items)) return result;
  return result;
}

/** Extract a human-readable message from an MCP tool error result ({ content:[{type:'text',text}], isError }). */
function mcpErrorText(result) {
  if (result && Array.isArray(result.content)) {
    for (const c of result.content) {
      if (c && c.type === 'text' && typeof c.text === 'string') return c.text;
    }
  }
  return 'mcp tool returned isError';
}

function cryptoId() {
  try {
    // eslint-disable-next-line global-require
    return require('node:crypto').randomUUID();
  } catch {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Exponential backoff with full jitter for retry attempt N (1-based): a random delay in
 * [0, min(maxMs, baseMs * 2^(N-1))]. Full jitter avoids thundering-herd retries against a recovering brand.
 */
function backoffDelay(attempt, baseMs, maxMs) {
  const ceiling = Math.min(Number(maxMs) || 0, (Number(baseMs) || 0) * (2 ** Math.max(0, attempt - 1)));
  if (!(ceiling > 0)) return 0;
  return Math.floor(Math.random() * ceiling);
}

/**
 * H1 error taxonomy. Map a failure signal to a canonical FAILURE_REASON string used for the cold-redirect
 * fallback tag (H2 observability). Best-effort: product-state text (out-of-stock / invalid-variant /
 * discontinued) is matched from the merchant's own message; everything else degrades to tool_error/unknown.
 * Pure/deterministic; carries no PII (it inspects only status + the merchant's own error text).
 * @param {{ thrown?: Error, status?: number, errorMessage?: string, phase?: string }} signal
 * @returns {string} a FAILURE_REASON value
 */
function classifyUcpFailure({ thrown, status, errorMessage, phase } = {}) {
  if (thrown) {
    if (thrown.name === 'AbortError') return FAILURE_REASON.TIMEOUT;
    // A thrown non-abort error during discovery is a network/DNS reach failure; elsewhere it's a tool error.
    return phase === 'discovery' ? FAILURE_REASON.PROFILE_UNREACHABLE : FAILURE_REASON.TOOL_ERROR;
  }
  const msg = String(errorMessage == null ? '' : errorMessage).toLowerCase();
  if (msg) {
    if (/out[\s_-]?of[\s_-]?stock|sold[\s_-]?out|no (?:more )?inventory|insufficient inventory|not available for sale|unavailable/.test(msg)) {
      return FAILURE_REASON.OUT_OF_STOCK;
    }
    if (/variant|discontinued|no longer available|not found|no such|does not exist|invalid (?:variant|product|id)|unknown (?:variant|product)/.test(msg)) {
      return FAILURE_REASON.VARIANT_INVALID;
    }
    if (/invalid arguments|missing required|schema|validation|required propert/.test(msg)) {
      return FAILURE_REASON.INVALID_INPUT;
    }
  }
  if (Number(status) >= 500) return FAILURE_REASON.TOOL_ERROR;
  if (Number(status) >= 400) return FAILURE_REASON.TOOL_ERROR;
  if (msg) return FAILURE_REASON.TOOL_ERROR;
  return FAILURE_REASON.UNKNOWN;
}

// ---- RFC 9421 signing (SIGNED tier) ---------------------------------------

/**
 * Load an ECDSA P-256 PRIVATE key from a PEM or JWK string into a Node KeyObject. Never logs the material.
 * @param {string} raw  PEM (PKCS8/SEC1) or a JWK JSON string. From env only.
 * @returns {{ keyObject: import('crypto').KeyObject, kid: string|undefined }}
 */
function loadSigningPrivateKey(raw) {
  const s = firstNonEmpty(raw);
  if (!s) return { keyObject: undefined, kid: undefined };
  if (s.startsWith('{')) {
    let jwk;
    try { jwk = JSON.parse(s); } catch { throw new Error('UCP_AGENT_SIGNING_PRIVATE_KEY is not valid JSON (JWK)'); }
    if (!jwk || jwk.d === undefined) throw new Error('signing JWK is missing private component "d"');
    return { keyObject: nodeCrypto.createPrivateKey({ key: jwk, format: 'jwk' }), kid: jwk.kid };
  }
  return { keyObject: nodeCrypto.createPrivateKey(s), kid: undefined };
}

/** RFC 9530 Content-Digest for a request body. Always sha-256. */
function contentDigestFor(bodyString) {
  const hash = nodeCrypto.createHash('sha256').update(bodyString, 'utf8').digest('base64');
  return `sha-256=:${hash}:`;
}

/**
 * Build the RFC 9421 signature base + Signature-Input params for a UCP MCP request. Pure/deterministic given
 * its inputs (used directly by tests). Component values are the exact HTTP field / derived-component values.
 * @returns {{ base: string, params: string, covered: string[], contentDigest: string }}
 */
function buildUcpSignatureBase({ method, url, bodyString, ucpAgentValue, idempotencyKey, keyid, created, expires }) {
  const u = new URL(url);
  const contentDigest = bodyString != null ? contentDigestFor(bodyString) : undefined;
  const fields = [];
  fields.push(['@method', String(method || 'POST').toUpperCase()]);
  fields.push(['@authority', u.host]);
  fields.push(['@path', u.pathname]);
  if (u.search) fields.push(['@query', u.search]);
  if (ucpAgentValue) fields.push(['ucp-agent', ucpAgentValue]);
  if (idempotencyKey) fields.push(['idempotency-key', idempotencyKey]);
  if (contentDigest) fields.push(['content-digest', contentDigest]);
  if (bodyString != null) fields.push(['content-type', 'application/json']);

  const covered = fields.map(([name]) => name);
  const inner = covered.map((n) => `"${n}"`).join(' ');
  let params = `(${inner})`;
  if (created != null) params += `;created=${created}`;
  if (expires != null) params += `;expires=${expires}`;
  params += `;keyid="${keyid}"`; // NO alg param — derived from JWK crv per the spec.

  const lines = fields.map(([name, value]) => `"${name}": ${value}`);
  lines.push(`"@signature-params": ${params}`);
  return { base: lines.join('\n'), params, covered, contentDigest };
}

/**
 * Sign a UCP MCP request. Returns the HTTP headers to attach (content-digest, signature-input, signature) plus
 * the covered components (for logging/tests). The private key + signature never leak any private material.
 */
function signUcpRequest({ method, url, bodyString, ucpAgentValue, idempotencyKey, keyObject, keyid, created, expires }) {
  const { base, params, covered, contentDigest } = buildUcpSignatureBase({
    method, url, bodyString, ucpAgentValue, idempotencyKey, keyid, created, expires,
  });
  // ECDSA P-256 over SHA-256, raw r||s (IEEE P1363) per RFC 9421 — NOT DER.
  const sig = nodeCrypto.sign('sha256', Buffer.from(base, 'utf8'), { key: keyObject, dsaEncoding: 'ieee-p1363' });
  const headers = {
    'signature-input': `sig1=${params}`,
    signature: `sig1=:${sig.toString('base64')}:`,
  };
  if (contentDigest) headers['content-digest'] = contentDigest;
  return { headers, covered, signatureBase: base };
}

async function withTimeout(run, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return run(undefined);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  createUcpBuyerAgentClient,
  // Exported so merchant variant sourcing unwraps the MCP envelope with THIS function rather than a copy of
  // it: the shapes it handles (`content[].json`, `content[].text` holding JSON) are the client's own contract
  // with the storefront, and a twin would drift the day a merchant changes which one it sends.
  unwrapToolPayload,
  TOOL,
  // Exported so a test can pin the SET ITSELF, not just one tool's behaviour: this is the only thing
  // standing between a transient 500 and a blind-retried mutating call (a duplicate cart, a re-priced
  // checkout replayed after the merchant applied it). Adding a state-changing tool here previously passed
  // the whole suite.
  IDEMPOTENT_TOOLS,
  TRUST_TIER,
  FAILURE_REASON,
  SYNTHETIC_PREVIEW_ADDRESS,
  SYNTHETIC_PREVIEW_EMAIL,
  // Exposed for deterministic tests (no live network). Not part of the public client surface.
  classifyUcpFailure,
  backoffDelay,
  loadSigningPrivateKey,
  contentDigestFor,
  buildUcpSignatureBase,
  signUcpRequest,
  normalizePricedCheckout,
  buildCheckoutArgs,
  // Exported so the profile ROUTE applies the identical rule to its Host-header fallback, and so a test can
  // pin the rule itself rather than one caller's behaviour.
  agentProfileUrlFromOrigin,
  agentProfileUrlFromRequestHost,
  isGeneratedInfraHost,
  normalizeHostname,
  configuredProfileHostnames,
  isForbiddenNetworkAddress,
  createPublicOnlyLookup,
  createPublicNetworkFetch,
  toFetchResponse,
  MAX_MERCHANT_RESPONSE_BYTES,
};
