'use strict';

/*
 * THE ONE UCP SPEC VERSION PIVOTA SPEAKS — both roles, one constant.
 *
 * WHY THIS FILE EXISTS. Pivota has two UCP surfaces and they each carried their own pin:
 *   - SELLER (inbound, Pivota-as-merchant): `safety-kernel/src/protocol/ucpProfile.js` → `/.well-known/ucp`,
 *     which pinned `2026-01-23` — a value introduced by the squashed kernel import commit (ad597a5d,
 *     2026-06-06) with no rationale recorded in any comment, ADR, doc, or partner constraint.
 *   - BUYER (outbound, Pivota-as-shopping-agent): `src/services/ucpBuyerAgentProfile.js`, which pinned
 *     `2026-04-08` because the live carts-and-checkout docs reference `https://ucp.dev/2026-04-08/...`
 *     (fetched 2026-07-13) and the outbound probe verified against 2026-04-08 endpoints.
 * PR #1962 then imported the UCP tool vocabulary (`get_product`, `create_checkout`, `update_checkout`,
 * `get_checkout`, `complete_checkout`) from `src/services/ucpBuyerAgentClient.js`'s TOOL constant — the
 * 2026-04-08 line — into the canonical contract that BUILDS the seller profile's capability list. So the
 * seller profile advertised `ucp_version: 2026-01-23` over capabilities whose tool names came from
 * 2026-04-08: a platform negotiating the older line against the newer vocabulary.
 *
 * The fix is not to bump one string; it is to leave exactly ONE place where a version literal may live, so a
 * future one-sided bump is impossible rather than merely discouraged. Same reasoning as the tool-vocabulary
 * pin (mcp-server/test/ucpToolVocabulary.test.js) and the content_key / protocol_vocabulary digest pins:
 * drift fails CI instead of surfacing in a partner integration.
 *
 * WHY .cjs INSIDE AN ESM PACKAGE. The seller profile is ESM (safety-kernel is `"type": "module"`); the
 * buyer profile is CommonJS (`src/services`, required by `ucpBuyerAgentClient.js`). CJS cannot `require()` an
 * ESM module, so the shared source has to be loadable by both: a `.cjs` module is `require`-able from the
 * buyer side and `import`-able from the kernel side on every Node in both packages' engine range (>=18).
 * It lives in safety-kernel because the dependency arrow already points that way (src/ → safety-kernel,
 * never the reverse), which keeps the kernel self-contained.
 *
 * BUMPING THIS. Changing the version here changes what platforms negotiate against `/.well-known/ucp` in
 * production (`AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED=1`). Before bumping, check whether the new line changes
 * the profile SHAPE (capability ids, operation set, payment_handlers, signing_keys) and not just the string —
 * as of 2026-08-13 this repo models no shape difference between 2026-01-23 and 2026-04-08, which is why the
 * alignment to 2026-04-08 was a string-only change.
 */

// The UCP spec line Pivota negotiates on BOTH roles. Evidence: the live UCP carts-and-checkout
// specification and schema documents are published under `https://ucp.dev/2026-04-08/` (fetched
// 2026-07-13), and the outbound buyer probe ran successfully against endpoints on that line.
const UCP_SPEC_VERSION = '2026-04-08';

// Origin the versioned spec/schema documents are published under. Kept separate from the version so the
// derived bases below carry no second copy of the version literal.
const UCP_SPEC_ORIGIN = 'https://ucp.dev';

/** `https://ucp.dev/<version>/specification/` — advertised in the buyer profile's service entries. */
const UCP_SPEC_BASE = `${UCP_SPEC_ORIGIN}/${UCP_SPEC_VERSION}/specification/`;

/**
 * `https://ucp.dev/<version>/schemas/` — the CAPABILITY schema base. PLURAL, and that is not cosmetic: this
 * constant said `schema/` (singular) and every schema URL built from it 404s. Measured 2026-08-14:
 *   https://ucp.dev/2026-04-08/schemas/shopping/checkout.json -> 200
 *   https://ucp.dev/2026-04-08/schema/shopping/checkout.json  -> 404
 * The spec's own profile examples and a live conformant business profile (cosrx) both use the plural form.
 * Because both of Pivota's UCP roles read this one constant, the singular spelling published dead schema
 * URLs from the buyer profile as well — a merchant that dereferences them to validate our capabilities gets
 * nothing at every one.
 */
const UCP_SCHEMA_BASE = `${UCP_SPEC_ORIGIN}/${UCP_SPEC_VERSION}/schemas/`;

/**
 * `https://ucp.dev/<version>/services/` — the SERVICE schema base, which is a DIFFERENT tree from the
 * capability schemas above and must not be derived from it. A service entry's `schema` is the transport's
 * machine description (OpenRPC for MCP, OpenAPI for REST), not a capability's JSON Schema:
 *   .../services/shopping/mcp.openrpc.json   -> 200
 *   .../services/shopping/rest.openapi.json  -> 200
 * Both measured 2026-08-14, and both are what the spec's Business Profile example and cosrx's live profile
 * carry. Kept here rather than inlined so neither role can spell it privately.
 */
const UCP_SERVICE_SCHEMA_BASE = `${UCP_SPEC_ORIGIN}/${UCP_SPEC_VERSION}/services/`;

module.exports = {
  UCP_SPEC_VERSION,
  UCP_SPEC_ORIGIN,
  UCP_SPEC_BASE,
  UCP_SCHEMA_BASE,
  UCP_SERVICE_SCHEMA_BASE,
};
