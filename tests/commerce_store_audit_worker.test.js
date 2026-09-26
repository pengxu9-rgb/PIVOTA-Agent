'use strict';

const { createCommerceStoreAuditWorker } = require('../src/services/commerceStoreAuditWorker');

test('claims one target, runs anonymous audit, and sends a redacted receipt', async () => {
  const fetchImpl = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({
    audit_run_id: 'audit-1', verification_run_id: 'verify-1', probe_id: 'verify-1:attempt:1', target_url: 'https://merchant.example/product/a',
  }) });
  const audit = { audit: jest.fn().mockResolvedValue({ verification_status: 'succeeded', observed_at: '2026-08-24T00:00:00.000Z', checkout: { status: 'guest_route_detected' }, cart: { status: 'verified', quantity: 1 } }) };
  const receipt = { submit: jest.fn().mockResolvedValue({ ok: true, verification_status: 'succeeded', capability: { agent_route_policy: 'merchant_handoff' } }) };
  const worker = createCommerceStoreAuditWorker({
    claimUrl: 'https://backend.example/internal/store-audit/commerce-probes/claims', internalKey: 'key', workerId: 'worker-1',
    armed: true,
    idTokenProvider: { getToken: async () => 'id-token' }, fetchImpl, auditService: audit, receiptClient: receipt,
  });
  await expect(worker.runOnce()).resolves.toMatchObject({ ok: true, code: 'processed', verification_status: 'succeeded' });
  expect(audit.audit).toHaveBeenCalledWith({ targetUrl: 'https://merchant.example/product/a' });
  expect(receipt.submit).toHaveBeenCalledWith(expect.objectContaining({ auditRunId: 'audit-1', workerId: 'worker-1' }));
});

test('does not audit an invalid claimed target', async () => {
  const worker = createCommerceStoreAuditWorker({
    claimUrl: 'https://backend.example/claims', internalKey: 'key', workerId: 'worker-1', idTokenProvider: { getToken: async () => 'id-token' },
    armed: true,
    fetchImpl: async () => ({ ok: true, json: async () => ({ audit_run_id: 'audit-1', verification_run_id: 'verify-1', probe_id: 'verify-1:attempt:1', target_url: 'https://merchant.example/a?token=secret' }) }),
    auditService: { audit: jest.fn() }, receiptClient: { submit: jest.fn() },
  });
  await expect(worker.runOnce()).resolves.toEqual({ ok: false, code: 'claim_invalid_payload' });
});

test('bounds a stalled claim request', async () => {
  const worker = createCommerceStoreAuditWorker({
    claimUrl: 'https://backend.example/claims', internalKey: 'key', workerId: 'worker-1', claimTimeoutMs: 5,
    armed: true,
    idTokenProvider: { getToken: async () => 'id-token' },
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    auditService: { audit: jest.fn() }, receiptClient: { submit: jest.fn() },
  });
  await expect(worker.runOnce()).resolves.toEqual({ ok: false, code: 'claim_delivery_failed' });
});

test('does not authenticate, claim, or browse when the deployment gate is disarmed', async () => {
  const fetchImpl = jest.fn();
  const audit = { audit: jest.fn() };
  const worker = createCommerceStoreAuditWorker({
    claimUrl: 'https://backend.example/claims', internalKey: 'key', workerId: 'worker-1',
    armed: false, idTokenProvider: { getToken: jest.fn() }, fetchImpl,
    auditService: audit, receiptClient: { submit: jest.fn() },
  });
  await expect(worker.runOnce()).resolves.toEqual({ ok: true, code: 'worker_disarmed' });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(audit.audit).not.toHaveBeenCalled();
});
