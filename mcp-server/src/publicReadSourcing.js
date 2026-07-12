// First-party / brand-official sourcing filter for the PUBLIC read tier (docs/openai_apps_v1_plan.md §5).
//
// The OpenAI review bar prohibits surfacing third-party listings scraped without authorization / acting as an
// unofficial connector. Pivota's catalog mixes brand-official rows (destination = the brand's own domain,
// e.g. jumiso.us, roundlab.com) with reseller/retailer-crawled rows (destination = a marketplace like
// ulta.com — the exact rows the audit flagged, §3.6). v1 EXCLUDES reseller rows from public responses.
//
// The only sourcing signal present in the search payload is the destination HOST (the backend's offer_type /
// is_first_party are not serialized into find_products rows). So v1 classifies by a curated reseller-host
// denylist (env-overridable) plus the explicit backend signals when they ARE present (offer_type:'retailer').
// This is a denylist, not a brand-allowlist: it reliably drops known marketplaces without over-rejecting
// brand-official redirects. Hosts not on the list pass — a limitation logged, not hidden.

// Curated known reseller / marketplace hosts (suffix-matched, so sub-domains like shop.ulta.com match too).
// Overridable/extendable via PUBLIC_READ_RESELLER_HOSTS (comma-separated, added to this base).
const DEFAULT_RESELLER_HOSTS = Object.freeze([
  'ulta.com', 'sephora.com', 'amazon.com', 'amazon.co.uk', 'amazon.co.jp', 'walmart.com',
  'target.com', 'nordstrom.com', 'macys.com', 'dermstore.com', 'lookfantastic.com',
  'cultbeauty.com', 'cultbeauty.co.uk', 'yesstyle.com', 'stylevana.com', 'oliveyoung.com',
  'global.oliveyoung.com', 'iherb.com', 'ebay.com', 'kohls.com', 'jcpenney.com',
  'beautylish.com', 'revolve.com', 'asos.com', 'boots.com', 'feelunique.com', 'skinstore.com',
  // Kept in sync with offerSellerIdentity.js DEFAULT_KNOWN_RETAILER_DOMAINS (Fix Plan C read-review).
  'selfridges.com', 'harrods.com', 'spacenk.com', 'coupang.com', 'gmarket.co.kr',
  // Full parity with offerSellerIdentity: extra Amazon TLDs / shortlinks + BestBuy + OY Korea.
  'amazon.ca', 'amazon.de', 'amzn.to', 'amzn.com', 'bestbuy.com', 'oliveyoung.co.kr',
]);

function hostOf(url) {
  const s = typeof url === 'string' ? url.trim() : '';
  if (!s) return null;
  try {
    return new URL(s).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Suffix match so shop.ulta.com / www.ulta.com both match ulta.com, but not "notulta.com".
function hostMatches(host, denyHost) {
  if (!host || !denyHost) return false;
  return host === denyHost || host.endsWith(`.${denyHost}`);
}

function resellerHostSet(extraHostsCsv) {
  const extra = String(extraHostsCsv || '')
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean);
  return [...DEFAULT_RESELLER_HOSTS, ...extra];
}

/**
 * Classify a raw catalog row as reseller-sourced (exclude from the public tier) or not.
 * @param {object} row a find_products / get_product_detail product row
 * @param {string[]} denyHosts reseller host suffixes
 * @returns {boolean} true if the row is reseller-sourced and must be excluded
 */
function isResellerRow(row, denyHosts) {
  if (!row || typeof row !== 'object') return false;
  // Explicit backend signals win when present (future-proof; not in today's search payload).
  if (typeof row.offer_type === 'string' && row.offer_type.toLowerCase() === 'retailer') return true;
  if (row.is_first_party === true) return false;
  // Destination host: the row's outbound link (where a click actually goes). Check the redirect/destination
  // fields — NOT the pivota canonical url, which is always a Pivota host.
  const host =
    hostOf(row.destination_url) || hostOf(row.url) || hostOf(row.merchant_canonical_url) || hostOf(row.canonical_url);
  if (!host) return false; // unknown host → do not over-reject
  return denyHosts.some((deny) => hostMatches(host, deny));
}

/**
 * Filter a list of raw product rows to first-party / brand-official only.
 * @returns {{ kept: object[], droppedCount: number }}
 */
function filterFirstPartyRows(rows, { extraHostsCsv } = {}) {
  const denyHosts = resellerHostSet(extraHostsCsv);
  const list = Array.isArray(rows) ? rows : [];
  const kept = list.filter((row) => !isResellerRow(row, denyHosts));
  return { kept, droppedCount: list.length - kept.length };
}

// Reads the enable flag: first-party-only is ON by default within the public tier (the tier itself is
// separately gated by PUBLIC_READ_MCP_ENABLED). Set PUBLIC_READ_FIRST_PARTY_ONLY=0 to include resellers.
function isFirstPartyOnlyEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const raw = String((env && env.PUBLIC_READ_FIRST_PARTY_ONLY) ?? '').trim().toLowerCase();
  if (raw === '') return true; // default ON
  return !['0', 'false', 'off', 'no'].includes(raw);
}

export {
  DEFAULT_RESELLER_HOSTS,
  hostOf,
  hostMatches,
  resellerHostSet,
  isResellerRow,
  filterFirstPartyRows,
  isFirstPartyOnlyEnabled,
};
