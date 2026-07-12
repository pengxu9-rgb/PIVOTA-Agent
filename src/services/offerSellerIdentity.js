'use strict';
/**
 * Fix Plan C — offer seller-identity derivation (single source of truth).
 *
 * `catalog_offers.offer_type` must reflect WHO IS SELLING (the brand direct vs a
 * third-party retailer), NOT the ingest lane a row arrived through. Historically
 * the value tracked source_tier/source_role, so agent-found D2C offers on the
 * brand's OWN domain were mislabelled 'retailer'. This module derives the honest
 * value from domain evidence, in precedence order:
 *
 *   1. offer domain matches the product's official/brand domain  -> brand_direct (first-party)
 *   2. normalized brand token is contained in the offer domain    -> brand_direct (first-party)
 *   3. offer domain is on the known-retailer list                 -> retailer     (not first-party)
 *   4. no positive evidence                                       -> null ("unknown"); DO NOT guess
 *
 * Pure functions (no I/O) so the sync write path, the backfill, and the tests all
 * share one rule. The retailer list is data-driven + env-extendable (never a
 * scattered hardcode) so ops can extend coverage without a code change.
 */

// Known third-party retailer / marketplace base domains (suffix-matched). Kept in
// sync with mcp-server/src/publicReadSourcing.js DEFAULT_RESELLER_HOSTS. Extend at
// runtime via KNOWN_RETAILER_DOMAINS (comma-separated) — additive, never replacing.
const DEFAULT_KNOWN_RETAILER_DOMAINS = Object.freeze([
  'ulta.com',
  'target.com',
  'bestbuy.com',
  'amazon.com', 'amazon.co.uk', 'amazon.co.jp', 'amazon.de', 'amazon.ca', 'amzn.to', 'amzn.com',
  'sephora.com',
  'walmart.com',
  'oliveyoung.com', 'global.oliveyoung.com', 'oliveyoung.co.kr',
  'nordstrom.com', 'macys.com', 'dermstore.com', 'lookfantastic.com',
  'cultbeauty.com', 'cultbeauty.co.uk', 'yesstyle.com', 'stylevana.com',
  'iherb.com', 'ebay.com', 'kohls.com', 'jcpenney.com', 'beautylish.com',
  'revolve.com', 'asos.com', 'boots.com', 'feelunique.com', 'skinstore.com',
  // Dept-store / marketplace beauty retailers (added Fix Plan C read-review):
  'selfridges.com', 'harrods.com', 'spacenk.com',
  'coupang.com', 'gmarket.co.kr',
]);

// Multi-level public suffixes we recognise for SLD extraction (approx eTLD+1; not
// a full PSL, but covers the catalog's real domains: .co.uk, .com.au, .co.kr, …).
const MULTI_LEVEL_TLDS = Object.freeze([
  'co.uk', 'com.au', 'co.jp', 'co.kr', 'co.za', 'com.br', 'co.nz', 'co.in',
  'com.tr', 'com.mx', 'co.il', 'com.sg', 'com.hk', 'com.tw', 'co.th', 'com.my',
]);

// Locale/util subdomain labels that are NOT part of brand identity.
const LOCALE_PREFIXES = new Set([
  'www', 'us', 'uk', 'eu', 'ca', 'au', 'jp', 'kr', 'de', 'fr', 'es', 'it',
  'nl', 'global', 'en', 'shop', 'store', 'www2', 'm',
]);

function knownRetailerDomains(extraCsv) {
  const envCsv =
    extraCsv != null
      ? extraCsv
      : typeof process !== 'undefined' && process.env
        ? process.env.KNOWN_RETAILER_DOMAINS
        : '';
  const extra = String(envCsv || '')
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean);
  return [...DEFAULT_KNOWN_RETAILER_DOMAINS, ...extra];
}

/** Lowercase host with protocol/path/port and a single leading www. stripped. */
function normalizeHost(value) {
  if (!value) return null;
  let host = String(value).trim().toLowerCase();
  if (!host) return null;
  // Accept a full URL or a bare host.
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  } else {
    // strip any path / query / port that snuck in on a bare host
    host = host.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  }
  host = host.replace(/\.$/, '').replace(/^www\./, '');
  return host || null;
}

function hostFromUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  try {
    return normalizeHost(new URL(s).hostname);
  } catch {
    return normalizeHost(s);
  }
}

/** Approximate registrable domain (eTLD+1) using the multi-level TLD table. */
function registrableBase(host) {
  const h = normalizeHost(host);
  if (!h) return null;
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.') || null;
  const lastTwo = parts.slice(-2).join('.');
  const lastThree = parts.slice(-3).join('.');
  if (MULTI_LEVEL_TLDS.includes(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  // (lastThree kept for readability; only lastTwo drives the decision)
  void lastThree;
  return lastTwo;
}

/** The "name" label of a domain (the SLD), e.g. www.tomfordbeauty.com -> tomfordbeauty. */
function domainNameLabel(host) {
  const base = registrableBase(host);
  if (!base) return null;
  const parts = base.split('.');
  // base is either sld.tld or sld.co.uk; the SLD is the first label.
  return parts[0] || null;
}

/** Two hosts refer to the same site if equal or one is a subdomain of the other. */
function domainsMatch(a, b) {
  const x = normalizeHost(a);
  const y = normalizeHost(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.endsWith(`.${y}`) || y.endsWith(`.${x}`)) return true;
  // Also match on registrable base (us.nuxe.com vs nuxe.com already covered above,
  // but shop.example.co.uk vs www.example.co.uk needs base compare).
  const bx = registrableBase(x);
  const by = registrableBase(y);
  return !!bx && !!by && bx === by;
}

/** Collapse a brand to comparable alphanumerics: "Tom Ford Beauty" -> "tomfordbeauty". */
function normalizeBrand(brand) {
  return String(brand || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '');
}

function isKnownRetailer(host, extraCsv) {
  const h = normalizeHost(host);
  if (!h) return false;
  const list = knownRetailerDomains(extraCsv);
  return list.some((base) => h === base || h.endsWith(`.${base}`));
}

/**
 * Is the brand the owner of this domain? True only when the domain's SLD *is* the
 * brand (collapsed) — exact label equality, NOT substring containment.
 *
 * Unanchored substring matching produced retailer->brand_direct false positives:
 * 'elf' is inside 'selfridges', 'mac' inside 'pharmacy', and the reverse rule made
 * brand 'beautyofjoseon' match label 'beauty' (beauty.com). Every genuine D2C case
 * is exact (cosrx.com, tomfordbeauty.com, wholesale.publicgoods.com -> 'publicgoods'),
 * so exact equality keeps all real matches while erring toward 'unknown' (never a
 * false brand_direct) for affixed hosts like shopcosrx.com — the honest, safe way.
 */
function brandOwnsDomain(brand, host) {
  const b = normalizeBrand(brand);
  const label = domainNameLabel(host);
  if (!b || !label) return false;
  const labelNorm = label.replace(/[^a-z0-9]+/g, '');
  if (!labelNorm) return false;
  return b === labelNorm;
}

const OFFER_TYPE_BRAND_DIRECT = 'brand_direct';
const OFFER_TYPE_RETAILER = 'retailer';

/**
 * Derive { offer_type, is_first_party, rule } from domain evidence.
 * @param {object} args
 * @param {string} [args.domain]         the offer's evidence domain (seed domain / offer_payload.domain)
 * @param {string} [args.canonicalUrl]   fallback source for the evidence domain
 * @param {string} [args.officialDomain] the product's official/brand domain (pdp_identity_listing)
 * @param {string} [args.brand]          the product brand
 * @param {string} [args.retailerCsv]    optional extra retailer domains (test/override)
 * @returns {{offer_type: (string|null), is_first_party: boolean, rule: string, evidence_domain: (string|null)}}
 */
function deriveOfferSellerIdentity(args) {
  const opts = args || {};
  const evidence = normalizeHost(opts.domain) || hostFromUrl(opts.canonicalUrl);
  const official = normalizeHost(opts.officialDomain);

  if (!evidence) {
    return { offer_type: null, is_first_party: false, rule: 'unknown_no_domain', evidence_domain: null };
  }
  // 0. A KNOWN third-party retailer host preempts every "brand" signal — a brand's
  //    official domain is never a marketplace. This guards against contaminated
  //    identity data: prod has `official_domain=ulta.com` on ~63 The-Ordinary rows
  //    (identity matched via a Ulta URL), which would otherwise mis-flip genuine
  //    Ulta offers to brand_direct. Retailer host = retailer, full stop.
  if (isKnownRetailer(evidence, opts.retailerCsv)) {
    return {
      offer_type: OFFER_TYPE_RETAILER,
      is_first_party: false,
      rule: 'known_retailer_domain',
      evidence_domain: evidence,
    };
  }
  // 1. matches the product's official/brand domain
  if (official && domainsMatch(evidence, official)) {
    return {
      offer_type: OFFER_TYPE_BRAND_DIRECT,
      is_first_party: true,
      rule: 'official_domain_match',
      evidence_domain: evidence,
    };
  }
  // 2. brand token contained in the offer domain (brand's own site w/o identity row)
  if (opts.brand && brandOwnsDomain(opts.brand, evidence)) {
    return {
      offer_type: OFFER_TYPE_BRAND_DIRECT,
      is_first_party: true,
      rule: 'brand_in_domain',
      evidence_domain: evidence,
    };
  }
  // 4. no positive evidence — leave unknown, do not guess
  return { offer_type: null, is_first_party: false, rule: 'unknown_no_evidence', evidence_domain: evidence };
}

module.exports = {
  DEFAULT_KNOWN_RETAILER_DOMAINS,
  OFFER_TYPE_BRAND_DIRECT,
  OFFER_TYPE_RETAILER,
  knownRetailerDomains,
  normalizeHost,
  hostFromUrl,
  registrableBase,
  domainNameLabel,
  domainsMatch,
  normalizeBrand,
  isKnownRetailer,
  brandOwnsDomain,
  deriveOfferSellerIdentity,
};
