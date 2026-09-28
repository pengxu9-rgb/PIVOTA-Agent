'use strict';

// The public doors through the real server, with X-Forwarded-For in the shape Google's external
// Application Load Balancer delivers: `<client-supplied...>, <client-ip>, <lb-ip>`. Two clients behind the
// one LB address must not share a bucket, a forged left-most entry must not mint a fresh one, and the hop
// count is the gateway-wide GATEWAY_RATE_LIMIT_TRUSTED_PROXY_HOPS — not a knob of the public doors' own.

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const nock = require('nock');

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
delete process.env.AGENT_CHECKOUT_STRICT;
delete process.env.GATEWAY_RATE_LIMIT_TRUSTED_PROXY_HOPS;
process.env.PUBLIC_READ_MCP_ENABLED = '1';
process.env.PUBLIC_READ_MCP_HOSTS = 'mcp.pivota.cc';
process.env.PUBLIC_READ_MCP_RPM = '1';
process.env.PUBLIC_READ_MCP_BURST = '3';
process.env.UCP_ORDER_WEBHOOK_RECEIVER_ENABLED = '1';
process.env.UCP_ORDER_WEBHOOK_RPM = '1';
process.env.UCP_ORDER_WEBHOOK_BURST = '3';
// Retired knob: the old public-door rule read it (default 1). Set here so a regression to it shows.
process.env.PUBLIC_READ_TRUSTED_PROXIES = '1';

const app = require('../src/server');

const LB_IP = '34.8.67.235';
const BURST = 3;

test.before(() => {
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1|localhost/);
});

test.after(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  delete process.env.PUBLIC_READ_TRUSTED_PROXIES;
});

const DOORS = {
  public_mcp: (xff) =>
    supertest(app)
      .post('/public/mcp')
      .set('X-Forwarded-For', xff)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  // Unsigned, so an admitted request is refused 401 by the receiver; only the limiter answers 429.
  ucp_order_webhook: (xff) => supertest(app).post('/ucp/order-webhook').set('X-Forwarded-For', xff).send({ order_id: 'ord_1' }),
};

// Requests admitted before the first 429, up to `max` (null: never limited).
async function admittedBeforeLimit(send, xffFor, max = BURST + 3) {
  for (let i = 0; i < max; i += 1) {
    const res = await send(xffFor(i));
    if (res.status === 429) return i;
  }
  return null;
}

let octet = 10;
const freshClient = () => `203.0.113.${(octet += 1)}`;

for (const [door, send] of Object.entries(DOORS)) {
  test(`${door}: two clients behind the one LB address get their own buckets`, async () => {
    const a = freshClient();
    const b = freshClient();
    assert.equal(await admittedBeforeLimit(send, () => `${a}, ${LB_IP}`), BURST, 'client A drains its own burst');
    const res = await send(`${b}, ${LB_IP}`);
    assert.notEqual(res.status, 429, 'client B is not charged for client A');
  });

  test(`${door}: rotating a forged left-most entry does not mint fresh buckets`, async () => {
    const c = freshClient();
    assert.equal(await admittedBeforeLimit(send, (i) => `10.0.0.${i}, ${c}, ${LB_IP}`), BURST);
  });

  test(`${door}: an IPv4-mapped spelling of the client lands in the same bucket`, async () => {
    const d = freshClient();
    assert.equal(
      await admittedBeforeLimit(send, (i) => (i % 2 ? `::ffff:${d}, ${LB_IP}` : `${d}, ${LB_IP}`)),
      BURST,
    );
  });
}

test('public_mcp: the hop count is the shared GATEWAY_RATE_LIMIT_TRUSTED_PROXY_HOPS', async () => {
  // Premise of the whole change, shown the other way round: told there is ONE hop, the door keys on the
  // LB's own address and every client behind it shares a bucket.
  process.env.GATEWAY_RATE_LIMIT_TRUSTED_PROXY_HOPS = '1';
  try {
    const e = freshClient();
    const f = freshClient();
    const lb = '34.8.67.236';
    assert.equal(await admittedBeforeLimit(DOORS.public_mcp, () => `${e}, ${lb}`), BURST);
    const res = await DOORS.public_mcp(`${f}, ${lb}`);
    assert.equal(res.status, 429, 'with hops=1 the LB address is the bucket');
  } finally {
    delete process.env.GATEWAY_RATE_LIMIT_TRUSTED_PROXY_HOPS;
  }
});
