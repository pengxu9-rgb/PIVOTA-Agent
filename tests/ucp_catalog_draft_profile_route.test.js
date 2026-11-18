// GET /.well-known/ucp-agent-catalog-draft: the draft-version profile used only for Shopify Global Catalog lookups
// that carry Promoted Placements attribution. Dark unless SHOPIFY_CATALOG_ATTRIBUTION is shadow or enforce; its
// self-reference comes only from SHOPIFY_CATALOG_DRAFT_PROFILE_URL, never from the Host header; and it never declares
// a cart or a checkout. The store profile at /.well-known/ucp-agent is unaffected.
const request = require('supertest');

const KEYS = ['SHOPIFY_CATALOG_ATTRIBUTION', 'SHOPIFY_CATALOG_DRAFT_PROFILE_URL', 'UCP_BUYER_AGENT_PROFILE_ENABLED'];

describe('GET /.well-known/ucp-agent-catalog-draft', () => {
  let saved;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../src/auroraBff/routes', () => ({ mountAuroraBffRoutes: () => {}, __internal: {} }));
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    jest.resetModules();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('dark by default: answered exactly as a path that does not exist', async () => {
    const app = require('../src/server');
    const resp = await request(app).get('/.well-known/ucp-agent-catalog-draft');
    const unknown = await request(app).get('/.well-known/no-such-path-for-this-test');
    expect(resp.status).toBe(404);
    expect(resp.status).toBe(unknown.status);
    expect(resp.headers['content-type']).toBe(unknown.headers['content-type']);
    expect(resp.text.split('/.well-known/ucp-agent-catalog-draft').join('PATH'))
      .toBe(unknown.text.split('/.well-known/no-such-path-for-this-test').join('PATH'));
  });

  test.each(['shadow', 'enforce'])('lit in %s: draft version, catalog capabilities only', async (mode) => {
    process.env.SHOPIFY_CATALOG_ATTRIBUTION = mode;
    process.env.SHOPIFY_CATALOG_DRAFT_PROFILE_URL = 'https://agent.example/.well-known/ucp-agent-catalog-draft';
    const app = require('../src/server');
    const resp = await request(app).get('/.well-known/ucp-agent-catalog-draft').set('Host', 'evil.example');
    expect(resp.status).toBe(200);
    expect(resp.body.ucp.version).toBe('draft');
    expect(Object.keys(resp.body.ucp.capabilities).sort()).toEqual([
      'dev.shopify.catalog.global', 'dev.ucp.shopping.catalog.lookup', 'dev.ucp.shopping.catalog.search',
    ]);
    expect(resp.body.ucp.profile_url).toBe('https://agent.example/.well-known/ucp-agent-catalog-draft');
    expect(JSON.stringify(resp.body)).not.toContain('evil.example');
  });

  test('no configured URL: no self-reference is invented from the Host header', async () => {
    process.env.SHOPIFY_CATALOG_ATTRIBUTION = 'shadow';
    const app = require('../src/server');
    const resp = await request(app).get('/.well-known/ucp-agent-catalog-draft').set('Host', 'agent.example');
    expect(resp.status).toBe(200);
    expect(resp.body.ucp.profile_url).toBeUndefined();
  });

  test('the store profile is unchanged and still dark by default', async () => {
    process.env.SHOPIFY_CATALOG_ATTRIBUTION = 'enforce';
    const app = require('../src/server');
    const resp = await request(app).get('/.well-known/ucp-agent');
    expect(resp.status).toBe(404);
  });
});
