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
 *     read from this profile (RFC 9421 / ECDSA P-256). We expose `ucp.signing_keys` (empty until the founder
 *     provisions a key) so the profile can carry it later without a code change.
 *
 * HARD BOUND: this profile requests discovery + cart-build + checkout-create scopes ONLY. It must NEVER
 * declare a purchase-completion / payment-handler capability — Pivota does not complete payment or act as a
 * payment processor in this probe. `assertNoPurchaseCompletion()` enforces that at build time.
 */

// UCP spec version we negotiate against. The live carts-and-checkout docs reference
// `https://ucp.dev/2026-04-08/specification/...`, so we pin the 2026-04-08 line by default.
const DEFAULT_UCP_VERSION = '2026-04-08';
const DEFAULT_SPEC_BASE = 'https://ucp.dev/2026-04-08/specification/';
const DEFAULT_SCHEMA_BASE = 'https://ucp.dev/2026-04-08/schema/';

// The shopping capabilities Pivota requests. Deliberately EXCLUDES any `*.complete` / payment capability.
const SHOPPING_SERVICE = 'dev.ucp.shopping';
const CATALOG_CAPABILITY = 'dev.ucp.shopping.catalog';
const CART_CAPABILITY = 'dev.ucp.shopping.cart';
const CHECKOUT_CAPABILITY = 'dev.ucp.shopping.checkout';

// Any capability whose name implies completing a purchase / moving money. Requesting these is forbidden here.
const FORBIDDEN_CAPABILITY_PATTERN = /(complete|payment|charge|purchase)/i;

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
function assertNoPurchaseCompletion(capabilityNames) {
  for (const name of capabilityNames || []) {
    if (FORBIDDEN_CAPABILITY_PATTERN.test(String(name))) {
      throw new Error(
        `ucpBuyerAgentProfile: capability "${name}" implies purchase-completion/payment, which this buyer ` +
        'profile must never request (probe is cart-build + storefront handoff only).',
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

  // Requested capabilities — catalog (discover), cart (build), checkout (create + hand off). NOT complete.
  const capabilityNames = [CATALOG_CAPABILITY, CART_CAPABILITY, CHECKOUT_CAPABILITY];
  assertNoPurchaseCompletion(capabilityNames);

  const capabilities = {
    [CATALOG_CAPABILITY]: [{ version }],
    [CART_CAPABILITY]: [{ version }],
    // checkout builds on cart; still hands off to the storefront — Pivota does not complete it.
    [CHECKOUT_CAPABILITY]: [{ version, extends: CART_CAPABILITY }],
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
    // Public keys for the SIGNED trust tier (RFC 9421 / ECDSA P-256). Empty = anonymous/token tier only.
    signing_keys: Array.isArray(config.signingKeys) ? config.signingKeys : [],
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
  DEFAULT_UCP_VERSION,
  SHOPPING_SERVICE,
  CATALOG_CAPABILITY,
  CART_CAPABILITY,
  CHECKOUT_CAPABILITY,
  FORBIDDEN_CAPABILITY_PATTERN,
};
