'use strict';

// The relationship graph obeys the catalog's serving gate.
//
// WHY (2026-10-21). The targeted rebuild proposed fentybeauty.com's "Donate To The Clara Lionel
// Foundation" as a competitive_alternative for 8 anchors. Its catalog row was stale and its seed
// active, and nothing in the graph looked at the catalog row: the seed lane reads
// external_product_seeds.status only, the products_cache and affected-anchor lanes join
// catalog_products without a suppression filter, the review queue reads label_state only, and
// the serving read reads the product_relationship_edges view only. Only target recall required a
// live, unsuppressed, renderable row. Suppressing a listing therefore never removed it from the
// graph. Census: pivota-backend docs/audits/non_product_listings_2026-10-21.md (pivota-backend#2664).
//
// THE GATE. A product ref resolves to the catalog rows it names:
//   product:<sig>            -> catalog_products.pivota_signature_id
//   product:<ext/source id>  -> catalog_products.source_product_id, and through
//                               external_product_seeds.external_product_id (or seed id) to the
//                               seed's attached_product_key
//   product:<product_key>    -> catalog_products.product_key
// plus the same ids read off the stored snapshot (product_id, source_product_id,
// pivota_signature_id, product_key), because a canonical re-keyed ref (product:pg_...) names no
// catalog row while its snapshot keeps the listing's own ids.
//
// A ref FAILS when it resolves to at least one catalog row and NONE of them is servable:
// sync_status 'live', not suppressed (suppressed_at / suppression_reason), and
// index_pipeline_state.serving_eligible not false for its content_key.
//
// TRI-STATE, deliberately: a ref that resolves to no catalog row, or a row with no IPS row,
// passes. Absence is not evidence, and the share of graph refs with no catalog row has not been
// measured; failing them closed would be a blind cut of the candidate pool. Only an explicit
// non-serving state fails.
//
// ONE PREDICATE, THREE READERS. catalogGateFailsSql is the only definition; candidate
// generation (loadCatalogServingGateFailures), the review queue and the serving read all
// splice it, so the three cannot drift apart.

const MAX_KEY_LENGTH = 260;

// ---- Non-product listings: JS twin of pivota-backend _is_non_core_product ---------------------
//
// pivota-backend services/index_pipeline_state_service.py, as extended by pivota-backend#2664.
// NON_PRODUCT_LISTING_RE, NON_PRODUCT_TITLE_START_RE and NON_PRODUCT_TYPES match
// the Python patterns exactly; keep them so. Of the older _NON_CORE_PRODUCT_RE only the gift-card and
// protection-fee arms are mirrored, in their compact form (NON_PRODUCT_COMPACT_RE: "gift card",
// "E-Gift Card" and a "/products/shippingprotection" slug all compact onto it). Its sample / GWP /
// packette / sticker arms are NOT, deliberately: those are merchandise in miniature that the graph
// pairs today (a fragrance sample-vial set is a real alternative), and the backend already rules
// on them through index_pipeline_state.serving_eligible, which the catalog gate below reads.
// The rule reads the title fields and the canonical URL, never the description: "10% of proceeds
// donated" in a description is a product.

const NON_PRODUCT_COMPACT_RE = /(?:giftcard|shippingprotection|deliveryprotection|packageprotection)/i;

const NON_PRODUCT_LISTING_RE = new RegExp(
  '\\b(?:'
  + 'donations?|'
  + 'gift\\s+(?:certificate|voucher)s?|e\\s*vouchers?|store\\s+credit|'
  + '(?:shipping|package|delivery|order|parcel|shipment)\\s+(?:protection|insurance|guarantee)|'
  + 'route\\s+(?:shipping\\s+)?(?:insurance|protection)|'
  + 'gratuity|tip\\s+jar|'
  + '(?:booking|pre\\s*order|appointment|reservation|security)\\s+deposit'
  + ')\\b',
  'i',
);

// Only at the START of ONE title: "Q-Tip Precision Swabs", "Fingertip Blender", "Colour Deposit
// Mask" and "Proceeds Donated To ..." are products.
const NON_PRODUCT_TITLE_START_RE = new RegExp(
  '^\\W*(?:'
  + 'donate\\b|'
  + 'deposit\\s*(?:$|[-:(]|for\\b)|'
  + '(?:add\\s+(?:a\\s+)?)?tips?\\W*$'
  + ')',
  'i',
);

// Exact values only: "Gift Set" and "Gifts" are merchandise.
const NON_PRODUCT_TYPES = new Set([
  'gift card', 'gift cards', 'giftcard', 'giftcards', 'e gift card', 'e gift cards', 'egift card',
  'gift certificate', 'gift voucher', 'donation', 'donations', 'insurance', 'shipping protection',
  'package protection', 'tip', 'tips', 'gratuity', 'deposit',
]);

function text(value) {
  return typeof value === 'string' ? value : '';
}

function snapshotTitles(snapshot) {
  const nested = snapshot.snapshot && typeof snapshot.snapshot === 'object' ? snapshot.snapshot : {};
  return [snapshot.name, snapshot.title, snapshot.display_name, snapshot.displayName,
    snapshot.product_name, snapshot.productName, nested.title, nested.name].map(text).filter(Boolean);
}

function snapshotUrls(snapshot) {
  return [snapshot.canonical_url, snapshot.url, snapshot.canonicalUrl].map(text).filter(Boolean);
}

// The backend reads catalog_products.product_type. A graph snapshot carries the merchant type as
// product_type, or folded into category when the source had no category of its own.
function snapshotTypes(snapshot) {
  return [snapshot.product_type, snapshot.productType, snapshot.category].map(text).filter(Boolean)
    .map((value) => value.replace(/[\s_-]+/g, ' ').trim().toLowerCase());
}

function nonProductListingReason(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const titles = snapshotTitles(snapshot);
  const raw = [...titles, ...snapshotUrls(snapshot)].join(' ').toLowerCase();
  const normalized = raw.replace(/[^a-z0-9%]+/g, ' ');
  const compact = raw.replace(/[^a-z0-9%]+/g, '');
  if (NON_PRODUCT_COMPACT_RE.test(compact) || NON_PRODUCT_LISTING_RE.test(normalized)) return 'non_product_listing';
  if (titles.some((title) => NON_PRODUCT_TITLE_START_RE.test(title))) return 'non_product_listing';
  if (snapshotTypes(snapshot).some((type) => NON_PRODUCT_TYPES.has(type))) return 'non_product_type';
  return '';
}

function isNonProductListing(snapshot) {
  return nonProductListingReason(snapshot) !== '';
}

// ---- Catalog serving gate ----------------------------------------------------------------------

function stripProductPrefix(ref) {
  return text(ref).trim().replace(/^product:/i, '');
}

// The ids a graph product (a normalized source row, or a stored label snapshot) names.
function catalogGateKeys(product, ref) {
  const src = product && typeof product === 'object' ? product : {};
  const keys = [ref === undefined ? src.product_ref : ref, src.product_ref, src.product_id,
    src.source_product_id, src.pivota_signature_id, src.product_key, src.attached_product_key]
    .map(stripProductPrefix)
    .filter((key) => key && key.length <= MAX_KEY_LENGTH);
  return [...new Set(keys)];
}

// SQL twin of catalogGateKeys over a stored label: refSql is the ref column, snapshotSql its
// jsonb snapshot. NULLs never match `= ANY`, and NULLIF keeps '' from matching blank ids.
function catalogGateKeysSql(refSql, snapshotSql) {
  return `ARRAY[NULLIF(regexp_replace(btrim(${refSql}), '^product:', '', 'i'), ''),
    ${['product_id', 'source_product_id', 'pivota_signature_id', 'product_key', 'attached_product_key']
    .map((field) => `NULLIF(regexp_replace(btrim(${snapshotSql}->>'${field}'), '^product:', '', 'i'), '')`).join(',\n    ')}]`;
}

// Every catalog row a key array names. One indexed equality lookup per arm (pivota_signature_id,
// source_product_id, product_key, external_product_seeds.external_product_id / id ->
// attached_product_key); an OR across columns would defeat every index.
function resolvedCatalogRowsSql(keysSql) {
  const cols = 'cp.product_key, cp.content_key, cp.sync_status, cp.suppressed_at, cp.suppression_reason';
  return `(
      SELECT ${cols} FROM catalog_products cp WHERE cp.pivota_signature_id = ANY(${keysSql})
      UNION SELECT ${cols} FROM catalog_products cp WHERE cp.source_product_id = ANY(${keysSql})
      UNION SELECT ${cols} FROM catalog_products cp WHERE cp.product_key = ANY(${keysSql})
      UNION SELECT ${cols} FROM external_product_seeds eps
        JOIN catalog_products cp ON cp.product_key = eps.attached_product_key
        WHERE eps.external_product_id = ANY(${keysSql})
      UNION SELECT ${cols} FROM external_product_seeds eps
        JOIN catalog_products cp ON cp.product_key = eps.attached_product_key
        WHERE eps.id = ANY(${keysSql})
    )`;
}

// The serving predicate of ONE resolved row (alias r) and its IPS row (alias ips). Never NULL: a
// NULL sync_status is not live (as in target recall and the backend's not_live blocker), and a
// NULL here would read as "no row" below and pass.
const CATALOG_ROW_SERVABLE_SQL = `(r.sync_status IS NOT DISTINCT FROM 'live' AND r.suppressed_at IS NULL
      AND r.suppression_reason IS NULL AND ips.serving_eligible IS NOT FALSE)`;

// TRUE when the keys resolve to catalog rows and none is servable. bool_or over no rows is NULL,
// and NULL IS FALSE is false: an unresolved ref passes (see TRI-STATE above).
function catalogGateFailsSql(keysSql) {
  return `((SELECT bool_or(${CATALOG_ROW_SERVABLE_SQL})
      FROM ${resolvedCatalogRowsSql(keysSql)} r
      LEFT JOIN index_pipeline_state ips ON ips.content_key = r.content_key) IS FALSE)`;
}

// For a stored label column pair, e.g. ('l.candidate_product_ref', 'l.candidate_snapshot').
function labelRefFailsCatalogGateSql(refSql, snapshotSql) {
  return catalogGateFailsSql(catalogGateKeysSql(refSql, snapshotSql));
}

// Why each failing subject failed, for diagnostics; the verdict itself is catalogGateFailsSql's.
const CATALOG_GATE_FAILURES_SQL = `
  SELECT s.subject_id,
    (SELECT CASE
        WHEN bool_or(r.suppressed_at IS NOT NULL OR r.suppression_reason IS NOT NULL) THEN 'catalog_suppressed'
        WHEN bool_or(r.sync_status IS DISTINCT FROM 'live') THEN 'catalog_not_live'
        ELSE 'index_not_serving_eligible' END
      FROM ${resolvedCatalogRowsSql('s.keys')} r) AS reason
  FROM jsonb_to_recordset($1::jsonb) AS s(subject_id text, keys text[])
  WHERE ${catalogGateFailsSql('s.keys')}
`;

const DEFAULT_GATE_BATCH_SIZE = 2000;

// Map subject_id -> failure reason for the subjects that fail the gate. queryFn errors propagate:
// a gate that silently answers "nothing failed" when its query breaks is the defect this closes.
async function loadCatalogServingGateFailures({ queryFn, subjects = [], batchSize = DEFAULT_GATE_BATCH_SIZE } = {}) {
  const failures = new Map();
  if (typeof queryFn !== 'function') return failures;
  const usable = subjects.filter((subject) => subject && subject.subject_id && subject.keys?.length);
  for (let i = 0; i < usable.length; i += batchSize) {
    const batch = usable.slice(i, i + batchSize);
    // eslint-disable-next-line no-await-in-loop
    const res = await queryFn(CATALOG_GATE_FAILURES_SQL, [JSON.stringify(batch)]);
    for (const row of Array.isArray(res?.rows) ? res.rows : []) failures.set(row.subject_id, row.reason);
  }
  return failures;
}

// Drops the products that fail the title rule or the catalog gate. Returns the kept products and
// a per-reason count. Products are compared by object identity, so a product shared by several
// lane arrays is decided once.
async function filterProductsByCatalogServingGate(products, { queryFn } = {}) {
  const list = (Array.isArray(products) ? products : []).filter(Boolean);
  const dropped = new Map();
  const counts = {};
  const subjects = [];
  list.forEach((product, index) => {
    const reason = nonProductListingReason(product);
    if (reason) {
      dropped.set(product, reason);
      return;
    }
    subjects.push({ subject_id: String(index), keys: catalogGateKeys(product) });
  });
  const failures = await loadCatalogServingGateFailures({ queryFn, subjects });
  for (const [subjectId, reason] of failures) dropped.set(list[Number(subjectId)], reason);
  for (const reason of dropped.values()) counts[reason] = (counts[reason] || 0) + 1;
  return { kept: list.filter((product) => !dropped.has(product)), dropped, counts };
}

// Serving read (product_relationship_edges). Default OFF: whether approved edges stop serving is a
// serving-surface decision, and the count it would drop has not been measured.
//   off     - not computed (default)
//   shadow  - computed and logged, nothing dropped
//   enforce - failing edges are dropped
const SERVING_GATE_MODES = new Set(['off', 'shadow', 'enforce']);

function relationshipServingCatalogGateMode(env = process.env) {
  const mode = text(env.RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE).trim().toLowerCase();
  return SERVING_GATE_MODES.has(mode) ? mode : 'off';
}

module.exports = {
  CATALOG_GATE_FAILURES_SQL,
  catalogGateFailsSql,
  catalogGateKeys,
  catalogGateKeysSql,
  filterProductsByCatalogServingGate,
  isNonProductListing,
  labelRefFailsCatalogGateSql,
  loadCatalogServingGateFailures,
  nonProductListingReason,
  relationshipServingCatalogGateMode,
  __internal: {
    CATALOG_ROW_SERVABLE_SQL,
    NON_PRODUCT_COMPACT_RE,
    NON_PRODUCT_LISTING_RE,
    NON_PRODUCT_TITLE_START_RE,
    NON_PRODUCT_TYPES,
    resolvedCatalogRowsSql,
  },
};
