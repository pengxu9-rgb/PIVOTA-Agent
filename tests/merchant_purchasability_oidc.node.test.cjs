'use strict';

// THE OIDC RAIL for the merchant-purchasability gate: the gateway authenticates its backend ops
// read with a Google-signed Cloud Run IDENTITY TOKEN instead of a standing admin JWT.
//
// WHY THE RAIL EXISTS, restated here because it is what every assertion below is defending.
// `PIVOTA_OPS_ADMIN_TOKEN` expires on a calendar date, and the gate FAILS OPEN on every failure
// by design — so the day it expires the backend answers 401, the gate silently stops gating, and
// both sides' dials still read "on". An identity token is minted per hour by the metadata server
// for this service's own service account and nobody has to remember anything.
//
// NO NETWORK, TWICE OVER. The backend is a stubbed `fetchImpl` and the METADATA SERVER is a
// separately stubbed `metadataFetchImpl` — two transports, because a test that stubbed one and
// accidentally let the other reach `metadata.google.internal` would hang in CI for a second per
// call and pass anyway (the failure path is a fallback).
//
// Discovered by `scripts/run_node_test_suites.cjs` (glob over tests/**/*.node.test.cjs), which is
// what the `node-tests` job of .github/workflows/pr-full-jest.yml runs.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GATE_FLAG_ENV,
  OPS_TOKEN_ENV,
  OIDC_AUDIENCE_ENV,
  BASE_URL_ENV,
  SOURCE,
  ISOLATING_KEYS,
  isIsolatingDeps,
  createMerchantPurchasabilityClient,
} = require('../src/services/merchantPurchasabilityClient');

const {
  cloudRunAudience,
  createRefreshingCloudRunIdTokenProvider,
  readTokenExpiryMs,
  REFRESH_SKEW_MS,
  DEFAULT_METADATA_TIMEOUT_MS,
  METADATA_IDENTITY_URL,
} = require('../src/services/cloudRunIdentityToken');

// ---- fixtures ------------------------------------------------------------------------------------------

const BASE = 'https://backend.example';
const AUDIENCE = 'https://api.pivota.cc';
const STATIC_TOKEN = 'static-admin-jwt-fixture';
const MERCHANT = 'flowerbeauty.com';
const FACT_PURCHASE = { tier: 'purchase', enforced: true, sweep_enabled: true };
const FACT_BROWSE_ONLY = { tier: 'browse_only', enforced: true, sweep_enabled: true };

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A Google-SHAPED identity token. Nothing here verifies it — the BACKEND does that. */
function identityToken({ expSeconds, id = 'a' } = {}) {
  const header = b64url({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const payload = b64url({
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    email: 'sa-gateway@pivota-prod.iam.gserviceaccount.com',
    email_verified: true,
    exp: expSeconds,
    marker: id,
  });
  return `${header}.${payload}.sig-${id}`;
}

function fakeLogger() {
  const lines = [];
  const record = (level) => (entry) => lines.push({ level, ...entry });
  return { lines, warn: record('warn'), info: record('info'), error: record('error') };
}

/** A backend that answers one body, recording every request. */
function fakeBackend(body, { status = 200, ok = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

/**
 * A metadata server. `mode` is how it answers: a token, an HTTP error, a hang until abort, or a
 * throw (the shape a non-GCP host actually produces — DNS for metadata.google.internal fails).
 */
function fakeMetadata({ tokens = [identityToken({ expSeconds: 2_000_000 })], mode = 'ok' } = {}) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (mode === 'throw') throw new Error('getaddrinfo ENOTFOUND metadata.google.internal');
    if (mode === 'error') return { ok: false, status: 500, text: async () => 'nope' };
    if (mode === 'empty') return { ok: true, status: 200, text: async () => '   ' };
    if (mode === 'hang') {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
    const token = tokens[Math.min(index, tokens.length - 1)];
    index += 1;
    return { ok: true, status: 200, text: async () => token };
  };
  return { calls, fetchImpl, get count() { return calls.length; } };
}

function oidcEnv(extra = {}) {
  return {
    [GATE_FLAG_ENV]: '1',
    [BASE_URL_ENV]: BASE,
    [OIDC_AUDIENCE_ENV]: AUDIENCE,
    ...extra,
  };
}

// ---- 1. the identity token is PREFERRED, and travels as Bearer -------------------------------------------

test('with the audience set, the identity token is sent as Bearer — not the static admin JWT', async () => {
  const backend = fakeBackend(FACT_PURCHASE);
  const metadata = fakeMetadata();
  const client = createMerchantPurchasabilityClient({
    env: oidcEnv({ [OPS_TOKEN_ENV]: STATIC_TOKEN }),   // BOTH configured: the identity must win
    fetchImpl: backend.fetchImpl,
    metadataFetchImpl: metadata.fetchImpl,
  });

  const decision = await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.deepEqual(decision, { offer: true, source: SOURCE.gate });

  const headers = backend.calls[0].options.headers;
  assert.equal(headers.authorization, `Bearer ${identityToken({ expSeconds: 2_000_000 })}`);
  assert.equal(headers.authorization.includes(STATIC_TOKEN), false, 'the static JWT must not be sent');
  assert.equal(Object.keys(headers).map((k) => k.toLowerCase()).includes('x-admin-key'), false);
});

test('the metadata request is the fixed Cloud Run identity endpoint, with the Google flavour header', async () => {
  const backend = fakeBackend(FACT_PURCHASE);
  const metadata = fakeMetadata();
  const client = createMerchantPurchasabilityClient({
    env: oidcEnv(), fetchImpl: backend.fetchImpl, metadataFetchImpl: metadata.fetchImpl,
  });
  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });

  assert.equal(metadata.count, 1);
  const { url, options } = metadata.calls[0];
  assert.ok(url.startsWith(`${METADATA_IDENTITY_URL}?`), url);
  const parsed = new URL(url);
  assert.equal(parsed.host, 'metadata.google.internal');
  assert.equal(parsed.searchParams.get('audience'), AUDIENCE);
  assert.equal(parsed.searchParams.get('format'), 'full');
  assert.equal(options.headers['Metadata-Flavor'], 'Google');
  assert.equal(options.redirect, 'error');
  // NO MERCHANT INPUT REACHES THIS URL. The audience is deployment configuration and nothing
  // else; a merchant domain in an auth URL is an SSRF with an Authorization header attached.
  assert.equal(url.includes(MERCHANT), false);
});

test('the metadata budget is at most 1s — MEASURED by the abort, not read off a constant', async () => {
  assert.ok(DEFAULT_METADATA_TIMEOUT_MS <= 1000);
  const metadata = fakeMetadata({ mode: 'hang' });
  // A caller asking for 30s must not get 30s: the ceiling is a Math.min, not a default.
  const provider = createRefreshingCloudRunIdTokenProvider({
    audience: AUDIENCE, fetchImpl: metadata.fetchImpl, timeoutMs: 30_000,
  });
  const started = Date.now();
  assert.equal(await provider.getToken(), null);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `a 30s ask must be capped to 1s; took ${elapsed}ms`);
});

// ---- 2. refresh BEFORE exp -------------------------------------------------------------------------------

test('the identity token is cached and refreshed ~5 minutes BEFORE it expires', async () => {
  let clock = 1_000_000_000;              // ms
  const expSeconds = Math.floor(clock / 1000) + 3600;   // one hour out
  const first = identityToken({ expSeconds, id: 'first' });
  const second = identityToken({ expSeconds: expSeconds + 3600, id: 'second' });
  const backend = fakeBackend(FACT_PURCHASE);
  const metadata = fakeMetadata({ tokens: [first, second] });
  const provider = createRefreshingCloudRunIdTokenProvider({
    audience: AUDIENCE, fetchImpl: metadata.fetchImpl, now: () => clock,
  });
  const client = createMerchantPurchasabilityClient({
    env: oidcEnv(), fetchImpl: backend.fetchImpl, idTokenProvider: provider,
    now: () => clock, ttlMs: 1, negativeTtlMs: 1,   // the FACT cache must not hide the refresh
  });

  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.equal(metadata.count, 1);

  // Well inside the token's life: cached, no second metadata call.
  clock += 30 * 60 * 1000;
  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.equal(metadata.count, 1, 'a live token must be reused, not re-fetched every read');
  assert.equal(backend.calls[1].options.headers.authorization, `Bearer ${first}`);

  // Just BEFORE the refresh window opens: still the first token.
  clock = (expSeconds * 1000) - REFRESH_SKEW_MS - 1000;
  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.equal(metadata.count, 1);

  // Inside the refresh window — and still 5 minutes before the token is actually dead.
  clock = (expSeconds * 1000) - REFRESH_SKEW_MS + 1000;
  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.equal(metadata.count, 2, 'it must refresh BEFORE exp, not after a 401');
  assert.equal(backend.calls[3].options.headers.authorization, `Bearer ${second}`);
  assert.ok(clock < expSeconds * 1000, 'the refresh happened while the old token was still valid');
});

test('a token with no readable exp is cached only briefly, never forever', async () => {
  let clock = 1_000_000_000;
  const opaque = 'not-a-jwt-at-all';
  const metadata = fakeMetadata({ tokens: [opaque, opaque] });
  const provider = createRefreshingCloudRunIdTokenProvider({
    audience: AUDIENCE, fetchImpl: metadata.fetchImpl, now: () => clock,
  });
  assert.equal(await provider.getToken(), opaque);
  clock += 10_000;
  assert.equal(await provider.getToken(), opaque);
  assert.equal(metadata.count, 1, 'briefly cached');
  clock += 120_000;
  await provider.getToken();
  assert.equal(metadata.count, 2, 'an unknown lifetime must NOT be treated as an immortal one');
});

test('readTokenExpiryMs reads exp without verifying, and refuses anything that is not a JWT', () => {
  assert.equal(readTokenExpiryMs(identityToken({ expSeconds: 1234 })), 1234 * 1000);
  for (const bad of [null, undefined, '', 'a.b', 'a.b.c.d', 'x.!!!.z', identityToken({ expSeconds: undefined })]) {
    assert.equal(readTokenExpiryMs(bad), null, String(bad));
  }
});

test('concurrent reads collapse into ONE metadata call', async () => {
  const backend = fakeBackend(FACT_PURCHASE);
  const metadata = fakeMetadata();
  const provider = createRefreshingCloudRunIdTokenProvider({
    audience: AUDIENCE, fetchImpl: metadata.fetchImpl,
  });
  const client = createMerchantPurchasabilityClient({
    env: oidcEnv(), fetchImpl: backend.fetchImpl, idTokenProvider: provider, ttlMs: 1,
  });
  await Promise.all([
    client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' }),
    client.shouldOfferPurchase({ domain: 'b.example', market: 'US' }),
    client.shouldOfferPurchase({ domain: 'c.example', market: 'US' }),
  ]);
  assert.equal(metadata.count, 1);
});

// ---- 3. the fallback chain, and rule 4 (fail OPEN) all the way down --------------------------------------

test('metadata 500 / timeout / throw / empty ALL fall back to the static admin JWT', async () => {
  for (const mode of ['error', 'hang', 'throw', 'empty']) {
    const backend = fakeBackend(FACT_PURCHASE);
    const metadata = fakeMetadata({ mode });
    const client = createMerchantPurchasabilityClient({
      env: oidcEnv({ [OPS_TOKEN_ENV]: STATIC_TOKEN }),
      fetchImpl: backend.fetchImpl,
      metadataFetchImpl: metadata.fetchImpl,
    });
    const decision = await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
    assert.deepEqual(decision, { offer: true, source: SOURCE.gate }, mode);
    assert.equal(backend.calls.length, 1, mode);
    assert.equal(backend.calls[0].options.headers.authorization, `Bearer ${STATIC_TOKEN}`, mode);
  }
});

test('no metadata AND no static JWT is the existing "not configured" behaviour — gate stays OPEN', async () => {
  const backend = fakeBackend(FACT_BROWSE_ONLY);
  const metadata = fakeMetadata({ mode: 'throw' });
  const logger = fakeLogger();
  const client = createMerchantPurchasabilityClient({
    env: oidcEnv(), fetchImpl: backend.fetchImpl, metadataFetchImpl: metadata.fetchImpl, logger,
  });

  const decision = await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  // THE WHOLE POINT: an auth failure must never refuse a purchase. The backend already fails
  // CLOSED; a second fail-closed layer turns one blip into a catalogue-wide outage.
  assert.deepEqual(decision, { offer: true, source: SOURCE.failed });
  assert.equal(backend.calls.length, 0, 'no credential means no read at all');
  assert.equal(logger.lines.filter((l) => l.event === 'merchant_purchasability_not_configured').length, 1);
  assert.equal(logger.lines.filter((l) => l.event === 'merchant_purchasability_identity_unavailable').length, 1);
});

test('a browse_only fact is STILL enforced when it arrives over the identity rail', async () => {
  // The rail changes the credential, not the decision. A mutant that made the OIDC path answer
  // "failed" would look fine in every fallback test above and quietly disarm the gate.
  const backend = fakeBackend(FACT_BROWSE_ONLY);
  const metadata = fakeMetadata();
  const client = createMerchantPurchasabilityClient({
    env: oidcEnv(), fetchImpl: backend.fetchImpl, metadataFetchImpl: metadata.fetchImpl,
  });
  assert.deepEqual(
    await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' }),
    { offer: false, source: SOURCE.gate },
  );
});

test('an identity failure never makes the gate REFUSE, even with a browse_only fact waiting', async () => {
  const backend = fakeBackend(FACT_BROWSE_ONLY);
  const metadata = fakeMetadata({ mode: 'throw' });
  const client = createMerchantPurchasabilityClient({
    env: oidcEnv(), fetchImpl: backend.fetchImpl, metadataFetchImpl: metadata.fetchImpl,
  });
  const decision = await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.equal(decision.offer, true);
});

// ---- 4. the audience: unset means the OLD path, exactly ---------------------------------------------------

test('with the audience env UNSET the static path is unchanged and metadata is never touched', async () => {
  const backend = fakeBackend(FACT_PURCHASE);
  const metadata = fakeMetadata();
  const client = createMerchantPurchasabilityClient({
    env: { [GATE_FLAG_ENV]: '1', [BASE_URL_ENV]: BASE, [OPS_TOKEN_ENV]: STATIC_TOKEN },
    fetchImpl: backend.fetchImpl,
    metadataFetchImpl: metadata.fetchImpl,
  });
  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.equal(metadata.count, 0, 'an unset audience must not construct or call a metadata client');
  assert.equal(backend.calls[0].options.headers.authorization, `Bearer ${STATIC_TOKEN}`);
});

test('an audience that is not a bare https origin disables the rail rather than sending junk', async () => {
  // `cloudRunAudience` is strict on purpose: an audience is a byte-for-byte string compare on the
  // backend, so a path, a port, a query or an http:// is not "nearly right", it is a 401 —
  // which fails OPEN and is therefore SILENT. Refusing to use it here at least logs.
  for (const bad of ['http://api.pivota.cc', 'https://api.pivota.cc/ops', 'https://api.pivota.cc:8443', 'api.pivota.cc', '']) {
    assert.equal(cloudRunAudience(bad), null, bad);
  }
  assert.equal(cloudRunAudience(AUDIENCE), AUDIENCE);

  const backend = fakeBackend(FACT_PURCHASE);
  const metadata = fakeMetadata();
  const client = createMerchantPurchasabilityClient({
    env: oidcEnv({ [OIDC_AUDIENCE_ENV]: 'https://api.pivota.cc/ops', [OPS_TOKEN_ENV]: STATIC_TOKEN }),
    fetchImpl: backend.fetchImpl,
    metadataFetchImpl: metadata.fetchImpl,
  });
  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.equal(metadata.count, 0);
  assert.equal(backend.calls[0].options.headers.authorization, `Bearer ${STATIC_TOKEN}`);
});

test('a trailing slash is a DIFFERENT audience — this is the cross-repo arming trap', async () => {
  assert.equal(cloudRunAudience('https://api.pivota.cc/'), AUDIENCE, 'a bare origin normalises');
  const metadata = fakeMetadata();
  const provider = createRefreshingCloudRunIdTokenProvider({
    audience: 'https://api.pivota.cc/', fetchImpl: metadata.fetchImpl,
  });
  await provider.getToken();
  // What goes ON THE WIRE is the normalised origin, so the backend's exact-string compare against
  // `OPS_GATEWAY_OIDC_AUDIENCE=https://api.pivota.cc` holds.
  assert.equal(new URL(metadata.calls[0].url).searchParams.get('audience'), AUDIENCE);
});

// ---- 5. no credential in a log, and none in a serialisable structure --------------------------------------

test('NO LOG LINE ON ANY OIDC PATH CARRIES A CREDENTIAL', async () => {
  const SECRET_IDENTITY = identityToken({ expSeconds: 2_000_000, id: 'supersecretmarker' });
  const paths = [
    ['ok', fakeMetadata({ tokens: [SECRET_IDENTITY] }), fakeBackend(FACT_PURCHASE)],
    ['browse_only', fakeMetadata({ tokens: [SECRET_IDENTITY] }), fakeBackend(FACT_BROWSE_ONLY)],
    ['metadata 500', fakeMetadata({ mode: 'error' }), fakeBackend(FACT_PURCHASE)],
    ['metadata throws', fakeMetadata({ mode: 'throw' }), fakeBackend(FACT_PURCHASE)],
    ['backend 500', fakeMetadata({ tokens: [SECRET_IDENTITY] }), fakeBackend(null, { ok: false, status: 500 })],
    ['malformed', fakeMetadata({ tokens: [SECRET_IDENTITY] }), fakeBackend({ tier: 'nope', enforced: true })],
  ];

  const all = [];
  for (const [label, metadata, backend] of paths) {
    const logger = fakeLogger();
    const client = createMerchantPurchasabilityClient({
      env: oidcEnv({ [OPS_TOKEN_ENV]: STATIC_TOKEN }),
      fetchImpl: backend.fetchImpl,
      metadataFetchImpl: metadata.fetchImpl,
      logger,
    });
    await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
    await client.shouldOfferPurchase({ domain: MERCHANT });                       // unkeyable
    await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US', budgetMs: 10 }); // budget
    for (const line of logger.lines) all.push({ label, line });
  }
  assert.ok(all.length >= paths.length, 'the matrix must actually produce logs');

  for (const { label, line } of all) {
    const rendered = JSON.stringify(line);
    assert.equal(rendered.includes(SECRET_IDENTITY), false, `${label}/${line.event}: identity token in a log`);
    assert.equal(rendered.includes('supersecretmarker'), false, `${label}/${line.event}: token payload in a log`);
    assert.equal(rendered.includes(STATIC_TOKEN), false, `${label}/${line.event}: static JWT in a log`);
    assert.equal(/eyJ[A-Za-z0-9_-]{6,}/.test(rendered), false, `${label}/${line.event}: JWT-shaped string: ${rendered}`);
    for (const forbidden of ['authorization', 'bearer', 'token', 'jwt', 'credential', 'secret']) {
      assert.equal(
        rendered.toLowerCase().includes(forbidden), false,
        `${label}/${line.event} logged a "${forbidden}" field: ${rendered}`,
      );
    }
  }
});

test('the token is in no serialisable structure: not the provider, not the fact cache', async () => {
  const SECRET_IDENTITY = identityToken({ expSeconds: 2_000_000, id: 'onlyinaclosure' });
  const backend = fakeBackend(FACT_PURCHASE);
  const metadata = fakeMetadata({ tokens: [SECRET_IDENTITY] });
  const provider = createRefreshingCloudRunIdTokenProvider({
    audience: AUDIENCE, fetchImpl: metadata.fetchImpl,
  });
  const client = createMerchantPurchasabilityClient({
    env: oidcEnv(), fetchImpl: backend.fetchImpl, idTokenProvider: provider,
  });
  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });

  // The provider's own surface — the thing a debug dump or a metric would reach for.
  assert.deepEqual(Object.keys(provider).sort(), ['audience', 'getToken']);
  assert.equal(JSON.stringify(provider).includes('onlyinaclosure'), false);
  // The fact cache holds FACTS. A credential in a cache keyed on a caller-influenced domain is
  // how one merchant's read ends up serialised next to an Authorization value.
  const dumped = JSON.stringify([...(client._cache.__keys ? [] : [])]) + JSON.stringify(client._cache);
  assert.equal(dumped.includes('onlyinaclosure'), false);
  assert.equal(JSON.stringify(client._cache.get(`${MERCHANT} US`)), JSON.stringify(FACT_PURCHASE));
});

// ---- 6. isolation: the new deps must FORK the singleton ---------------------------------------------------

test('the three OIDC deps isolate — a test must never write into the process cache', () => {
  for (const key of ['oidcAudience', 'idTokenProvider', 'metadataFetchImpl']) {
    assert.ok(ISOLATING_KEYS.includes(key), `${key} must isolate`);
    assert.equal(isIsolatingDeps({ [key]: 'x' }), true, key);
  }
  // And the union is not a replacement: everything that isolated before still does.
  for (const key of ['env', 'fetchImpl', 'now', 'ttlMs', 'negativeTtlMs', 'timeoutMs', 'cacheMaxEntries', 'baseUrl', 'token']) {
    assert.ok(ISOLATING_KEYS.includes(key), `${key} must still isolate`);
  }
  assert.equal(isIsolatingDeps({ logger: null }), false, 'a logger still configures, not forks');
});

// ---- 7. the pre-existing provider is untouched -------------------------------------------------------------

test('createCloudRunIdTokenProvider still exists unchanged for its four store-audit callers', async () => {
  const { createCloudRunIdTokenProvider } = require('../src/services/cloudRunIdentityToken');
  const metadata = fakeMetadata();
  const provider = createCloudRunIdTokenProvider({
    audience: 'https://web.example', fetchImpl: metadata.fetchImpl,
  });
  assert.equal(provider.audience, 'https://web.example');
  assert.equal(typeof await provider.getToken(), 'string');
  assert.equal(metadata.calls[0].options.headers['metadata-flavor'], 'Google');
  // Its URL shape too, because a mutation sweep found that nothing in this repo asserted it —
  // `format=full` is what makes the token carry `email`, which is the claim the backend's
  // allow-list is built on. A silent drop to `format=standard` would 401 every read.
  const legacy = new URL(metadata.calls[0].url);
  assert.equal(legacy.searchParams.get('format'), 'full');
  assert.equal(legacy.searchParams.get('audience'), 'https://web.example');
});

test('a metadata failure is NOT sticky: the next read retries and gets the identity', async () => {
  // A mutant that cached the FAILURE would pin the process to the static fallback (or to no
  // credential at all) for the length of a TTL after one blip. The cache guard is written so a
  // cached entry needs a TOKEN, not merely a timestamp; this is what measures that.
  let fail = true;
  const token = identityToken({ expSeconds: 2_000_000, id: 'after-retry' });
  const calls = [];
  const metadataFetchImpl = async (url, options) => {
    calls.push(url);
    if (fail) return { ok: false, status: 500, text: async () => 'nope' };
    return { ok: true, status: 200, text: async () => token };
  };
  const backend = fakeBackend(FACT_PURCHASE);
  const client = createMerchantPurchasabilityClient({
    env: oidcEnv({ [OPS_TOKEN_ENV]: STATIC_TOKEN }),
    fetchImpl: backend.fetchImpl, metadataFetchImpl, ttlMs: 1, negativeTtlMs: 1,
  });

  await client.shouldOfferPurchase({ domain: MERCHANT, market: 'US' });
  assert.equal(backend.calls[0].options.headers.authorization, `Bearer ${STATIC_TOKEN}`);

  fail = false;
  // A DIFFERENT merchant, so the second read is a FACT-cache miss and actually reaches the
  // credential chain again — the two caches are independent and this test is about the second.
  await client.shouldOfferPurchase({ domain: 'second.example', market: 'US' });
  assert.equal(calls.length, 2, 'a failure must not be cached');
  assert.equal(backend.calls[1].options.headers.authorization, `Bearer ${token}`);
});
