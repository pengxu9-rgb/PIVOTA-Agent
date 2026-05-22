const {
  buildCandidateQuery,
  buildProjectionForCandidate,
  parseArgs,
  renderMarkdownReport,
  summarizeRows,
} = require('../../scripts/reanalyze_product_intel_kb_seller_only');

const INGREDIENTS = [
  'Water',
  'Glycerin',
  'Niacinamide',
  'Propanediol',
  'Panthenol',
  'Sodium Hyaluronate',
  'Ceramide NP',
  'Allantoin',
  'Tocopherol',
  'Phenoxyethanol',
];

function fixtureCandidate({ reviewDecision = 'rewrite', seedData = {} } = {}) {
  const ingredientText = INGREDIENTS.join(', ');
  return {
    product_key: 'cp_fixture',
    source_product_id: 'ext_fixture',
    pivota_signature_id: 'sig_fixture',
    category_path: 'beauty/skincare/serum',
    seed_id: 'seed_fixture',
    external_product_id: 'ext_fixture',
    domain: 'example.com',
    title: 'Barrier Support Niacinamide Serum',
    destination_url: 'https://example.com/products/barrier-serum',
    canonical_url: 'https://example.com/products/barrier-serum',
    image_url: 'https://example.com/images/barrier-serum.jpg',
    price_amount: '24.00',
    price_currency: 'USD',
    availability: 'in_stock',
    seed_status: 'active',
    seed_created_at: '2026-01-01T00:00:00.000Z',
    seed_updated_at: '2026-05-20T00:00:00.000Z',
    kb_key: 'product:ext_fixture',
    kb_updated_at: '2026-05-01T00:00:00.000Z',
    last_success_at: '2026-05-01T00:00:00.000Z',
    evidence_profile: 'seller_only',
    review_decision: reviewDecision,
    source_meta: {
      evidence_profile: 'seller_only',
      review_decision: reviewDecision,
    },
    seed_data: {
      title: 'Barrier Support Niacinamide Serum',
      description: 'A lightweight serum for barrier support, hydration, and uneven tone.',
      destination_url: 'https://example.com/products/barrier-serum',
      canonical_url: 'https://example.com/products/barrier-serum',
      inci_list: INGREDIENTS,
      raw_ingredient_text_clean: ingredientText,
      pdp_ingredients_raw: ingredientText,
      ingredient_intel: {
        inci_list: INGREDIENTS,
        raw_ingredient_text_clean: ingredientText,
      },
      pdp_field_quality_summary: {
        ingredients_raw: {
          source_quality_status: 'high',
          source_origin: 'official_pdp',
        },
      },
      ...seedData,
    },
    analysis: {
      product_intel_v1: {
        contract_version: 'pivota.product_intel.v1',
        product_intel_core: {
          display_name: 'Pivota Insights',
          what_it_is: {
            headline: 'Treatment serum',
            body: 'A lightweight serum.',
          },
          best_for: [
            {
              tag: 'hydration',
              label: 'Hydration support',
              confidence: 'moderate',
            },
          ],
          why_it_stands_out: [
            {
              headline: 'Key highlight',
              body: 'Barrier support for a daily serum step.',
              evidence_strength: 'seller_grounded',
            },
          ],
          routine_fit: {
            step: 'serum',
            am_pm: ['am', 'pm'],
            pairing_notes: ['Use before moisturizer.'],
          },
          watchouts: [],
          confidence: {
            overall: 'moderate',
            fields: {
              what_it_is: 'high',
              best_for: 'moderate',
              why_it_stands_out: 'moderate',
              routine_fit: 'moderate',
              watchouts: 'moderate',
            },
          },
          freshness: {
            generated_at: '2026-05-01T00:00:00.000Z',
            source_version: 'pivota.product_intel.v1',
          },
          quality_state: 'limited',
          evidence_profile: 'seller_only',
          source_coverage: {
            seller: { available: true },
            formula: { available: false },
          },
        },
        quality_state: 'limited',
        evidence_profile: 'seller_only',
        source_coverage: {
          seller: { available: true },
          formula: { available: false },
        },
        provenance: {
          review_status: 'completed',
          review_decision: reviewDecision,
          review_tier: 'assistant_reviewed',
          reviewer: 'qa@example.com',
          reviewer_kind: 'assistant',
          reviewed_at: '2026-05-01T00:00:00.000Z',
        },
      },
    },
  };
}

describe('reanalyze_product_intel_kb_seller_only dry-run helpers', () => {
  test('parseArgs supports dry-run filters and rejects apply at caller boundary', () => {
    const args = parseArgs([
      '--limit',
      '0',
      '--domain',
      'example.com',
      '--category-prefix=beauty/skincare',
      '--sample-limit',
      '12',
      '--require-priority',
      '--output-json',
      '/tmp/out.json',
      '--output-md',
      '/tmp/out.md',
      '--kb-key',
      'product:ext_fixture',
      '--apply',
    ]);

    expect(args).toMatchObject({
      limit: 0,
      domain: 'example.com',
      categoryPrefix: 'beauty/skincare',
      sampleLimit: 12,
      requirePriority: true,
      outputJson: '/tmp/out.json',
      outputMd: '/tmp/out.md',
      kbKey: 'product:ext_fixture',
      apply: true,
    });
  });

  test('buildCandidateQuery keeps the required latest_kb/candidates predicate and dry-run filters', () => {
    const { sql, params } = buildCandidateQuery({
      limit: 25,
      domain: 'example.com',
      categoryPrefix: 'beauty/skincare',
      requirePriority: true,
      kbKey: 'product:ext_fixture',
    });

    expect(sql).toContain('WITH latest_kb AS');
    expect(sql).toContain("cp.catalog_track = 'external_referral'");
    expect(sql).toContain("kb.analysis->'product_intel_v1'->>'evidence_profile'");
    expect(sql).toContain("WHERE evidence_profile = 'seller_only'");
    expect(sql).toContain("nullif(seed_data->>'inci_list', '') IS NOT NULL");
    expect(sql).toContain("seed_data->'snapshot'->'ingredient_intel' <> '{}'::jsonb");
    expect(sql).toContain('seed_updated_at > last_success_at');
    expect(params).toEqual(['product:ext_fixture', 'example.com', 'beauty/skincare%', 25]);
  });

  test('classifies an ingredient-backed rewrite row as renderable after deterministic refresh', () => {
    const row = buildProjectionForCandidate(fixtureCandidate());

    expect(row.classification).toBe('would_render_after_publish');
    expect(row.evidence_classification).toBe('would_graduate');
    expect(row.before).toMatchObject({
      evidence_profile: 'seller_only',
      quality_state: 'limited',
    });
    expect(row.after).toMatchObject({
      evidence_profile: 'seller_plus_formula',
      quality_state: 'eligible',
    });
    expect(row.after.source_coverage).toMatchObject({
      formula: { available: true },
    });
    expect(row.diff).toMatchObject({
      evidence_profile_changed: true,
      source_coverage_changed: true,
      quality_state_changed: true,
    });
    expect(row.review_provenance_after).toEqual(row.review_provenance_before);
    expect(row.lost_review_provenance_fields).toEqual([]);
    expect(row.would_publish).toBe(true);
  });

  test('surfaces seller_only_fallback provenance as graduated but not renderable', () => {
    const row = buildProjectionForCandidate(fixtureCandidate({ reviewDecision: 'seller_only_fallback' }));

    expect(row.classification).toBe('would_not_render_even_if_published');
    expect(row.evidence_classification).toBe('would_graduate');
    expect(row.after.evidence_profile).toBe('seller_plus_formula');
    expect(row.render_rejection_hint).toBe('seller_only_fallback_review_decision');
    expect(row.would_publish).toBe(false);
    expect(row.review_provenance_after).toEqual(row.review_provenance_before);
  });

  test('fills missing review_tier from existing source_meta without changing analysis provenance fields', () => {
    const candidate = fixtureCandidate();
    delete candidate.analysis.product_intel_v1.provenance.review_tier;
    candidate.source_meta.review_tier = 'assistant_reviewed';

    const row = buildProjectionForCandidate(candidate);

    expect(row.classification).toBe('would_render_after_publish');
    expect(row.review_provenance_before).toMatchObject({
      review_status: 'completed',
      review_decision: 'rewrite',
      review_tier: 'assistant_reviewed',
      reviewer: 'qa@example.com',
      reviewer_kind: 'assistant',
      reviewed_at: '2026-05-01T00:00:00.000Z',
    });
    expect(row.review_provenance_after).toEqual(row.review_provenance_before);
  });

  test('summarizes and renders the projected diff shape', () => {
    const rows = [
      buildProjectionForCandidate(fixtureCandidate()),
      buildProjectionForCandidate(fixtureCandidate({ reviewDecision: 'seller_only_fallback' })),
    ];
    const summary = summarizeRows(rows);
    expect(summary.would_graduate_total).toBe(2);
    expect(summary.would_publish_total).toBe(1);
    expect(summary.classifications).toMatchObject({
      would_render_after_publish: 1,
      would_not_render_even_if_published: 1,
      lost_review_provenance: 0,
    });

    const markdown = renderMarkdownReport({
      generated_at: '2026-05-22T00:00:00.000Z',
      options: { sample_limit: 10 },
      summary,
      rows,
    });
    expect(markdown).toContain('Domain x Classification');
    expect(markdown).toContain('beauty/skincare/serum');
    expect(markdown).toContain('product:ext_fixture');
  });
});
