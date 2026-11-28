'use strict';

// The gateway's client for the merchant door relay (src/services/doorRelay/relayFetch.js). What is pinned:
//   - the Google ID token rides ONLY on the relay hop's Authorization; the merchant's headers (a merchant bearer
//     included) ride inside the JSON body, in order;
//   - a relay refusal comes back as an Error with the SAME code the gateway's own transport would have thrown;
//   - an AbortSignal aborts the hop; the relay's time cap reads as AbortError (a timeout to every caller);
//   - a Response is rebuilt for 200, 204 and 302 (null-body statuses as toFetchResponse handles them), and a 3xx under
//     `redirect: 'error'` is the transport's PIVOTA_REDIRECT_REFUSED;
//   - the default ID token provider asks the metadata server with Metadata-Flavor and caches until near expiry.
// The hop and the metadata server are injected fakes; nothing leaves the process.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  createRelayFetch,
  createMetadataIdTokenProvider,
  validRelayOrigin,
  merchantDoorRelayMode,
  MAX_MERCHANT_RESPONSE_BYTES,
  METADATA_IDENTITY_URL,
} = require('../src/services/doorRelay/relayFetch');
const buyerClient = require('../src/services/ucpBuyerAgentClient');

const RELAY = 'https://door-relay.example';

function fakeHop(answer) {
  const calls = [];
  const hopFetch = async (url, init) => {
    calls.push({ url, init, payload: JSON.parse(init.body) });
    const a = typeof answer === 'function' ? await answer(calls[calls.length - 1]) : answer;
    return new Response(JSON.stringify(a.json), { status: a.status || 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, hopFetch };
}

const okEnvelope = (status, headers = [], body = '') => ({
  json: { status, headers, body_b64: Buffer.from(body).toString('base64') },
});

function jwt(expSeconds) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ aud: RELAY, exp: expSeconds })}.c2ln`;
}

describe('relayFetch', () => {
  test('the ID token goes only on the relay hop; merchant headers (its own bearer too) go inside the body, in order', async () => {
    const { calls, hopFetch } = fakeHop(okEnvelope(200, [['content-type', 'application/json']], '{"ok":true}'));
    const relayFetch = createRelayFetch({ relayUrl: RELAY, idTokenProvider: async (aud) => `id-token-for-${aud}`, hopFetch });
    const merchantHeaders = {
      'Content-Type': 'application/json',
      'Signature-Input': 'sig1=("@method");created=1;keyid="k"',
      Signature: 'sig1=:AAAA:',
      Authorization: 'Bearer merchant-tier-token',
    };
    const res = await relayFetch('https://merchant.example/api/ucp/mcp', { method: 'POST', headers: merchantHeaders, body: '{"a":1}' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(calls.length, 1);
    const [{ url, init, payload }] = calls;
    assert.equal(url, `${RELAY}/v1/fetch`);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, `Bearer id-token-for-${RELAY}`);
    assert.deepEqual(payload.headers, Object.entries(merchantHeaders));
    assert.equal(payload.url, 'https://merchant.example/api/ucp/mcp');
    assert.equal(payload.method, 'POST');
    assert.equal(Buffer.from(payload.body_b64, 'base64').toString(), '{"a":1}');
    assert.equal(JSON.stringify(payload).includes('id-token-for'), false, 'the ID token is not in what the relay forwards');
  });

  test('headers given as a Headers object or as pairs are carried too; a GET carries no body', async () => {
    const { calls, hopFetch } = fakeHop(okEnvelope(200));
    const relayFetch = createRelayFetch({ relayUrl: RELAY, idTokenProvider: async () => 't', hopFetch });
    await relayFetch('https://merchant.example/a', { headers: new Headers({ accept: 'application/json' }) });
    await relayFetch('https://merchant.example/b', { headers: [['X-A', '1'], ['X-B', '2']] });
    assert.deepEqual(calls[0].payload.headers, [['accept', 'application/json']]);
    assert.equal(calls[0].payload.method, 'GET');
    assert.equal(calls[0].payload.body_b64, null);
    assert.deepEqual(calls[1].payload.headers, [['X-A', '1'], ['X-B', '2']]);
  });

  for (const code of ['PIVOTA_SSRF_REFUSED', 'PIVOTA_SSRF_LITERAL', 'PIVOTA_SSRF_NAME', 'PIVOTA_SIZE_CAP', 'PIVOTA_UNSUPPORTED_STATUS', 'PIVOTA_RELAY_PORT', 'ECONNRESET']) {
    test(`a relay refusal ${code} comes back as an Error with the same code`, async () => {
      const { hopFetch } = fakeHop({ status: code.startsWith('PIVOTA_SSRF') ? 403 : 502, json: { error_code: code, message: 'refused' } });
      const relayFetch = createRelayFetch({ relayUrl: RELAY, idTokenProvider: async () => 't', hopFetch });
      await assert.rejects(relayFetch('https://merchant.example/x'), (err) => err.code === code && err.name === 'Error');
    });
  }

  test('the relay\'s time cap reads as AbortError (a timeout, not retried by fetchWithPolicy)', async () => {
    const { hopFetch } = fakeHop({ status: 504, json: { error_code: 'PIVOTA_RELAY_TIMEOUT', message: 'slow' } });
    const relayFetch = createRelayFetch({ relayUrl: RELAY, idTokenProvider: async () => 't', hopFetch });
    await assert.rejects(relayFetch('https://merchant.example/x'), (err) => err.code === 'PIVOTA_RELAY_TIMEOUT' && err.name === 'AbortError');
  });

  test('a Cloud Run refusal with no envelope (401/403/503) is PIVOTA_RELAY_UNAVAILABLE with the hop status', async () => {
    const hopFetch = async () => new Response('Forbidden', { status: 403 });
    const relayFetch = createRelayFetch({ relayUrl: RELAY, idTokenProvider: async () => 't', hopFetch });
    await assert.rejects(relayFetch('https://merchant.example/x'), (err) => err.code === 'PIVOTA_RELAY_UNAVAILABLE' && err.relayStatus === 403);
  });

  test('an unreachable relay is PIVOTA_RELAY_UNAVAILABLE; an identity failure is PIVOTA_RELAY_IDENTITY', async () => {
    const down = createRelayFetch({ relayUrl: RELAY, idTokenProvider: async () => 't', hopFetch: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(down('https://merchant.example/x'), { code: 'PIVOTA_RELAY_UNAVAILABLE' });
    let hopped = false;
    const noIdentity = createRelayFetch({
      relayUrl: RELAY,
      idTokenProvider: async () => { throw new Error('metadata down'); },
      hopFetch: async () => { hopped = true; return new Response('{}'); },
    });
    await assert.rejects(noIdentity('https://merchant.example/x'), { code: 'PIVOTA_RELAY_IDENTITY' });
    assert.equal(hopped, false, 'no hop without a token');
  });

  test('an AbortSignal aborts the hop with AbortError; an already-aborted one never hops', async () => {
    let hopSignal = null;
    const hopFetch = (_url, init) => new Promise((_resolve, reject) => {
      hopSignal = init.signal;
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const relayFetch = createRelayFetch({ relayUrl: RELAY, idTokenProvider: async () => 't', hopFetch });
    const ac = new AbortController();
    const pending = relayFetch('https://merchant.example/x', { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await assert.rejects(pending, (err) => err.name === 'AbortError');
    assert.equal(hopSignal.aborted, true);

    let called = false;
    const never = createRelayFetch({ relayUrl: RELAY, idTokenProvider: async () => 't', hopFetch: async () => { called = true; } });
    const gone = new AbortController();
    gone.abort();
    await assert.rejects(never('https://merchant.example/x', { signal: gone.signal }), (err) => err.name === 'AbortError');
    assert.equal(called, false);
  });

  test('the hop timeout fires when the relay does not answer', async () => {
    const hopFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const relayFetch = createRelayFetch({ relayUrl: RELAY, idTokenProvider: async () => 't', hopFetch, timeoutMs: 20 });
    await assert.rejects(relayFetch('https://merchant.example/x'), (err) => err.code === 'PIVOTA_RELAY_TIMEOUT' && err.name === 'AbortError');
  });

  test('Response reconstruction: 200 with headers and body, 204 with no body, 302 with Location', async () => {
    const answers = [
      okEnvelope(200, [['content-type', 'application/json'], ['x-request-id', 'r1']], '{"v":2}'),
      okEnvelope(204, [['x-a', 'b']], ''),
      okEnvelope(302, [['location', 'https://merchant.example/next']], '<html>moved</html>'),
    ];
    let i = 0;
    const { hopFetch } = fakeHop(() => answers[i++]);
    const relayFetch = createRelayFetch({ relayUrl: RELAY, idTokenProvider: async () => 't', hopFetch });
    const ok = await relayFetch('https://merchant.example/a');
    assert.equal(ok.status, 200);
    assert.equal(ok.ok, true);
    assert.equal(ok.headers.get('x-request-id'), 'r1');
    assert.equal(await ok.text(), '{"v":2}');
    const empty = await relayFetch('https://merchant.example/b');
    assert.equal(empty.status, 204);
    assert.equal(empty.body, null);
    assert.equal(empty.headers.get('x-a'), 'b');
    const moved = await relayFetch('https://merchant.example/c', { redirect: 'manual' });
    assert.equal(moved.status, 302);
    assert.equal(moved.ok, false);
    assert.equal(moved.headers.get('location'), 'https://merchant.example/next');
  });

  test('a 3xx under redirect:"error" is the transport\'s PIVOTA_REDIRECT_REFUSED; a 1xx is PIVOTA_UNSUPPORTED_STATUS', async () => {
    const { hopFetch } = fakeHop((call) => (call.payload.url.endsWith('/r') ? okEnvelope(307, [['location', 'https://x.example/']]) : okEnvelope(103)));
    const relayFetch = createRelayFetch({ relayUrl: RELAY, idTokenProvider: async () => 't', hopFetch });
    await assert.rejects(relayFetch('https://merchant.example/r', { redirect: 'error' }), { code: 'PIVOTA_REDIRECT_REFUSED' });
    await assert.rejects(relayFetch('https://merchant.example/i'), { code: 'PIVOTA_UNSUPPORTED_STATUS' });
  });

  test('a body over the transport cap is refused here too; the cap is the transport\'s own', async () => {
    assert.equal(MAX_MERCHANT_RESPONSE_BYTES, buyerClient.MAX_MERCHANT_RESPONSE_BYTES);
    const { hopFetch } = fakeHop({ json: { status: 200, headers: [], body_b64: Buffer.alloc(MAX_MERCHANT_RESPONSE_BYTES + 1).toString('base64') } });
    const relayFetch = createRelayFetch({ relayUrl: RELAY, idTokenProvider: async () => 't', hopFetch });
    await assert.rejects(relayFetch('https://merchant.example/x'), { code: 'PIVOTA_SIZE_CAP' });
  });

  test('the relay URL must be a bare https origin', () => {
    assert.equal(validRelayOrigin('https://door-relay.example'), RELAY);
    assert.equal(validRelayOrigin('https://door-relay.example/'), RELAY);
    for (const bad of ['', 'http://door-relay.example', 'https://u:p@door-relay.example', 'https://door-relay.example/v1', 'https://door-relay.example/?a=1', 'not a url', undefined]) {
      assert.equal(validRelayOrigin(bad), null, String(bad));
    }
    assert.throws(() => createRelayFetch({ relayUrl: 'http://door-relay.example' }), { code: 'PIVOTA_RELAY_UNCONFIGURED' });
  });

  test('the switch: only "on" is on', () => {
    assert.equal(merchantDoorRelayMode({}), 'off');
    assert.equal(merchantDoorRelayMode({ MERCHANT_DOOR_RELAY: 'off' }), 'off');
    assert.equal(merchantDoorRelayMode({ MERCHANT_DOOR_RELAY: '1' }), 'off');
    assert.equal(merchantDoorRelayMode({ MERCHANT_DOOR_RELAY: ' ON ' }), 'on');
  });
});

describe('metadata ID token provider', () => {
  test('asks the metadata server for the audience with Metadata-Flavor, and caches until near expiry', async () => {
    let t = 1_700_000_000_000;
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return new Response(jwt(Math.floor(t / 1000) + 3600), { status: 200 });
    };
    const provider = createMetadataIdTokenProvider({ fetchImpl, now: () => t });
    const first = await provider(RELAY);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(RELAY)}`);
    assert.equal(calls[0].init.headers['Metadata-Flavor'], 'Google');
    assert.equal(calls[0].init.redirect, 'error');
    t += 30 * 60 * 1000;
    assert.equal(await provider(RELAY), first);
    assert.equal(calls.length, 1, 'cached');
    t += 26 * 60 * 1000; // past exp - 5 min
    await provider(RELAY);
    assert.equal(calls.length, 2, 'refreshed before expiry');
  });

  test('concurrent callers share one mint; a non-200 or a non-JWT body is PIVOTA_RELAY_IDENTITY', async () => {
    let n = 0;
    const provider = createMetadataIdTokenProvider({
      fetchImpl: async () => { n += 1; await new Promise((r) => setTimeout(r, 5)); return new Response(jwt(Math.floor(Date.now() / 1000) + 3600)); },
    });
    await Promise.all([provider(RELAY), provider(RELAY), provider(RELAY)]);
    assert.equal(n, 1);
    const bad = createMetadataIdTokenProvider({ fetchImpl: async () => new Response('nope', { status: 404 }) });
    await assert.rejects(bad(RELAY), { code: 'PIVOTA_RELAY_IDENTITY' });
    const html = createMetadataIdTokenProvider({ fetchImpl: async () => new Response('<html>', { status: 200 }) });
    await assert.rejects(html(RELAY), { code: 'PIVOTA_RELAY_IDENTITY' });
  });
});
