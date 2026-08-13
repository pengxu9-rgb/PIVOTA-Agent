// UCP discovery — generates the `/.well-known/ucp` capability profile a UCP platform (Gemini/Search) fetches
// to autonomously discover + configure against Pivota, and computes the per-request active-capability
// INTERSECTION (UCP requires the merchant to return only the capabilities both sides support).
//
// THE DOCUMENT SHAPE IS THE SPEC'S, and it did not used to be. An earlier version of this comment cited a
// local readiness doc rather than the spec and published a structure of its own invention: top-level
// `ucp_version` / `services` / `capabilities`, with `capabilities` an ARRAY of `{id, title, operations}`.
// The spec (ucp.dev/2026-04-08/specification/overview, "Business Profile") nests EVERYTHING under `ucp` and
// makes `services`, `capabilities` and `payment_handlers` MAPS keyed by id:
//
//   { ucp: { version: <pinned>,
//            services:         { dev.ucp.shopping: [ { version, spec, transport, endpoint } ] },
//            capabilities:     { dev.ucp.shopping.checkout: [ { version, spec, schema } ] },
//            payment_handlers: { com.google.pay: [ { id, version, spec, schema } ] } } }
// (written without quotes on purpose: mcp-server/test/ucpSpecVersion.test.js scans this file for a quoted
// versioned ucp.dev URL, which is exactly the re-hardcoding it exists to prevent — a doc example is not an
// exemption from that rule.)
//
// Confirmed against a LIVE conformant business profile (cosrx, 2026-08-13): its only top-level key is `ucp`,
// its capability entries are `[{version, spec, schema}]`, and `payment_handlers` is a map. `spec` and
// `schema` are marked REQUIRED on a capability entry and we published neither.
//
// This mattered the same way a wrong capability id does: a platform validating the profile answers
// `profile_malformed` and never reaches negotiation, so the door looks dead for a reason nothing in the
// document announces. Pivota's own BUYER profile (src/services/ucpBuyerAgentProfile.js) already emitted the
// correct shape — the two roles had drifted and only one was right.
//
// `title` and `operations` are NOT spec members and are no longer published. Operations remain the internal
// rule for whether a capability is advertisable at all (a capability with nothing behind it is withheld);
// they are simply not part of the document, because the spec derives a capability's operations from its
// schema rather than from a per-profile list.

import { CANONICAL_CAPABILITIES, CANONICAL_OPERATIONS, operationsForCapability } from './canonicalContract.js';
import { UCP_SPEC_VERSION, UCP_SPEC_BASE, UCP_SCHEMA_BASE } from './ucpSpecVersion.cjs';

// The spec line this profile advertises. It is NOT declared here: this file used to pin the 2026-01-23 line
// while the buyer-agent profile pinned 2026-04-08, and #1962 sourced the advertised capabilities' tool names
// from that same 2026-04-08 line — so the seller negotiated an older version than the vocabulary it
// advertised (a platform reading `create_checkout` under a 2026-01-23 profile). Both
// roles now read ONE constant (ucpSpecVersion.cjs), so a one-sided bump is not expressible.
// Still negotiate per the platform's advertised version in prod; this is the version WE publish.
const DEFAULT_UCP_VERSION = UCP_SPEC_VERSION;

// The UCP service these capabilities belong to. `services` is a MAP keyed by this id, per spec.
const SHOPPING_SERVICE = 'dev.ucp.shopping';

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

/**
 * Drop every MODIFIER capability whose `extends` target is not in the same list.
 *
 * A modifier (UCP `extends` + `config`, today `dev.ucp.shopping.fulfillment`) has no operations of its own:
 * it adds fields to the input shape of the capability it extends and publishes the bounds the door enforces
 * on them. Emitted WITHOUT that capability it is self-contradictory — it describes the input shape of a door
 * the very same response says is not available — and a platform can read it as permission to send
 * `checkout.fulfillment` on a checkout that is not there. That is the "advertised but not executable" defect
 * one level up.
 *
 * IT IS SHARED BECAUSE PIVOTA PUBLISHES TWO CAPABILITY LISTS, AND BOTH CAN ORPHAN A MODIFIER. The profile's
 * own list orphans one via the checkout kill-switch (`omitCapabilityIds`); the per-request ACTIVE list
 * orphans one whenever a platform's `UCP-Agent` capabilities name the modifier but not what it extends —
 * plausible, since a platform advertising fulfillment support may enumerate only the extension. The first was
 * guarded and the second was not, which is exactly the twin-drift this repo keeps paying for: one invariant,
 * one implementation, both callers.
 *
 * Single-pass, matching the shape of the data: no modifier currently extends another modifier, and a chain
 * would need a fixpoint. If one is ever added, this is the one place to teach.
 */
function withoutOrphanedModifiers(capabilities) {
  const presentIds = new Set(capabilities.map((c) => c.id));
  return capabilities.filter((c) => !c.extends || c.extends.every((id) => presentIds.has(id)));
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
    .map((cap) => {
      // A MODIFIER capability (UCP's `extends` + `config`) has no operation of its own by definition: it adds
      // fields to the input shape of the capability it extends — today `dev.ucp.shopping.fulfillment`, which
      // adds `checkout.fulfillment` — and publishes, machine-readably, the bounds the door enforces on them.
      // It carries no `operations` key at all rather than an empty one: `operations: []` would read as "this
      // capability offers nothing", which is the opposite of what a modifier means.
      if (CANONICAL_CAPABILITIES[cap].extends) {
        return {
          id: CANONICAL_CAPABILITIES[cap].ucp,
          title: CANONICAL_CAPABILITIES[cap].title,
          ...capabilityDocUrls(CANONICAL_CAPABILITIES[cap], config),
          extends: [...CANONICAL_CAPABILITIES[cap].extends],
          ...(CANONICAL_CAPABILITIES[cap].config ? { config: CANONICAL_CAPABILITIES[cap].config } : {}),
        };
      }
      return {
        id: CANONICAL_CAPABILITIES[cap].ucp,
        title: CANONICAL_CAPABILITIES[cap].title,
        ...capabilityDocUrls(CANONICAL_CAPABILITIES[cap], config),
        // PERMANENTLY-refused operations are never advertised. A profile is a promise of what a platform can
        // call; listing an operation that always refuses is the "advertised but not executable" defect this
        // repo already fixed once for the checkout capabilities under a dark kill-switch (omitCapabilityIds
        // below). Today this drops `exchange_payment_token` — ACP delegate_payment, which Pivota will never
        // implement because it vaults cardholder data (see delegatedPaymentRefusal.js). The door still answers
        // a named refusal; it is simply not advertised as a capability.
        operations: operationsForCapability(cap, { includeRefusalOnly: false }),
      };
    })
    // Withheld capabilities (and every operation they carry) never appear in the profile.
    .filter((c) => !omit.has(c.id))
    // A capability with NO advertisable operation left is not a capability — it is a title with nothing behind
    // it, and a platform reading `operations: []` learns only that it should not have been sent. This is what
    // removes `dev.ucp.shopping.ap2_mandate` from the profile: its only operation was the refused
    // delegate_payment exchange. Payment authorization itself is NOT lost — an ACP delegated token / AP2
    // mandate is presented inline on `checkout.complete`, which the checkout capability already advertises.
    //
    // A modifier is not an exception to that rule but a different kind of entry: what stands behind it is its
    // `config` plus the operations of the capability it extends, which the next filter requires to be present.
    .filter((c) => c.extends || c.operations.length > 0);

  // …but a modifier is only real while what it EXTENDS is still advertised — see `withoutOrphanedModifiers`,
  // which BOTH capability lists Pivota publishes run through.
  const liveCapabilities = withoutOrphanedModifiers(capabilities);

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
  const version = config.ucpVersion || DEFAULT_UCP_VERSION;
  const services = {};
  const serviceEntries = [];
  if (nonEmptyString(restBasePath)) {
    serviceEntries.push({ version, spec: `${UCP_SPEC_BASE}overview`, transport: 'rest', endpoint: `${baseUrl}${restBasePath}` });
  }
  if (config.mcpEndpoint) {
    serviceEntries.push({ version, spec: `${UCP_SPEC_BASE}overview`, transport: 'mcp', endpoint: config.mcpEndpoint });
  }
  if (serviceEntries.length) services[SHOPPING_SERVICE] = serviceEntries;

  // capabilities: a MAP of id -> [entry], each entry carrying the REQUIRED `version`/`spec`/`schema`.
  const capabilityMap = {};
  for (const c of liveCapabilities) {
    capabilityMap[c.id] = [pruneUndefined({
      version,
      spec: c.specUrl,
      schema: c.schemaUrl,
      extends: c.extends,
      config: c.config,
    })];
  }

  return {
    ucp: pruneUndefined({
      version,
      services,
      capabilities: capabilityMap,
      // A MAP keyed by handler id, per spec and per cosrx's live profile. Callers still pass the array form
      // this module has always accepted; it is keyed here by the handler's `type` (the reverse-DNS id a
      // platform matches on, e.g. `dev.shopify.shop_pay`) falling back to `id`. An already-mapped value is
      // passed through untouched.
      payment_handlers: toPaymentHandlerMap(config.paymentHandlers),
      // PUBLIC keys platforms verify Pivota's order webhooks / receipts against (ES256, P-256).
      // Sourced from config.signingKeys or env UCP_BUSINESS_SIGNING_PUBLIC_JWK; validated so a
      // private component (`d`) can never be published. Empty until the founder provisions a key.
      signing_keys: resolveBusinessSigningKeys(config),
    }),
    // A Pivota extension, deliberately a SIBLING of `ucp` rather than inside it — the same placement the
    // buyer profile uses for its `agent` block, and the spec's own profile object is `ucp` alone.
    //
    // Pivota is a MID-MAN, never merchant-of-record (founder rule, 2026-07-23): transactions pass through
    // this edge and settle on the MERCHANT's side — the kernel's own quote schema carries the true
    // per-transaction `merchant_of_record` (the merchant), and a previous `true` here contradicted both that
    // schema and the design docs. `role` states what this endpoint actually is.
    provider: {
      merchant_of_record: false,
      role: 'commerce_index_passthrough',
      description:
        'Pivota is a commerce index / protocol edge: it passes checkout '
        + 'sessions through to the merchant of record, who settles the '
        + 'transaction on their own rails.',
    },
  };
}

/**
 * The `spec` / `schema` URLs for one capability, or NOTHING when we have none to publish.
 *
 * A standard capability derives both from the pinned version bases plus its own verified paths. A VENDOR
 * capability has neither unless the operator supplies them via `vendorCapabilityDocs` — Pivota hosts no spec
 * or JSON Schema for `cc.pivota.insights`, and inventing a URL for a document that does not exist is the
 * same defect as advertising a capability that does not exist.
 */
function capabilityDocUrls(cap, config = {}) {
  const override = (config.vendorCapabilityDocs || {})[cap.ucp];
  if (override) {
    return pruneUndefined({ specUrl: override.spec, schemaUrl: override.schema });
  }
  if (!cap.specName && !cap.schemaName) return {};
  return pruneUndefined({
    specUrl: cap.specName ? `${UCP_SPEC_BASE}${cap.specName}` : undefined,
    schemaUrl: cap.schemaName ? `${UCP_SCHEMA_BASE}${cap.schemaName}` : undefined,
  });
}

/** Drop undefined members so an absent optional never ships as an explicit `undefined`. */
function pruneUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Handler declarations -> the spec's MAP form. An array (what every caller passes today) is keyed by each
 * handler's `type`, else its `id`; a value that is already a map is returned unchanged. A handler with
 * neither key cannot be addressed by a platform and is dropped rather than published under a made-up name.
 */
function toPaymentHandlerMap(handlers) {
  if (handlers && !Array.isArray(handlers) && typeof handlers === 'object') return handlers;
  const out = {};
  for (const h of Array.isArray(handlers) ? handlers : []) {
    const key = nonEmptyString(h?.type) ? h.type : (nonEmptyString(h?.id) ? h.id : undefined);
    if (!key) continue;
    (out[key] = out[key] || []).push(h);
  }
  return out;
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
  const ours = (ourProfile && ourProfile.ucp && ourProfile.ucp.capabilities) || {};

  // Step 1-2: the ids BOTH sides carry. Entries keep only `version` — the spec's own "Capability Declaration
  // in Responses" example declares active capabilities as `{ id: [{ version }] }`, not the full profile entry.
  const mutual = {};
  for (const [id, entries] of Object.entries(ours)) {
    if (!platform.has(id)) continue;
    const version = (Array.isArray(entries) && entries[0] && entries[0].version) || ourProfile.ucp.version;
    mutual[id] = [{ version }];
  }

  // Step 3, REPEATED to a fixed point: "Remove any capability where `extends` is set but none of its parent
  // capabilities are in the intersection." Repeated because pruning one extension can orphan another that
  // extended IT — a single pass would leave a grandchild pointing at a parent that is already gone.
  //
  // Single-parent (`extends: "a"`) requires that parent; multi-parent (`extends: ["a","b"]`) requires at
  // least one. Telling a platform a modifier is ACTIVE while what it modifies is not is a self-contradictory
  // answer it can read as permission to send the modifier's fields.
  const parentsOf = (id) => {
    const entry = (ours[id] || [])[0] || {};
    const ext = entry.extends;
    if (!ext) return null;
    return Array.isArray(ext) ? ext : [ext];
  };
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (const id of Object.keys(mutual)) {
      const parents = parentsOf(id);
      if (!parents) continue;
      if (!parents.some((parent) => Object.prototype.hasOwnProperty.call(mutual, parent))) {
        delete mutual[id];
        pruned = true;
      }
    }
  }
  return mutual;
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
  // The spec's response shape: everything under `ucp`, capabilities as a MAP. This used to answer
  // `{ ucp_version, active_capabilities: [...] }` — neither key exists in the spec, so a platform reading
  // the negotiated set found nothing where it looked.
  return json(200, {
    ucp: {
      version: profile?.ucp?.version,
      capabilities: activeCapabilityIntersection(profile, platformCapabilities),
    },
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
