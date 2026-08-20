'use strict';

/*
 * /ui/chat must never reach an LLM without a credential.
 *
 * Regression pin for the 2026-08-20 finding: `POST https://mcp.pivota.cc/ui/chat` with
 * `{"messages":[{"role":"user","content":"..."}]}` and NO credential returned 200 and a model
 * answer. The tell that the gate was absent rather than lenient was that an empty body came back
 * 400 "Body must have a messages array" — application validation, reached before any auth.
 *
 * HOW THESE TESTS KNOW THE LLM WAS NOT REACHED, rather than just reading a status code: this file
 * boots the server with NO LLM provider configured, so getUiChatLlmClient() throws and any request
 * that gets past the guard lands in the route's catch and answers 500 INTERNAL_ERROR. So "reached
 * the agent loop" has its own distinct, observable status. Delete the guard from server.js and every
 * refusal case below turns into that 500 and fails. The last test is the positive control that
 * proves 500 really is what a permitted request produces here — without it, a mutant that made the
 * whole route 404 unconditionally would pass every other assertion in the file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');

const { decideUiChatAccess } = require('../src/services/uiChatAccessGuard');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.PUBLIC_READ_MCP_HOSTS = 'mcp.pivota.cc';
// Left UNSET on purpose. The public-host refusal must not depend on the read tier being switched
// on: mcp.pivota.cc resolves to this service either way, so a guard reading
// `isPublicReadMcpEnabled() && isPublicReadMcpHostRequest(req)` — the shape every OTHER host check
// in server.js uses — would re-open the LLM the moment the read tier went dark.
delete process.env.PUBLIC_READ_MCP_ENABLED;

delete process.env.PIVOTA_UI_CHAT_INTERNAL_KEY;

const app = require('../src/server');

// Deliberately AFTER the require, and assigned rather than deleted.
//
// src/server.js:6 calls require('dotenv').config(). dotenv does not overwrite a variable that is
// already set — but a variable this file DELETED is not set, so a .env in the working directory
// (gitignored, and present on most dev machines) silently refills OPENAI_API_KEY during that
// require. Deleting these before the require therefore does nothing on exactly the machines where
// it matters most: the suite stays green, the positive control's 500 starts coming from a live
// call to api.openai.com instead of an unconfigured client, and with a VALID key in .env the route
// answers 200, the control fails for a reason unrelated to the guard, and it costs money to find
// out. Assigning '' afterwards cannot be undone by dotenv and pins the provider either way.
process.env.PIVOTA_UI_CHAT_LLM_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.PIVOTA_GEMINI_API_KEY = '';
process.env.GOOGLE_API_KEY = '';
process.env.VERTEX_AI_ENABLED = '';

const KEY = 'Test-Internal-Key-AbCdEf0123456789';
const PUBLIC_HOST = 'mcp.pivota.cc';
const INTERNAL_HOST = 'commerce.mcp.pivota.cc';
const BODY = { messages: [{ role: 'user', content: 'hello' }] };

function withKey(value) {
  if (value === null) delete process.env.PIVOTA_UI_CHAT_INTERNAL_KEY;
  else process.env.PIVOTA_UI_CHAT_INTERNAL_KEY = value;
}

/** Nothing that reached the agent loop may be in this response. */
function assertNoLlmAnswer(resp) {
  assert.equal(resp.body.assistantMessage, undefined, 'response carried an LLM answer');
  assert.notEqual(resp.status, 200, 'a refused request must not answer 200');
  assert.notEqual(resp.status, 500, 'a 500 here means the request reached the unconfigured LLM');
  assert.notEqual(resp.status, 400, 'a 400 here means the request reached body validation');
}

// ---- the decision function, in isolation -----------------------------------------------------

test('public-read host is refused even with the correct key — the branches are ordered', () => {
  const d = decideUiChatAccess({
    isPublicReadHost: true,
    headers: { 'x-internal-key': KEY },
    env: { PIVOTA_UI_CHAT_INTERNAL_KEY: KEY },
  });
  assert.equal(d.allow, false);
  assert.equal(d.status, 404);
  assert.equal(d.reason, 'public_read_host');
});

test('404 not 401 on the public host — a 401 still advertises the surface', () => {
  const d = decideUiChatAccess({ isPublicReadHost: true, env: {} });
  assert.equal(d.status, 404);
});

test('an unconfigured key is closed, never open', () => {
  const d = decideUiChatAccess({ isPublicReadHost: false, headers: {}, env: {} });
  assert.equal(d.allow, false);
  assert.equal(d.status, 404);
  assert.equal(d.reason, 'key_not_configured');
});

test('a configured key rejects a missing, wrong, and same-length near-miss header', () => {
  const env = { PIVOTA_UI_CHAT_INTERNAL_KEY: KEY };
  for (const headers of [{}, { 'x-internal-key': 'nope' }, { 'x-internal-key': `${KEY.slice(0, -1)}X` }]) {
    const d = decideUiChatAccess({ isPublicReadHost: false, headers, env });
    assert.equal(d.allow, false, JSON.stringify(headers));
    assert.equal(d.status, 401);
  }
});

test('the matching key is accepted however the header name is cased', () => {
  const env = { PIVOTA_UI_CHAT_INTERNAL_KEY: KEY };
  for (const name of ['x-internal-key', 'X-Internal-Key', 'X-INTERNAL-KEY']) {
    const d = decideUiChatAccess({ isPublicReadHost: false, headers: { [name]: KEY }, env });
    assert.equal(d.allow, true, name);
  }
});

// ---- the live route --------------------------------------------------------------------------

test('anonymous POST /ui/chat on the public read host does not reach the LLM', async () => {
  withKey(null);
  const resp = await supertest(app).post('/ui/chat').set('Host', PUBLIC_HOST).send(BODY);
  assert.equal(resp.status, 404);
  assertNoLlmAnswer(resp);
});

test('an empty body on the public read host is refused BEFORE validation', async () => {
  // The original symptom: `{}` answered 400 "Body must have a messages array". A 400 here would
  // mean the request is still reaching application code with no credential.
  withKey(null);
  const resp = await supertest(app).post('/ui/chat').set('Host', PUBLIC_HOST).send({});
  assert.equal(resp.status, 404);
  assert.notEqual(resp.body.error, 'INVALID_REQUEST');
});

test('a configured key cannot re-open the identity anchor', async () => {
  withKey(KEY);
  const resp = await supertest(app)
    .post('/ui/chat')
    .set('Host', PUBLIC_HOST)
    .set('X-Internal-Key', KEY)
    .send(BODY);
  assert.equal(resp.status, 404);
  assertNoLlmAnswer(resp);
});

test('the public host 404s while a key IS configured — this is what prod actually runs', async () => {
  // The single most load-bearing case, and the one the rest of this file could not see. Every other
  // public-host test here leaves the key UNSET, so its 404 is equally explained by branch 2's
  // key_not_configured — they cannot tell the two branches apart. Now that
  // PIVOTA_UI_CHAT_INTERNAL_KEY is set on the service, "key configured" is the ONLY state the
  // public host will ever be in, and a guard whose branches were ordered the other way round would
  // answer 401 here: advertising the surface on the identity anchor, which is the exact thing the
  // 404-not-401 choice exists to prevent.
  withKey(KEY);
  const resp = await supertest(app).post('/ui/chat').set('Host', PUBLIC_HOST).send(BODY);
  assert.equal(resp.status, 404);
  assertNoLlmAnswer(resp);
});

test('a Host carrying a port is still the public host', async () => {
  // isPublicReadMcpHostRequest strips the port with .split(':')[0]. Nothing exercised that, so
  // dropping it would have turned `Host: mcp.pivota.cc:443` into an internal host.
  withKey(KEY);
  const resp = await supertest(app).post('/ui/chat').set('Host', `${PUBLIC_HOST}:443`).send(BODY);
  assert.equal(resp.status, 404);
  assertNoLlmAnswer(resp);
});

test('the refused host set comes from PUBLIC_READ_MCP_HOSTS, not from a hardcoded name', async () => {
  // publicReadMcpHosts() DEFAULTS to 'mcp.pivota.cc', so setting the env var to that same value
  // asserts nothing whatsoever — a call site that hardcoded the literal would pass every other test
  // in this file. Point the env at a different name and both directions have to move with it.
  withKey(KEY);
  process.env.PUBLIC_READ_MCP_HOSTS = 'gateway.pivota.cc';
  try {
    const nowPublic = await supertest(app).post('/ui/chat').set('Host', 'gateway.pivota.cc').send(BODY);
    assert.equal(nowPublic.status, 404, 'the configured host must be refused');
    assertNoLlmAnswer(nowPublic);

    // ...and the name that is no longer in the list must fall through to branch 2, not stay 404.
    const noLongerPublic = await supertest(app).post('/ui/chat').set('Host', PUBLIC_HOST).send(BODY);
    assert.equal(noLongerPublic.status, 401, 'a host outside the list must reach the key check');
  } finally {
    process.env.PUBLIC_READ_MCP_HOSTS = PUBLIC_HOST;
  }
});

test('the key comparison is case-SENSITIVE on the value', async () => {
  withKey(KEY);
  const resp = await supertest(app)
    .post('/ui/chat')
    .set('Host', INTERNAL_HOST)
    .set('X-Internal-Key', KEY.toLowerCase())
    .send(BODY);
  assert.equal(resp.status, 401);
  assertNoLlmAnswer(resp);
});

test('a whitespace-only key counts as unconfigured, not as a key', async () => {
  withKey('   ');
  const resp = await supertest(app)
    .post('/ui/chat')
    .set('Host', INTERNAL_HOST)
    .set('X-Internal-Key', '   ')
    .send(BODY);
  assert.equal(resp.status, 404, 'a blank key must fail closed, never become a matchable secret');
  assertNoLlmAnswer(resp);
});

test('darkening the read tier does not re-open /ui/chat on the public host', async () => {
  withKey(null);
  process.env.PUBLIC_READ_MCP_ENABLED = '0';
  try {
    const resp = await supertest(app).post('/ui/chat').set('Host', PUBLIC_HOST).send(BODY);
    assert.equal(resp.status, 404);
    assertNoLlmAnswer(resp);
  } finally {
    delete process.env.PUBLIC_READ_MCP_ENABLED;
  }
});

test('the spellings Express also routes here are refused too', async () => {
  // caseSensitive and strict both default off, so these reach the same handler.
  withKey(null);
  for (const p of ['/UI/Chat', '/ui/chat/', '/ui/CHAT/']) {
    const resp = await supertest(app).post(p).set('Host', PUBLIC_HOST).send(BODY);
    assert.equal(resp.status, 404, p);
    assertNoLlmAnswer(resp);
  }
});

test('an internal host with no key configured is closed', async () => {
  withKey(null);
  const resp = await supertest(app).post('/ui/chat').set('Host', INTERNAL_HOST).send(BODY);
  assert.equal(resp.status, 404);
  assertNoLlmAnswer(resp);
});

test('an internal host with a key configured refuses a missing or wrong key', async () => {
  withKey(KEY);
  const missing = await supertest(app).post('/ui/chat').set('Host', INTERNAL_HOST).send(BODY);
  assert.equal(missing.status, 401);
  assertNoLlmAnswer(missing);

  const wrong = await supertest(app)
    .post('/ui/chat')
    .set('Host', INTERNAL_HOST)
    .set('X-Internal-Key', 'not-the-key')
    .send(BODY);
  assert.equal(wrong.status, 401);
  assertNoLlmAnswer(wrong);
});

// ---- the internal UI page ----------------------------------------------------------------------

test('the internal UI page is not served at the root of the public read host', async () => {
  const resp = await supertest(app).get('/').set('Host', PUBLIC_HOST);
  assert.notEqual(resp.status, 200);
  assert.ok(!String(resp.text || '').includes('Internal UI'), 'public host served the internal UI');
});

test('the internal UI page is still served on an internal host', async () => {
  // The other half of the contract: this fix removes the page from the public tier, it does not
  // delete it. A mutant that dropped the static mount entirely would pass every test above.
  const resp = await supertest(app).get('/').set('Host', INTERNAL_HOST).expect(200);
  assert.match(resp.text, /Pivota Shopping Agent \(Internal UI\)/);
});

// ---- positive control ---------------------------------------------------------------------------

test('the provider env this file depends on is actually unconfigured', () => {
  // If this ever fails, the positive control below has quietly stopped meaning what it says and is
  // talking to a real provider. Fail here, loudly, rather than there, expensively.
  for (const name of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'PIVOTA_GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
    assert.equal(process.env[name], '', `${name} must be empty for the positive control to mean anything`);
  }
});

test('with the right key on an internal host the request DOES reach the agent loop', async () => {
  // 500 because no LLM provider is configured in this file — that is the point. It is the observable
  // difference between "the guard refused this" and "the guard let it through", and it is what makes
  // every 404/401 above a real assertion rather than a coincidence.
  withKey(KEY);
  const resp = await supertest(app)
    .post('/ui/chat')
    .set('Host', INTERNAL_HOST)
    .set('X-Internal-Key', KEY)
    .send(BODY);
  assert.equal(resp.status, 500);
  assert.equal(resp.body.error, 'INTERNAL_ERROR');
});
