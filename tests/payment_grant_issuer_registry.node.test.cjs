'use strict';

// paymentGrantIssuerRegistry — merge, pinning, staleness, and rebuild-only-on-change.
//
// Everything here runs with injected fetch/now/build, so the contracts under test are the
// module's own: static trust is pinned, registry rows are additive, a bad row cannot poison
// the build, revocation takes effect within the staleness bound, and the inner verifier is
// rebuilt exactly when the merged list changes and never otherwise.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createPaymentGrantIssuerRegistry } = require('../src/services/paymentGrantIssuerRegistry');

const ENV = { PIVOTA_API_BASE: 'https://api.example', AGENT_AUTH_INTROSPECT_INTERNAL_KEY: 'ik_test' };
const STATIC_CANARY = { iss: 'https://operator.pivota.local/payment-canary', jwksUri: 'https://c.example/jwks', aud: 'pivota-agent-mcp', algs: ['ES256'] };

function row(over = {}) {
  return {
    iss: 'https://antom.example/payments', jwksUri: 'https://antom.example/jwks',
    aud: 'https://commerce.mcp.pivota.cc/mcp', algs: ['ES256'], methods: ['signed_grant'],
    ...over,
  };
}

function fakeFetch(pages) {
  // pages: array of issuer-lists (or Error) served in order; last repeats.
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, key: init.headers['X-Internal-Key'] });
    const page = pages[Math.min(i, pages.length - 1)];
    i += 1;
    if (page instanceof Error) throw page;
    return { ok: true, json: async () => ({ issuers: page }) };
  };
  fn.calls = calls;
  return fn;
}

function grantFor(iss) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return { token: `${b64({ alg: 'ES256' })}.${b64({ iss, sub: 'user_1' })}.sig` };
}

function harness({ pages, staticIssuers = [STATIC_CANARY], env = ENV, ttlMs = 1000, maxStalenessMs = 10_000 } = {}) {
  let clock = 1_000_000;
  const logs = { warn: [], error: [] };
  const builds = [];
  const fetchImpl = fakeFetch(pages || [[]]);
  const registry = createPaymentGrantIssuerRegistry({
    env, staticIssuers, ttlMs, maxStalenessMs,
    fetchImpl,
    logger: { warn: (o, m) => logs.warn.push(m), error: (o, m) => logs.error.push(m), info() {} },
    now: () => clock,
  });
  const verify = registry.createVerifier(async (issuers) => {
    builds.push(issuers.map((e) => e.iss));
    return async (authorization) => ({ ok: true, seen: issuers.map((e) => e.iss) });
  });
  return { registry, verify, builds, logs, fetches: () => fetchImpl.calls.length, tick: (ms) => { clock += ms; } };
}

test('disabled registry (no internal key) serves static issuers and never fetches', async () => {
  const fetchImpl = fakeFetch([[row()]]);
  const registry = createPaymentGrantIssuerRegistry({
    env: { PIVOTA_API_BASE: 'https://api.example' }, // no key
    staticIssuers: [STATIC_CANARY], fetchImpl, now: () => 1,
  });
  assert.equal(registry.enabled, false);
  const builds = [];
  const verify = registry.createVerifier(async (issuers) => {
    builds.push(issuers.map((e) => e.iss));
    return async () => ({ ok: true });
  });
  const out = await verify(grantFor(STATIC_CANARY.iss));
  assert.equal(out.ok, true);
  assert.deepEqual(builds, [[STATIC_CANARY.iss]]);
  assert.equal(fetchImpl.calls.length, 0);
});

test('empty everywhere refuses with PAYMENT_AUTHZ_UNAVAILABLE, never an open verifier', async () => {
  const { verify } = harness({ pages: [[]], staticIssuers: [] });
  await assert.rejects(() => verify(grantFor('https://x.example')), (err) => err.code === 'PAYMENT_AUTHZ_UNAVAILABLE');
});

test('registry rows are ADDITIVE to static, and the inner verifier sees the merge', async () => {
  const { verify, builds } = harness({ pages: [[row()]] });
  await verify(grantFor(STATIC_CANARY.iss));
  assert.deepEqual(builds, [[STATIC_CANARY.iss, 'https://antom.example/payments']]);
});

test('a registry row shadowing a static iss is dropped loudly — DB rows cannot replace pinned trust', async () => {
  const { verify, builds, logs } = harness({
    pages: [[row({ iss: STATIC_CANARY.iss, jwksUri: 'https://evil.example/jwks' }), row()]],
  });
  await verify(grantFor(STATIC_CANARY.iss));
  assert.deepEqual(builds[0], [STATIC_CANARY.iss, 'https://antom.example/payments']);
  assert.ok(logs.warn.some((m) => m.includes('shadows a static env issuer')));
});

test('a piped iss is dropped at ingest (it would poison the WHOLE verifier build) and siblings survive', async () => {
  const { verify, builds, logs } = harness({ pages: [[row({ iss: 'https://bad.example|x' }), row()]] });
  await verify(grantFor(STATIC_CANARY.iss));
  assert.deepEqual(builds[0], [STATIC_CANARY.iss, 'https://antom.example/payments']);
  assert.ok(logs.error.some((m) => m.includes('piped iss')));
});

test('ap2-only rows are inert; signed_grant+ap2 rows are served', async () => {
  const { verify, builds } = harness({
    pages: [[
      row({ iss: 'https://ap2only.example', methods: ['ap2_mandate'] }),
      row({ iss: 'https://both.example', methods: ['signed_grant', 'ap2_mandate'] }),
    ]],
  });
  await verify(grantFor(STATIC_CANARY.iss));
  assert.deepEqual(builds[0], [STATIC_CANARY.iss, 'https://both.example']);
});

test('TTL: calls inside the window share one fetch; past it, a re-read happens', async () => {
  const h = harness({ pages: [[row()], [row()]] });
  await h.verify(grantFor(STATIC_CANARY.iss));
  await h.verify(grantFor(STATIC_CANARY.iss));
  assert.equal(h.builds.length, 1); // and only one build, list unchanged
  h.tick(1500); // past ttlMs=1000
  await h.verify(grantFor(STATIC_CANARY.iss));
  assert.equal(h.builds.length, 1); // re-read happened but the list did not change: NO rebuild
});

test('the inner verifier is rebuilt exactly when the merged list changes', async () => {
  const h = harness({ pages: [[row()], [row(), row({ iss: 'https://second.example' })]] });
  await h.verify(grantFor(STATIC_CANARY.iss));
  h.tick(1500);
  await h.verify(grantFor(STATIC_CANARY.iss));
  assert.equal(h.builds.length, 2);
  assert.deepEqual(h.builds[1], [STATIC_CANARY.iss, 'https://antom.example/payments', 'https://second.example']);
});

test('unknown iss forces ONE refresh so a just-registered PSP verifies immediately', async () => {
  const h = harness({ pages: [[], [row()]] });
  await h.verify(grantFor(STATIC_CANARY.iss)); // primes with empty registry
  const out = await h.verify(grantFor('https://antom.example/payments'));
  assert.equal(out.ok, true);
  assert.ok(h.builds[h.builds.length - 1].includes('https://antom.example/payments'));
});

test('forced refreshes respect the min gap — a storm of unknown-iss grants is not a fetch storm', async () => {
  // ttl is LARGE so the only fetches after priming are the forced ones under test; whether the
  // grant ultimately verifies is the inner verifier's business, not this module's.
  const h = harness({ pages: [[]], ttlMs: 60_000 });
  await h.verify(grantFor(STATIC_CANARY.iss));
  assert.equal(h.fetches(), 1); // prime
  await h.verify(grantFor('https://never.example'));
  assert.equal(h.fetches(), 2); // one forced re-read for the miss
  h.tick(1000); // within MIN_FORCED_REFRESH_GAP_MS=5000
  await h.verify(grantFor('https://never.example'));
  assert.equal(h.fetches(), 2); // the storm coalesces: no third fetch
  h.tick(6000); // past the gap
  await h.verify(grantFor('https://never.example'));
  assert.equal(h.fetches(), 3);
});

test('beyond the staleness bound, registry rows are DROPPED and static trust keeps serving', async () => {
  const h = harness({ pages: [[row()], new Error('backend down')], maxStalenessMs: 5000 });
  await h.verify(grantFor(STATIC_CANARY.iss));
  assert.deepEqual(h.builds[0], [STATIC_CANARY.iss, 'https://antom.example/payments']);
  h.tick(2000); // past TTL, within staleness: stale cache still serves
  await h.verify(grantFor(STATIC_CANARY.iss));
  assert.equal(h.builds.length, 1);
  h.tick(6000); // past maxStalenessMs: revocation bound expired
  await h.verify(grantFor(STATIC_CANARY.iss));
  assert.deepEqual(h.builds[h.builds.length - 1], [STATIC_CANARY.iss]); // registry rows gone
  assert.ok(h.logs.error.some((m) => m.includes('stale beyond bound')));
});

test('after the backend recovers, registry rows come back', async () => {
  const h = harness({ pages: [[row()], new Error('down'), [row()]], maxStalenessMs: 5000 });
  await h.verify(grantFor(STATIC_CANARY.iss)); // fetch 1: good
  h.tick(6000); // past ttl AND past staleness
  await h.verify(grantFor(STATIC_CANARY.iss)); // fetch 2: down -> static-only
  assert.deepEqual(h.builds[h.builds.length - 1], [STATIC_CANARY.iss]);
  h.tick(2000); // past ttl again
  await h.verify(grantFor(STATIC_CANARY.iss)); // fetch 3: good -> merged again
  assert.equal(h.fetches(), 3);
  assert.deepEqual(h.builds[h.builds.length - 1], [STATIC_CANARY.iss, 'https://antom.example/payments']);
});

test('malformed rows are dropped without taking the fetch down', async () => {
  const h = harness({ pages: [[{ iss: '' }, { nonsense: true }, null, row()]] });
  await h.verify(grantFor(STATIC_CANARY.iss));
  assert.deepEqual(h.builds[0], [STATIC_CANARY.iss, 'https://antom.example/payments']);
});

test('a row that would make buildIssuerRegistry THROW is dropped at ingest: http jwks, bad algs, dup iss', async () => {
  // Review finding 2: the pipe-only guard was insufficient — an http jwksUri row sailed
  // through and every payment attempt (static canary included) then died on the build.
  const h = harness({
    pages: [[
      row({ iss: 'https://http-jwks.example', jwksUri: 'http://http-jwks.example/jwks' }),
      row({ iss: 'https://bad-alg.example', algs: ['HS256'] }),
      row({ iss: 'https://dup.example' }),
      row({ iss: 'https://dup.example', jwksUri: 'https://dup2.example/jwks' }),
      row(),
    ]],
  });
  await h.verify(grantFor(STATIC_CANARY.iss));
  assert.deepEqual(h.builds[0], [STATIC_CANARY.iss, 'https://dup.example', 'https://antom.example/payments']);
  assert.ok(h.logs.error.some((m) => m.includes('non-https jwksUri')));
  assert.ok(h.logs.error.some((m) => m.includes('non-allowlisted alg')));
  assert.ok(h.logs.error.some((m) => m.includes('duplicate payment issuer row')));
});

test('a SYNCHRONOUS build throw must not strand the old verifier under the new fingerprint', async () => {
  // Review finding 3, the fail-open-for-revocation bug: with Promise.resolve(build(...)),
  // a sync throw escaped before assignment — the fingerprint said "new list" while the old
  // verifier kept serving, so a snapshot that both revoked an issuer and carried a poison
  // row kept the revoked issuer verifying indefinitely.
  let mode = 'good';
  const seen = [];
  const registry = createPaymentGrantIssuerRegistry({
    env: ENV, staticIssuers: [STATIC_CANARY], ttlMs: 1000,
    fetchImpl: fakeFetch([[], [row()], [row()]]),
    now: (() => { let c = 0; return () => { c += 1500; return c; }; })(), // every call passes TTL
  });
  const verify = registry.createVerifier((issuers) => {
    // SYNC throw, exactly like createSignedGrantVerifier
    if (mode === 'poison') throw new Error('issuer jwksUri must be https');
    seen.push(issuers.map((e) => e.iss));
    return async () => ({ ok: true, over: issuers.map((e) => e.iss) });
  });
  const first = await verify(grantFor(STATIC_CANARY.iss)); // static-only build
  assert.deepEqual(first.over, [STATIC_CANARY.iss]);
  mode = 'poison';
  await assert.rejects(() => verify(grantFor(STATIC_CANARY.iss)), /must be https/);
  // Same (changed) list again while still poisoned: must THROW AGAIN (a retried build), never
  // silently serve the pre-poison verifier.
  await assert.rejects(() => verify(grantFor(STATIC_CANARY.iss)), /must be https/);
  mode = 'good';
  const healed = await verify(grantFor(STATIC_CANARY.iss));
  assert.ok(healed.over.includes('https://antom.example/payments'));
});

test('the fingerprint is order-insensitive but azp-sensitive', async () => {
  const a = row({ iss: 'https://a.example' });
  const b = row({ iss: 'https://b.example' });
  const h = harness({ pages: [[a, b], [b, a], [a, { ...b, azp: 'client-2' }]] });
  await h.verify(grantFor(STATIC_CANARY.iss));
  h.tick(1500);
  await h.verify(grantFor(STATIC_CANARY.iss)); // same set, reordered: NO rebuild
  assert.equal(h.builds.length, 1);
  h.tick(1500);
  await h.verify(grantFor(STATIC_CANARY.iss)); // azp changed: rebuild
  assert.equal(h.builds.length, 2);
});

test('the staleness alarm logs once a minute, not once per payment attempt', async () => {
  const h = harness({ pages: [[row()], new Error('down')], maxStalenessMs: 5000 });
  await h.verify(grantFor(STATIC_CANARY.iss));
  h.tick(6000);
  for (let i = 0; i < 5; i += 1) await h.verify(grantFor(STATIC_CANARY.iss));
  const first = h.logs.error.filter((m) => m.includes('stale beyond bound')).length;
  assert.equal(first, 1);
  h.tick(61_000);
  await h.verify(grantFor(STATIC_CANARY.iss));
  const after = h.logs.error.filter((m) => m.includes('stale beyond bound')).length;
  assert.equal(after, 2);
});

test('a failed inner build is retried, not wedged forever', async () => {
  let attempts = 0;
  const registry = createPaymentGrantIssuerRegistry({
    env: ENV, staticIssuers: [STATIC_CANARY], ttlMs: 1000,
    fetchImpl: fakeFetch([[]]), now: () => 1,
  });
  const verify = registry.createVerifier(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('jwks fetch blew up');
    return async () => ({ ok: true });
  });
  await assert.rejects(() => verify(grantFor(STATIC_CANARY.iss)));
  const out = await verify(grantFor(STATIC_CANARY.iss));
  assert.equal(out.ok, true);
  assert.equal(attempts, 2);
});
