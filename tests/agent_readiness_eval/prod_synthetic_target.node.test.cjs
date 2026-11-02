'use strict';

// FIRST: no test in this directory may reach a non-loopback host (see _net_guard.cjs).
require('./_net_guard.cjs');

// The production synthetic target (--target-kind prod-synthetic): the allowlist entry and its caps, the
// X-Pivota-Synthetic attestation and tool restriction in the client, the eval client's OAuth token
// (lib/oauth.cjs, oauth-login.cjs), and the preflight that runs before any tool call (lib/prodSynthetic.cjs).
// Production is NEVER dialled: every request goes to an injected fetch, every gcloud call to an injected
// function, and the loopback callback to 127.0.0.1.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveConfig, validateConfig } = require('../../scripts/agent-readiness-eval/lib/config.cjs');
const safety = require('../../scripts/agent-readiness-eval/lib/safety.cjs');
const { McpClient } = require('../../scripts/agent-readiness-eval/lib/mcpClient.cjs');
const oauth = require('../../scripts/agent-readiness-eval/lib/oauth.cjs');
const prodSynthetic = require('../../scripts/agent-readiness-eval/lib/prodSynthetic.cjs');
const oauthLogin = require('../../scripts/agent-readiness-eval/oauth-login.cjs');
const { main } = require('../../scripts/agent-readiness-eval/run.cjs');

const PROD = 'https://commerce.mcp.pivota.cc';
const ENDPOINT = `${PROD}/mcp`;
const CID = `mcpc_${'a1'.repeat(16)}`;
const CREDS = { READINESS_EVAL_OAUTH_CLIENT_ID: CID, READINESS_EVAL_OAUTH_CLIENT_SECRET: 'client-secret-for-tests' };
const FIVE = ['search_catalog', 'get_product', 'get_offers', 'get_alternatives', 'get_intel'];
const RUN_ARGV = ['--target-kind', 'prod-synthetic', '--tier', 'commerce', '--auth', 'bearer', '--base-url', PROD,
  '--journeys', 'discovery,follow,consistency', '--rps', '1', '--max-wall-seconds', '3000', '--limit', '20'];

const cfg = (argv, env = {}) => resolveConfig(argv, env);
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ---------------------------------------------------------------------------------------------------------------
// The allowlist entry and its caps.

test('allowlist: only https://commerce.mcp.pivota.cc (no port) is the production synthetic target', () => {
  for (const url of [PROD, ENDPOINT, `${PROD}/`]) {
    const r = safety.classifyTarget(url);
    assert.equal(r.ok, true, url);
    assert.equal(r.kind, 'prod-synthetic', url);
  }
  assert.match(safety.classifyTarget('http://commerce.mcp.pivota.cc/mcp').problem, /must be addressed over https/);
  assert.match(safety.classifyTarget('https://commerce.mcp.pivota.cc:8443/mcp').problem, /takes no port/);
  for (const url of ['https://mcp.pivota.cc/mcp', 'https://agent.pivota.cc/mcp', 'https://x.commerce.mcp.pivota.cc/mcp',
    'https://commerce.mcp.pivota.cc.evil.example/mcp', 'https://user@commerce.mcp.pivota.cc/mcp']) {
    assert.equal(safety.classifyTarget(url).ok, false, `${url} must be refused`);
  }
  // Injectable for tests, and empty means no production target at all.
  assert.equal(safety.classifyTarget(ENDPOINT, { prodSyntheticHosts: [] }).ok, false);
});

test('checkTarget: a well-formed production synthetic run passes, and each departure from it is refused', () => {
  assert.deepEqual(safety.checkTarget(cfg(RUN_ARGV)).problems, []);
  const refused = (extra, re) => assert.match(safety.checkTarget(cfg([...RUN_ARGV, ...extra])).problems.join('\n'), re, extra.join(' '));
  refused(['--target-kind', 'local'], /--target-kind must be prod-synthetic/);
  refused(['--tier', 'public'], /--tier commerce/);
  refused(['--mcp-path', '/mcp/v2'], /uses the \/mcp path/);
  refused(['--auth', 'api_key'], /--auth bearer/);
  refused(['--journeys', 'discovery,recommend'], /recommend journey/);
  refused(['--concurrency', '3'], /concurrency 3 exceeds/);
  refused(['--rps', '2'], /rps 2 exceeds/);
  refused(['--limit', '0'], /--limit 1\.\.200/);
  refused(['--limit', '201'], /--limit 1\.\.200/);
  refused(['--max-wall-seconds', '3001'], /--max-wall-seconds 1\.\.3000/);
  // A local target named prod-synthetic is refused the other way round.
  assert.match(safety.checkTarget(cfg(['--target-kind', 'prod-synthetic', '--base-url', 'http://127.0.0.1:1'])).problems.join('\n'), /--target-kind must be local/);
});

test('checkProdSynthetic: load mode never runs against production, check or run', () => {
  for (const checkClassification of [false, true]) {
    const c = { ...cfg(RUN_ARGV), checkClassification, load: { enabled: true } };
    assert.match(safety.checkProdSynthetic(c).join('\n'), /load mode never runs against production/);
  }
});

test('the classification check skips the run caps but keeps the tier, path and auth rules', () => {
  const check = (extra) => safety.checkTarget(cfg(['--target-kind', 'prod-synthetic', '--tier', 'commerce', '--auth', 'bearer', '--base-url', PROD, '--check-classification', ...extra])).problems;
  // The defaults (recommend journey, rps 4, no limit, an hour) would refuse a run.
  assert.deepEqual(check([]), []);
  assert.match(check(['--auth', 'none']).join('\n'), /--auth bearer/);
  assert.match(check(['--tier', 'public']).join('\n'), /--tier commerce/);
  assert.match(safety.checkTarget(cfg(['--target-kind', 'prod-synthetic', '--tier', 'commerce', '--auth', 'bearer', '--base-url', PROD])).problems.join('\n'), /recommend journey/);
});

test('config: prod-synthetic needs no bearer env; --check-classification is for prod-synthetic only', () => {
  assert.deepEqual(validateConfig(cfg(RUN_ARGV)), []);
  assert.match(validateConfig(cfg(['--auth', 'bearer', '--base-url', 'http://127.0.0.1:1'])).join('\n'), /auth=bearer needs READINESS_EVAL_BEARER_TOKEN/);
  assert.match(validateConfig(cfg(['--base-url', 'http://127.0.0.1:1', '--check-classification'])).join('\n'), /--check-classification is for --target-kind prod-synthetic/);
  assert.equal(cfg([], { READINESS_EVAL_CHECK_CLASSIFICATION: '1' }).checkClassification, true);
  assert.equal(cfg(['--oauth-token-file', '/x/t.json']).oauthTokenFile, '/x/t.json');
});

test('attestationFor: enforce only for a run, observe or enforce for the check; the clone header otherwise', () => {
  assert.deepEqual(safety.attestationFor('prod-synthetic'), { header: 'x-pivota-synthetic', values: ['enforce'] });
  assert.deepEqual(safety.attestationFor('prod-synthetic', { stage: 'check' }), { header: 'x-pivota-synthetic', values: ['observe', 'enforce'] });
  for (const kind of ['loopback', 'clone']) {
    for (const stage of ['run', 'check']) assert.deepEqual(safety.attestationFor(kind, { stage }), { header: 'x-pivota-deployment', values: ['eval-clone'] });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// A fake commerce door. It answers JSON-RPC with whatever state header the test sets, and records every request.

function fakeDoor({ state = 'enforce', tools = FIVE, stateFor = null } = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, method: body.method, auth: init.headers.authorization, redirect: init.redirect });
    const headers = { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' };
    const s = stateFor ? stateFor(body.method, seen.length) : state;
    if (s !== null) headers['x-pivota-synthetic'] = s;
    if (body.id === undefined) return new Response(null, { status: 202, headers });
    let result = {};
    if (body.method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: 'door', version: '1' }, capabilities: {} };
    if (body.method === 'tools/list') result = { tools: tools.map((name) => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } })) };
    if (body.method === 'tools/call') result = { content: [{ type: 'text', text: '{}' }], structuredContent: {} };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers });
  };
  return { seen, fetchImpl };
}

const client = (door, opts = {}) => new McpClient({ endpoint: ENDPOINT, auth: 'bearer', bearerToken: 'at-1', fetchImpl: door.fetchImpl, ...opts });

test('client: the production target needs the bearer, and calls only the four read tools a journey uses', async () => {
  assert.throws(() => new McpClient({ endpoint: ENDPOINT, fetchImpl: async () => {} }), /needs the eval OAuth bearer/);
  assert.throws(() => new McpClient({ endpoint: ENDPOINT, auth: 'api_key', apiKey: 'k', fetchImpl: async () => {} }), /needs the eval OAuth bearer/);
  const door = fakeDoor();
  const c = client(door);
  await c.initialize();
  for (const name of ['recommend_products', 'get_intel', 'create_checkout_session']) {
    await assert.rejects(c.callTool(name, {}), /is not an allowed tool/, name);
  }
  assert.equal(door.seen.filter((r) => r.method === 'tools/call').length, 0);
  for (const name of safety.PROD_SYNTHETIC_TOOLS) assert.equal((await c.callTool(name, {})).outcome, 'ok', name);
  // recommend_products stays allowed on loopback.
  const local = new McpClient({ endpoint: 'http://127.0.0.1:1/mcp', fetchImpl: door.fetchImpl });
  assert.ok(local.allowedTools.includes('recommend_products'));
});

// (fetch trims header whitespace, so a padded value cannot reach the client.)
for (const bad of [null, '', 'observe', 'off', 'invalid', 'ENFORCE', 'enforce,enforce']) {
  test(`client, run: a response marked ${JSON.stringify(bad)} halts the run and nothing more is sent`, async () => {
    const door = fakeDoor({ stateFor: (method) => (method === 'tools/call' ? bad : 'enforce') });
    const c = client(door);
    assert.equal((await c.initialize()).outcome, 'ok');
    const rec = await c.callTool('search_catalog', { query: 'q' });
    assert.equal(rec.outcome, 'attestation_missing');
    assert.equal(rec.attested, bad === null ? null : bad);
    assert.match(c.halted, /x-pivota-synthetic: enforce/);
    const before = door.seen.length;
    assert.equal((await c.callTool('search_catalog', { query: 'q' })).outcome, 'halted');
    assert.equal(door.seen.length, before, 'no request after the halt');
  });
}

test('client, check stage: observe is accepted for initialize and tools/list, and no tool is ever called', async () => {
  const door = fakeDoor({ state: 'observe' });
  const c = client(door, { stage: 'check' });
  assert.equal((await c.initialize()).outcome, 'ok');
  assert.equal((await c.listTools()).outcome, 'ok');
  await assert.rejects(c.callTool('search_catalog', { query: 'q' }), /a classification check calls no tool/);
  assert.deepEqual(door.seen.map((r) => r.method), ['initialize', 'notifications/initialized', 'tools/list']);
  // ... but the check still halts on anything that is neither observe nor enforce.
  const off = fakeDoor({ state: 'off' });
  const c2 = client(off, { stage: 'check' });
  assert.equal((await c2.initialize()).outcome, 'attestation_missing');
  // A run never accepts observe.
  const run = client(fakeDoor({ state: 'observe' }));
  assert.equal((await run.initialize()).outcome, 'attestation_missing');
});

test('client: the eval-clone header does not satisfy the production target, nor the reverse', async () => {
  const cloneHeader = async (url, init) => {
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-pivota-deployment': 'eval-clone' },
    });
  };
  assert.equal((await client({ fetchImpl: cloneHeader }).initialize()).outcome, 'attestation_missing');
  const local = new McpClient({ endpoint: 'http://127.0.0.1:1/mcp', fetchImpl: fakeDoor({ state: 'enforce' }).fetchImpl });
  assert.equal((await local.initialize()).outcome, 'attestation_missing');
});

// ---------------------------------------------------------------------------------------------------------------
// The eval client's OAuth token.

test('oauth: PKCE S256 matches the RFC 7636 appendix B vector', () => {
  const octets = Buffer.from([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]);
  const { verifier, challenge } = oauth.pkcePair(() => octets);
  assert.equal(verifier, 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const a = oauth.pkcePair();
  assert.notEqual(a.verifier, oauth.pkcePair().verifier, 'random by default');
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
});

test('oauth: the authorization URL is compiled in: our issuer, the loopback redirect, S256, the commerce resource', () => {
  const u = new URL(oauth.authorizeUrl({ clientId: CID, state: 'st', challenge: 'ch' }));
  assert.equal(`${u.origin}${u.pathname}`, 'https://api.pivota.cc/oauth/authorize');
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    response_type: 'code',
    client_id: CID,
    redirect_uri: 'http://127.0.0.1:8765/callback',
    scope: 'pivota.checkout',
    state: 'st',
    code_challenge: 'ch',
    code_challenge_method: 'S256',
    resource: 'https://commerce.mcp.pivota.cc/mcp',
  });
  assert.equal(oauth.OAUTH.issuer, 'https://api.pivota.cc');
  assert.ok(Object.isFrozen(oauth.OAUTH));
});

test('oauth: client credentials come from the environment, and the id must look like a registered client', () => {
  assert.deepEqual(oauth.clientCredentials(CREDS).problems, []);
  assert.match(oauth.clientCredentials({ ...CREDS, READINESS_EVAL_OAUTH_CLIENT_ID: 'mcpc_partner' }).problems.join('\n'), /mcpc_ \+ 32 hex/);
  assert.match(oauth.clientCredentials({ READINESS_EVAL_OAUTH_CLIENT_ID: CID }).problems.join('\n'), /CLIENT_SECRET is not set/);
});

function fakeTokenEndpoint(answer) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init, form: Object.fromEntries(new URLSearchParams(init.body)) });
    const [status, body] = typeof answer === 'function' ? answer(seen.length) : answer;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { seen, fetchImpl };
}

test('oauth: the code exchange posts to the token endpoint with Basic auth, the verifier and the resource; never follows a redirect', async () => {
  const ep = fakeTokenEndpoint([200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'pivota.checkout' }]);
  const token = await oauth.exchangeCode({ code: 'c-1', verifier: 'v-1', clientId: CID, clientSecret: 's/e:c', fetchImpl: ep.fetchImpl, now: () => 1_000_000_000 });
  const [req] = ep.seen;
  assert.equal(req.url, 'https://api.pivota.cc/oauth/token');
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.redirect, 'error');
  assert.equal(req.init.headers.authorization, `Basic ${Buffer.from(`${CID}:${encodeURIComponent('s/e:c')}`).toString('base64')}`);
  assert.deepEqual(req.form, {
    grant_type: 'authorization_code',
    code: 'c-1',
    redirect_uri: 'http://127.0.0.1:8765/callback',
    code_verifier: 'v-1',
    resource: 'https://commerce.mcp.pivota.cc/mcp',
  });
  assert.deepEqual(token, { issuer: 'https://api.pivota.cc', client_id: CID, access_token: 'at-1', refresh_token: 'rt-1', scope: 'pivota.checkout', expires_at: 1_000_000 + 3600 });
});

test('oauth: a refused exchange names the error code only, never a token or description from the body', async () => {
  for (const [status, body, re] of [
    [400, { error: 'invalid_grant', error_description: 'leaky-detail', access_token: 'at-LEAK' }, /token endpoint refused: invalid_grant$/],
    [500, 'not json', /token endpoint refused: http_500$/],
    [200, { token_type: 'bearer' }, /token endpoint refused: http_200$/],
  ]) {
    const ep = fakeTokenEndpoint([status, body]);
    await assert.rejects(oauth.exchangeCode({ code: 'c', verifier: 'v', clientId: CID, clientSecret: 's', fetchImpl: ep.fetchImpl }), (err) => {
      assert.match(err.message, re);
      assert.doesNotMatch(err.message, /LEAK|leaky/);
      return true;
    });
  }
});

test('oauth: the token file is 0600, written atomically, and never inside a git checkout', () => {
  const dir = tmp('re-oauth-');
  const file = path.join(dir, 'nested', 'token.json');
  oauth.writeToken(file, { issuer: oauth.OAUTH.issuer, client_id: CID, access_token: 'at', refresh_token: 'rt', expires_at: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['token.json'], 'no temp file left behind');
  assert.equal(oauth.readToken(file).access_token, 'at');

  const repo = tmp('re-oauth-repo-');
  fs.mkdirSync(path.join(repo, '.git'));
  assert.throws(() => oauth.writeToken(path.join(repo, 'a', 'token.json'), { issuer: oauth.OAUTH.issuer, access_token: 'at' }), /inside a git checkout/);
  assert.equal(fs.existsSync(path.join(repo, 'a')), false, 'nothing created inside the checkout');
  // This repository itself is a checkout.
  assert.throws(() => oauth.writeToken(path.join(__dirname, 'token.json'), { issuer: oauth.OAUTH.issuer, access_token: 'at' }), /inside a git checkout/);

  fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ issuer: 'https://as.example', access_token: 'at' }));
  assert.throws(() => oauth.readToken(path.join(dir, 'other.json')), /not an eval token for https:\/\/api\.pivota\.cc/);
});

function storedToken(dir, fields = {}) {
  const file = path.join(dir, 'token.json');
  oauth.writeToken(file, { issuer: oauth.OAUTH.issuer, client_id: CID, access_token: 'at-old', refresh_token: 'rt-old', scope: null, expires_at: 2_000_000, ...fields });
  return file;
}
const NOW = () => 2_000_000 * 1000;

test('ensureFreshToken: a token with enough life left is used as is, without a request', async () => {
  const file = storedToken(tmp('re-fresh-'), { expires_at: 2_000_000 + oauth.MIN_FRESH_SECONDS });
  const ep = fakeTokenEndpoint([500, {}]);
  const r = await oauth.ensureFreshToken({ file, env: {}, fetchImpl: ep.fetchImpl, now: NOW });
  assert.equal(r.refreshed, false);
  assert.equal(r.token.access_token, 'at-old');
  assert.equal(ep.seen.length, 0);
});

test('ensureFreshToken: a token near expiry is refreshed and stored; an unrotated refresh token is kept', async () => {
  for (const [answer, wantRt] of [[{ access_token: 'at-new', expires_in: 3600 }, 'rt-old'], [{ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }, 'rt-new']]) {
    const file = storedToken(tmp('re-fresh-'), { expires_at: 2_000_000 + oauth.MIN_FRESH_SECONDS - 1 });
    const ep = fakeTokenEndpoint([200, answer]);
    const r = await oauth.ensureFreshToken({ file, env: CREDS, fetchImpl: ep.fetchImpl, now: NOW });
    assert.equal(r.refreshed, true);
    assert.deepEqual(ep.seen[0].form, { grant_type: 'refresh_token', refresh_token: 'rt-old', resource: 'https://commerce.mcp.pivota.cc/mcp' });
    assert.equal(r.token.refresh_token, wantRt);
    assert.deepEqual(oauth.readToken(file), r.token, 'stored');
    assert.equal(r.token.expires_at, 2_000_000 + 3600);
  }
});

test('ensureFreshToken: refuses another client\'s token, a token without a refresh token, and a missing file', async () => {
  const stale = { expires_at: 2_000_000 };
  const ep = fakeTokenEndpoint([200, { access_token: 'at-new' }]);
  await assert.rejects(oauth.ensureFreshToken({ file: storedToken(tmp('re-fresh-'), { ...stale, client_id: `mcpc_${'b2'.repeat(16)}` }), env: CREDS, fetchImpl: ep.fetchImpl, now: NOW }), /belongs to another client/);
  await assert.rejects(oauth.ensureFreshToken({ file: storedToken(tmp('re-fresh-'), { ...stale, refresh_token: null }), env: CREDS, fetchImpl: ep.fetchImpl, now: NOW }), /no refresh token; sign in again/);
  await assert.rejects(oauth.ensureFreshToken({ file: storedToken(tmp('re-fresh-'), stale), env: {}, fetchImpl: ep.fetchImpl, now: NOW }), /CLIENT_ID/);
  await assert.rejects(oauth.ensureFreshToken({ file: path.join(tmp('re-fresh-'), 'none.json'), env: CREDS, fetchImpl: ep.fetchImpl }), /sign in first: node scripts\/agent-readiness-eval\/oauth-login\.cjs/);
  assert.equal(ep.seen.length, 0);
});

async function hitCallback(port, query) {
  // The server binds asynchronously: retry a refused connection briefly.
  for (let i = 0; ; i += 1) {
    try {
      return await fetch(`http://127.0.0.1:${port}/callback?${query}`);
    } catch (err) {
      if (i > 50) throw err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}
const freePort = () => 20000 + crypto.randomInt(20000);

test('awaitCallback: resolves with the code only for the expected state, on 127.0.0.1', async () => {
  const port = freePort();
  const cb = oauth.awaitCallback({ state: 's-ok', port, timeoutMs: 10000 });
  const res = await hitCallback(port, 'state=s-ok&code=c-42');
  assert.equal(res.status, 200);
  assert.equal(await cb.code, 'c-42');

  const port2 = freePort();
  const bad = oauth.awaitCallback({ state: 's-ok', port: port2, timeoutMs: 10000 });
  const rejected = assert.rejects(bad.code, /state mismatch or no code/);
  assert.equal((await hitCallback(port2, 'state=s-other&code=c-42')).status, 400);
  await rejected;

  const port3 = freePort();
  const denied = oauth.awaitCallback({ state: 's-ok', port: port3, timeoutMs: 10000 });
  const rejected3 = assert.rejects(denied.code, /access_denied/);
  await hitCallback(port3, 'state=s-ok&error=access_denied');
  await rejected3;

  await assert.rejects(oauth.awaitCallback({ state: 's', port: freePort(), timeoutMs: 30 }).code, /sign-in timed out/);
});

test('oauth-login: signs in, stores the token, and prints neither the token nor the secret', async () => {
  const dir = tmp('re-login-');
  const file = path.join(dir, 'token.json');
  const out = [];
  const err = [];
  const io = { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } };
  const ep = fakeTokenEndpoint([200, { access_token: 'at-SECRETVALUE', refresh_token: 'rt-SECRETVALUE', expires_in: 3600 }]);
  let state;
  const code = await oauthLogin.main(['--token-file', file], CREDS, io, {
    fetchImpl: ep.fetchImpl,
    awaitCallback: (opts) => {
      state = opts.state;
      return { code: Promise.resolve('code-1'), close() {} };
    },
  });
  assert.equal(code, 0, err.join(''));
  const printed = out.join('') + err.join('');
  assert.doesNotMatch(printed, /SECRETVALUE|client-secret-for-tests/);
  assert.match(printed, /refreshable/);
  const url = new URL(printed.match(/https:\/\/api\.pivota\.cc\/oauth\/authorize\S+/)[0]);
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(ep.seen[0].form.code, 'code-1');
  assert.equal(crypto.createHash('sha256').update(ep.seen[0].form.code_verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(oauth.readToken(file).access_token, 'at-SECRETVALUE');

  const unreachable = () => {
    throw new Error('no sign-in may start without client credentials');
  };
  assert.equal(await oauthLogin.main(['--token-file', file], {}, io, { awaitCallback: unreachable }), 2, 'no client credentials');
  assert.equal(await oauthLogin.main(['--token-file', path.join(dir, 't2.json')], CREDS, io, {
    awaitCallback: () => ({ code: Promise.reject(new Error('sign-in timed out')), close() {} }),
  }), 1);
  assert.equal(fs.existsSync(path.join(dir, 't2.json')), false);
});

// ---------------------------------------------------------------------------------------------------------------
// The preflight.

function service({ mode = 'enforce', secret = { name: 'assertion-secret-a', key: '1' }, ready = true, extraEnv = [], traffic = [{ percent: 100, latestRevision: true }] } = {}) {
  const env = [...extraEnv];
  if (mode !== null) env.push({ name: 'SYNTHETIC_TRAFFIC_MODE', value: mode });
  if (secret) env.push({ name: 'SYNTHETIC_ASSERTION_SECRET', valueFrom: { secretKeyRef: secret } });
  return {
    spec: { template: { spec: { containers: [{ env }] } } },
    status: { latestCreatedRevisionName: 'svc-00002', latestReadyRevisionName: ready ? 'svc-00002' : 'svc-00001', traffic },
  };
}

function fakeGcloud({ gateway = service(), web = service({ mode: null }) } = {}) {
  const calls = [];
  const gcloud = async (args) => {
    calls.push(args);
    const svc = args[3] === 'gateway' ? gateway : args[3] === 'web' ? web : null;
    if (!svc) throw new Error(`unexpected service ${args[3]}`);
    return JSON.stringify(svc);
  };
  return { calls, gcloud };
}

test('deploymentProblems: enforce and the same pinned secret version on both services is the only pass', async () => {
  const ok = fakeGcloud();
  assert.deepEqual(await prodSynthetic.deploymentProblems({ gcloud: ok.gcloud }), []);
  for (const args of ok.calls) {
    assert.deepEqual(args.slice(0, 3), ['run', 'services', 'describe']);
    assert.ok(args.includes('--project=pivota-prod') && args.includes('--region=us-west1') && args.includes('--format=json'));
  }
  assert.deepEqual(ok.calls.map((a) => a[3]).sort(), ['gateway', 'web']);

  const cases = [
    [{ gateway: service({ mode: 'observe' }) }, /SYNTHETIC_TRAFFIC_MODE is "observe", not "enforce"/],
    [{ gateway: service({ mode: null }) }, /SYNTHETIC_TRAFFIC_MODE is unset/],
    [{ gateway: service({ secret: null }) }, /the gateway mounts no SYNTHETIC_ASSERTION_SECRET/],
    [{ web: service({ mode: null, secret: null }) }, /the backend \(web\) mounts no SYNTHETIC_ASSERTION_SECRET/],
    [{ web: service({ mode: null, secret: { name: 'assertion-secret-a', key: '2' } }) }, /different SYNTHETIC_ASSERTION_SECRET versions/],
    [{ web: service({ mode: null, secret: { name: 'other-secret', key: '1' } }) }, /different SYNTHETIC_ASSERTION_SECRET versions/],
    [{ gateway: service({ secret: { name: 'assertion-secret-a', key: 'latest' } }), web: service({ mode: null, secret: { name: 'assertion-secret-a', key: 'latest' } }) }, /as "latest", not a pinned version number/],
    [{ gateway: service({ ready: false }) }, /the gateway's latest revision svc-00002 is not Ready/],
    [{ web: service({ mode: null, ready: false }) }, /the backend's latest revision svc-00002 is not Ready/],
    [{ gateway: service({ traffic: [{ percent: 90, latestRevision: true }, { percent: 10, revisionName: 'svc-00001' }] }) }, /the gateway does not serve all its traffic from its latest ready revision/],
    [{ web: service({ mode: null, traffic: [{ percent: 100, revisionName: 'svc-00001' }] }) }, /the backend does not serve all its traffic/],
    [{ web: service({ mode: null, traffic: [] }) }, /the backend does not serve all its traffic/],
  ];
  // Pinned by name to the latest ready revision, or a 0% tag on an old one, is fine.
  const pinned = service({ traffic: [{ percent: 100, revisionName: 'svc-00002' }, { percent: 0, revisionName: 'svc-00001', tag: 'old' }] });
  assert.deepEqual(await prodSynthetic.deploymentProblems({ gcloud: fakeGcloud({ gateway: pinned }).gcloud }), []);
  for (const [over, re] of cases) {
    assert.match((await prodSynthetic.deploymentProblems({ gcloud: fakeGcloud(over).gcloud })).join('\n'), re, String(re));
  }
  // A plain env value is not a mount.
  const plain = service({ secret: null, extraEnv: [{ name: 'SYNTHETIC_ASSERTION_SECRET', value: 'x' }] });
  assert.match((await prodSynthetic.deploymentProblems({ gcloud: fakeGcloud({ gateway: plain }).gcloud })).join('\n'), /the gateway mounts no/);
  assert.match((await prodSynthetic.deploymentProblems({ gcloud: async () => { throw new Error('not logged in'); } })).join('\n'), /could not read the deployment with gcloud \(not logged in\)/);
});

function preflightSetup({ checkClassification = false, door = fakeDoor(), gcloud = fakeGcloud(), tokenFields = {} } = {}) {
  const file = storedToken(tmp('re-pre-'), { expires_at: Math.floor(Date.now() / 1000) + 3600, ...tokenFields });
  const argv = [...RUN_ARGV, '--oauth-token-file', file, ...(checkClassification ? ['--check-classification'] : [])];
  return { config: cfg(argv), deps: { fetchImpl: door.fetchImpl, gcloud: gcloud.gcloud, oauthFetch: fakeTokenEndpoint([500, {}]).fetchImpl }, door, gcloud };
}

test('preflight, check: observe and exactly the five read tools pass, with no tool call and no gcloud read', async () => {
  const s = preflightSetup({ checkClassification: true, door: fakeDoor({ state: 'observe' }) });
  const r = await prodSynthetic.preflight({ config: s.config, env: CREDS, deps: s.deps });
  assert.deepEqual(r.problems, []);
  assert.equal(r.report.stage, 'check');
  assert.equal(r.report.state, 'observe');
  assert.deepEqual(r.report.tools, [...FIVE].sort());
  assert.equal(r.report.token.client_id, CID);
  assert.doesNotMatch(JSON.stringify(r.report), /at-old|rt-old/, 'the report carries no token');
  assert.deepEqual(s.door.seen.map((x) => x.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.ok(s.door.seen.every((x) => x.auth === 'Bearer at-old' && x.url === ENDPOINT && x.redirect === 'manual'));
  assert.equal(s.gcloud.calls.length, 0);
});

test('preflight, run: the deployment is read first, and a deployment not in enforce stops it before any MCP request', async () => {
  const s = preflightSetup({ gcloud: fakeGcloud({ gateway: service({ mode: 'observe' }) }) });
  const r = await prodSynthetic.preflight({ config: s.config, env: CREDS, deps: s.deps });
  assert.match(r.problems.join('\n'), /not "enforce"/);
  assert.equal(r.bearerToken, null);
  assert.equal(s.door.seen.length, 0);

  const ok = preflightSetup();
  const pass = await prodSynthetic.preflight({ config: ok.config, env: CREDS, deps: ok.deps });
  assert.deepEqual(pass.problems, []);
  assert.equal(pass.bearerToken, 'at-old');
  assert.equal(pass.report.state, 'enforce');
  assert.equal(ok.gcloud.calls.length, 2);
});

test('preflight, run: a door that says observe (deployment drifted, or another revision) refuses the run', async () => {
  const s = preflightSetup({ door: fakeDoor({ state: 'observe' }) });
  const r = await prodSynthetic.preflight({ config: s.config, env: CREDS, deps: s.deps });
  assert.match(r.problems.join('\n'), /^initialize: attestation_missing/);
  assert.equal(r.report.state, 'observe');
  assert.deepEqual(s.door.seen.map((x) => x.method), ['initialize']);
});

test('preflight: a tools/list that is not exactly the five read tools refuses (not the listed eval client)', async () => {
  for (const tools of [[...FIVE, 'create_checkout_session'], FIVE.slice(1), [...FIVE.slice(1), 'recommend_products'], []]) {
    const s = preflightSetup({ checkClassification: true, door: fakeDoor({ state: 'observe', tools }) });
    const r = await prodSynthetic.preflight({ config: s.config, env: CREDS, deps: s.deps });
    assert.match(r.problems.join('\n'), /this token is not the listed eval client/, tools.join(','));
    assert.equal(r.bearerToken, null);
  }
});

test('preflight: no header, or a header on initialize but not on tools/list, refuses', async () => {
  const none = preflightSetup({ checkClassification: true, door: fakeDoor({ state: null }) });
  const r1 = await prodSynthetic.preflight({ config: none.config, env: CREDS, deps: none.deps });
  assert.match(r1.problems.join('\n'), /^initialize: attestation_missing/);
  assert.equal(r1.report.state, null);

  const late = preflightSetup({ checkClassification: true, door: fakeDoor({ stateFor: (m) => (m === 'tools/list' ? null : 'observe') }) });
  const r2 = await prodSynthetic.preflight({ config: late.config, env: CREDS, deps: late.deps });
  assert.match(r2.problems.join('\n'), /^tools\/list: attestation_missing/);
});

test('preflight: an unusable token stops it before gcloud or the door', async () => {
  const s = preflightSetup({ tokenFields: { expires_at: 1, refresh_token: null } });
  const r = await prodSynthetic.preflight({ config: s.config, env: CREDS, deps: s.deps });
  assert.match(r.problems.join('\n'), /no refresh token/);
  assert.equal(s.door.seen.length + s.gcloud.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// run.cjs end to end, against the fake door.

function capture() {
  const out = [];
  const err = [];
  return { io: { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } }, out, err };
}

test('run.cjs --check-classification: prints the pass and exits 0 after initialize + tools/list only', async () => {
  const s = preflightSetup({ checkClassification: true, door: fakeDoor({ state: 'observe' }) });
  const file = s.config.oauthTokenFile;
  const c = capture();
  const code = await main(['--target-kind', 'prod-synthetic', '--tier', 'commerce', '--auth', 'bearer', '--base-url', PROD,
    '--check-classification', '--oauth-token-file', file, '--out', tmp('re-out-')], CREDS, c.io, s.deps);
  assert.equal(code, 0, c.err.join(''));
  const printed = JSON.parse(c.out.join(''));
  assert.equal(printed.classification_check, 'pass');
  assert.equal(printed.state, 'observe');
  assert.deepEqual(s.door.seen.map((x) => x.method), ['initialize', 'notifications/initialized', 'tools/list']);
});

test('run.cjs, run: a preflight refusal exits 2 with the state, and no tool is called', async () => {
  const s = preflightSetup({ door: fakeDoor({ state: 'observe' }) });
  const c = capture();
  const code = await main([...RUN_ARGV, '--oauth-token-file', s.config.oauthTokenFile, '--out', tmp('re-out-')], CREDS, c.io, s.deps);
  assert.equal(code, 2);
  assert.match(c.err.join(''), /REFUSED \(production synthetic preflight\)/);
  assert.match(c.err.join(''), /X-Pivota-Synthetic: observe/);
  assert.equal(s.door.seen.filter((x) => x.method === 'tools/call').length, 0);
});

test('run.cjs, run: a run whose state drops mid-run halts at the first unmarked response', async () => {
  let calls = 0;
  const door = fakeDoor({ stateFor: (method) => (method === 'tools/call' && (calls += 1) > 1 ? 'observe' : 'enforce') });
  const s = preflightSetup({ door });
  const c = capture();
  const code = await main([...RUN_ARGV, '--journeys', 'discovery', '--limit', '5', '--oauth-token-file', s.config.oauthTokenFile, '--out', tmp('re-out-')], CREDS, c.io, { ...s.deps, onRunDir: () => {} });
  assert.notEqual(code, 0);
  const toolCalls = door.seen.filter((x) => x.method === 'tools/call');
  assert.equal(toolCalls.length, 2, 'one marked call, then the unmarked one that halted the run');
  assert.ok(door.seen.every((x) => x.auth === 'Bearer at-old'));
});

// ---------------------------------------------------------------------------------------------------------------
// The canary: one call of one tool, with fixed ids, after the full preflight.

const CANARY_BASE = ['--target-kind', 'prod-synthetic', '--tier', 'commerce', '--auth', 'bearer', '--base-url', PROD];
const IDS = ['--canary-merchant-id', 'merch_test_1', '--canary-product-id', 'prod_test_1'];
// get_product takes only a pair the gateway serves on its unscoped detail lane.
const SEED_IDS = ['--canary-merchant-id', 'merch_obs_test1', '--canary-product-id', 'prod_test_1'];
const idsFor = (tool) => (tool === 'get_product' ? SEED_IDS : IDS);

test('canary config: each tool takes exactly its arguments, and the run caps do not apply', () => {
  const problems = (argv) => safety.checkTarget(cfg([...CANARY_BASE, ...argv])).problems;
  for (const tool of ['get_alternatives', 'get_product', 'get_offers']) {
    assert.deepEqual(problems(['--canary', tool, ...idsFor(tool)]), [], tool);
    assert.match(problems(['--canary', tool, '--canary-merchant-id', 'merch_test_1']).join('\n'), /needs --canary-product-id/);
    assert.match(problems(['--canary', tool, ...idsFor(tool), '--canary-query', 'q']).join('\n'), /takes no --canary-query/);
  }
  assert.deepEqual(problems(['--canary', 'search_catalog', '--canary-query', 'vitamin c serum']), []);
  assert.match(problems(['--canary', 'search_catalog', ...IDS, '--canary-query', 'q']).join('\n'), /takes no --canary-merchant-id[\s\S]*takes no --canary-product-id/);
  assert.match(problems(['--canary', 'search_catalog']).join('\n'), /needs --canary-query/);
  for (const tool of ['get_intel', 'recommend_products', 'create_checkout_session', 'constructor', '__proto__']) {
    assert.match(problems(['--canary', tool, ...IDS]).join('\n'), /--canary must be one of get_alternatives, get_product, search_catalog, get_offers/, tool);
  }
  assert.match(problems(['--canary', 'get_product', '--canary-merchant-id', 'a b', '--canary-product-id', 'p']).join('\n'), /--canary-merchant-id must be an id/);
  assert.match(problems(['--canary', 'get_product', '--canary-merchant-id', 'm', '--canary-product-id', 'x'.repeat(201)]).join('\n'), /--canary-product-id must be an id/);
  assert.match(problems(['--canary', 'search_catalog', '--canary-query', 'q'.repeat(201)]).join('\n'), /at most 200 printable/);
  assert.match(problems(['--canary', 'search_catalog', '--canary-query', 'a\u0007b']).join('\n'), /at most 200 printable/);
  assert.match(problems(['--canary', 'get_product', ...SEED_IDS, '--check-classification']).join('\n'), /separate steps/);
  // The tier/path/auth/load rules still apply.
  assert.match(problems(['--canary', 'get_product', ...SEED_IDS, '--auth', 'none']).join('\n'), /--auth bearer/);
  // Only for the production target, and canary arguments need --canary.
  assert.match(validateConfig(cfg(['--base-url', 'http://127.0.0.1:1', '--canary', 'get_product'])).join('\n'), /--canary is for --target-kind prod-synthetic/);
  assert.match(validateConfig(cfg([...CANARY_BASE, ...IDS])).join('\n'), /--canary-\* arguments need --canary <tool>/);
  assert.deepEqual(safety.canaryArguments('get_offers', { merchant_id: 'm', product_id: 'p', query: 'q', market: 'US' }), { merchant_id: 'm', product_id: 'p' });
});

async function runCanary(extra, { door = fakeDoor(), gcloud = fakeGcloud() } = {}) {
  const s = preflightSetup({ door, gcloud });
  const c = capture();
  const code = await main([...CANARY_BASE, '--oauth-token-file', s.config.oauthTokenFile, '--out', tmp('re-out-'), ...extra], CREDS, c.io, s.deps);
  return { code, c, door, gcloud, printed: code === 2 ? null : JSON.parse(c.out.join('')) };
}

test('canary: after the full preflight, exactly one tools/call with exactly the given ids, and its times are printed', async () => {
  const bodies = [];
  const base = fakeDoor();
  const door = { seen: base.seen, fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); return base.fetchImpl(url, init); } };
  const r = await runCanary(['--canary', 'get_offers', ...IDS], { door });
  assert.equal(r.code, 0, r.c.err.join(''));
  assert.deepEqual(door.seen.map((x) => x.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.deepEqual(bodies[3].params, { name: 'get_offers', arguments: { merchant_id: 'merch_test_1', product_id: 'prod_test_1' } });
  assert.equal(r.gcloud.calls.length, 2, 'the deployment was read');
  assert.equal(r.printed.canary, 'get_offers');
  assert.equal(r.printed.state, 'enforce');
  assert.equal(r.printed.is_error, false);
  assert.ok(Date.parse(r.printed.started_at) <= Date.parse(r.printed.finished_at));
  assert.equal(r.printed.preflight.state, 'enforce');
  assert.doesNotMatch(r.c.out.join(''), /at-old|rt-old/);
});

test('canary: a deployment not in enforce, or a door not saying enforce, makes no tool call', async () => {
  const a = await runCanary(['--canary', 'get_alternatives', ...IDS], { gcloud: fakeGcloud({ gateway: service({ mode: 'observe' }) }) });
  assert.equal(a.code, 2);
  assert.equal(a.door.seen.length, 0);
  const b = await runCanary(['--canary', 'get_alternatives', ...IDS], { door: fakeDoor({ state: 'observe' }) });
  assert.equal(b.code, 2);
  assert.equal(b.door.seen.filter((x) => x.method === 'tools/call').length, 0);
});

test('canary: an unmarked answer to the call exits 3; a tool error exits 1 with its code', async () => {
  const halted = await runCanary(['--canary', 'get_product', ...SEED_IDS], { door: fakeDoor({ stateFor: (m) => (m === 'tools/call' ? 'observe' : 'enforce') }) });
  assert.equal(halted.code, 3);
  assert.equal(halted.printed.outcome, 'attestation_missing');
  assert.equal(halted.printed.state, 'observe');

  const base = fakeDoor();
  const erroring = {
    seen: base.seen,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method !== 'tools/call') return base.fetchImpl(url, init);
      base.seen.push({ method: body.method });
      const result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'PRODUCT_NOT_FOUND' } }) }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'content-type': 'application/json', 'x-pivota-synthetic': 'enforce' } });
    },
  };
  const err = await runCanary(['--canary', 'get_product', ...SEED_IDS], { door: erroring });
  assert.equal(err.code, 1);
  assert.equal(err.printed.is_error, true);
  assert.equal(err.printed.error_code, 'PRODUCT_NOT_FOUND');
});

test('canary get_product: only a seed-supply pair the gateway serves unscoped (the loopback lane), never a merchant scope', () => {
  const problems = (m, pid) => safety.checkTarget(cfg([...CANARY_BASE, '--canary', 'get_product', '--canary-merchant-id', m, '--canary-product-id', pid])).problems;
  assert.deepEqual(problems('merch_obs_test1', 'ext_test_1'), [], 'an observed seller, any id');
  assert.deepEqual(problems('external_seed', 'sig_test1'), [], 'the shared bucket with a sig_ id');
  for (const [m, pid] of [['merch_test_1', 'prod_test_1'], ['merch_test_1', 'sig_test1'], ['external_seed', 'ext_test_1'], ['merch_obsx', 'sig_test1']]) {
    assert.match(problems(m, pid).join('\n'), /takes a seed-supply pair/, `${m} ${pid}`);
  }
  // The same rule the gateway's get_product_detail routes on.
  const { isSeedSupplyUnservableUpstream } = require('../../src/services/externalSeedLane');
  assert.equal(isSeedSupplyUnservableUpstream('merch_obs_a', 'p'), true);
  assert.equal(isSeedSupplyUnservableUpstream('external_seed', 'sig_a'), true);
  assert.equal(isSeedSupplyUnservableUpstream('external_seed', 'ext_a'), false);
  assert.equal(isSeedSupplyUnservableUpstream('', 'sig_a'), false);
  assert.equal(isSeedSupplyUnservableUpstream('merch_a', 'sig_a'), false);
});

test('prod-synthetic journeys declare no market on any call, search or follow, even for a market query', async () => {
  const bodies = [];
  const base = fakeDoor();
  const door = {
    seen: base.seen,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.method === 'tools/call' && body.params.name === 'search_catalog') {
        base.seen.push({ method: body.method, auth: init.headers.authorization });
        const products = [{ product_id: 'prod_test_1', merchant_id: 'merch_test_1', title: 'Test Serum', brand: 'Test', price: { amount: 10, currency: 'USD' } }];
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{}' }], structuredContent: { status: 'success', products, total: 1 } } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-pivota-synthetic': 'enforce' },
        });
      }
      return base.fetchImpl(url, init);
    },
  };
  const s = preflightSetup({ door });
  const c = capture();
  const code = await main([...RUN_ARGV, '--journeys', 'discovery,follow', '--markets', 'US,GB', '--limit', '3', '--follow-sample', '1', '--follow-top', '1',
    '--oauth-token-file', s.config.oauthTokenFile, '--out', tmp('re-out-')], CREDS, c.io, s.deps);
  assert.ok([0, 1].includes(code), c.err.join(''));
  const calls = bodies.filter((b) => b.method === 'tools/call');
  assert.ok(calls.some((b) => b.params.name === 'search_catalog') && calls.some((b) => b.params.name === 'get_offers'), calls.map((b) => b.params.name).join(','));
  for (const b of calls) assert.equal('market' in b.params.arguments, false, `${b.params.name}: ${JSON.stringify(b.params.arguments)}`);
});

test('gcloud runs without the harness\'s secrets in its environment', async () => {
  const env = { PATH: '/bin', HOME: '/h', READINESS_EVAL_OAUTH_CLIENT_SECRET: 's', READINESS_EVAL_OAUTH_CLIENT_ID: CID, READINESS_EVAL_BEARER_TOKEN: 't', READINESS_EVAL_API_KEY: 'k', READINESS_EVAL_CALLER_KEYS: 'a,b', READINESS_EVAL_LIMIT: '3' };
  let seen;
  const out = await prodSynthetic.runGcloud(['run', 'services', 'describe', 'x'], {
    env,
    execFileImpl: (cmd, args, opts, cb) => {
      seen = { cmd, args, opts };
      cb(null, '{}');
    },
  });
  assert.equal(out, '{}');
  assert.equal(seen.cmd, 'gcloud');
  assert.deepEqual(seen.opts.env, { PATH: '/bin', HOME: '/h', READINESS_EVAL_LIMIT: '3' });
});

test('oauth-login --logout deletes the stored eval token, and only an eval token', async () => {
  const dir = tmp('re-logout-');
  const file = storedToken(dir);
  const c = capture();
  assert.equal(await oauthLogin.main(['--logout', '--token-file', file], {}, c.io), 0);
  assert.equal(fs.existsSync(file), false);
  assert.match(c.out.join(''), /Deleted the eval token/);
  assert.equal(await oauthLogin.main(['--logout', '--token-file', file], {}, c.io), 0);
  assert.match(c.out.join(''), /No eval token/);
  const other = path.join(dir, 'other.json');
  fs.writeFileSync(other, '{"not":"a token"}');
  await assert.rejects(oauthLogin.main(['--logout', '--token-file', other], {}, c.io), /not an eval token/);
  assert.equal(fs.existsSync(other), true);
});

test('a production halt says the call was not marked synthetic', async () => {
  const c = client(fakeDoor({ state: 'observe' }));
  assert.match((await c.initialize()).error, /not marked as a synthetic call$/);
  const local = new McpClient({ endpoint: 'http://127.0.0.1:1/mcp', fetchImpl: fakeDoor({ state: null }).fetchImpl });
  assert.match((await local.initialize()).error, /not provably the eval deployment$/);
});

test('withoutMarket: a query loses its market and any market among its own arguments, and keeps the rest', () => {
  const { withoutMarket } = require('../../scripts/agent-readiness-eval/lib/journeys.cjs');
  const q = { id: 'q1', text: 'serum', market: 'GB', args: { market: 'GB', price_max: 30 } };
  assert.deepEqual(withoutMarket(q), { id: 'q1', text: 'serum', market: null, args: { price_max: 30 } });
  assert.deepEqual(q.args, { market: 'GB', price_max: 30 }, 'the query set itself is untouched');
  assert.deepEqual(withoutMarket({ id: 'q2', text: 't', market: null }), { id: 'q2', text: 't', market: null, args: {} });
});
