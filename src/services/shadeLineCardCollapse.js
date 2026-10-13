'use strict';

// ONE CARD PER SHADE LINE in search and discovery.
//
// A store that lists every shade of a line as its own page fills a results page with one line:
// many near-identical cards that differ only by colour. Once the identity graph has put those
// pages in one product line (rule shade_line_v2, shadeLineRule.js), this collapses the line's
// cards into ONE card: an in-stock representative, a "from" price and the shade count. Each shade
// keeps its own sig_/PDP; the PDP's shade picker (buildProductLineOptions) links the siblings.
// Nothing here changes a URL, an offer or a PDP.
//
// FLAG: SHADE_LINE_CARD_COLLAPSE_ENABLED=true (default OFF, read per call). Off, every caller
// returns its input untouched and makes no extra read. Independent of the rule's own flag
// (SHADE_LINE_RULE_V2_ENABLED): with the rule off no line is ever verified, so nothing collapses.
//
// WHAT COLLAPSES. A line is a shade line when at least one of its public rows carries the rule's
// APPROVED decision naming that row's stored product_line_id (readVerifiedShadeLineId). Every card
// whose STORED product_line_id is such a line is a member, whatever its own decision says: a
// member refused on a later rebuild keeps its sticky line id, so it is still in the line (and
// must not show up as a separate card next to its own line card), and v1 siblings a v2 line
// adopted are in it too. A row whose rebuild only PROPOSES a line (sticky elsewhere) is in its
// stored line, not the proposed one. Lines of other rules, with no approved v2 row, never collapse.
//
// MARKET. The buyer's market is a currency here (buyerMarket.js: the seed `market` column is a
// serving partition, not where the buyer is). A member counts only when it is priced in the
// serving currency and no other (servingCurrencyGuard.isPricedInServingCurrency). Members in
// another currency are never folded into a line card and never contribute a price; they are left
// as they are for the door's currency guard to judge. No FX, ever. No serving currency, no
// collapse. The line's other members are priced from the CURRENT seed columns
// (listLiveShadeLineMembers); a member with no current price is left out of the count and price.
//
// DEDUPE ORDER. This runs AFTER the existing same-item dedupe (discovery: sellable_item_group_id
// buckets; search: the lane's own grouping), so members are counted by distinct sellable item, and
// a card that already stands for several sellers of one shade is one member. In search it runs on
// the wide candidate pool BEFORE the page-size trim, so a folded shade frees a slot the pool
// refills, and `total` shrinks by the cards folded away. Running it twice is a no-op.
//
// PUBLIC PAYLOAD. `shade_line` = { product_line_id, rule_version, shade_count, in_stock_shade_count,
// from_price, currency, collapsed_card_count } and `shade_count`. No member refs.
//
// BEFORE ENABLING SHADE_LINE_CARD_COLLAPSE_ENABLED (known gaps; not built yet, each needs a fix or
// an explicit sign-off first):
//   1. Buckets must be per store (merchant + domain), not per line. Once one store's v2 shades
//      sit in a line that also holds other sellers' pages (a cross-merchant v1 line), every card
//      of that line from every merchant folds into ONE card -- whose representative may be
//      another merchant's listing -- and shade_count counts a shade sold at two stores twice.
//      (The rule no longer adopts a v1 line that is not one store's, but lines adopted or
//      re-keyed by hand, and older v1 lines, can still mix stores.)
//   2. The refill after a fold works only if the upstream lane over-fetches past the requested
//      page size. The find_products_multi test mocks a wide pool; verify the real lanes do.
//   3. Pagination is contract-visible: a line card on page 1 can sit beside the same line's
//      shades on page 2 (there is no cursor to reconcile), and `total` shrinks by folded cards.
//   4. Member-read cost: listLiveShadeLineMembers resolves lines that are verified OR shared by
//      two cards; it should resolve only v2-approved lines, and apply the per-line cap BEFORE the
//      lateral seed join and the trust EXISTS (worst case today ~200 lines x 400 members).
//
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
const { resolveCanonicalSearchProductPrice } = require('./searchProductPrice');
const { SHADE_LINE_RULE_VERSION, readVerifiedShadeLineId } = require('./shadeLineRule');

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

function priceInCurrency(product, servingCurrency) {
  const priced = resolveCanonicalSearchProductPrice(product);
  if (!priced || priced.currency !== servingCurrency) return null;
  return { amount: priced.amount, currency: priced.currency };
}

function emptyStats(extra = {}) {
  return { applied: false, lines_collapsed: 0, cards_dropped: 0, line_cards: 0, ...extra };
}

// Which line ids are worth a member read: lines a card already verifies, and lines two or more
// cards share (one of them may be a member whose own decision was later refused).
function lineIdsToResolve(cards, storedLineOf, isVerifiedCard) {
  const counts = new Map();
  const verified = new Set();
  for (const card of cards) {
    const lineId = asString(storedLineOf(card));
    if (!lineId) continue;
    counts.set(lineId, (counts.get(lineId) || 0) + 1);
    if (isVerifiedCard(card)) verified.add(lineId);
  }
  return [...new Set([...verified, ...[...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id)])];
}

/**
 * The pure core. `cards` keep their order; a line's card takes the slot of the line's
 * highest-ranked member.
 *
 * @param {Array} cards
 * @param {object} opts
 * @param {(card)=>string} opts.storedLineOf   the card's STORED product_line_id (from its identity row)
 * @param {(card)=>boolean} opts.isVerifiedCard the card's own row carries the approved v2 decision
 * @param {(card)=>object} opts.productOf      the product object the card is built from
 * @param {(card)=>string} opts.memberKeyOf    distinct-member key (sellable item, else listing ref)
 * @param {(card, summary)=>object} opts.decorate
 * @param {string|null} opts.servingCurrency   the buyer's currency; null = collapse nothing
 * @param {Map<string, Array>} [opts.lineMembers] lineId -> rows from listLiveShadeLineMembers
 */
function collapseCardsByShadeLine(cards, {
  storedLineOf,
  isVerifiedCard,
  productOf,
  memberKeyOf,
  decorate,
  servingCurrency,
  lineMembers = new Map(),
} = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const currency = asString(servingCurrency).toUpperCase();
  if (!list.length) return { cards: list, stats: emptyStats() };
  if (!currency) return { cards: list, stats: emptyStats({ reason: 'no_serving_currency' }) };

  const verifiedLines = new Set();
  for (const card of list) {
    const lineId = asString(storedLineOf(card));
    if (lineId && isVerifiedCard(card)) verifiedLines.add(lineId);
  }
  for (const [lineId, rows] of lineMembers.entries()) {
    if ((rows || []).some((row) => readVerifiedShadeLineId(row) === lineId)) verifiedLines.add(lineId);
  }
  if (!verifiedLines.size) return { cards: list, stats: emptyStats({ reason: 'no_shade_lines' }) };

  const buckets = new Map();
  list.forEach((card, index) => {
    const lineId = asString(storedLineOf(card));
    if (!lineId || !verifiedLines.has(lineId)) return;
    const product = productOf(card);
    if (!isPricedInServingCurrency(product, currency)) return;
    const bucket = buckets.get(lineId) || [];
    bucket.push({ card, index, product });
    buckets.set(lineId, bucket);
  });

  let linesCollapsed = 0;
  let cardsDropped = 0;
  let lineCards = 0;
  const replacement = new Map();
  const dropped = new Set();
  for (const [lineId, entries] of buckets.entries()) {
    // Members by distinct sellable item: recalled cards first, then the line's other public rows.
    const members = new Map();
    for (const entry of entries) {
      const key = asString(memberKeyOf(entry.card)) || `card:${entry.index}`;
      if (!members.has(key)) {
        members.set(key, {
          inStock: productInStock(entry.product),
          price: priceInCurrency(entry.product, currency),
        });
      }
    }
    for (const row of lineMembers.get(lineId) || []) {
      const facts = isPlainObject(row.card_facts) ? row.card_facts : {};
      if (!isPricedInServingCurrency(facts, currency)) continue;
      const key = asString(row.sellable_item_group_id) || asString(row.source_listing_ref);
      if (!key || members.has(key)) continue;
      members.set(key, {
        inStock: productInStock(facts),
        price: priceInCurrency(facts, currency),
      });
    }

    const previous = entries
      .map((entry) => (isPlainObject(entry.product?.shade_line) ? entry.product.shade_line : null))
      .find((summary) => summary && summary.product_line_id === lineId);
    const shadeCount = Math.max(members.size, Number(previous?.shade_count) || 0);
    if (shadeCount < 2) continue;

    const memberList = [...members.values()];
    const inStockPrices = memberList.filter((member) => member.inStock && member.price).map((member) => member.price);
    let fromPrice = inStockPrices.length
      ? inStockPrices.reduce((best, price) => (price.amount < best.amount ? price : best), inStockPrices[0])
      : null;
    if (previous?.from_price && previous.from_price.currency === currency
      && (!fromPrice || Number(previous.from_price.amount) < fromPrice.amount)) {
      fromPrice = { amount: Number(previous.from_price.amount), currency };
    }
    const representative = entries.find((entry) => productInStock(entry.product)) || entries[0];
    const summary = {
      product_line_id: lineId,
      rule_version: SHADE_LINE_RULE_VERSION,
      shade_count: shadeCount,
      in_stock_shade_count: Math.max(
        memberList.filter((member) => member.inStock).length,
        Number(previous?.in_stock_shade_count) || 0,
      ),
      from_price: fromPrice,
      currency,
      collapsed_card_count: Math.max(entries.length, Number(previous?.collapsed_card_count) || 0),
    };
    const slot = entries[0].index;
    replacement.set(slot, decorate(representative.card, summary));
    for (const entry of entries.slice(1)) dropped.add(entry.index);
    lineCards += 1;
    if (entries.length > 1) {
      linesCollapsed += 1;
      cardsDropped += entries.length - 1;
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
 * `candidate.identityShadeLine` (outside `raw`, so it is never projected onto a card).
 */
async function collapseDiscoveryCandidatesByShadeLine(candidates, {
  servingCurrency,
  lineMembersResolverFn = null,
  env = process.env,
} = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!isShadeLineCardCollapseEnabled(env)) return { candidates: list, stats: emptyStats({ reason: 'flag_off' }) };
  const storedLineOf = (candidate) => asString(candidate?.raw?.identity_graph?.product_line_id);
  const isVerifiedCard = (candidate) =>
    Boolean(readVerifiedShadeLineId({ product_line_id: storedLineOf(candidate), shade_line: candidate?.identityShadeLine }));
  const lineIds = lineIdsToResolve(list, storedLineOf, isVerifiedCard);
  if (!lineIds.length) return { candidates: list, stats: emptyStats({ reason: 'no_shade_lines' }) };
  const lineMembers = await loadLineMembers(lineIds, lineMembersResolverFn);
  const result = collapseCardsByShadeLine(list, {
    storedLineOf,
    isVerifiedCard,
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
  const storedLineOf = (product) => asString(rowsByRef.get(refOf(product))?.product_line_id);
  const isVerifiedCard = (product) => Boolean(readVerifiedShadeLineId(rowsByRef.get(refOf(product))));
  const lineIds = lineIdsToResolve(list, storedLineOf, isVerifiedCard);
  if (!lineIds.length) return { products: list, stats: emptyStats({ reason: 'no_shade_lines' }) };
  const lineMembers = await loadLineMembers(lineIds, lineMembersResolverFn);
  const result = collapseCardsByShadeLine(list, {
    storedLineOf,
    isVerifiedCard,
    productOf: (product) => product,
    memberKeyOf: (product) =>
      asString(rowsByRef.get(refOf(product))?.sellable_item_group_id) || asString(product?.sellable_item_group_id) || refOf(product),
    decorate: (product, summary) => ({
      ...decorateProduct(product, summary),
      product_line_id: summary.product_line_id,
    }),
    servingCurrency,
    lineMembers,
  });
  return { products: result.cards, stats: result.stats };
}

/**
 * A search response body (`products`, mirrored in `results` / `data.products` by some lanes),
 * BEFORE the page-size trim. Returns the body unchanged when the flag is off or nothing collapses;
 * otherwise a copy with the line cards, `total` reduced by the cards folded away, and
 * metadata.shade_line_collapse.
 */
async function collapseSearchResponseBodyByShadeLine({
  body,
  servingCurrency,
  identityRowsResolverFn = null,
  lineMembersResolverFn = null,
  env = process.env,
} = {}) {
  if (!isShadeLineCardCollapseEnabled(env)) return body;
  if (!isPlainObject(body) || !Array.isArray(body.products) || body.products.length < 1) return body;
  const original = body.products;
  const { products, stats } = await collapseSearchProductsByShadeLine(original, {
    servingCurrency,
    identityRowsResolverFn,
    lineMembersResolverFn,
    env,
  });
  if (!stats.applied || !stats.line_cards) return body;
  const sameList = (value) => Array.isArray(value) && value.length === original.length
    && value.every((item, index) => item === original[index]);
  const next = { ...body, products };
  if (sameList(body.results)) next.results = products;
  if (isPlainObject(body.data) && sameList(body.data.products)) next.data = { ...body.data, products };
  if (typeof body.total === 'number' && Number.isFinite(body.total)) {
    next.total = Math.max(products.length, body.total - stats.cards_dropped);
  }
  next.metadata = {
    ...(isPlainObject(body.metadata) ? body.metadata : {}),
    shade_line_collapse: stats,
  };
  return next;
}

module.exports = {
  SHADE_LINE_CARD_COLLAPSE_FLAG,
  collapseSearchResponseBodyByShadeLine,
  collapseCardsByShadeLine,
  collapseDiscoveryCandidatesByShadeLine,
  collapseSearchProductsByShadeLine,
  isShadeLineCardCollapseEnabled,
  _internals: {
    lineIdsToResolve,
    productInStock,
  },
};
