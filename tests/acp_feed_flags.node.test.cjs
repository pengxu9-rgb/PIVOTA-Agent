'use strict';

// ACP door flag decoupling: publishing the read-only feed must NEVER mount a
// money-path checkout endpoint. (feat/acp-public-feed, 2026-07-23.)

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAcpRestEnabled,
  isAcpFeedEnabled,
  isAcpPublicFeedEnabled,
  isAcpRouteEnabled,
} = require('../src/acpFeedFlags');

const CHECKOUT_HANDLERS = [
  'createCheckoutSession', 'updateCheckoutSession', 'getCheckoutSession',
  'completeCheckoutSession', 'cancelCheckoutSession',
];

test('feed flag alone mounts ONLY the feed — every checkout endpoint stays dark', () => {
  const env = { AGENT_CHECKOUT_STRICT: '1', AGENT_CHECKOUT_ACP_FEED_ENABLED: '1' };
  assert.equal(isAcpFeedEnabled(env), true);
  assert.equal(isAcpRestEnabled(env), false);
  assert.equal(isAcpRouteEnabled('productFeed', env), true);
  for (const h of CHECKOUT_HANDLERS) {
    assert.equal(isAcpRouteEnabled(h, env), false, `${h} must stay 404 under the feed-only flag`);
  }
});

test('the full checkout flag IMPLIES the feed', () => {
  const env = { AGENT_CHECKOUT_STRICT: '1', AGENT_CHECKOUT_ACP_REST_ENABLED: '1' };
  assert.equal(isAcpFeedEnabled(env), true);
  assert.equal(isAcpRouteEnabled('productFeed', env), true);
  for (const h of CHECKOUT_HANDLERS) {
    assert.equal(isAcpRouteEnabled(h, env), true);
  }
});

test('strict off keeps every route dark, even with the flags on', () => {
  const env = { AGENT_CHECKOUT_ACP_REST_ENABLED: '1', AGENT_CHECKOUT_ACP_FEED_ENABLED: '1' };
  assert.equal(isAcpRouteEnabled('productFeed', env), false);
  assert.equal(isAcpRouteEnabled('createCheckoutSession', env), false);
});

test('all flags off (default) = every route dark = byte-identical prior behavior', () => {
  const env = { AGENT_CHECKOUT_STRICT: '1' };
  assert.equal(isAcpFeedEnabled(env), false);
  assert.equal(isAcpRestEnabled(env), false);
  for (const h of ['productFeed', ...CHECKOUT_HANDLERS]) {
    assert.equal(isAcpRouteEnabled(h, env), false);
  }
});

test('public-feed flag is independent of the mount flags', () => {
  assert.equal(isAcpPublicFeedEnabled({ ACP_PUBLIC_FEED: '1' }), true);
  assert.equal(isAcpPublicFeedEnabled({ ACP_PUBLIC_FEED: 'true' }), true);
  assert.equal(isAcpPublicFeedEnabled({}), false);
  // Enabling the public feed does NOT by itself mount anything — mounting is the
  // feed/rest flags' job (a public-feed flag with no mount flag serves nothing).
  const env = { AGENT_CHECKOUT_STRICT: '1', ACP_PUBLIC_FEED: '1' };
  assert.equal(isAcpRouteEnabled('productFeed', env), false);
});

test('flag parsing accepts the documented truthy set only', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' Yes ']) {
    assert.equal(isAcpRestEnabled({ AGENT_CHECKOUT_ACP_REST_ENABLED: v }), true, v);
  }
  for (const v of ['0', 'false', '', 'off', 'no', undefined]) {
    assert.equal(isAcpRestEnabled({ AGENT_CHECKOUT_ACP_REST_ENABLED: v }), false, String(v));
  }
});
