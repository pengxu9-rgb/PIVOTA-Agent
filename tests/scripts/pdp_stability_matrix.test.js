const {
  buildEndpoint,
  buildInvokeBody,
  evaluateCase,
  normalizeCase,
  summarizeResults,
} = require('../../scripts/pdp_stability_matrix');
const { DEFAULT_PUBLIC_ENDPOINT } = require('../../scripts/lib/commerce_invoke_contract');

describe('pdp_stability_matrix helpers', () => {
  it('normalizes raw cases into stable probe definitions', () => {
    expect(
      normalizeCase(
        {
          id: 'ext_wrong_merchant',
          bucket: 'merchant_mismatch',
          product_id: 'ext_seed_1',
          merchant_id: 'merch_wrong',
          expect_status: 200,
          expect_reason_codes: ['PRODUCT_ROUTE_MERCHANT_MISMATCH'],
          expect_resolved_merchant_id: 'external_seed',
          expect_canonicalization_applied: true,
        },
        0,
      ),
    ).toEqual(
      expect.objectContaining({
        id: 'ext_wrong_merchant',
        bucket: 'merchant_mismatch',
        product_id: 'ext_seed_1',
        merchant_id: 'merch_wrong',
        include: ['offers', 'reviews_preview', 'similar'],
        expect_status: 200,
        expect_reason_codes: ['PRODUCT_ROUTE_MERCHANT_MISMATCH'],
        expect_resolved_merchant_id: 'external_seed',
        expect_canonicalization_applied: true,
      }),
    );
  });

  it('builds same-origin and absolute endpoints safely', () => {
    expect(buildEndpoint('https://agent.pivota.cc/', DEFAULT_PUBLIC_ENDPOINT)).toBe(
      `https://agent.pivota.cc${DEFAULT_PUBLIC_ENDPOINT}`,
    );
    expect(buildEndpoint('https://agent.pivota.cc', 'https://edge.example.com/invoke')).toBe(
      'https://edge.example.com/invoke',
    );
  });

  it('builds get_pdp_v2 invoke bodies with cache bypass when requested', () => {
    expect(
      buildInvokeBody(
        {
          product_id: 'ext_seed_1',
          merchant_id: 'merch_wrong',
          include: ['offers', 'similar'],
        },
        true,
      ),
    ).toEqual(
      expect.objectContaining({
        operation: 'get_pdp_v2',
        payload: expect.objectContaining({
          product_ref: {
            product_id: 'ext_seed_1',
            merchant_id: 'merch_wrong',
          },
          include: ['offers', 'similar'],
          options: { cache_bypass: true },
        }),
      }),
    );
  });

  it('evaluates expected canonicalization signals and status codes', () => {
    const evaluation = evaluateCase(
      {
        expect_status: 200,
        expect_reason_codes: ['PRODUCT_ROUTE_MERCHANT_MISMATCH'],
        expect_resolved_merchant_id: 'external_seed',
        expect_canonicalization_applied: true,
      },
      {
        status: 200,
        reason_code: 'PRODUCT_ROUTE_MERCHANT_MISMATCH',
        identity_resolution: {
          resolved_merchant_id: 'external_seed',
          canonicalization_applied: true,
        },
      },
    );

    expect(evaluation).toEqual({ passed: true, failures: [] });
  });

  it('evaluates expected transport errors for timeout canaries', () => {
    const evaluation = evaluateCase(
      {
        expect_status: null,
        expect_reason_codes: [],
        expect_resolved_merchant_id: null,
        expect_canonicalization_applied: null,
        expect_transport_error: 'ECONNABORTED',
      },
      {
        status: null,
        reason_code: null,
        identity_resolution: null,
        transport_error: 'ECONNABORTED',
      },
    );

    expect(evaluation).toEqual({ passed: true, failures: [] });
  });

  it('summarizes bucket pass rates and latency percentiles', () => {
    expect(
      summarizeResults([
        {
          bucket: 'merchant_mismatch',
          status: 200,
          reason_code: 'PRODUCT_ROUTE_MERCHANT_MISMATCH',
          latency_ms: 120,
          passed: true,
        },
        {
          bucket: 'merchant_mismatch',
          status: 200,
          reason_code: 'PRODUCT_ROUTE_MERCHANT_MISMATCH',
          latency_ms: 180,
          passed: false,
        },
        {
          bucket: 'not_found',
          status: 404,
          reason_code: 'PRODUCT_NOT_FOUND',
          latency_ms: 90,
          passed: true,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        bucket: 'merchant_mismatch',
        total: 2,
        passed: 1,
        failed: 1,
        statuses: { 200: 2 },
        reason_codes: { PRODUCT_ROUTE_MERCHANT_MISMATCH: 2 },
      }),
      expect.objectContaining({
        bucket: 'not_found',
        total: 1,
        passed: 1,
        failed: 0,
        statuses: { 404: 1 },
        reason_codes: { PRODUCT_NOT_FOUND: 1 },
      }),
    ]);
  });
});
