jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({
    rows: [
      {
        id: 42,
        status: 'queued',
        mode: 'apply',
        filters: { product_id: 'ext_123' },
        requested_by: 'test',
        created_at: '2026-05-06T00:00:00.000Z',
      },
    ],
  })),
  closePool: jest.fn(async () => {}),
}));

const db = require('../../src/db');
const {
  _internals: { enqueueImageCacheJob, parseArgs },
} = require('../../scripts/enqueue-external-seed-image-cache-job.cjs');

describe('enqueue-external-seed-image-cache-job', () => {
  test('parses product scoped enqueue args', () => {
    const args = parseArgs([
      'node',
      'script',
      '--product-id',
      'ext_123',
      '--market',
      'us',
      '--limit',
      '25',
      '--fetch-mode',
      'auto',
      '--force-cache',
      '--requested-by',
      'test',
    ]);

    expect(args).toEqual(
      expect.objectContaining({
        productId: 'ext_123',
        market: 'US',
        limit: 25,
        fetchMode: 'auto',
        forceCache: true,
        requestedBy: 'test',
      }),
    );
  });

  test('enqueues a DB job with normalized filters', async () => {
    await enqueueImageCacheJob({
      productId: 'ext_123',
      market: 'US',
      limit: 1,
      offset: 0,
      fetchMode: 'auto',
      forceCache: true,
      requestedBy: 'test',
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO external_seed_image_cache_jobs'),
      [
        JSON.stringify({
          product_id: 'ext_123',
          market: 'US',
          limit: 1,
          offset: 0,
          fetch_mode: 'auto',
          force_cache: true,
        }),
        'test',
      ],
    );
  });
});
