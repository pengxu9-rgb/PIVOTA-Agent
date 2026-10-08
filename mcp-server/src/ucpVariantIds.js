// VARIANT IDS ON THE UCP DOOR — one definition for what get_product publishes and what checkout accepts.
//
// UCP says a variant's `id` is "used as item.id" on a checkout line. Pivota's UCP door used to publish ONE variant
// (the product itself) because checkout could only take a product id, and a multi-variant product was refused at
// checkout or bought without the buyer's size/shade. This module makes the choice expressible end to end:
//
//   variant.id  =  `<product_id>::v::<variant_id>`   (only for a product with MORE THAN ONE real variant)
//
// The product id comes first so the door can read the product (every lane reads by product id) and then prove the
// variant is one of THAT product's real variants (`findRealVariant`). The split is on the FIRST `::v::`: product ids
// are `sig_…`-style and never contain it, while a variant id may (mirror keys use a `::v::` infix), so everything
// after the first separator is the variant id, verbatim.
//
// "Real" variants are counted exactly as checkout counts them — buyerIntake's own readers
// (`variantIdsFromProductRead` minus `isRestatedProductId`) — so the door never publishes a variant it would refuse,
// and never accepts one it did not publish.

import { isRestatedProductId, variantIdsFromProductRead } from "../../safety-kernel/src/protocol/buyerIntake.js";
import { majorToIsoMinor } from "../../safety-kernel/src/money.js";

export const UCP_VARIANT_SEPARATOR = "::v::";
const MAX_VARIANT_ID_LENGTH = 256;

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

export function encodeUcpVariantItemId(productId, variantId) {
  return `${productId}${UCP_VARIANT_SEPARATOR}${variantId}`;
}

/**
 * A UCP `item.id` -> `{ product_id, variant_id? }`, or null when it names a variant malformedly (an empty side, a
 * variant id that is too long or not printable). A plain product id has no `variant_id`.
 */
export function parseUcpItemId(raw) {
  const id = str(raw);
  if (!id) return null;
  const at = id.indexOf(UCP_VARIANT_SEPARATOR);
  if (at === -1) return { product_id: id };
  const product_id = id.slice(0, at).trim();
  const variant_id = id.slice(at + UCP_VARIANT_SEPARATOR.length).trim();
  if (!product_id || !variant_id || variant_id.length > MAX_VARIANT_ID_LENGTH || !/^[\x21-\x7e]+$/.test(variant_id)) return null;
  return { product_id, variant_id };
}

function variantIdOf(v) {
  if (!isPlainObject(v)) return undefined;
  for (const key of ["variant_id", "id"]) {
    const raw = v[key];
    if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  }
  return undefined;
}

function productIdOf(row) {
  return str(row && row.pivota_signature_id) || str(row && row.product_id) || str(row && row.id);
}

/** The row's REAL variants (objects), in order, by checkout's own count. */
export function realVariantsOf(row) {
  if (!isPlainObject(row)) return [];
  const pid = productIdOf(row);
  const real = new Set(variantIdsFromProductRead({ product: row }).filter((id) => !isRestatedProductId(id, pid)));
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(row.variants) ? row.variants : []) {
    const id = variantIdOf(v);
    if (id && real.has(id) && !seen.has(id)) { seen.add(id); out.push({ id, variant: v }); }
  }
  return out;
}

/** The real variant of `row` whose id is `variantId`, or null. */
export function findRealVariant(row, variantId) {
  const want = str(variantId);
  if (!want) return null;
  const hit = realVariantsOf(row).find((r) => r.id === want);
  return hit ? hit.variant : null;
}

/**
 * A variant's OWN price in ISO minor units, or undefined when it states none this door can read. Canonical PDP
 * variants use `price.current`; native rows use a flat `{amount, currency}` or a scalar beside the variant's (or the
 * row's) currency. Never borrows the product's price — the caller decides what an unpriced variant shows.
 */
export function variantPriceOf(variant, row) {
  if (!isPlainObject(variant)) return undefined;
  let raw = variant.price;
  if (isPlainObject(raw) && raw.current !== undefined) raw = raw.current;
  const amount = isPlainObject(raw) ? raw.amount : raw;
  const currency = (str(isPlainObject(raw) ? raw.currency : null) || str(variant.currency) || str(row && row.currency) || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency) || amount === undefined || amount === null || amount === "") return undefined;
  const minor = majorToIsoMinor(amount, currency);
  return minor === undefined ? undefined : { amount: minor, currency };
}

/** A human label for a variant: its title, else its option values, else null. */
export function variantLabelOf(variant) {
  if (!isPlainObject(variant)) return null;
  const title = str(variant.title) || str(variant.name);
  if (title) return title;
  const options = Array.isArray(variant.options) ? variant.options : [];
  const values = options.map((o) => (isPlainObject(o) ? str(o.value) : str(o))).filter(Boolean);
  return values.length ? values.join(" / ") : null;
}
