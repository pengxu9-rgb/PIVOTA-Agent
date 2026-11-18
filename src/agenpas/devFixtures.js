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
  // A Reap-rail purchase behind the consent step (AGENPAS_CONSENT_ENABLED and AGENPAS_RAILS=a2a,reap): the card page
  // and then the approval page appear only after the buyer accepts the terms on the page.
  consent: { id: 'rp_000000000000000000000007' },
});

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
function consentPurchase(id, accepted, nowMs) {
  const consentBlock = (step, satisfied) => ({
    required: true, available: true, step, satisfied,
    terms_url: FIXTURE_TERMS_URL, privacy_url: FIXTURE_PRIVACY_URL, terms_version: 'fixture-terms-1', privacy_version: 'fixture-privacy-1',
    ...(satisfied ? {} : { offer: { id: 'fixtureoffer0000000000000001', issued_at: isoSeconds(nowMs) } }),
  });
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
    default:
      return null;
  }
}

function createFixturePurchaseReader() {
  return createFixtures().reader;
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
