// The canonical→UCP RESPONSE shaper — the OUTBOUND half of the UCP dialect. ucpArgumentAdapter.js is the
// inbound half (UCP wire args → native tool args); this module is its mirror (native tool RESULT → the UCP
// spec's response shape). They are separate files on purpose: one direction each, no shared state.
//
// WHY THIS EXISTS. #2016 put `search_catalog` on the UCP dialect and, by decision, returned Pivota's NATIVE
// product list. That was the right first step and the wrong final state: a UCP platform parses the spec's
// `catalog_search.json` response, and a native list forces every platform to carry Pivota-specific code for
// one merchant. Worse, native carried no pagination contract, so the request-side `pagination.cursor` was
// accepted-and-unread — a client that received N results had no way to ask for the next N. This module
// closes both: the spec envelope, and a real cursor that the request side (ucpArgumentAdapter) now READS.
//
// ---- THE RESPONSE SHAPE, AND WHERE IT COMES FROM ---------------------------------------------------------
//
// FETCHED 2026-08-18 from https://ucp.dev/2026-04-08/schemas/shopping/catalog_search.json and the types it
// $refs (product.json, variant.json, price_range.json, price.json, amount.json, description.json,
// media.json, category.json, pagination.json, message*.json, ucp.json). Transcribed `required` arrays:
//   search_response : ["ucp","products"]; optional pagination, messages
//   ucp             : ["version"] (+ status: "success"|"error", default success)
//   product         : ["id","title","description","price_range","variants"]; variants minItems 1
//   variant         : ["id","title","description","price"]
//   price_range     : ["min","max"], each a price
//   price           : ["amount","currency"]; amount = INTEGER in ISO 4217 MINOR units, minimum 0;
//                     currency pattern ^[A-Z]{3}$
//   description     : plain / html / markdown, minProperties 1 — {} is NOT valid (review of #2020 caught the
//                     first transcription saying it was)
//   media           : ["type","url"]; type well-known: image | video | model_3d
//   category        : ["value"] (+ taxonomy)
//   pagination(resp): ["has_next_page"]; `cursor` MUST be present when has_next_page is true; total_count
//   message         : oneOf error|warning|info; warning requires ["type","code","content"], info ["type","content"]
// FETCHED 2026-08-18 likewise: https://ucp.dev/2026-04-08/schemas/shopping/catalog_lookup.json —
//   get_product_response : ["ucp","product"]; product is `detail_product` = product.json (allOf) plus optional
//                          `selected[]` / `options[]` (availability signals per option value); optional messages
// mcp-server/test/ucpResponseShaper.test.js pins these arrays with the same provenance, so a drift on either
// side fails CI rather than surfacing in a platform integration.
//
// VARIANTS ON get_product — WHY IT IS STILL ONE. The native detail row DOES carry real variants
// ({variant_id, sku_id, title, options[], price?, availability?}). UCP says variant.id is "used as item.id in
// cart/checkout line items", and this door's create_checkout maps `item.id` to product_id: it has no field
// for a variant, and buyerIntake refuses a multi-variant product rather than guessing (rule 3). Publishing
// per-variant ids here would therefore advertise ids the checkout cannot take — the "advertised but not
// executable" defect one operation over. So get_product publishes the SAME single variant as search (id =
// the product id checkout accepts) and, when the row carries more than one REAL variant, SAYS SO in a
// `messages` warning (`variants.selection_not_supported`) instead of hiding it. Real variants become
// publishable the day create_checkout accepts a variant id on `item.id`; that is a checkout-mapper decision
// and lives with it, not here. `selected` / `options` are omitted for the same reason: option axes a caller
// cannot select would be a promise the door does not keep.
//
// ---- WHAT MAPS, AND THE THREE THINGS THAT DO NOT --------------------------------------------------------
//
//  product.id / variant.id  ← the Pivota signature id (`sig_…`, `pivota_signature_id || product_id || id`),
//     the same id `get_product` reads and a `create_checkout` line item's `item.id` accepts. UCP calls this
//     a GID; ours is a sig. A product row carries ONE purchasable identity here — the native search row has
//     no variant list — so the product's single variant IS the product, under the same id. This is exactly
//     the position the ACP feed is already in ("publishes sig_* product ids and NO variant identity"), and
//     it is why buyerIntake resolves the default variant server-side at checkout.
//  price.amount ← MAJOR → ISO MINOR via money.js majorToIsoMinor (rounded — a displayed price may round; a
//     charge may not, which is why parseDecimalToMinor is a different function). A row with NO price, or a
//     price with NO currency, cannot satisfy `price_range` and is DROPPED, counted in a `messages` info
//     entry, never silently — such rows are already blocked from the public tier (OFFER_PRICE_MISSING) and
//     a spec-conformant product cannot be built for them.
//  variant.availability ← the row's availability string / in_stock boolean, by the SAME precedence the
//     public projector uses (string wins; verified stale-boolean on prod 2026-08-01).
//  pagination ← native `total`/`page`/requested page_size. `has_next_page` is REQUIRED, so it is computed,
//     never guessed: with a total, page*page_size < total; without one, only a FULL page (returned >=
//     requested page_size) can have a next page. `cursor` is minted only when has_next_page is true and is
//     an OPAQUE encoding of the next page number (see encodeSearchCursor) — the request side decodes it back
//     to native `page`, which is what makes the loop honest: emitting a cursor the request side ignored
//     would send every paginating client back to page 1 forever.
//  messages ← one `info` when rows were dropped for having no price; one `warning` (code
//     `filters.categories_not_applied`) when the caller sent `filters.categories`, which this door accepts
//     and does not apply (vocabulary mismatch — see ucpArgumentAdapter). The spec's whole point of
//     `messages` is that an unapplied filter is SAID, not silently ignored.
//
// NOT MAPPED, each for a stated reason:
//  - `brand`: UCP's product model has NO brand member. It rides in `metadata.brand` (the spec's extension
//    slot: "Business-defined custom data extending the standard product model") rather than being folded
//    into `title`, which would corrupt the title for every platform that displays it.
//  - `rating`, `options`, `list_price_range`, `barcodes`, `sku`: absent from the native search row.
//  - `handle`: no stable slug exists beyond the sig id; `url` carries the canonical PDP instead.
//
// PURITY. Shaping runs AFTER the commerce read cache (commerceToolSurface.callTool): the cache stores the
// NATIVE sanitized value keyed on dialect-agnostic params, and both dialects read the same entry — so this
// function must never mutate its input (it receives a clone, but it does not rely on that) and must be a
// pure function of (native result, request args). Anything else would let one dialect's shape leak into
// the other's cache hits.

import { majorToIsoMinor } from "../../safety-kernel/src/money.js";
import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";

export const UCP_RESPONSE_VERSION = "2026-04-08";

// The native lane's default page size when the caller sends none (src/server.js find_products_multi:
// `Number(search?.page_size || search?.limit || 20)`). Used ONLY to compute has_next_page when neither the
// request nor the native response names a size; a hand-copy, so pinned by test against nothing stronger than
// this comment — keep it in step if the lane's default moves.
const LANE_DEFAULT_PAGE_SIZE = 20;

// The canonical PDP host — the SAME constant the public projector constructs `pivota_url` from. Row URL fields
// are not trustworthy for reseller rows (verified live: `pivota_canonical_url` was the reseller's page), so
// the URL is CONSTRUCTED from the sig id, which is host-controlled and valid for any sig-keyed product.
const DEFAULT_PDP_BASE = "https://agent.pivota.cc";

// ---- small pure helpers ----------------------------------------------------------------------------------

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const arr = (v) => (Array.isArray(v) ? v : []);
function finiteNum(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function own(src, key) {
  if (!isPlainObject(src)) return undefined;
  if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
  return Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined;
}
/** Drop null/undefined members so optional spec fields are OMITTED, not published as null. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

// ---- cursor ----------------------------------------------------------------------------------------------
//
// OPAQUE by contract (the spec: "Cursor to fetch the next page"), so a platform cannot depend on its shape —
// and so we can change it. It encodes ONLY the next page number: the query, filters and page size are sent
// again by the caller on the next request (the spec's cursor is a continuation token, not a saved search),
// and encoding them here would let a stale cursor silently replay an OLD query against a NEW request. `v` is
// a format version so a future shape can be told apart from junk.

const CURSOR_VERSION = 1;
const CURSOR_MAX_PAGE = 100000; // a bound, not a policy: keeps a forged/overflowed page from reaching SQL

export function encodeSearchCursor(nextPage) {
  if (!Number.isInteger(nextPage) || nextPage < 2 || nextPage > CURSOR_MAX_PAGE) return undefined;
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, page: nextPage }), "utf8").toString("base64url");
}

/** Decode a cursor to the native page number, or undefined for anything that is not one of ours. */
export function decodeSearchCursor(cursor) {
  if (typeof cursor !== "string" || cursor.trim() === "" || cursor.length > 64) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor.trim(), "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || parsed.v !== CURSOR_VERSION) return undefined;
  const page = parsed.page;
  if (!Number.isInteger(page) || page < 2 || page > CURSOR_MAX_PAGE) return undefined;
  return page;
}

// ---- product ---------------------------------------------------------------------------------------------

function productIdOf(p) {
  return str(p.pivota_signature_id) || str(p.product_id) || str(p.id);
}

const AVAILABILITY_IN_STOCK = new Set(["in_stock", "in stock", "instock", "available"]);
const AVAILABILITY_OUT_OF_STOCK = new Set([
  "out_of_stock", "out of stock", "outofstock", "oos", "sold out", "sold_out", "unavailable", "discontinued",
]);
/**
 * -> UCP variant.availability `{ available, status }` (status well-known values: in_stock | backorder |
 * preorder | out_of_stock | discontinued). Same precedence as the public projector: the availability STRING
 * wins over the `in_stock` boolean (the two are derived independently upstream and the boolean was verified
 * stale on prod 2026-08-01). Unknown -> omitted entirely rather than published as a guess.
 */
function availabilityOf(p) {
  const text = typeof p.availability === "string" ? p.availability.trim().toLowerCase() : "";
  if (text === "discontinued") return { available: false, status: "discontinued" };
  if (AVAILABILITY_IN_STOCK.has(text)) return { available: true, status: "in_stock" };
  if (AVAILABILITY_OUT_OF_STOCK.has(text)) return { available: false, status: "out_of_stock" };
  if (p.in_stock === true) return { available: true, status: "in_stock" };
  if (p.in_stock === false) return { available: false, status: "out_of_stock" };
  return undefined;
}

const ISO_CURRENCY_RE = /^[A-Z]{3}$/;
function priceOf(p) {
  // price.json: `currency` pattern ^[A-Z]{3}$. Uppercased (a row may carry "usd"), and a value that is not
  // three letters cannot be published as a price — the row is dropped as no_price and SAID.
  const currency = str(p.currency)?.toUpperCase();
  if (!currency || !ISO_CURRENCY_RE.test(currency)) return undefined;
  const amount = majorToIsoMinor(p.price, currency);
  if (amount === undefined) return undefined;
  return { amount, currency };
}

function imagesOf(p) {
  const seen = new Set();
  const out = [];
  const push = (u) => {
    const s = str(u);
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  };
  push(p.image_url);
  for (const u of arr(p.images)) push(u);
  for (const u of arr(p.image_urls)) push(u);
  return out.slice(0, 8);
}

function descriptionOf(p, title) {
  // `description` is REQUIRED on product and variant AND declares minProperties:1, so `{}` is invalid. A row
  // with no prose gets `{plain: <title>}` — a true statement about the row, not a fabricated sentence — so
  // the product stays spec-valid without inventing copy.
  const plain = str(p.description) || str(p.summary_short) || str(p.short_description) || title;
  return { plain };
}

/**
 * One native search row -> one UCP product, or undefined when a spec-conformant product cannot be built
 * (no id, or no priced offer). The reason is returned alongside so the envelope can SAY it in `messages`.
 */
export function shapeUcpProduct(row, { pdpBase = DEFAULT_PDP_BASE } = {}) {
  if (!isPlainObject(row)) return { product: undefined, dropped: "not_a_row" };
  const id = productIdOf(row);
  if (!id) return { product: undefined, dropped: "no_id" };
  const price = priceOf(row);
  if (!price) return { product: undefined, dropped: "no_price" };

  // `title` is required. A row with none is not fabricated a title: brand, then the id — both are true
  // statements about the row, and a platform can tell them apart from a real title.
  const title = str(row.title) || str(row.brand) || id;
  const description = descriptionOf(row, title);
  const url = `${pdpBase}/products/${id}`;
  const media = imagesOf(row).map((u) => ({ type: "image", url: u }));
  const category = str(row.category) || str(row.product_type);
  const availability = availabilityOf(row);
  const brand = str(row.brand);

  const variant = compact({
    id,
    title,
    description,
    price,
    url,
    availability,
    media: media.length ? media : undefined,
  });

  const product = compact({
    id,
    title,
    description,
    url,
    categories: category ? [{ value: category }] : undefined,
    price_range: { min: price, max: price },
    media: media.length ? media : undefined,
    variants: [variant],
    metadata: brand ? { brand } : undefined,
  });
  return { product, dropped: undefined };
}

// ---- envelope --------------------------------------------------------------------------------------------

/**
 * The native `search_catalog` result -> the UCP `catalog_search.json` search_response.
 *
 * @param {object} native   the SANITIZED native result (products, total?, page?)
 * @param {object} ctx      { params: the allowlisted native params (payload.search), ucpArgs: the raw UCP args }
 */
export function shapeUcpSearchResponse(native, { params, ucpArgs, pdpBase = DEFAULT_PDP_BASE } = {}) {
  const body = isPlainObject(native) ? native : {};
  const search = isPlainObject(own(params, "payload")) ? own(own(params, "payload"), "search") : undefined;
  const requested = isPlainObject(search) ? search : {};

  const products = [];
  let droppedNoPrice = 0;
  let droppedNoId = 0;
  for (const row of arr(body.products)) {
    const { product, dropped } = shapeUcpProduct(row, { pdpBase });
    if (product) products.push(product);
    else if (dropped === "no_price") droppedNoPrice += 1;
    else if (dropped === "no_id" || dropped === "not_a_row") droppedNoId += 1;
  }

  // Pagination, computed — never guessed. `page` is what the caller asked for (native `page`, itself decoded
  // from a cursor), `page_size` what they asked for; the lane's own default page size is unknown to us, so
  // without a requested size a next page is only claimed when a total says so.
  const page = Number.isInteger(requested.page) && requested.page >= 1 ? requested.page : 1;
  // The page size that ACTUALLY governed this page: what the caller asked for, else what the lane reports it
  // used, else the lane's default (src/server.js find_products_multi: `page_size || 20`). NEVER the count of
  // rows returned — a short last page (5 of 25 at size 20) would then compute 2*5=10 < 25 and claim a next
  // page, and the empty page after it 3*0=0 < 25 again, forever (review of #2020, reproduced). The public
  // projector avoids the same trap the same way ("so clients paginating by total/page_size aren't skewed
  // by a short final page").
  const nativeSize = finiteNum(body.page_size);
  const pageSize = Number.isInteger(requested.page_size) && requested.page_size >= 1
    ? requested.page_size
    : Number.isInteger(nativeSize) && nativeSize >= 1 ? nativeSize : LANE_DEFAULT_PAGE_SIZE;
  const total = finiteNum(body.total);
  const returned = arr(body.products).length; // rows the LANE returned, before our drops — paging is the lane's
  let hasNext = false;
  if (returned === 0) {
    // An empty page is the end, whatever a (possibly estimated, possibly stale) total says. Claiming a next
    // page here is the one shape of lie that never terminates.
    hasNext = false;
  } else if (total !== null && total >= 0) {
    hasNext = page * pageSize < total;
  } else {
    // No total: only a FULL page can have a next page.
    hasNext = returned >= pageSize;
  }
  const cursor = hasNext ? encodeSearchCursor(page + 1) : undefined;
  if (hasNext && !cursor) hasNext = false; // beyond the cursor bound: say "no more" rather than emit nothing
  const pagination = compact({
    has_next_page: hasNext,
    cursor,
    total_count: total !== null && total >= 0 && Number.isInteger(total) ? total : undefined,
  });

  const messages = [];
  const catalog = isPlainObject(own(ucpArgs, "catalog")) ? own(ucpArgs, "catalog") : undefined;
  const filters = isPlainObject(own(catalog, "filters")) ? own(catalog, "filters") : undefined;
  const categories = own(filters, "categories");
  if (Array.isArray(categories) && categories.length > 0) {
    messages.push({
      type: "warning",
      code: "filters.categories_not_applied",
      path: "$.products",
      content: "This catalog does not apply the request's `filters.categories`: `products` are not narrowed by category. Filter client-side, or narrow the query text.",
      content_type: "plain",
    });
  }
  if (droppedNoPrice > 0) {
    messages.push({
      type: "info",
      code: "products.omitted_no_price",
      path: "$.products",
      content: `${droppedNoPrice} matching product${droppedNoPrice === 1 ? "" : "s"} omitted: no priced offer, so no spec-conformant price_range could be published.`,
      content_type: "plain",
    });
  }
  if (droppedNoId > 0) {
    messages.push({
      type: "info",
      code: "products.omitted_no_id",
      path: "$.products",
      content: `${droppedNoId} row${droppedNoId === 1 ? "" : "s"} omitted: no product id.`,
      content_type: "plain",
    });
  }

  return compact({
    ucp: { version: UCP_RESPONSE_VERSION, status: "success" },
    products,
    pagination,
    messages: messages.length ? messages : undefined,
  });
}

/**
 * How many REAL variants a native detail row carries — ids that are not just the product id restated (the
 * same test buyerIntake applies before it believes a variant list). Used only to decide whether to SAY that
 * variant selection is not expressible on this door.
 */
function realVariantCount(row) {
  const pid = productIdOf(row);
  const seen = new Set();
  for (const v of arr(row.variants)) {
    const id = isPlainObject(v) ? str(v.variant_id) || str(v.id) : null;
    if (!id || id === pid) continue;
    seen.add(id);
  }
  return seen.size;
}

/**
 * The native `get_product` result -> the UCP `catalog_lookup.json` get_product_response.
 *
 * `product` is REQUIRED on the wire, so a row that cannot become a spec product is not published as a
 * half-envelope — it is refused with the taxonomy's own codes, exactly as the native door already refuses:
 *   no row / no id  -> UNKNOWN_PRODUCT_ID   (retriable:false, "search again to obtain a valid product_id")
 *   no priced offer -> NO_MERCHANT_OFFER    (retriable:false, "no purchasable merchant offer attached")
 * Both are PivotaCommerceError, so toToolError surfaces the curated message and the retry classification.
 */
export function shapeUcpGetProductResponse(native, { params, ucpArgs, pdpBase = DEFAULT_PDP_BASE } = {}) {
  const body = isPlainObject(native) ? native : {};
  const row = isPlainObject(own(body, "product")) ? own(body, "product") : (productIdOf(body) ? body : undefined);
  const { product, dropped } = shapeUcpProduct(row, { pdpBase });
  if (!product) {
    if (dropped === "no_price") {
      throw new PivotaCommerceError("NO_MERCHANT_OFFER", { reason: "ucp_product_unpriced", dialect: "ucp" });
    }
    throw new PivotaCommerceError("UNKNOWN_PRODUCT_ID", { reason: "ucp_product_not_found", dialect: "ucp" });
  }
  const messages = [];
  const variants = realVariantCount(row);
  if (variants > 1) {
    messages.push({
      type: "warning",
      code: "variants.selection_not_supported",
      path: "$.product.variants",
      content: `This product has ${variants} purchasable variants, but this catalog cannot yet take a variant choice on a checkout line item: only the product id is accepted as item.id, and checkout refuses rather than guesses among variants. The single variant published here is the product itself.`,
      content_type: "plain",
    });
  }
  return compact({
    ucp: { version: UCP_RESPONSE_VERSION, status: "success" },
    product,
    messages: messages.length ? messages : undefined,
  });
}

/** canonical op id -> outbound shaper. Ops absent here return the native result unchanged. */
const SHAPERS = Object.freeze({
  search_catalog: shapeUcpSearchResponse,
  get_product: shapeUcpGetProductResponse,
});

export const UCP_SHAPED_OPERATION_IDS = Object.freeze(Object.keys(SHAPERS));

/**
 * Shape a native tool result for the UCP dialect. Pure; safe to call on a cache CLONE.
 * @param {{id:string}} op   canonical operation
 * @param {object} native    sanitized native result
 * @param {object} ctx       { params, ucpArgs }
 */
export function shapeUcpResult(op, native, ctx = {}) {
  const shaper = op && SHAPERS[op.id];
  return shaper ? shaper(native, ctx) : native;
}
