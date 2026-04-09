const {
  buildEndpoint,
  buildInvokeBody,
  buildOutcomeKey,
  normalizeWatchCase,
  summarizeByBucket,
  summarizeByCase,
} = require('../../scripts/pdp_pressure_watch');

describe('pdp_pressure_watch helpers', () => {
  it('normalizes watch cases with empty include by default', () => {
    expect(
      normalizeWatchCase(
        {
          id: 'watch_ext6',
          bucket: 'pressure_watch_ext',
          product_id: 'ext_seed_1',
        },
        0,
      ),
    ).toEqual(
      expect.objectContaining({
        id: 'watch_ext6',
        bucket: 'pressure_watch_ext',
        product_id: 'ext_seed_1',
        include: [],
      }),
    );
  });

  it('builds get_pdp_v2 invoke bodies with empty include arrays', () => {
    expect(
      buildInvokeBody(
        {
          product_id: 'ext_seed_1',
          merchant_id: 'external_seed',
          include: [],
        },
        true,
      ),
    ).toEqual(
      expect.objectContaining({
        operation: 'get_pdp_v2',
        payload: expect.objectContaining({
          product_ref: {
            product_id: 'ext_seed_1',
            merchant_id: 'external_seed',
          },
          include: [],
          options: { cache_bypass: true },
        }),
      }),
    );
  });

  it('builds stable outcome keys for transport and status results', () => {
    expect(buildOutcomeKey({ transport_error: 'ECONNABORTED' })).toBe('transport:ECONNABORTED');
    expect(buildOutcomeKey({ status: 404, reason_code: 'PRODUCT_NOT_FOUND', transport_error: null })).toBe(
      'status:404|reason:PRODUCT_NOT_FOUND',
    );
  });

  it('builds same-origin and absolute endpoints safely', () => {
    expect(buildEndpoint('https://agent.pivota.cc/', '/api/gateway')).toBe(
      'https://agent.pivota.cc/api/gateway',
    );
    expect(buildEndpoint('https://agent.pivota.cc', 'https://edge.example.com/invoke')).toBe(
      'https://edge.example.com/invoke',
    );
  });

  it('summarizes per-case flap state across mixed outcomes', () => {
    expect(
      summarizeByCase([
        {
          id: 'watch_ext6',
          bucket: 'pressure_watch_ext',
          status: 200,
          reason_code: null,
          transport_error: null,
          latency_ms: 120,
          outcome_key: 'status:200|reason:-',
        },
        {
          id: 'watch_ext6',
          bucket: 'pressure_watch_ext',
          status: null,
          reason_code: null,
          transport_error: 'ECONNABORTED',
          latency_ms: 8000,
          outcome_key: 'transport:ECONNABORTED',
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: 'watch_ext6',
        total: 2,
        distinct_outcomes: 2,
        flapped: true,
        statuses: { 200: 1, null: 1 },
        transport_errors: { ECONNABORTED: 1 },
      }),
    ]);
  });

  it('summarizes bucket-level status and transport distributions', () => {
    expect(
      summarizeByBucket([
        {
          id: 'watch_ext6',
          bucket: 'pressure_watch_ext',
          status: 200,
          reason_code: null,
          transport_error: null,
          latency_ms: 110,
          outcome_key: 'status:200|reason:-',
        },
        {
          id: 'watch_ext3a',
          bucket: 'pressure_watch_ext',
          status: 502,
          reason_code: null,
          transport_error: null,
          latency_ms: 700,
          outcome_key: 'status:502|reason:-',
        },
        {
          id: 'watch_ext3a',
          bucket: 'pressure_watch_ext',
          status: null,
          reason_code: null,
          transport_error: 'ECONNABORTED',
          latency_ms: 8000,
          outcome_key: 'transport:ECONNABORTED',
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        bucket: 'pressure_watch_ext',
        total: 3,
        distinct_outcomes: 3,
        flapped: true,
        statuses: { 200: 1, 502: 1, null: 1 },
        transport_errors: { ECONNABORTED: 1 },
      }),
    ]);
  });
});
