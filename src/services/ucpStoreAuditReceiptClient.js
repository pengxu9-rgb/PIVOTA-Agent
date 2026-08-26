'use strict';

/*
 * Backend receipt client for the Store Audit UCP worker.
 *
 * This is deliberately a one-way, one-attempt handoff: the gateway probes a
 * public merchant endpoint but never receives database credentials. The
 * backend validates the worker lease and persists the redacted result.
 */

const DEFAULT_TIMEOUT_MS = 5000;
const { createCloudRunIdTokenProvider } = require('./cloudRunIdentityToken');

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function requireHttpsUrl(value) {
  const raw = firstString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function toReceiptRoute(route) {
  if (!route || typeof route !== 'object') return null;
  const normalized_domain = firstString(route.normalized_domain);
  const endpoint = requireHttpsUrl(route.endpoint_normalized || route.endpoint);
  if (!normalized_domain || !endpoint || route.route_kind !== 'ucp') return null;
  return {
    normalized_domain,
    route_kind: 'ucp',
    endpoint,
    ...(firstString(route.profile_fingerprint)
      ? { profile_fingerprint: firstString(route.profile_fingerprint) }
      : {}),
    ...(firstString(route.expires_at) ? { expires_at: firstString(route.expires_at) } : {}),
  };
}

function buildReceipt({ auditRunId, verificationRunId, workerId, probeId, result } = {}) {
  if (!result || typeof result !== 'object') throw new Error('UCP probe result is required');
  const required = {
    audit_run_id: firstString(auditRunId),
    verification_run_id: firstString(verificationRunId),
    worker_id: firstString(workerId),
    probe_id: firstString(probeId),
    verifier_id: firstString(result.verifier_id),
    verification_status: firstString(result.verification_status),
    observed_at: firstString(result.observed_at),
  };
  for (const [key, value] of Object.entries(required)) {
    if (!value) throw new Error(`Missing Store Audit receipt field: ${key}`);
  }
  if (required.verifier_id !== 'ucp_probe') throw new Error('Unexpected Store Audit verifier');
  if (!['succeeded', 'failed', 'blocked'].includes(required.verification_status)) {
    throw new Error('Unexpected Store Audit verification status');
  }

  const route = toReceiptRoute(result.route);
  const receipt = {
    ...required,
    ...(firstString(result.reason) ? { reason: firstString(result.reason) } : {}),
    ...(route ? { route } : {}),
  };
  if (result.acceptance_signal) {
    if (!route) throw new Error('Acceptance signal requires a valid UCP route');
    receipt.acceptance_signal = result.acceptance_signal;
  }
  return receipt;
}

function createUcpStoreAuditReceiptClient({
  receiptUrl = process.env.STORE_AUDIT_UCP_PROBE_RECEIPT_URL,
  internalKey = process.env.STORE_AUDIT_UCP_PROBE_INTERNAL_KEY,
  cloudRunAudience = process.env.STORE_AUDIT_UCP_PROBE_ID_TOKEN_AUDIENCE,
  idTokenProvider,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const url = requireHttpsUrl(receiptUrl);
  const key = firstString(internalKey);
  // audienceEnvVar keeps an unset UCP audience from silently borrowing the
  // commerce worker's env default inside the shared provider.
  const identity = idTokenProvider || createCloudRunIdTokenProvider({
    audience: cloudRunAudience,
    audienceEnvVar: 'STORE_AUDIT_UCP_PROBE_ID_TOKEN_AUDIENCE',
  });

  async function submit(input) {
    if (!url || !key || !identity || typeof identity.getToken !== 'function' || typeof fetchImpl !== 'function') {
      return { ok: false, code: 'receipt_not_configured' };
    }
    const body = buildReceipt(input);
    const idToken = await identity.getToken();
    if (!idToken) return { ok: false, code: 'receipt_auth_unavailable' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-internal-key': key,
          authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response || !response.ok) {
        return { ok: false, code: 'receipt_rejected', status: response && response.status };
      }
      const responseBody = await response.json().catch(() => ({}));
      return {
        ok: true,
        verification_status: firstString(responseBody && responseBody.verification_status),
        execution_route_id: firstString(responseBody && responseBody.execution_route_id),
        evidence_id: firstString(responseBody && responseBody.evidence_id),
      };
    } catch {
      return { ok: false, code: 'receipt_delivery_failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  return { submit };
}

module.exports = { buildReceipt, createUcpStoreAuditReceiptClient, toReceiptRoute };
