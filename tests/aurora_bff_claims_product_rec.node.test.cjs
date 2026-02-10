const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { renderAllowedTemplate } = require('../src/auroraBff/claimsTemplates/render');
const { validateRenderedText } = require('../src/auroraBff/claimsTemplates/validate');
const { detectBannedClaimTerms } = require('../src/auroraBff/ingredientKbV2/claimGuard');
const { createCitationHash, assertValidIngredientKbV2 } = require('../src/auroraBff/ingredientKbV2/types');
const { buildProductRecommendations } = require('../src/auroraBff/productRecV1');

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
        sha256: 'b'.repeat(64),
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurora_claims_product_rec_'));
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

test('allowed templates are allowlisted and free of banned medical claims', () => {
  const combos = [
    { templateType: 'ingredient_why', issueType: 'redness' },
    { templateType: 'product_why_match', issueType: 'texture' },
    { templateType: 'module_explanation_short', issueType: 'acne' },
    { templateType: 'how_to_use', issueType: 'tone' },
  ];
  for (const market of ['EU', 'US']) {
    for (const lang of ['en', 'zh']) {
      for (const combo of combos) {
        const rendered = renderAllowedTemplate({
          templateType: combo.templateType,
          issueType: combo.issueType,
          ingredientName: lang === 'zh' ? '烟酰胺' : 'Niacinamide',
          moduleLabel: lang === 'zh' ? '额头' : 'forehead',
          market,
          lang,
        });
        assert.ok(rendered.text && rendered.text.length > 0);
        assert.ok(rendered.text.length <= 240);
        const validation = validateRenderedText({ text: rendered.text, templateKey: rendered.template_key });
        assert.equal(validation.ok, true);
        assert.equal(detectBannedClaimTerms(rendered.text).length, 0);
      }
    }
  }
});

test('product rec is suppressed when evidence is below threshold', async () => {
  const dataset = buildDataset([
    {
      ingredient_id: 'niacinamide',
      inci_name: 'Niacinamide',
      zh_name: '烟酰胺',
      aliases: [],
      identifiers: {},
      functions: [],
      restrictions: [],
      evidence_grade: 'C',
      market_scope: ['EU', 'US'],
      claims: [],
      safety_notes: [],
      do_not_mix: [],
      manifest_refs: ['test_snapshot'],
    },
  ]);
  const catalog = [
    {
      product_id: 'prod_niacinamide',
      name: 'Niacinamide Gel',
      brand: 'Test Brand',
      market_scope: ['EU', 'US'],
      ingredient_ids: ['niacinamide'],
      risk_tags: ['lightweight'],
      usage_note_en: 'Apply after cleansing.',
      usage_note_zh: '洁面后使用。',
      cautions_en: [],
      cautions_zh: [],
    },
  ];

  await withTempArtifacts({ dataset, catalog }, async ({ artifactPath, catalogPath }) => {
    const result = buildProductRecommendations({
      moduleId: 'forehead',
      issues: [{ issue_type: 'tone', severity_0_4: 2.5 }],
      actions: [{ ingredient_id: 'niacinamide', evidence_issue_types: ['tone'] }],
      market: 'US',
      lang: 'en',
      riskTier: 'low',
      qualityGrade: 'pass',
      minCitations: 1,
      minEvidenceGrade: 'B',
      repairOnlyWhenDegraded: true,
      artifactPath,
      catalogPath,
    });
    assert.equal(Array.isArray(result.products), true);
    assert.equal(result.products.length, 0);
    assert.equal(result.suppressed_reason, 'LOW_EVIDENCE');
  });
});

test('product rec emits templated why_match with citations when evidence is sufficient', async () => {
  const dataset = buildDataset([
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
  const catalog = [
    {
      product_id: 'prod_niacinamide',
      name: 'Niacinamide Gel',
      brand: 'Test Brand',
      market_scope: ['EU', 'US'],
      ingredient_ids: ['niacinamide'],
      risk_tags: ['lightweight'],
      usage_note_en: 'Apply after cleansing.',
      usage_note_zh: '洁面后使用。',
      cautions_en: [],
      cautions_zh: [],
    },
  ];

  await withTempArtifacts({ dataset, catalog }, async ({ artifactPath, catalogPath }) => {
    const result = buildProductRecommendations({
      moduleId: 'left_cheek',
      issues: [{ issue_type: 'tone', severity_0_4: 2.8 }],
      actions: [{ ingredient_id: 'niacinamide', evidence_issue_types: ['tone'] }],
      market: 'EU',
      lang: 'en',
      riskTier: 'low',
      qualityGrade: 'pass',
      minCitations: 1,
      minEvidenceGrade: 'B',
      repairOnlyWhenDegraded: true,
      artifactPath,
      catalogPath,
    });
    assert.ok(result.products.length >= 1);
    const first = result.products[0];
    assert.ok(first.why_match_template_key && first.why_match_template_key.length > 0);
    assert.equal(first.evidence.evidence_grade === 'A' || first.evidence.evidence_grade === 'B', true);
    assert.ok(Array.isArray(first.evidence.citation_ids) && first.evidence.citation_ids.length >= 1);
    assert.equal(detectBannedClaimTerms(first.why_match).length, 0);
    const validation = validateRenderedText({ text: first.why_match, templateKey: first.why_match_template_key });
    assert.equal(validation.ok, true);
  });
});

test('barrier-irritated risk filters strong-active products and keeps repair options', async () => {
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
      market_scope: ['EU', 'US'],
      claims: [
        {
          claim_id: 'sa_claim_1',
          claim_text: 'Helps improve the appearance of blemish-prone areas.',
          evidence_grade: 'B',
          market_scope: ['EU', 'US'],
          citations: [baseCitation({ source_url: 'https://example.org/sa' })],
          risk_flags: [],
        },
      ],
      safety_notes: [],
      do_not_mix: ['Strong acids'],
      manifest_refs: ['test_snapshot'],
    },
    {
      ingredient_id: 'panthenol',
      inci_name: 'Panthenol',
      zh_name: '泛醇',
      aliases: [],
      identifiers: {},
      functions: [],
      restrictions: [],
      evidence_grade: 'B',
      market_scope: ['EU', 'US'],
      claims: [
        {
          claim_id: 'panthenol_claim_1',
          claim_text: 'Supports visible skin comfort and smoothness.',
          evidence_grade: 'B',
          market_scope: ['EU', 'US'],
          citations: [baseCitation({ source_url: 'https://example.org/panthenol' })],
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
      product_id: 'prod_strong_acid',
      name: 'Strong Acid Lotion',
      brand: 'Test Brand',
      market_scope: ['EU', 'US'],
      ingredient_ids: ['salicylic_acid'],
      risk_tags: ['acid', 'active'],
      usage_note_en: 'Use very carefully.',
      usage_note_zh: '谨慎使用。',
      cautions_en: [],
      cautions_zh: [],
    },
    {
      product_id: 'prod_repair_panthenol',
      name: 'Repair Panthenol Cream',
      brand: 'Test Brand',
      market_scope: ['EU', 'US'],
      ingredient_ids: ['panthenol'],
      risk_tags: ['repair'],
      usage_note_en: 'Use in gentle routines.',
      usage_note_zh: '可用于温和修护。',
      cautions_en: [],
      cautions_zh: [],
    },
  ];

  await withTempArtifacts({ dataset, catalog }, async ({ artifactPath, catalogPath }) => {
    const result = buildProductRecommendations({
      moduleId: 'chin',
      issues: [{ issue_type: 'acne', severity_0_4: 2.6 }],
      actions: [
        { ingredient_id: 'salicylic_acid', evidence_issue_types: ['acne'] },
        { ingredient_id: 'panthenol', evidence_issue_types: ['redness'] },
      ],
      market: 'US',
      lang: 'en',
      riskTier: 'barrier_irritated',
      qualityGrade: 'pass',
      minCitations: 1,
      minEvidenceGrade: 'B',
      repairOnlyWhenDegraded: true,
      artifactPath,
      catalogPath,
    });
    assert.ok(result.products.length >= 1);
    const productIds = result.products.map((item) => item.product_id);
    assert.equal(productIds.includes('prod_strong_acid'), false);
    assert.equal(productIds.includes('prod_repair_panthenol'), true);
  });
});

test('degraded quality emits repair-only products when repair-only mode is enabled', async () => {
  const dataset = buildDataset([
    {
      ingredient_id: 'retinol',
      inci_name: 'Retinol',
      zh_name: '视黄醇',
      aliases: [],
      identifiers: {},
      functions: [],
      restrictions: [],
      evidence_grade: 'A',
      market_scope: ['EU', 'US'],
      claims: [
        {
          claim_id: 'retinol_claim_1',
          claim_text: 'Supports the appearance of smoother texture.',
          evidence_grade: 'A',
          market_scope: ['EU', 'US'],
          citations: [baseCitation({ source_url: 'https://example.org/retinol' })],
          risk_flags: [],
        },
      ],
      safety_notes: [],
      do_not_mix: ['Strong acids'],
      manifest_refs: ['test_snapshot'],
    },
    {
      ingredient_id: 'panthenol',
      inci_name: 'Panthenol',
      zh_name: '泛醇',
      aliases: [],
      identifiers: {},
      functions: [],
      restrictions: [],
      evidence_grade: 'B',
      market_scope: ['EU', 'US'],
      claims: [
        {
          claim_id: 'panthenol_claim_1',
          claim_text: 'Supports visible comfort and smoother appearance.',
          evidence_grade: 'B',
          market_scope: ['EU', 'US'],
          citations: [baseCitation({ source_url: 'https://example.org/panthenol-repair' })],
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
      product_id: 'prod_repair_panthenol',
      name: 'Repair Panthenol Cream',
      brand: 'Test Brand',
      market_scope: ['EU', 'US'],
      ingredient_ids: ['panthenol'],
      risk_tags: ['repair'],
      usage_note_en: 'Use in gentle routines.',
      usage_note_zh: '可用于温和修护。',
      cautions_en: [],
      cautions_zh: [],
    },
    {
      product_id: 'prod_active_retinol',
      name: 'Night Retinol Serum',
      brand: 'Test Brand',
      market_scope: ['EU', 'US'],
      ingredient_ids: ['retinol'],
      risk_tags: ['retinoid', 'active'],
      usage_note_en: 'Use at night only.',
      usage_note_zh: '仅夜间使用。',
      cautions_en: [],
      cautions_zh: [],
    },
  ];

  await withTempArtifacts({ dataset, catalog }, async ({ artifactPath, catalogPath }) => {
    const result = buildProductRecommendations({
      moduleId: 'forehead',
      issues: [{ issue_type: 'texture', severity_0_4: 2.7 }],
      actions: [
        { ingredient_id: 'retinol', evidence_issue_types: ['texture'] },
        { ingredient_id: 'panthenol', evidence_issue_types: ['redness'] },
      ],
      market: 'US',
      lang: 'en',
      riskTier: 'low',
      qualityGrade: 'degraded',
      minCitations: 1,
      minEvidenceGrade: 'B',
      repairOnlyWhenDegraded: true,
      artifactPath,
      catalogPath,
    });

    assert.ok(Array.isArray(result.products));
    assert.ok(result.products.length >= 1);
    const productIds = result.products.map((item) => item.product_id);
    assert.equal(productIds.includes('prod_repair_panthenol'), true);
    assert.equal(productIds.includes('prod_active_retinol'), false);
    for (const item of result.products) {
      assert.ok(item.evidence && Array.isArray(item.evidence.citation_ids));
      assert.ok(item.evidence.citation_ids.length >= 1);
      assert.equal(detectBannedClaimTerms(item.why_match).length, 0);
    }
  });
});

test('degraded quality suppresses when repair evidence is below threshold', async () => {
  const dataset = buildDataset([
    {
      ingredient_id: 'panthenol',
      inci_name: 'Panthenol',
      zh_name: '泛醇',
      aliases: [],
      identifiers: {},
      functions: [],
      restrictions: [],
      evidence_grade: 'C',
      market_scope: ['EU', 'US'],
      claims: [],
      safety_notes: [],
      do_not_mix: [],
      manifest_refs: ['test_snapshot'],
    },
  ]);
  const catalog = [
    {
      product_id: 'prod_repair_panthenol',
      name: 'Repair Panthenol Cream',
      brand: 'Test Brand',
      market_scope: ['EU', 'US'],
      ingredient_ids: ['panthenol'],
      risk_tags: ['repair'],
      usage_note_en: 'Use in gentle routines.',
      usage_note_zh: '可用于温和修护。',
      cautions_en: [],
      cautions_zh: [],
    },
  ];

  await withTempArtifacts({ dataset, catalog }, async ({ artifactPath, catalogPath }) => {
    const result = buildProductRecommendations({
      moduleId: 'forehead',
      issues: [{ issue_type: 'redness', severity_0_4: 2.3 }],
      actions: [{ ingredient_id: 'panthenol', evidence_issue_types: ['redness'] }],
      market: 'US',
      lang: 'en',
      riskTier: 'low',
      qualityGrade: 'degraded',
      minCitations: 1,
      minEvidenceGrade: 'B',
      repairOnlyWhenDegraded: true,
      artifactPath,
      catalogPath,
    });

    assert.equal(Array.isArray(result.products), true);
    assert.equal(result.products.length, 0);
    assert.equal(result.suppressed_reason, 'LOW_EVIDENCE');
  });
});

test('product rec suppression reason uses NO_MATCH when no catalog overlap is available', async () => {
  const dataset = buildDataset([
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
          citations: [baseCitation({ source_url: 'https://example.org/niacinamide-no-match' })],
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
      product_id: 'prod_unrelated',
      name: 'Unrelated Product',
      brand: 'Test Brand',
      market_scope: ['EU', 'US'],
      ingredient_ids: ['hyaluronic_acid'],
      risk_tags: ['lightweight'],
      usage_note_en: 'Use as needed.',
      usage_note_zh: '按需使用。',
      cautions_en: [],
      cautions_zh: [],
    },
  ];

  await withTempArtifacts({ dataset, catalog }, async ({ artifactPath, catalogPath }) => {
    const result = buildProductRecommendations({
      moduleId: 'left_cheek',
      issues: [{ issue_type: 'tone', severity_0_4: 2.8 }],
      actions: [{ ingredient_id: 'niacinamide', evidence_issue_types: ['tone'] }],
      market: 'EU',
      lang: 'en',
      riskTier: 'low',
      qualityGrade: 'pass',
      minCitations: 1,
      minEvidenceGrade: 'B',
      repairOnlyWhenDegraded: true,
      artifactPath,
      catalogPath,
    });
    assert.equal(Array.isArray(result.products), true);
    assert.equal(result.products.length, 0);
    assert.equal(result.suppressed_reason, 'NO_MATCH');
  });
});
