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
  // A Reap-rail purchase behind the consent step (AGENPAS_CONSENT_ENABLED and AGENPAS_RAILS=a2a,reap): the card page
  // and then the approval page appear only after the buyer accepts the terms on the page.
  consent: { id: 'rp_000000000000000000000007' },
  // An A2A purchase whose address form is consent-gated (AGENPAS_CONSENT_ENABLED and AGENPAS_COLLECT_SHIPPING): the
  // terms first, then the form, then the card step.
  address_consent: { id: 'ap_000000000000000000000008' },
  // An A2A returning buyer with two saved cards (AGENPAS_CARD_PICKER_ENABLED and AGENPAS_CONSENT_ENABLED): the order is
  // locked and waits; the approval terms first, then the buyer approves with the newest card or picks the other; then
  // the approval page, then the order.
  card_choice: { id: 'ap_000000000000000000000009' },
});

// card_choice: which card each link confirmed, and when (dev memory only).
const cardConfirmed = new Map();
const FIXTURE_CARDS = Object.freeze([
  Object.freeze({ id: 'fixture_card_newest', network: 'visa', last4: '4242', added_at: '2026-11-20T00:00:00Z' }),
  Object.freeze({ id: 'fixture_card_older', network: 'visa', last4: '1881', added_at: '2026-10-02T00:00:00Z' }),
]);
// The card a buyer adds from "Add a new card" (dev only).
const FIXTURE_NEW_CARD = Object.freeze({ id: 'fixture_card_new', network: 'visa', last4: '7777' });
const fixtureCardHandle = (purchaseId, cardId) => crypto.createHash('sha256').update(`fixture:${purchaseId}:${cardId}`).digest('hex').slice(0, 24);

// needs_address: which links have given their address (dev memory only; a digest, never the address itself).
const addressGiven = new Map();
const addressKey = (claims) => `${claims.purchaseId}:${claims.iat}`;
const crypto = require('node:crypto');
const digestOf = (address) => crypto.createHash('sha256').update(JSON.stringify(address)).digest('hex');

// The fixture's legal pages: Pivota's own host (the AGENPAS_LEGAL_HOSTS default), so the links show without config.
const FIXTURE_TERMS_URL = 'https://pivota.cc/terms';
const FIXTURE_PRIVACY_URL = 'https://pivota.cc/privacy';

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

function isoSeconds(ms) {
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

// The consent scenario: needs_payment_method until the card consent, then the card page for 10 s, then locking with
// the approval consent offered, then (once accepted) the approval page for 10 s, then placing and completed.
function fixtureConsentBlock(step, satisfied, nowMs) {
  return {
    required: true, available: true, step, satisfied,
    terms_url: FIXTURE_TERMS_URL, privacy_url: FIXTURE_PRIVACY_URL, terms_version: 'fixture-terms-1', privacy_version: 'fixture-privacy-1',
    ...(satisfied ? {} : { offer: { id: 'fixtureoffer0000000000000001', issued_at: isoSeconds(nowMs) } }),
  };
}

const ALL_ADDRESS_FIELDS = Object.freeze(['email', 'firstName', 'lastName', 'phone', 'addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'country']);

// The address_consent scenario, as the backend's gate answers: the step marked and no field list until the
// shipping_address consent, then the form, then (once the address is given) the card step and completed.
function addressConsentPurchase(id, claims, accepted, nowMs) {
  const deadline = new Date((claims.iat + 30 * 60) * 1000).toISOString();
  if (!accepted.get('shipping_address')) {
    const body = base(id, 'routing', {
      next_action: { kind: 'shipping_address', consent_required: true, expires_at: deadline },
      consent: fixtureConsentBlock('shipping_address', false, nowMs),
    });
    body.detail.buyer_step = { kind: 'shipping_address', expires_at: deadline, consent_required: true, available: true };
    return body;
  }
  const given = addressGiven.get(addressKey(claims));
  if (!given) {
    return base(id, 'routing', {
      next_action: { kind: 'shipping_address', fields_missing: [...ALL_ADDRESS_FIELDS], expires_at: deadline, prefill: { country: 'US' } },
      consent: fixtureConsentBlock('shipping_address', true, nowMs),
    });
  }
  const since = Math.max(0, nowMs / 1000 - given.at);
  const state = step(since, [[0, 'needs_payment_method'], [20, 'completed']]);
  if (state === 'completed') return base(id, state, { order_reference: '#1008', poll_after_seconds: null });
  return base(id, state, { next_action: action('card_binding', claims.iat) });
}

function consentPurchase(id, accepted, nowMs) {
  const consentBlock = (step, satisfied) => fixtureConsentBlock(step, satisfied, nowMs);
  const card = accepted.get('card_binding');
  const approval = accepted.get('approval');
  const deadline = new Date(nowMs + 10 * 60 * 1000).toISOString();
  const reap = (state, extra) => ({ ...base(id, state, extra), rail: 'reap', rail_purchase_id: id });
  if (!card) {
    return reap('needs_payment_method', {
      next_action: { kind: 'card_binding', expires_at: deadline, consent_required: true }, consent: consentBlock('card_binding', false),
    });
  }
  const sinceCard = (nowMs - card) / 1000;
  if (sinceCard < 10) {
    return reap('needs_payment_method', { next_action: action('card_binding', Math.floor(card / 1000)), consent: consentBlock('card_binding', true) });
  }
  if (!approval) return reap('locking', { consent: consentBlock('approval', false) });
  const sinceApproval = (nowMs - approval) / 1000;
  if (sinceApproval < 10) {
    return reap('awaiting_buyer_authorization', { next_action: action('approval', Math.floor(approval / 1000)), consent: consentBlock('approval', true) });
  }
  if (sinceApproval < 16) return reap('placing');
  const body = reap('completed', { order_reference: '#1007', poll_after_seconds: null });
  body.detail.merchant_order_status_url = 'https://merchant.example/orders/1007';
  return body;
}

/** The fixture body for a verified link, or null for an id with no scenario. */
function fixturePurchase(claims, { now, accepted } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.now();
  const name = scenarioForId(claims && claims.purchaseId);
  if (!name) return null;
  const id = claims.purchaseId;
  const elapsed = Math.max(0, nowMs / 1000 - claims.iat);
  switch (name) {
    case 'consent':
      return consentPurchase(id, accepted instanceof Map ? accepted : new Map(), nowMs);
    case 'address_consent':
      return addressConsentPurchase(id, claims, accepted instanceof Map ? accepted : new Map(), nowMs);
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
    case 'card_choice': {
      const confirmed = cardConfirmed.get(addressKey(claims));
      const steps = accepted instanceof Map ? accepted : new Map();
      if (!confirmed) {
        return base(id, 'locking', {
          consent: fixtureConsentBlock('approval', steps.has('approval'), nowMs),
          card_choice: {
            confirmed: false,
            expires_at: new Date((claims.iat + 30 * 60) * 1000).toISOString(),
            cards: FIXTURE_CARDS.map((c, i) => ({
              handle: fixtureCardHandle(id, c.id), network: c.network, last4: c.last4, added_at: c.added_at, selected: i === 0,
            })),
          },
        });
      }
      if (confirmed.cardId === FIXTURE_NEW_CARD.id) {
        // "Add a new card": the card page (its own terms first), then, once the terms are accepted and the card bound,
        // the order is locked again and approved on the new card.
        const boundFrom = steps.get('card_binding');
        if (!boundFrom) {
          return base(id, 'needs_payment_method', {
            next_action: action('card_binding', claims.iat), consent: fixtureConsentBlock('card_binding', false, nowMs),
          });
        }
        const sinceBound = Math.max(0, (nowMs - boundFrom) / 1000);
        const newState = step(sinceBound, [[0, 'needs_payment_method'], [8, 'locking'], [11, 'awaiting_buyer_authorization'], [30, 'placing'], [35, 'completed']]);
        const newPaid = { payment_card: { network: FIXTURE_NEW_CARD.network, last4: FIXTURE_NEW_CARD.last4 } };
        if (newState === 'needs_payment_method') {
          return base(id, newState, { next_action: action('card_binding', claims.iat), consent: fixtureConsentBlock('card_binding', true, nowMs) });
        }
        if (newState === 'awaiting_buyer_authorization') {
          return base(id, newState, { next_action: action('approval', claims.iat), consent: fixtureConsentBlock('approval', true, nowMs), ...newPaid });
        }
        if (newState === 'completed') return base(id, newState, { order_reference: '#1004', poll_after_seconds: null, ...newPaid });
        return base(id, newState);
      }
      const since = Math.max(0, nowMs / 1000 - confirmed.at);
      const state = step(since, [[0, 'locking'], [3, 'awaiting_buyer_authorization'], [25, 'placing'], [30, 'completed']]);
      const card = FIXTURE_CARDS.find((c) => c.id === confirmed.cardId);
      const paid = { payment_card: { network: card.network, last4: card.last4 } };
      if (state === 'locking') {
        return base(id, state, {
          consent: fixtureConsentBlock('approval', true, nowMs),
          card_choice: {
            confirmed: true, expires_at: null,
            cards: FIXTURE_CARDS.map((c) => ({
              handle: fixtureCardHandle(id, c.id), network: c.network, last4: c.last4, added_at: c.added_at,
              selected: c.id === confirmed.cardId,
            })),
          },
        });
      }
      if (state === 'awaiting_buyer_authorization') {
        return base(id, state, { next_action: action('approval', claims.iat), consent: fixtureConsentBlock('approval', true, nowMs), ...paid });
      }
      if (state === 'completed') return base(id, state, { order_reference: '#1003', poll_after_seconds: null, ...paid });
      return base(id, state);
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
            kind: 'shipping_address', fields_missing: [...ALL_ADDRESS_FIELDS],
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
  return createFixtures({ now }).reader;
}

/**
 * The fixture reader and its consent writer, sharing one in-memory record of the consents accepted per purchase (dev
 * only; the router builds one per instance). The writer records what the router hands it and nothing else.
 */
function createFixtures({ now } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const accepted = new Map();
  const acceptedFor = (claims) => {
    const key = `${claims.agentId}|${claims.purchaseId}`;
    if (!accepted.has(key)) accepted.set(key, new Map());
    return accepted.get(key);
  };
  return Object.freeze({
    reader: Object.freeze({
      async read(claims) {
        const purchase = fixturePurchase(claims, { now: clock(), accepted: acceptedFor(claims) });
        return purchase ? { kind: 'accepted', purchase } : { kind: 'not_found' };
      },
      // Same answers as the backend's address write: the same address again is fine, another one is a 409.
      async submitShippingAddress(claims, address) {
        const scenario = scenarioForId(claims && claims.purchaseId);
        if (scenario !== 'needs_address' && scenario !== 'address_consent') return { kind: 'conflict' };
        // As the backend's gate: no address before the step's consent (nothing kept).
        if (scenario === 'address_consent' && !acceptedFor(claims).has('shipping_address')) return { kind: 'consent_required' };
        const key = addressKey(claims);
        const digest = digestOf(address);
        const given = addressGiven.get(key);
        if (given && given.digest !== digest) return { kind: 'conflict' };
        if (!given) addressGiven.set(key, { digest, at: clock() / 1000 });
        return { kind: 'accepted', purchase: fixturePurchase(claims, { now: clock(), accepted: acceptedFor(claims) }) };
      },
      // Same answers as the backend's card-choice write: the same card again is fine, another one is closed.
      async submitCardChoice(claims, handle) {
        if (scenarioForId(claims && claims.purchaseId) !== 'card_choice') return { kind: 'closed', code: 'card_choice_closed' };
        // As the backend's gate: no card before the approval step's consent (nothing kept).
        if (!acceptedFor(claims).has('approval')) return { kind: 'consent_required' };
        const wantsNew = handle && typeof handle === 'object' && handle.newCard === true;
        const card = wantsNew ? FIXTURE_NEW_CARD : FIXTURE_CARDS.find((c) => fixtureCardHandle(claims.purchaseId, c.id) === handle);
        if (!card) return { kind: 'stale' };
        const key = addressKey(claims);
        const given = cardConfirmed.get(key);
        if (given && given.cardId !== card.id) return { kind: 'closed', code: 'card_choice_closed' };
        if (!given) cardConfirmed.set(key, { cardId: card.id, at: clock() / 1000 });
        return { kind: 'accepted', purchase: fixturePurchase(claims, { now: clock(), accepted: acceptedFor(claims) }) };
      },
    }),
    consentWriter: Object.freeze({
      async record(claims, consent) {
        if (!scenarioForId(claims && claims.purchaseId)) return { kind: 'refused', code: 'purchase_not_found' };
        const steps = acceptedFor(claims);
        if (!steps.has(consent.step)) steps.set(consent.step, clock());
        return { kind: 'recorded' };
      },
    }),
  });
}

module.exports = {
  FIXTURE_HOST,
  SCENARIOS,
  createFixturePurchaseReader,
  createFixtures,
  fixturePurchase,
};
