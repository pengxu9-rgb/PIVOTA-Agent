// THE EXPECTED-SELLER RULE of the UCP door (vendor capability `cc.pivota.reap_seller`; docs/reap-agentic-lane.md
// §5.4) — the pure half, in one module that imports NO lane, so both the Reap lane (ucpReapAgenticLane.js, which
// runs the door-level check) and the storefront lane (ucpCheckoutEscalation.js, which re-checks the link it is
// about to hand out) apply the SAME function without an import cycle.
//
// THE RULE. A create carrying `checkout.reap.expected_merchant_domain` may proceed only if EVERY destination a
// row can sell from or send the buyer to is, after canonicalisation, that seller:
//   - the row's explicit merchant fields (`merchant_domain`, `source_domain`) — what the Reap lane buys from;
//   - the storefront target (`external_redirect_url` of a non-native row) — the storefront answer's continue_url;
//   - for a NATIVE row (no storefront target), the merchant's REGISTERED store destinations the product read
//     carries (`online_store_url`, `external_redirect_url` — both derived by the backend from the merchant's
//     verified connected store). A native row with none of these and no explicit field cannot be confirmed:
//     its `canonical_url` / `url` is a catalog page, not the merchant of record the kernel sells for.
// A destination that is a Pivota host (an `/r` attribution hop), a redirector (a URL carrying another URL), not
// https, carries userinfo, or does not parse is UNCONFIRMED — fail closed, whatever its host.

import { intakeRefusal } from "../../safety-kernel/src/protocol/buyerIntake.js";

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
function own(src, key) {
  if (!isPlainObject(src)) return undefined;
  if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
  return Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined;
}

export const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** Printable ASCII only — checked BEFORE any case fold, so a lookalike (U+212A KELVIN SIGN) cannot fold to `k`. */
export const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/;
// Pivota's own hosts. A row URL can point at them — the canonical PDP (`agent.pivota.cc/products/sig_…`), or a
// signed attribution redirect (`https://<pivota host>/r?token=…`) riding in `external_redirect_url` — and none of
// them is the MERCHANT's domain.
export const SELF_HOST_RE = /(^|\.)pivota\.cc$/;
/** The `<merchant>` segment of a catalog product key, as the backend mints it (merchant ids are this shape). */
const MERCHANT_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;

/**
 * THE ONE SELLER-COMPARISON RULE: the backend's canonical merchant-domain spelling (pivota-backend #2258,
 * `canonical_merchant_domain`) — lowercase, then ONE leading `www.` removed (`www.www.a.com` -> `www.a.com`, as
 * there). Null for anything that is not a bare host name (a scheme, port, path, userinfo, single label, any
 * non-ASCII character — refused BEFORE the case fold — or one of Pivota's own hosts). Used on BOTH sides of the
 * expected-seller check, and by the argument adapter to refuse an expected seller that could never match. It is
 * NEVER applied to what the Reap lane POSTs or publishes: those stay as observed.
 */
export function canonicalReapMerchantDomain(raw) {
  if (typeof raw !== "string" || !PRINTABLE_ASCII_RE.test(raw)) return null;
  const lower = raw.toLowerCase();
  if (!HOSTNAME_RE.test(lower) || SELF_HOST_RE.test(lower)) return null;
  const folded = lower.startsWith("www.") ? lower.slice(4) : lower;
  return HOSTNAME_RE.test(folded) ? folded : null;
}

/** Is `rowDomain` the seller named by `expected`? Both must canonicalise; anything unreadable is NOT a match. */
export function isSameReapMerchant(expected, rowDomain) {
  const a = canonicalReapMerchantDomain(expected);
  const b = canonicalReapMerchantDomain(rowDomain);
  return a !== null && b !== null && a === b;
}

/**
 * The `<merchant>` segment of a catalog product key (`prod::<merchant>::<platform>::<source id>`, the backend's
 * `catalog_products.merchant_id`), or null when the key is not that form.
 */
export function reapMerchantIdOfProductKey(productKey) {
  if (typeof productKey !== "string") return null;
  const parts = productKey.split("::");
  if (parts.length < 4 || parts[0] !== "prod") return null;
  return MERCHANT_ID_RE.test(parts[1]) ? parts[1] : null;
}

/**
 * `checkout.reap.expected_merchant_domain` — the seller the platform showed the buyer, read from the RAW UCP body.
 * The argument adapter advertises and accepts it ONLY while the Reap lane is on, and refuses a value
 * `canonicalReapMerchantDomain` cannot read (`ucp_expected_merchant_domain_invalid`). `undefined` ONLY when the
 * member is absent: a present value of any other type is returned as it is, so that behind a bypassed adapter it
 * still fails CLOSED (it matches no seller) rather than reading as "no expectation".
 */
export function reapExpectedMerchantDomain(ucpArgs) {
  return own(own(own(ucpArgs, "checkout"), "reap"), "expected_merchant_domain");
}

/** Does this URL carry ANOTHER URL (an affiliate / redirector hop: `?murl=https://…`, `/r/https://…`)? */
function carriesAnotherUrl(parsed) {
  for (const value of parsed.searchParams.values()) {
    if (/^\s*(https?:)?\/\//i.test(value) || /^\s*https?%3a/i.test(value)) return true;
  }
  let path = parsed.pathname;
  try { path = decodeURIComponent(path); } catch { return true; }
  return /https?:\/|\/\/[^/]/i.test(path.slice(1));
}

/**
 * One destination URL against the expected seller: `{ ok: true }`, or `{ ok: false, cause, host? }` where `cause`
 * is `different_seller` (a readable merchant host that is not the seller; `host` names it) or
 * `seller_unconfirmed` (not https, userinfo, unparseable, a Pivota host, a non-ASCII or unreadable host, or a hop
 * that carries another URL — its final destination is not this URL's host).
 */
export function judgeSellerUrl(expected, url) {
  const want = canonicalReapMerchantDomain(expected);
  if (want === null) return { ok: false, cause: "seller_unconfirmed" };
  let parsed;
  try { parsed = new URL(String(url)); } catch { return { ok: false, cause: "seller_unconfirmed" }; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return { ok: false, cause: "seller_unconfirmed" };
  const host = canonicalReapMerchantDomain(parsed.hostname);
  if (host === null) return { ok: false, cause: "seller_unconfirmed" };
  if (carriesAnotherUrl(parsed)) return { ok: false, cause: "seller_unconfirmed" };
  if (host !== want) return { ok: false, cause: "different_seller", host: parsed.hostname.toLowerCase() };
  return { ok: true };
}

/**
 * EVERY destination the row can sell from or send the buyer to (see THE RULE above). `target` is the storefront
 * target the caller already classified (`escalationTargetOf(row)`, null for a native row).
 */
export function sellerDestinationsOfRow(row, target) {
  const out = [];
  for (const key of ["merchant_domain", "source_domain"]) {
    const v = str(own(row, key));
    if (v) out.push({ kind: "domain", value: v });
  }
  if (target) {
    out.push({ kind: "url", value: target });
  } else {
    for (const key of ["online_store_url", "external_redirect_url"]) {
      const v = str(own(row, key));
      if (v) out.push({ kind: "url", value: v });
    }
  }
  return out;
}

/**
 * The row against the expected seller: `{ ok: true }`, or `{ ok: false, cause, host? }` for the FIRST destination
 * that is not the seller. A row with no destination at all is `seller_unconfirmed`.
 */
export function judgeRowSeller(expected, row, target) {
  if (!isPlainObject(row)) return { ok: false, cause: "seller_unconfirmed" };
  const destinations = sellerDestinationsOfRow(row, target);
  if (destinations.length === 0) return { ok: false, cause: "seller_unconfirmed" };
  const want = canonicalReapMerchantDomain(expected);
  for (const d of destinations) {
    if (d.kind === "url") {
      const verdict = judgeSellerUrl(expected, d.value);
      if (!verdict.ok) return verdict;
      continue;
    }
    const host = canonicalReapMerchantDomain(d.value);
    if (want === null || host === null) return { ok: false, cause: "seller_unconfirmed" };
    if (host !== want) return { ok: false, cause: "different_seller", host: d.value.toLowerCase() };
  }
  return { ok: true };
}

/** The refusal reason for a create whose expected seller is not the seller of the resolved rows. */
export const SELLER_MISMATCH_REASON = "ucp_seller_mismatch";

/**
 * `QUOTE_REQUIRED` / `ucp_seller_mismatch`. `merchantDomain` is the host that is NOT the seller (a different
 * seller's), from Pivota's own catalog read — never a request value; `merchantId` the served row's catalog
 * merchant id. Both omitted when unknown.
 */
export function sellerMismatchRefusal({ lineIndex, merchantDomain, merchantId, cause }) {
  const where = lineIndex === null || lineIndex === undefined ? "this cart" : `checkout.line_items[${lineIndex}]`;
  const who = merchantDomain ? `is sold by, or sends the buyer to, ${merchantDomain}` : "has a seller Pivota cannot confirm";
  return intakeRefusal("QUOTE_REQUIRED", SELLER_MISMATCH_REASON, [
    `The item at ${where} ${who}, not the seller named in checkout.reap.expected_merchant_domain.`,
    "No checkout was opened, nothing was charged, and no other route is offered for it. Do not send the buyer to",
    "any link from Pivota for this item; send them to the seller they were shown.",
  ].join(" "), {
    dialect: "ucp",
    rejected_field: "checkout.reap.expected_merchant_domain",
    cause,
    ...(lineIndex === null || lineIndex === undefined ? {} : { line_item: `$.line_items[${lineIndex}]` }),
    ...(merchantDomain ? { merchant_domain: merchantDomain } : {}),
    ...(merchantId ? { merchant_id: merchantId } : {}),
  });
}
