'use strict';

// db/merchantEvidence: read substantiated merchant evidence from the shared
// product_evidence store. Best-effort by contract — every miss/error path → [].

const mockQuery = jest.fn();
jest.mock('../src/db/index', () => ({ query: (...args) => mockQuery(...args) }));

const { fetchSubstantiatedMerchantEvidenceClaims } = require('../src/db/merchantEvidence');

beforeEach(() => mockQuery.mockReset());

test('returns only substantiated claims (drops unverified/blank)', async () => {
  mockQuery.mockResolvedValue({
    rows: [
      {
        claims: [
          { claim_text: 'SPF 30 verified', substantiation_status: 'substantiated', evidence_grade: 'a' },
          { claim_text: 'Positioning blurb', substantiation_status: 'unverified' },
          { claim_text: '', substantiation_status: 'substantiated' },
        ],
      },
    ],
  });
  const out = await fetchSubstantiatedMerchantEvidenceClaims('prod-1');
  expect(out.map((c) => c.claim_text)).toEqual(['SPF 30 verified']);
});

test('parses a JSON-string claims column (JSONB-as-string under some drivers)', async () => {
  mockQuery.mockResolvedValue({
    rows: [{ claims: JSON.stringify([{ claim_text: 'X', substantiation_status: 'substantiated' }]) }],
  });
  const out = await fetchSubstantiatedMerchantEvidenceClaims('prod-1');
  expect(out).toHaveLength(1);
});

test('empty / missing key / no rows / query error all yield []', async () => {
  expect(await fetchSubstantiatedMerchantEvidenceClaims('')).toEqual([]);
  expect(await fetchSubstantiatedMerchantEvidenceClaims(null)).toEqual([]);

  mockQuery.mockResolvedValue({ rows: [] });
  expect(await fetchSubstantiatedMerchantEvidenceClaims('prod-1')).toEqual([]);

  mockQuery.mockRejectedValue(new Error('relation "product_evidence" does not exist'));
  expect(await fetchSubstantiatedMerchantEvidenceClaims('prod-1')).toEqual([]);
});

test('queries product_evidence by product_key + default geo', async () => {
  mockQuery.mockResolvedValue({ rows: [] });
  await fetchSubstantiatedMerchantEvidenceClaims('prod-9');
  const [sql, params] = mockQuery.mock.calls[0];
  expect(sql).toMatch(/product_evidence/);
  expect(params).toEqual(['prod-9', 'default']);
});
