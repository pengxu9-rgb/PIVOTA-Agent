jest.mock('../src/services/externalSeedPipelineStatus', () => ({
  getExternalSeedPipelineStatus: jest.fn(),
}));

const ProductPipelineAuditStatusSkill = require('../src/auroraBff/skills/product_pipeline_audit_status');
const { getExternalSeedPipelineStatus } = require('../src/services/externalSeedPipelineStatus');
const { validateSkillRequest } = require('../src/auroraBff/validators/schema_validator');

describe('product.pipeline.audit_status skill', () => {
  beforeEach(() => {
    getExternalSeedPipelineStatus.mockReset();
  });

  test('validator accepts multi-segment skill ids', () => {
    expect(
      validateSkillRequest({
        skill_id: 'product.pipeline.audit_status',
        skill_version: '1.0.0',
        context: {},
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  test('returns a read-only audit status response', async () => {
    getExternalSeedPipelineStatus.mockResolvedValue({
      seed: {
        id: 'eps_1',
        title: 'Banana Bright Vitamin C Serum',
        canonical_url: 'https://olehenriksen.com/products/banana-bright-vitamin-c-serum',
        diagnostics: {
          failure_category: null,
          discovery_strategy: 'shopify_json',
        },
      },
      audit: {
        findings: [
          {
            anomaly_type: 'generic_template_description',
            severity: 'review',
          },
        ],
      },
      audit_summary: {
        by_severity: {
          blocker: 0,
          review: 1,
          info: 0,
        },
      },
      coverage: {
        ingredient_coverage_status: 'ready_for_harvest',
        kb_coverage_status: 'missing',
      },
      gating: {
        audit_status: 'needs_review',
      },
    });

    const skill = new ProductPipelineAuditStatusSkill();
    const result = await skill.run(
      {
        skill_id: 'product.pipeline.audit_status',
        skill_version: '1.0.0',
        params: {
          external_seed_id: 'eps_1',
        },
        context: {},
      },
      null,
    );

    expect(result.telemetry.skill_id).toBe('product.pipeline.audit_status');
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].card_type).toBe('text_response');
    expect(result.cards[0].sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text_answer' }),
        expect.objectContaining({
          type: 'pipeline_audit_status',
          coverage: expect.objectContaining({ kb_coverage_status: 'missing' }),
          gating: expect.objectContaining({ audit_status: 'needs_review' }),
        }),
      ]),
    );
    expect(result.next_actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target_skill_id: 'product.analyze' }),
        expect.objectContaining({ target_skill_id: 'ingredient.report' }),
      ]),
    );
  });
});
