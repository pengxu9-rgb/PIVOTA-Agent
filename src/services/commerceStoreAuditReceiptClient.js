'use strict';

const { createCloudRunIdTokenProvider } = require('./cloudRunIdentityToken');
const { CART_STATUSES, CHECKOUT_STATUSES, httpsUrl } = require('./commerceStorefrontAudit');

const PLATFORM = new Set(['shopify', 'cafe24', 'woocommerce', 'bigcommerce', 'magento', 'custom', 'unknown']);
const CHECKOUT_PROVIDER = new Set(['shopify', 'cafe24', 'stripe', 'adyen', 'antom', 'custom', 'unknown']);
const OUTCOME = new Set(['challenge', 'network', 'timeout', 'not_checkout_reachable', 'invalid_probe']);

function text(value, max = 255) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, max) : null;
}

function buildReceipt({ auditRunId, verificationRunId, workerId, probeId, result } = {}) {
  if (!result || typeof result !== 'object') throw new Error('commerce audit result is required');
  const receipt = {
    audit_run_id: text(auditRunId, 128), verification_run_id: text(verificationRunId, 128),
    worker_id: text(workerId), probe_id: text(probeId), verifier_id: 'commerce_checkout_probe',
    verification_status: text(result.verification_status, 32), observed_at: text(result.observed_at, 64),
  };
  if (Object.values(receipt).some((value) => !value)) throw new Error('missing commerce receipt field');
  if (!['succeeded', 'failed', 'blocked'].includes(receipt.verification_status)) throw new Error('invalid commerce verification status');
  if (result.outcome_code) {
    if (!OUTCOME.has(result.outcome_code)) throw new Error('invalid commerce outcome code');
    receipt.outcome_code = result.outcome_code;
  }
  if (result.platform) {
    if (!PLATFORM.has(result.platform.platform) || !CHECKOUT_PROVIDER.has(result.platform.checkout_provider)) throw new Error('invalid commerce platform');
    receipt.platform = { platform: result.platform.platform, checkout_provider: result.platform.checkout_provider };
  }
  if (result.checkout) {
    if (!CHECKOUT_STATUSES.has(result.checkout.status)) throw new Error('invalid checkout status');
    receipt.checkout = { status: result.checkout.status };
    if (result.checkout.challenge_stage) receipt.checkout.challenge_stage = result.checkout.challenge_stage;
  }
  if (result.cart) {
    if (!CART_STATUSES.has(result.cart.status)) throw new Error('invalid cart status');
    receipt.cart = { status: result.cart.status };
    if (Number.isInteger(result.cart.quantity) && result.cart.quantity > 0) receipt.cart.quantity = result.cart.quantity;
    if (Number.isFinite(result.cart.cart_price) && result.cart.cart_price >= 0) receipt.cart.cart_price = result.cart.cart_price;
    if (/^[A-Z]{3}$/.test(String(result.cart.currency || ''))) receipt.cart.currency = result.cart.currency;
  }
  if (receipt.verification_status === 'succeeded' && !receipt.checkout) throw new Error('successful commerce probe requires checkout evidence');
  return receipt;
}

function createCommerceStoreAuditReceiptClient({
  receiptUrl = process.env.STORE_AUDIT_COMMERCE_PROBE_RECEIPT_URL,
  internalKey = process.env.STORE_AUDIT_COMMERCE_PROBE_INTERNAL_KEY,
  cloudRunAudience = process.env.STORE_AUDIT_COMMERCE_PROBE_ID_TOKEN_AUDIENCE,
  idTokenProvider, fetchImpl = global.fetch, timeoutMs = 5000,
} = {}) {
  const url = httpsUrl(receiptUrl);
  const key = text(internalKey);
  const identity = idTokenProvider || createCloudRunIdTokenProvider({ audience: cloudRunAudience, fetchImpl });
  async function submit(input) {
    if (!url || !key || !identity || typeof identity.getToken !== 'function' || typeof fetchImpl !== 'function') return { ok: false, code: 'receipt_not_configured' };
    const body = buildReceipt(input);
    const token = await identity.getToken();
    if (!token) return { ok: false, code: 'receipt_auth_unavailable' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-internal-key': key, authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: controller.signal });
      if (!response || !response.ok) return { ok: false, code: 'receipt_rejected', status: response && response.status };
      const payload = await response.json().catch(() => ({}));
      return { ok: true, verification_status: text(payload.verification_status, 32), capability: payload.capability || null };
    } catch { return { ok: false, code: 'receipt_delivery_failed' }; } finally { clearTimeout(timer); }
  }
  return { submit };
}

module.exports = { buildReceipt, createCommerceStoreAuditReceiptClient };
