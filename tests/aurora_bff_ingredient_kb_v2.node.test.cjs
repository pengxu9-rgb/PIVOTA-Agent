const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  citationSchema,
  assertValidIngredientKbV2,
  createCitationHash,
} = require('../src/auroraBff/ingredientKbV2/types');
const {
  detectBannedClaimTerms,
  sanitizeClaimText,
  ensureCosmeticSafeClaims,
  genericSafeClaim,
} = require('../src/auroraBff/ingredientKbV2/claimGuard');
const { resolveIngredientRecommendation } = require('../src/auroraBff/ingredientKbV2/resolve');

function baseCitation(overrides = {}) {
  const sourceUrl = overrides.source_url || 'https://example.org/doc';
  const docTitle = overrides.doc_title || 'Example document';
  const publisher = overrides.publisher || 'Example publisher';
  const publishedAt = overrides.published_at || '2024-01-01T00:00:00.000Z';
  const retrievedAt = overrides.retrieved_at || '2026-02-09T00:00:00.000Z';
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

function baseManifest() {
  return {
    source: 'cosing_snapshot',
    license_hint: 'Public metadata',
    retrieved_at: '2026-02-09T00:00:00.000Z',
    sha256: 'a'.repeat(64),
    file_path: 'data/external/cosing/cosing_snapshot_min.csv',
    record_count: 1,
  };
}

function baseDataset() {
  const citation = baseCitation();
  return {
    schema_version: 'aurora.ingredient_kb_v2.v1',
    generated_at: '2026-02-09T00:00:00.000Z',
    ingredients: [
      {
        ingredient_id: 'niacinamide',
        inci_name: 'Niacinamide',
        zh_name: '烟酰胺',
        aliases: ['Vitamin B3'],
        identifiers: {
          cosing_id: 'COSING:8835',
          cas_no: '98-92-0',
          ec_no: '202-713-4',
        },
        functions: ['skin conditioning', 'tone-evening'],
        restrictions: ['Use with patch test on very sensitive skin'],
        evidence_grade: 'B',
        market_scope: ['EU', 'JP', 'US'],
        claims: [
          {
            claim_id: 'niacinamide_claim_eu',
            claim_text: 'Supports visible tone-evening.',
            evidence_grade: 'B',
            market_scope: ['EU'],
            citations: [citation],
            risk_flags: [],
          },
          {
            claim_id: 'niacinamide_claim_jp_sensitive',
            claim_text: 'Supports visible calming in mild-use routines.',
            evidence_grade: 'B',
            market_scope: ['JP'],
            citations: [citation],
            risk_flags: ['sensitive'],
          },
        ],
        safety_notes: [
          {
            note_id: 'niacinamide_note_1',
            note_text: 'Reduce frequency if persistent flushing occurs.',
            evidence_grade: 'B',
            market_scope: ['EU', 'JP'],
            citations: [citation],
            risk_flags: ['sensitive'],
          },
        ],
        do_not_mix: ['Strong acids in same routine'],
        manifest_refs: ['cosing_snapshot'],
      },
    ],
    manifests: [baseManifest()],
    market_policy_docs: {
      EU: [baseCitation({ source_url: 'https://policy.example/eu', doc_title: 'EU policy doc' })],
      CN: [baseCitation({ source_url: 'https://policy.example/cn', doc_title: 'CN policy doc' })],
      JP: [baseCitation({ source_url: 'https://policy.example/jp', doc_title: 'JP policy doc' })],
      US: [baseCitation({ source_url: 'https://policy.example/us', doc_title: 'US policy doc' })],
    },
  };
}

test('citation schema enforces required fields and limits', () => {
  const valid = citationSchema.safeParse(baseCitation());
  assert.equal(valid.success, true);

  const invalidHash = citationSchema.safeParse(baseCitation({ hash: 'short' }));
  assert.equal(invalidHash.success, false);

  const invalidUrl = citationSchema.safeParse(baseCitation({ source_url: 'ftp://example.org/doc' }));
  assert.equal(invalidUrl.success, false);

  const longExcerpt = citationSchema.safeParse(baseCitation({ excerpt: 'x'.repeat(241) }));
  assert.equal(longExcerpt.success, false);
});

test('claim guard blocks banned terms in EN/CN/JP and falls back to cosmetic-safe wording', () => {
  assert.ok(detectBannedClaimTerms('This will treat acne signs.').length > 0);
  assert.ok(detectBannedClaimTerms('用于治疗问题肌肤').length > 0);
  assert.ok(detectBannedClaimTerms('診断に使う表現').length > 0);

  const safe = sanitizeClaimText('Can treat irritation quickly', { market: 'US', evidenceGrade: 'A' });
  assert.equal(safe, genericSafeClaim({ market: 'US' }));

  const lowEvidence = sanitizeClaimText('Supports visible smoothness', { market: 'JP', evidenceGrade: 'C' });
  assert.equal(lowEvidence, genericSafeClaim({ market: 'JP' }));

  const claims = ensureCosmeticSafeClaims(
    ['Supports visible balance', 'Supports visible balance', 'Can cure dryness'],
    { market: 'EU', evidenceGrade: 'A' },
  );
  assert.equal(claims.length, 2);
  assert.equal(claims[1], genericSafeClaim({ market: 'EU' }));
});

test('resolver applies market/risk gating and evidence fallback', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurora_ingredient_kb_v2_'));
  const artifactPath = path.join(tempDir, 'ingredient_kb_v2.json');
  try {
    const dataset = baseDataset();
    assert.doesNotThrow(() => assertValidIngredientKbV2(dataset));
    await fs.writeFile(artifactPath, JSON.stringify(dataset, null, 2), 'utf8');

    const euResult = resolveIngredientRecommendation({
      ingredientId: 'niacinamide',
      market: 'EU',
      riskTier: 'standard',
      artifactPath,
    });
    assert.equal(euResult.evidence_grade, 'B');
    assert.equal(euResult.evidence_limited, false);
    assert.ok(Array.isArray(euResult.citations) && euResult.citations.length > 0);
    assert.ok(euResult.allowed_claims.some((claim) => claim.includes('tone-evening')));

    const jpSensitive = resolveIngredientRecommendation({
      ingredientId: 'niacinamide',
      market: 'JP',
      riskTier: 'sensitive',
      artifactPath,
    });
    assert.equal(jpSensitive.evidence_grade, 'C');
    assert.equal(jpSensitive.evidence_limited, true);
    assert.equal(jpSensitive.allowed_claims.length, 1);
    assert.equal(jpSensitive.allowed_claims[0], genericSafeClaim({ market: 'JP' }));
    assert.ok(jpSensitive.disallowed_claims.some((item) => item.includes('calming')));

    const cnResult = resolveIngredientRecommendation({
      ingredientId: 'niacinamide',
      market: 'CN',
      riskTier: 'standard',
      artifactPath,
    });
    assert.equal(cnResult.evidence_grade, 'C');
    assert.equal(cnResult.evidence_limited, true);
    assert.equal(cnResult.allowed_claims[0], genericSafeClaim({ market: 'CN' }));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
