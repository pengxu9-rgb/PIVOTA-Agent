'use strict';

const {
  classifyCheckoutPage,
  detectStorefrontPlatform,
  dismissBlockingDialogs,
  fillSyntheticAddress,
  httpsUrl,
  journeySteps,
  platformFromGenerator,
  sanitizeSearchQuery,
  validatePublicBrowserUrl,
} = require('../src/services/commerceStorefrontAudit');

function visibleLocator(overrides = {}) {
  return {
    count: jest.fn(async () => 1),
    isVisible: jest.fn(async () => true),
    first() { return this; },
    ...overrides,
  };
}

test('recognizes Cafe24 pre-address security challenge without retaining its URL', () => {
  expect(classifyCheckoutPage({
    url: 'https://veritas-hub.cafe24.com/challenge',
    text: 'For a secure experience, please check your access.',
  })).toEqual({ status: 'security_challenged_pre_address', challenge_stage: 'pre_address' });
});

test('recognizes a guest checkout route and supported platform metadata', () => {
  expect(classifyCheckoutPage({ url: 'https://merchant.example/order/orderform.html', text: '' }))
    .toEqual({ status: 'guest_route_detected' });
  expect(platformFromGenerator('Cafe24')).toEqual({ platform: 'cafe24', checkout_provider: 'cafe24' });
});

test('detects a custom Cafe24 theme without a generator meta tag', async () => {
  const page = {
    locator: jest.fn((selector) => {
      if (selector === 'meta[name="generator"]') {
        return {
          first() { return this; },
          getAttribute: jest.fn(async () => null),
        };
      }
      return { count: jest.fn(async () => 1) };
    }),
  };

  await expect(detectStorefrontPlatform(page)).resolves.toEqual({
    platform: 'cafe24', checkout_provider: 'cafe24',
  });
});

test('accepts only non-sensitive canonical storefront targets', () => {
  expect(httpsUrl('https://merchant.example/product/a')).toBe('https://merchant.example/product/a');
  expect(httpsUrl('https://merchant.example/product/a?token=secret')).toBeNull();
  expect(httpsUrl('http://merchant.example/product/a')).toBeNull();
  expect(httpsUrl('https://127.0.0.1/product/a')).toBeNull();
});

test('blocks private DNS targets and validates redirect destinations before browser navigation', async () => {
  await expect(validatePublicBrowserUrl('https://merchant.example/a', {
    validateUrl: async () => ({ ok: false }),
  })).resolves.toEqual({ ok: false });
  await expect(validatePublicBrowserUrl('https://127.0.0.1/a')).resolves.toEqual({ ok: false });
});

test('builds a complete six-step journey without retaining page content', () => {
  expect(sanitizeSearchQuery('Hero Serum — JudyDoll')).toBe('Hero Serum');
  expect(journeySteps({
    storefront_access: { status: 'passed', reason: 'storefront_loaded' },
  })).toEqual([
    { step: 'storefront_access', status: 'passed', reason: 'storefront_loaded' },
    { step: 'product_search', status: 'not_run', reason: 'not_attempted' },
    { step: 'product_detail', status: 'not_run', reason: 'not_attempted' },
    { step: 'add_to_cart', status: 'not_run', reason: 'not_attempted' },
    { step: 'shipping_address', status: 'not_run', reason: 'not_attempted' },
    { step: 'checkout', status: 'not_run', reason: 'not_attempted' },
  ]);
});

test('dismisses a blocking marketing dialog before storefront search', async () => {
  const close = visibleLocator({ click: jest.fn(async () => {}) });
  const dialog = visibleLocator({
    nth() { return this; },
    getByRole: jest.fn(() => close),
    locator: jest.fn(() => visibleLocator({ count: jest.fn(async () => 0) })),
  });
  dialog.count = jest.fn(async () => 1);
  const page = {
    getByRole: jest.fn(() => dialog),
    waitForTimeout: jest.fn(async () => {}),
  };

  await dismissBlockingDialogs(page);

  expect(close.click).toHaveBeenCalledWith({ timeout: 1500 });
});

test('selects country before filling the rebuilt checkout address form', async () => {
  const events = [];
  let countrySelected = false;
  const absent = () => visibleLocator({ count: jest.fn(async () => 0) });
  const fillable = (name) => visibleLocator({
    fill: jest.fn(async () => {
      if (name === 'address' && !countrySelected) throw new Error('stale address form');
      events.push(name);
    }),
  });
  const country = visibleLocator({
    selectOption: jest.fn(async () => { countrySelected = true; events.push('country'); }),
  });
  const state = visibleLocator({ selectOption: jest.fn(async () => { events.push('state'); }) });
  const locators = new Map([
    ['select[name*="country" i]', country],
    ['select[name*="zone" i]', state],
    ['input[type="email"]', fillable('email')],
    ['input[name*="first" i]', fillable('first')],
    ['input[name*="last" i]', fillable('last')],
    ['input[name*="address1" i]', fillable('address')],
    ['input[name*="city" i]', fillable('city')],
    ['input[name*="zip" i]', fillable('postal')],
  ]);
  const page = {
    locator: jest.fn((selector) => locators.get(selector) || absent()),
    waitForTimeout: jest.fn(async () => {}),
  };

  await expect(fillSyntheticAddress(page)).resolves.toEqual({
    status: 'passed', reason: 'address_fields_filled',
  });
  expect(events[0]).toBe('country');
  expect(events.indexOf('address')).toBeGreaterThan(events.indexOf('country'));
  expect(events).toContain('state');
});

test('does not report address readiness when a visible field rejects input', async () => {
  const absent = () => visibleLocator({ count: jest.fn(async () => 0) });
  const ok = visibleLocator({ fill: jest.fn(async () => {}) });
  const rejectedAddress = visibleLocator({ fill: jest.fn(async () => { throw new Error('detached'); }) });
  const locators = new Map([
    ['input[type="email"]', ok],
    ['input[name*="first" i]', ok],
    ['input[name*="last" i]', ok],
    ['input[name*="address1" i]', rejectedAddress],
    ['input[name*="city" i]', ok],
    ['input[name*="zip" i]', ok],
  ]);
  const page = {
    locator: jest.fn((selector) => locators.get(selector) || absent()),
    waitForTimeout: jest.fn(async () => {}),
  };

  await expect(fillSyntheticAddress(page)).resolves.toEqual({
    status: 'not_supported', reason: 'address_form_unavailable',
  });
});
