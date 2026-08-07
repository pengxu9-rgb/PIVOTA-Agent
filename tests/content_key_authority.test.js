'use strict';
/**
 * content_key conformance — issue #1916.
 *
 * `content_key` is minted by pivota-backend/services/catalog_identity.py. This suite
 * is the contract that keeps the Node port in the SAME keyspace: the fixture's
 * `python_authority` cases come from that implementation, and the `prod_*` cases are
 * real catalog_products rows minted by the live Python writer. If a change to
 * src/services/contentKey.js breaks either group, the change has forked the key.
 *
 * It also pins the two rules that a fork keeps re-breaking:
 *   1. Nothing in this repo may mint a content_key by any other formula.
 *   2. The matching key (retailerOfferIdentity) is never used as a content key.
 */

const fs = require('node:fs');
const path = require('node:path');

const ck = require('../src/services/contentKey');
const identity = require('../src/services/retailerOfferIdentity');

const CASES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'content_key_v1_cases.json'), 'utf8'),
);

describe('makeContentKey matches the cross-service authority', () => {
  test('the fixture still covers both the Python cases and live prod rows', () => {
    expect(CASES.filter((c) => c.source === 'python_authority').length).toBeGreaterThanOrEqual(20);
    expect(CASES.filter((c) => c.source === 'prod_catalog_products').length).toBeGreaterThanOrEqual(8);
  });

  test.each(CASES.map((c) => [c.name, c]))('%s', (_name, entry) => {
    expect(ck.makeContentKey(entry.brand, entry.title, entry.gtin)).toBe(entry.content_key);
  });
});

describe('normalization rules the authority locked on 2026-05-12', () => {
  test('corporate suffixes and case/whitespace collapse to one brand', () => {
    expect(ck.makeContentKey('Glow Recipe Inc.', 'Plum Plump Hyaluronic Serum')).toBe(
      ck.makeContentKey('  glow recipe  ', 'Plum  Plump  Hyaluronic  Serum'),
    );
  });

  test('GTIN-12 / GTIN-13 / GTIN-14 spellings of one code collide', () => {
    const twelve = ck.makeContentKey('MAC', 'Lipstick Russian Red', '773602443796');
    expect(ck.makeContentKey('MAC', 'Lipstick Russian Red', '0773602443796')).toBe(twelve);
    expect(ck.makeContentKey('MAC', 'Lipstick Russian Red', '00773602443796')).toBe(twelve);
    expect(ck.makeContentKey('MAC', 'Lipstick Russian Red', '773-602-443796')).toBe(twelve);
  });

  test('a GTIN changes the key — no-GTIN and GTIN rows are different products', () => {
    expect(ck.makeContentKey('MAC', 'Lipstick Russian Red', '773602443796')).not.toBe(
      ck.makeContentKey('MAC', 'Lipstick Russian Red', null),
    );
  });

  test('size IS identity here — 30ml and 50ml do NOT collapse', () => {
    expect(ck.makeContentKey('COSRX', 'Snail Mucin Essence 30ml')).not.toBe(
      ck.makeContentKey('COSRX', 'Snail Mucin Essence 50ml'),
    );
  });

  test('empty brand or title returns null, never an all-collide key', () => {
    expect(ck.makeContentKey('', 'Some Title')).toBeNull();
    expect(ck.makeContentKey('Some Brand', '')).toBeNull();
    expect(ck.makeContentKey(null, null)).toBeNull();
    expect(ck.makeContentKey('®™', 'Some Title')).toBeNull();
  });

  test('isContentKey accepts the minted shape and rejects near-misses', () => {
    expect(ck.isContentKey(ck.makeContentKey('COSRX', 'Snail Mucin Essence'))).toBe(true);
    expect(ck.isContentKey('ck_TOOSHORT')).toBe(false);
    expect(ck.isContentKey('ck_C9EE21AC285DA9BB9C8A4F5375992927')).toBe(false);
    expect(ck.isContentKey('sig_c9ee21ac285da9bb9c8a4f5375992927')).toBe(false);
    expect(ck.isContentKey(null)).toBe(false);
  });
});

describe('the matching key is not a content key (issue #1916 root cause)', () => {
  test('retailerOfferIdentity exports no content_key minter', () => {
    expect(identity.contentKeyFallback).toBeUndefined();
    expect(Object.keys(identity).filter((k) => /content_?key/i.test(k))).toEqual([]);
  });

  test('identityMatchKey still collapses size variants — that is its job', () => {
    expect(identity.identityMatchKey('COSRX', 'COSRX Snail Mucin Essence 100ml')).toBe(
      identity.identityMatchKey('COSRX', 'Snail Mucin Essence 3.38 oz'),
    );
  });

  test('and it is deliberately looser than content_key, so it must never be hashed into one', () => {
    // Same two titles: one matching key, two content keys. Collapsing them is a
    // resolve-first DB decision (reuse the matched row's stored key), never a hash.
    expect(ck.makeContentKey('COSRX', 'COSRX Snail Mucin Essence 100ml')).not.toBe(
      ck.makeContentKey('COSRX', 'Snail Mucin Essence 3.38 oz'),
    );
  });
});

describe('no second formula survives in the tree', () => {
  const MINTERS = [
    'scripts/sync-external-seeds-to-catalog.cjs',
    'scripts/sync-ulta-external-seeds-to-catalog.cjs',
  ];

  /** Drop comments so the assertions read executable code, not the history we document. */
  function codeOf(relPath) {
    return fs
      .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|--)/.test(line))
      .map((line) => line.replace(/\s+--\s.*$/, ''))
      .join('\n');
  }

  test.each(MINTERS)('%s mints only via src/services/contentKey', (relPath) => {
    const source = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
    expect(source).toMatch(/services\/contentKey/);
    expect(source).toMatch(/makeContentKey\(/);
    // The retired generations, by their literal call shapes.
    expect(codeOf(relPath)).not.toMatch(/stableHash\('ck'/);
    expect(codeOf(relPath)).not.toMatch(/contentKeyFallback/);
  });

  test('retailerOfferIdentity.js constructs no ck_ hash', () => {
    expect(codeOf('src/services/retailerOfferIdentity.js')).not.toMatch(/stableHash\('ck'/);
  });

  test('contentKey.js is the only src/services file that hashes a ck_ value', () => {
    // A minter is a file that both builds a digest and names the ck_ namespace. Any
    // second one is a fork of a key this repo does not own — that is issue #1916.
    const others = fs
      .readdirSync(path.join(__dirname, '..', 'src', 'services'))
      .filter((name) => name.endsWith('.js') && name !== 'contentKey.js')
      .filter((name) => {
        const code = codeOf(`src/services/${name}`);
        return /createHash\(/.test(code) && /['"`]ck_?['"`]|ck_\$\{/.test(code);
      });
    expect(others).toEqual([]);
  });
});
