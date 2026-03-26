const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');

const { createLookReplicatorApp } = require('../src/lookReplicator/app');
const { createAuroraBffApp } = require('../src/auroraBff/app');

test('look replicator standalone app exposes healthz', async () => {
  const app = createLookReplicatorApp({
    logger: null,
    commerceClient: {
      invoke: async () => ({ statusCode: 200, body: { ok: true }, headers: {} }),
    },
  });
  const response = await supertest(app).get('/healthz').expect(200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.service, 'look_replicator');
});

test('aurora standalone app exposes healthz', async () => {
  const app = createAuroraBffApp({ logger: null });
  const response = await supertest(app).get('/healthz').expect(200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.service, 'aurora_bff');
});
