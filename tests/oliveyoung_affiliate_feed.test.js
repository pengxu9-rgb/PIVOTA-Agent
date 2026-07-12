'use strict';
/* Fix Plan D · T4 — tests for the Olive Young affiliate-feed adapter, driven by the
 * committed fixture. Verifies normalization, safety gating, seed-row shape +
 * provenance, cross-lane content_key collapse, and graceful no-credential behaviour.
 * NO network, NO prod. */

const fs = require('node:fs');
const path = require('node:path');

const oy = require('../src/services/oliveYoungAffiliateFeed');
const { buildDiscoveredVia } = require('../src/services/seedProvenance');
const { contentKeyFallback } = require('../src/services/retailerOfferIdentity');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'oliveyoung', 'affiliate_feed_sample.json');
const feedPayload = fs.readFileSync(FIXTURE, 'utf8');

describe('parseFeed', () => {
  test('extracts the products array from a {products:[...]} feed', () => {
    const records = oy.parseFeed(feedPayload, { format: 'auto' });
    expect(records.length).toBe(6);
  });
  test('supports a top-level json array', () => {
    expect(oy.parseFeed('[{"a":1},{"b":2}]').length).toBe(2);
  });
  test('bad json -> empty', () => {
    expect(oy.parseFeed('not json')).toEqual([]);
  });
});

describe('normalizeFeedRecord', () => {
  const records = oy.parseFeed(feedPayload);
  test('maps a COSRX record to the canonical offer shape', () => {
    const offer = oy.normalizeFeedRecord(records[0], { market: 'US' });
    expect(offer.channel).toBe('olive_young');
    expect(offer.seller_name).toBe('Olive Young');
    expect(offer.brand).toBe('COSRX');
    expect(offer.price_amount).toBe(22);
    expect(offer.price_currency).toBe('USD');
    expect(offer.availability).toBe('in_stock');
    // destination prefers the affiliate deeplink
    expect(offer.destination_url).toMatch(/track\.example_affiliate_network\.com/);
    expect(offer.product_url).toMatch(/global\.oliveyoung\.com/);
  });
  test('out of stock normalizes', () => {
    const offer = oy.normalizeFeedRecord(records[3]);
    expect(offer.availability).toBe('out_of_stock');
  });
});

describe('isSafeOYOffer', () => {
  const records = oy.parseFeed(feedPayload);
  test('accepts a priced, hosted, branded offer', () => {
    expect(oy.isSafeOYOffer(oy.normalizeFeedRecord(records[0]))).toBe(true);
  });
  test('rejects the $0 / no-deeplink record (Medicube)', () => {
    expect(oy.isSafeOYOffer(oy.normalizeFeedRecord(records[5]))).toBe(false);
  });
});

describe('buildSeedRowFromOYOffer', () => {
  const records = oy.parseFeed(feedPayload);
  const offer = oy.normalizeFeedRecord(records[0]);
  const row = oy.buildSeedRowFromOYOffer(offer, { market: 'US', buildDiscoveredVia });

  test('produces an oliveyoung: external_product_id and OY seller fields', () => {
    expect(row.external_product_id).toMatch(/^oliveyoung:/);
    expect(row.seed_data.seller_name).toBe('Olive Young');
    expect(row.seed_data.source_role).toBe('retailer_offer');
    expect(row.domain).toBe('global.oliveyoung.com');
  });

  test('stamps discovered_via.channel = olive_young on seed_data and snapshot', () => {
    expect(row.seed_data.discovered_via.channel).toBe('olive_young');
    expect(row.seed_data.snapshot.discovered_via.channel).toBe('olive_young');
    expect(row.seed_data.discovered_via.evidence_url).toMatch(/oliveyoung\.com/);
  });

  test('determinism: same record -> same external_product_id', () => {
    const row2 = oy.buildSeedRowFromOYOffer(offer, { market: 'US', buildDiscoveredVia });
    expect(row2.external_product_id).toBe(row.external_product_id);
  });

  test('cross-lane collapse: OY COSRX essence shares content_key with the D2C title', () => {
    const oyKey = contentKeyFallback(row.seed_data.brand, row.seed_data.title);
    const d2cKey = contentKeyFallback('COSRX', 'Advanced Snail 96 Mucin Power Essence 3.38 oz');
    expect(oyKey).toBe(d2cKey);
  });
});

describe('hasAffiliateCredentials (graceful no-cred behaviour)', () => {
  test('false when creds absent', () => {
    expect(oy.hasAffiliateCredentials({})).toBe(false);
  });
  test('true only when network + feed url + key all set', () => {
    expect(
      oy.hasAffiliateCredentials({
        OY_AFFILIATE_NETWORK: 'impact',
        OY_AFFILIATE_FEED_URL: 'https://feed.example/oy.json',
        OY_AFFILIATE_API_KEY: 'secret',
      }),
    ).toBe(true);
  });
  test('false when only some creds set', () => {
    expect(oy.hasAffiliateCredentials({ OY_AFFILIATE_NETWORK: 'impact' })).toBe(false);
  });
});
