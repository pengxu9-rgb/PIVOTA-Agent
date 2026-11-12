process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

describe('request_after_sales cancel routing', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('routes requested_action=cancel to /agent/v1/orders/{id}/cancel', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v1/orders/ORD_1/cancel')
      .reply(200, { status: 'success', order_id: 'ORD_1' });

    await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'request_after_sales',
        payload: {
          status: {
            order_id: 'ORD_1',
            requested_action: 'cancel',
          },
        },
      })
      .expect(200);
  });

  // The caller's own agent key is the only credential an after-sales call may carry: the gateway's service
  // key (PIVOTA_API_KEY) would run the backend's ownership check against this gateway instead of the caller.
  it.each(['cancel', 'refund'])('never sends the gateway service key on %s', async (action) => {
    const seen = [];
    const path = action === 'cancel' ? '/agent/v1/orders/ORD_1/cancel' : '/agent/v2/orders/ORD_1/refunds';
    nock(process.env.PIVOTA_API_BASE)
      .post(path)
      .reply(function reply() {
        seen.push({ ...this.req.headers });
        return [200, { status: 'success', order_id: 'ORD_1' }];
      });

    await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'request_after_sales',
        payload: { status: { order_id: 'ORD_1', requested_action: action } },
      })
      .expect(200);

    expect(seen).toHaveLength(1);
    expect(seen[0]['x-api-key']).toBeUndefined();
    expect(seen[0].authorization).toBeUndefined();
  });

  // FIX_PLAN C-11: with the backend's CHECKOUT_CANCEL_UPSTREAM_ENABLED on, the v1 cancel answers v2's codes. This lane
  // hands each back unchanged (status and body), so a caller reads `canceled: false` and the code, never a success.
  // The answers are recorded from the merged backend (tests/fixtures/backend_get_order_unified.backend.json).
  const RECORDED_V1_CANCEL = JSON.parse(require('fs').readFileSync(
    require('path').join(__dirname, '..', 'fixtures', 'backend_get_order_unified.backend.json'), 'utf8',
  )).cancel_v1;
  it.each([
    ['not_canceled_paid', 409, 'ORDER_ALREADY_PAID'],
    ['not_canceled_processing', 409, 'PAYMENT_PROCESSING'],
    ['not_confirmed', 503, 'CANCEL_NOT_CONFIRMED'],
  ])('passes the backend\'s v1 cancel answer %s through as %s %s', async (outcome, status, code) => {
    const recorded = RECORDED_V1_CANCEL[outcome];
    let calls = 0;
    nock(process.env.PIVOTA_API_BASE)
      .post(`/agent/v1/orders/${recorded.body.detail.order_id}/cancel`)
      .reply(() => { calls += 1; return [recorded.status, recorded.body]; });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'request_after_sales',
        payload: { status: { order_id: recorded.body.detail.order_id, requested_action: 'cancel' } },
      });

    expect(res.status).toBe(status);
    expect(res.body.detail).toEqual(expect.objectContaining({ error: code, canceled: false }));
    expect(calls).toBe(1);
  });
});
