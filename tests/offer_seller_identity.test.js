'use strict';
/* Fix Plan C — table-driven tests for the offer seller-identity derivation.
 * Lesson (ADR-009): SQL-shape tests miss NULL / 3-valued-logic. We test BEHAVIOUR:
 * every branch, plus explicit NULL-domain / NULL-brand / NULL-official cases. */

const {
  deriveOfferSellerIdentity,
  domainsMatch,
  brandOwnsDomain,
  isKnownRetailer,
  normalizeHost,
  registrableBase,
  domainNameLabel,
} = require('../src/services/offerSellerIdentity');

describe('normalizeHost', () => {
  test.each([
    ['https://www.tomfordbeauty.com/products/x', 'tomfordbeauty.com'],
    ['WWW.COSRX.COM', 'cosrx.com'],
    ['us.nuxe.com:443', 'us.nuxe.com'],
    ['wholesale.publicgoods.com', 'wholesale.publicgoods.com'],
    ['ulta.com/', 'ulta.com'],
    ['', null],
    [null, null],
    [undefined, null],
  ])('normalizeHost(%p) -> %p', (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });
});

describe('registrableBase / domainNameLabel (multi-level TLD + subdomain)', () => {
  test.each([
    ['www.tomfordbeauty.com', 'tomfordbeauty.com', 'tomfordbeauty'],
    ['us.nuxe.com', 'nuxe.com', 'nuxe'],
    ['dearbarber.co.uk', 'dearbarber.co.uk', 'dearbarber'],
    ['wholesale.publicgoods.com', 'publicgoods.com', 'publicgoods'],
    ['reddane.co.za', 'reddane.co.za', 'reddane'],
  ])('registrableBase(%p)=%p label=%p', (host, base, label) => {
    expect(registrableBase(host)).toBe(base);
    expect(domainNameLabel(host)).toBe(label);
  });
});

describe('domainsMatch (www / locale / subdomain equivalence)', () => {
  test.each([
    ['www.tomfordbeauty.com', 'tomfordbeauty.com', true],
    ['us.nuxe.com', 'nuxe.com', true],
    ['wholesale.publicgoods.com', 'publicgoods.com', true],
    ['shop.example.co.uk', 'www.example.co.uk', true],
    ['ulta.com', 'fentybeauty.com', false],
    ['notulta.com', 'ulta.com', false],
    [null, 'ulta.com', false],
    ['ulta.com', null, false],
  ])('domainsMatch(%p,%p)=%p', (a, b, expected) => {
    expect(domainsMatch(a, b)).toBe(expected);
  });
});

describe('isKnownRetailer (suffix + env-extendable)', () => {
  test.each([
    ['ulta.com', true],
    ['shop.ulta.com', true],
    ['amazon.co.uk', true],
    ['amzn.to', true],
    ['global.oliveyoung.com', true],
    ['bestbuy.com', true],
    ['fentybeauty.com', false],
    ['notulta.com', false],
  ])('isKnownRetailer(%p)=%p', (host, expected) => {
    expect(isKnownRetailer(host)).toBe(expected);
  });

  test('env/csv-extendable without code change', () => {
    expect(isKnownRetailer('coupang.com')).toBe(false);
    expect(isKnownRetailer('coupang.com', 'coupang.com')).toBe(true);
  });
});

describe('brandOwnsDomain', () => {
  test.each([
    ['Tom Ford Beauty', 'www.tomfordbeauty.com', true],
    ['COSRX', 'cosrx.com', true],
    ['Public Goods', 'wholesale.publicgoods.com', true],
    ['Fenty Beauty', 'ulta.com', false],
    ['Anua', 'anua.com', true],
    ['', 'anything.com', false],
    [null, 'anything.com', false],
    ['Naturium', null, false],
  ])('brandOwnsDomain(%p,%p)=%p', (brand, host, expected) => {
    expect(brandOwnsDomain(brand, host)).toBe(expected);
  });
});

describe('deriveOfferSellerIdentity — precedence + NULL behaviour', () => {
  // Rule 1: official domain match -> brand_direct/first-party
  test('official_domain_match on brand DTC domain', () => {
    const r = deriveOfferSellerIdentity({
      domain: 'fentybeauty.com', officialDomain: 'fentybeauty.com', brand: 'Fenty Beauty',
    });
    expect(r).toMatchObject({ offer_type: 'brand_direct', is_first_party: true, rule: 'official_domain_match' });
  });

  test('official_domain_match tolerates www / locale prefixes', () => {
    const r = deriveOfferSellerIdentity({
      domain: 'us.nuxe.com', officialDomain: 'nuxe.com', brand: 'Nuxe',
    });
    expect(r.offer_type).toBe('brand_direct');
    expect(r.is_first_party).toBe(true);
  });

  // Rule 3: genuine retailer domain -> retailer/not-first-party (the Ulta lane)
  test('known_retailer_domain even when official domain is the brand site', () => {
    const r = deriveOfferSellerIdentity({
      domain: 'ulta.com', officialDomain: 'fentybeauty.com', brand: 'Fenty Beauty',
    });
    expect(r).toMatchObject({ offer_type: 'retailer', is_first_party: false, rule: 'known_retailer_domain' });
  });

  // CONTAMINATED identity data: prod has official_domain=ulta.com on genuine Ulta
  // offers (The Ordinary). A retailer host must still win -> retailer, NOT brand_direct.
  test('retailer host preempts a CONTAMINATED official_domain that equals the retailer', () => {
    const r = deriveOfferSellerIdentity({
      domain: 'ulta.com', officialDomain: 'ulta.com', brand: 'The Ordinary',
    });
    expect(r).toMatchObject({ offer_type: 'retailer', is_first_party: false, rule: 'known_retailer_domain' });
  });

  // Rule 2: brand-in-domain when no official identity row exists
  test('brand_in_domain fallback (no official_domain evidence)', () => {
    const r = deriveOfferSellerIdentity({ domain: 'cosrx.com', brand: 'COSRX' });
    expect(r).toMatchObject({ offer_type: 'brand_direct', is_first_party: true, rule: 'brand_in_domain' });
  });

  // wholesale.publicgoods.com-style subdomain of the brand's own domain -> brand_direct
  test('brand wholesale subdomain classifies brand_direct, not retailer', () => {
    const r = deriveOfferSellerIdentity({
      domain: 'wholesale.publicgoods.com', officialDomain: 'publicgoods.com', brand: 'Public Goods',
    });
    expect(r.offer_type).toBe('brand_direct');
    expect(r.is_first_party).toBe(true);
  });

  // Rule 4: unknown host, no brand match -> NULL, do not guess
  test('unknown domain with no brand/official evidence -> null', () => {
    const r = deriveOfferSellerIdentity({ domain: 'somerandommarketplace.com', brand: 'Acme' });
    expect(r).toMatchObject({ offer_type: null, is_first_party: false, rule: 'unknown_no_evidence' });
  });

  // NULL-domain behaviour (explicit 3-valued-logic case)
  test('NULL domain and NULL canonicalUrl -> null / unknown_no_domain (never guesses)', () => {
    const r = deriveOfferSellerIdentity({ domain: null, canonicalUrl: null, officialDomain: 'brand.com', brand: 'Brand' });
    expect(r).toMatchObject({ offer_type: null, is_first_party: false, rule: 'unknown_no_domain' });
  });

  test('NULL domain but canonicalUrl present -> derives from canonical host', () => {
    const r = deriveOfferSellerIdentity({
      domain: null, canonicalUrl: 'https://roundlab.com/products/toner', officialDomain: 'roundlab.com', brand: 'Round Lab',
    });
    expect(r.offer_type).toBe('brand_direct');
    expect(r.rule).toBe('official_domain_match');
  });

  // NULL brand + NULL official -> falls through to retailer list or null (no crash)
  test('NULL brand and NULL official on retailer domain -> retailer', () => {
    const r = deriveOfferSellerIdentity({ domain: 'target.com', officialDomain: null, brand: null });
    expect(r.offer_type).toBe('retailer');
  });

  test('NULL brand and NULL official on unknown domain -> null', () => {
    const r = deriveOfferSellerIdentity({ domain: 'mystery-host.io', officialDomain: null, brand: null });
    expect(r.offer_type).toBeNull();
    expect(r.rule).toBe('unknown_no_evidence');
  });

  test('empty args object does not throw and returns unknown_no_domain', () => {
    const r = deriveOfferSellerIdentity({});
    expect(r.offer_type).toBeNull();
    expect(r.rule).toBe('unknown_no_domain');
  });
});
