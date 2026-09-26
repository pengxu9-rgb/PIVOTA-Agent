'use strict';

const { candidateLinks, createPublicWebEvidenceNavigator, normalizeTargets, robotsAllows } = require('../src/services/publicWebEvidenceNavigator');

test('requires explicit evidence-only, robots-checked HTTPS targets', () => {
  expect(normalizeTargets([{ merchant_id: 'm1', base_url: 'https://shop.example', crawl_policy: { evidence_only: true, robots_checked: true } }])).toHaveLength(1);
  expect(normalizeTargets([{ merchant_id: 'm1', base_url: 'https://shop.example?token=x', crawl_policy: { evidence_only: true, robots_checked: true } }])).toHaveLength(0);
});

test('uses the most specific robots rule and blocks an unknown agent group', () => {
  expect(robotsAllows('User-agent: *\nDisallow: /checkout\nAllow: /', 'PivotaCommerceIndexBot/0.1', new URL('https://shop.example/'))).toBe(true);
  expect(robotsAllows('User-agent: *\nDisallow: /', 'PivotaCommerceIndexBot/0.1', new URL('https://shop.example/'))).toBe(false);
  expect(robotsAllows('User-agent: Googlebot\nAllow: /', 'PivotaCommerceIndexBot/0.1', new URL('https://shop.example/'))).toBe(false);
});

test('keeps only same-host policy/review links and never accepts commerce paths', () => {
  expect(candidateLinks([
    { href: 'https://shop.example/pages/returns', text: 'Returns' },
    { href: 'https://shop.example/reviews', text: 'Customer Reviews' },
    { href: 'https://shop.example/pages/privacy-policy', text: 'Privacy Policy' },
    { href: 'https://shop.example/products/a', text: 'Return product' },
    { href: 'https://evil.example/returns', text: 'Returns' },
  ], new Set(['shop.example']))).toEqual({
    return_policy: [{ url: 'https://shop.example/pages/returns', label: 'Returns' }],
    after_sales_reviews: [{ url: 'https://shop.example/reviews', label: 'Customer Reviews' }],
  });
});

test('follows one validated same-host robots redirect before browser launch', async () => {
  const launch = jest.fn().mockResolvedValue({ close: async () => {} });
  const context = { route: async () => {}, newPage: async () => ({ goto: async () => {}, waitForTimeout: async () => {}, locator: () => ({ evaluateAll: async () => [] }) }) };
  launch.mockResolvedValue({ newContext: async () => context, close: async () => {} });
  const fetchImpl = jest.fn()
    .mockResolvedValueOnce({ status: 301, headers: { get: () => 'https://www.shop.example/robots.txt' } })
    .mockResolvedValueOnce({ status: 200, text: async () => 'User-agent: *\nAllow: /' });
  const navigator = createPublicWebEvidenceNavigator({ playwright: { chromium: { launch } }, validateUrl: async () => ({ ok: true }), fetchImpl, connectProxyFactory: () => ({ start: async () => ({}), close: async () => {} }) });
  const result = await navigator.discover({ targets: [{ merchant_id: 'm1', base_url: 'https://shop.example', crawl_policy: { evidence_only: true, robots_checked: true } }] });
  expect(result.results[0].robots).toMatchObject({ decision: 'allowed', url: 'https://www.shop.example/robots.txt' });
  expect(launch).toHaveBeenCalled();
});

test('does not launch a browser when robots denies the target', async () => {
  const launch = jest.fn();
  const navigator = createPublicWebEvidenceNavigator({
    playwright: { chromium: { launch } }, validateUrl: async () => ({ ok: true }),
    fetchImpl: async () => ({ status: 200, text: async () => 'User-agent: *\nDisallow: /' }),
  });
  const result = await navigator.discover({ targets: [{ merchant_id: 'm1', base_url: 'https://shop.example', crawl_policy: { evidence_only: true, robots_checked: true } }] });
  expect(result.results[0].robots.decision).toBe('disallowed_or_unverified');
  expect(launch).not.toHaveBeenCalled();
});
