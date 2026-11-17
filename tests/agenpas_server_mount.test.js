// AgenPas mounted in the real gateway app (src/server.js; docs/agenpas.md). Dark by default: every /agenpas path
// answers exactly what an unknown path answers. Lit with dev fixtures (local only): the page, its assets and its API
// answer, and nothing reaches the backend. Loopback only.
const request = require('supertest');

const KEYS = [
  'AGENPAS_ENABLED', 'AGENPAS_LINK_SECRET', 'AGENPAS_PUBLIC_BASE_URL', 'AGENPAS_HOSTED_HOSTS', 'AGENPAS_DEV_FIXTURES',
  'AGENPAS_EMBED_HOSTED_PAGES', 'AGENPAS_LINK_TTL_SECONDS',
];
const PID = 'ap_000000000000000000000001';

describe('AgenPas routes in the gateway app', () => {
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

  test('dark by default: each AgenPas path answers like a path that never existed', async () => {
    const app = require('../src/server');
    const baseline = await request(app).get('/agenpas-path-that-never-existed');
    for (const p of [`/agenpas/p/${PID}`, `/agenpas/api/p/${PID}`, '/agenpas/assets/app.js', '/agenpas/dev/start']) {
      const resp = await request(app).get(p);
      expect(resp.status).toBe(baseline.status);
      expect(resp.headers['content-type']).toBe(baseline.headers['content-type']);
      expect(resp.headers['content-security-policy']).toBe(baseline.headers['content-security-policy']);
      expect(resp.text.replace(p.split('?')[0], '<path>')).toBe(baseline.text.replace('/agenpas-path-that-never-existed', '<path>'));
    }
  });

  test('lit with dev fixtures: page, assets and API answer', async () => {
    process.env.AGENPAS_ENABLED = '1';
    process.env.AGENPAS_LINK_SECRET = 'server-mount-test-secret-0123456789abcdef';
    process.env.AGENPAS_DEV_FIXTURES = '1';
    process.env.AGENPAS_HOSTED_HOSTS = 'hosted.example';
    const app = require('../src/server');
    const start = await request(app).get('/agenpas/dev/start?scenario=happy');
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.location, 'http://localhost');
    expect(loc.search).toBe('');
    const token = new URLSearchParams(loc.hash.slice(1)).get('t');
    const page = await request(app).get(loc.pathname);
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    expect((await request(app).get('/agenpas/assets/app.js')).status).toBe(200);
    const api = await request(app).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token);
    expect(api.status).toBe(200);
    expect(api.body.purchase_id).toBe(PID);
    expect(typeof api.body.screen).toBe('string');
  });
});
