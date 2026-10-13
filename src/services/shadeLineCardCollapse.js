'use strict';

// ONE CARD PER SHADE LINE (per store) in search and discovery.
//
// A store that lists every shade of a line as its own page fills a results page with one line:
// many near-identical cards that differ only by colour. Once the identity graph has put those
// pages in one product line (rule shade_line_v2, shadeLineRule.js), this folds one store's cards of
// that line into ONE card: an in-stock representative (shown with ITS OWN listing price, never a
// price borrowed from another shade) and the shade count. Each shade keeps its own sig_/PDP; the
// PDP's shade picker (buildProductLineOptions) links the siblings. Nothing here changes a URL, an
// offer, a price or a PDP.
//
// FLAG: SHADE_LINE_CARD_COLLAPSE_ENABLED=true (default OFF, read per call). Off, every caller
// returns its input untouched and makes no extra read (the identity rows reader does not even
// select the shade-line decision). Independent of the rule's flag (SHADE_LINE_RULE_V2_ENABLED):
// with the rule off no row carries an approved decision, so nothing folds.
//
// WHAT FOLDS. A card folds only on its OWN accepted decision: its identity row carries the rule's
// APPROVED decision naming that row's stored product_line_id (readVerifiedShadeLineId), and the
// decision's store (seller of record @ domain). Cards are bucketed by line AND store. So never:
//   - a v1 sibling (or any member) without a v2 approval of its own -- it stays its own card;
//   - a member a later rebuild refused (set, mini, size_mismatch, ...) or only PROPOSED for a line;
//   - another merchant's (or another domain's) listing, even in the same line.
// The representative is always an accepted member of its bucket.
//
// PRICE. No "from" price: a card's price is the price of the listing it links to (the #2416
// rule). The line's other members only feed the shade counts.
//
// MARKET. The buyer's market is a currency here (buyerMarket.js: the seed `market` column is a
// serving partition, not where the buyer is). A card folds, and a member counts, only when priced
// in the serving currency and no other (servingCurrencyGuard.isPricedInServingCurrency). Others
// are left as they are for the door's currency guard. No FX. No serving currency, no fold. The
// line's other members are read from the CURRENT seed columns (listLiveShadeLineMembers); a member
// with no current price is not counted.
//
// SEARCH PAGES. find_products_multi folds on the candidate pool before the door's guards and the
// page-size trim, but it counts only the cards that SURVIVE those guards (the serving-currency
// guard, the price and availability contracts, the product-group dedupe and the beauty near-dup
// refine, run by the door on a copy of the body): only surviving cards fold, and only as many as
// the surviving pool holds BEYOND the requested page size (a line that would need more is left
// unfolded). So a page is never shorter than it would be without the fold: a folded slot is
// refilled only from a real over-fetch. It folds on the FIRST page only (page 1, offset 0), and
// `total` is left as the lane reported it (a count of listings, the same on every page).
//
// RANK. A line card sits at its representative's own rank (the best-ranked in-stock member, else
// the best-ranked member): it is never lifted above cards that outranked the listing it shows.
//
// DEDUPE ORDER. This runs AFTER the existing same-item dedupe (discovery: sellable_item_group_id
// buckets; search: the lane's own grouping), so members are counted by distinct sellable item.
// Running it twice is a no-op.
//
// PUBLIC PAYLOAD. `shade_line` = { product_line_id, rule_version, shade_count, in_stock_shade_count,
// currency, collapsed_card_count } and `shade_count`. No member refs, no borrowed price.
//
// STILL BLOCKING SHADE_LINE_CARD_COLLAPSE_ENABLED (documented, not built):
//   1. Pages after the first. Without a cursor, page 2 comes from the lane's own offset over the
//      unfolded list, so shades of a line folded on page 1 can reappear on page 2 as their own
//      cards (or fold again into a second line card there -- which is why only page 1 folds).
//      Needs a cursor/offset contract that skips the members a page-1 line card stands for.
//   2. The over-fetch width is the lane's. The code comment on the page-size contract says the
//      upstream "often returns ~50 rows"; that is not measured here. The budget above keeps pages
//      full either way, but on a lane that returns exactly the page size nothing folds.
//   3. `total` counts listings, not cards: a client that derives page counts from it will see
//      fewer cards than `total` suggests on page 1.
//   4. Member-read cost is bounded (only v2-approved lines, a per-line cap applied before the seed
//      join and the trust check) but not measured on prod; the cap makes a shade count a lower
//      bound for lines larger than the cap.

// RE-KEYING THE LINES OLDER RULES MINTED (documented here, NOT done by this code; needs Peng's go):
//   product_line_id is sticky on upsert (pdpIdentityGraph.writeIdentityRows keeps a stored
//   non-empty id unless the new rule is reviewed_multi_offer_merge), so shade_line_v2 only lines
//   up NEW listings. A rebuilt row that is stored in another line gets status 'proposed', with
//   proposed_product_line_id / proposed_review_family_id in soft_identity.shade_line; it keeps
//   its stored ids until an explicitly approved re-key.
//   1. Census, read-only: scripts/census-shade-lines.js. It reads the stored rows (and the stores
//      holding the v1 lines they could adopt) in a READ ONLY transaction, rebuilds each listing IN
//      MEMORY, runs the parser and the group guards with the stored lines, and prints, per
//      proposed line, the members, their stored ids, in_line / rekey, and every refusal. It writes
//      nothing. (A backfill --dry-run persists nothing, and a non-dry rebuild is a prod write.)
//      The census is also the reconciliation for `--only-uncovered` batches: those select only
//      seeds with no listing yet, so a batch never sees the stored v1 siblings of a line and
//      cannot adopt it; the census, which reads the stored rows, does.
//   2. Re-key, with approval, the census's `rekey` rows by ONE of:
//      a. the existing reviewed path, per row, in ONE transaction: write a `force_product_line`
//         override (applyPdpIdentityOverride) with payload.target_product_line_id = the proposed
//         pl_ id AND payload.target_review_family_id = the proposed rf_ id, and
//         UPDATE pdp_identity_listing SET product_line_id = <pl_>, review_family_id = <rf_>,
//         soft_identity = soft_identity || {shade_line: {status:'approved', ...}}, and add the
//         shade to variant_axes when the row has none -- the way
//         scripts/review-and-link-same-canonical-product-line-identities.cjs pairs an override
//         with a row update. The override alone does NOT move a row: applyIdentityOverrides sets
//         the id on the rebuilt listing, but the upsert keeps the stored one.
//      b. a versioned upsert branch, keyed on the PROPOSAL (never on EXCLUDED.product_line_id,
//         which for a stored row is just the rebuilt key, and never on status 'approved', which a
//         row stored elsewhere never gets):
//           product_line_id = CASE
//             WHEN <explicit re-key flag>
//              AND EXCLUDED.soft_identity->'shade_line'->>'status' = 'proposed'
//              AND NULLIF(EXCLUDED.soft_identity->'shade_line'->>'proposed_product_line_id', '') IS NOT NULL
//               THEN EXCLUDED.soft_identity->'shade_line'->>'proposed_product_line_id'
//             ...existing branches...
//         and the same branch reading proposed_review_family_id in the review_family_id CASE;
//         the rebuilt row must also carry the shade axis for the re-keyed member. Then run a
//         targeted (non --only-uncovered) backfill of the approved stores with that flag.
//   review_family_id must move WITH product_line_id in both halves: the review summary
//   aggregates by review_family_id, and a line whose members split across rf_ ids shows partial
//   reviews. The rule mints rf_<hash of the same line key> (or, for an adopted v1 line, that
//   line's own review family), and the census prints both ids for every row.

const { isPricedInServingCurrency } = require('./servingCurrencyGuard');
const { SHADE_LINE_RULE_VERSION, readShadeLineDecision, readVerifiedShadeLineId } = require('./shadeLineRule');

const SHADE_LINE_CARD_COLLAPSE_FLAG = 'SHADE_LINE_CARD_COLLAPSE_ENABLED';

function isShadeLineCardCollapseEnabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env?.[SHADE_LINE_CARD_COLLAPSE_FLAG] || '').trim());
}

function asString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function productInStock(product) {
  if (!isPlainObject(product)) return false;
  const inventory = isPlainObject(product.inventory) ? product.inventory : {};
  const availability = asString(product.availability || inventory.availability || product.stock_status);
  if (/out[_\s-]?of[_\s-]?stock|sold[_\s-]?out|unavailable|discontinued/i.test(availability)) return false;
  if (product.in_stock === false || product.available === false || inventory.in_stock === false) return false;
  return true;
}

function emptyStats(extra = {}) {
  return { applied: false, lines_collapsed: 0, cards_dropped: 0, line_cards: 0, ...extra };
}

/**
 * The bucket a stored identity row belongs to, or '': `<line id>|<store>` when the row's OWN
 * decision is an approval of its stored line, with the store the rule lined it up in.
 */
function shadeLineBucketOf(row) {
  const lineId = readVerifiedShadeLineId(row);
  if (!lineId) return '';
  const store = asString(readShadeLineDecision(row)?.store);
  return store ? `${lineId}|${store}` : '';
}

/**
 * The pure core. `cards` keep their order; a bucket's card takes its representative's own slot.
 *
 * @param {Array} cards
 * @param {object} opts
 * @param {(card)=>string} opts.bucketOf        `<line id>|<store>` for an accepted member, else ''
 * @param {(card)=>object} opts.productOf       the product object the card is built from
 * @param {(card)=>string} opts.memberKeyOf     distinct-member key (sellable item, else listing ref)
 * @param {(card, summary)=>object} opts.decorate
 * @param {string|null} opts.servingCurrency    the buyer's currency; null = fold nothing
 * @param {Map<string, Array>} [opts.lineMembers] line id -> rows from listLiveShadeLineMembers
 * @param {number} [opts.maxCardsDropped]        fold whole buckets, in rank order, while the cards
 *                                               they drop stay within this budget
 * @param {(card)=>boolean} [opts.isEligible]    cards that may fold at all (search: the cards that
 *                                               survive the door's guards); others stay as they are
 */
function collapseCardsByShadeLine(cards, {
  bucketOf,
  isEligible = () => true,
  productOf,
  memberKeyOf,
  decorate,
  servingCurrency,
  lineMembers = new Map(),
  maxCardsDropped = Infinity,
} = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const currency = asString(servingCurrency).toUpperCase();
  if (!list.length) return { cards: list, stats: emptyStats() };
  if (!currency) return { cards: list, stats: emptyStats({ reason: 'no_serving_currency' }) };

  const buckets = new Map();
  list.forEach((card, index) => {
    if (!isEligible(card)) return;
    const bucket = asString(bucketOf(card));
    if (!bucket) return;
    const product = productOf(card);
    if (!isPricedInServingCurrency(product, currency)) return;
    const entries = buckets.get(bucket) || [];
    entries.push({ card, index, product });
    buckets.set(bucket, entries);
  });
  if (!buckets.size) return { cards: list, stats: emptyStats({ reason: 'no_shade_lines' }) };

  let linesCollapsed = 0;
  let cardsDropped = 0;
  let lineCards = 0;
  let budgetSkipped = 0;
  const budget = Number.isFinite(Number(maxCardsDropped)) ? Math.max(0, Number(maxCardsDropped)) : Infinity;
  const replacement = new Map();
  const dropped = new Set();
  const ordered = [...buckets.entries()].sort((a, b) => a[1][0].index - b[1][0].index);
  for (const [bucket, entries] of ordered) {
    const [lineId] = bucket.split('|');
    // Members by distinct sellable item: the bucket's cards, then the line's other accepted members
    // of the SAME store in the buyer's currency.
    const members = new Map();
    for (const entry of entries) {
      const key = asString(memberKeyOf(entry.card)) || `card:${entry.index}`;
      if (!members.has(key)) members.set(key, { inStock: productInStock(entry.product) });
    }
    for (const row of lineMembers.get(lineId) || []) {
      if (shadeLineBucketOf(row) !== bucket) continue;
      const facts = isPlainObject(row.card_facts) ? row.card_facts : {};
      if (!isPricedInServingCurrency(facts, currency)) continue;
      const key = asString(row.sellable_item_group_id) || asString(row.source_listing_ref);
      if (!key || members.has(key)) continue;
      members.set(key, { inStock: productInStock(facts) });
    }

    const previous = entries
      .map((entry) => (isPlainObject(entry.product?.shade_line) ? entry.product.shade_line : null))
      .find((summary) => summary && summary.product_line_id === lineId);
    const shadeCount = Math.max(members.size, Number(previous?.shade_count) || 0);
    if (shadeCount < 2) continue;
    const drops = entries.length - 1;
    if (cardsDropped + drops > budget) {
      // Folding this bucket would leave the page short: the pool has no more cards to refill it.
      budgetSkipped += 1;
      continue;
    }

    const memberList = [...members.values()];
    const representative = entries.find((entry) => productInStock(entry.product)) || entries[0];
    const summary = {
      product_line_id: lineId,
      rule_version: SHADE_LINE_RULE_VERSION,
      shade_count: shadeCount,
      in_stock_shade_count: Math.max(
        memberList.filter((member) => member.inStock).length,
        Number(previous?.in_stock_shade_count) || 0,
      ),
      currency,
      collapsed_card_count: Math.max(entries.length, Number(previous?.collapsed_card_count) || 0),
    };
    // The line card sits at its REPRESENTATIVE's own rank. It is not lifted to the slot of a
    // higher-ranked member that is out of stock: that would move the shown listing above cards
    // that outranked it.
    replacement.set(representative.index, decorate(representative.card, summary));
    for (const entry of entries) {
      if (entry.index !== representative.index) dropped.add(entry.index);
    }
    lineCards += 1;
    if (drops > 0) {
      linesCollapsed += 1;
      cardsDropped += drops;
    }
  }

  const out = [];
  list.forEach((card, index) => {
    if (dropped.has(index)) return;
    out.push(replacement.has(index) ? replacement.get(index) : card);
  });
  return {
    cards: out,
    stats: {
      applied: true,
      lines_collapsed: linesCollapsed,
      cards_dropped: cardsDropped,
      line_cards: lineCards,
      ...(budgetSkipped ? { lines_left_unfolded_for_page_size: budgetSkipped } : {}),
      serving_currency: currency,
    },
  };
}

async function loadLineMembers(lineIds, lineMembersResolverFn) {
  const map = new Map();
  if (!lineIds.length || typeof lineMembersResolverFn !== 'function') return map;
  try {
    const rows = await lineMembersResolverFn({ productLineIds: lineIds });
    for (const row of Array.isArray(rows) ? rows : []) {
      const lineId = asString(row?.product_line_id);
      if (!lineId) continue;
      const bucket = map.get(lineId) || [];
      bucket.push(row);
      map.set(lineId, bucket);
    }
  } catch (_) {
    // The line's other members are an enrichment: without them the card counts what was recalled.
  }
  return map;
}

// Only lines some card is an accepted member of are worth a member read.
function verifiedLineIds(cards, bucketOf) {
  return [...new Set(cards.map((card) => asString(bucketOf(card)).split('|')[0]).filter(Boolean))];
}

function decorateProduct(product, summary) {
  return {
    ...product,
    shade_line: summary,
    shade_count: summary.shade_count,
  };
}

/**
 * Discovery: candidates after applyIdentityGraphDiscoveryDedupe, which stamped the identity row's
 * line on `candidate.raw.identity_graph.product_line_id` and its shade-line decision on
 * `candidate.identityShadeLine` (outside `raw`, so it is never projected onto a card). The
 * discovery pool is the whole candidate pool; pages are cut from it after this, so no budget.
 */
async function collapseDiscoveryCandidatesByShadeLine(candidates, {
  servingCurrency,
  lineMembersResolverFn = null,
  env = process.env,
} = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!isShadeLineCardCollapseEnabled(env)) return { candidates: list, stats: emptyStats({ reason: 'flag_off' }) };
  const bucketOf = (candidate) =>
    shadeLineBucketOf({
      product_line_id: candidate?.raw?.identity_graph?.product_line_id,
      shade_line: candidate?.identityShadeLine,
    });
  const lineIds = verifiedLineIds(list, bucketOf);
  if (!lineIds.length) return { candidates: list, stats: emptyStats({ reason: 'no_shade_lines' }) };
  const lineMembers = await loadLineMembers(lineIds, lineMembersResolverFn);
  const result = collapseCardsByShadeLine(list, {
    bucketOf,
    productOf: (candidate) => candidate?.raw || {},
    memberKeyOf: (candidate) => asString(candidate?.raw?.sellable_item_group_id) || asString(candidate?.key),
    decorate: (candidate, summary) => ({ ...candidate, raw: decorateProduct(candidate.raw || {}, summary) }),
    servingCurrency,
    lineMembers,
  });
  return { candidates: result.cards, stats: result.stats };
}

/**
 * Search: product cards. They do not carry the identity row, so it is read for their listing refs
 * (listLivePdpIdentityRowsForRefs: public rows only).
 */
async function collapseSearchProductsByShadeLine(products, {
  servingCurrency,
  identityRowsResolverFn = null,
  lineMembersResolverFn = null,
  maxCardsDropped = Infinity,
  isEligible = () => true,
  env = process.env,
} = {}) {
  const list = Array.isArray(products) ? products : [];
  if (!isShadeLineCardCollapseEnabled(env)) return { products: list, stats: emptyStats({ reason: 'flag_off' }) };
  if (list.length < 1 || typeof identityRowsResolverFn !== 'function') {
    return { products: list, stats: emptyStats({ reason: 'nothing_to_resolve' }) };
  }
  const refOf = (product) => {
    const merchantId = asString(product?.merchant_id || product?.merchantId);
    const productId = asString(product?.product_id || product?.productId || product?.id);
    return merchantId && productId ? `${merchantId}:${productId}` : '';
  };
  const refs = [...new Set(list.map(refOf).filter(Boolean))];
  if (!refs.length) return { products: list, stats: emptyStats({ reason: 'no_listing_refs' }) };
  let rows = [];
  try {
    rows = await identityRowsResolverFn({ sourceListingRefs: refs });
  } catch (_) {
    return { products: list, stats: emptyStats({ reason: 'identity_rows_unavailable' }) };
  }
  const rowsByRef = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const ref = asString(row?.source_listing_ref);
    if (ref) rowsByRef.set(ref, row);
  }
  const bucketOf = (product) => shadeLineBucketOf(rowsByRef.get(refOf(product)));
  const lineIds = verifiedLineIds(list, bucketOf);
  if (!lineIds.length) return { products: list, stats: emptyStats({ reason: 'no_shade_lines' }) };
  const lineMembers = await loadLineMembers(lineIds, lineMembersResolverFn);
  const result = collapseCardsByShadeLine(list, {
    bucketOf,
    isEligible,
    productOf: (product) => product,
    memberKeyOf: (product) =>
      asString(rowsByRef.get(refOf(product))?.sellable_item_group_id) || asString(product?.sellable_item_group_id) || refOf(product),
    decorate: (product, summary) => ({
      ...decorateProduct(product, summary),
      product_line_id: summary.product_line_id,
    }),
    servingCurrency,
    lineMembers,
    maxCardsDropped,
  });
  return { products: result.cards, stats: result.stats };
}

/**
 * A search response body (`products`, mirrored in `results` / `data.products` by some lanes),
 * BEFORE the page-size trim. Folds only on the first page, and only as many cards as the pool
 * holds beyond `requestedLimit`. `total` is left as the lane reported it. Returns the body
 * unchanged when the flag is off or nothing folds.
 */
async function collapseSearchResponseBodyByShadeLine({
  body,
  servingCurrency,
  requestedLimit = null,
  page = 1,
  offset = 0,
  // The `merchant_id:product_id` keys of the pool cards that survive the door's own guards (serving
  // currency, price and availability contracts, product-group dedupe, beauty near-dup refine),
  // computed by the caller on a copy of this body. Only they fold, and the budget counts only
  // them. null = unknown: nothing folds. Omitted (undefined): every card counts (unit callers).
  survivorKeys = undefined,
  identityRowsResolverFn = null,
  lineMembersResolverFn = null,
  env = process.env,
} = {}) {
  if (!isShadeLineCardCollapseEnabled(env)) return body;
  if (!isPlainObject(body) || !Array.isArray(body.products) || body.products.length < 1) return body;
  // Later pages are cut by the lane from the unfolded list; folding there could show a second card
  // for a line page 1 already folded. See "STILL BLOCKING" above.
  if ((Number(page) || 1) > 1 || (Number(offset) || 0) > 0) return body;
  const original = body.products;
  const limit = Number(requestedLimit);
  const refOf = (product) => {
    const merchantId = asString(product?.merchant_id || product?.merchantId);
    const productId = asString(product?.product_id || product?.productId || product?.id);
    return merchantId && productId ? `${merchantId}:${productId}` : '';
  };
  const survivors = survivorKeys instanceof Set ? survivorKeys : null;
  const isEligible = survivors ? (product) => survivors.has(refOf(product)) : () => survivorKeys !== null;
  // null survivors: isEligible refuses every card, so nothing folds.
  const survivingCount = survivors ? original.filter(isEligible).length : original.length;
  // The page is cut from the cards that SURVIVE the guards. Without a known page size, or without
  // surviving cards beyond it, a fold could only shorten the page: then nothing folds (a single
  // recalled member of a larger line is still labelled with its counts).
  const maxCardsDropped = Number.isFinite(limit) && limit > 0 ? Math.max(0, survivingCount - limit) : 0;
  const { products, stats } = await collapseSearchProductsByShadeLine(original, {
    servingCurrency,
    identityRowsResolverFn,
    lineMembersResolverFn,
    maxCardsDropped,
    isEligible,
    env,
  });
  if (!stats.applied || !stats.line_cards) return body;
  const sameList = (value) => Array.isArray(value) && value.length === original.length
    && value.every((item, index) => item === original[index]);
  const next = { ...body, products };
  if (sameList(body.results)) next.results = products;
  if (isPlainObject(body.data) && sameList(body.data.products)) next.data = { ...body.data, products };
  next.metadata = {
    ...(isPlainObject(body.metadata) ? body.metadata : {}),
    shade_line_collapse: {
      ...stats,
      pool_size: original.length,
      surviving_pool_size: survivingCount,
      requested_limit: Number.isFinite(limit) ? limit : null,
    },
  };
  return next;
}

module.exports = {
  SHADE_LINE_CARD_COLLAPSE_FLAG,
  collapseCardsByShadeLine,
  collapseDiscoveryCandidatesByShadeLine,
  collapseSearchProductsByShadeLine,
  collapseSearchResponseBodyByShadeLine,
  isShadeLineCardCollapseEnabled,
  shadeLineBucketOf,
  _internals: {
    productInStock,
    verifiedLineIds,
  },
};
