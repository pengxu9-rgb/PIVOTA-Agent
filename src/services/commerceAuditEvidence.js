'use strict';

const EVIDENCE_SOURCE_STORE_AUDIT = 'store_audit';
const ROUTE_DISCOVERY_ONLY = 'discovery_only';
const ROUTE_MERCHANT_HANDOFF = 'merchant_handoff';
const ROUTE_USER_TAKEOVER = 'user_takeover_required';
const ROUTE_AGENT_CHECKOUT = 'agent_checkout_eligible';
const CHECKOUT_ROUTE_EVIDENCE = 'commerce_checkout_route';
const SENSITIVE_KEY = /(address|email|phone|name|token|secret|cookie|session|authorization|card|payment|checkout_?url|continue_?url)/i;

function text(value, max = 512) {
  const normalized = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  return normalized ? normalized.slice(0, max) : '';
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function containsSensitiveData(value) {
  if (Array.isArray(value)) return value.some(containsSensitiveData);
  if (!plainObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => SENSITIVE_KEY.test(key) || containsSensitiveData(nested));
}

function iso(value) {
  const timestamp = new Date(value || '').getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function expiresAt(observedAt, hours) {
  return new Date(new Date(observedAt).getTime() + (hours * 60 * 60 * 1000)).toISOString();
}

function safeCurrency(value) {
  const currency = text(value, 3).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function safeAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function createEvidence({ subjectType, subjectId, evidenceType, payload, observedAt, ttlHours, market, auditRunId, confidence = 'observed' }) {
  if (containsSensitiveData(payload)) throw new Error('Commerce audit evidence ' + evidenceType + ' contains sensitive data');
  const observed_at = iso(observedAt) || new Date().toISOString();
  return {
    source: EVIDENCE_SOURCE_STORE_AUDIT,
    subject_type: subjectType,
    subject_id: subjectId,
    evidence_type: evidenceType,
    payload,
    confidence,
    observed_at,
    expires_at: expiresAt(observed_at, ttlHours),
    ...(text(market, 24) ? { market: text(market, 24).toUpperCase() } : {}),
    ...(text(auditRunId, 128) ? { audit_run_id: text(auditRunId, 128) } : {}),
  };
}

function buildCommerceAuditEvidence(observation = {}) {
  const merchantId = text(observation.merchant_id, 255);
  const skuId = text(observation.sku_id, 255);
  if (!merchantId) throw new Error('Store Audit evidence requires merchant_id');
  for (const field of ['cart', 'guest_checkout', 'integration']) {
    if (containsSensitiveData(observation[field])) {
      throw new Error('Store Audit observation contains sensitive data');
    }
  }
  const common = { observedAt: observation.observed_at, market: observation.market, auditRunId: observation.audit_run_id };
  const records = [];
  const platform = text(observation.platform, 80).toLowerCase();
  const checkoutProvider = text(observation.checkout_provider, 80).toLowerCase();
  if (platform || checkoutProvider) {
    records.push(createEvidence({
      ...common, subjectType: 'merchant', subjectId: merchantId, evidenceType: 'commerce_platform', ttlHours: 24 * 30,
      payload: { ...(platform ? { platform } : {}), ...(checkoutProvider ? { checkout_provider: checkoutProvider } : {}) },
    }));
  }
  if (plainObject(observation.cart) && skuId) {
    const status = text(observation.cart.status, 80).toLowerCase() || 'unknown';
    const price = safeAmount(observation.cart.price);
    const currency = safeCurrency(observation.cart.currency);
    records.push(createEvidence({
      ...common, subjectType: 'sku', subjectId: skuId, evidenceType: 'commerce_cartability', ttlHours: 6,
      payload: {
        status,
        ...(Number.isInteger(observation.cart.quantity) && observation.cart.quantity > 0 ? { quantity: observation.cart.quantity } : {}),
        ...(price != null ? { cart_price: price } : {}),
        ...(currency ? { currency } : {}),
      },
    }));
  }
  if (plainObject(observation.guest_checkout)) {
    const status = text(observation.guest_checkout.status, 100).toLowerCase() || 'unknown';
    const challengeStage = text(observation.guest_checkout.challenge_stage, 100).toLowerCase();
    records.push(createEvidence({
      ...common, subjectType: 'merchant', subjectId: merchantId, evidenceType: CHECKOUT_ROUTE_EVIDENCE, ttlHours: 24,
      // A representative SKU may be used to reach checkout, but the resulting
      // route/challenge finding is a merchant-level fact and is reused for the store.
      payload: {
        audit_scope: 'merchant_checkout',
        status,
        ...(challengeStage ? { challenge_stage: challengeStage } : {}),
        ...(skuId ? { probe_sku_id: skuId } : {}),
      },
    }));
  }
  if (plainObject(observation.integration) && observation.integration.agent_checkout_authorized === true) {
    records.push(createEvidence({
      ...common, subjectType: 'merchant', subjectId: merchantId, evidenceType: 'commerce_integration_authorization',
      ttlHours: 24 * 30, confidence: 'merchant_authorized',
      payload: { mode: text(observation.integration.mode, 80).toLowerCase() || 'authorized_integration', agent_checkout_authorized: true },
    }));
  }
  return records;
}

function resolveCommerceCapabilities({ merchant_id, sku_id, evidence = [], now } = {}) {
  const merchantId = text(merchant_id, 255);
  const skuId = text(sku_id, 255);
  if (!merchantId) throw new Error('Commerce capability resolution requires merchant_id');
  const cutoff = new Date(now || Date.now()).getTime();
  const active = (Array.isArray(evidence) ? evidence : []).filter((item) =>
    plainObject(item) && new Date(item.expires_at || 0).getTime() > cutoff,
  ).sort((a, b) => new Date(b.observed_at || 0) - new Date(a.observed_at || 0));
  const latest = (type, subjectType, subjectId) => active.find((item) =>
    item.evidence_type === type && item.subject_type === subjectType && item.subject_id === subjectId,
  ) || null;
  const platform = latest('commerce_platform', 'merchant', merchantId);
  const guest = latest(CHECKOUT_ROUTE_EVIDENCE, 'merchant', merchantId)
    // Accept the pre-release name while any early producer is being upgraded.
    || latest('commerce_guest_checkout', 'merchant', merchantId);
  const authorization = latest('commerce_integration_authorization', 'merchant', merchantId);
  const cart = skuId ? latest('commerce_cartability', 'sku', skuId) : null;
  const guestStatus = text(guest?.payload?.status, 100) || 'unknown';
  const challenge = text(guest?.payload?.challenge_stage, 100) || null;
  const cartStatus = text(cart?.payload?.status, 80) || 'unknown';
  const authorized = authorization?.source === EVIDENCE_SOURCE_STORE_AUDIT
    && authorization?.confidence === 'merchant_authorized'
    && authorization?.payload?.agent_checkout_authorized === true;
  const agentRoutePolicy = authorized
    ? ROUTE_AGENT_CHECKOUT
    : (challenge || guestStatus.includes('challenge') || guestStatus.includes('blocked'))
      ? ROUTE_USER_TAKEOVER
      : (cartStatus === 'verified' || guestStatus === 'guest_route_detected')
        ? ROUTE_MERCHANT_HANDOFF
        : ROUTE_DISCOVERY_ONLY;
  return {
    merchant: {
      merchant_id: merchantId,
      commerce_platform: text(platform?.payload?.platform, 80) || 'unknown',
      checkout_provider: text(platform?.payload?.checkout_provider, 80) || 'unknown',
      guest_checkout_mode: guestStatus,
      security_challenge_mode: challenge,
      integration_mode: authorized ? text(authorization.payload.mode, 80) : 'public_storefront',
      agent_route_policy: agentRoutePolicy,
      payment_capability: authorized ? 'merchant_authorized_revalidation_required' : 'unverified',
      evidence_refs: [platform, guest, authorization].filter(Boolean),
    },
    sku: skuId ? {
      sku_id: skuId,
      cartability_status: cartStatus,
      ...(cart?.payload?.cart_price != null ? { cart_price: cart.payload.cart_price } : {}),
      ...(cart?.payload?.currency ? { cart_currency: cart.payload.currency } : {}),
      orderability_status: cartStatus === 'verified' ? 'cart_verified_not_checkout_verified' : 'unknown',
      evidence_refs: cart ? [cart] : [],
    } : null,
  };
}

function merchantCheckoutAuditDecision({ merchant_id, evidence = [], now } = {}) {
  const merchantId = text(merchant_id, 255);
  if (!merchantId) throw new Error('Merchant checkout audit decision requires merchant_id');
  const cutoff = new Date(now || Date.now()).getTime();
  const current = (Array.isArray(evidence) ? evidence : [])
    .filter((item) => plainObject(item)
      && item.subject_type === 'merchant'
      && item.subject_id === merchantId
      && (item.evidence_type === CHECKOUT_ROUTE_EVIDENCE || item.evidence_type === 'commerce_guest_checkout')
      && new Date(item.expires_at || 0).getTime() > cutoff)
    .sort((a, b) => new Date(b.observed_at || 0) - new Date(a.observed_at || 0))[0];
  return current
    ? { should_audit: false, reason: 'fresh_merchant_checkout_evidence', next_eligible_at: current.expires_at, evidence_ref: current }
    : { should_audit: true, reason: 'missing_or_expired_merchant_checkout_evidence' };
}

module.exports = {
  EVIDENCE_SOURCE_STORE_AUDIT,
  ROUTE_DISCOVERY_ONLY,
  ROUTE_MERCHANT_HANDOFF,
  ROUTE_USER_TAKEOVER,
  ROUTE_AGENT_CHECKOUT,
  CHECKOUT_ROUTE_EVIDENCE,
  buildCommerceAuditEvidence,
  containsSensitiveData,
  merchantCheckoutAuditDecision,
  resolveCommerceCapabilities,
};
