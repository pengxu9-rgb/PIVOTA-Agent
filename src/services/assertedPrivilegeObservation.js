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

// THE REAL RULES, not a copy of them. `buildRawAuthClaims` is what the governance envelope actually calls, so
// reading `.partner_tier` off its output is identical-by-construction to what production decides. An earlier
// version imported only the normalizer and kept private `firstNonEmpty`/`readHeader` copies; they disagreed
// with the originals on array-valued and falsy inputs, and the disagreement produced FALSE NEGATIVES — a
// caller demonstrably holding `flagship_partner` (90 rpm, deep_resolution, deep offer fields) that the
// measurement never counted. A false negative here is strictly worse than the false positive it replaced: it
// makes "a sustained zero" REACHABLE while a live partner is silently on flagship, which is exactly the
// throttle-a-live-partner outcome this whole exercise exists to prevent.
const {
  buildRawAuthClaims,
  firstNonEmptyString,
  readHeader,
} = require('../api/gateway/invocation/buildInvokeIngressGatewayInput');

// Bound on any other caller-controlled string that reaches the log line. `operation` is caller-supplied on
// POST /agent/v1/invoke and the observer runs before schema validation.
const MAX_ECHOED_CHARS = 64;

// Long enough that a real tier ('flagship') is never truncated, short enough that the field cannot be an
// amplifier. Truncation is flagged rather than silent, so a reader can tell a capped value from a real one.
const RAW_TIER_MAX_CHARS = 64;

// Where a tier can be asserted from, in the same precedence order buildRawAuthClaims applies. Kept in step
// with that function — if a source is added there and not here, the observation under-reports and the
// enforcement decision is made on incomplete data.
const PARTNER_TIER_SOURCES = Object.freeze([
  { source: 'metadata.partner_tier', read: (ctx) => firstNonEmptyString(ctx.metadata.partner_tier) },
  { source: 'metadata.partnerTier', read: (ctx) => firstNonEmptyString(ctx.metadata.partnerTier) },
  { source: 'header:x-pivota-partner-tier', read: (ctx) => readHeader(ctx.headers, 'x-pivota-partner-tier') },
  { source: 'header:x-partner-tier', read: (ctx) => readHeader(ctx.headers, 'x-partner-tier') },
]);

// The other identity fields buildRawAuthClaims reads from caller-controlled input. Counted for completeness,
// but NOT the same defect as the tier, and the difference is worth stating because it is counter-intuitive:
// asserting `org_id` alone promotes principal_type to 'partner' while leaving partner_tier at 'none', and
// resolvePartnerTierPolicy then falls through to the `unknown` profile — 0 rpm, no allowed layers. Measured:
// no headers -> public_api_agent 20 rpm; x-org-id only -> unknown 0 rpm. So org_id assertion is a SELF-DoS,
// not an escalation, and enforcement would HELP such a caller rather than throttle them.
const OTHER_ASSERTED_FIELDS = Object.freeze([
  {
    field: 'org_id',
    read: (ctx) =>
      firstNonEmptyString(
        ctx.metadata.org_id,
        ctx.metadata.orgId,
        readHeader(ctx.headers, 'x-pivota-org-id'),
        readHeader(ctx.headers, 'x-org-id'),
      ),
  },
  { field: 'agent_id', read: (ctx) => firstNonEmptyString(ctx.metadata.agent_id, ctx.metadata.agentId) },
  {
    field: 'principal_id',
    read: (ctx) => firstNonEmptyString(ctx.metadata.principal_id, ctx.metadata.principalId),
  },
]);

/**
 * The tier the CREDENTIAL proves, as opposed to the one the request claims.
 *
 * Returns null today for every caller, and that is the finding rather than a stub: introspection
 * (`introspectInvokeApiKey`) returns agent-level identity only — `agent_id`, `auth_source`, `key_fingerprint`
 * — and no tier. Isolated here so that when a tier IS added to the credential, the comparison below starts
 * working with a one-line change and the emitted field is already named.
 */
function resolveCredentialPartnerTier(invokeAuth = {}) {
  const fromAuth = firstNonEmptyString(invokeAuth?.partner_tier, invokeAuth?.partnerTier);
  return fromAuth || null;
}

/**
 * @returns {object|null} an observation to log, or null when the request asserts nothing that can have an
 *   effect — which is the common case, and the case an attacker can force.
 */
function observeAssertedPrivilege({ req = {}, routeContext = {}, operation = '', metadata = {} } = {}) {
  const safeMetadata = metadata && typeof metadata === 'object' ? metadata : {};
  const ctx = { metadata: safeMetadata, headers: req?.headers };

  let assertedTier = '';
  let assertedTierSource = null;
  for (const candidate of PARTNER_TIER_SOURCES) {
    const value = candidate.read(ctx) || '';
    if (value) {
      assertedTier = value;
      assertedTierSource = candidate.source;
      break;
    }
  }

  const otherAsserted = OTHER_ASSERTED_FIELDS.filter((entry) => Boolean(entry.read(ctx))).map(
    (entry) => entry.field,
  );

  // THE VALUE THE REAL CODE WOULD ACTUALLY USE, from the real function. `buildRawAuthClaims` runs the
  // asserted string through normalizePartnerTier and then OMITS the key entirely when the result is 'none'
  // (buildInvokeIngressGatewayInput.js:339). So `bogus`, `ADMIN`, `flag-ship` — and the entirely plausible
  // literal `"none"` — produce identity byte-identical to asserting nothing at all. Comparing the RAW string
  // would score every one of them as a downgrade, and since this counter's whole purpose is a go/no-go
  // ("a sustained zero is the green light"), a corpus of harmless junk would make the criterion unreachable:
  // the measurement could only ever block the safe change it exists to unblock.
  // Ask the REAL builder, on the REAL inputs. It normalizes and then omits the key when the answer is 'none',
  // so `|| 'none'` here reproduces production exactly — including for array-valued and falsy inputs, which a
  // reimplementation got wrong in the false-negative direction.
  const effectiveTier = buildRawAuthClaims(req, routeContext, safeMetadata).partner_tier || 'none';
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
    operation: String(operation || '').trim().toLowerCase().slice(0, MAX_ECHOED_CHARS) || null,
    client_channel: String(routeContext?.client_channel || '').trim() || null,

    // WHAT WAS CLAIMED, and from where. Bounded — see RAW_TIER_MAX_CHARS.
    asserted_partner_tier: rawTier || null,
    asserted_partner_tier_truncated: assertedTier.length > RAW_TIER_MAX_CHARS,
    asserted_partner_tier_source: assertedTierSource,

    // WHAT THE CODE WOULD ACTUALLY USE, straight from buildRawAuthClaims. Compare against this, never the raw
    // string — and note the two can differ legitimately (`FLAGSHIP` -> `flagship`, `['flagship','x']` -> the
    // first element) as well as illegitimately.
    effective_partner_tier: effectiveTier,

    // A tier WAS asserted but resolves to nothing. Costs no extra line (this only rides lines that emit for
    // another reason) and answers the second half of the enforcement design: the "refuse an unprovable
    // assertion" flavour would turn these callers' 200s into 4xx, which the downgrade counter cannot see.
    asserted_tier_ignored: Boolean(assertedTier) && !hasEffect,

    // WHAT THE CREDENTIAL PROVES. null today for everyone — see resolveCredentialPartnerTier.
    credential_partner_tier: credentialTier,

    // THE DECISION FIELD. True means enforcement would take a privilege this request currently HAS. Counting
    // these by key_fingerprint over a few days is exactly the input the enforcement change needs, and a
    // sustained zero is the green light to ship it — specifically, a sustained zero among lines with a
    // NON-NULL key_fingerprint. Anonymous callers reach this ingress (GET /agent/v1/products/search has no
    // auth middleware), so a header-fuzzing bot can otherwise hold the gate shut forever with lines that
    // identify nobody. Keyed on the EFFECTIVE tier, so an assertion that already resolves to 'none' cannot
    // hold it shut either.
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
  MAX_ECHOED_CHARS,
  resolveCredentialPartnerTier,
  PARTNER_TIER_SOURCES,
  OTHER_ASSERTED_FIELDS,
};
