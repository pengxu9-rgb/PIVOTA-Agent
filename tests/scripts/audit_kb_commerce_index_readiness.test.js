const {
  _internals: {
    buildEligibleSourceKeys,
    buildInventoryRows,
    recommendedLane,
    summarizeInventory,
    terminalHoldStatus,
  },
} = require('../../scripts/audit-kb-commerce-index-readiness.cjs');

describe('audit-kb-commerce-index-readiness terminal holds', () => {
  test('classifies source-unavailable rows as terminal holds before seed fact gaps', () => {
    const rows = buildInventoryRows({
      seedRows: [
        {
          id: 'eps_source_unavailable',
          external_product_id: 'ext_source_unavailable',
          market: 'US',
          domain: 'sigmabeauty.com',
          title: 'Discontinued Brush Set',
          canonical_url: 'https://sigmabeauty.com/products/discontinued-brush-set',
          seed_data: {
            source_unavailable_v1: {
              contract_version: 'external_seed.source_unavailable.v1',
              status: 'source_unavailable',
              reason: 'official_source_404_no_product_urls',
            },
          },
        },
      ],
      readinessByProductId: new Map(),
      identityByProductId: new Map(),
      kbByProductId: new Map(),
      catalogByProductKey: new Map(),
      offerByProductKey: new Map(),
      indexByContentKey: new Map(),
      docBySourceRef: new Map(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].seed_missing_fields).toContain('price');
    expect(rows[0].terminal_hold).toBe(true);
    expect(rows[0].terminal_hold_reason).toBe('official_source_404_no_product_urls');
    expect(rows[0].main_blocker).toBe('terminal_hold');
    expect(rows[0].recommended_lane).toBe('terminal_hold_no_action');
    expect(rows[0].next_command).toBe('');
  });

  test('classifies non-merch product family rows as terminal holds', () => {
    expect(
      terminalHoldStatus({
        title: 'Sigma Beauty E-Gift Card',
        seed_data: {
          product_family: 'non_merch',
        },
      }),
    ).toEqual({
      held: true,
      reason: 'non_merch_product_family',
    });
    expect(recommendedLane('terminal_hold')).toBe('terminal_hold_no_action');
  });

  test('classifies content evidence holds as terminal holds without requiring transaction blockers', () => {
    expect(
      terminalHoldStatus({
        title: 'Caramel Apple Eyeshadow Quad',
        seed_data: {
          content_evidence_hold_v1: {
            contract_version: 'external_seed.content_evidence_hold.v1',
            status: 'hold_for_evidence',
            reason: 'official_source_missing_editorial_content',
            public_serving_ready: false,
          },
        },
      }),
    ).toEqual({
      held: true,
      reason: 'official_source_missing_editorial_content',
    });
  });

  test('reports actionable readiness rate separately from terminal holds', () => {
    const summary = summarizeInventory(
      [
        { main_blocker: 'db_serving_ready' },
        { main_blocker: 'seed_content_blocked' },
        { main_blocker: 'terminal_hold' },
      ],
      [],
      [],
      [],
      [],
    );

    expect(summary.scanned_rows).toBe(3);
    expect(summary.terminal_hold_rows).toBe(1);
    expect(summary.action_required_rows).toBe(1);
    expect(summary.db_serving_ready_rate).toBe(0.3333);
    expect(summary.db_serving_ready_rate_excluding_terminal_holds).toBe(0.5);
    expect(summary.lane_breakdown).toEqual(
      expect.arrayContaining([
        { key: 'ready_no_action', count: 1 },
        { key: 'lane_2_seed_commerce_facts', count: 1 },
        { key: 'terminal_hold_no_action', count: 1 },
      ]),
    );
  });

  test('builds catalog-serving eligibility keys from attached catalog IPS state', () => {
    const keys = buildEligibleSourceKeys({
      seedRows: [
        {
          external_product_id: 'ext_ready',
          attached_product_key: 'product_ready',
        },
        {
          external_product_id: 'ext_shadow',
          attached_product_key: 'product_shadow',
        },
      ],
      catalogByProductKey: new Map([
        ['product_ready', { content_key: 'ck_ready' }],
        ['product_shadow', { content_key: 'ck_shadow' }],
      ]),
      indexByContentKey: new Map([
        ['ck_ready', { serving_eligible: true }],
        ['ck_shadow', { serving_eligible: false }],
      ]),
    });

    expect(Array.from(keys)).toEqual(['external_seed::ext_ready']);
  });
});
