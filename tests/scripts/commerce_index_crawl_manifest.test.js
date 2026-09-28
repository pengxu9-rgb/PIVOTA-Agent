'use strict';

const { validateCrawlManifest } = require('../../src/services/commerceIndexCrawlManifest');

const now = new Date('2026-08-23T20:00:00.000Z');

function validManifest() {
  return {
    dry_run: true,
    market: 'US',
    user_agent: 'PivotaCommerceIndexBot/1.0 (+https://pivota.cc/bot)',
    source: { id: 'source_123', kind: 'public_crawl', public_crawl_policy_ref: 'policy_123' },
    limits: { per_domain_concurrency: 1, max_requests_per_domain: 10, max_retries: 1, min_delay_ms: 1000 },
    robots: {
      'shop.example': { allowed: true, checked_at: '2026-08-23T19:30:00.000Z', url: 'https://shop.example/robots.txt' },
    },
    targets: [{ kind: 'product', url: 'https://shop.example/products/cream?variant=1' }],
  };
}

test('accepts a bounded dry-run manifest with fresh per-host robots evidence', () => {
  const result = validateCrawlManifest(validManifest(), { now });

  expect(result).toMatchObject({
    ok: true,
    plan: { dryRun: true, targetCount: 1, domains: [{ hostname: 'shop.example', targetCount: 1 }] },
  });
});

test('rejects manifests that could be interpreted as live execution', () => {
  const manifest = validManifest();
  manifest.dry_run = false;

  const result = validateCrawlManifest(manifest, { now });

  expect(result.ok).toBe(false);
  expect(result.errors).toContain('dry_run must be exactly true; this gate never authorizes a live crawl.');
});

test('requires consent for merchant API and contracted-feed sources', () => {
  const manifest = validManifest();
  manifest.source = { id: 'source_123', kind: 'merchant_api' };

  const result = validateCrawlManifest(manifest, { now });

  expect(result.ok).toBe(false);
  expect(result.errors).toContain('merchant_api and contracted_feed sources require consent_ref.');
});

test('rejects stale or denied robots decisions and unsafe limits', () => {
  const manifest = validManifest();
  manifest.robots['shop.example'] = {
    allowed: false,
    checked_at: '2026-08-20T19:30:00.000Z',
    url: 'https://shop.example/robots.txt',
  };
  manifest.limits.per_domain_concurrency = 2;
  manifest.limits.max_retries = 2;

  const result = validateCrawlManifest(manifest, { now });

  expect(result.ok).toBe(false);
  expect(result.errors).toEqual(expect.arrayContaining([
    'limits.per_domain_concurrency must equal 1.',
    'limits.max_retries must be an integer from 0 to 1.',
    'robots denies shop.example.',
    'shop.example: robots.checked_at is older than 24 hours.',
  ]));
});
