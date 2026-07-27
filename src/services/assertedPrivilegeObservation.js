'use strict';

// Who is asserting a privilege tier they cannot prove?
//
// MEASUREMENT ONLY. Nothing here changes a decision, blocks a request, or alters a response. It exists to
// answer a question that could not be answered retroactively, so the enforcement change can land on evidence
// instead of on a guess.
//
// THE DEFECT IT MEASURES. `buildRawAuthClaims` (src/api/gateway/invocation/buildInvokeIngressGatewayInput.js)
// resolves `partner_tier` from `metadata.partner_tier`, `metadata.partnerTier`, `x-pivota-partner-tier` and
// `x-partner-tier` — every one of them REQUEST-CONTROLLED — and `req.invokeAuth` carries no tier at all, so
// there is no authenticated source to compare against. `partnerTierPolicies.js` then hands `flagship` a
// 90 rpm / 12,000-per-day budget and `allow_checkout_handoff`. A caller can assert its own privilege tier.
//
// WHY THIS SHIPS BEFORE THE FIX. The no-fallback fix is to delete the request-controlled sources and refuse a
// request that asserts a tier it cannot prove. But with every source deleted, every caller resolves to `none`,
// and `none` means `public_api_agent` (20 rpm) or `unknown` (0 rpm). Shipping that blind risks throttling a
// live partner to zero. Railway's retained log window carried no invoke lines with tier fields, so the
// question was unanswerable looking backwards. This makes it answer itself going forwards, in days.
//
// SILENT BY DESIGN UNLESS THE ASSERTION CAN MATTER. The observer returns null unless a request asserts
// something that would actually change identity downstream, so on a healthy corpus this emits ZERO lines and
// any line at all is a finding. That keeps it off the hot path's log budget (`find_products_multi` is the
// highest-volume op here) AND denies an anonymous caller the ability to generate log lines at will.
//
// NEVER LOGS A CREDENTIAL. `key_fingerprint` is already a fingerprint (see fingerprintSecret); raw tokens,
// API keys and checkout tokens are not read here at all.
//
// AND NEVER LOGS AN UNBOUNDED CALLER STRING. `partner_tier` arrives from request metadata OR from the
// `x-partner-tier` header, and `GET /agent/v1/products/search` reaches handleInvokeRequest with NO AUTH — so
// an anonymous caller controls that header. A verbatim, uncapped value there is a log-flood amplifier
// (10mb body limit on the authenticated route, ~16KB headers on the anonymous one) dressed up as
// observability. Two independent bounds: the raw value is truncated to RAW_TIER_MAX_CHARS, and the observer
// stays SILENT unless the assertion actually has an effect (see below), so junk never reaches the log at all.

const { normalizePartnerTier } = require('../api/gateway/invocation/buildInvokeIngressGatewayInput');

// Long enough that a real tier ('flagship') is never truncated, short enough that the field cannot be an
// amplifier. Truncation is flagged rather than silent, so a reader can tell a capped value from a real one.
const RAW_TIER_MAX_CHARS = 64;

// Where a tier can be asserted from, in the same precedence order buildRawAuthClaims applies. Kept in step
// with that function — if a source is added there and not here, the observation under-reports and the
// enforcement decision is made on incomplete data.
const PARTNER_TIER_SOURCES = Object.freeze([
  { source: 'metadata.partner_tier', read: (ctx) => ctx.metadata.partner_tier },
  { source: 'metadata.partnerTier', read: (ctx) => ctx.metadata.partnerTier },
  { source: 'header:x-pivota-partner-tier', read: (ctx) => ctx.header('x-pivota-partner-tier') },
  { source: 'header:x-partner-tier', read: (ctx) => ctx.header('x-partner-tier') },
]);

// The same self-assertion pattern on the other identity fields buildRawAuthClaims reads from metadata. Not
// the primary question, but they are the same defect family and cost nothing to count while we are here.
const OTHER_ASSERTED_FIELDS = Object.freeze([
  { field: 'org_id', read: (ctx) => firstNonEmpty(ctx.metadata.org_id, ctx.metadata.orgId, ctx.header('x-pivota-org-id'), ctx.header('x-org-id')) },
  { field: 'agent_id', read: (ctx) => firstNonEmpty(ctx.metadata.agent_id, ctx.metadata.agentId) },
  { field: 'principal_id', read: (ctx) => firstNonEmpty(ctx.metadata.principal_id, ctx.metadata.principalId) },
]);

function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function readHeaderFrom(headers) {
  return (name) => {
    if (!headers || typeof headers !== 'object') return '';
    const direct = headers[name];
    if (typeof direct === 'string') return direct.trim();
    const lower = String(name).toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() === lower && typeof value === 'string') return value.trim();
    }
    return '';
  };
}

/**
 * The tier the CREDENTIAL proves, as opposed to the one the request claims.
 *
 * Returns null today for every caller, and that is the finding rather than a stub: introspection
 * (`introspectInvokeApiKey`) returns agent-level identity only — `agent_id`, `auth_source`, `key_fingerprint`
 * — and no tier. Isolated here so that when a tier IS added to the credential, the comparison below starts
 * working with a one-line change and the emitted field is already named.
 */
function resolveCredentialPartnerTier(invokeAuth = {}) {
  const fromAuth = firstNonEmpty(invokeAuth?.partner_tier, invokeAuth?.partnerTier);
  return fromAuth || null;
}

/**
 * @returns {object|null} an observation to log, or null when the request asserts nothing that can have an
 *   effect — which is the common case, and the case an attacker can force.
 */
function observeAssertedPrivilege({ req = {}, routeContext = {}, operation = '', metadata = {} } = {}) {
  const ctx = {
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    header: readHeaderFrom(req?.headers),
  };

  let assertedTier = '';
  let assertedTierSource = null;
  for (const candidate of PARTNER_TIER_SOURCES) {
    const value = firstNonEmpty(candidate.read(ctx));
    if (value) {
      assertedTier = value;
      assertedTierSource = candidate.source;
      break;
    }
  }

  const otherAsserted = OTHER_ASSERTED_FIELDS.filter((entry) => Boolean(firstNonEmpty(entry.read(ctx)))).map(
    (entry) => entry.field,
  );

  // THE VALUE THE REAL CODE WOULD ACTUALLY USE, from the real function. `buildRawAuthClaims` runs the
  // asserted string through normalizePartnerTier and then OMITS the key entirely when the result is 'none'
  // (buildInvokeIngressGatewayInput.js:339). So `bogus`, `ADMIN`, `flag-ship` — and the entirely plausible
  // literal `"none"` — produce identity byte-identical to asserting nothing at all. Comparing the RAW string
  // would score every one of them as a downgrade, and since this counter's whole purpose is a go/no-go
  // ("a sustained zero is the green light"), a corpus of harmless junk would make the criterion unreachable:
  // the measurement could only ever block the safe change it exists to unblock.
  const effectiveTier = normalizePartnerTier(assertedTier);
  const hasEffect = effectiveTier !== 'none';

  // SILENT WHEN THE ASSERTION CANNOT MATTER. This is a correctness rule and a safety rule at once: a value
  // that normalizes to 'none' changes nothing downstream, so logging it is noise — and because the
  // `x-partner-tier` header is reachable unauthenticated, logging it is noise an anonymous caller can
  // generate at will. With this rule the only tier values that ever reach the log are 'flagship' and
  // 'approved', i.e. an allowlist of two.
  if (!hasEffect && otherAsserted.length === 0) return null;

  const credentialTier = resolveCredentialPartnerTier(req?.invokeAuth);
  const rawTier = assertedTier.slice(0, RAW_TIER_MAX_CHARS);

  return {
    event: 'invoke_asserted_privilege',
    operation: String(operation || '').trim().toLowerCase() || null,
    client_channel: String(routeContext?.client_channel || '').trim() || null,

    // WHAT WAS CLAIMED, and from where. Bounded — see RAW_TIER_MAX_CHARS.
    asserted_partner_tier: rawTier || null,
    asserted_partner_tier_truncated: assertedTier.length > RAW_TIER_MAX_CHARS,
    asserted_partner_tier_source: assertedTierSource,

    // WHAT THE CODE WOULD ACTUALLY USE. Compare against this, never against the raw string.
    effective_partner_tier: effectiveTier,

    // WHAT THE CREDENTIAL PROVES. null today for everyone — see resolveCredentialPartnerTier.
    credential_partner_tier: credentialTier,

    // THE DECISION FIELD. True means enforcement would take a privilege this request currently HAS. Counting
    // these by key_fingerprint over a few days is exactly the input the enforcement change needs, and a
    // sustained zero is the green light to ship it. Keyed on the EFFECTIVE tier, so an assertion that already
    // resolves to 'none' can never hold the gate shut.
    enforcement_would_downgrade: hasEffect && effectiveTier !== credentialTier,

    // WHO. Fingerprint, never the key itself.
    key_fingerprint: req?.invokeAuth?.key_fingerprint || routeContext?.key_fingerprint || null,
    agent_id: req?.invokeAuth?.agent_id || routeContext?.agent_id || null,
    auth_mode: req?.invokeAuth?.auth_mode || routeContext?.auth_mode || null,
    auth_source: req?.invokeAuth?.auth_source || routeContext?.auth_source || null,

    // The same self-assertion pattern on the sibling identity fields. Names only — the VALUES are
    // caller-supplied strings that could carry anything, and this is a measurement, not an audit trail.
    other_asserted_fields: otherAsserted,
  };
}

module.exports = {
  observeAssertedPrivilege,
  RAW_TIER_MAX_CHARS,
  resolveCredentialPartnerTier,
  PARTNER_TIER_SOURCES,
  OTHER_ASSERTED_FIELDS,
};
