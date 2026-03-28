const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createCitationHash, assertValidIngredientKbV2 } = require('../src/auroraBff/ingredientKbV2/types');
const { DEFAULT_CATALOG_PATH, buildProductRecommendations } = require('../src/auroraBff/productRecV1');

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

function buildDataset() {
  return {
    schema_version: 'aurora.ingredient_kb_v2.v1',
    generated_at: '2026-02-10T00:00:00.000Z',
    ingredients: [
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
    ],
    manifests: [
      {
        source: 'test_snapshot',
        license_hint: 'Public metadata',
        retrieved_at: '2026-02-10T00:00:00.000Z',
        sha256: 'c'.repeat(64),
        file_path: 'data/external/test/snapshot.json',
        record_count: 1,
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

async function withTempArtifacts(catalog, fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurora_photo_product_rec_catalog_'));
  const artifactPath = path.join(tempDir, 'ingredient_kb_v2.json');
  const catalogPath = path.join(tempDir, 'product_catalog.json');
  try {
    const dataset = buildDataset();
    assert.doesNotThrow(() => assertValidIngredientKbV2(dataset));
    await fs.writeFile(artifactPath, JSON.stringify(dataset, null, 2), 'utf8');
    await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2), 'utf8');
    await fn({ artifactPath, catalogPath });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('photo product rec: bundled demo catalog can be disabled explicitly', async () => {
  await withTempArtifacts([], async ({ artifactPath }) => {
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
      repairOnlyWhenDegraded: false,
      artifactPath,
      catalogPath: DEFAULT_CATALOG_PATH,
      allowBundledCatalogSeed: false,
    });

    assert.equal(result.products.length, 0);
    assert.equal(result.suppressed_reason, 'NO_MATCH');
    assert.equal(result.debug.catalog_items, 0);
    assert.equal(result.debug.bundled_catalog_seed_allowed, false);
  });
});

test('photo product rec: explicit non-demo catalog still works when bundled fallback is disabled', async () => {
  await withTempArtifacts(
    [
      {
        product_id: 'prod_real_catalog_1',
        name: 'Real Catalog Niacinamide Serum',
        brand: 'Real Catalog',
        market_scope: ['EU', 'US'],
        ingredient_ids: ['niacinamide'],
        risk_tags: [],
        usage_note_en: 'Apply after cleansing.',
        usage_note_zh: '洁面后使用。',
        cautions_en: [],
        cautions_zh: [],
      },
    ],
    async ({ artifactPath, catalogPath }) => {
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
        repairOnlyWhenDegraded: false,
        artifactPath,
        catalogPath,
        allowBundledCatalogSeed: false,
      });

      assert.equal(result.products.length >= 1, true);
      assert.equal(result.products[0].brand, 'Real Catalog');
      assert.equal(result.products[0].retrieval_source, 'catalog');
    },
  );
});
