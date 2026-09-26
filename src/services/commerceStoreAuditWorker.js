'use strict';

const { createCloudRunIdTokenProvider } = require('./cloudRunIdentityToken');
const { createCommerceStorefrontAudit, httpsUrl } = require('./commerceStorefrontAudit');
const { createCommerceStoreAuditReceiptClient } = require('./commerceStoreAuditReceiptClient');

function text(value) { const normalized = String(value || '').trim(); return normalized || null; }

function createCommerceStoreAuditWorker({
  claimUrl = process.env.STORE_AUDIT_COMMERCE_PROBE_CLAIM_URL,
  internalKey = process.env.STORE_AUDIT_COMMERCE_PROBE_INTERNAL_KEY,
  workerId = process.env.STORE_AUDIT_COMMERCE_WORKER_ID,
  cloudRunAudience = process.env.STORE_AUDIT_COMMERCE_PROBE_ID_TOKEN_AUDIENCE,
  armed = String(process.env.STORE_AUDIT_COMMERCE_REPROBE_ARMED || '').trim().toLowerCase() === 'true',
  idTokenProvider, fetchImpl = global.fetch, auditService, claimTimeoutMs = 5000,
  receiptClient,
} = {}) {
  const claimEndpoint = httpsUrl(claimUrl);
  const key = text(internalKey); const id = text(workerId);
  const identity = idTokenProvider || createCloudRunIdTokenProvider({ audience: cloudRunAudience, fetchImpl });
  const auditor = auditService || createCommerceStorefrontAudit({ playwright: require('playwright') });
  const sender = receiptClient || createCommerceStoreAuditReceiptClient({ internalKey: key, fetchImpl, cloudRunAudience, idTokenProvider: identity });
  async function runOnce() {
    // Scheduler pause is not a complete boundary: an operator can manually
    // execute a Cloud Run Job. Refuse before auth, claim, browser launch, or
    // merchant network access unless the separate deployment gate is armed.
    if (!armed) return { ok: true, code: 'worker_disarmed' };
    if (!claimEndpoint || !key || !id || !identity || typeof identity.getToken !== 'function' || typeof fetchImpl !== 'function') return { ok: false, code: 'worker_not_configured' };
    const token = await identity.getToken();
    if (!token) return { ok: false, code: 'service_auth_unavailable' };
    let response;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), claimTimeoutMs);
    try { response = await fetchImpl(claimEndpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-internal-key': key, authorization: `Bearer ${token}` }, body: JSON.stringify({ worker_id: id }), signal: controller.signal }); } catch { return { ok: false, code: 'claim_delivery_failed' }; } finally { clearTimeout(timer); }
    if (response && response.status === 204) return { ok: true, code: 'no_work' };
    if (!response || !response.ok) return { ok: false, code: 'claim_rejected', status: response && response.status };
    let claim;
    try { claim = await response.json(); } catch { return { ok: false, code: 'claim_invalid_response' }; }
    const auditRunId = text(claim && claim.audit_run_id); const verificationRunId = text(claim && claim.verification_run_id); const probeId = text(claim && claim.probe_id); const targetUrl = httpsUrl(claim && claim.target_url);
    if (!auditRunId || !verificationRunId || !probeId || !targetUrl) return { ok: false, code: 'claim_invalid_payload' };
    const result = await auditor.audit({ targetUrl });
    const receipt = await sender.submit({ auditRunId, verificationRunId, workerId: id, probeId, result });
    return receipt.ok ? { ok: true, code: 'processed', verification_status: receipt.verification_status, capability: receipt.capability } : { ok: false, code: receipt.code };
  }
  return { runOnce };
}

module.exports = { createCommerceStoreAuditWorker };
