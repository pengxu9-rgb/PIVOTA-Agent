jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [] })),
  closePool: jest.fn(async () => {}),
}));

const {
  _internals: { parseArgs, summarize },
} = require('../../scripts/backfill-external-seed-image-cache.cjs');

describe('backfill-external-seed-image-cache', () => {
  test('defaults to dry-run and parses high-risk host filters', () => {
    const args = parseArgs([
      'node',
      'script',
      '--host',
      'www.guerlain.com',
      '--market',
      'us',
      '--limit',
      '10',
      '--fetch-mode',
      'browser',
    ]);

    expect(args.apply).toBe(false);
    expect(args.dryRun).toBe(true);
    expect(args.host).toBe('www.guerlain.com');
    expect(args.market).toBe('US');
    expect(args.limit).toBe(10);
    expect(args.fetchMode).toBe('browser');
  });

  test('summarizes visible, cached, and quarantined asset outcomes', () => {
    const summary = summarize([
      {
        changed: true,
        visible_image_urls: ['https://assets.pivota.cc/a.png'],
        asset_count: 1,
        quarantine_count: 1,
        assets: [{ status: 'cached', source_host: 'www.guerlain.com' }],
        quarantine_assets: [{ status: 'stale_404', source_host: 'sdcdn.io' }],
      },
      {
        changed: false,
        visible_image_urls: ['https://cdn.shopify.com/a.jpg'],
        asset_count: 1,
        quarantine_count: 0,
        assets: [{ status: 'direct_fetch_ok', source_host: 'cdn.shopify.com' }],
        quarantine_assets: [],
      },
    ]);

    expect(summary.rows_scanned).toBe(2);
    expect(summary.rows_changed).toBe(1);
    expect(summary.visible_image_url_count).toBe(2);
    expect(summary.status_counts.cached).toBe(1);
    expect(summary.status_counts.stale_404).toBe(1);
    expect(summary.host_counts['www.guerlain.com']).toBe(1);
  });
});
