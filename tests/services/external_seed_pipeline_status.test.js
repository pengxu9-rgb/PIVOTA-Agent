jest.mock('../../src/db', () => ({
  query: jest.fn(),
}));

jest.mock('../../src/services/pciKbClient', () => ({
  kbQuery: jest.fn(),
}));

jest.mock('../../src/services/externalSeedContentAudit', () => ({
  auditExternalSeedRow: jest.fn(() => ({ findings: [] })),
  summarizeAuditResults: jest.fn(() => ({
    by_severity: { blocker: 0, review: 0, info: 0 },
  })),
}));

jest.mock('../../src/services/externalSeedHarvesterBridge', () => ({
  buildExternalSeedHarvesterCandidates: jest.fn(() => [{ candidate_id: 'extseed:eps_bpo:US' }]),
}));

jest.mock('../../src/services/externalSeedIngredientEnrichment', () => ({
  ENRICHMENT_SOURCE: {
    kbReviewed: 'kb_reviewed',
    descriptionParse: 'description_parse',
    titleUrlAnchor: 'title_url_anchor',
    none: 'none',
  },
  classifySeedStructuredIngredientStatus: jest.fn(() => 'missing'),
  fetchReviewedKbRowsForSeedRow: jest.fn(async () => [
    {
      sku_key: 'extseed:eps_bpo:US',
      parse_status: 'OK',
      raw_ingredient_text_clean: 'Benzoyl Peroxide 10%',
      inci_list: 'Benzoyl Peroxide 10%',
    },
  ]),
  buildSeedKbSyncStatus: jest.fn(() => 'kb_only_unsynced'),
  buildRuntimeIngredientEvidenceSource: jest.fn(() => 'kb_reviewed_read_through'),
}));

const { query } = require('../../src/db');
const { kbQuery } = require('../../src/services/pciKbClient');
const { getExternalSeedPipelineStatus } = require('../../src/services/externalSeedPipelineStatus');

describe('externalSeedPipelineStatus', () => {
  beforeEach(() => {
    query.mockReset();
    kbQuery.mockReset();
  });

  test('surfaces seed-vs-KB sync mismatch and blocks false ready_for_kb_use', async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: 'eps_bpo',
          external_product_id: 'ext_bpo',
          market: 'US',
          domain: 'neutrogena.example.com',
          canonical_url: 'https://neutrogena.example.com/products/rapid-clear-stubborn-acne-spot-gel',
          destination_url: 'https://neutrogena.example.com/products/rapid-clear-stubborn-acne-spot-gel',
          title: 'Rapid Clear Stubborn Acne Spot Gel',
          image_url: '',
          price_amount: null,
          price_currency: 'USD',
          availability: 'in_stock',
          seed_data: {
            snapshot: {
              canonical_url: 'https://neutrogena.example.com/products/rapid-clear-stubborn-acne-spot-gel',
              title: 'Rapid Clear Stubborn Acne Spot Gel',
            },
          },
          updated_at: '2026-03-22T00:00:00.000Z',
          created_at: '2026-03-22T00:00:00.000Z',
        },
      ],
    });

    kbQuery.mockImplementation(async (sql) => {
      const text = String(sql || '');
      if (text.includes('to_regclass')) {
        return { rows: [{ table_name: 'pci_kb.sku_ingredients' }] };
      }
      return {
        rows: [
          {
            sku_key: 'extseed:eps_bpo:US',
            parse_status: 'OK',
            raw_ingredient_text_clean: 'Benzoyl Peroxide 10%',
            inci_list: 'Benzoyl Peroxide 10%',
          },
        ],
      };
    });

    const status = await getExternalSeedPipelineStatus({
      externalSeedId: 'eps_bpo',
    });

    expect(status.coverage).toEqual(
      expect.objectContaining({
        seed_structured_ingredient_status: 'missing',
        seed_kb_sync_status: 'kb_only_unsynced',
        runtime_ingredient_evidence_source: 'kb_reviewed_read_through',
        kb_reviewed_row_count: 1,
      }),
    );
    expect(status.gating.next_step).toBe('sync_seed_ingredient_fields');
  });
});
