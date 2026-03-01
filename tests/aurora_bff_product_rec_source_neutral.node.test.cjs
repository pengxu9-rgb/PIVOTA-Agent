const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createCitationHash, assertValidIngredientKbV2 } = require('../src/auroraBff/ingredientKbV2/types');
const { buildIngredientProductRecommendationsNeutral } = require('../src/auroraBff/productRecV1');

function baseCitation(overrides = {}) {
  const sourceUrl = overrides.source_url || 'https://example.org/source';
  const docTitle = overrides.doc_title || 'Example source';
  const publisher = overrides.publisher || 'Example publisher';
  const publishedAt = overrides.published_at || '2024-01-01T00:00:00.000Z';
  const retrievedAt = overrides.retrieved_at || '2026-02-10T00:00:00.000Z';
  const excerpt = overrides.excerpt || 'Short source excerpt.';
  return {
    source_url: sourceUrl,
    doc_title: docTitle,
    publisher,
    published_at: publishedAt,
    retrieved_at: retrievedAt,
    excerpt,
    hash: overrides.hash || createCitationHash([sourceUrl, docTitle, publisher, publishedAt, excerpt]),
    license_hint: overrides.license_hint || 'Public metadata',
  };
}

function buildDataset(ingredients) {
  return {
    schema_version: 'aurora.ingredient_kb_v2.v1',
    generated_at: '2026-02-10T00:00:00.000Z',
    ingredients,
    manifests: [
      {
        source: 'test_snapshot',
        license_hint: 'Public metadata',
        retrieved_at: '2026-02-10T00:00:00.000Z',
        sha256: 'a'.repeat(64),
        file_path: 'data/external/test/snapshot.json',
        record_count: ingredients.length,
      },
    ],
    market_policy_docs: {
      EU: [baseCitation({ source_url: 'https://policy.example/eu', doc_title: 'EU policy' })],
      CN: [baseCitation({ source_url: 'https://policy.example/cn', doc_title: 'CN policy' })],
      JP: [baseCitation({ source_url: 'https://policy.example/jp', doc_title: 'JP policy' })],
      US: [baseCitation({ source_url: 'https://policy.example/us', doc_title: 'US policy' })],
    },
  };
}

async function withTempArtifacts({ dataset, catalog }, fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurora_product_rec_neutral_'));
  const artifactPath = path.join(tempDir, 'ingredient_kb_v2.json');
  const catalogPath = path.join(tempDir, 'product_catalog.json');
  try {
    assert.doesNotThrow(() => assertValidIngredientKbV2(dataset));
    await fs.writeFile(artifactPath, JSON.stringify(dataset, null, 2), 'utf8');
    await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2), 'utf8');
    await fn({ artifactPath, catalogPath });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function buildNiacinamideDataset() {
  return buildDataset([
    {
      ingredient_id: 'niacinamide',
      inci_name: 'Niacinamide',
      zh_name: '烟酰胺',
      aliases: [],
      identifiers: {},
      functions: [],
      restrictions: [],
      evidence_grade: 'B',
      market_scope: ['EU', 'US'],
      claims: [
        {
          claim_id: 'niacinamide_claim_1',
          claim_text: 'Supports visible tone-evening in cosmetic routines.',
          evidence_grade: 'B',
          market_scope: ['EU', 'US'],
          citations: [baseCitation()],
          risk_flags: [],
        },
      ],
      safety_notes: [],
      do_not_mix: [],
      manifest_refs: ['test_snapshot'],
    },
  ]);
}

test('neutral rec: higher suitability can outrank across sources and no 1:1 source quota', async () => {
  const dataset = buildNiacinamideDataset();
  const catalog = [];

  await withTempArtifacts({ dataset, catalog }, async ({ artifactPath, catalogPath }) => {
    let fallbackCalls = 0;
    const result = await buildIngredientProductRecommendationsNeutral({
      moduleId: 'left_cheek',
      ingredientId: 'niacinamide',
      ingredientName: 'Niacinamide',
      issueType: 'tone',
      market: 'US',
      lang: 'en',
      riskTier: 'low',
      qualityGrade: 'pass',
      minCitations: 1,
      minEvidenceGrade: 'B',
      repairOnlyWhenDegraded: false,
      artifactPath,
      catalogPath,
      maxProducts: 3,
      fallbackCandidateBuilder: async () => {
        fallbackCalls += 1;
        return {
          ok: true,
          products: [
            {
              product_id: 'prod_catalog_1',
              merchant_id: 'int_shop_a',
              name: 'Catalog Niacinamide Basic',
              brand: 'Internal A',
              ingredient_ids: [],
              retrieval_source: 'catalog',
              retrieval_reason: 'catalog_search_match',
            },
            {
              product_id: 'prod_external_1',
              merchant_id: 'ext_shop_a',
              name: 'External Niacinamide 10',
              brand: 'External A',
              ingredient_ids: ['niacinamide'],
              image_url: 'https://external-a.example.com/images/niacinamide-10.png',
              benefit_tags: ['oil_control', 'tone_evening'],
              price: 29.9,
              currency: 'USD',
              price_label: '$29.90',
              social_proof: { rating: 4.6, review_count: 128, summary: 'Popular for oil control' },
              retrieval_source: 'external_seed',
              retrieval_reason: 'external_seed_supplement',
              pdp_url: 'https://external-a.example.com/p/niacinamide-10',
            },
            {
              product_id: 'prod_external_2',
              merchant_id: 'ext_shop_b',
              name: 'External Niacinamide Barrier',
              brand: 'External B',
              ingredient_ids: ['niacinamide'],
              retrieval_source: 'external_seed',
              retrieval_reason: 'external_seed_supplement',
              pdp_url: 'https://external-b.example.com/p/niacinamide-barrier',
            },
          ],
          external_search_ctas: [],
        };
      },
      llmFallbackRecoverFn: null,
    });

    assert.equal(Array.isArray(result.products), true);
    assert.equal(result.products.length, 3);
    assert.equal(result.products[0].retrieval_source, 'external_seed');
    assert.equal(fallbackCalls, 1);

    const sourceCounts = result.products.reduce((acc, row) => {
      const key = String(row && row.retrieval_source || 'unknown');
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {});
    assert.equal(Number(sourceCounts.external_seed || 0) >= 2, true);
    assert.equal(Number(sourceCounts.catalog || 0) >= 1, true);
    assert.equal(result.products[0].price > 0, true);
    assert.equal(result.products[0].currency, 'USD');
    assert.equal(Array.isArray(result.products[0].benefit_tags), true);
    assert.equal(typeof result.products[0].social_proof, 'object');

    for (const row of result.products) {
      assert.equal(typeof row.retrieval_source, 'string');
      assert.equal(row.retrieval_source.length > 0, true);
      assert.equal(typeof row.retrieval_reason, 'string');
      assert.equal(row.retrieval_reason.length > 0, true);
    }
  });
});

test('neutral rec: skips network fallback when internal pool already has matches', async () => {
  const dataset = buildNiacinamideDataset();
  const catalog = [
    {
      product_id: 'prod_internal_1',
      name: 'Internal Niacinamide Serum',
      brand: 'Pivota Lab',
      market_scope: ['US'],
      ingredient_ids: ['niacinamide'],
      risk_tags: [],
      usage_note_en: 'Apply after cleansing.',
      usage_note_zh: '洁面后使用。',
      cautions_en: [],
      cautions_zh: [],
    },
  ];

  await withTempArtifacts({ dataset, catalog }, async ({ artifactPath, catalogPath }) => {
    let fallbackCalls = 0;
    const result = await buildIngredientProductRecommendationsNeutral({
      moduleId: 'left_cheek',
      ingredientId: 'niacinamide',
      ingredientName: 'Niacinamide',
      issueType: 'tone',
      market: 'US',
      lang: 'en',
      riskTier: 'low',
      qualityGrade: 'pass',
      minCitations: 1,
      minEvidenceGrade: 'B',
      repairOnlyWhenDegraded: false,
      artifactPath,
      catalogPath,
      maxProducts: 3,
      fallbackCandidateBuilder: async () => {
        fallbackCalls += 1;
        return { ok: true, products: [], external_search_ctas: [] };
      },
      llmFallbackRecoverFn: null,
    });

    assert.equal(Array.isArray(result.products), true);
    assert.equal(result.products.length >= 1, true);
    assert.equal(result.products[0].retrieval_source, 'catalog');
    assert.equal(fallbackCalls, 1);
  });
});

test('neutral rec: triggers llm fallback when pooled internal/external candidates are empty', async () => {
  const dataset = buildNiacinamideDataset();
  const catalog = [];

  await withTempArtifacts({ dataset, catalog }, async ({ artifactPath, catalogPath }) => {
    const result = await buildIngredientProductRecommendationsNeutral({
      moduleId: 'forehead',
      ingredientId: 'niacinamide',
      ingredientName: 'Niacinamide',
      issueType: 'tone',
      market: 'US',
      lang: 'en',
      riskTier: 'low',
      qualityGrade: 'pass',
      minCitations: 1,
      minEvidenceGrade: 'B',
      repairOnlyWhenDegraded: false,
      artifactPath,
      catalogPath,
      maxProducts: 3,
      fallbackCandidateBuilder: async () => ({ ok: true, products: [], external_search_ctas: [] }),
      llmFallbackRecoverFn: async () => ({
        products: [
          {
            product_id: 'prod_llm_1',
            merchant_id: 'llm_shop',
            name: 'LLM Recovered Niacinamide',
            brand: 'LLM Brand',
            ingredient_ids: ['niacinamide'],
            retrieval_source: 'llm_fallback',
            retrieval_reason: 'catalog_empty_or_filtered',
            pdp_url: 'https://llm.example.com/p/niacinamide',
          },
        ],
        external_search_ctas: [],
      }),
    });

    assert.equal(Array.isArray(result.products), true);
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].retrieval_source, 'llm_fallback');
    assert.equal(result.products[0].retrieval_reason.length > 0, true);
  });
});

test('neutral rec: returns google cta when internal/external + llm are all empty', async () => {
  const dataset = buildNiacinamideDataset();
  const catalog = [];

  await withTempArtifacts({ dataset, catalog }, async ({ artifactPath, catalogPath }) => {
    const result = await buildIngredientProductRecommendationsNeutral({
      moduleId: 'right_cheek',
      ingredientId: 'niacinamide',
      ingredientName: 'Niacinamide',
      issueType: 'tone',
      market: 'US',
      lang: 'en',
      riskTier: 'low',
      qualityGrade: 'pass',
      minCitations: 1,
      minEvidenceGrade: 'B',
      repairOnlyWhenDegraded: false,
      artifactPath,
      catalogPath,
      maxProducts: 3,
      fallbackCandidateBuilder: async () => ({ ok: true, products: [], external_search_ctas: [] }),
      llmFallbackRecoverFn: async () => ({ products: [], external_search_ctas: [] }),
    });

    assert.equal(Array.isArray(result.products), true);
    assert.equal(result.products.length, 0);
    assert.equal(typeof result.products_empty_reason, 'string');
    assert.equal(result.products_empty_reason.length > 0, true);
    assert.equal(Array.isArray(result.external_search_ctas), true);
    assert.equal(result.external_search_ctas.length > 0, true);
    assert.equal(String(result.external_search_ctas[0].url || '').includes('google.com/search'), true);
  });
});

test('neutral rec: canonical ingredient alias bridges template ids to catalog ingredient ids', async () => {
  const dataset = buildDataset([
    {
      ingredient_id: 'salicylic_acid',
      inci_name: 'Salicylic Acid',
      zh_name: '水杨酸',
      aliases: [],
      identifiers: {},
      functions: [],
      restrictions: [],
      evidence_grade: 'B',
      market_scope: ['US'],
      claims: [
        {
          claim_id: 'salicylic_claim_1',
          claim_text: 'Supports pore decongestion in cosmetic use.',
          evidence_grade: 'B',
          market_scope: ['US'],
          citations: [baseCitation({ source_url: 'https://example.org/salicylic' })],
          risk_flags: [],
        },
      ],
      safety_notes: [],
      do_not_mix: [],
      manifest_refs: ['test_snapshot'],
    },
  ]);
  const catalog = [
    {
      product_id: 'prod_bha_1',
      name: 'BHA Night Liquid',
      brand: 'Catalog BHA',
      market_scope: ['US'],
      ingredient_ids: ['salicylic_acid'],
      risk_tags: [],
      usage_note_en: 'Use at night only.',
      usage_note_zh: '夜间使用。',
      cautions_en: [],
      cautions_zh: [],
    },
  ];

  await withTempArtifacts({ dataset, catalog }, async ({ artifactPath, catalogPath }) => {
    const result = await buildIngredientProductRecommendationsNeutral({
      moduleId: 'left_cheek',
      ingredientId: 'bha_lha',
      ingredientName: 'BHA/LHA',
      issueType: 'texture',
      market: 'US',
      lang: 'en',
      riskTier: 'low',
      qualityGrade: 'pass',
      minCitations: 1,
      minEvidenceGrade: 'B',
      repairOnlyWhenDegraded: false,
      artifactPath,
      catalogPath,
      maxProducts: 3,
      fallbackCandidateBuilder: null,
      llmFallbackRecoverFn: null,
    });

    assert.equal(result.products.length >= 1, true);
    assert.equal(result.products[0].retrieval_source, 'catalog');
    assert.equal(result.debug.ingredient_id, 'salicylic_acid');
  });
});

test('neutral rec: soft evidence gate keeps candidates instead of hard-dropping by thresholds', async () => {
  const dataset = buildNiacinamideDataset();
  const catalog = [
    {
      product_id: 'prod_internal_soft_gate',
      name: 'Internal Niacinamide Soft Gate',
      brand: 'Pivota Lab',
      market_scope: ['US'],
      ingredient_ids: ['niacinamide'],
      risk_tags: [],
      usage_note_en: 'Use daily after toner.',
      usage_note_zh: '化妆水后使用。',
      cautions_en: [],
      cautions_zh: [],
    },
  ];

  await withTempArtifacts({ dataset, catalog }, async ({ artifactPath, catalogPath }) => {
    const result = await buildIngredientProductRecommendationsNeutral({
      moduleId: 'left_cheek',
      ingredientId: 'niacinamide',
      ingredientName: 'Niacinamide',
      issueType: 'tone',
      market: 'US',
      lang: 'en',
      riskTier: 'low',
      qualityGrade: 'pass',
      minCitations: 3,
      minEvidenceGrade: 'A',
      repairOnlyWhenDegraded: false,
      artifactPath,
      catalogPath,
      maxProducts: 3,
      fallbackCandidateBuilder: null,
      llmFallbackRecoverFn: null,
    });

    assert.equal(result.products.length >= 1, true);
    assert.equal(result.products[0].retrieval_source, 'catalog');
    assert.equal(typeof result.debug.evidence_score, 'number');
  });
});

test('neutral rec: can roll back to hard evidence gate via option switch', async () => {
  const dataset = buildNiacinamideDataset();
  const catalog = [
    {
      product_id: 'prod_internal_hard_gate',
      name: 'Internal Niacinamide Hard Gate',
      brand: 'Pivota Lab',
      market_scope: ['US'],
      ingredient_ids: ['niacinamide'],
      risk_tags: [],
      usage_note_en: 'Use daily after toner.',
      usage_note_zh: '化妆水后使用。',
      cautions_en: [],
      cautions_zh: [],
    },
  ];

  await withTempArtifacts({ dataset, catalog }, async ({ artifactPath, catalogPath }) => {
    const result = await buildIngredientProductRecommendationsNeutral({
      moduleId: 'left_cheek',
      ingredientId: 'niacinamide',
      ingredientName: 'Niacinamide',
      issueType: 'tone',
      market: 'US',
      lang: 'en',
      riskTier: 'low',
      qualityGrade: 'pass',
      minCitations: 3,
      minEvidenceGrade: 'A',
      repairOnlyWhenDegraded: false,
      artifactPath,
      catalogPath,
      maxProducts: 3,
      fallbackCandidateBuilder: null,
      llmFallbackRecoverFn: null,
      softEvidenceGateEnabled: false,
    });

    assert.equal(result.products.length, 0);
    assert.equal(result.suppressed_reason, 'LOW_EVIDENCE');
    assert.equal(result.products_empty_reason, 'low_evidence');
    assert.equal(result.debug.soft_evidence_gate_enabled, false);
  });
});
