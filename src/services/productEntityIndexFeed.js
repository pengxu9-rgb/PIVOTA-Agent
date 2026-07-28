const { query: defaultQuery } = require('../db');
const {
  buildExternalSeedProduct,
  EXTERNAL_SEED_MERCHANT_ID,
} = require('./externalSeedProducts');
const { activeCatalogProductSourceWhere } = require('./activeCatalogSourceSql');

// ADR-018 connection layer, JS twin of pivota-backend
// `services/connection_layer.classify_connection_layer`. Kept deliberately
// narrow: this lane sees one catalog row and nothing merchant-scoped, so it can
// distinguish layer 1 from layer 2 and must never claim layer 3 (which needs a
// PSP fact this query does not join). Normalisation matches the Python twin's
// `.strip().lower()` — the backend paid for that lesson twice, once because a
// NULL track fell through to the wrong layer and once because single-argument
// Postgres `btrim` strips spaces but not tabs.
const TRACK_EXTERNAL_REFERRAL = 'external_referral';
const TRACK_INTERNAL_MERCHANT = 'internal_merchant';

// Same flag NAME as pivota-backend's `CONNECTION_LAYER_FIELD_ENABLED`, on
// purpose: one connection-layer contract spans two repos, and two names for one
// rollout is how half a contract ships. Read per call rather than at module
// load so a test (and an operator flipping it) does not need a restart.
function connectionLayerFieldEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(env?.CONNECTION_LAYER_FIELD_ENABLED || '').trim().toLowerCase(),
  );
}

function connectionLayerForTrack(track) {
  const normalized = String(track ?? '').trim().toLowerCase();
  // Anything that is not explicitly the internal (synced) track is layer 1 —
  // an unrecognised or absent track is not evidence of a sync, so it falls to
  // the honest floor rather than inventing a tier.
  return normalized === TRACK_INTERNAL_MERCHANT ? 2 : 1;
}

// Latched per process — see the try/catch around the statement below.
let CONTENT_CANONICAL_ELECTION_TABLE_MISSING = false;

function isMissingContentCanonicalElectionError(err) {
  // The relation NAME is the required signal, not the SQLSTATE. This statement
  // also touches catalog_products, catalog_merchants, index_pipeline_state,
  // catalog_skus, catalog_offers and product_group_members; latching on a bare
  // `code === '42P01'` would permanently disable the election preference
  // whenever ANY of those went missing, and blame migration 181 for it. That
  // exact misdiagnosis was demonstrated on the sibling latch in src/server.js.
  // Postgres's undefined_table message always names the relation, so requiring
  // the name costs nothing and the SQLSTATE stays as corroboration (a wrapping
  // proxy may carry only the text).
  // ONE anchored pattern, not two independent substring tests. The loose form
  // (`includes('content_canonical_election')` AND `includes('does not exist')`)
  // latches on an unrelated 42P01 whose message happens to embed the failing SQL
  // — which some proxies and ORMs append as `QUERY: ...`, and this statement
  // names the table. Consequence is only a lost preference, but a latch that
  // fires on the wrong cause is how the sibling latch in server.js misdiagnosed
  // itself for a process lifetime.
  const message = String(err?.message || err || '');
  const namesRelation = /relation "?content_canonical_election"? does not exist/i.test(message);
  if (!namesRelation) return false;
  // Unconditional: the anchored pattern above IS the decision. Writing
  // `err?.code === '42P01' || true` read as though SQLSTATE still
  // corroborated, which it does not — the `|| true` made the left side dead.
  return true;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.floor(n), max));
}

function nonEmptyString(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

// A URL IS NOT A TITLE, and this chain used to accept one silently.
//
// Measured on the live feed 2026-07-28: 3,952 of 4,375 rows (90%) published
// `title` IDENTICAL to `link` — the PDP URL as the product name, on the field a
// shopping ingester displays. Every other field on those rows was correct.
//
// ROOT CAUSE IS A CHAIN ORDER, NOT MISSING DATA. `buildExternalSeedProduct`
// (services/externalSeedProducts:3888) ends its own title fallback with
// `... || canonicalUrl || destinationUrl || externalProductId`, so for a seed
// with no authored title `product.title` arrives here ALREADY holding the URL —
// a non-empty string, which wins `nonEmptyString` at position 1 and means
// `row.product_name` (i.e. `cp.title`) is never consulted.
//
// The real titles were there the whole time. Probed 6 affected rows across 6
// brands: every one renders a proper name on its own PDP —
// "Complexion Essentials", "Rice 72 Serum", "Hyalu-Cica First Ampoule". So the
// residue after this fix is expected to be ~0, not 3,952.
//
// Fixing the builder's fallback instead would NOT fix this: the chain would
// then take `externalProductId` and still never reach `cp.title`. The poisoned
// candidate has to be rejected HERE, where the alternative sources are in hand.
const URL_SHAPED = /^(https?:)?\/\//i;

// An ID is not a name either. The builder's chain ends `… || externalProductId`,
// so with an empty canonical_url the feed shipped `"ext_x1"` as a product title
// — demonstrated by review, and invisible to the residue counter because the
// value is non-empty and not URL-shaped.
//
// FULL match, not a prefix: a real product legitimately named "ext_" something,
// or any name that merely begins with those letters, must survive. Only a title
// that IS nothing but an id is rejected.
const BARE_ID_SHAPED = /^(ext|sig|merch)_[a-z0-9_]+$/i;

// Exported and shared so the lane and the gate cannot drift apart — two copies
// of one predicate is the failure ADR-012 names, and review found the /i flag
// unpinned on both.
function isUsableTitleText(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  if (URL_SHAPED.test(text)) return false;
  if (BARE_ID_SHAPED.test(text)) return false;
  return true;
}

function firstUsableTitle(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    // Skip empty AND URL-shaped candidates, rather than stopping at the first
    // non-empty one. Deliberately not skipping `ext_*`/`sig_*` ids too: those
    // are a different (and much rarer) fallback, and widening this predicate
    // without measuring it first is how a title gate starts dropping real
    // products whose name legitimately begins with an id.
    if (isUsableTitleText(text)) return text;
  }
  return '';
}

function safeJsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeJsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const decoded = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    return isUsableCursor(decoded) ? decoded : null;
  } catch (_err) {
    return null;
  }
}

// A MALFORMED CURSOR IS AN ABSENT CURSOR, never a 500.
//
// Decoding used to succeed on any JSON object and hand its fields straight to
// Postgres, so two shapes reached the DB and crashed it — confirmed live on
// acp.pivota.cc, unauthenticated:
//
//   {"sort_updated_at":"not-a-date","product_entity_id":"x",
//    "source_product_id":"y"}  -> 500  ($N::timestamptz cast, ~line 390-397)
//   {"offset": 1e21}           -> 500  (bigint overflow on OFFSET)
//
// There is NO injection here — every value is a bound parameter, and
// `{"source_listing_ref":"' OR 1=1--"}` correctly returns 200 count=0. This is
// availability, not confidentiality. But until now the only way to deliver a
// cursor at all was a JSON body on a GET, which no crawler stumbles into;
// forwarding the query string puts it one plain URL away on a public,
// crawler-facing feed — one bad link or scanner from a 500.
//
// Degrading to "start from the beginning" is also what a caller replaying a
// stale or truncated cursor link actually wants.
//
// Deliberately SHAPE-only: this validates what Postgres will be asked to cast,
// not whether the cursor points anywhere real. A well-formed cursor for a
// deleted row still legitimately returns an empty page.
// Every field that reaches a bind, not just the two that reach a CAST. The
// first version of this guard checked `offset` and `sort_updated_at` only, and
// review proved that insufficient against a local PG 15 on three counts:
//
//   * `Date.parse` is LOOSER than `::timestamptz`, not equal to it. 11 of 20
//     Date.parse-accepted strings threw: "2026", "2026-07", "Jan 2026", "0",
//     "12", "5/5", "0000-01-01T00:00:00Z", "+275760-09-13T00:00:00.000Z",
//     "Jul 28 2026 GMT+9999". Using it as a proxy for the cast was the error.
//   * A NUL byte defeats it in the field it does check —
//     `Date.parse('2026-07-28T00:00:00Z' + a NUL byte)` is a valid number, and
//     `String.trim()` does not strip it. PG: "invalid byte sequence for
//     encoding UTF8: 0x00".
//   * `product_entity_id`, `source_product_id` and `source_listing_ref` were
//     validated by NOTHING. They are text comparisons so no cast can throw —
//     but 0x00 kills the connection-level encode whatever the comparison type,
//     so "no cast" is not "no hazard".
//
// Strict ISO-8601 instead of Date.parse: the only cursor this feed MINTS is
// `{source_listing_ref, market, tool, include_attached}` (see the keyset cursor
// builder below), and a keyset cursor's timestamp is always an ISO string. So
// the strict form accepts everything we produce and rejects the free-form
// strings that reach the cast. Date.parse still runs afterwards to catch
// shapes the regex admits but that are not real dates (month 13, day 32).
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

// 0x00 is the one that matters (it breaks the encode, not the parse); the rest
// of the C0 range has no business in an id and costs nothing to refuse.
const hasControlChars = (s) => /[\u0000-\u001f\u007f]/.test(s);

function isUsableCursor(c) {
  // Reject unexpected value types across the board FIRST — a nested object or
  // array bound as a parameter is its own class of upstream surprise.
  for (const [k, v] of Object.entries(c)) {
    if (v == null) continue;
    if (typeof v === 'string') {
      if (hasControlChars(v)) return false;
      continue;
    }
    if (typeof v === 'number' || typeof v === 'boolean') continue;
    return false; // objects, arrays, anything else
  }

  if (c.offset != null) {
    const n = Number(c.offset);
    // `Number.isSafeInteger` rejects 1e21, Infinity, NaN and 1.5 in one check.
    // A negative offset is not a crash, but it is not a page either.
    if (!Number.isSafeInteger(n) || n < 0) return false;
  }

  if (c.sort_updated_at != null) {
    const t = c.sort_updated_at;
    if (typeof t !== 'string') return false;
    if (!ISO_TIMESTAMP_RE.test(t)) return false;
    // Catches what the calendar check below cannot see: the TIME fields. V8
    // rejects hour 25 and minute 60 in an ISO string, so this is load-bearing
    // for `2026-07-28T25:00:00Z`, which the regex's `\d{2}` happily admits.
    if (Number.isNaN(Date.parse(t))) return false;
    if (!isRealCalendarDate(t)) return false;
  }

  return true;
}

// Date.parse is NOT a calendar validator, and assuming it was is what left six
// live 500s in the previous version of this guard.
//
// V8's ISO parser accepts day 01-31 for ANY month and then `MakeDay` ROLLS OVER:
// `Date.parse('2026-02-30T00:00:00Z')` returns a number (it becomes Mar 2), so
// the "secondary Date.parse check" the last commit described as catching
// "month 13 / day 32" catches neither of these:
//
//   2026-02-30  2026-04-31  2026-06-31  2026-09-31  2026-11-31  2025-02-29
//
// All six passed the regex (`\d{2}`), passed Date.parse, and reached
// `$N::timestamptz` -> "date/time field value out of range". Delivered as a
// base64url `?cursor=`, which needs no URL encoding at all.
//
// A UTC round-trip is the check that actually holds: build the date from its
// components and require every component to survive. Rollover changes at least
// one of them, so Feb 30 -> Mar 2 fails on the day, month 13 fails on the year,
// day 00 fails by rolling into the previous month. Leap days are correct for
// free — 2024-02-29 survives, 2025-02-29 does not — with no leap-year rule
// written here, which is the point: the platform already knows the calendar.
//
// NO SEPARATE YEAR-0000 CASE. An earlier draft had one; mutation testing showed
// it was unkillable, i.e. redundant. `Date.UTC(0, ...)` maps year 0 to 1900, so
// the round-trip compares 1900 against 0 and rejects it anyway. A guard no
// mutation can kill is not defence in depth — it is dead weight that hides
// which check is actually load-bearing, so it is gone rather than papered over
// with a test that only exercises the sibling.
//
// The three-component comparison is deliberately kept WHOLE even though the
// month leg alone catches every case the regex can produce today (rollover
// always changes the month: Feb 30 -> Mar, day 32 -> next month, day 00 ->
// previous month). Pruning it to just the month would be correct-by-accident
// and would silently become wrong if the regex ever admitted a different digit
// width. One idiom that states "every component survived" beats three guards
// where two are load-bearing only under conditions a future edit controls.
function isRealCalendarDate(t) {
  const year = Number(t.slice(0, 4));
  const month = Number(t.slice(5, 7));
  const day = Number(t.slice(8, 10));
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year
    && d.getUTCMonth() === month - 1
    && d.getUTCDate() === day;
}

// `[object Object]` is not a brand — it is a coercion accident, and it POISONS a
// fallback chain because it is a non-empty string and therefore WINS.
//
// Upstream, `externalSeedProducts.js:firstNonEmptyString` does
// `String(value || '')`, so an object-valued brand candidate (several seeds
// carry schema.org-shaped `{"@type":"Brand","name":"Anua"}`) arrives here
// ALREADY stringified. `normalizeBrand`'s own `typeof === 'object'` unwrap
// cannot see it — by then it is a string.
//
// Measured on prod 2026-07-28 over the 20 rows the ACP feed serves: 12 of 20
// (60%) resolved to the literal `"[object Object]"` while the CLEAN value sat
// further down the very same chain in `catalog_products.brand` ("Mediheal US",
// "Anua", …), outranked by the garbage. Rejecting the sentinel lets the truth
// win — this is a recovery, not a blanking.
//
// Scoped to the two DISPLAY normalizers on purpose. The shared `nonEmptyString`
// also builds ids, `content_key` and `title`, where changing what counts as
// "empty" could change which rows survive the `!/^sig_/` drop and so move the
// live `get_product_entity_index_feed` row COUNT. Brand and category cannot: the
// worst case here is the field falls through to '' exactly as it would have if
// the poisoned candidate had been absent. The upstream helper is the real
// defect and is filed separately; it feeds a 4,000-line module and many surfaces.
const STRINGIFIED_OBJECT = '[object Object]';

function withoutStringifiedObjects(values) {
  return values.filter((v) => {
    // Drop live objects WITHOUT coercing them. `nonEmptyString` short-circuits at
    // the first non-empty candidate; a filter does not, so a `String(v)` here
    // runs on EVERY candidate including ones the original chain would never have
    // touched. A scraped JSON-LD blob carrying a non-callable `toString` key
    // therefore threw on this branch where origin/main returned a good earlier
    // value — a hard 500 on the public feed and on the live
    // `get_product_entity_index_feed`. Testing the type first cannot throw, and
    // an object can only ever coerce to the sentinel anyway.
    // Arrays are deliberately let through: `nonEmptyString` renders ['Anua'] as
    // 'Anua', which is a real value, not a coercion accident.
    if (v && typeof v === 'object' && !Array.isArray(v)) return false;
    // The actual defect: the object was ALREADY stringified upstream, so by the
    // time it reaches here it is an ordinary string that wins the coalesce.
    return typeof v !== 'string' || v.trim() !== STRINGIFIED_OBJECT;
  });
}

function normalizeBrand(product, row, seedData, snapshot) {
  const productBrand = product && typeof product.brand === 'object' ? product.brand?.name : product?.brand;
  return nonEmptyString(
    ...withoutStringifiedObjects([
    productBrand,
    product?.vendor,
    row.brand,
    seedData.brand,
    seedData.brand_name,
    seedData.vendor,
    snapshot.brand,
    snapshot.brand_name,
    snapshot.vendor,
    ]),
  );
}

function normalizeCategory(product, row, seedData, snapshot) {
  const categoryPath = Array.isArray(product?.category_path) ? product.category_path.join(' > ') : '';
  return nonEmptyString(
    ...withoutStringifiedObjects([
    categoryPath,
    product?.category,
    product?.product_type,
    row.category,
    seedData.category,
    seedData.product_type,
    snapshot.category,
    snapshot.product_type,
    ]),
  );
}

function buildProductEntityIndexFeedItem(row, env = process.env) {
  const seedData = safeJsonObject(row?.seed_data);
  const snapshot = safeJsonObject(seedData.snapshot);
  const product = buildExternalSeedProduct(row) || {};
  const sourceProductId = nonEmptyString(
    row.source_product_id,
    product.product_id,
    product.id,
    row.external_product_id,
    seedData.external_product_id,
    seedData.product_id,
    snapshot.product_id,
  );
  const productEntityId = nonEmptyString(row.product_entity_id, row.sellable_item_group_id);
  if (!/^sig_[a-z0-9]+$/i.test(productEntityId) || !sourceProductId) return null;
  const title = firstUsableTitle(product.title, product.name, row.product_name, row.title, seedData.title, snapshot.title);
  // Amount and currency must come from the same source: the joined best-offer
  // row when present, else the seed-derived product. No cross-source mixing
  // and no currency default (the INR-served-as-USD class).
  const rowPrice = Number(row.price_amount);
  const productPrice = Number(product.price);
  let priceAmount = null;
  let priceCurrency = null;
  if (Number.isFinite(rowPrice) && rowPrice > 0) {
    priceAmount = rowPrice;
    priceCurrency = nonEmptyString(row.price_currency) || null;
  } else if (Number.isFinite(productPrice) && productPrice > 0) {
    priceAmount = productPrice;
    priceCurrency = nonEmptyString(product.currency) || null;
  }
  return {
    id: sourceProductId,
    product_id: sourceProductId,
    external_seed_id: /^ext_[a-z0-9_]+$/i.test(sourceProductId) ? sourceProductId : nonEmptyString(row.external_seed_id),
    source_product_id: sourceProductId,
    merchant_id: nonEmptyString(row.merchant_id, product.merchant_id, EXTERNAL_SEED_MERCHANT_ID),
    merchant_name: nonEmptyString(row.merchant_name, product.merchant_name),
    source: nonEmptyString(row.source, product.source, 'canonical_catalog'),
    product_entity_id: productEntityId,
    product_group_id: productEntityId,
    sellable_item_group_id: productEntityId,
    canonical_sig_id: productEntityId,
    content_key: nonEmptyString(row.content_key),
    title,
    name: title,
    brand: normalizeBrand(product, row, seedData, snapshot),
    category: normalizeCategory(product, row, seedData, snapshot),
    canonical_url: product.canonical_url || row.canonical_url || snapshot.canonical_url || '',
    destination_url: product.destination_url || row.destination_url || snapshot.destination_url || '',
    image_url: product.image_url || row.image_url || snapshot.image_url || '',
    seller_count: Number(row.seller_count || 0) || undefined,
    member_count: Number(row.member_count || 0) || undefined,
    offer_count: Number(row.offer_count || 0) || undefined,
    member_refs: safeJsonArray(row.member_refs),
    price_amount: priceAmount,
    price_currency: priceCurrency,
    price: priceAmount,
    currency: priceCurrency,
    availability: nonEmptyString(row.availability, product.availability) || null,
    // ADR-018. `catalog_track` already encodes layers 1 vs 2 with no new
    // storage, which is why the layer is DERIVED rather than stored: a stored
    // copy would be a third thing to keep in sync with catalog_track and
    // merchant_stores.status, both of which move, and a stale derivative is
    // this stack's recurring failure.
    //
    // This lane can only see the ROW, so it can only answer layers 1 vs 2 —
    // layer 3 additionally needs a merchant-scoped PSP fact this query does not
    // join. It reports 2, not 3, for a synced row: understating the layer costs
    // an agent nothing (execution_path is what it acts on), whereas overstating
    // it would advertise a settlement rail that may not exist. Measured 2026-07-27,
    // this is academic — 100% of the real serving catalog is layer 1 and layers
    // 2 and 3 have ZERO non-rig population — but the contract is fixed now so
    // the first real sync is a data change, not a shape change.
    // Plain PDP content, already public on the page this item links to, and it
    // carries no semantic CLAIM the way `connection_layer` does — so unlike that
    // field this one is emitted ungated. Stated rather than assumed: it does
    // mean the flags-off item payload differs from origin/main by exactly this
    // one additive key. Ingesters treat description-less items as low quality,
    // and the ACP projection has no other source for it.
    description: nonEmptyString(row.product_description, product.description) || undefined,
    // ── connection_layer is NOT emitted here. Read this before adding it back. ──
    //
    // ADR-018's whole rationale — the one given to the founder — is that the
    // layer and the execution path ship as TWO fields precisely so the layer can
    // never imply an execution guarantee. This lane can derive the layer (from
    // catalog_track) but CANNOT derive `execution_path`: that needs the
    // warm-handoff brand allowlist and the ACP door state, neither of which this
    // query sees. Emitting `connection_layer: 1` beside `execution_path:
    // undefined` ships the empty half of the contract and reintroduces exactly
    // the implication the two-field design exists to prevent.
    //
    // `connectionLayerForTrack` and its tests stay — the derivation is correct
    // and is what a caller that CAN resolve an execution path should use. The
    // rule is: both fields together, or neither.
    updated_at: row.source_updated_at || row.updated_at || row.identity_updated_at || null,
  };
}

async function getProductEntityIndexFeed(payload = {}, deps = {}) {
  const query = deps.query || defaultQuery;
  const limit = clampInt(payload.limit, 100, 1, 500);
  const cursor = decodeCursor(payload.cursor);
  const page = clampInt(payload.page, 1, 1, 100000);
  const offset = cursor && Number.isFinite(Number(cursor.offset))
    ? Math.max(0, Math.floor(Number(cursor.offset)))
    : Math.max(0, (page - 1) * limit);
  const cursorSourceListingRef = nonEmptyString(cursor?.source_listing_ref);
  const cursorSortUpdatedAt = nonEmptyString(cursor?.sort_updated_at);
  const cursorProductEntityId = nonEmptyString(cursor?.product_entity_id);
  const cursorSourceProductId = nonEmptyString(cursor?.source_product_id);
  const useSourceRefCursor = Boolean(cursorSourceListingRef);
  const useSortKeysetCursor = !useSourceRefCursor && Boolean(
    cursorSortUpdatedAt && cursorProductEntityId && cursorSourceProductId,
  );
  const market = nonEmptyString(payload.market, process.env.EXTERNAL_SEED_MARKET, 'US');
  const tool = nonEmptyString(payload.tool, 'creator_agents');
  const includeAttached = payload.include_attached === true || payload.includeAttached === true;

  // ── ELECTED-CANONICAL REPRESENTATIVE (default OFF) ──────────────────────────
  //
  // This lane picks ONE row per content_key with a ROW_NUMBER whose tie-breaks
  // (is_primary → lifecycle → minted_at → updated_at → product_key) predate the
  // canonical election and know nothing about it. `content_canonical_election`
  // is now seeded in prod — 4,266 rows — and it is a DIFFERENT choice.
  //
  // Measured against prod 2026-07-27, over the 4,467 content_keys this lane
  // would serve to the ACP feed:
  //     4,266 have an election row
  //        83 where THIS lane's rank-1 sig ≠ the elected canonical_sig_id
  //       201 with no election row at all
  //
  // Those 83 matter specifically on a shopping feed — but ONLY because
  // acpFeedSource's projection now keys the feed item on `product_entity_id`.
  // Worth recording precisely, because the first cut of this comment was wrong:
  // while the ACP projection still keyed on `source_product_id`, moving the
  // rank-1 sig was UNOBSERVABLE on the feed (every link was an ext_ id, i.e. a
  // 500 regardless of which sibling won). The rationale below is true of the
  // code as it now stands, not of the code the flag was first written against.
  //
  // With the projection fixed, the item's `link` IS built from the rank-1 sig,
  // so without this preference the feed would advertise a PDP whose own
  // rel=canonical points at a DIFFERENT URL. An ingester reads that as a
  // canonical conflict and drops or merges the item — and the attribution goes
  // with it. Rather than a second canonicalisation mechanism (there are already
  // three), this defers to the election when one exists and falls back to the
  // untouched tie-break chain when it does not.
  //
  // Flagged because this lane also serves the LIVE `get_product_entity_index_feed`
  // operation, where changing which sig represents a group changes ids that
  // callers may have cached. Flag off ⇒ SQL byte-identical to today.
  const electedCanonicalEnabled = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.INDEX_FEED_ELECTED_CANONICAL || '').trim().toLowerCase(),
  ) && !CONTENT_CANONICAL_ELECTION_TABLE_MISSING;

  // Built as a function of `on` rather than as fixed consts, so the retry below
  // can rebuild the SAME statement with the join dropped.
  const electionFragments = (on) => ({
    // The column is selected either way so `canonical_rows` has a stable shape
    // and the ranked CTE's `cr.*` does not change arity between the two builds.
    select: on
      ? 'cce.canonical_sig_id AS elected_canonical_sig_id,'
      : 'NULL::text AS elected_canonical_sig_id,',
    join: on
      ? 'LEFT JOIN content_canonical_election cce ON cce.content_key = cp.content_key'
      : '',
    // Leading term, so it wins over every existing tie-break — but ONLY when an
    // election exists for that key. Three-way rather than a boolean: keys with
    // NO election (201 of them) sort at 1, ahead of a NON-elected sibling at 2,
    // so their ordering is decided entirely by the untouched tie-break chain
    // below. `IS NOT DISTINCT FROM` rather than `=` so a NULL on either side
    // yields false instead of NULL — a NULL CASE result would scatter the
    // ordering rather than fall through.
    rank: on
      ? `CASE
                WHEN cr.elected_canonical_sig_id IS NULL THEN 1
                WHEN cr.pivota_signature_id IS NOT DISTINCT FROM cr.elected_canonical_sig_id THEN 0
                ELSE 2
              END,`
      : '',
  });

  // PRICE GATE IN SQL, not only in JS (default OFF — opt in per caller).
  //
  // The best-offer join is a LEFT JOIN LATERAL, so an offer-less row comes back
  // with a NULL price. Filtering those in JS *after* the query means LIMIT
  // counted rows that then vanish: in prod roughly 4,467 of ~5,887 rows are
  // priced, so about a QUARTER of every page would silently disappear — and the
  // ACP feed body (`{version, count, products}`) carries no cursor, so there is
  // no top-up and no second page to recover them. The caller asks for 20 and
  // gets 15, with nothing saying why.
  //
  // Pushing the predicate into `mapped` makes LIMIT apply to quotable rows. The
  // JS gate stays as defence-in-depth: they fail independently, and the JS one
  // also covers a lane that is not this SQL.
  const pricedOnly = payload.priced_only === true || payload.pricedOnly === true;
  const pricedOnlyWhere = pricedOnly
    ? "AND best_offer.price_amount IS NOT NULL AND best_offer.price_currency IS NOT NULL"
    : '';

  const fetchLimit = limit + 1;
  const params = [];
  // Best-offer price preference: in-market offers first. Captured as a bind
  // up front so the LATERAL below can reference it regardless of which
  // pagination binds are added later.
  const bestOfferMarketParam = params.push(String(market).toUpperCase());
  let identityPaginationWhere = '';
  let paginationWhere = '';
  if (useSourceRefCursor) {
    const sourceRefParam = params.push(cursorSourceListingRef);
    identityPaginationWhere = `AND ('catalog_content_key:' || ranked.content_key) > $${sourceRefParam}`;
  } else if (useSortKeysetCursor) {
    const sortParam = params.push(cursorSortUpdatedAt);
    const productParam = params.push(cursorProductEntityId);
    const sourceParam = params.push(cursorSourceProductId);
    paginationWhere = `
      WHERE (
        sort_updated_at < $${sortParam}::timestamptz
        OR (
          sort_updated_at = $${sortParam}::timestamptz
          AND product_entity_id > $${productParam}
        )
        OR (
          sort_updated_at = $${sortParam}::timestamptz
          AND product_entity_id = $${productParam}
          AND source_product_id > $${sourceParam}
        )
      )
    `;
  }
  params.push(fetchLimit);
  const limitParam = params.length;
  let offsetClause = '';
  if (!useSourceRefCursor && !useSortKeysetCursor && offset > 0) {
    params.push(offset);
    offsetClause = `OFFSET $${params.length}`;
  }

  const buildSql = (withElection) => {
    const election = electionFragments(withElection);
    return `
      WITH offer_stats AS (
        SELECT
          s.product_key,
          COUNT(DISTINCT o.offer_id)::int AS offer_count
        FROM catalog_skus s
        LEFT JOIN catalog_offers o ON o.sku_key = s.sku_key
        GROUP BY s.product_key
      ),
      canonical_rows AS (
        SELECT
          cp.content_key,
          cp.product_key,
          cp.merchant_id,
          cm.merchant_name,
          cp.platform,
          cp.source_product_id,
          cp.title AS product_name,
          cp.description AS product_description,
          cp.brand,
          cp.category,
          cp.product_type,
          cp.canonical_url,
          cp.pivota_canonical_url,
          cp.image_url,
          cp.product_payload,
          cp.pivota_signature_id,
          cp.pivota_signature_minted_at,
          cp.pdp_lifecycle_stage,
          cp.updated_at,
          cp.catalog_track,
          ${election.select}
          pgm.product_group_id AS internal_product_group_id,
          COALESCE(pgm.is_primary, false) AS is_primary,
          COALESCE(offer_stats.offer_count, 0)::int AS offer_count
        FROM catalog_products cp
        INNER JOIN index_pipeline_state ips
          ON ips.content_key = cp.content_key
         AND ips.serving_eligible = TRUE
        LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
        LEFT JOIN product_group_members pgm
          ON pgm.merchant_id = cp.merchant_id
         AND pgm.platform = cp.platform
         AND pgm.platform_product_id = cp.source_product_id
        LEFT JOIN offer_stats ON offer_stats.product_key = cp.product_key
        ${election.join}
        WHERE cp.content_key IS NOT NULL
          AND cp.pivota_signature_id LIKE 'sig\\_%' ESCAPE '\\'
          AND ${activeCatalogProductSourceWhere('cp', 'cm')}
      ),
      ranked AS (
        SELECT
          cr.*,
          ROW_NUMBER() OVER (
            PARTITION BY cr.content_key
            ORDER BY
              ${election.rank}
              CASE WHEN cr.is_primary = true THEN 0 ELSE 1 END,
              CASE cr.pdp_lifecycle_stage
                WHEN 'published' THEN 0
                WHEN 'validated' THEN 1
                WHEN 'candidate' THEN 2
                WHEN 'draft' THEN 3
                ELSE 9
              END,
              cr.pivota_signature_minted_at ASC NULLS LAST,
              cr.updated_at DESC NULLS LAST,
              cr.product_key ASC
          ) AS row_rank
        FROM canonical_rows cr
      ),
      stats AS (
        SELECT
          content_key,
          COUNT(*)::int AS member_count,
          COUNT(DISTINCT merchant_id)::int AS seller_count,
          COALESCE(SUM(offer_count), 0)::int AS offer_count,
          MAX(updated_at) AS sort_updated_at,
          jsonb_agg(
            jsonb_build_object(
              'merchant_id', merchant_id,
              'merchant_name', merchant_name,
              'product_id', source_product_id,
              'platform', platform,
              'product_key', product_key,
              'pivota_signature_id', pivota_signature_id,
              'is_primary', is_primary
            )
            ORDER BY
              CASE WHEN is_primary = true THEN 0 ELSE 1 END,
              product_key ASC
          ) AS member_refs
        FROM canonical_rows
        GROUP BY content_key
      ),
      mapped AS (
        SELECT
          'catalog_content_key:' || ranked.content_key AS source_listing_ref,
          ranked.pivota_signature_id AS product_entity_id,
          ranked.source_product_id AS source_product_id,
          null::text AS external_seed_row_id,
          ranked.source_product_id AS external_product_id,
          ranked.canonical_url AS destination_url,
          COALESCE(ranked.pivota_canonical_url, ranked.canonical_url) AS canonical_url,
          regexp_replace(lower(coalesce(ranked.canonical_url, ranked.pivota_canonical_url, '')), '^https?://(?:www\\.)?([^/]+).*$','\\1') AS domain,
          ranked.product_name,
          ranked.image_url,
          best_offer.price_amount AS price_amount,
          best_offer.price_currency AS price_currency,
          best_offer.availability AS availability,
          COALESCE(ranked.brand, '') AS brand,
          COALESCE(ranked.category, ranked.product_type, '') AS category,
          COALESCE(ranked.product_payload, '{}'::jsonb) AS seed_data,
          ranked.updated_at AS source_updated_at,
          COALESCE(stats.sort_updated_at, ranked.updated_at, '1970-01-01T00:00:00Z'::timestamptz) AS sort_updated_at,
          ranked.updated_at AS identity_updated_at,
          0.96::numeric AS identity_confidence,
          ranked.merchant_id,
          ranked.merchant_name,
          ranked.content_key,
          ranked.catalog_track,
          ranked.product_description,
          ranked.elected_canonical_sig_id,
          ranked.internal_product_group_id,
          stats.seller_count,
          stats.member_count,
          stats.offer_count,
          stats.member_refs,
          'canonical_catalog'::text AS source
        FROM ranked
        JOIN stats ON stats.content_key = ranked.content_key
        -- Shopping ingesters reject price-null items, so every feed item
        -- carries ONE representative offer's price: amount, currency, and
        -- availability from the SAME offer row (never mixed across rows),
        -- cheapest in-market first. Currency is never defaulted — an offer
        -- without a currency is not price-quotable and is skipped.
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(o.merchant_effective_price, o.list_price) AS price_amount,
            o.currency AS price_currency,
            o.availability AS availability
          FROM catalog_offers o
          WHERE o.product_key = ranked.product_key
            AND o.suppressed_at IS NULL
            AND COALESCE(o.merchant_effective_price, o.list_price) > 0
            AND o.currency IS NOT NULL
          ORDER BY
            CASE WHEN upper(coalesce(o.market, '')) = $${bestOfferMarketParam} THEN 0 ELSE 1 END,
            COALESCE(o.merchant_effective_price, o.list_price) ASC,
            o.offer_id ASC
          LIMIT 1
        ) best_offer ON TRUE
        WHERE ranked.row_rank = 1
          ${pricedOnlyWhere}
          ${identityPaginationWhere}
      )
      SELECT *, COUNT(*) OVER() AS total_rows
      FROM mapped
      ${paginationWhere}
      ORDER BY
        source_listing_ref ASC
      LIMIT $${limitParam}
      ${offsetClause}
    `;
  };

  // The election table is created by pivota-backend migration 181, applied at
  // BACKEND boot via db/schema_guard.py. This repo deploys independently, so
  // there is a window — and a merge-order mistake — in which this gateway runs
  // against a database that has not grown the table yet. A missing relation
  // must degrade this lane to its pre-election behaviour, never 500 it: the
  // election adds a canonical PREFERENCE, and losing a preference is not worth
  // losing the feed.
  //
  // Latched per process — and stated precisely, because the obvious phrasing is
  // false: the table CAN appear mid-process, since the backend creates it at
  // ITS boot (db/schema_guard.py) and that is a different process from this
  // long-lived gateway. The latch is a deliberate trade, not a claim about the
  // world. Re-probing would put a guaranteed-failing query in front of every
  // request, and the cost of being wrong is only that the canonical preference
  // stays off until this process restarts. It does NOT self-heal; a gateway
  // deploy clears it.
  let result;
  try {
    result = await query(buildSql(electedCanonicalEnabled), params);
  } catch (err) {
    if (!electedCanonicalEnabled || !isMissingContentCanonicalElectionError(err)) throw err;
    CONTENT_CANONICAL_ELECTION_TABLE_MISSING = true;
    result = await query(buildSql(false), params);
  }

  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const pageRows = rows.slice(0, limit);
  const products = pageRows.map(buildProductEntityIndexFeedItem).filter(Boolean);
  const total = Math.max(0, Number(rows[0]?.total_rows || 0) || 0);
  const nextOffset = offset + pageRows.length;
  const hasNextPage = rows.length > limit;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasNextPage && lastRow
    ? encodeCursor({
      source_listing_ref: lastRow.source_listing_ref,
      market,
      tool,
      include_attached: includeAttached,
    })
    : null;

  return {
    status: 'success',
    success: true,
    products,
    total,
    page: useSourceRefCursor || useSortKeysetCursor ? page : Math.floor(offset / limit) + 1,
    page_size: products.length,
    pagination: {
      limit,
      offset: useSourceRefCursor || useSortKeysetCursor ? null : offset,
      total_count: total || null,
      has_more: hasNextPage,
    },
    cursor_info: {
      next_cursor: nextCursor,
      has_next_page: hasNextPage,
      serving_mode: 'product_entity_index_feed',
    },
    metadata: {
      query_source: 'product_entity_index_feed',
      source: 'backend_external_seeds',
      market,
      tool,
      include_attached: includeAttached,
      cursor_mode: useSourceRefCursor
        ? 'source_listing_ref'
        : useSortKeysetCursor
          ? 'keyset'
          : 'initial_or_offset',
      rows_returned: pageRows.length,
      products_returned_count: products.length,
      next_offset: useSourceRefCursor || useSortKeysetCursor ? null : nextOffset,
    },
  };
}

module.exports = {
  getProductEntityIndexFeed,
  firstUsableTitle,
  isUsableTitleText,
  buildProductEntityIndexFeedItem,
  // Exported for the cursor-validation tests. `getProductEntityIndexFeed`
  // itself needs a live DB, so the malformed-cursor guard is unreachable from
  // the outside without this — and an unreachable guard is an untested one.
  decodeCursor,
  connectionLayerForTrack,
  connectionLayerFieldEnabled,
  isMissingContentCanonicalElectionError,
};
