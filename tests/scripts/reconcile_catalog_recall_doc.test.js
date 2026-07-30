jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  closePool: jest.fn(async () => {}),
}));

const {
  CONFIRM_TOKEN,
  DEFAULT_BATCH_SIZE,
  ALIAS_BUNDLE_PATHS,
  RECALL_DOC_FIELD_ORDER,
  buildRecallDocProjection,
  buildDriftPredicateSql,
  normalizeAvailability,
  textOf,
} = require('../../scripts/reconcile-catalog-recall-doc.cjs');

const gapScope = require('../fixtures/adr020_phase1_gap_scope.json');

function fixtureSeedRow() {
  return {
    product_key: 'prod::external_seed::external_seed::ext_fixture1',
    seed_id: 'ext_fixture1',
    title: 'Ginseng Cleansing Oil',
    domain: 'beautyofjoseon.com',
    canonical_url: 'https://beautyofjoseon.com/products/ginseng-cleansing-oil',
    destination_url: 'https://beautyofjoseon.com/products/ginseng-cleansing-oil?ref=x',
    market: 'us',
    tool: 'beauty',
    availability: 'In Stock',
    seed_data: {
      brand: 'Beauty of Joseon',
      derived: {
        recall: {
          retrieval_title: 'Beauty of Joseon Ginseng Cleansing Oil',
          retrieval_summary: 'Lightweight cleansing oil with ginseng seed oil',
          retrieval_body: 'Dissolves sunscreen and makeup without stripping',
          brand: 'Beauty of Joseon',
          category: 'cleansing oil',
          ingredient_tokens: 'ginseng-seed-oil soybean-oil',
          alias_tokens: 'boj cleansing oil',
        },
      },
      snapshot: {
        availability: 'OutOfStock',
        product: {
          search_aliases: ['ginseng oil cleanser', 'BOJ oil'],
        },
        aliases: 'joseon ginseng oil',
      },
    },
  };
}

describe('buildRecallDocProjection (pure doc builder)', () => {
  test('projects every seed-lane searchable field into a lowercased line-per-field doc', () => {
    const projection = buildRecallDocProjection(fixtureSeedRow());

    expect(projection.recall_doc).toBe(projection.recall_doc.toLowerCase());

    const lines = projection.recall_doc.split('\n');
    // One line per field, in migration-057 arm order.
    expect(lines).toHaveLength(RECALL_DOC_FIELD_ORDER.length);
    expect(lines[RECALL_DOC_FIELD_ORDER.indexOf('title')]).toBe('ginseng cleansing oil');
    expect(lines[RECALL_DOC_FIELD_ORDER.indexOf('domain')]).toBe('beautyofjoseon.com');

    // urls
    expect(projection.recall_doc).toContain('https://beautyofjoseon.com/products/ginseng-cleansing-oil');
    expect(projection.recall_doc).toContain('?ref=x');
    // derived.recall retrieval fields
    expect(projection.recall_doc).toContain('lightweight cleansing oil with ginseng seed oil');
    expect(projection.recall_doc).toContain('dissolves sunscreen and makeup without stripping');
    // brand + category chains
    expect(projection.recall_doc).toContain('beauty of joseon');
    expect(projection.recall_doc).toContain('cleansing oil');
    // ingredient tokens
    expect(projection.recall_doc).toContain('ginseng-seed-oil soybean-oil');
    // alias bundle: top-level alias_tokens, nested snapshot.product array items,
    // and snapshot string alias all land on the alias line
    const aliasLine = lines[RECALL_DOC_FIELD_ORDER.indexOf('alias_bundle')];
    expect(aliasLine).toContain('boj cleansing oil');
    expect(aliasLine).toContain('ginseng oil cleanser');
    expect(aliasLine).toContain('boj oil');
    expect(aliasLine).toContain('joseon ginseng oil');
  });

  test('maps market, tool, and availability scoping', () => {
    const projection = buildRecallDocProjection(fixtureSeedRow());
    expect(projection.recall_market).toBe('US');
    expect(projection.recall_tool).toBe('beauty');
    expect(projection.recall_availability).toBe('in_stock');
  });

  test('falls back through seed_data/snapshot for availability when the column is empty', () => {
    const row = fixtureSeedRow();
    row.availability = null;
    // seed_data.availability absent -> snapshot.availability used
    expect(buildRecallDocProjection(row).recall_availability).toBe('out_of_stock');

    row.seed_data.availability = 'Available';
    expect(buildRecallDocProjection(row).recall_availability).toBe('in_stock');
  });

  test('is null-safe on missing or malformed seed_data', () => {
    expect(() => buildRecallDocProjection(null)).not.toThrow();
    expect(() => buildRecallDocProjection({})).not.toThrow();

    const minimal = buildRecallDocProjection({
      title: 'Bare Title',
      domain: 'example.com',
      seed_data: null,
    });
    expect(minimal.recall_doc).toContain('bare title');
    expect(minimal.recall_doc).toContain('example.com');
    expect(minimal.recall_doc.split('\n')).toHaveLength(RECALL_DOC_FIELD_ORDER.length);
    expect(minimal.recall_market).toBeNull();
    expect(minimal.recall_tool).toBeNull();
    expect(minimal.recall_availability).toBeNull();

    const garbage = buildRecallDocProjection({ seed_data: 'not-json{{{', market: 'jp' });
    expect(garbage.recall_market).toBe('JP');
    expect(garbage.recall_doc.split('\n')).toHaveLength(RECALL_DOC_FIELD_ORDER.length);
  });

  test('accepts seed_data delivered as a JSON string', () => {
    const row = fixtureSeedRow();
    row.seed_data = JSON.stringify(row.seed_data);
    row.availability = null; // exercise snapshot fallback through the parsed string
    const projection = buildRecallDocProjection(row);
    expect(projection.recall_doc).toContain('boj cleansing oil');
    expect(projection.recall_availability).toBe('out_of_stock');
  });

  test('alias bundle covers all 13 seed-lane alias paths', () => {
    expect(ALIAS_BUNDLE_PATHS).toHaveLength(13);
    const joined = ALIAS_BUNDLE_PATHS.map((p) => p.join('.'));
    expect(joined).toContain('derived.recall.alias_tokens');
    expect(joined).toContain('snapshot.product.search_aliases');
    expect(joined).toContain('snapshot.product.searchAliases');
    expect(joined).toContain('snapshot.product.aliases');
  });
});

describe('textOf / normalizeAvailability helpers', () => {
  test('textOf flattens arrays and tolerates odd shapes', () => {
    expect(textOf(['a', ['b', 'c'], null, 'd'])).toBe('a b c d');
    expect(textOf('plain')).toBe('plain');
    expect(textOf(42)).toBe('42');
    expect(textOf(null)).toBe('');
    expect(textOf({ k: 'v' })).toBe('{"k":"v"}');
  });

  test('normalizeAvailability mirrors normalizeSeedAvailability', () => {
    expect(normalizeAvailability('In Stock')).toBe('in_stock');
    expect(normalizeAvailability('instock')).toBe('in_stock');
    expect(normalizeAvailability('OOS')).toBe('out_of_stock');
    expect(normalizeAvailability('preorder')).toBe('preorder');
    expect(normalizeAvailability('')).toBeNull();
    expect(normalizeAvailability(undefined)).toBeNull();
  });
});

describe('drift predicate SQL builder', () => {
  test('flags never-projected and stale rows against the seed clock', () => {
    const sql = buildDriftPredicateSql('cp', 'eps');
    expect(sql).toContain('cp.recall_doc IS NULL');
    expect(sql).toContain('cp.recall_doc_updated_at IS NULL');
    expect(sql).toContain('cp.recall_doc_updated_at < eps.updated_at');
  });

  test('respects custom aliases', () => {
    const sql = buildDriftPredicateSql('p', 's');
    expect(sql).toContain('p.recall_doc IS NULL');
    expect(sql).toContain('p.recall_doc_updated_at < s.updated_at');
  });
});

describe('script conventions', () => {
  test('write path is gated behind an explicit confirm token', () => {
    expect(CONFIRM_TOKEN).toBe('RECONCILE_CATALOG_RECALL_DOC_PROJECTION');
    expect(DEFAULT_BATCH_SIZE).toBe(200);
  });
});

describe('phase 1 acceptance corpus fixture', () => {
  test('carries the 15 gap queries / 71 unique products measured 2026-07-30', () => {
    expect(gapScope.gap_query_count).toBe(15);
    expect(gapScope.gap_queries).toHaveLength(15);
    const ids = new Set();
    for (const q of gapScope.gap_queries) {
      expect(Array.isArray(q.only_in_seed)).toBe(true);
      for (const p of q.only_in_seed) ids.add(p.external_product_id);
    }
    expect(ids.size).toBe(71);
    expect(gapScope.source).toContain('audit-recall-lane-parity.cjs');
  });
});
