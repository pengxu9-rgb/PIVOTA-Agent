// UCP discovery — generates the `/.well-known/ucp` capability profile a UCP platform (Gemini/Search) fetches
// to autonomously discover + configure against Pivota, and computes the per-request active-capability
// INTERSECTION (UCP requires the merchant to return only the capabilities both sides support).
//
// Grounded in the public UCP spec (MERCHANT_SIDE_READINESS_codex.md): the business publishes a profile with
// `ucp_version`, `services` (transport bindings: REST / MCP / A2A), `capabilities`, `payment_handlers`, and
// `signing_keys`; platforms advertise via a `UCP-Agent` header; capabilities map 1:1 to MCP tools. All
// capabilities are backed by the one canonical contract (so safety is enforced once, never forked).

import { CANONICAL_CAPABILITIES, CANONICAL_OPERATIONS, operationsForCapability } from './canonicalContract.js';
import { UCP_SPEC_VERSION } from './ucpSpecVersion.cjs';

// The spec line this profile advertises. It is NOT declared here: this file used to pin the 2026-01-23 line
// while the buyer-agent profile pinned 2026-04-08, and #1962 sourced the advertised capabilities' tool names
// from that same 2026-04-08 line — so the seller negotiated an older version than the vocabulary it
// advertised (a platform reading `create_checkout` under a 2026-01-23 profile). Both
// roles now read ONE constant (ucpSpecVersion.cjs), so a one-sided bump is not expressible.
// Still negotiate per the platform's advertised version in prod; this is the version WE publish.
const DEFAULT_UCP_VERSION = UCP_SPEC_VERSION;

// Default kid for a business signing key published without one. Matches the kid the retired
// `ucp-web-production` profile shipped, so platforms that pinned it keep verifying across the port.
const DEFAULT_BUSINESS_SIGNING_KID = 'pivota-order-1';

/**
 * Sanitize one candidate business signing key into a publishable PUBLIC JWK, or return undefined if unusable.
 * Mirrors `toPublicJwk` in src/services/ucpBuyerAgentProfile.js (the buyer-agent precedent).
 * HARD BOUND: any private-key material (`d`) is REJECTED loudly — this module must NEVER publish a private key.
 */
export function toPublicSigningJwk(candidate) {
  if (!candidate || typeof candidate !== 'object') return undefined;
  if (candidate.d !== undefined) {
    // Private key material — refuse loudly. Callers must publish the PUBLIC half only.
    throw new Error('ucpProfile: signing key contains private material ("d"); refuse to publish it.');
  }
  const { kty, crv, x, y } = candidate;
  if (kty !== 'EC' || crv !== 'P-256' || !x || !y) return undefined;
  // Prefer an explicit kid; fall back to the house convention so a kid-less key is still addressable.
  const kid = typeof candidate.kid === 'string' && candidate.kid.trim() ? candidate.kid : DEFAULT_BUSINESS_SIGNING_KID;
  // Publish only the well-known public JWK members (drop anything unexpected). `use` is republished
  // only when it is a string — any other type collapses to 'sig' rather than leaking odd values.
  return { kty, crv, x, y, kid, use: typeof candidate.use === 'string' && candidate.use ? candidate.use : 'sig' };
}

/**
 * Resolve the PUBLIC business signing keys to publish in `/.well-known/ucp`, in priority order:
 *   config.signingKeys (array) -> env UCP_BUSINESS_SIGNING_PUBLIC_JWK (object or JSON array) -> [] (none).
 * Never throws on absent/blank env; throws if the env is unparseable JSON or a provided key carries
 * private material (`d`) — better a 503 profile than a leaked private key.
 */
export function resolveBusinessSigningKeys(config = {}) {
  let raw;
  if (Array.isArray(config.signingKeys)) raw = config.signingKeys;
  else {
    const envSource = config.env || (typeof process !== 'undefined' ? process.env : {}) || {};
    const env = envSource.UCP_BUSINESS_SIGNING_PUBLIC_JWK;
    if (typeof env === 'string' && env.trim()) {
      let parsed;
      try { parsed = JSON.parse(env.trim()); } catch { throw new Error('UCP_BUSINESS_SIGNING_PUBLIC_JWK is not valid JSON'); }
      raw = Array.isArray(parsed) ? parsed : [parsed];
    } else raw = [];
  }
  return raw.map(toPublicSigningJwk).filter(Boolean);
}

/**
 * Build the `/.well-known/ucp` profile object.
 * @param {{
 *   baseUrl: string,                       // https origin Pivota serves from
 *   restBasePath?: string,                 // UCP-REST base path. ONLY set this when a door that speaks UCP
 *                                          // REST wire shapes actually serves there — see the services note
 *                                          // in the body. Omitted => no `rest` transport is advertised.
 *   mcpEndpoint?: string,                  // MCP endpoint advertised as UCP's transport. It SHOULD serve the
 *                                          // UCP dialect (spec tool names: create_checkout, …); the gateway
 *                                          // currently passes its MCP-native door, so UCP-named calls are not
 *                                          // yet served — see the step-3 note in #1962.
 *   paymentHandlers?: Array<object>,       // declared handlers (id, name, version, psp, pci, ap2?, ...)
 *   signingKeys?: Array<object>,           // public JWKs Pivota signs responses/receipts with
 *   capabilities?: string[],               // which CANONICAL_CAPABILITIES keys to advertise (default: all)
 *   omitCapabilityIds?: string[],          // UCP capability ids (dev.ucp.*) to withhold from the profile —
 *                                          // for capabilities whose doors are currently dark (a profile
 *                                          // must not advertise what would hard-404)
 *   ucpVersion?: string,
 * }} config
 */
function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

export function buildUcpProfile(config = {}) {
  const baseUrl = requireHttps(config.baseUrl, 'baseUrl');
  const restBasePath = config.restBasePath;
  const advertised = Array.isArray(config.capabilities) && config.capabilities.length
    ? config.capabilities
    : Object.keys(CANONICAL_CAPABILITIES);

  for (const cap of advertised) {
    if (!CANONICAL_CAPABILITIES[cap]) throw new Error(`unknown capability advertised: ${cap}`);
  }

  const omit = new Set(Array.isArray(config.omitCapabilityIds) ? config.omitCapabilityIds : []);
  const capabilities = advertised
    .map((cap) => ({
      id: CANONICAL_CAPABILITIES[cap].ucp,
      title: CANONICAL_CAPABILITIES[cap].title,
      // PERMANENTLY-refused operations are never advertised. A profile is a promise of what a platform can
      // call; listing an operation that always refuses is the "advertised but not executable" defect this
      // repo already fixed once for the checkout capabilities under a dark kill-switch (omitCapabilityIds
      // below). Today this drops `exchange_payment_token` — ACP delegate_payment, which Pivota will never
      // implement because it vaults cardholder data (see delegatedPaymentRefusal.js). The door still answers
      // a named refusal; it is simply not advertised as a capability.
      operations: operationsForCapability(cap, { includeRefusalOnly: false }),
    }))
    // Withheld capabilities (and every operation they carry) never appear in the profile.
    .filter((c) => !omit.has(c.id))
    // A capability with NO advertisable operation left is not a capability — it is a title with nothing behind
    // it, and a platform reading `operations: []` learns only that it should not have been sent. This is what
    // removes `dev.ucp.shopping.ap2_mandate` from the profile: its only operation was the refused
    // delegate_payment exchange. Payment authorization itself is NOT lost — an ACP delegated token / AP2
    // mandate is presented inline on `checkout.complete`, which the checkout capability already advertises.
    .filter((c) => c.operations.length > 0);

  // TRANSPORTS ARE ADVERTISED ONLY WHEN SOMETHING SPEAKS THEM.
  //
  // This list previously ALWAYS carried a `rest` entry, defaulted to `${baseUrl}/ucp`, and the gateway
  // passed it `restBasePath: COMMERCE_ACP_BASE_PATH` — so the UCP profile pointed platforms at the ACP
  // door, which speaks ACP wire shapes (`POST /checkout_sessions` with ACP bodies), not UCP's. A platform
  // following it would fail on the first call. Advertising a transport nothing implements is the same
  // "advertised but not executable" defect the capability filter above exists to prevent, so `rest` is now
  // opt-in: pass restBasePath only when a real UCP-REST door serves there.
  //
  // UCP's own transport is MCP JSON-RPC (`tools/call` with the spec's flat tool names — see the buyer
  // client's TOOL constant and canonicalContract's ucpTool vocabulary), which is what `mcpEndpoint`
  // carries. That endpoint must serve the UCP DIALECT: a platform calling `create_checkout` against a
  // door that only knows `create_checkout_session` gets an unknown-tool error.
  const services = [];
  if (nonEmptyString(restBasePath)) {
    services.push({ transport: 'rest', endpoint: `${baseUrl}${restBasePath}` });
  }
  if (config.mcpEndpoint) {
    services.push({ transport: 'mcp', endpoint: config.mcpEndpoint });
  }

  return {
    ucp_version: config.ucpVersion || DEFAULT_UCP_VERSION,
    // Pivota is a MID-MAN, never merchant-of-record (founder rule, 2026-07-23):
    // transactions pass through this edge and settle on the MERCHANT's side — the
    // kernel's own quote schema carries the true per-transaction
    // `merchant_of_record` (the merchant), and the previous `true` here
    // contradicted both that schema and the design docs ("both ecosystems keep
    // the merchant as MoR"). `role` states what this endpoint actually is.
    provider: {
      merchant_of_record: false,
      role: 'commerce_index_passthrough',
      description:
        'Pivota is a commerce index / protocol edge: it passes checkout '
        + 'sessions through to the merchant of record, who settles the '
        + 'transaction on their own rails.',
    },
    services,
    capabilities,
    payment_handlers: Array.isArray(config.paymentHandlers) ? config.paymentHandlers : [],
    // PUBLIC keys platforms verify Pivota's order webhooks / receipts against (ES256, P-256).
    // Sourced from config.signingKeys or env UCP_BUSINESS_SIGNING_PUBLIC_JWK; validated so a
    // private component (`d`) can never be published. Empty until the founder provisions a key.
    signing_keys: resolveBusinessSigningKeys(config),
  };
}

/**
 * Active-capability intersection: given the platform's advertised UCP capability ids (from its profile /
 * the `UCP-Agent` exchange), return only the capabilities BOTH support. UCP requires the merchant to compute
 * + return this per request rather than assume the agent can handle everything.
 * @param {object} ourProfile  output of buildUcpProfile
 * @param {string[]} platformCapabilityIds  UCP capability ids the platform advertises
 */
export function activeCapabilityIntersection(ourProfile, platformCapabilityIds) {
  const platform = new Set(Array.isArray(platformCapabilityIds) ? platformCapabilityIds : []);
  return (ourProfile?.capabilities || []).filter((c) => platform.has(c.id));
}

/**
 * Framework-neutral UCP routes:
 *   GET /.well-known/ucp        -> the merchant profile
 *   POST/GET /ucp/capabilities  -> active capability intersection for this platform/request
 */
export function createUcpRouteHandlers(profile, { wellKnownPath = '/.well-known/ucp', capabilitiesPath = '/ucp/capabilities' } = {}) {
  const getProfile = typeof profile === 'function' ? profile : () => profile;
  return [
    {
      method: 'GET',
      path: wellKnownPath,
      handler: async () => json(200, getProfile()),
    },
    {
      method: 'POST',
      path: capabilitiesPath,
      handler: async (req = {}) => activeCapabilitiesResponse(getProfile(), req),
    },
    {
      method: 'GET',
      path: capabilitiesPath,
      handler: async (req = {}) => activeCapabilitiesResponse(getProfile(), req),
    },
  ];
}

export function mountUcpRoutes(app, routes) {
  if (!app) throw new Error('mountUcpRoutes requires an Express-style app');
  for (const route of routes) {
    const mount = app[route.method.toLowerCase()];
    if (typeof mount !== 'function') throw new Error(`app is missing ${route.method.toLowerCase()}()`);
    mount.call(app, route.path, async (req, res) => {
      const out = await route.handler({ headers: req.headers, body: req.body, query: req.query });
      for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
      return res.status(out.status).json(out.body);
    });
  }
}

function activeCapabilitiesResponse(profile, req) {
  const platformCapabilities = parsePlatformCapabilities(req);
  return json(200, {
    ucp_version: profile?.ucp_version,
    active_capabilities: activeCapabilityIntersection(profile, platformCapabilities),
  });
}

export function parsePlatformCapabilities(req = {}) {
  return normalizeCapabilityList(
    req.body?.capabilities
    ?? req.body?.platform_capabilities
    ?? req.query?.capabilities
    ?? header(req, 'ucp-agent-capabilities')
    ?? capabilityListFromUcpAgent(header(req, 'ucp-agent')),
  );
}

function requireHttps(url, field) {
  if (typeof url !== 'string' || !url.trim()) throw new Error(`${field} is required`);
  let u;
  try { u = new URL(url); } catch { throw new Error(`${field} must be a valid URL`); }
  if (u.protocol !== 'https:') throw new Error(`${field} must be https`);
  return url.replace(/\/+$/, '');
}

function capabilityListFromUcpAgent(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.capabilities)) return parsed.capabilities;
  } catch {
    // Fall back to comma-separated capabilities below.
  }
  return value;
}

function normalizeCapabilityList(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return normalizeCapabilityList(parsed);
    if (Array.isArray(parsed?.capabilities)) return normalizeCapabilityList(parsed.capabilities);
  } catch {
    // Not JSON; treat as a comma-separated header/query value.
  }
  return trimmed.split(',').map((v) => v.trim()).filter(Boolean);
}

function header(req, name) {
  const h = req?.headers ?? {};
  return h[name] ?? h[name.toLowerCase()] ?? h[name.toUpperCase()];
}

function json(status, body) {
  return { status, body, headers: { 'content-type': 'application/json' } };
}
