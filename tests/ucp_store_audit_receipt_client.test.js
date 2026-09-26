'use strict';

const {
  buildReceipt,
  createUcpStoreAuditReceiptClient,
} = require('../src/services/ucpStoreAuditReceiptClient');

function input(overrides = {}) {
  return {
    auditRunId: 'audit-1',
    verificationRunId: 'verify-1',
    workerId: 'worker-1',
    probeId: 'probe-20260823-001',
    result: {
      verifier_id: 'ucp_probe',
      verification_status: 'succeeded',
      observed_at: '2026-08-23T12:00:00.000Z',
      route: {
        normalized_domain: 'shop.example',
        route_kind: 'ucp',
        endpoint_normalized: 'https://shop.example/api/ucp/mcp',
        profile_url: 'https://shop.example/.well-known/ucp',
      },
      acceptance_signal: {
        evidence_type: 'acceptance_signal',
        evidence_level: 'tested',
        payload: { priced_facts: { total: '20.00', currency: 'USD' } },
      },
    },
    ...overrides,
  };
}

test('receipt maps endpoint_normalized and excludes profile URLs', () => {
  const receipt = buildReceipt(input());
  expect(receipt.route).toEqual({
    normalized_domain: 'shop.example',
    route_kind: 'ucp',
    endpoint: 'https://shop.example/api/ucp/mcp',
  });
  expect(JSON.stringify(receipt)).not.toContain('.well-known/ucp');
});

test('receipt client is fail-closed without an HTTPS destination and key', async () => {
  const fetchImpl = jest.fn();
  const client = createUcpStoreAuditReceiptClient({
    receiptUrl: 'http://backend.internal/receipts',
    internalKey: '',
    fetchImpl,
  });
  await expect(client.submit(input())).resolves.toEqual({ ok: false, code: 'receipt_not_configured' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('receipt client sends one redacted POST with the dedicated key', async () => {
  const fetchImpl = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ verification_status: 'succeeded', execution_route_id: 'route-1', evidence_id: 'evidence-1' }),
  });
  const client = createUcpStoreAuditReceiptClient({
    receiptUrl: 'https://backend.internal/internal/store-audit/ucp-probes/receipts',
    internalKey: 'dedicated-key',
    idTokenProvider: { getToken: jest.fn().mockResolvedValue('cloud-run-id-token') },
    fetchImpl,
  });
  await expect(client.submit(input())).resolves.toEqual({
    ok: true,
    verification_status: 'succeeded',
    execution_route_id: 'route-1',
    evidence_id: 'evidence-1',
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [, request] = fetchImpl.mock.calls[0];
  expect(request.redirect).toBe('error');
  expect(request.headers['x-internal-key']).toBe('dedicated-key');
  expect(request.headers.authorization).toBe('Bearer cloud-run-id-token');
  expect(request.body).not.toContain('.well-known/ucp');
});

test('receipt client fails closed when Cloud Run identity token is unavailable', async () => {
  const fetchImpl = jest.fn();
  const client = createUcpStoreAuditReceiptClient({
    receiptUrl: 'https://backend.internal/internal/store-audit/ucp-probes/receipts',
    internalKey: 'dedicated-key',
    idTokenProvider: { getToken: jest.fn().mockResolvedValue(null) },
    fetchImpl,
  });
  await expect(client.submit(input())).resolves.toEqual({ ok: false, code: 'receipt_auth_unavailable' });
  expect(fetchImpl).not.toHaveBeenCalled();
});
