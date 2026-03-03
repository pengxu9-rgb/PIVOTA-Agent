const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/auroraBff/routes');
const {
  buildIngredientReportPayload,
  enrichIngredientReportCardsInEnvelope,
} = __internal;

describe('ingredient report individualization', () => {
  const testCases = [
    {
      name: 'BEHENYL ALCOHOL',
      query: 'BEHENYL ALCOHOL',
      expectCategory: /fatty alcohol/i,
      expectEvidenceGrade: 'B',
      expectIrritationRisk: 'low',
      expectBenefitConcerns: ['hydration'],
    },
    {
      name: 'Niacinamide',
      query: 'niacinamide',
      expectCategory: /barrier.*brightening|brightening.*barrier/i,
      expectEvidenceGrade: 'B',
      expectIrritationRisk: 'low',
      expectBenefitConcerns: ['brightening', 'barrier-support'],
    },
    {
      name: 'Retinol',
      query: 'retinol',
      expectCategory: /anti-aging|texture/i,
      expectEvidenceGrade: 'B',
      expectIrritationRisk: 'medium',
      expectBenefitConcerns: ['fine-lines', 'texture'],
    },
    {
      name: 'Octocrylene (UV filter)',
      query: 'octocrylene',
      expectCategory: /uv filter|stabilizer/i,
      expectEvidenceGrade: 'B',
      expectIrritationRisk: 'low',
      expectBenefitConcerns: ['photoprotection'],
    },
    {
      name: 'Phenoxyethanol (preservative)',
      query: 'phenoxyethanol',
      expectCategory: /preservative/i,
      expectEvidenceGrade: 'B',
      expectIrritationRisk: 'low',
      expectBenefitConcerns: ['formula_stability'],
    },
    {
      name: 'Random unknown ingredient',
      query: 'xylitylglucoside unknown',
      expectCategory: /ingredient lookup/i,
      expectEvidenceGrade: null,
      expectIrritationRisk: null,
      expectBenefitConcerns: ['hydration'],
    },
  ];

  for (const tc of testCases) {
    it(`produces differentiated report for ${tc.name}`, () => {
      const payload = buildIngredientReportPayload({
        language: 'EN',
        query: tc.query,
        research: null,
        meta: {},
      });

      assert.ok(payload, `payload should not be null for ${tc.name}`);
      assert.equal(payload.schema_version, 'aurora.ingredient_report.v2-lite');

      assert.match(
        payload.ingredient.category,
        tc.expectCategory,
        `category mismatch for ${tc.name}: got "${payload.ingredient.category}"`,
      );

      if (tc.expectEvidenceGrade) {
        assert.equal(
          payload.verdict.evidence_grade,
          tc.expectEvidenceGrade,
          `evidence_grade mismatch for ${tc.name}`,
        );
      }

      if (tc.expectIrritationRisk) {
        assert.equal(
          payload.verdict.irritation_risk,
          tc.expectIrritationRisk,
          `irritation_risk mismatch for ${tc.name}`,
        );
      }

      assert.ok(
        Array.isArray(payload.benefits) && payload.benefits.length > 0,
        `benefits should not be empty for ${tc.name}`,
      );

      for (const expectedConcern of tc.expectBenefitConcerns) {
        const found = payload.benefits.some((b) => b.concern === expectedConcern);
        assert.ok(found, `expected benefit concern "${expectedConcern}" not found for ${tc.name}`);
      }

      assert.ok(
        Array.isArray(payload.watchouts) && payload.watchouts.length > 0,
        `watchouts should not be empty for ${tc.name}`,
      );

      assert.ok(
        payload.verdict.one_liner && payload.verdict.one_liner.length > 10,
        `one_liner should be substantive for ${tc.name}`,
      );
    });
  }

  it('produces different one_liners for different ingredients', () => {
    const queries = ['niacinamide', 'retinol', 'octocrylene', 'phenoxyethanol', 'behenyl alcohol'];
    const oneLiners = new Set();

    for (const query of queries) {
      const payload = buildIngredientReportPayload({ language: 'EN', query, research: null, meta: {} });
      assert.ok(payload);
      oneLiners.add(payload.verdict.one_liner);
    }

    assert.equal(
      oneLiners.size,
      queries.length,
      `Expected ${queries.length} unique one_liners, got ${oneLiners.size}`,
    );
  });

  it('produces different categories for different ingredient types', () => {
    const queries = ['niacinamide', 'retinol', 'octocrylene', 'phenoxyethanol', 'glycerin'];
    const categories = new Set();

    for (const query of queries) {
      const payload = buildIngredientReportPayload({ language: 'EN', query, research: null, meta: {} });
      assert.ok(payload);
      categories.add(payload.ingredient.category);
    }

    assert.ok(
      categories.size >= 4,
      `Expected at least 4 unique categories, got ${categories.size}: ${[...categories].join(', ')}`,
    );
  });

  it('enriches generic LLM cards with deterministic data', () => {
    const genericEnvelope = {
      cards: [
        {
          card_id: 'ingredient_report_test',
          type: 'aurora_ingredient_report',
          payload: {
            schema_version: 'aurora.ingredient_report.v2-lite',
            locale: 'en-US',
            research_status: 'fallback',
            ingredient: {
              inci: 'BEHENYL ALCOHOL',
              display_name: 'BEHENYL ALCOHOL',
              aliases: [],
              category: 'Ingredient lookup',
            },
            verdict: {
              one_liner: 'Here is a quick ingredient snapshot for BEHENYL ALCOHOL.',
              top_benefits: ['Generic guidance.'],
              evidence_grade: 'unknown',
              irritation_risk: 'unknown',
              time_to_results: null,
              confidence: 0.55,
              confidence_level: 'low',
            },
            benefits: [],
            how_to_use: { frequency: 'unknown', routine_step: 'unknown', pair_well: [], consider_separating: [], notes: [] },
            watchouts: [],
            evidence: { summary: '', citations: [], show_citations_by_default: false },
          },
        },
      ],
    };

    const enriched = enrichIngredientReportCardsInEnvelope(genericEnvelope, { language: 'EN' });
    const card = enriched.cards[0];
    const p = card.payload;

    assert.match(p.ingredient.category, /fatty alcohol/i, 'should be enriched with fatty alcohol category');
    assert.equal(p.verdict.evidence_grade, 'B', 'should have deterministic evidence grade');
    assert.equal(p.verdict.irritation_risk, 'low', 'should have deterministic irritation risk');
    assert.ok(p.benefits.length > 0, 'should have deterministic benefits');
    assert.ok(p.watchouts.length > 0, 'should have deterministic watchouts');
  });

  it('family fallback produces differentiated content for known families', () => {
    const familyQueries = [
      { query: 'glycolic acid', family: 'aha' },
      { query: 'adapalene', family: 'retinoid' },
      { query: 'zinc oxide', family: 'mineral_filter' },
      { query: 'glycerin', family: 'humectant' },
    ];

    const categories = new Set();
    for (const { query } of familyQueries) {
      const payload = buildIngredientReportPayload({ language: 'EN', query, research: null, meta: {} });
      assert.ok(payload, `payload should exist for ${query}`);
      categories.add(payload.ingredient.category);
      assert.ok(
        !/^Ingredient lookup$/.test(payload.ingredient.category),
        `${query} should not get generic "Ingredient lookup" category, got "${payload.ingredient.category}"`,
      );
    }

    assert.ok(
      categories.size >= 3,
      `Expected at least 3 unique categories from family queries, got ${categories.size}`,
    );
  });
});
