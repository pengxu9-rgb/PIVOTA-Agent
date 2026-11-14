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

test('requires trusted claim-level review for both legacy and new merchant submissions', async () => {
  const evidence = {
    source_type: 'Merchant_Lab_Report',
    source_ref: 'art_1',
    substantiation_status: 'substantiated',
    evidence_grade: 'a',
    review_source_type: 'merchant_lab_report',
    review_source_url: 'https://lab.example/report',
  };
  mockQuery.mockResolvedValue({ rows: [{
    review_state: 'reviewed',
    claims: [
      { ...evidence, claim_text: 'Legacy merchant-provided grade' },
      { ...evidence, claim_text: 'Submitted', review_status: 'submitted' },
      { ...evidence, claim_text: 'Verified but no reviewer', review_status: 'verified' },
      { ...evidence, claim_text: 'Verified but no source', review_status: 'verified', reviewed_by: 'employee-1', review_source_url: ' ' },
      { ...evidence, claim_text: 'Reviewed claim', review_status: 'verified', reviewed_by: 'employee-1' },
    ],
  }] });
  const out = await fetchSubstantiatedMerchantEvidenceClaims('prod-1');
  expect(out.map((claim) => claim.claim_text)).toEqual(['Reviewed claim']);
  expect(out[0].source_refs).toEqual(['https://lab.example/report']);
  expect(out[0].source_ref).toBe('https://lab.example/report');
  expect(out[0]).not.toHaveProperty('reviewed_by');
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

test('staff-reviewed read excludes legacy non-merchant-source rows', async () => {
  mockQuery.mockResolvedValue({ rows: [{ claims: [
    { claim_text: 'Legacy claim', evidence_grade: 'a', source_type: 'clinical', substantiation_status: 'substantiated' },
    { claim_text: 'Reviewed claim', evidence_grade: 'b', source_type: 'merchant_positioning', substantiation_status: 'substantiated',
      review_status: 'verified', reviewed_by: 'staff', review_source_type: 'brand_statement', review_source_url: 'https://brand.example/label' },
  ] }] });
  const claims = await fetchSubstantiatedMerchantEvidenceClaims('prod-1', { staffReviewedOnly: true });
  expect(claims.map((claim) => claim.claim_text)).toEqual(['Reviewed claim']);
  expect(claims[0].source_refs).toEqual(['https://brand.example/label']);
});

test('staff-reviewed citations keep public variant selectors and reject private URL parts', async () => {
  const urls = ['https://brand.example/label?variant=123', 'https://brand.example/label#private',
    'https://brand.example/label?access_token=private', 'https://brand.example/label?api_key=private',
    'https://127.0.0.1/label'];
  mockQuery.mockResolvedValue({ rows: [{ claims: urls.map((review_source_url) => ({
    claim_text: 'Reviewed claim', evidence_grade: 'b', source_type: 'merchant_lab_report',
    substantiation_status: 'substantiated', review_status: 'verified', reviewed_by: 'staff',
    review_source_type: 'brand_statement', review_source_url,
  })) }] });
  const claims = await fetchSubstantiatedMerchantEvidenceClaims('prod-1', { staffReviewedOnly: true });
  expect(claims.map((claim) => claim.source_ref)).toEqual([urls[0]]);
});
