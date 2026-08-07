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

/* The dimensions in which the first revision of this port was WRONG. Every case here
 * is a confirmed Node-vs-Python divergence found reviewing PR #1938 — 15.9% of
 * realistic inputs disagreed, and none of it was visible to the 30-case fixture,
 * because that corpus is entirely ASCII and CJK. Expected values come from
 * catalog_identity.py directly, not from this implementation. */
describe('port equivalence where JS has no equivalent property (#1938 review)', () => {
  test('combining CLASS, not \\p{Mark}: a ccc=0 mark becomes a SPACE, not nothing', () => {
    // U+0903 DEVANAGARI SIGN VISARGA is category Mc with combining class 0. Python
    // keeps it past the mark filter, then [^\w\s-] turns it into a space. Deleting it
    // outright (what \p{Mark} did) also moves the token boundary.
    expect(ck.normalizeTitle('a\u0903b')).toBe('a b');
    expect(ck.normalizeTitle('กำ Toner')).toBe('ก า toner');
  });

  test('combining CLASS: a ccc!=0 mark is still deleted outright', () => {
    // U+0301 COMBINING ACUTE has ccc=230 — dropped with no space, so "café" -> "cafe".
    expect(ck.normalizeTitle('café serum')).toBe('cafe serum');
  });

  test('Thai and Devanagari titles no longer fork from the authority', () => {
    expect(ck.makeContentKey('Mistine', 'เซรั่มบำรุงผิว วิตามินซี', '8850012345678'))
      .toBe('ck_ce99c08b8988f2bc5f6e25a35156af6e');
    expect(ck.makeContentKey('Himalaya', 'नीम फेस वॉश 100ml'))
      .toBe('ck_f923d430a83409b7e35aaedcfa6c91e2');
  });

  test("GTIN digits are Python's Nd, not ASCII 0-9", () => {
    // Bare JS \D is [^0-9], so each of these normalized to '' and the GTIN silently
    // vanished from the key.
    expect(ck.normalizeGtin('４９０９９７８９９０６６５')).toBe('0４９０９９７８９９０６６５');
    expect(ck.normalizeGtin('٣٤٥')).toBe('00000000000٣٤٥');
    expect(ck.normalizeGtin('१२३४५६७८९०१२')).toBe('00१२३४५६७८९०१२');
  });

  test('GTIN length is counted in codepoints, not UTF-16 code units', () => {
    // U+104A0 OSMANYA DIGIT ZERO is astral: 1 codepoint, 2 code units. zfill counts
    // codepoints, so .length/padStart would both under-count and mis-pad.
    expect(Array.from(ck.normalizeGtin('\u{104A0}7736')).length).toBe(14);
  });

  test("brand whitespace is Python's, in both directions", () => {
    // U+FEFF (a UTF-8 BOM decoded into a CSV field) is JS-whitespace but NOT Python's,
    // so it must SURVIVE. U+0085 and U+001C-001F are Python's but not JS's, so they
    // must SPLIT. normalizeBrand has no punctuation pass to absorb either mistake.
    expect(ck.normalizeBrand('\ufeffGlow Recipe')).toBe('\ufeffglow recipe');
    expect(ck.normalizeBrand('Glow Recipe Inc\u0085')).toBe('glow recipe');
    expect(ck.normalizeBrand('Glow\u001cRecipe')).toBe('glow recipe');
  });

  test("title whitespace collapse is Python's too, not JS's", () => {
    // U+0085 and U+001C survive the [^\w\s-] pass because they ARE Python whitespace,
    // so the collapse that follows has to recognise them. JS \s does not, and JS
    // .trim() would not strip them either.
    expect(ck.normalizeTitle('a\u0085b')).toBe('a b');
    expect(ck.normalizeTitle('a\u001cb')).toBe('a b');
    expect(ck.normalizeTitle('a\u00a0b')).toBe('a b'); // NBSP: both agree
  });

  test('every corporate suffix token is exercised, not just Inc.', () => {
    // The suffix walk is the likeliest place someone edits this module and was its
    // least-covered corner — only `Inc.` had a case, so dropping `company` from the
    // set passed every test. Stacked and comma-terminated forms exercise the `while`
    // loop and the rstrip(".,") respectively.
    for (const brand of [
      'Glow Recipe LLC', 'Glow Recipe Ltd', 'Glow Recipe Corp',
      'Glow Recipe Company', 'Glow Recipe Co. Ltd.', 'Glow Recipe Inc,',
      'Glow Recipe (R)',
    ]) {
      expect(ck.normalizeBrand(brand)).toBe('glow recipe');
    }
    expect(ck.normalizeBrand('Acme (TM) Labs')).toBe('acme labs');
  });

  test('the Unicode version the tables came from is asserted, not silently inherited', () => {
    // Not a pin — a tripwire. Regenerating contentKeyUnicodeTable.js against a
    // different Python moves keys for newly-assigned codepoints; that has to be a
    // deliberate, visible change rather than a quiet re-key.
    expect(ck.PYTHON_UNICODE_VERSION).toBe('14.0.0');
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

/* The PR's main runtime behaviour change: makeContentKey can return null where the
 * deleted contentKeyFallback always returned a string. Mutation testing on the first
 * revision deleted BOTH guards below and all 72 tests stayed green — the change had
 * no coverage at all. index_pipeline_state.content_key is a PRIMARY KEY, so an
 * unguarded null fails the serving upsert, and a placeholder would collide every
 * unmintable row onto ONE serving decision. */
describe('null content_key is skipped, never written or substituted (#1938 review)', () => {
  const ulta = require('../scripts/sync-ulta-external-seeds-to-catalog.cjs');
  const { dropUnmintableMirrors } = ulta._internals;

  const mirrorWith = (key, id) => ({
    row: { external_product_id: id },
    product: { content_key: key, brand: 'Brand', title: 'Title' },
  });

  test('retailer lane drops the unmintable mirror and records why', () => {
    const skipped = [];
    const kept = dropUnmintableMirrors(
      [mirrorWith('ck_' + 'a'.repeat(32), 'keep'), mirrorWith(null, 'drop')],
      skipped,
    );
    expect(kept.map((m) => m.row.external_product_id)).toEqual(['keep']);
    expect(skipped).toEqual([
      { external_product_id: 'drop', reason: 'content_key_unmintable', brand: 'Brand', title: 'Title' },
    ]);
  });

  test('retailer lane un-counts a dropped row from self_mint', () => {
    // self_mint is incremented before the drop is known, so leaving it would report
    // more self-mints than mirror_rows.
    const skipped = [];
    const resolution = { self_mint: 2 };
    dropUnmintableMirrors([mirrorWith(null, 'a'), mirrorWith(null, 'b')], skipped, resolution);
    expect(resolution.self_mint).toBe(0);
    expect(skipped).toHaveLength(2);
  });

  test('resolve-first still wins: a mirror given a key by reuse is kept', () => {
    const skipped = [];
    const reused = mirrorWith(null, 'reused');
    reused.product.content_key = 'ck_' + 'b'.repeat(32); // as the resolver would set it
    expect(dropUnmintableMirrors([reused], skipped)).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  test('the retailer lane actually CALLS the guard', () => {
    // Unit-testing dropUnmintableMirrors does not protect the wiring: deleting the
    // call site left the function exported and every test still green. Assert the
    // call, after the resolve-first loop and before applyMirrors.
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'sync-ulta-external-seeds-to-catalog.cjs'),
      'utf8',
    );
    const callIndex = source.indexOf('mirrors = dropUnmintableMirrors(');
    expect(callIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(source.indexOf('resolveAgainstIndex(index,'));
    expect(callIndex).toBeLessThan(source.indexOf('await applyMirrors('));
  });

  test('the D2C lane carries the same guard', () => {
    // That lane's check is inline in the intake loop, so assert it at the source: a
    // null key must reach a `content_key_unmintable` skip, not an insert.
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'sync-external-seeds-to-catalog.cjs'),
      'utf8',
    );
    expect(source).toMatch(/if \(!mirror\.product\.content_key\)/);
    expect(source).toMatch(/reason: 'content_key_unmintable'/);
  });

  test('an unmintable brand/title really does produce null, so the guards can fire', () => {
    expect(ck.makeContentKey('®™', 'Some Title')).toBeNull();
    expect(ck.makeContentKey('Brand', '!!!')).toBeNull();
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
