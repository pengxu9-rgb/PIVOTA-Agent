const {
  augmentCandidatesWithTransitiveRecall,
  buildCandidatesByAnchorFromSources,
  loadExternalProductSeedCandidates,
  loadIngredientKbCandidates,
  loadLegacyDupeKbRows,
  loadProductIntelKbRows,
  loadProductsCacheCandidates,
  normalizeExternalProductSeedRow,
  normalizeProductIntelKbRow,
} = require('../src/auroraBff/productRelationshipGraphSources');

const NOW = '2026-05-25T00:00:00.000Z';

describe('product relationship graph source loaders', () => {
  test('fail open when optional source tables are missing', async () => {
    const queryFn = jest.fn(async () => {
      const err = new Error('relation does not exist');
      err.code = '42P01';
      throw err;
    });

    await expect(loadProductsCacheCandidates({ queryFn })).resolves.toEqual([]);
    await expect(loadExternalProductSeedCandidates({ queryFn })).resolves.toEqual([]);
    await expect(loadProductIntelKbRows({ queryFn })).resolves.toEqual([]);
    await expect(loadIngredientKbCandidates({ queryFn })).resolves.toEqual([]);
    await expect(loadLegacyDupeKbRows({ queryFn })).resolves.toEqual([]);
    expect(queryFn).toHaveBeenCalled();
  });

  // Regression: prior guard swallowed `column "X" does not exist` (code 42703)
  // and `function ... does not exist` (42883) as if the source were absent.
  // That masked SELECT lists referencing renamed/removed columns and caused
  // the build script to run with a silently degraded universe. The narrowed
  // guard must surface these errors to the caller.
  test('column / function drift must throw (not be swallowed as missing source)', async () => {
    const colErr = Object.assign(new Error('column "category" does not exist'), { code: '42703' });
    const fnErr = Object.assign(new Error('function pgvector_unknown() does not exist'), { code: '42883' });

    const queryColMissing = jest.fn(async () => { throw colErr; });
    const queryFnMissing = jest.fn(async () => { throw fnErr; });

    await expect(loadExternalProductSeedCandidates({ queryFn: queryColMissing })).rejects.toThrow(/column .* does not exist/);
    await expect(loadProductsCacheCandidates({ queryFn: queryColMissing })).rejects.toThrow(/column .* does not exist/);
    await expect(loadProductIntelKbRows({ queryFn: queryColMissing })).rejects.toThrow(/column .* does not exist/);
    await expect(loadLegacyDupeKbRows({ queryFn: queryFnMissing })).rejects.toThrow(/function .* does not exist/);
  });

  // Regression: the build script silently fell back to an empty
  // external_product_seeds source because the SELECT list referenced a
  // `category` column that was removed from the table. The loader now
  // derives category from the seed_data JSONB; assert the SQL no longer
  // references the removed columns so this class of drift is caught at CI time.
  test('loader SQL does not reference columns that were removed from prod schema', async () => {
    const sqlSeen = [];
    const captureFn = jest.fn(async (sql) => { sqlSeen.push(String(sql)); return { rows: [] }; });

    await loadExternalProductSeedCandidates({ queryFn: captureFn, market: 'US', limit: 5 });
    await loadProductsCacheCandidates({ queryFn: captureFn, limit: 5 });

    const seedSql = sqlSeen.find((s) => s.includes('FROM external_product_seeds')) || '';
    const cacheSql = sqlSeen.find((s) => s.includes('FROM products_cache')) || '';

    // external_product_seeds has no `category` column — must use seed_data JSONB instead.
    expect(seedSql).not.toMatch(/\bcategory\b/);
    // products_cache has no `updated_at` column — must use cached_at / last_accessed_at instead.
    expect(cacheSql).not.toMatch(/\bupdated_at\b/);
  });

  test('normalizes external seed and product-intel rows from fake query results', async () => {
    const externalRow = {
      id: 'seed_1',
      external_product_id: 'ext_barrier_serum',
      title: 'Barrier Peptide Serum',
      category: 'serum',
      price_amount: '18.50',
      canonical_url: 'https://example.test/products/barrier-serum',
      seed_data: {
        brand: 'Value Lab',
        pdp_description_raw: 'A ceramide and peptide serum for barrier support.',
        ingredient_ids: ['ceramide', 'peptide'],
      },
      updated_at: NOW,
    };
    const intelRow = {
      kb_key: 'product:ext_barrier_serum',
      source: 'pivota_product_intel_pilot_selected',
      last_success_at: NOW,
      analysis: {
        product_intel_v1: {
          canonical_product_ref: { product_id: 'ext_barrier_serum' },
          product_intel_core: {
            what_it_is: {
              headline: 'Barrier serum',
              body: 'A daily serum focused on barrier comfort and hydration.',
            },
            routine_fit: { step: 'serum', am_pm: ['am', 'pm'] },
            best_for: [{ tag: 'barrier', label: 'Barrier support' }],
          },
        },
      },
    };
    const queryFn = jest.fn(async (sql) => {
      if (String(sql).includes('FROM external_product_seeds')) return { rows: [externalRow] };
      if (String(sql).includes('FROM aurora_product_intel_kb')) return { rows: [intelRow] };
      return { rows: [] };
    });

    const [seedCandidate] = await loadExternalProductSeedCandidates({ queryFn, market: 'US', limit: 5 });
    const [intelCandidate] = await loadProductIntelKbRows({ queryFn, limit: 5 });
    const directSeed = normalizeExternalProductSeedRow(externalRow);
    const directIntel = normalizeProductIntelKbRow(intelRow);

    expect(seedCandidate).toEqual(
      expect.objectContaining({
        product_ref: 'product:ext_barrier_serum',
        brand: 'Value Lab',
        name: 'Barrier Peptide Serum',
        category: 'serum',
        price: 18.5,
        evidence_grade: 'B',
        observed_at: NOW,
      }),
    );
    expect(seedCandidate.source_refs).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'external_product_seed', authoritative: true })]),
    );
    expect(intelCandidate).toEqual(
      expect.objectContaining({
        product_ref: 'product:ext_barrier_serum',
        name: 'Barrier serum',
        category: 'serum',
        evidence_grade: 'B',
        observed_at: NOW,
      }),
    );
    expect(intelCandidate.source_refs).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'product_intel_kb', authoritative: true })]),
    );
    expect(directSeed.product_ref).toBe(seedCandidate.product_ref);
    expect(directIntel.product_ref).toBe(intelCandidate.product_ref);
  });

  test('infers brand and concrete title from official product-intel source when row fields are sparse', async () => {
    const { normalizeProductIntelKbRow } = require('../src/auroraBff/productRelationshipGraphSources');
    const row = {
      kb_key: 'product:ext_kylie_pouch',
      source: 'pivota_product_intel_pilot_selected',
      last_success_at: NOW,
      analysis: {
        product_intel_v1: {
          provenance: {
            official_source_url: 'https://kyliecosmetics.com/products/cosmic-by-kylie-jenner-eau-de-parfum-pouch',
          },
          search_card: {
            title_candidate: 'Cosmic Kylie Jenner Pouch',
          },
          product_intel_core: {
            what_it_is: {
              headline: 'Beauty accessory identity',
              body: 'A Kylie Cosmetics beauty accessory listed on the official source page.',
            },
            routine_fit: { step: 'accessory' },
          },
        },
      },
    };

    expect(normalizeProductIntelKbRow(row)).toEqual(
      expect.objectContaining({
        product_ref: 'product:ext_kylie_pouch',
        brand: 'Kylie Cosmetics',
        name: 'Cosmic Kylie Jenner Pouch',
      }),
    );
  });

  test('adds two-hop transitive recall candidates for review without replacing direct candidates', () => {
    const anchors = [
      {
        product_ref: 'product:anchor_a',
        product_id: 'anchor_a',
        brand: 'Brand A',
        name: 'Barrier Peptide Serum',
        category: 'serum',
        category_taxonomy: ['skincare', 'serum', 'barrier'],
        description: 'Peptide serum for barrier support.',
      },
      {
        product_ref: 'product:bridge_b',
        product_id: 'bridge_b',
        brand: 'Brand B',
        name: 'Barrier Support Serum',
        category: 'serum',
        category_taxonomy: ['skincare', 'serum', 'barrier'],
        description: 'Barrier support serum with peptide positioning.',
      },
    ];
    const bridge = {
      product_ref: 'product:bridge_b',
      product_id: 'bridge_b',
      brand: 'Brand B',
      name: 'Barrier Support Serum',
      category: 'serum',
      category_taxonomy: ['skincare', 'serum', 'barrier'],
      description: 'Barrier support serum with peptide positioning.',
      category_use_case_match: 0.9,
      ingredient_functional_similarity: 0.86,
      similarity_score: 0.88,
      score_total: 0.88,
      source_refs: [{ type: 'product_intel_kb', authoritative: true }],
    };
    const secondHop = {
      product_ref: 'product:candidate_c',
      product_id: 'candidate_c',
      brand: 'Brand C',
      name: 'Ceramide Peptide Repair Drops',
      category: 'serum',
      category_taxonomy: ['skincare', 'serum', 'barrier'],
      description: 'Ceramide peptide drops for barrier repair.',
      category_use_case_match: 0.88,
      ingredient_functional_similarity: 0.84,
      similarity_score: 0.86,
      score_total: 0.86,
      source_refs: [{ type: 'ingredient_kb', authoritative: true }],
    };

    const out = augmentCandidatesWithTransitiveRecall({
      anchors,
      candidatesByAnchor: {
        'product:anchor_a': [bridge],
        'product:bridge_b': [secondHop],
      },
      maxPerAnchor: 1,
      maxTransitivePerAnchor: 2,
    });

    const anchorRows = out['product:anchor_a'];
    const transitive = anchorRows.find((row) => row.product_ref === 'product:candidate_c');

    expect(anchorRows.map((row) => row.product_ref)).toEqual(
      expect.arrayContaining(['product:bridge_b', 'product:candidate_c']),
    );
    expect(transitive).toEqual(
      expect.objectContaining({
        transitive_bridge_ref: 'product:bridge_b',
        source_refs: expect.arrayContaining([
          expect.objectContaining({ type: 'relationship_graph_transitive_recall' }),
        ]),
      }),
    );
    expect(transitive.why_candidate.summary).toMatch(/Two-hop recall/);
  });
});

describe('product relationship graph candidate map enrichment', () => {
  test('dedupes product families, merges intel provenance, and ranks deterministic source scores', () => {
    const anchors = [
      {
        product_id: 'anchor_serum',
        brand: 'Top Brand',
        name: 'Luxury Barrier Peptide Serum',
        category: 'serum',
        category_taxonomy: ['skincare', 'serum'],
        description: 'Ceramide peptide serum for barrier support and fragrance-free routines.',
        tags: ['ceramide', 'peptide', 'barrier'],
        price: 80,
      },
    ];
    const products = [
      {
        product_id: 'value_serum_a',
        product_family_id: 'fam_value_serum',
        brand: 'Value Lab',
        name: 'Barrier Peptide Serum',
        category: 'serum',
        category_taxonomy: ['skincare', 'serum'],
        description: 'Ceramide peptide barrier serum.',
        ingredient_text: 'ceramide peptide glycerin',
        price: 32,
        source_refs: [{ type: 'products_cache', authoritative: true }],
        observed_at: NOW,
      },
      {
        product_id: 'value_serum_b',
        product_family_id: 'fam_value_serum',
        brand: 'Value Lab',
        name: 'Barrier Peptide Serum Set',
        category: 'serum',
        category_taxonomy: ['skincare', 'serum'],
        description: 'Ceramide peptide barrier serum with hydration support.',
        ingredient_text: 'ceramide peptide glycerin panthenol',
        price: 28,
        source_refs: [{ type: 'external_product_seed', authoritative: true }],
        observed_at: NOW,
      },
      {
        product_id: 'offtopic_lotion',
        brand: 'Body Brand',
        name: 'Citrus Body Lotion',
        category: 'body lotion',
        category_taxonomy: ['body care', 'lotion'],
        description: 'A scented body lotion.',
        price: 12,
        source_refs: [{ type: 'products_cache', authoritative: true }],
      },
    ];
    const intelRows = [
      {
        kb_key: 'product:value_serum_b',
        source: 'pivota_product_intel_pilot_selected',
        last_success_at: NOW,
        analysis: {
          product_intel_v1: {
            canonical_product_ref: { product_id: 'value_serum_b' },
            product_intel_core: {
              what_it_is: {
                headline: 'Barrier serum set',
                body: 'A value barrier serum with peptide and ceramide positioning.',
              },
              routine_fit: { step: 'serum' },
              best_for: [{ tag: 'barrier', label: 'Barrier support' }],
            },
          },
        },
      },
    ];
    const legacyDupes = [
      {
        kb_key: 'product:anchor_serum',
        verified: true,
        verified_at: NOW,
        original: {
          product_id: 'anchor_serum',
          brand: 'Top Brand',
          name: 'Luxury Barrier Peptide Serum',
        },
        dupes: [
          {
            product_id: 'legacy_serum',
            brand: 'Legacy Lab',
            name: 'Classic Barrier Serum Dupe',
            category: 'serum',
            category_taxonomy: ['skincare', 'serum'],
            description: 'Ceramide peptide serum for barrier support.',
            ingredient_text: 'ceramide peptide glycerin',
            price: 25,
          },
        ],
        comparables: [],
      },
    ];

    const map = buildCandidatesByAnchorFromSources({
      anchors,
      products,
      intelRows,
      legacyDupes,
      maxPerAnchor: 10,
    });
    const rows = map['product:anchor_serum'];
    const valueFamilyRows = rows.filter((row) => row.product_ref.includes('value_serum'));
    const valueRow = valueFamilyRows[0];

    expect(rows.map((row) => row.product_ref)).toContain('product:legacy_serum');
    expect(valueFamilyRows).toHaveLength(1);
    expect(valueRow.product_ref).toBe('product:value_serum_b');
    expect(valueRow.source_refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'external_product_seed' }),
        expect.objectContaining({ type: 'product_intel_kb' }),
      ]),
    );
    expect(rows.some((row) => row.product_ref === 'product:offtopic_lotion')).toBe(false);
    expect(rows).toEqual([...rows].sort((a, b) => b.similarity_score - a.similarity_score));
  });
});
