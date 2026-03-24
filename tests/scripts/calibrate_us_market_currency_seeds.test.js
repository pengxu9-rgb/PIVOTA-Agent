const {
  _internals: { classifyCalibrationAction, summarize },
} = require('../../scripts/calibrate_us_market_currency_seeds.cjs');

describe('calibrate_us_market_currency_seeds', () => {
  test('classifies live USD probe as refresh_to_usd', () => {
    const decision = classifyCalibrationAction(
      { price_currency: 'EUR' },
      {
        status: 'dry_run',
        payload: {
          nextRow: {
            price_currency: 'USD',
            seed_data: {
              snapshot: {
                variants: [{ currency: 'USD' }, { currency: 'USD' }],
              },
            },
          },
        },
      },
    );

    expect(decision).toMatchObject({
      action: 'refresh_to_usd',
      row_currency: 'EUR',
      live_currency: 'USD',
      variant_currencies: ['USD'],
    });
  });

  test('classifies live non-USD probe as quarantine_inactive', () => {
    const decision = classifyCalibrationAction(
      { price_currency: 'EUR' },
      {
        status: 'dry_run',
        payload: {
          nextRow: {
            price_currency: 'EUR',
            seed_data: {
              snapshot: {
                variants: [{ currency: 'EUR' }],
              },
            },
          },
        },
      },
    );

    expect(decision).toMatchObject({
      action: 'quarantine_inactive',
      row_currency: 'EUR',
      live_currency: 'EUR',
      variant_currencies: ['EUR'],
    });
  });

  test('summarizes results by action and domain', () => {
    const summary = summarize(
      [
        {
          domain: 'patyka.com',
          decision: { action: 'quarantine_inactive' },
          apply_status: 'quarantined',
        },
        {
          domain: 'skintific.com',
          decision: { action: 'refresh_to_usd' },
          apply_status: 'updated',
        },
        {
          domain: 'patyka.com',
          decision: { action: 'probe_failed' },
          apply_status: 'failed',
        },
      ],
      { dryRun: false },
    );

    expect(summary).toMatchObject({
      mode: 'apply',
      scanned: 3,
      refresh_to_usd: 1,
      quarantine_inactive: 1,
      probe_failed: 1,
      updated: 1,
      quarantined: 1,
      failed: 1,
    });
    expect(summary.by_domain['patyka.com']).toMatchObject({
      scanned: 2,
      quarantine_inactive: 1,
      probe_failed: 1,
      quarantined: 1,
      failed: 1,
    });
  });
});
