// AgenPas mounted in the real gateway app (src/server.js; docs/agenpas.md). Dark by default: every /agenpas path
// answers exactly what an unknown path answers. Lit with dev fixtures (local only): the page, its assets and its API
// answer, and nothing reaches the backend. Loopback only.
const net = require('node:net');
const request = require('supertest');

// RAW requests: the request line goes out byte for byte (supertest's URL handling would resolve dot segments and
// re-encode), which is what a path-traversal probe needs. Returns { status, headers, body }.
function rawRequest(app, requestText) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const socket = net.connect(server.address().port, '127.0.0.1');
      let buf = '';
      socket.on('data', (d) => { buf += d.toString('latin1'); });
      socket.on('end', () => {
        server.close();
        const [head, ...rest] = buf.split('\r\n\r\n');
        const lines = head.split('\r\n');
        const headers = {};
        for (const l of lines.slice(1)) {
          const i = l.indexOf(':');
          if (i > 0) headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
        }
        resolve({ status: Number((lines[0] || '').split(' ')[1]), headers, body: rest.join('\r\n\r\n') });
      });
      socket.on('error', (err) => { server.close(); reject(err); });
      socket.write(requestText);
    });
  });
}
const rawGet = (app, path, host, extra = '') => rawRequest(app, `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`);

// The reviewer's traversal probes (review round 2, P1-1) and their encoded variants.
const TRAVERSALS = [
  '/agenpas/..%2findex.html', '/agenpas/..%2F/', '/agenpas/..%2F', '/agenpas//..%2findex.html', '/agenpas/%2e%2e%2findex.html',
  '/agenpas/x/..%2f..%2findex.html', '/agenpas/p/..%2f..%2findex.html', '/agenpas/assets/..%2f..%2findex.html',
  '/agenpas/../index.html', '/agenpas/%2e%2e/index.html', '/agenpas/.%2e/index.html', '/agenpas/%2E%2E%2Findex.html',
  '/agenpas/..%5cindex.html', '/agenpas/..%5Cindex.html', '/agenpas/..\\index.html', '/agenpas/%252e%252e%252findex.html',
  '/agenpas/..%252findex.html', '/agenpas/./assets/app.js', '/agenpas/assets/app.js/', '/agenpas/assets//app.js',
  '/agenpas/..%2fhealth', '/agenpas/..%2fcatalog-image-cache%2fx', '/agenpas/..%2f..%2fpackage.json',
  '/agenpas/p/ap_000000000000000000000001%2f..%2f..%2findex.html', '/agenpas', '/agenpas/',
  // Encoded spellings of LEGITIMATE shapes: refused undecoded, so a decode-first refactor cannot slip (v3 P3-3).
  '/agenpas/assets/app%2ejs', '/agenpas/ass%65ts/app.js', '/agenpas/%61ssets/app.css', '/agenpas/api/p/ap_000000000000000000000001%00',
  '/agenpas/p/ap_00000000000000000000000%31', '/agenpas/p/.', '/agenpas/p/..',
];

const KEYS = [
  'AGENPAS_ENABLED', 'AGENPAS_LINK_SECRET', 'AGENPAS_PUBLIC_BASE_URL', 'AGENPAS_HOSTED_HOSTS', 'AGENPAS_DEV_FIXTURES',
  'AGENPAS_EMBED_HOSTED_PAGES', 'AGENPAS_LINK_TTL_SECONDS', 'AGENPAS_INTERNAL_READ_KEY',
  'AGENPAS_CONSENT_ENABLED', 'AGENPAS_LEGAL_HOSTS', 'AGENPAS_RAILS', 'AGENPAS_INTERNAL_CONSENT_KEY',
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

  test('the AgenPas host is exclusive: every non-AgenPas path is 404 there, and other hosts are unchanged', async () => {
    const app = require('../src/server');
    const OTHER_PATHS = ['/', '/index.html', '/health', '/api/merchant/disputes', '/mcp', '/agenpas/not-a-route'];
    const strip = (r) => ({ status: r.status, type: r.headers['content-type'], text: r.text });
    // Flag off first: the baseline for every host.
    const before = {};
    for (const host of ['agenpas.example', 'gateway.example']) {
      for (const p of OTHER_PATHS) before[`${host}${p}`] = strip(await request(app).get(p).set('Host', host));
    }
    process.env.AGENPAS_ENABLED = '1';
    process.env.AGENPAS_LINK_SECRET = 'server-mount-test-secret-0123456789abcdef';
    process.env.AGENPAS_PUBLIC_BASE_URL = 'https://agenpas.example';
    for (const p of OTHER_PATHS) {
      for (const method of ['get', 'post', 'options']) {
        const res = await request(app)[method](p).set('Host', 'agenpas.example');
        expect([p, method, res.status]).toEqual([p, method, 404]);
        expect(res.text.includes('Internal UI')).toBe(false);
        expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      }
    }
    // A non-GET on an AgenPas path, and a case variant, are refused there too.
    expect((await request(app).post('/agenpas/api/p/ap_000000000000000000000001').set('Host', 'agenpas.example')).status).toBe(404);
    expect((await request(app).get('/AGENPAS/assets/app.js').set('Host', 'agenpas.example')).status).toBe(404);
    // AgenPas itself still answers there.
    expect((await request(app).get('/agenpas/assets/app.js').set('Host', 'agenpas.example')).status).toBe(200);
    // Every other host: exactly what it answered with the flag off.
    for (const p of OTHER_PATHS) {
      const now = strip(await request(app).get(p).set('Host', 'gateway.example'));
      const then = before[`gateway.example${p}`];
      if (p === '/health') expect(now.status).toBe(then.status);
      else expect(now).toEqual(then);
    }
    // And with the flag off, the AgenPas host is an ordinary host again.
    delete process.env.AGENPAS_ENABLED;
    for (const p of OTHER_PATHS) {
      const now = strip(await request(app).get(p).set('Host', 'agenpas.example'));
      const then = before[`agenpas.example${p}`];
      if (p === '/health') expect(now.status).toBe(then.status);
      else expect(now).toEqual(then);
    }
    expect(before['agenpas.example/'].status).toBe(200);
  });

  describe('the AgenPas host, lit (review round 2)', () => {
    let app;
    beforeEach(() => {
      process.env.AGENPAS_ENABLED = '1';
      process.env.AGENPAS_LINK_SECRET = 'server-mount-test-secret-0123456789abcdef';
      process.env.AGENPAS_PUBLIC_BASE_URL = 'https://agenpas.example';
      app = require('../src/server');
    });

    test.each(TRAVERSALS)('traversal %s on the AgenPas host: refused by the front guard, never the internal UI', async (p) => {
      for (const host of ['agenpas.example', 'AGENPAS.Example', 'agenpas.example:443', 'agenpas.example.', 'agenpas.example:8443']) {
        const res = await rawGet(app, p, host);
        expect([p, host, res.status]).toEqual([p, host, 404]);
        expect(res.body.includes('Internal UI')).toBe(false);
        expect(res.headers['x-agenpas-guard']).toBe('front');
        expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      }
    });

    test('an absolute-form request line is judged by its path and the Host header', async () => {
      const abs = await rawGet(app, 'http://x/agenpas/..%2findex.html', 'agenpas.example');
      expect(abs.status).toBe(404);
      expect(abs.headers['x-agenpas-guard']).toBe('front');
      const absOk = await rawGet(app, 'https://agenpas.example/agenpas/assets/app.js', 'agenpas.example');
      expect(absOk.status).toBe(200);
      const absRoot = await rawGet(app, 'http://gateway.example/', 'agenpas.example');
      expect(absRoot.status).toBe(404);
    });

    test('host variants of the AgenPas host get nothing but AgenPas (:443 and a trailing dot serve it; :8443 serves nothing)', async () => {
      for (const host of ['agenpas.example:443', 'agenpas.example.', 'AGENPAS.EXAMPLE']) {
        expect((await rawGet(app, '/', host)).status).toBe(404);
        expect((await rawGet(app, '/agenpas/assets/app.js', host)).status).toBe(200);
      }
      const otherPort = await rawGet(app, '/agenpas/assets/app.js', 'agenpas.example:8443');
      expect(otherPort.status).toBe(404);
      expect((await rawGet(app, '/', 'agenpas.example:8443')).headers['x-agenpas-guard']).toBe('front');
    });

    test('X-Forwarded-Host is ignored: only the Host header decides', async () => {
      const spoofIn = await rawGet(app, '/', 'gateway.example', 'X-Forwarded-Host: agenpas.example\r\n');
      expect(spoofIn.status).toBe(200);
      expect(spoofIn.body.includes('Internal UI')).toBe(true);
      const spoofOut = await rawGet(app, '/', 'agenpas.example', 'X-Forwarded-Host: gateway.example\r\n');
      expect(spoofOut.status).toBe(404);
      expect(spoofOut.headers['x-agenpas-guard']).toBe('front');
    });

    test('the AgenPas stylesheet, an admitted shape, passes both locks (front guard, static host gate) and is served', async () => {
      const res = await rawGet(app, '/agenpas/assets/app.css', 'agenpas.example');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/css/);
    });
  });

  describe('the internal UI static host gate, on its own (front guard bypassed)', () => {
    // The real gate from src/server.js, mounted on a bare app with NO front guard in front of it: the only thing
    // between these requests and public/index.html is the gate itself.
    let bare;
    beforeEach(() => {
      process.env.AGENPAS_ENABLED = '1';
      process.env.AGENPAS_LINK_SECRET = 'server-mount-test-secret-0123456789abcdef';
      process.env.AGENPAS_PUBLIC_BASE_URL = 'https://agenpas.example';
      const { internalUiStaticGate } = require('../src/server')._debug;
      const express = require('express');
      bare = express();
      bare.use(internalUiStaticGate);
      bare.use((req, res) => res.status(404).type('text/plain').send('fell through'));
    });

    test.each(['/', '/index.html', '/agenpas/..%2findex.html', '/agenpas/x/..%2f..%2findex.html'])('%s on the AgenPas host: no internal UI', async (p) => {
      for (const host of ['agenpas.example', 'AGENPAS.EXAMPLE', 'agenpas.example:443', 'agenpas.example.', 'agenpas.example:8443']) {
        const res = await rawGet(bare, p, host);
        expect(res.body.includes('Internal UI')).toBe(false);
        expect(res.body).toBe('fell through');
      }
    });

    test('another host still gets the internal UI from the same gate (the control)', async () => {
      const res = await rawGet(bare, '/index.html', 'gateway.example');
      expect(res.status).toBe(200);
      expect(res.body.includes('Internal UI')).toBe(true);
    });
  });

  test('a malformed purchase id on the AgenPas host gets the friendly "isn\'t valid" page', async () => {
    process.env.AGENPAS_ENABLED = '1';
    process.env.AGENPAS_LINK_SECRET = 'server-mount-test-secret-0123456789abcdef';
    process.env.AGENPAS_PUBLIC_BASE_URL = 'https://agenpas.example';
    const app = require('../src/server');
    for (const id of ['not_an_id', 'ap_123', 'AP_000000000000000000000001']) {
      const res = await rawGet(app, `/agenpas/p/${id}`, 'agenpas.example');
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toMatch(/isn&#39;t valid|isn't valid/);
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
      expect(res.headers['x-agenpas-guard']).toBeUndefined();
    }
  });

  test('the back guard answers on the AgenPas host for an admitted path the router did not serve', async () => {
    process.env.AGENPAS_ENABLED = '1';
    process.env.AGENPAS_LINK_SECRET = 'server-mount-test-secret-0123456789abcdef';
    process.env.AGENPAS_DEV_FIXTURES = '1';
    process.env.AGENPAS_PUBLIC_BASE_URL = 'http://localhost:4000';
    const app = require('../src/server');
    // /agenpas/dev/start is admitted (fixtures armed, loopback Host); an unknown scenario is not served by the router.
    const res = await rawGet(app, '/agenpas/dev/start?scenario=no-such-scenario', 'localhost:4000');
    expect(res.status).toBe(404);
    expect(res.headers['x-agenpas-guard']).toBe('back');
    expect(res.body).toBe('Not found');
    // Off a loopback Host the same path is the front guard's.
    process.env.AGENPAS_PUBLIC_BASE_URL = 'https://agenpas.example';
    const front = await rawGet(app, '/agenpas/dev/start?scenario=happy', 'agenpas.example');
    expect(front.headers['x-agenpas-guard']).toBe('front');
  });

  describe('terms and privacy consent (AGENPAS_CONSENT_ENABLED)', () => {
    const CONSENT_PID = 'rp_000000000000000000000007';
    const CONSENT_PATH = `/agenpas/api/p/${CONSENT_PID}/consent`;

    test('off: a consent POST is the front guard\'s 404 on the AgenPas host, and with AgenPas off it is any unknown POST', async () => {
      const app = require('../src/server');
      const baseline = await request(app).post('/agenpas-path-that-never-existed/consent').set('Host', 'agenpas.example').send({ step: 'card_binding' });
      const dark = await request(app).post(CONSENT_PATH).set('Host', 'agenpas.example').send({ step: 'card_binding' });
      expect(dark.status).toBe(baseline.status);
      expect(dark.headers['content-type']).toBe(baseline.headers['content-type']);
      expect(dark.text.replace(CONSENT_PATH, '<path>')).toBe(baseline.text.replace('/agenpas-path-that-never-existed/consent', '<path>'));
      process.env.AGENPAS_ENABLED = '1';
      process.env.AGENPAS_LINK_SECRET = 'server-mount-test-secret-0123456789abcdef';
      process.env.AGENPAS_PUBLIC_BASE_URL = 'https://agenpas.example';
      const lit = await request(app).post(CONSENT_PATH).set('Host', 'agenpas.example').set('Origin', 'https://agenpas.example')
        .set('Sec-Fetch-Site', 'same-origin').send({ step: 'card_binding' });
      expect(lit.status).toBe(404);
      expect(lit.headers['x-agenpas-guard']).toBe('front');
      const preflight = await request(app).options(CONSENT_PATH).set('Host', 'agenpas.example').set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(preflight.status).toBe(404);
      expect(preflight.headers['x-agenpas-guard']).toBe('front');
    });

    test('on, with dev fixtures: offer -> POST -> the hosted page appears; OPTIONS refused; the global parser skips the host (1 kB route limit)', async () => {
      process.env.AGENPAS_ENABLED = '1';
      process.env.AGENPAS_LINK_SECRET = 'server-mount-test-secret-0123456789abcdef';
      process.env.AGENPAS_DEV_FIXTURES = '1';
      process.env.AGENPAS_HOSTED_HOSTS = 'hosted.example';
      process.env.AGENPAS_PUBLIC_BASE_URL = 'http://localhost:4000';
      process.env.AGENPAS_CONSENT_ENABLED = '1';
      const app = require('../src/server');
      const HOST = 'localhost:4000';
      const start = await request(app).get('/agenpas/dev/start?scenario=consent').set('Host', HOST);
      expect(start.status).toBe(302);
      const token = new URLSearchParams(new URL(start.headers.location, 'http://localhost').hash.slice(1)).get('t');
      const before = await request(app).get(`/agenpas/api/p/${CONSENT_PID}`).set('Host', HOST).set('X-Agenpas-Link', token);
      expect(before.status).toBe(200);
      expect(before.body.screen).toBe('add_card');
      expect(before.body.action).toBeNull();
      expect(before.body.consent.step).toBe('card_binding');
      const post = (body, extra = {}) => {
        let r = request(app).post(CONSENT_PATH).set('Host', HOST).set('X-Agenpas-Link', token)
          .set('Origin', 'http://localhost:4000').set('Sec-Fetch-Site', 'same-origin');
        for (const [k, v] of Object.entries(extra)) r = r.set(k, v);
        return r.send(body);
      };
      const offer = before.body.consent.offer;
      // A VALID body padded with 2 kB of whitespace: the route's own 1 kB parser refuses it (413). Had the app's 10 MB
      // parser read it first, it would parse to a small, valid body and be recorded.
      const padded = `{"step":"card_binding",${' '.repeat(2048)}"offer_id":${JSON.stringify(offer.id)},"issued_at":${JSON.stringify(offer.issued_at)}}`;
      const big = await post(padded, { 'Content-Type': 'application/json' });
      expect(big.status).toBe(413);
      expect((await post('step=card_binding', { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415);
      expect((await request(app).options(CONSENT_PATH).set('Host', HOST)).headers['x-agenpas-guard']).toBe('front');
      const ok = await post({ step: 'card_binding', offer_id: offer.id, issued_at: offer.issued_at });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ recorded: true });
      const after = await request(app).get(`/agenpas/api/p/${CONSENT_PID}`).set('Host', HOST).set('X-Agenpas-Link', token);
      expect(after.body.screen).toBe('add_card');
      expect(after.body.action.url).toMatch(/^https:\/\/hosted\.example\//);
      expect(after.body.consent).toBeNull();
    });
  });

  test('lit with dev fixtures: page, assets and API answer', async () => {
    process.env.AGENPAS_ENABLED = '1';
    process.env.AGENPAS_LINK_SECRET = 'server-mount-test-secret-0123456789abcdef';
    process.env.AGENPAS_DEV_FIXTURES = '1';
    process.env.AGENPAS_HOSTED_HOSTS = 'hosted.example';
    process.env.AGENPAS_PUBLIC_BASE_URL = 'http://localhost:4000';
    const app = require('../src/server');
    const HOST = 'localhost:4000';
    // Not the public host: not served.
    expect((await request(app).get('/agenpas/assets/app.js').set('Host', 'other.example')).status).toBe(404);
    const start = await request(app).get('/agenpas/dev/start?scenario=happy').set('Host', HOST);
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.location, 'http://localhost');
    expect(loc.search).toBe('');
    const token = new URLSearchParams(loc.hash.slice(1)).get('t');
    const page = await request(app).get(loc.pathname).set('Host', HOST);
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    expect((await request(app).get('/agenpas/assets/app.js').set('Host', HOST)).status).toBe(200);
    const api = await request(app).get(`/agenpas/api/p/${PID}`).set('Host', HOST).set('X-Agenpas-Link', token);
    expect(api.status).toBe(200);
    expect(api.body.purchase_id).toBe(PID);
    expect(typeof api.body.screen).toBe('string');
  });
});
