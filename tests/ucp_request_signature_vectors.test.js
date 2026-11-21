'use strict';

// The shared RFC 9421 request-signing vectors. The backend's checkout client signs UCP calls with its own
// (Python) signer, and a platform is ONE identity to the merchant: both signers must produce the same
// Signature-Input, signature base and Content-Digest for the same request. The vector file is generated from
// THIS signer and copied verbatim into pivota-backend (tests/fixtures/ucp_request_signature_vectors.json),
// whose test reproduces it. This test pins the gateway side, so a change here that would split the two
// signers fails before it ships. The key is TEST-ONLY (the one in ucp_buyer_agent_client.test.js).

const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vectors = require('./fixtures/ucp_request_signature_vectors.json');

// The SAME sha256 is pinned in pivota-backend tests/test_ucp_request_signing.py. A regenerated or edited
// vector file fails here AND there until both pins move together, so the two copies cannot drift apart.
const VECTORS_SHA256 = 'c263a74407f74187f1d7ae3f2a7f6664a54186c5794caafe50c50138f4786b50';
const { buildUcpSignatureBase } = require('../src/services/ucpBuyerAgentClient');

describe('shared UCP request-signature vectors (gateway side)', () => {
  test('the vector file is byte-for-byte the copy pivota-backend pins (same sha256 in both repos)', () => {
    const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'ucp_request_signature_vectors.json'));
    expect(nodeCrypto.createHash('sha256').update(bytes).digest('hex')).toBe(VECTORS_SHA256);
  });

  const pub = nodeCrypto.createPublicKey({ key: vectors.public_jwk, format: 'jwk' });

  test.each(vectors.cases.map((c) => [c.name, c]))('%s: the gateway signer reproduces the vector', (_name, c) => {
    const built = buildUcpSignatureBase({
      method: c.method,
      url: c.url,
      bodyString: c.body,
      ucpAgentValue: c.ucp_agent || undefined,
      idempotencyKey: c.idempotency_key || undefined,
      keyid: vectors.public_jwk.kid,
      created: vectors.created,
      expires: vectors.expires,
    });
    expect(built.covered).toEqual(c.expected.covered);
    expect(built.base).toBe(c.expected.signature_base);
    expect(`sig1=${built.params}`).toBe(c.expected.signature_input);
    expect(built.contentDigest ?? null).toBe(c.expected.content_digest);
  });

  test.each(vectors.cases.map((c) => [c.name, c]))('%s: the recorded signature verifies (raw r||s)', (_name, c) => {
    const sig = Buffer.from(/^sig1=:(.*):$/.exec(c.expected.gateway_signature)[1], 'base64');
    expect(sig).toHaveLength(64);
    const ok = nodeCrypto.verify('sha256', Buffer.from(c.expected.signature_base, 'utf8'), { key: pub, dsaEncoding: 'ieee-p1363' }, sig);
    expect(ok).toBe(true);
  });

  test('the vectors cover the spec cases that matter', () => {
    const all = vectors.cases.flatMap((c) => c.expected.covered);
    for (const id of ['@method', '@authority', '@path', '@query', 'ucp-agent', 'idempotency-key', 'content-digest', 'content-type']) {
      expect(all).toContain(id);
    }
    expect(vectors.cases.some((c) => /[^\x00-\x7f]/.test(c.body || ''))).toBe(true);
    // The URL shapes where the raw text and the wire differ: both signers must sign the WIRE form.
    for (const n of ['url_path_with_space', 'url_path_non_ascii', 'url_dot_segments', 'url_query_space_and_non_ascii', 'url_idn_host', 'url_ipv6_host_with_port']) {
      expect(vectors.cases.map((c) => c.name)).toContain(n);
    }
  });
});
