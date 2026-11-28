'use strict';

// A SIGNED merchant-door call still verifies after the door relay hop (src/services/doorRelay/*).
//
// The buyer-agent client signs its UCP MCP calls with RFC 9421 (ES256) over @method, @authority, @path, ucp-agent,
// idempotency-key, content-digest and content-type. With MERCHANT_DOOR_RELAY=on that request no longer leaves this
// process: relayFetch packs it into JSON, the relay service unpacks it and its transport sends it. Any change on the
// way (a header renamed, joined, dropped or re-encoded, a body re-serialized, a path normalized) breaks the signature
// at the merchant, and nothing else in the suite would notice. What is pinned here:
//   - the request the relay's transport is handed carries the client's exact header list (Signature, Signature-Input,
//     Content-Digest, UCP-Agent, Idempotency-Key, Content-Type and the rest, in order) and its exact body bytes;
//   - the relay hop's own Authorization (the ID token) is not among them; at the TOKEN tier the merchant's Bearer is;
//   - the merchant's side of the check passes: the repo's own verifier (ucpSignatureVerifier.js), given what the relay
//     sent and the key the client's own profile publishes, says `verified`;
//   - negative controls: the same check fails when the transport sees one covered header, the body, or the path
//     changed.
// The key pair is generated here per run. The relay listens on 127.0.0.1; its transport is an injected fake, so no
// DNS lookup and no socket to any merchant ever happens. Hosts are example.com-style placeholders.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const nodeCrypto = require('node:crypto');

const { createDoorRelayHandler } = require('../src/services/doorRelay/server');
const { createRelayFetch } = require('../src/services/doorRelay/relayFetch');
const { createUcpBuyerAgentClient, TRUST_TIER } = require('../src/services/ucpBuyerAgentClient');
const { createUcpSignatureVerifier } = require('../src/services/ucpSignatureVerifier');

const RELAY_ORIGIN = 'https://door-relay.example';
const MERCHANT_HOST = 'merchant.example';
const MCP_ENDPOINT = `https://${MERCHANT_HOST}/api/ucp/mcp`;
const PROFILE_URL = 'https://agent.example/.well-known/ucp-agent';
const KID = 'door-relay-roundtrip-test-key';
const ID_TOKEN = 'relay-hop-id-token.for-tests-only.not-a-real-token';
const MERCHANT_BEARER = 'merchant-tier-token-for-tests-only';

// Ephemeral, per run. Neither half is written anywhere.
const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PUBLIC_JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig' };
const PRIVATE_JWK_JSON = JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid: KID });

const MCP_ANSWER = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  result: { content: [{ type: 'text', text: JSON.stringify({ id: 'cart-test-1', continue_url: `https://${MERCHANT_HOST}/cart/c/1` }) }] },
});

// The relay, on 127.0.0.1, with a fake transport that records exactly what it is handed. `tamper` (per test) edits
// the request before it is recorded, standing in for a relay that changed something on the way.
let relayServer;
let relayBase;
const transportCalls = [];
const hopCalls = [];
let tamper = null;

async function fakeTransport(url, init) {
  let call = {
    url,
    method: init.method,
    headerPairs: Object.entries(init.headers || {}),
    body: init.body ? Buffer.from(init.body) : null,
  };
  if (typeof tamper === 'function') call = tamper(call);
  transportCalls.push(call);
  return new Response(MCP_ANSWER, { status: 200, headers: { 'content-type': 'application/json' } });
}

// The hop goes to the relay's https origin; here that origin is the 127.0.0.1 server.
async function hopFetch(url, init) {
  hopCalls.push({ url, init });
  const local = String(url).replace(RELAY_ORIGIN, relayBase);
  return fetch(local, init);
}

before(async () => {
  relayServer = http.createServer(createDoorRelayHandler({ transport: fakeTransport, log: () => {} }));
  await new Promise((resolve) => relayServer.listen(0, '127.0.0.1', resolve));
  relayBase = `http://127.0.0.1:${relayServer.address().port}`;
});

after(async () => {
  await new Promise((resolve) => relayServer.close(resolve));
});

/** A client whose merchant fetch is the relay; `sent` records what the client handed that fetch. */
function relayedClient(extra) {
  const relayFetch = createRelayFetch({ relayUrl: RELAY_ORIGIN, idTokenProvider: async () => ID_TOKEN, hopFetch });
  const sent = [];
  const client = createUcpBuyerAgentClient({
    profileUrl: PROFILE_URL,
    signingPrivateKey: PRIVATE_JWK_JSON,
    signingKeyId: KID,
    signingKeys: [PUBLIC_JWK],
    retryAttempts: 0,
    merchantFetchImpl: async (url, options) => {
      sent.push({ url, method: options.method, headerPairs: Object.entries(options.headers), body: Buffer.from(options.body, 'utf8') });
      return relayFetch(url, options);
    },
    ...extra,
  });
  return { client, sent };
}

/** The merchant's view of what the relay sent, shaped like a node:http IncomingMessage the verifier reads. */
function merchantRequest(call) {
  const u = new URL(call.url);
  const headers = { host: u.host };
  const rawHeaders = ['Host', u.host];
  for (const [name, value] of call.headerPairs) {
    const lower = name.toLowerCase();
    headers[lower] = headers[lower] === undefined ? value : `${headers[lower]}, ${value}`;
    rawHeaders.push(name, value);
  }
  return { method: call.method, originalUrl: `${u.pathname}${u.search}`, headers, rawHeaders, protocol: 'https' };
}

/** The merchant-side check, with the key fetched from the client's OWN published profile (injected, no network). */
function verifyAsMerchant(client, call) {
  const profileDoc = client.buildProfile();
  const verifier = createUcpSignatureVerifier({
    env: { UCP_SIGNATURE_EXPECTED_AUTHORITIES: MERCHANT_HOST },
    trustedProfiles: [PROFILE_URL],
    fetchImpl: async (url) => (String(url) === PROFILE_URL
      ? { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(profileDoc) }
      : { status: 404, headers: { get: () => null }, text: async () => '' }),
  });
  return verifier.verifyRequest(merchantRequest(call), { rawBody: call.body });
}

const header = (pairs, name) => {
  const hit = pairs.find(([n]) => n.toLowerCase() === name);
  return hit ? hit[1] : undefined;
};

async function oneCall(client, tool) {
  transportCalls.length = 0;
  hopCalls.length = 0;
  const result = tool === 'lookup_catalog'
    ? await client.lookupCatalog(MCP_ENDPOINT, { ids: ['gid://shopify/Product/1'] })
    : await client.createCart(MCP_ENDPOINT, { lineItems: [{ item: { id: 'gid://shopify/ProductVariant/1' }, quantity: 1 }] });
  assert.equal(result.ok, true, 'the faked merchant answer comes back through the relay');
  assert.equal(transportCalls.length, 1, 'exactly one outbound request per tool call');
  assert.equal(hopCalls.length, 1, 'exactly one relay hop per tool call');
  return transportCalls[0];
}

const CASES = [
  { name: 'SIGNED tier', options: {}, tier: TRUST_TIER.SIGNED, bearer: false },
  { name: 'TOKEN tier with signAlways', options: { credential: MERCHANT_BEARER, signAlways: true }, tier: TRUST_TIER.TOKEN, bearer: true },
];

for (const c of CASES) {
  describe(`door relay keeps a signed call verifiable — ${c.name}`, () => {
    for (const tool of ['create_cart', 'lookup_catalog']) {
      test(`${tool}: the relay forwards the client's headers and body byte for byte, and the merchant verifies it`, async () => {
        tamper = null;
        const { client, sent } = relayedClient(c.options);
        assert.equal(client.tier, c.tier);
        assert.equal(client.describeTier().signs_requests, true, 'this client signs its calls');

        const out = await oneCall(client, tool);
        assert.equal(sent.length, 1);
        const original = sent[0];

        // What left the relay is what the client produced.
        assert.equal(out.url, MCP_ENDPOINT);
        assert.equal(out.method, 'POST');
        assert.deepEqual(out.headerPairs, original.headerPairs, 'same header names, case, values and order');
        assert.ok(out.body.equals(original.body), 'same body bytes');
        for (const name of ['signature', 'signature-input', 'content-digest', 'ucp-agent', 'idempotency-key', 'content-type']) {
          const value = header(out.headerPairs, name);
          assert.ok(value, `${name} is forwarded`);
          assert.equal(value, header(original.headerPairs, name), `${name} is unchanged`);
        }
        const covered = header(out.headerPairs, 'signature-input');
        for (const component of ['"@method"', '"@authority"', '"@path"', '"ucp-agent"', '"idempotency-key"', '"content-digest"', '"content-type"']) {
          assert.ok(covered.includes(component), `the signature covers ${component}`);
        }

        // The relay hop carried the ID token; the merchant request does not.
        assert.equal(hopCalls[0].init.headers.authorization, `Bearer ${ID_TOKEN}`);
        assert.equal(out.headerPairs.some(([, v]) => v.includes(ID_TOKEN)), false, 'the ID token is not a forwarded header value');
        assert.equal(header(out.headerPairs, 'authorization'), c.bearer ? `Bearer ${MERCHANT_BEARER}` : undefined,
          c.bearer ? 'the merchant Bearer is forwarded at the TOKEN tier' : 'no Authorization at the SIGNED tier');

        const result = await verifyAsMerchant(client, out);
        assert.equal(result.reason, 'ok', `verifier says ${result.reason}`);
        assert.equal(result.verified, true);
        assert.equal(result.keyid, KID);
        assert.equal(result.authority, MERCHANT_HOST);
        assert.equal(result.meta_binding, 'match', 'the body names the same profile as the UCP-Agent header');
      });
    }

    const TAMPERS = [
      {
        what: 'a covered header (idempotency-key) changed',
        edit: (call) => ({ ...call, headerPairs: call.headerPairs.map(([n, v]) => [n, n.toLowerCase() === 'idempotency-key' ? `${v}0` : v]) }),
        reason: 'bad_signature',
      },
      {
        what: 'a covered header (content-type) re-spelled with a charset',
        edit: (call) => ({ ...call, headerPairs: call.headerPairs.map(([n, v]) => [n, n.toLowerCase() === 'content-type' ? `${v}; charset=utf-8` : v]) }),
        reason: 'bad_signature',
      },
      {
        what: 'the body re-serialized (one byte added)',
        edit: (call) => ({ ...call, body: Buffer.concat([call.body, Buffer.from('\n')]) }),
        reason: 'digest_mismatch',
      },
      {
        what: 'the path changed (trailing slash)',
        edit: (call) => ({ ...call, url: `${call.url}/` }),
        reason: 'bad_signature',
      },
    ];
    for (const t of TAMPERS) {
      test(`negative control: ${t.what} -> not verified (${t.reason})`, async () => {
        tamper = t.edit;
        try {
          const { client } = relayedClient(c.options);
          const out = await oneCall(client, 'create_cart');
          const result = await verifyAsMerchant(client, out);
          assert.equal(result.verified, false);
          assert.equal(result.reason, t.reason);
        } finally {
          tamper = null;
        }
      });
    }
  });
}
