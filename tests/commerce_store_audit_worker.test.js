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
    idTokenProvider: { getToken: async () => 'id-token' }, fetchImpl, auditService: audit, receiptClient: receipt,
  });
  await expect(worker.runOnce()).resolves.toMatchObject({ ok: true, code: 'processed', verification_status: 'succeeded' });
  expect(audit.audit).toHaveBeenCalledWith({ targetUrl: 'https://merchant.example/product/a' });
  expect(receipt.submit).toHaveBeenCalledWith(expect.objectContaining({ auditRunId: 'audit-1', workerId: 'worker-1' }));
});

test('does not audit an invalid claimed target', async () => {
  const worker = createCommerceStoreAuditWorker({
    claimUrl: 'https://backend.example/claims', internalKey: 'key', workerId: 'worker-1', idTokenProvider: { getToken: async () => 'id-token' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ audit_run_id: 'audit-1', verification_run_id: 'verify-1', probe_id: 'verify-1:attempt:1', target_url: 'https://merchant.example/a?token=secret' }) }),
    auditService: { audit: jest.fn() }, receiptClient: { submit: jest.fn() },
  });
  await expect(worker.runOnce()).resolves.toEqual({ ok: false, code: 'claim_invalid_payload' });
});
