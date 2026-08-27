// SHARED buyer / address / item-identity INTAKE for every protocol door (ACP REST, MCP, and whatever comes
// next). This module is the ONE definition of three rules that a door must not get subtly different:
//
//   1. ATTESTED-WINS PRECEDENCE — an email attested by a verified buyer credential beats a caller-supplied
//      one, always. A body value can only ever fill a gap.
//   2. THE REQUIRED-ADDRESS FIELD SET — pivota-backend `_coerce_shipping_address` requires all five of
//      name, address_line1, city, postal_code, country. A partial address is refused at intake.
//   3. THE VARIANT-RESOLUTION RULE — resolve a product's default variant through the canonical `get_product`
//      read; NEVER synthesise a variant id from a product id; refuse when resolution is ambiguous, impossible,
//      or answered about a different product.
//
// WHY IT LIVES HERE AND NOT IN A DOOR. All three were first implemented in acpRestAdapter.js (#1918). The MCP
// commerce door had the SAME three defects, reachable by real callers, and two of them are money-correctness
// bugs: a `sku_id`-only cart priced as an EMPTY cart, and a `product_id`-only cart priced against
// `variant_id === product_id` — a forged identity the catalog never issued. Copying the ACP door's logic into
// the MCP door would have recreated the twin-drift class this codebase keeps paying for (see
// services/pdpRenderability.js for what re-derivation costs when the twins drift), so the logic MOVED here and
// both doors import it. Changing a rule now changes it for every door, or fails a test in both.
//
// JOSE-FREE BY CONSTRUCTION. mcp-server imports this module, and mcp-server is deliberately jose-free (see
// docs/agent-checkout/GO_LIVE_protocol_edge.md: "mcp-server is jose-free; injected so safety-kernel never
// imports it"). `attestedBuyerFromClaims` therefore lives HERE rather than in identity/userTokenVerifier.js
// (which imports `jose`); that module re-exports it so every existing importer is unaffected. Nothing in this
// file imports anything but the shared error taxonomy.

import { PivotaCommerceError } from '../errors.js';

const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';
// The prototype guard, moved VERBATIM from acpRestAdapter.js: it admits `Object.prototype` and a null
// prototype specifically, and nothing else. A bare own-property test in its place would admit rows carrying a
// hostile prototype and misclassify them as plain data.
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const str = (v) => (typeof v === 'string' ? v : undefined);
const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

/** Copy ONLY the named own properties; never __proto__/constructor/prototype (defends against pollution). */
export function pickFields(src, keys) {
  const out = {};
  if (!isPlainObject(src)) return out;
  for (const k of keys) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

// ---- intake refusals ---------------------------------------------------------------------------------------

/**
 * An intake refusal carrying a curated message + a structured `detail` block.
 *
 * `code` stays one of the contract-stable PivotaErrorCodes (clients already branch on it); the specific,
 * actionable fact lives in the message and in `detail`, exactly as the delegate_payment refusal does. The
 * `acp_detail` key is an EXPLICIT opt-in read by each door's error mapper — ordinary PivotaCommerceError
 * detail (which can carry ids and internal reasons) is still never surfaced.
 *
 * The `acp_`prefix is HISTORICAL: these keys were named at the ACP door and ACP clients already branch on
 * them, so renaming them would break a live contract for no behavioural gain. Read them through
 * `surfaceableIntakeRefusal` rather than by hand, which is what makes the prefix a private detail of this
 * module rather than a fact every door has to know.
 */
export function intakeRefusal(code, reason, message, extra = {}) {
  return new PivotaCommerceError(code, {
    reason,
    acp_message: message,
    acp_detail: { reason, ...extra },
  });
}

/**
 * Is this error an intake refusal whose curated message/detail is SAFE to surface to the caller?
 *
 * Returns `{ message, detail }` for one, `null` for anything else. The generic per-code `userMessage` is
 * useless at an intake refusal — QUOTE_REQUIRED's is "I need a fresh price quote before placing this order.",
 * which tells an agent nothing about the missing email or the ambiguous variant — so every door surfaces the
 * curated message instead. By construction an intake detail names FIELDS only, never a value taken from the
 * request, so it carries no PII.
 */
export function surfaceableIntakeRefusal(err) {
  if (!(err instanceof PivotaCommerceError)) return null;
  const detail = isPlainObject(err.detail?.acp_detail) ? err.detail.acp_detail : null;
  if (!detail) return null;
  return {
    message: nonEmpty(err.detail.acp_message) ? err.detail.acp_message : err.userMessage,
    detail: { ...detail },
  };
}

// ---- 1. buyer identity: ATTESTED WINS -----------------------------------------------------------------------

// Conservative address shape. Deliberately NOT an RFC-5322 parser: this only has to reject the shapes a
// downstream order/receipt system cannot use, and anything it lets through the backend validates again.
const EMAIL_SHAPE = /^[^\s@,;<>"'\\]+@[^\s@,;<>"'\\]+\.[^\s@,;<>"'\\]{2,}$/;

/** Trim + shape-check an email. Returns undefined for anything unusable — NEVER echoes the input. */
export function normalizeEmail(value) {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v && EMAIL_SHAPE.test(v) ? v : undefined;
}

/**
 * ATTESTED buyer identity fields, read from claims a verified token already carried.
 *
 * `email` is taken ONLY when the IdP has not explicitly disclaimed it: an OIDC `email_verified: false`
 * means "the issuer is asserting an address it has NOT confirmed", which is not an attestation, so it is
 * treated as ABSENT (a caller-supplied address may then be used instead) — as is any other FALSY value for
 * that claim, since a non-conformant `"false"`/`0` is still the issuer disclaiming. A MISSING `email_verified` is
 * accepted — many issuers omit it — because the claim still comes from inside a signature-verified token,
 * which is strictly stronger than a value typed into a request body by the calling agent.
 *
 * Pure and side-effect free. It NEVER contributes to `user_ref` (ownership stays `iss|sub`), and it never
 * widens what a verifier accepts — a token without these claims verifies exactly as it does today.
 */
export function attestedBuyerFromClaims(claims) {
  if (claims == null || typeof claims !== 'object' || Array.isArray(claims)) return {};
  const out = {};
  const email = trimmed(claims.email);
  // A PRESENT `email_verified` that does not affirmatively say "yes" is a disclaimer (review F4). OIDC
  // says boolean, but a non-conformant IdP emitting `"false"`/`"0"`/`0` must not have its disclaimed
  // address promoted to attested — and note `"false"` is a TRUTHY string, so a plain falsy test misses
  // exactly the case worth defending against. `undefined`/absent is NOT a disclaimer: many IdPs omit it.
  const ev = claims.email_verified;
  const affirmed = ev === true || (typeof ev === 'string' && ['true', '1', 'yes'].includes(ev.trim().toLowerCase()));
  const disclaimed = 'email_verified' in claims && !affirmed;
  if (email && !disclaimed && EMAIL_SHAPE.test(email)) out.attested_email = email;
  const name = trimmed(claims.name)
    || [trimmed(claims.given_name), trimmed(claims.family_name)].filter(Boolean).join(' ');
  if (name) out.attested_name = name;
  return out;
}

/**
 * Normalize whatever a door's identity resolver produced into `{ attested_email, attested_name }`.
 *
 * A malformed attested address is treated as ABSENT rather than fatal: it is the IdP's field, the buyer
 * cannot fix it, and the body fallback is then allowed to supply a usable one.
 */
export function normalizeAttestedBuyer(identity) {
  const id = isPlainObject(identity) ? identity : {};
  return {
    attested_email: normalizeEmail(id.customer_email ?? id.attested_email),
    attested_name: nonEmpty(id.customer_name ?? id.attested_name)
      ? (id.customer_name ?? id.attested_name).trim()
      : undefined,
  };
}

// The ACCEPTED FIELD NAMES differ per door, so the message is built per door rather than shared. A shared
// message told MCP callers to supply `buyer.email` — a field that door's allowlist silently strips, so a
// model following the advice retried and was refused identically. A refusal that misdirects is worse than
// a terse one: it burns a retry and teaches the wrong contract.
const DEFAULT_EMAIL_BODY_FIELDS = ['customer_email'];

export function buyerEmailRequiredMessage(acceptedBodyFields = DEFAULT_EMAIL_BODY_FIELDS) {
  const fields = acceptedBodyFields.map((f) => `\`${f}\``).join(' (or ');
  const closing = acceptedBodyFields.length > 1 ? ')'.repeat(acceptedBodyFields.length - 1) : '';
  return [
    'A buyer email is required to create a checkout session.',
    `Supply it as ${fields}${closing} in the request body, or present a buyer credential whose`,
    'verified claims carry an `email`. An attested email from the buyer credential always wins; a body value is',
    'used only when the credential carries none.',
  ].join(' ');
}

/**
 * THE PRECEDENCE RULE, in one place.
 *
 * The attested address is read FIRST, so a caller-supplied value can only ever fill a gap and can NEVER
 * override what the verified buyer credential asserted. The body candidates are not even parsed when an
 * attested one exists, so a malformed or hostile body email is inert on that path.
 *
 * Throws the named refusal when neither source yields a usable address: this is the only point at which
 * `buyer_context` can still be fixed cheaply, and without it pivota-backend `POST /agent/v2/orders` answers
 * an opaque 400 INVALID_BUYER_CONTEXT several calls later — after the agent has already presented a payment
 * credential.
 */
export function resolveBuyerEmail(attested_email, bodyCandidates = [], { acceptedBodyFields } = {}) {
  if (nonEmpty(attested_email)) return attested_email.trim();
  for (const candidate of bodyCandidates) {
    const email = normalizeEmail(candidate);
    if (email) return email;
  }
  const fields = Array.isArray(acceptedBodyFields) && acceptedBodyFields.length
    ? acceptedBodyFields
    : DEFAULT_EMAIL_BODY_FIELDS;
  throw intakeRefusal('QUOTE_REQUIRED', 'acp_buyer_email_required', buyerEmailRequiredMessage(fields), {
    accepted_body_fields: [...fields],
    attested_source: 'buyer_credential_claims.email',
    attested_wins: true,
  });
}

/** Same precedence, but a name is OPTIONAL — an absent one is not a refusal. */
export function resolveBuyerName(attested_name, bodyCandidates = []) {
  if (nonEmpty(attested_name)) return attested_name.trim();
  for (const candidate of bodyCandidates) {
    if (nonEmpty(candidate)) return candidate.trim();
  }
  return undefined;
}

/** `first last`, skipping whatever is absent. Undefined when nothing usable was supplied. */
export function joinName(first, last) {
  const parts = [first, last].filter((p) => nonEmpty(p)).map((p) => p.trim());
  return parts.length ? parts.join(' ') : undefined;
}

// ---- 2. address: OPTIONAL, but COMPLETE IF PRESENT ----------------------------------------------------------
//
// Optional, because a door may legitimately price before the buyer picks a destination (ACP does exactly
// this, and both doors have an update op that genuinely re-maps the address into a fresh snapshot).
// Requiring one at create would refuse a spec-legal request the protocol expects to succeed.
//
// Complete-if-present, because a PARTIAL address is worse than none: it silently prices shipping/tax against
// a destination the order lane will then REJECT, and the caller does not find out until completion.
//
// `recipient_name` is preserved (not renamed): both src/server.js buildInvokeBuyerContext and the kernel's
// normalizeBuyerAddress already map recipient_name -> name. `name` is carried through as well, so a caller
// using the plain spelling is not silently stripped of the recipient.

/** The five fields pivota-backend `_coerce_shipping_address` requires, in its own order. */
export const REQUIRED_ADDRESS_FIELDS = Object.freeze(['name', 'address_line1', 'city', 'postal_code', 'country']);

/** Everything a door carries through when an address is supplied. */
export const INTAKE_ADDRESS_FIELDS = Object.freeze([
  'country', 'city', 'state', 'postal_code', 'address_line1', 'address_line2', 'name', 'recipient_name', 'phone',
]);

// Per door, for the same reason as the email message: the ACP door names a concrete REST endpoint, the
// MCP door names its tool. The genericised 'the update op' wording dropped the endpoint the sentence
// existed to supply, which is what an ACP client reads out of `body.message`.
const DEFAULT_UPDATE_HINT = 'the update op';

export function addressIncompleteMessage(updateHint = DEFAULT_UPDATE_HINT) {
  return [
    'The fulfillment address is incomplete. An address is optional here — a checkout session may be created',
    `without one and the address supplied later via ${updateHint} — but an address that IS supplied must be`,
    'complete, because order creation requires all of',
    `${REQUIRED_ADDRESS_FIELDS.join(', ')}.`,
    '(`name` may be given as `recipient_name`.)',
  ].join(' ');
}

/**
 * Allowlist-pick an address and REFUSE it if incomplete. `undefined` in -> `undefined` out (absent is legal).
 *
 * The refusal names the MISSING FIELDS and nothing else: an address is PII and must never reach an error body
 * or a log line, so nothing here echoes the value it rejected.
 */
export function pickCompleteAddress(raw, { updateHint } = {}) {
  if (!isPlainObject(raw)) return undefined;
  const out = pickFields(raw, INTAKE_ADDRESS_FIELDS);
  const effective = { ...out, name: nonEmpty(out.name) ? out.name : out.recipient_name };
  const missing = REQUIRED_ADDRESS_FIELDS.filter((f) => !nonEmpty(effective[f]));
  if (missing.length) {
    throw intakeRefusal('QUOTE_REQUIRED', 'acp_fulfillment_address_incomplete', addressIncompleteMessage(updateHint), {
      missing_fields: missing,
      required_fields: [...REQUIRED_ADDRESS_FIELDS],
    });
  }
  return out;
}

// ---- 3. item identity: RESOLVE, DON'T FORGE, AND DON'T REFUSE WHAT IS RESOLVABLE ------------------------------
//
// An earlier revision of the ACP door refused ANY item without a real `variant_id`. That refusal was
// UNSATISFIABLE from Pivota's own ACP feed, which publishes `{id (sig_*), title, price, brand, availability,
// currency, description, image_link, link}` and NO variant identity whatsoever — so an agent that discovered a
// product through GET /acp/feed had nowhere to obtain a variant_id and could never open a checkout session.
//
// A door therefore RESOLVES the product's default variant, and refuses only when resolution is genuinely
// ambiguous or impossible:
//   identity mismatch          -> refuse (`identity_mismatch`)
//   exactly one REAL variant   -> use it
//   zero variants              -> refuse (`no_variants`)
//   PRODUCT-GRAIN row          -> use the product id (the read DECLARED `purchase_grain: 'product'` AND
//                                 published exactly one candidate byte-equal to the product id — see the
//                                 resolver body; this is the backend's own convention for a variant-less row)
//   only restated product ids  -> refuse (`no_real_variant_identity`) — incl. `${pid}-N`, a lost variant axis
//   more than one REAL variant -> refuse (`ambiguous`, with the count — a door will not guess an option)
//   read errors/expires        -> refuse (`resolution_unavailable`)
//
// Four properties this must keep, in order of importance:
//
//  1. NEVER let a variant id that was synthesised FROM the product id reach `variant_id`. It is not enough
//     that the value "came back from the read": the read itself can manufacture one. On the UNSCOPED lane an
//     unscoped `get_product_detail` does NOT go to the backend — src/server.js routes it to this gateway's
//     own `get_pdp_v2`, whose `pdp_payload.product.variants` come from src/pdpBuilder.js `buildVariants`,
//     which FABRICATES `variant_id: product.product_id` for a product with no variants and
//     `` `${product.product_id}-${idx+1}` `` for a variant with no id of its own. Those are byte-identical to
//     the `variant_id || sku || product_id` forgery in buildQuotePreviewV2Body that this resolution exists to
//     avoid. So the resolver filters them out (isRestatedProductId) and refuses if nothing survives. A forged
//     id does not fail loudly — it PRICES A DIFFERENT CART and succeeds.
//  2. NEVER believe a read that answered about a DIFFERENT product. `merchant_id` is a caller-controlled field
//     that SELECTS BETWEEN TWO LANES with different resolution semantics, and the unscoped lane serves a
//     synthetic canonical product whose variants may be family-collapsed across merchants. The returned
//     product's identity is checked against what was ASKED for before its variants are used at all.
//  3. FAIL CLOSED. Every non-unique outcome (including a read that throws or times out) refuses the item.
//     There is no path from a failed resolution to a priced quote.
//  4. REFUSE BEFORE PRICING. Resolution runs at intake, i.e. before the executor is asked for `preview_quote`
//     — a refused request performs no pricing call and takes no inventory hold.
//
// Beyond the derived-from-product_id filter, the resolved id's SHAPE is never inspected. Live feed products
// resolve to real storefront ids (`48930014462260`) and to synthetic canonical placeholders
// (`merit:c7e0303d89a516b5::canonical`) alike; telling those apart is index-lane knowledge that must not leak
// into a protocol door. What the filter tests is not "does this look canonical" but the narrow, lane-agnostic
// question "is this string just the product id I asked about, restated" — which no legitimate variant
// identity can be, because a product with exactly one real variant still distinguishes the two.

// Every item-identity refusal keeps the SAME contract-stable code (QUOTE_REQUIRED) and the same
// `detail.reason` (`acp_item_identity_required`); `detail.variant_resolution` is what distinguishes the
// cases, and `detail.variant_count` carries the count when one is known. `required_item_fields` is kept on
// all of them because a fully-specified item resolves whatever the outcome was.
export function itemVariantRefusal(variant_resolution, message, extra = {}) {
  return intakeRefusal('QUOTE_REQUIRED', 'acp_item_identity_required', message, {
    required_item_fields: ['product_id', 'variant_id'],
    variant_resolution,
    ...extra,
  });
}

export const ITEM_PRODUCT_ID_REQUIRED_MESSAGE = [
  'Every item must carry a `product_id`.',
  'A `sku_id` alone is not resolvable at this door: the shared quote-body builder reads `sku`, not `sku_id`,',
  'so a `sku_id`-only cart prices as an EMPTY cart. `variant_id` is optional — when it is omitted this door',
  "resolves the product's default variant and refuses if that resolution is ambiguous or impossible.",
].join(' ');

export const VARIANT_NOT_RESOLVABLE_MESSAGE = [
  'No purchasable variant could be resolved for this item: the product read returned no variants.',
  'Supply `variant_id` explicitly, or re-run product discovery — as it stands this product cannot be priced.',
].join(' ');

export const variantAmbiguousMessage = (count) => [
  `This item is ambiguous: the product resolves to ${count} variants and the request names none.`,
  'Supply `variant_id` for the exact option the buyer chose. This door will not pick one for you, because',
  'guessing prices a cart the buyer did not ask for.',
].join(' ');

export const VARIANT_RESOLUTION_UNAVAILABLE_MESSAGE = [
  "The item's default variant could not be resolved: the product read failed or timed out.",
  'The request is refused rather than priced against a guessed variant. Retry, or supply `variant_id`.',
].join(' ');

export const VARIANT_NO_REAL_IDENTITY_MESSAGE = [
  'No purchasable variant could be resolved for this item: every variant the product read returned is just',
  'the requested `product_id` restated (the catalog publishes no distinct variant identity for this product),',
  'and this door will not price a `variant_id` that was derived from a `product_id`.',
  'Supply `variant_id` explicitly, or re-run product discovery.',
].join(' ');

export const PRODUCT_IDENTITY_MISMATCH_MESSAGE = [
  'This item could not be resolved: the product read answered about a different product than the one',
  'requested, so its variants are not this item`s variants and were not used.',
  'Supply `variant_id` explicitly, or re-run product discovery — and check that `merchant_id` names the',
  'merchant that actually carries this `product_id`.',
].join(' ');

// Short by design: this runs inside checkout-session creation, so it bounds how long an agent waits before
// the door answers. Overridable per-wiring.
export const DEFAULT_VARIANT_RESOLUTION_TIMEOUT_MS = 3000;

// ---- load bounds on a public create path --------------------------------------------------------------------
//
// Before these existed, intake checked only `items.length !== 0`, so ONE create with 2000 distinct products
// issued 2000 CONCURRENT upstream reads and still answered 201. And because the reads run BEFORE a door's
// create-claim, a replayed create repeats them.
//
// The numbers are deliberately generous for a real cart and deliberately finite for a load generator:
//   - 50 items: an agentic checkout cart is a handful of lines; 50 is far past any observed cart and still
//     bounds the work a single request can name.
//   - 25 distinct products: the READ count is what costs money, so it is capped SEPARATELY and LOWER than
//     the item cap. Lower is what makes it a real bound rather than a restatement of the item cap — a
//     50-line cart of one product is 1 read and stays legal; a 26-product cart is refused before any read.
//   - concurrency 6: enough that a normal cart resolves in one or two waves inside the 3s deadline, small
//     enough that an abandoned batch leaves at most 6 reads in flight instead of one per product.
export const MAX_CART_ITEMS = 50;
export const MAX_CART_DISTINCT_PRODUCTS = 25;
export const VARIANT_RESOLUTION_CONCURRENCY = 6;

const cartTooManyItemsMessage = (max) => [
  `This cart names too many line items: at most ${max} are accepted per checkout session.`,
  'Split the order across sessions.',
].join(' ');

const cartTooManyProductsMessage = (max) => [
  `This cart names too many distinct products: at most ${max} are accepted per checkout session.`,
  'Each distinct product without a `variant_id` costs an upstream catalog read, so the limit is on products,',
  'not on quantity. Split the order across sessions, or supply `variant_id` for each item.',
].join(' ');

/**
 * Allowlist + validate a cart's items. Returns fresh item objects; NOTHING is derived or synthesised here.
 *
 * Requires a non-empty items array with a scalar `product_id` and a positive safe-integer quantity each, so a
 * `{}` / `{items:[]}` body cannot drive a default/zero-item quote on a loose backend.
 *
 * `product_id` is REQUIRED: without it the shared quote-body builder silently DROPS the item from
 * `offer_refs`, so a `sku_id`-only cart prices as an EMPTY cart. `variant_id` is optional and resolved later;
 * an unusable value (empty string, non-string) is treated as ABSENT so resolution fills it rather than
 * passing junk to pricing.
 */
export function normalizeCartItems(rawItems) {
  const raw = Array.isArray(rawItems) ? rawItems : [];
  if (raw.length === 0) throw new PivotaCommerceError('QUOTE_REQUIRED', { reason: 'no_items' });
  // Cap BEFORE mapping: refusing an oversized cart must itself be cheap, and must not depend on walking it.
  if (raw.length > MAX_CART_ITEMS) {
    throw intakeRefusal('QUOTE_REQUIRED', 'acp_cart_too_many_items', cartTooManyItemsMessage(MAX_CART_ITEMS), {
      max_items: MAX_CART_ITEMS,
      item_count: raw.length,
    });
  }
  const items = raw.map((it) => {
    const item = pickFields(it, ['product_id', 'sku_id', 'variant_id', 'quantity']);
    if (!nonEmpty(item.product_id)) {
      throw itemVariantRefusal('product_id_required', ITEM_PRODUCT_ID_REQUIRED_MESSAGE);
    }
    // TRIM like `variant_id`. Untrimmed, `"p1"` / `" p1 "` / `"p1  "` are three DISTINCT cache/dedup keys —
    // three upstream reads for one product — and the unnormalized string is what would reach pricing. It is
    // also what the forged-id filter compares against, so it must be the same normalization on both sides.
    item.product_id = item.product_id.trim();
    if (nonEmpty(item.variant_id)) item.variant_id = item.variant_id.trim();
    else delete item.variant_id;
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new PivotaCommerceError('QUOTE_REQUIRED', { reason: 'item_bad_quantity' });
    }
    return item;
  });
  // Distinct products, counted on the TRIMMED value — this is the read count, i.e. the actual upstream cost.
  const distinctProducts = new Set(items.map((it) => it.product_id)).size;
  if (distinctProducts > MAX_CART_DISTINCT_PRODUCTS) {
    throw intakeRefusal('QUOTE_REQUIRED', 'acp_cart_too_many_products', cartTooManyProductsMessage(MAX_CART_DISTINCT_PRODUCTS), {
      max_distinct_products: MAX_CART_DISTINCT_PRODUCTS,
      distinct_product_count: distinctProducts,
    });
  }
  return items;
}

/**
 * Build the door's default-variant resolver over an already-composed canonical executor.
 *
 * The read is the SAME one the executor already exposes to every other protocol surface: canonical
 * `get_product` -> read('get_product_detail'). No new transport, no new credential, no second copy of the read
 * path. The canonical contract marks get_product `requiresUserRef:false, mutating:false`, so this passes no
 * gate it could weaken: no idempotency key, no session binding, no money path.
 *
 * `ctx` reaches the EXECUTOR only. canonicalExecutor's `read()` is `(backendOp, payload) => upstream(...)` —
 * it forwards no ctx — so neither `user_ref` nor `signal` reaches the upstream HTTP client today. The signal
 * is threaded anyway because it is what the LIMITER checks (an aborted batch launches no further reads); if
 * `read()` ever grows a third argument, in-flight cancellation follows for free.
 *
 * OPTIONAL MERCHANT FALLBACK (`sourceMerchantVariants`). Our catalog carries no real variant identity for the
 * seed cohort — it publishes ids restated from the product id, which the filter below correctly refuses. The
 * merchant's OWN storefront does carry them (see src/services/merchantVariantSource.js), so a door may inject
 * a source that asks it. This hook changes WHERE candidate ids come from and nothing else:
 *   * it is consulted ONLY when our own read produced no real identity — never to override or outvote one;
 *   * whatever it returns goes through the SAME `isRestatedProductId` filter and the SAME exactly-one-real
 *     rule, so property 1 holds for merchant answers exactly as for ours (a storefront that echoed our
 *     product id back would still be refused);
 *   * it runs AFTER the product-grain carve-out, so a row the read declared product-grain keeps resolving
 *     locally and never spends a network hop;
 *   * returning null/[] leaves the existing refusal exactly as it was, and a throw is caught into that same
 *     refusal — there is no path from a failed merchant lookup to a priced cart.
 *
 * @param {{ executor: {execute:Function}, timeoutMs?: number,
 *           sourceMerchantVariants?: (productRead:object, product_id:string, ctx:object)=>Promise<string[]|null> }} deps
 * @returns {(items:Array, merchant_id:string|undefined, ctx:object)=>Promise<void>} mutates items in place
 */
export function createDefaultVariantResolver({ executor, timeoutMs, sourceMerchantVariants } = {}) {
  if (!executor || typeof executor.execute !== 'function') {
    throw new Error('createDefaultVariantResolver requires a canonical executor with execute()');
  }
  // Bounded so a slow or hanging product read can never add an unbounded stall to session creation. The whole
  // batch shares ONE deadline, so a 20-item cart costs the same wall clock as a 1-item cart. Expiry is a
  // REFUSAL, never a fall-through.
  const deadlineMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_VARIANT_RESOLUTION_TIMEOUT_MS;

  // The read is IDENTITY-CHECKED before its variants are believed: see assertProductIdentity.
  async function readProductVariantIds(product_id, merchant_id, ctx, signal) {
    const product = { product_id };
    if (nonEmpty(merchant_id)) product.merchant_id = merchant_id;
    const result = await executor.execute('get_product', { payload: { product } }, { ...ctx, signal });
    assertProductIdentity(result, product_id, merchant_id);
    // The RAW read rides along so an injected merchant source can use the storefront pointer the read
    // already carries (the seed lane publishes the merchant PDP url on the product). No second read of our
    // own catalog, and nothing downstream reads `raw` unless a source was injected.
    return { ids: variantIdsFromProductRead(result), productGrain: isProductGrainRead(result), raw: result };
  }

  /**
   * Fill in `variant_id` for every item that arrived without one. FAIL-CLOSED at every exit: a read that
   * throws, expires, answers about a DIFFERENT product, resolves nothing, resolves only ids restated from the
   * requested product_id, or resolves more than one candidate REFUSES the item.
   *
   * LOAD NOTE: this runs BEFORE a door's create-claim, so a refused cart does not consume a dedup slot — but
   * it also means a REPLAYED create re-reads instead of short-circuiting on the claim. Nothing here dedupes
   * across requests, so the per-cart CAPS + the concurrency limiter are the only things bounding the load a
   * public create path can generate; do not remove them.
   */
  return async function resolveDefaultVariants(items, merchant_id, ctx) {
    const needing = items.filter((it) => !nonEmpty(it.variant_id));
    if (needing.length === 0) return;
    // One read per DISTINCT product_id (the same product twice in a cart is one lookup). product_id is
    // already trimmed by normalizeCartItems, so " p1 " and "p1" collapse to ONE read rather than two.
    const productIds = [...new Set(needing.map((it) => it.product_id))];
    // One controller for the whole batch: the shared deadline aborts it, and the limiter stops launching
    // queued reads the moment it is aborted. Without this a 50-product cart kept every read running long
    // after the door had already answered.
    const controller = new AbortController();
    let resolved;
    try {
      resolved = await withDeadline(
        mapWithConcurrency(productIds, VARIANT_RESOLUTION_CONCURRENCY, (pid) => readProductVariantIds(pid, merchant_id, ctx, controller.signal), controller),
        deadlineMs,
        controller,
      );
    } catch (err) {
      // A NAMED intake refusal (identity mismatch) is already curated and value-free — surface it, so ops can
      // tell "the read answered about another product" apart from "the read failed". Anything else is an
      // errored/expired lookup: the internal cause is never surfaced (it can carry ids and upstream detail);
      // the caller is told what is actionable — retry, or name the variant.
      if (err instanceof PivotaCommerceError && isPlainObject(err.detail?.acp_detail)) throw err;
      throw itemVariantRefusal('resolution_unavailable', VARIANT_RESOLUTION_UNAVAILABLE_MESSAGE);
    }
    const byProduct = new Map(productIds.map((pid, i) => [pid, resolved[i]]));

    // MERCHANT SOURCING RUNS AS A BATCH, BEFORE THE ITEM LOOP — never inside it.
    //
    // The loop below is sequential, so asking the storefront from inside it made a cart of N DISTINCT
    // products cost N lookups END TO END, each up to the source's own deadline (~50 x 6s past a 3s batch
    // deadline for a full cart) — an unbounded stall the batch deadline above had already been designed to
    // prevent for our OWN reads. Per-product deduping fixed only the repeated-line case; distinct products
    // were still serial. So the products that need a storefront are computed FIRST, then resolved through
    // the same limiter + deadline + controller our own reads use.
    //
    // WHICH PRODUCTS NEED ONE is decided here exactly as the loop decides it: our read published no REAL
    // identity, and the product-grain carve-out does not apply. The loop is still the only place that
    // ACCEPTS an id — this pass only pre-fetches candidates for it, so no verdict moves out of the loop.
    //
    // ABORT, STATED HONESTLY: an expired deadline stops us WAITING and stops the limiter LAUNCHING further
    // lookups. It does not cancel an HTTP request already in flight — the UCP client owns its own per-call
    // timeout and accepts no external signal — so the bound this buys is on INTAKE latency, not on the
    // merchant's socket.
    const merchantByProduct = new Map();
    if (typeof sourceMerchantVariants === 'function') {
      const needMerchant = productIds.filter((pid) => {
        const read = byProduct.get(pid);
        if (!read) return false;
        if (read.ids.some((id) => !isRestatedProductId(id, pid))) return false; // our read already answered
        if (read.productGrain && read.ids.every((id) => id === pid) && read.ids.length <= 1) return false;
        return true;
      });
      if (needMerchant.length > 0) {
        const merchantController = new AbortController();
        let merchantResults = [];
        try {
          merchantResults = await withDeadline(
            mapWithConcurrency(
              needMerchant,
              VARIANT_RESOLUTION_CONCURRENCY,
              async (pid) => {
                if (merchantController.signal.aborted) return null;
                try {
                  return await sourceMerchantVariants(byProduct.get(pid).raw, pid, { ...ctx, signal: merchantController.signal });
                } catch {
                  return null; // fail closed; the loop's existing refusal stands for this product
                }
              },
              merchantController,
            ),
            deadlineMs,
            merchantController,
          );
        } catch {
          merchantResults = []; // a blown deadline refuses every product it covered, exactly as before
        }
        needMerchant.forEach((pid, i) => merchantByProduct.set(pid, merchantResults[i] ?? null));
      }
    }

    for (const it of needing) {
      const read = byProduct.get(it.product_id) ?? { ids: [], productGrain: false, raw: null };
      const candidates = read.ids;
      // THE central filter. A candidate that is the requested product_id, or the requested product_id plus a
      // separator, carries no identity of its own — it is the product id restated. src/pdpBuilder.js
      // buildVariants MANUFACTURES exactly those two shapes when an upstream product has no variants
      // (`variant_id: product.product_id`) or has variants with no ids (`${product.product_id}-${idx+1}`),
      // and the UNSCOPED lane serves these doors straight out of that builder. Accepting one would write the
      // very `variant_id === product_id` forgery this exists to eliminate — and it would do it silently,
      // pricing a cart nobody asked for.
      const real = candidates.filter((id) => !isRestatedProductId(id, it.product_id));
      if (real.length === 0) {
        // PRODUCT-GRAIN ROW: the read SAID, in a typed field, that the row carries no variant axis and its one
        // canonical variant IS the product (pdpBuilder `purchase_grain: 'product'`; the backend's own
        // canonicalization makes the same choice — agent_v2 _canonicalize_search_product prices such a row as
        // offer::<merchant>::<product_id>). For that row `variant_id === product_id` is not a forgery: it is
        // the purchasable identity, priced at exactly what the PDP and search showed. Accept it ONLY under all
        // three of: the read declared the grain (a typed field — property 1 is intact, nothing here reads the
        // SHAPE of an id), the read published AT MOST one candidate, and any candidate is BYTE-EQUAL to the
        // requested product_id (a `${pid}-N` restatement means a variant axis whose identity was lost, and
        // there pricing WOULD guess — still refused below). ZERO candidates under the declaration is the same
        // row one step later: measured on prod 2026-08-18, 3 of 24 sampled seed rows publish `variants: []`
        // because the PDP's visibility rules hide the builder's own placeholder — the declaration is computed
        // from the RAW row before any of that, and says what the empty list cannot. Absent the declaration,
        // zero candidates stays `no_variants` (fail closed) exactly as before.
        // Sampled the same day: 18/24 seed rows already resolve on a REAL crawled variant id, 3 are honestly
        // ambiguous (multi-variant); this carve-out is for the remaining product-grain rows only.
        //
        // SCOPE, stated plainly (review of #2024): this closes the RESOLVER seam and nothing further down.
        // A seed row that now passes intake still cannot be PRICED today — pivota-backend's quote engine is
        // Shopify-only (services/quote_service.py -> shopify_storefront_pricing_service, which needs the
        // seller's primary Shopify store and a real ProductVariant GID), and a UCP create_checkout reaches
        // routes/agent_v2.py QuotePreviewBody with no merchant_id at all (required -> 422). So for the seed
        // cohort the refusal moves from a curated intake refusal to a backend pricing error until an
        // offer-grain pricing path exists. Demo checkouts must use Shopify-store products with real GIDs.
        // This carve-out is still right — it is what lets that future path receive the row at all.
        // (`<= 1` is defense in depth: variantIdsFromProductRead already dedupes, so an all-equal list is at
        // most one long today — the bound is what keeps that true if a future reader stops deduping.)
        if (read.productGrain && candidates.every((id) => id === it.product_id) && candidates.length <= 1) {
          it.variant_id = it.product_id;
          continue;
        }
        // ASK THE MERCHANT, if a door injected a source. Our catalog has nothing real to offer for this row;
        // the storefront it was crawled from does. Merchant answers are NOT trusted more than ours — they go
        // through the identical filter and the identical exactly-one rule immediately below.
        if (typeof sourceMerchantVariants === 'function') {
          // Already fetched by the batch above (one entry per DISTINCT product, refusals included, so a
          // storefront that declined is never re-asked for the next line naming the same product). No
          // network call happens inside this loop.
          const merchantIds = merchantByProduct.get(it.product_id) ?? null;
          const merchantReal = (Array.isArray(merchantIds) ? merchantIds : [])
            .filter((id) => nonEmpty(id) && !isRestatedProductId(id, it.product_id));
          if (merchantReal.length === 1) {
            it.variant_id = merchantReal[0];
            continue;
          }
          if (merchantReal.length > 1) {
            throw itemVariantRefusal('ambiguous', variantAmbiguousMessage(merchantReal.length), { variant_count: merchantReal.length });
          }
        }
        // Distinguish "the catalog published no variant identity for this product" (it published only
        // restatements of the product id) from "the product genuinely has no variants". Ops needs both.
        if (candidates.length > 0) {
          throw itemVariantRefusal('no_real_variant_identity', VARIANT_NO_REAL_IDENTITY_MESSAGE, { variant_count: candidates.length });
        }
        throw itemVariantRefusal('no_variants', VARIANT_NOT_RESOLVABLE_MESSAGE, { variant_count: 0 });
      }
      if (real.length > 1) {
        throw itemVariantRefusal('ambiguous', variantAmbiguousMessage(real.length), { variant_count: real.length });
      }
      it.variant_id = real[0];
    }
  };
}

/**
 * FAIL CLOSED on a wiring mistake too: with no resolver threaded, an item that still lacks a `variant_id`
 * would reach pricing unresolved and be forged by the shared builder — the exact hole these doors close.
 * (A fully-specified cart is unaffected; there is nothing to resolve.)
 */
export function assertNoUnresolvedVariants(items) {
  if (items.some((it) => !nonEmpty(it.variant_id))) {
    throw itemVariantRefusal('resolution_unavailable', VARIANT_RESOLUTION_UNAVAILABLE_MESSAGE);
  }
}

// Unwrap the shapes the canonical `get_product` read returns across lanes (`{product:{...}}`,
// `{data:{product:{...}}}`, or a bare product).
function productOfRead(result) {
  const r = isPlainObject(result) ? result : {};
  return isPlainObject(r.product) ? r.product
    : isPlainObject(r.data) && isPlainObject(r.data.product) ? r.data.product
    : r;
}

// A product read -> the DISTINCT variant ids it published, in order. Both spellings of the id. Nothing is
// derived: an entry with no id of its own contributes nothing, and a product with no variants yields an empty
// list (which REFUSES upstream).
export function variantIdsFromProductRead(result) {
  const product = productOfRead(result);
  const ids = [];
  for (const v of Array.isArray(product.variants) ? product.variants : []) {
    const id = variantIdOf(v);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Did the product read DECLARE itself product-grain — a row with no variant axis whose one canonical variant is
 * the product itself? Reads the TYPED field pdpBuilder publishes (`purchase_grain: 'product'`); a read that
 * says nothing is NOT product-grain (fail closed — absence must never buy an acceptance).
 */
export function isProductGrainRead(result) {
  const product = productOfRead(result);
  return typeof product.purchase_grain === 'string' && product.purchase_grain.trim() === 'product';
}

/**
 * Is this candidate variant id just the requested product_id RESTATED?
 *
 * True when the candidate EQUALS the product id, or begins with the product id and continues with a
 * SEPARATOR — any non-alphanumeric character. Both comparisons are on TRIMMED values and are
 * CASE-SENSITIVE: the fabrications this guards against (src/pdpBuilder.js buildVariants:
 * `product.product_id` and `` `${product.product_id}-${idx+1}` ``) are byte-for-byte copies of the product
 * id, and assertProductIdentity has already established that the read's product id is byte-equal to the
 * requested one, so a case-insensitive compare would buy nothing and could only refuse MORE. (No evidence
 * was found that ids are compared case-insensitively anywhere on this path; session ids, `user_ref` and
 * variant ids are all compared case-sensitively here and in canonicalExecutor.)
 *
 * Why it cannot over-refuse a legitimate id:
 *   - `v_p1_red` for product `p1` merely CONTAINS the product id -> does not START with it -> ACCEPTED.
 *   - `sig_9f2c1a` for product `sig_9f2c` starts with it but continues ALPHANUMERICALLY, so it is a
 *     different id and not a restatement -> ACCEPTED. (Hash-prefix collisions between a product id and a
 *     real variant id are exactly this shape.)
 *   - Real storefront ids (`48930014462260`) and canonical placeholders (`merit:c7e...::canonical`) are not
 *     prefixed by the `sig_*` product id these doors are asked about -> ACCEPTED.
 * What it does refuse is the narrow family `<product_id>`, `<product_id>-1`, `<product_id>::canonical`,
 * `<product_id>_default` — strings that carry no identity the product id did not already carry. Refusing is
 * the SAFE direction here: the caller gets an actionable refusal naming `variant_id`, whereas accepting
 * prices a cart against an identity the catalog never issued.
 */
export function isRestatedProductId(candidate, product_id) {
  const c = typeof candidate === 'string' ? candidate.trim() : '';
  const p = typeof product_id === 'string' ? product_id.trim() : '';
  if (!c || !p) return false;
  if (c === p) return true;
  if (!c.startsWith(p)) return false;
  return /[^A-Za-z0-9]/.test(c.charAt(p.length)); // next char is a separator -> derived, not distinct
}

/**
 * The read must be ABOUT the product that was asked for, before any of its variants are believed.
 *
 * Probed hole this closes: a read answering `{product_id:'SOME_OTHER_PRODUCT', merchant_id:'other_merchant',
 * variants:[{variant_id:'v_of_other'}]}` was accepted verbatim and priced. It matters because `merchant_id`
 * is a caller-controlled field that selects between two lanes with different resolution semantics, and the
 * unscoped lane serves a synthetic canonical product whose variants may be family-collapsed across merchants.
 *
 * Rules (all trimmed, case-sensitive, fail-closed):
 *   - product_id MUST be present on the returned product and MUST equal the requested one. A read that
 *     cannot even identify itself is not a read we can attribute variants from.
 *   - merchant_id is checked ONLY when the caller supplied one, and only when the response carries one:
 *     the unscoped lane legitimately answers with no merchant (that is the whole point of `sig_*`), and not
 *     every backend echoes the field. A response that DOES name a different merchant is refused.
 */
export function assertProductIdentity(result, requested_product_id, requested_merchant_id) {
  const product = productOfRead(result);
  const gotProductId = scalarId(product.product_id) ?? scalarId(product.id);
  if (!gotProductId || gotProductId !== String(requested_product_id).trim()) {
    throw itemVariantRefusal('identity_mismatch', PRODUCT_IDENTITY_MISMATCH_MESSAGE);
  }
  if (nonEmpty(requested_merchant_id)) {
    const gotMerchantId = scalarId(product.merchant_id);
    if (gotMerchantId && gotMerchantId !== requested_merchant_id.trim()) {
      throw itemVariantRefusal('identity_mismatch', PRODUCT_IDENTITY_MISMATCH_MESSAGE);
    }
  }
}

// A scalar id from a read, normalized the same way variantIdOf normalizes: trimmed string, or a finite
// number stringified. Anything else is not an id.
function scalarId(raw) {
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
}

function variantIdOf(v) {
  if (!isPlainObject(v)) return undefined;
  for (const key of ['variant_id', 'id']) {
    const raw = v[key];
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
    // Numeric storefront ids are common upstream; stringifying the value the READ returned is not
    // synthesis — it is still that variant's own id, never anything derived from the product id.
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  }
  return undefined;
}

/**
 * Bounded-concurrency map, results in input order. Replaces an unbounded `Promise.all` over the cart's
 * distinct products (which turned a 2000-product cart into 2000 simultaneous upstream reads).
 *
 * `controller` is the batch's abort handle. Workers check it before starting EACH read, so once the deadline
 * (or a sibling's failure) aborts, no further read is launched — the number of reads that outlive a refused
 * request is bounded by `limit`, not by the cart size. The first failure aborts the rest.
 */
export async function mapWithConcurrency(values, limit, fn, controller) {
  const out = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length && !controller.signal.aborted) {
      const i = next++;
      try {
        out[i] = await fn(values[i], i);
      } catch (err) {
        controller.abort();
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), values.length) }, () => worker()));
  return out;
}

// Race a promise against a deadline. The loser's later settlement is already handled by the race, so a slow
// read that finishes after expiry cannot surface as an unhandled rejection.
//
// On expiry the batch `controller` is ABORTED first, then the race rejects — so a door does not merely stop
// WAITING for the reads, it stops the limiter launching any more of them. (Reads already issued still run to
// completion: canonicalExecutor's `read()` forwards no ctx/signal to `upstream`, so the signal stops at the
// executor boundary. The limiter is what makes that bounded — at most VARIANT_RESOLUTION_CONCURRENCY reads
// can be mid-flight when the deadline fires, instead of one per distinct product.)
//
// The timer is unref'd so it never holds the process open. Under a live server that is invisible (the HTTP
// server already keeps the loop alive); in a bare script whose only pending work is this timer, the process
// may exit before it fires. That is the intended trade — a refusal timer must not be a reason to stay up.
export function withDeadline(promise, ms, controller) {
  if (!(ms > 0)) return promise;
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error('variant_resolution_timeout'));
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}
