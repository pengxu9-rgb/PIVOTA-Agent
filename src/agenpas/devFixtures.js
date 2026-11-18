'use strict';

/*
 * LOCAL DEVELOPMENT ONLY. Canned purchases for trying the AgenPas page without a backend.
 *
 * Armed only when AGENPAS_DEV_FIXTURES is on AND config.devFixturesAllowed() (no managed platform marker such as
 * K_SERVICE / RAILWAY_*, and no production environment name). The router checks that per request; this module
 * never reads the network and holds no state.
 *
 * Each scenario is a timeline measured from the link's issue time, so reloading the page shows the same purchase
 * moving on. Hosted page URLs point at `hosted.example` (a reserved name that resolves nowhere): add it to
 * AGENPAS_HOSTED_HOSTS to see the buttons; the purchase advances on its own whether or not the page opened.
 */

const SCENARIOS = Object.freeze({
  happy: { id: 'ap_000000000000000000000001' },
  outcome_unknown: { id: 'ap_000000000000000000000002' },
  refused: { id: 'ap_000000000000000000000003' },
  declined: { id: 'ap_000000000000000000000004' },
  unknown_state: { id: 'ap_000000000000000000000005' },
  expired: { id: 'ap_000000000000000000000006' },
  needs_address: { id: 'ap_000000000000000000000007' },
});

// needs_address: which links have given their address (dev memory only; a digest, never the address itself).
const addressGiven = new Map();
const addressKey = (claims) => `${claims.purchaseId}:${claims.iat}`;
const crypto = require('node:crypto');
const digestOf = (address) => crypto.createHash('sha256').update(JSON.stringify(address)).digest('hex');

const FIXTURE_HOST = 'hosted.example';

function scenarioForId(purchaseId) {
  return Object.keys(SCENARIOS).find((name) => SCENARIOS[name].id === purchaseId) || null;
}

function step(elapsed, timeline) {
  let current = timeline[0][1];
  for (const [at, state] of timeline) if (elapsed >= at) current = state;
  return current;
}

function base(purchaseId, state, extra = {}) {
  return {
    purchase_id: purchaseId,
    rail: 'a2a',
    executor: 'rail_managed',
    rail_purchase_id: purchaseId,
    state,
    rail_state: state,
    totals: {
      currency: 'USD', our_price_minor: 1800, quoted_total_minor: state === 'routing' || state === 'needs_payment_method' ? null : 2349,
      final_total_minor: state === 'completed' ? 2297 : null, shipping_minor: 399, tax_minor: 150,
    },
    poll_after_seconds: 3,
    detail: {
      id: purchaseId,
      state,
      merchant_domain: 'merchant.example',
      product_name: 'Sample Lip Gloss',
      variant_title: 'Rose 04',
      quantity: 1,
      currency: 'USD',
      agent_user_ref_hash: 'fixture-owner-hash-never-projected',
      consent_version: 'fixture-terms',
    },
    ...extra,
  };
}

// A fixed deadline per link (30 min after issue), as a real rail page has: the body only changes when the state does.
function action(kind, issuedAtSeconds) {
  return {
    type: 'open_url', kind, url: `https://${FIXTURE_HOST}/${kind}?session=fixture`,
    expires_at: new Date((issuedAtSeconds + 30 * 60) * 1000).toISOString(),
  };
}

/** The fixture body for a verified link, or null for an id with no scenario. */
function fixturePurchase(claims, { now } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.now();
  const name = scenarioForId(claims && claims.purchaseId);
  if (!name) return null;
  const id = claims.purchaseId;
  const elapsed = Math.max(0, nowMs / 1000 - claims.iat);
  switch (name) {
    case 'happy': {
      const state = step(elapsed, [[0, 'routing'], [3, 'needs_payment_method'], [25, 'locking'], [30, 'awaiting_buyer_authorization'], [50, 'placing'], [56, 'completed']]);
      if (state === 'needs_payment_method') return base(id, state, { next_action: action('card_binding', claims.iat) });
      if (state === 'awaiting_buyer_authorization') return base(id, state, { next_action: action('approval', claims.iat) });
      if (state === 'completed') {
        const body = base(id, state, { order_reference: '#1001', poll_after_seconds: null });
        body.detail.merchant_order_status_url = 'https://merchant.example/orders/1001';
        return body;
      }
      return base(id, state);
    }
    case 'outcome_unknown': {
      const state = step(elapsed, [[0, 'placing'], [6, 'failed']]);
      const body = base(id, state, state === 'failed' ? { poll_after_seconds: null } : {});
      if (state === 'failed') body.detail.last_error_code = 'vic_order_outcome_unknown';
      return body;
    }
    case 'refused': {
      const body = base(id, 'refused', { poll_after_seconds: null });
      body.detail.refusal_reason = 'merchant_not_purchasable';
      return body;
    }
    case 'declined': {
      const state = step(elapsed, [[0, 'awaiting_buyer_authorization'], [15, 'failed']]);
      if (state === 'awaiting_buyer_authorization') return base(id, state, { next_action: action('approval', claims.iat) });
      const body = base(id, state, { poll_after_seconds: null });
      body.detail.last_error_code = 'vic_authorization_declined';
      return body;
    }
    case 'unknown_state':
      return base(id, 'some_future_state');
    case 'expired':
      return base(id, 'expired', { poll_after_seconds: null });
    case 'needs_address': {
      const given = addressGiven.get(addressKey(claims));
      if (!given) {
        return base(id, 'routing', {
          next_action: {
            kind: 'shipping_address', fields_missing: ['email', 'firstName', 'lastName', 'phone', 'addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'country'],
            expires_at: new Date((claims.iat + 30 * 60) * 1000).toISOString(), prefill: { country: 'US' },
          },
        });
      }
      const since = Math.max(0, nowMs / 1000 - given.at);
      const state = step(since, [[0, 'needs_payment_method'], [20, 'completed']]);
      if (state === 'completed') return base(id, state, { order_reference: '#1002', poll_after_seconds: null });
      return base(id, state, { next_action: action('card_binding', claims.iat) });
    }
    default:
      return null;
  }
}

function createFixturePurchaseReader({ now } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  return Object.freeze({
    async read(claims) {
      const purchase = fixturePurchase(claims, { now: clock() });
      return purchase ? { kind: 'accepted', purchase } : { kind: 'not_found' };
    },
    // Same answers as the backend's address write: the same address again is fine, another one is a 409.
    async submitShippingAddress(claims, address) {
      if (scenarioForId(claims && claims.purchaseId) !== 'needs_address') return { kind: 'conflict' };
      const key = addressKey(claims);
      const digest = digestOf(address);
      const given = addressGiven.get(key);
      if (given && given.digest !== digest) return { kind: 'conflict' };
      if (!given) addressGiven.set(key, { digest, at: clock() / 1000 });
      return { kind: 'accepted', purchase: fixturePurchase(claims, { now: clock() }) };
    },
  });
}

module.exports = {
  FIXTURE_HOST,
  SCENARIOS,
  createFixturePurchaseReader,
  fixturePurchase,
};
