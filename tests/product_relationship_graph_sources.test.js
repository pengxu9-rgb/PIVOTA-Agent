const {
  augmentCandidatesWithTransitiveRecall,
  buildCandidatesByAnchorFromSources,
  loadAffectedProductAnchorCandidates,
  loadExternalProductSeedCandidates,
  loadIngredientKbCandidates,
  loadLegacyDupeKbRows,
  loadProductRelationshipGraphSourceInputs,
  loadProductIntelKbRows,
  loadProductsCacheCandidates,
  normalizeCatalogProductRow,
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
    await expect(loadAffectedProductAnchorCandidates({ queryFn, refs: ['ext_missing'] })).resolves.toEqual([]);
    expect(queryFn).toHaveBeenCalled();
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

  test('loads affected anchors by ext, sig, and content refs outside the broad source window', async () => {
    const externalRow = {
      id: 'seed_old',
      external_product_id: 'ext_old_serum',
      product_ref: 'product:sig_old_serum',
      product_key: 'prod::external_seed::external_seed::ext_old_serum',
      source_product_id: 'ext_old_serum',
      pivota_signature_id: 'sig_old_serum',
      content_key: 'ck_old_serum',
      title: 'Older Barrier Serum',
      category: 'serum',
      price_amount: '42.00',
      market: 'US',
      canonical_url: 'https://example.test/old-serum',
      seed_data: {
        brand: 'Archive Lab',
        description: 'A source-backed serum that changed outside the broad recency window.',
      },
      updated_at: NOW,
    };
    const queryFn = jest.fn(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM external_product_seeds eps')) return { rows: [externalRow] };
      if (text.includes('FROM products_cache pc')) return { rows: [] };
      if (text.includes('FROM catalog_products cp')) return { rows: [] };
      return { rows: [] };
    });

    const affected = await loadAffectedProductAnchorCandidates({
      queryFn,
      refs: ['ext_old_serum', 'product:sig_old_serum', 'ck_old_serum'],
      market: 'US',
      limit: 5,
    });

    expect(affected).toHaveLength(1);
    expect(affected[0]).toEqual(
      expect.objectContaining({
        product_ref: 'product:sig_old_serum',
        product_id: 'ext_old_serum',
        pivota_signature_id: 'sig_old_serum',
        content_key: 'ck_old_serum',
        brand: 'Archive Lab',
      }),
    );
    expect(queryFn.mock.calls[0][1]).toEqual([
      expect.arrayContaining(['ext_old_serum', 'product:sig_old_serum', 'sig_old_serum', 'ck_old_serum']),
      'US',
      5,
    ]);
  });

  test('source input loader merges affected anchors into the product pool', async () => {
    const queryFn = jest.fn(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM external_product_seeds eps')) {
        return {
          rows: [
            {
              id: 'seed_old',
              external_product_id: 'ext_old_serum',
              product_ref: 'product:sig_old_serum',
              pivota_signature_id: 'sig_old_serum',
              content_key: 'ck_old_serum',
              title: 'Older Barrier Serum',
              category: 'serum',
              price_amount: '42.00',
              market: 'US',
              seed_data: { brand: 'Archive Lab' },
              updated_at: NOW,
            },
          ],
        };
      }
      if (text.includes('FROM external_product_seeds')) return { rows: [] };
      return { rows: [] };
    });

    const inputs = await loadProductRelationshipGraphSourceInputs({
      queryFn,
      limit: 2,
      market: 'US',
      affectedRefs: ['sig_old_serum'],
    });

    expect(inputs.affectedProducts).toHaveLength(1);
    expect(inputs.products.map((row) => row.product_ref)).toContain('product:sig_old_serum');
    expect(inputs.source_counts.affected_products).toBe(1);
  });

  test('normalizes catalog rows into graph product snapshots', () => {
    expect(
      normalizeCatalogProductRow({
        product_key: 'prod::external_seed::external_seed::ext_catalog_serum',
        source_product_id: 'ext_catalog_serum',
        pivota_signature_id: 'sig_catalog_serum',
        content_key: 'ck_catalog_serum',
        title: 'Catalog Barrier Serum',
        brand: 'Catalog Lab',
        product_type: 'Serum',
        category: 'Serum',
        category_path: 'beauty/skincare/serum',
        canonical_url: 'https://example.test/catalog-serum',
        updated_at: NOW,
      }),
    ).toEqual(
      expect.objectContaining({
        product_ref: 'product:sig_catalog_serum',
        product_id: 'ext_catalog_serum',
        source_product_id: 'ext_catalog_serum',
        pivota_signature_id: 'sig_catalog_serum',
        content_key: 'ck_catalog_serum',
        brand: 'Catalog Lab',
        name: 'Catalog Barrier Serum',
      }),
    );
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
