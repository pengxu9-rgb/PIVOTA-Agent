'use strict';

/* One-shot Cloud Run Job worker for the Store Audit UCP re-probe lane. */

const { createUcpStoreAuditProbe } = require('./ucpStoreAuditProbe');
const { createUcpStoreAuditReceiptClient } = require('./ucpStoreAuditReceiptClient');
const { createCloudRunIdTokenProvider } = require('./cloudRunIdentityToken');

function httpsUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function validVariantGid(value) {
  const candidate = firstString(value);
  return candidate && /^gid:\/\/shopify\/ProductVariant\/[0-9]+$/.test(candidate)
    ? candidate
    : undefined;
}

function createUcpStoreAuditWorker({
  claimUrl = process.env.STORE_AUDIT_UCP_PROBE_CLAIM_URL,
  internalKey = process.env.STORE_AUDIT_UCP_PROBE_INTERNAL_KEY,
  workerId = process.env.STORE_AUDIT_UCP_WORKER_ID,
  cloudRunAudience = process.env.STORE_AUDIT_UCP_PROBE_ID_TOKEN_AUDIENCE,
  idTokenProvider,
  fetchImpl = global.fetch,
  probeService = createUcpStoreAuditProbe(),
  receiptClient,
} = {}) {
  const claimEndpoint = httpsUrl(claimUrl);
  const key = firstString(internalKey);
  const id = firstString(workerId);
  const identity = idTokenProvider || createCloudRunIdTokenProvider({ audience: cloudRunAudience });
  const sender = receiptClient || createUcpStoreAuditReceiptClient({
    internalKey: key,
    fetchImpl,
    cloudRunAudience,
    idTokenProvider: identity,
  });

  async function runOnce() {
    if (!claimEndpoint || !key || !id || !identity || typeof identity.getToken !== 'function' || typeof fetchImpl !== 'function') {
      return { ok: false, code: 'worker_not_configured' };
    }
    const idToken = await identity.getToken();
    if (!idToken) return { ok: false, code: 'service_auth_unavailable' };
    let response;
    try {
      response = await fetchImpl(claimEndpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-internal-key': key,
          authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ worker_id: id }),
      });
    } catch {
      return { ok: false, code: 'claim_delivery_failed' };
    }
    if (response && response.status === 204) return { ok: true, code: 'no_work' };
    if (!response || !response.ok) {
      return { ok: false, code: 'claim_rejected', status: response && response.status };
    }

    let claim;
    try {
      claim = await response.json();
    } catch {
      return { ok: false, code: 'claim_invalid_response' };
    }
    const auditRunId = firstString(claim && claim.audit_run_id);
    const verificationRunId = firstString(claim && claim.verification_run_id);
    const probeId = firstString(claim && claim.probe_id);
    const brandDomain = firstString(claim && claim.brand_domain);
    if (!auditRunId || !verificationRunId || !probeId || !brandDomain) {
      return { ok: false, code: 'claim_invalid_payload' };
    }

    const result = await probeService.probe({
      brandDomain,
      variantGid: validVariantGid(claim && claim.variant_gid),
    });
    const receipt = await sender.submit({
      auditRunId,
      verificationRunId,
      workerId: id,
      probeId,
      result,
    });
    if (!receipt.ok) return { ok: false, code: receipt.code };
    return {
      ok: true,
      code: 'processed',
      verification_status: receipt.verification_status,
    };
  }

  return { runOnce };
}

module.exports = { createUcpStoreAuditWorker, validVariantGid };
