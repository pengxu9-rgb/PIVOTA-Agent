// UCP discovery — generates the `/.well-known/ucp` capability profile a UCP platform (Gemini/Search) fetches
// to autonomously discover + configure against Pivota, and computes the per-request active-capability
// INTERSECTION (UCP requires the merchant to return only the capabilities both sides support).
//
// THE DOCUMENT SHAPE IS THE SPEC'S, and it did not used to be. An earlier version of this comment cited a
// local readiness doc rather than the spec and published a structure of its own invention: top-level
// `ucp_version` / `services` / `capabilities`, with `capabilities` an ARRAY of `{id, title, operations}`.
// The spec (ucp.dev/2026-04-08/specification/overview, "Business Profile") nests the PROTOCOL metadata under
// `ucp` and makes `services`, `capabilities` and `payment_handlers` MAPS keyed by id:
//
//   { ucp: { version: <pinned>,
//            services:         { dev.ucp.shopping: [ { version, spec, transport, endpoint, schema } ] },
//            capabilities:     { dev.ucp.shopping.checkout: [ { version, spec, schema } ] },
//            payment_handlers: { com.google.pay: [ { id, version, spec, schema } ] } },
//     signing_keys: [ ... ] }
// (written without quotes on purpose: mcp-server/test/ucpSpecVersion.test.js scans this file for a quoted
// versioned ucp.dev URL, which is exactly the re-hardcoding it exists to prevent — a doc example is not an
// exemption from that rule.)
//
// `signing_keys` IS A SIBLING OF `ucp`, NOT A MEMBER OF IT. Both of the spec's profile examples close the
// `ucp` object and then declare `signing_keys` beside it, and the prose is explicit: "The `ucp` object
// contains protocol metadata: version, services, capabilities, and payment handlers. The `signing_keys`
// array contains public keys (JWK format) used to verify signatures on webhooks…". This module got it RIGHT
// before the shape rewrite and the first draft of that rewrite moved it inside — a platform verifying an
// RFC 9421 signature on a Pivota order webhook reads `profile.signing_keys`, gets undefined, and answers
// `key_not_found` / 401. Key Discovery is the whole reason the profile doubles as a key document; burying
// the keys one level down breaks it as silently as a wrong capability id.
//
// Confirmed against a LIVE conformant business profile (cosrx, 2026-08-14): its only top-level key is `ucp`
// (it publishes no signing keys at all, so it neither confirms nor denies the placement — the spec does),
// its capability entries are `[{version, spec, schema}]`, its service entries carry `schema`, and
// `payment_handlers` is a map keyed by a reverse-DNS handler namespace.
//
// This mattered the same way a wrong capability id does: a platform validating the profile answers
// `profile_malformed` and never reaches negotiation, so the door looks dead for a reason nothing in the
// document announces.
//
// `title` and `operations` are NOT spec members and are no longer published. Operations remain the internal
// rule for whether a capability is advertisable at all (a capability with nothing behind it is withheld);
// they are simply not part of the document, because the spec derives a capability's operations from its
// schema rather than from a per-profile list.

import { CANONICAL_CAPABILITIES, CANONICAL_OPERATIONS, canonicalOp, operationsForCapability } from './canonicalContract.js';
import { UCP_SPEC_VERSION, UCP_SPEC_BASE, UCP_SCHEMA_BASE, UCP_SERVICE_SCHEMA_BASE } from './ucpSpecVersion.cjs';

// The spec line this profile advertises. It is NOT declared here: this file used to pin the 2026-01-23 line
// while the buyer-agent profile pinned 2026-04-08, and #1962 sourced the advertised capabilities' tool names
// from that same 2026-04-08 line — so the seller negotiated an older version than the vocabulary it
// advertised (a platform reading `create_checkout` under a 2026-01-23 profile). Both
// roles now read ONE constant (ucpSpecVersion.cjs), so a one-sided bump is not expressible.
// Still negotiate per the platform's advertised version in prod; this is the version WE publish.
const DEFAULT_UCP_VERSION = UCP_SPEC_VERSION;

// The UCP service these capabilities belong to. `services` is a MAP keyed by this id, per spec.
const SHOPPING_SERVICE = 'dev.ucp.shopping';

// A service entry's `schema` is the TRANSPORT's machine description, and it differs per transport: OpenRPC
// for MCP, OpenAPI for REST. (`a2a` has none in the spec's own example, which is why this is a lookup and
// not a template.) Both measured 200 on 2026-08-14.
const SERVICE_SCHEMA_BY_TRANSPORT = Object.freeze({
  mcp: `${UCP_SERVICE_SCHEMA_BASE}shopping/mcp.openrpc.json`,
  rest: `${UCP_SERVICE_SCHEMA_BASE}shopping/rest.openapi.json`,
});

// Spec: profile responses MUST carry `public` and `max-age` >= 60. 300s is a deliberate margin over the
// floor — the document changes only on deploy — and the directive set must stay free of `private`,
// `no-store` and `no-cache`, which the spec forbids outright.
const PROFILE_CACHE_CONTROL = 'public, max-age=300';

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
 * `extends` in either of the spec's two forms (`"a"` or `["a","b"]`) as a list, or null for a ROOT.
 *
 * An EMPTY array is an extension with no reachable parent, NOT a root: the spec's rule is "remove any
 * capability where `extends` is set but none of its parents are in the intersection", and `[]` satisfies
 * "set" while having no parent present. Returning null for it would make a malformed platform document
 * un-prunable — the one shape that turns this guard off comes from the counterparty, not from us.
 */
function parentList(ext) {
  if (ext === undefined || ext === null) return null;
  return Array.isArray(ext) ? ext : [ext];
}

/**
 * THE intersection-algorithm orphan rule, steps 3 AND 4, and the ONLY implementation of it.
 *
 * Spec, verbatim:
 *   3. "Prune orphaned extensions: Remove any capability where `extends` is set but NONE of its parent
 *       capabilities are in the intersection."
 *        - single-parent (`extends: "string"`): parent must be present
 *        - multi-parent (`extends: ["a","b"]`): AT LEAST ONE parent must be present
 *   4. "Repeat pruning: Continue step 3 until no more capabilities are removed (handles transitive
 *       extension chains)."
 *
 * So the test is `.some()`, not `.every()`, and the loop runs to a FIXED POINT rather than once. Both
 * details are load-bearing and both were wrong here in different places: the profile builder used `.every`
 * (stricter than the spec — it would delete a multi-parent extension the platform can legitimately use) and
 * ran a single pass (a grandchild survives its pruned parent). A shared helper is the point, because Pivota
 * publishes TWO capability lists and both can orphan an extension: the profile's own list orphans one via
 * the checkout kill-switch (`omitCapabilityIds`), and the per-request ACTIVE list orphans one whenever a
 * platform's `UCP-Agent` capabilities name the modifier but not what it extends. Two lists, two chances to
 * drift, one rule.
 *
 * Emitting an orphan is not cosmetic: a modifier describes the input shape of a capability the very same
 * document says is unavailable, and a platform can read it as permission to send `checkout.fulfillment` on
 * a checkout that is not there.
 *
 * @param {Iterable<string>} ids            capability ids currently in the set
 * @param {(id: string) => string[]|null}   parentsOf  the entry's `extends`, as a list, or null for a root
 * @returns {Set<string>} the surviving ids
 */
function pruneOrphanedExtensions(ids, parentsOf) {
  const surviving = new Set(ids);
  let removed = true;
  while (removed) {
    removed = false;
    for (const id of [...surviving]) {
      const parents = parentsOf(id);
      if (!parents) continue; // a ROOT capability is never pruned
      if (!parents.some((parent) => surviving.has(parent))) {
        surviving.delete(id);
        removed = true;
      }
    }
  }
  return surviving;
}

/**
 * The operations of a capability that a platform can ACTUALLY INVOKE over the transport we advertise.
 *
 * WHY THIS EXISTS, and it is the sharpest lesson of this whole change: fixing a capability id turns a
 * silently-DEAD advertisement into an actively-LYING one unless reachability is checked at the same time.
 * `dev.ucp.shopping.discovery` matched no platform, so nothing behind it was ever called. Publishing the real
 * `dev.ucp.shopping.catalog.search` makes the intersection SUCCEED — and then `tools/call search_catalog`
 * hard-fails, because the UCP dialect does not expose that tool (mcp-server/src/ucpArgumentAdapter.js says so
 * outright). A correct id in front of an absent tool is worse than a wrong id: the platform now gets far
 * enough to fail on the money-adjacent call instead of skipping the capability.
 *
 * THE RULE. Our advertised transport is MCP JSON-RPC, where an operation is invoked as a TOOL. So an
 * operation is invocable only if the canonical contract gives it a `ucpTool` — the same evidenced-spec-name
 * gate the dialect itself uses, so this cannot drift from what the door serves. The one exception is an
 * operation that is not tool-served at all: `kernel: 'external'` (identity linking happens at the OAuth
 * edge, not via tools/call), which stays advertisable because no tool absence can make it unreachable.
 *
 * This is self-maintaining: the day `search_catalog` gains an evidenced `ucpTool` and a mapper, its
 * capability starts advertising itself. Nothing here needs editing for that.
 */
function invocableOperations(cap, config = {}) {
  const ops = operationsForCapability(cap, { includeRefusalOnly: false });
  // Only the MCP transport implies tool-invocation. With no mcp endpoint advertised there is no tool surface
  // to be absent from, so the unfiltered list is the honest answer.
  if (!config.mcpEndpoint) return ops;
  return ops.filter((id) => {
    const op = canonicalOp(id);
    return Boolean(op.ucpTool) || op.kernel === 'external';
  });
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
          ...capabilityDocUrls(CANONICAL_CAPABILITIES[cap], config),
          extends: [...CANONICAL_CAPABILITIES[cap].extends],
          ...(CANONICAL_CAPABILITIES[cap].config ? { config: CANONICAL_CAPABILITIES[cap].config } : {}),
        };
      }
      return {
        id: CANONICAL_CAPABILITIES[cap].ucp,
        ...capabilityDocUrls(CANONICAL_CAPABILITIES[cap], config),
        // PERMANENTLY-refused operations are never advertised. A profile is a promise of what a platform can
        // call; listing an operation that always refuses is the "advertised but not executable" defect this
        // repo already fixed once for the checkout capabilities under a dark kill-switch (omitCapabilityIds
        // below). Today this drops `exchange_payment_token` — ACP delegate_payment, which Pivota will never
        // implement because it vaults cardholder data (see delegatedPaymentRefusal.js). The door still answers
        // a named refusal; it is simply not advertised as a capability.
        operations: invocableOperations(cap, config),
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
    .filter((c) => c.extends || c.operations.length > 0)
    // A CAPABILITY WITH NO PUBLISHABLE `spec`/`schema` IS WITHHELD, NOT PUBLISHED PARTIAL. The spec marks both
    // REQUIRED for every capability, and a platform validating against that answers `profile_malformed` for
    // the WHOLE DOCUMENT — so one incomplete entry does not degrade itself, it takes checkout, catalog and
    // fulfillment down with it. Today this withholds exactly `cc.pivota.insights`: Pivota hosts no spec or
    // JSON Schema for its decision layer, and a made-up URL is the same defect as a made-up capability id.
    // Supplying real documents via `vendorCapabilityDocs` publishes it again with no edit here.
    .filter((c) => nonEmptyString(c.specUrl) && nonEmptyString(c.schemaUrl));

  // …and a modifier is only real while what it EXTENDS is still advertised. Same rule the intersection runs,
  // same function — see `pruneOrphanedExtensions`.
  const byId = new Map(capabilities.map((c) => [c.id, c]));
  const surviving = pruneOrphanedExtensions(byId.keys(), (id) => parentList(byId.get(id)?.extends));
  const liveCapabilities = capabilities.filter((c) => surviving.has(c.id));

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
  //
  // Each entry carries `schema` — the transport's machine description — because the spec requires it for
  // REST, MCP and embedded, and a live conformant profile carries it on every entry. We published none, so a
  // platform validating the profile answered `profile_malformed` before it ever reached the endpoint.
  const version = config.ucpVersion || DEFAULT_UCP_VERSION;
  const serviceEntries = [];
  if (nonEmptyString(restBasePath)) {
    serviceEntries.push(serviceEntry(version, 'rest', `${baseUrl}${restBasePath}`));
  }
  if (config.mcpEndpoint) {
    serviceEntries.push(serviceEntry(version, 'mcp', config.mcpEndpoint));
  }
  const services = serviceEntries.length ? { [SHOPPING_SERVICE]: serviceEntries } : {};

  // capabilities: a MAP of id -> [entry], each entry carrying the REQUIRED `version`/`spec`/`schema`.
  //
  // NO TRANSPORT => NO CAPABILITIES (#1987). The same rule as the filters above, one level up: a
  // permanently-refused operation is not advertised, a capability with no advertisable operation is not
  // advertised, and a capability with no DOOR to reach it is not a capability either — it is a promise a
  // platform cannot act on. It is exactly what the documented rollback produces: unsetting
  // AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED withholds the only transport while strict keeps the capabilities.
  //
  // THE PREDICATE IS `serviceEntries.length`, NOT `services.length`. #1987 wrote `services.length > 0` when
  // `services` was an ARRAY; this change makes it the spec's MAP, and `{}.length` is `undefined`, so the
  // ported condition would be permanently FALSE — a production profile advertising nothing at all, with
  // every suite still green because the no-transport case is the one that gets asserted. #1987's own merge
  // note called this out in advance; it is reconciled here rather than rediscovered in production.
  //
  // The profile itself stays up either way — version, provider, payment_handlers and signing_keys are
  // unchanged, so discovery still answers 200 and still identifies Pivota. Only the invocable list empties.
  const capabilityMap = {};
  if (serviceEntries.length > 0) {
    for (const c of liveCapabilities) {
      capabilityMap[c.id] = [pruneUndefined({
        version,
        spec: c.specUrl,
        schema: c.schemaUrl,
        extends: c.extends,
        config: c.config,
      })];
    }
  }

  return {
    ucp: {
      version,
      services,
      capabilities: capabilityMap,
      payment_handlers: toPaymentHandlerMap(config.paymentHandlers),
    },
    // PUBLIC keys platforms verify Pivota's order webhooks / receipts against (ES256, P-256). Sourced from
    // config.signingKeys or env UCP_BUSINESS_SIGNING_PUBLIC_JWK; validated so a private component (`d`) can
    // never be published. Empty until the founder provisions a key.
    //
    // A SIBLING OF `ucp`, PER SPEC — see the placement note at the top of this file. Inside `ucp` it is
    // invisible to Key Discovery, which reads `profile.signing_keys`.
    signing_keys: resolveBusinessSigningKeys(config),
    // A Pivota extension, also a sibling — the spec's `ucp` object is protocol metadata only, and this is
    // neither a capability nor a transport.
    //
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
  };
}

/** One `services[<service>]` entry: version + spec + transport + endpoint, plus the transport's `schema`. */
function serviceEntry(version, transport, endpoint) {
  return pruneUndefined({
    version,
    spec: `${UCP_SPEC_BASE}overview`,
    transport,
    endpoint,
    schema: SERVICE_SCHEMA_BY_TRANSPORT[transport],
  });
}

/**
 * The `spec` / `schema` URLs for one capability, or NOTHING when we have none to publish — which makes the
 * capability unpublishable (see the withholding filter in buildUcpProfile).
 *
 * A standard capability derives both from the pinned version bases plus its own measured paths. A VENDOR
 * capability has neither unless the operator supplies them via `vendorCapabilityDocs`: Pivota hosts no spec
 * or JSON Schema for `cc.pivota.insights`, and inventing a URL for a document that does not exist is the
 * same defect as advertising a capability that does not exist. An override must supply BOTH, for the same
 * reason the contract must — half an entry is still malformed.
 */
function capabilityDocUrls(cap, config = {}) {
  const override = (config.vendorCapabilityDocs || {})[cap.ucp];
  if (override) {
    // THE ORIGIN MUST MATCH THE NAMESPACE AUTHORITY. A vendor capability is named by reverse-DNS of a domain
    // its documents live on (`cc.pivota.insights` -> pivota.cc), and a validating platform checks that. An
    // override pointing `cc.pivota.insights` at ucp.dev would publish a document we do not control under a
    // name that claims we do — so it is refused rather than published, which is the same call as withholding
    // a capability with no documents at all.
    const authority = vendorAuthorityHost(cap.ucp);
    const ok = (u) => typeof u === 'string' && hostOf(u) === authority;
    if (authority && !(ok(override.spec) && ok(override.schema))) return {};
    return pruneUndefined({ specUrl: override.spec, schemaUrl: override.schema });
  }
  return pruneUndefined({
    specUrl: cap.specName ? `${UCP_SPEC_BASE}${cap.specName}` : undefined,
    schemaUrl: cap.schemaName ? `${UCP_SCHEMA_BASE}${cap.schemaName}` : undefined,
  });
}

/** `cc.pivota.insights` -> `pivota.cc`. Null for a standard `dev.ucp.*` id, which is not vendor-namespaced. */
function vendorAuthorityHost(capabilityId) {
  const labels = String(capabilityId || '').split('.');
  if (labels.length < 3) return null;
  if (labels[0] === 'dev' && labels[1] === 'ucp') return null; // a standard id, not a vendor authority
  return `${labels[1]}.${labels[0]}`;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

/** Drop undefined members so an absent optional never ships as an explicit `undefined`. */
function pruneUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * A payment-handler key is a REVERSE-DNS HANDLER NAMESPACE, and it is NOT the handler's `id`.
 *
 * The spec keys `payment_handlers` by a namespace the platform matches on — `com.google.pay`,
 * `dev.shopify.shop_pay`, `com.example.processor_tokenizer` — while the entry's own `id` is a short local
 * name inside it (`gpay`, `shop_pay_1234`). Live confirmation (cosrx, 2026-08-14): key `com.google.pay`,
 * entry `id: "gpay"`. Keying by `id` would publish Pivota's `stripe_spt` handler under `stripe_spt`, a name
 * no platform can match — the "advertised under a name nothing recognizes" defect one field over from the
 * capability id this workstream already fixed twice.
 *
 * So the namespace must be DECLARED (`namespace`, or the spec's own key if a caller passes the map form),
 * and it must look like reverse-DNS. A handler that declares neither is DROPPED rather than published under
 * a synthesized key: an unmatched handler is invisible, a wrongly-keyed one is a promise that fails at
 * payment time. Nothing configures handlers today (`ucpPaymentHandlers` is unset everywhere), so this fixes
 * the shape before it has a chance to ship.
 */
// At least TWO labels (`com.stripe`), lowercase, no leading/trailing dot, no empty label. The spec's own
// examples are three (`com.google.pay`) but two is a legitimate authority, and requiring three would
// silently drop a valid handler — the same "withheld for a reason nothing announces" failure this rule
// exists to prevent, inverted. Case matters because a platform matches these keys literally.
function isReverseDnsNamespace(v) {
  return typeof v === 'string' && /^[a-z0-9-]+(\.[a-z0-9_-]+)+$/.test(v);
}

function toPaymentHandlerMap(handlers) {
  // The spec's map form, supplied directly. Its KEYS get the same rule as the array form's: an operator can
  // hand-build this map, and passing it through unvalidated would leave exactly one way to publish a handler
  // under a name no platform can match — which is the defect this function exists to close.
  if (handlers && !Array.isArray(handlers) && typeof handlers === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(handlers)) {
      if (!isReverseDnsNamespace(key)) continue;
      out[key] = value;
    }
    return out;
  }
  const out = {};
  for (const h of Array.isArray(handlers) ? handlers : []) {
    if (!isReverseDnsNamespace(h?.namespace)) continue;
    (out[h.namespace] = out[h.namespace] || []).push(h);
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
  const ours = ourProfile?.ucp?.capabilities || {};

  // Step 1: the ids BOTH sides carry.
  //
  // (Step 2, "select the highest mutual version", is a no-op while Pivota publishes exactly one version and
  // this function receives only ids — see the note on parsePlatformCapabilities. It becomes real the day we
  // publish `supported_versions`, and is deliberately NOT faked here.)
  const mutualIds = Object.keys(ours).filter((id) => platform.has(id));

  // Steps 3-4: prune orphaned extensions, to a fixed point. The intersection can orphan a MODIFIER the
  // profile itself did not — a platform whose advertised ids name `dev.ucp.shopping.fulfillment` but not the
  // `dev.ucp.shopping.checkout` it extends would otherwise be told the modifier is ACTIVE while the
  // capability it modifies is not, a self-contradictory answer it can read as permission to send
  // `checkout.fulfillment`. Same rule as the profile builder, same function.
  const surviving = pruneOrphanedExtensions(mutualIds, (id) => parentList((ours[id] || [])[0]?.extends));

  // Entries keep only `version` — the spec's "Capability Declaration in Responses" example declares active
  // capabilities as `{ id: [{ version }] }`, not the full profile entry.
  const mutual = {};
  for (const id of mutualIds) {
    if (!surviving.has(id)) continue;
    mutual[id] = [{ version: (ours[id] || [])[0]?.version || ourProfile?.ucp?.version }];
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
      // The profile is a CACHEABLE, SHARED document, and the spec says so in MUST terms: "Profile responses
      // MUST include a Cache-Control header with `public` and `max-age` of at least 60 seconds. Profiles
      // MUST NOT be served with `private`, `no-store`, or `no-cache`." The rationale is in the same section —
      // a profile is stable identity, never per-transaction — and the header is how a platform is told it may
      // stop refetching. We sent none, so every platform was free to treat it as uncacheable.
      handler: async () => json(200, getProfile(), { 'cache-control': PROFILE_CACHE_CONTROL }),
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
  // the negotiated set found nothing where it looked. No Cache-Control here: this response IS per-request
  // (it depends on the caller's advertised capabilities), which is exactly what the profile is not.
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

function json(status, body, extraHeaders) {
  return { status, body, headers: { 'content-type': 'application/json', ...extraHeaders } };
}
