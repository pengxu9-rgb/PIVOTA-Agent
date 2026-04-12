jest.mock('../../src/db', () => ({
  query: jest.fn(),
}));

jest.mock('../../src/services/productGroundingResolver', () => ({
  resolveProductRef: jest.fn(),
}));

const { query } = require('../../src/db');
const { resolveProductRef } = require('../../src/services/productGroundingResolver');
const {
  buildLikePattern,
  normalizeCandidateRow,
  auditCandidate,
  summarizeAuditRows,
} = require('../../scripts/audit_beauty_alternatives_authority');

describe('audit_beauty_alternatives_authority', () => {
  beforeEach(() => {
    query.mockReset();
    resolveProductRef.mockReset();
  });

  test('normalizes live alternative candidates into authority audit rows', () => {
    expect(
      normalizeCandidateRow({
        product: {
          brand: 'The Inkey List',
          name: 'Niacinamide Serum',
          product_type: 'Serum',
          search_aliases: ['Niacinamide Serum 10%'],
        },
      }),
    ).toEqual(
      expect.objectContaining({
        brand: 'The Inkey List',
        name: 'Niacinamide Serum',
        product_type: 'Serum',
        search_aliases: expect.arrayContaining(['Niacinamide Serum', 'Niacinamide Serum 10%']),
      }),
    );
  });

  test('buildLikePattern escapes wildcard-heavy input into a safe lowercase like pattern', () => {
    expect(buildLikePattern('SPF50+_% Serum')).toBe('%spf50+ serum%');
  });

  test('classifies missing authority when neither DB presence nor resolver hits exist', async () => {
    query.mockResolvedValue({ rows: [] });
    resolveProductRef.mockResolvedValue({
      resolved: false,
      reason: 'no_candidates',
      product_ref: null,
      metadata: { sources: [] },
    });

    const row = await auditCandidate({
      brand: 'Supergoop!',
      name: 'Glowscreen SPF 40',
      product_type: 'Sunscreen',
    });

    expect(row.classification).toBe('missing_authority');
    expect(row.miss_reason).toBe('no_internal_or_external_authority_hit');
    expect(row.query_variants[0]).toBe('Supergoop! Glowscreen SPF 40');
  });

  test('classifies present_but_unresolved when authority exists but runtime resolution still misses', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'eps_supergoop_glowscreen', external_product_id: 'ext_supergoop_glow', domain: 'supergoop.com' }],
      })
      .mockResolvedValue({ rows: [] });
    resolveProductRef.mockResolvedValue({
      resolved: false,
      reason: 'no_candidates',
      product_ref: null,
      metadata: { sources: [] },
    });

    const row = await auditCandidate({
      brand: 'Supergoop!',
      name: 'Glowscreen SPF 40',
      product_type: 'Sunscreen',
      search_aliases: ['Glow Screen SPF 40'],
    });

    expect(row.classification).toBe('present_but_unresolved');
    expect(row.first_external_match).toEqual(
      expect.objectContaining({
        hit_count: 1,
        domains: ['supergoop.com'],
      }),
    );
    expect(row.miss_reason).toBe('presence_hit_without_runtime_resolution');
  });

  test('classifies resolved external-seed hits from runtime resolver', async () => {
    query.mockResolvedValue({ rows: [] });
    resolveProductRef.mockResolvedValue({
      resolved: true,
      reason: 'resolved',
      product_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_paulas_choice_booster',
      },
      metadata: {
        sources: [{ source: 'external_seed' }],
      },
    });

    const row = await auditCandidate({
      brand: "Paula's Choice",
      name: '10% Niacinamide Booster',
      product_type: 'Serum',
    });

    expect(row.classification).toBe('external_seed_hit');
    expect(row.resolver.product_ref).toEqual({
      merchant_id: 'external_seed',
      product_id: 'ext_paulas_choice_booster',
    });
  });

  test('summarizeAuditRows groups counts by brand and classification', () => {
    expect(
      summarizeAuditRows([
        { brand: 'Skin1004', classification: 'missing_authority' },
        { brand: 'Skin1004', classification: 'present_but_unresolved' },
        { brand: 'La Roche-Posay', classification: 'internal_hit' },
      ]),
    ).toEqual(
      expect.objectContaining({
        scanned: 3,
        internal_hit: 1,
        present_but_unresolved: 1,
        missing_authority: 1,
        by_brand: {
          Skin1004: expect.objectContaining({
            scanned: 2,
            present_but_unresolved: 1,
            missing_authority: 1,
          }),
          'La Roche-Posay': expect.objectContaining({
            scanned: 1,
            internal_hit: 1,
          }),
        },
      }),
    );
  });
});
