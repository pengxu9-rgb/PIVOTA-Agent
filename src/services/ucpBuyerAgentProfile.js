'use strict';

/*
 * Pivota UCP *buyer-agent* capability profile.
 *
 * ROLE: this is the OUTBOUND (buyer) role — Pivota acting as a shopping / discovery agent that calls OTHER
 * merchants' UCP endpoints. It is the OPPOSITE of the seller surface in
 * `safety-kernel/src/protocol/ucpProfile.js` + `/.well-known/ucp` (Pivota-as-merchant, inbound). Do not
 * conflate them; the seller surface is unchanged by this module.
 *
 * Grounded in the live Shopify agent docs (fetched 2026-07-13):
 *   - shopify.dev/docs/agents/profiles — the profile JSON is `{ ucp: { version, services, capabilities,
 *     payment_handlers } }`. `version` is required; an empty `capabilities` fails negotiation;
 *     `payment_handlers` may be `{}`.
 *   - An AGENT hosts its own profile at an HTTPS URL it controls and references it on every UCP request via
 *     the request `meta["ucp-agent"].profile` field. Only the *business/merchant* profile uses the fixed
 *     `/.well-known/ucp` path; the agent profile URL is agent-chosen. We serve ours at `/.well-known/ucp-agent`.
 *   - shopify.dev/docs/agents/profiles/auth-and-rate-limiting — for the SIGNED tier, the agent's public key is
 *     read from this profile (RFC 9421 / ECDSA P-256). We publish it in `ucp.signing_keys` as a PUBLIC JWK
 *     array; the `keyid` the client signs with is the JWK `kid`. Verifiers do `find_key_by_kid(profile
 *     .signing_keys, keyid)` (`<UCP_SPEC_BASE>signatures`, i.e. the signatures document on the pinned spec
 *     line — see safety-kernel/src/protocol/ucpSpecVersion.cjs). The signing alg is derived from the
 *     JWK `crv` (P-256), so no `alg` member is required.
 *
 * KEY SOURCING (public key only — it IS public, but is sourced from env so the founder controls rotation and
 * we never bake a real key into the repo):
 *   - `UCP_AGENT_SIGNING_PUBLIC_JWK` — a single JWK object OR a JSON array of JWKs (the ECDSA P-256 PUBLIC key).
 *   - Any JWK carrying a private `d` member is REJECTED — this module MUST never publish private material.
 *   - Absent env + no `config.signingKeys` => `signing_keys: []` (anonymous/token tier only). We ship a
 *     clearly-marked PLACEHOLDER_PUBLIC_JWK constant (NOT a usable key) that documents the shape the founder
 *     replaces via env; it is never auto-published.
 *
 * HARD BOUND: this profile requests discovery + cart-build + checkout-create scopes ONLY. It must NEVER
 * declare a purchase-completion / payment-handler capability — Pivota does not complete payment or act as a
 * payment processor in this probe. `assertNoPurchaseCompletion()` enforces that at build time.
 */

// UCP spec version we negotiate against, and the versioned spec/schema bases derived from it. The literal
// lives in ONE place for both of Pivota's UCP roles — `safety-kernel/src/protocol/ucpSpecVersion.cjs` —
// because the seller profile (`/.well-known/ucp`) previously pinned a different, older line than this file
// did while advertising capabilities whose tool names came from THIS line. Read that file for the evidence
// behind the pinned version; never re-declare a version literal here.
const {
  UCP_SPEC_VERSION,
  UCP_SPEC_BASE,
  UCP_SCHEMA_BASE,
} = require('../../safety-kernel/src/protocol/ucpSpecVersion.cjs');

const DEFAULT_UCP_VERSION = UCP_SPEC_VERSION;
const DEFAULT_SPEC_BASE = UCP_SPEC_BASE;
const DEFAULT_SCHEMA_BASE = UCP_SCHEMA_BASE;

// The shopping capabilities Pivota requests. Deliberately EXCLUDES any `*.complete` / payment capability.
//
// EVERY ID HERE MUST EXIST IN THE UCP VOCABULARY, because negotiation is a set INTERSECTION: a merchant
// grants the capabilities it advertises ∩ the ones we request, and an id that exists nowhere intersects with
// nothing. It fails SILENTLY — the call succeeds, the profile is accepted, and the tools simply are not there.
//
// That is exactly what `dev.ucp.shopping.catalog` did. No such capability exists at any version: the
// 2026-04-08 spec (ucp.dev/2026-04-08/specification/catalog) splits catalog into
//   dev.ucp.shopping.catalog.search — "Search for products using query text and filters."
//   dev.ucp.shopping.catalog.lookup — "Retrieve products or variants by identifier."
// and the 2026-01-23 profile has no catalog capability at all, so it is not even a stale spelling.
//
// MEASURED against a live merchant (cosrx, 2026-08-13), the correlation was exact and left no tool
// unexplained: the merchant advertised {checkout, fulfillment, discount, cart, order, catalog.search,
// catalog.lookup, dev.shopify.catalog}; we requested {catalog, cart, checkout}; and `tools/list` returned
// exactly 9 tools — the 4 cart + 5 checkout ones. The four withheld (get_product, search_catalog,
// lookup_catalog, get_order) were precisely the ones behind the id we mis-spelled and the one we never ask
// for. BOTH catalog ids are requested because this client uses both halves: `searchCatalog` is free text
// (.search) and `getProduct` is retrieval by identifier (.lookup).
//
// `dev.ucp.shopping.order` is deliberately NOT requested — it would grant `get_order`, which is a capability
// decision (do we track orders on the merchant's rails?) rather than part of fixing a wrong id.
//
const SHOPPING_SERVICE = 'dev.ucp.shopping';
const CATALOG_SEARCH_CAPABILITY = 'dev.ucp.shopping.catalog.search';
const CATALOG_LOOKUP_CAPABILITY = 'dev.ucp.shopping.catalog.lookup';
const CART_CAPABILITY = 'dev.ucp.shopping.cart';
const CHECKOUT_CAPABILITY = 'dev.ucp.shopping.checkout';

// Any capability whose name implies completing a purchase / moving money. Requesting these is forbidden here.
const FORBIDDEN_CAPABILITY_PATTERN = /(complete|payment|charge|purchase)/i;

// PLACEHOLDER ONLY — this is NOT a usable key (the x/y are dummy zero-ish coordinates). It documents the JWK
// shape the founder replaces by setting UCP_AGENT_SIGNING_PUBLIC_JWK (generate the pair with
// `node scripts/gen-ucp-agent-keypair.cjs`). It is NEVER auto-published into the profile.
const PLACEHOLDER_PUBLIC_JWK = Object.freeze({
  kty: 'EC',
  crv: 'P-256',
  x: 'REPLACE_ME_base64url_public_x_coordinate',
  y: 'REPLACE_ME_base64url_public_y_coordinate',
  kid: 'pivota-ucp-agent-REPLACE_ME',
  use: 'sig',
});

/**
 * Sanitize one candidate signing key into a publishable PUBLIC JWK, or return undefined if unusable.
 * HARD BOUND: strips/rejects any private-key material (`d`) so we can NEVER publish a private key.
 */
function toPublicJwk(candidate) {
  if (!candidate || typeof candidate !== 'object') return undefined;
  if (candidate.d !== undefined) {
    // Private key material — refuse loudly. Callers must publish the PUBLIC half only.
    throw new Error('ucpBuyerAgentProfile: signing key contains private material ("d"); refuse to publish it.');
  }
  const { kty, crv, x, y, kid } = candidate;
  if (kty !== 'EC' || crv !== 'P-256' || !x || !y || !kid) return undefined;
  // Publish only the well-known public JWK members (drop anything unexpected).
  const jwk = { kty, crv, x, y, kid, use: candidate.use || 'sig' };
  return jwk;
}

/**
 * Resolve the PUBLIC signing keys to publish, in priority order:
 *   config.signingKeys (array) -> env UCP_AGENT_SIGNING_PUBLIC_JWK (object or JSON array) -> [] (none).
 * Never throws on absent/blank env; only throws if a provided key carries private material.
 */
function resolveSigningKeys(config = {}) {
  let raw;
  if (Array.isArray(config.signingKeys)) raw = config.signingKeys;
  else {
    const env = (config.env || process.env || {}).UCP_AGENT_SIGNING_PUBLIC_JWK;
    if (typeof env === 'string' && env.trim()) {
      let parsed;
      try { parsed = JSON.parse(env.trim()); } catch { throw new Error('UCP_AGENT_SIGNING_PUBLIC_JWK is not valid JSON'); }
      raw = Array.isArray(parsed) ? parsed : [parsed];
    } else raw = [];
  }
  return raw.map(toPublicJwk).filter(Boolean);
}

function requireHttps(url, field) {
  if (typeof url !== 'string' || !url.trim()) throw new Error(`${field} is required`);
  let u;
  try { u = new URL(url); } catch { throw new Error(`${field} must be a valid URL`); }
  if (u.protocol !== 'https:') throw new Error(`${field} must be https`);
  return url.replace(/\/+$/, '');
}

/**
 * Assert the negotiated capability set never requests purchase-completion / payment. Throws otherwise.
 * @param {string[]} capabilityNames
 */
// The capabilities this buyer profile is ALLOWED to request. An ALLOWLIST, because the denylist this
// replaces could not express the rule it existed to enforce.
//
// `FORBIDDEN_CAPABILITY_PATTERN` matches /(complete|payment|charge|purchase)/i, and the UCP capability that
// authorizes money is spelled `dev.ucp.shopping.ap2_mandate` — none of those substrings. So the one id the
// guard exists to keep out was the one id it could not see, and adding it to the requested set passed every
// test, including the test named "…but NOT purchase-completion / payment". The same hole covers
// `com.google.pay`, `dev.shopify.shop_pay` and `dev.ucp.processor_tokenizer`. This repo already knew
// ap2_mandate is the payment capability — canonicalContract.js titles it "Payment authorization" and
// ucpProfile.js deliberately strips it from the seller profile — so the denylist was contradicted by its own
// neighbours.
//
// An allowlist cannot have that failure mode: a capability nobody has vetted is refused because it is
// ABSENT, not because someone predicted its spelling. Adding one is a deliberate edit here.
const ALLOWED_BUYER_CAPABILITIES = Object.freeze(new Set([
  'dev.ucp.shopping.catalog.search',
  'dev.ucp.shopping.catalog.lookup',
  'dev.ucp.shopping.cart',
  'dev.ucp.shopping.checkout',
]));

function assertNoPurchaseCompletion(capabilityNames) {
  for (const name of capabilityNames || []) {
    // Kept as a first pass: it names the SHAPE of the rule for anything obviously money-flavoured, and gives
    // a clearer message than "not on the allowlist" for the case someone is most likely to attempt.
    if (FORBIDDEN_CAPABILITY_PATTERN.test(String(name))) {
      throw new Error(
        `ucpBuyerAgentProfile: capability "${name}" implies purchase-completion/payment, which this buyer ` +
        'profile must never request (probe is cart-build + storefront handoff only).',
      );
    }
    if (!ALLOWED_BUYER_CAPABILITIES.has(String(name))) {
      throw new Error(
        `ucpBuyerAgentProfile: capability "${name}" is not on the vetted buyer allowlist. Pivota requests ` +
        'discovery + cart-build + checkout-create ONLY and never completes payment; a payment-authorizing ' +
        'capability such as dev.ucp.shopping.ap2_mandate must never be requested here. Add an id to ' +
        'ALLOWED_BUYER_CAPABILITIES deliberately, after checking what it authorizes.',
      );
    }
  }
}

/**
 * Build Pivota's buyer-agent capability profile object.
 * @param {{
 *   profileUrl?: string,          // https URL this profile is hosted at (self-reference; e.g. https://agent.pivota.cc/.well-known/ucp-agent)
 *   ucpVersion?: string,
 *   specBase?: string,
 *   schemaBase?: string,
 *   signingKeys?: Array<object>,  // public JWKs for the SIGNED tier (empty until provisioned)
 * }} [config]
 * @returns {object} profile JSON matching shopify.dev/docs/agents/profiles
 */
function buildUcpBuyerAgentProfile(config = {}) {
  const version = config.ucpVersion || DEFAULT_UCP_VERSION;
  const specBase = `${(config.specBase || DEFAULT_SPEC_BASE).replace(/\/+$/, '')}/`;
  const schemaBase = `${(config.schemaBase || DEFAULT_SCHEMA_BASE).replace(/\/+$/, '')}/`;
  const profileUrl = config.profileUrl ? requireHttps(config.profileUrl, 'profileUrl') : undefined;
  // The spec marks `spec` and `schema` REQUIRED on a capability entry, and every profile example carries
  // both. We computed the bases and attached them only to the SERVICE entry, so a merchant that validates
  // the platform profile would answer `profile_malformed` (422) — a profile that fails negotiation for a
  // reason nothing in it announces, which is the same silent class as a wrong capability id.
  const capabilitySpec = (name) => `${specBase}${name}`;
  const capabilitySchema = (name) => `${schemaBase}shopping/${name}.json`;

  // Requested capabilities — catalog search + lookup (discover), cart (build), checkout (create + hand off).
  // NOT complete.
  const capabilityNames = [
    CATALOG_SEARCH_CAPABILITY, CATALOG_LOOKUP_CAPABILITY, CART_CAPABILITY, CHECKOUT_CAPABILITY,
  ];
  assertNoPurchaseCompletion(capabilityNames);

  // `extends` IS A PRUNING KEY, NOT A DESCRIPTION. Intersection step 3 is: "Prune orphaned extensions:
  // Remove any capability where `extends` is set but none of its parent capabilities are in the
  // intersection." Declaring a parent therefore declares a DEPENDENCY THAT CAN DELETE THE ENTRY — and the
  // spec is explicit that `extends` is "Present for extensions, absent for ROOT capabilities."
  //
  // checkout is a ROOT capability. It previously declared `extends: CART_CAPABILITY`, so any merchant
  // advertising checkout but NOT cart pruned our checkout entirely — all five checkout tools gone, silently.
  // That is the exact failure this file was edited to fix, sitting one line below the fix; cosrx happens to
  // advertise cart, which is the only reason it never showed. Both spec profile examples declare checkout
  // with no `extends`; only extensions (fulfillment, discount) carry one.
  const capabilities = {
    [CATALOG_SEARCH_CAPABILITY]: [{ version, spec: capabilitySpec('catalog'), schema: capabilitySchema('catalog_search') }],
    [CATALOG_LOOKUP_CAPABILITY]: [{ version, spec: capabilitySpec('catalog'), schema: capabilitySchema('catalog_lookup') }],
    [CART_CAPABILITY]: [{ version, spec: capabilitySpec('cart'), schema: capabilitySchema('cart') }],
    // Root: no `extends`. Pivota still hands off to the storefront and never completes payment — that bound
    // lives in the non-money allowlist and `completes_payment: false`, not in a dependency edge.
    [CHECKOUT_CAPABILITY]: [{ version, spec: capabilitySpec('checkout'), schema: capabilitySchema('checkout') }],
  };

  const ucp = {
    version,
    services: {
      [SHOPPING_SERVICE]: [
        {
          version,
          spec: specBase,
          transport: 'mcp',
          schema: schemaBase,
        },
      ],
    },
    capabilities,
    // Empty object = Pivota declares NO payment handler. It never processes payment; the buyer completes on
    // the merchant's own storefront via the returned handoff URL.
    payment_handlers: {},
    // PUBLIC keys for the SIGNED trust tier (RFC 9421 / ECDSA P-256). Sourced from env / config (public JWK
    // only; private material rejected). Empty = anonymous/token tier only. Verifiers match the request's
    // `keyid` against a JWK `kid` here.
    signing_keys: resolveSigningKeys(config),
  };
  if (profileUrl) ucp.profile_url = profileUrl;

  return {
    ucp,
    // Human/founder-facing truthful descriptor of who Pivota is and what it will (and will NOT) do. Additive
    // metadata alongside the spec `ucp` block; kept small to stay under the profile payload size limit.
    agent: {
      name: 'Pivota',
      role: 'buyer_agent',
      description:
        'Pivota is a product discovery and recommendation agent. It searches the catalog, builds a cart on '
        + "the shopper's behalf, creates a checkout, and hands the shopper off to the merchant's own storefront "
        + 'checkout to complete payment.',
      homepage: 'https://pivota.cc',
      completes_payment: false,
      is_payment_processor: false,
      requested_scopes: capabilityNames,
    },
  };
}

module.exports = {
  buildUcpBuyerAgentProfile,
  assertNoPurchaseCompletion,
  resolveSigningKeys,
  toPublicJwk,
  PLACEHOLDER_PUBLIC_JWK,
  DEFAULT_UCP_VERSION,
  SHOPPING_SERVICE,
  ALLOWED_BUYER_CAPABILITIES,
  CATALOG_SEARCH_CAPABILITY,
  CATALOG_LOOKUP_CAPABILITY,
  CART_CAPABILITY,
  CHECKOUT_CAPABILITY,
  FORBIDDEN_CAPABILITY_PATTERN,
};
