const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';

const app = require('../src/server');

test('CORS preflight advertises PATCH in Access-Control-Allow-Methods', async () => {
  const resp = await supertest(app)
    .options('/v1/travel-plans')
    .set('Origin', 'http://localhost:3000')
    .set('Access-Control-Request-Method', 'PATCH')
    .set('Access-Control-Request-Headers', 'content-type,x-aurora-uid')
    .expect(204);

  const methods = String(resp.headers['access-control-allow-methods'] || '');
  assert.match(methods, /\bPATCH\b/);
});

test('CORS preflight allows the Aurora Chatbox production Vercel origin', async () => {
  const resp = await supertest(app)
    .options('/v1/travel-plans')
    .set('Origin', 'https://pivota-aurora-chatbox.vercel.app')
    .set('Access-Control-Request-Method', 'GET')
    .set('Access-Control-Request-Headers', 'content-type,x-aurora-uid')
    .expect(204);

  assert.equal(resp.headers['access-control-allow-origin'], 'https://pivota-aurora-chatbox.vercel.app');
  assert.equal(resp.headers['access-control-allow-credentials'], 'true');
});
