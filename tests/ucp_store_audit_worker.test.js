'use strict';

const { createUcpStoreAuditWorker, validVariantGid } = require('../src/services/ucpStoreAuditWorker');

const identity = () => ({ getToken: jest.fn().mockResolvedValue('cloud-run-id-token') });

test('worker is fail-closed when its claim configuration is absent', async () => {
  const fetchImpl = jest.fn();
  const worker = createUcpStoreAuditWorker({
    claimUrl: '', internalKey: '', workerId: '', fetchImpl,
    idTokenProvider: identity(),
    probeService: { probe: jest.fn() },
    receiptClient: { submit: jest.fn() },
  });
  await expect(worker.runOnce()).resolves.toEqual({ ok: false, code: 'worker_not_configured' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('worker reports no work without probing', async () => {
  const probe = { probe: jest.fn() };
  const worker = createUcpStoreAuditWorker({
    claimUrl: 'https://backend.internal/claims', internalKey: 'key', workerId: 'worker-1',
    idTokenProvider: identity(),
    fetchImpl: jest.fn().mockResolvedValue({ status: 204, ok: true }),
    probeService: probe, receiptClient: { submit: jest.fn() },
  });
  await expect(worker.runOnce()).resolves.toEqual({ ok: true, code: 'no_work' });
  expect(probe.probe).not.toHaveBeenCalled();
});

test('worker claims, performs anonymous probe, and sends result to receipt client', async () => {
  const probe = { probe: jest.fn().mockResolvedValue({ verifier_id: 'ucp_probe', verification_status: 'succeeded' }) };
  const sender = { submit: jest.fn().mockResolvedValue({ ok: true, verification_status: 'succeeded' }) };
  const fetchImpl = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      audit_run_id: 'audit-1', verification_run_id: 'verify-1',
      probe_id: 'verify-1:attempt:1', brand_domain: 'shop.example',
      variant_gid: 'gid://shopify/ProductVariant/123',
    }),
  });
  const worker = createUcpStoreAuditWorker({
    claimUrl: 'https://backend.internal/claims', internalKey: 'key', workerId: 'worker-1',
    idTokenProvider: identity(),
    fetchImpl, probeService: probe, receiptClient: sender,
  });
  await expect(worker.runOnce()).resolves.toEqual({ ok: true, code: 'processed', verification_status: 'succeeded' });
  expect(probe.probe).toHaveBeenCalledWith({
    brandDomain: 'shop.example', variantGid: 'gid://shopify/ProductVariant/123',
  });
  expect(sender.submit).toHaveBeenCalledWith(expect.objectContaining({
    auditRunId: 'audit-1', verificationRunId: 'verify-1', workerId: 'worker-1', probeId: 'verify-1:attempt:1',
  }));
  expect(fetchImpl.mock.calls[0][1].headers['x-internal-key']).toBe('key');
  expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer cloud-run-id-token');
});

test('worker fails before claim when its Cloud Run identity token is unavailable', async () => {
  const fetchImpl = jest.fn();
  const worker = createUcpStoreAuditWorker({
    claimUrl: 'https://backend.internal/claims', internalKey: 'key', workerId: 'worker-1',
    idTokenProvider: { getToken: jest.fn().mockResolvedValue(null) },
    fetchImpl, probeService: { probe: jest.fn() }, receiptClient: { submit: jest.fn() },
  });
  await expect(worker.runOnce()).resolves.toEqual({ ok: false, code: 'service_auth_unavailable' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('only a Shopify ProductVariant GID is passed to create_checkout preview', () => {
  expect(validVariantGid('gid://shopify/ProductVariant/123')).toBe('gid://shopify/ProductVariant/123');
  expect(validVariantGid('gid://shopify/Product/123')).toBeUndefined();
  expect(validVariantGid('arbitrary-product-key')).toBeUndefined();
});
