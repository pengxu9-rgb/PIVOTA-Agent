#!/usr/bin/env node
'use strict';

/*
 * scripts/probe-ucp-platform-signature.cjs — MANUAL probe (NOT CI). Read-only.
 *
 * WHAT IT PROVES. Under a platform agent standard (2026-11), every UCP request we send names our profile in
 * `UCP-Agent` and is RFC 9421-signed with ES256 under a kid that profile publishes. This probe runs those
 * conformance cases and prints one line per case.
 *
 *   self (default, OFFLINE — nothing leaves the process)
 *     The REAL outbound client (ucpBuyerAgentClient) builds and signs each request against a placeholder
 *     merchant; a capturing fetch records the exact bytes and headers; our own UCP verifier
 *     (ucpSignatureVerifier.js) checks them against the profile document you give it.
 *       1  search_catalog verifies; covers @method @authority @path ucp-agent content-digest content-type
 *       2  create_cart (state-changing) verifies and also covers idempotency-key
 *       3  backend signer parity — not run here: pinned by the shared vectors tests in both repos
 *       4  a query string is covered as @query
 *       5  header profile = meta profile = the canonical URL
 *       8  body changed after signing -> digest_mismatch (400 / -32600)
 *       9  unsigned -> signature_missing (401 / -32000)
 *      10  an RFC 9421 order webhook (spec shape) is accepted by our receiver; a tampered one is refused
 *       K  the private key we sign with is the public key the profile publishes under that kid
 *
 *   --live --check-profile   case 6: GET our profile URL: 200, no redirect, Cache-Control public
 *                            max-age >= 60, the kid in signing_keys[] AND keys[] (keys[] is served only with UCP_AGENT_PUBLISH_JWKS=1), both arrays the same kids.
 *   --live --target <mcp-url> --allow-host <host>
 *                            cases 1, 8, 9 against a partner sandbox: search_catalog only.
 *
 * KEY MATERIAL. Default: UCP_AGENT_SIGNING_PRIVATE_KEY (+ UCP_AGENT_SIGNING_KEY_ID) from env, never printed,
 * never logged, never written. `--test-key` uses an ephemeral key generated in memory instead (no secret
 * needed — what a reviewer runs). The profile document comes from `--profile-file <path>` (a profile JSON,
 * or a bare public JWK such as the S1 ceremony's pub.jwk.json), or with --live from the profile URL.
 *
 * WHERE TO RUN --live. Not from a laptop: a partner sandbox is a store endpoint. Live runs go through the PR
 * controller session (staging / a one-off job), each with its own go. `--target` refuses any host not named
 * by `--allow-host`, and anything that is not https.
 *
 * Usage:
 *   node scripts/probe-ucp-platform-signature.cjs --test-key
 *   UCP_AGENT_SIGNING_PRIVATE_KEY=... UCP_AGENT_SIGNING_KEY_ID=... \
 *     node scripts/probe-ucp-platform-signature.cjs --profile-file pub.jwk.json
 *   node scripts/probe-ucp-platform-signature.cjs --live --check-profile [--profile-url <url>]
 *   node scripts/probe-ucp-platform-signature.cjs --live --target https://sandbox.example/ucp/mcp --allow-host sandbox.example
 * Flags: --json (machine-readable), --profile-url (default the canonical URL below).
 * Exit: 0 all PASS (SKIP allowed), 1 any FAIL, 2 usage error.
 */

const nodeCrypto = require('crypto');
const fs = require('fs');

const {
  createUcpBuyerAgentClient,
  signUcpRequest,
  loadSigningPrivateKey,
} = require('../src/services/ucpBuyerAgentClient');
const { createUcpSignatureVerifier, PROFILE_KIND } = require('../src/services/ucpSignatureVerifier');
const { createUcpOrderWebhookReceiver } = require('../src/services/ucpOrderWebhookReceiver');

// Decided 2026-11-20 (Peng): the one profile URL every Pivota UCP request names.
const CANONICAL_PROFILE_URL = 'https://ucp.pivota.cc/.well-known/ucp-agent';
// A placeholder merchant: self mode never resolves or contacts it.
const SELF_MERCHANT_HOST = 'merchant.probe.example';
const SELF_ENDPOINT = `https://${SELF_MERCHANT_HOST}/ucp/mcp`;
const SELF_BUSINESS_PROFILE = `https://${SELF_MERCHANT_HOST}/.well-known/ucp`;
const OUR_WEBHOOK_HOST = 'ucp.pivota.cc';

const PASS = 'PASS';
const FAIL = 'FAIL';
const SKIP = 'SKIP';

function result(id, name, ok, detail, status) {
  return { id: String(id), name, status: status || (ok ? PASS : FAIL), detail };
}

// ---- key + profile inputs -------------------------------------------------------------------------------

/** A profile document from a file: a profile JSON as-is, or a bare public JWK wrapped in both arrays. */
function profileDocFromJson(json) {
  if (json && typeof json === 'object' && !Array.isArray(json) && json.kty) {
    if (json.d !== undefined) throw new Error('the profile file holds PRIVATE key material; pass the public JWK');
    return { signing_keys: [json], keys: [json] };
  }
  return json;
}

function ephemeralKey() {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const kid = 'probe-ephemeral-key';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'ES256' };
  return {
    privateKeyRaw: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    keyId: kid,
    profileDoc: { signing_keys: [jwk], keys: [jwk] },
  };
}

/** Does the private key's public half equal the JWK the profile publishes under kid? Booleans only out. */
function keyMatchesProfile(privateKeyRaw, keyId, profileDoc) {
  const { keyObject } = loadSigningPrivateKey(privateKeyRaw);
  const pub = nodeCrypto.createPublicKey(keyObject).export({ format: 'jwk' });
  const lists = [profileDoc && profileDoc.signing_keys, profileDoc && profileDoc.keys].filter(Array.isArray);
  const published = lists.flat().filter((k) => k && k.kid === keyId);
  return {
    published: published.length > 0,
    matches: published.length > 0 && published.every((k) => k.kty === 'EC' && k.crv === 'P-256' && k.x === pub.x && k.y === pub.y),
  };
}

// ---- self mode ------------------------------------------------------------------------------------------

/** A fetch that records what the client sends and answers every MCP call with an empty success. */
function capturingFetch() {
  const calls = [];
  const impl = async (url, init = {}) => {
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = String(v);
    calls.push({ url: String(url), method: String(init.method || 'GET').toUpperCase(), headers, body: init.body == null ? null : String(init.body) });
    let id = 1;
    try { id = JSON.parse(init.body).id; } catch { /* keep 1 */ }
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '{}' }], structuredContent: {} } });
    return {
      ok: true,
      status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => payload,
      json: async () => JSON.parse(payload),
    };
  };
  return { impl, calls };
}

function asVerifierRequest(call) {
  const u = new URL(call.url);
  return {
    req: { method: call.method, originalUrl: `${u.pathname}${u.search}`, headers: { host: u.host, ...call.headers } },
    rawBody: call.body == null ? null : Buffer.from(call.body, 'utf8'),
  };
}

function lastMcpCall(calls, toolName) {
  return [...calls].reverse().find((c) => {
    try { return JSON.parse(c.body).params.name === toolName; } catch { return false; }
  });
}

function profileServingFetch(profileUrl, profileDoc) {
  return async (url) => (String(url) === profileUrl
    ? { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(profileDoc) }
    : { status: 404, headers: { get: () => null }, text: async () => '' });
}

async function runSelfCases({ privateKeyRaw, keyId, profileDoc, profileUrl = CANONICAL_PROFILE_URL }) {
  const out = [];
  const pair = keyMatchesProfile(privateKeyRaw, keyId, profileDoc);
  out.push(result('K', 'signing key = the public key the profile publishes under its kid', pair.matches,
    pair.published ? (pair.matches ? `kid ${keyId} matches` : `kid ${keyId} is published with a DIFFERENT public key`) : `kid ${keyId} is not in the profile`));

  const cap = capturingFetch();
  const client = createUcpBuyerAgentClient({
    profileUrl,
    signingPrivateKey: privateKeyRaw,
    signingKeyId: keyId,
    fetchImpl: cap.impl,
    allowTokenTier: false, // SIGNED tier exactly: no Bearer from this process's env rides along
    retryAttempts: 0,
  });
  const verifier = createUcpSignatureVerifier({
    env: { UCP_SIGNATURE_EXPECTED_AUTHORITIES: SELF_MERCHANT_HOST },
    trustedProfiles: [profileUrl],
    fetchImpl: profileServingFetch(profileUrl, profileDoc),
  });
  out.push(result('T', 'client runs at the SIGNED tier', client.tier === 'signed', `tier=${client.tier}`));

  await client.searchCatalog(SELF_ENDPOINT, { query: 'probe' }).catch(() => null);
  const search = lastMcpCall(cap.calls, 'search_catalog');
  if (!search) {
    out.push(result(1, 'search_catalog signed and verified', false, 'the client sent no search_catalog call'));
  } else {
    const { req, rawBody } = asVerifierRequest(search);
    const r = await verifier.verifyRequest(req, { rawBody });
    const want = ['"@method"', '"@authority"', '"@path"', '"ucp-agent"', '"content-digest"', '"content-type"'];
    const covers = want.every((c) => (r.covered || []).includes(c));
    out.push(result(1, 'search_catalog signed and verified', r.verified && covers, `${r.reason}; covered ${(r.covered || []).join(' ')}`));

    // 5: one identity, three places.
    const header = search.headers['ucp-agent'];
    let meta = null;
    try { meta = JSON.parse(search.body).params.arguments.meta['ucp-agent'].profile; } catch { meta = null; }
    const same = header === `profile="${CANONICAL_PROFILE_URL}"` && meta === CANONICAL_PROFILE_URL && profileUrl === CANONICAL_PROFILE_URL;
    out.push(result(5, 'header profile = meta profile = canonical URL', same, `header=${header} meta=${meta}`));

    // 8: the body changed after signing.
    const tampered = await verifier.verifyRequest(req, { rawBody: Buffer.from(String(search.body).replace('probe', 'tampered'), 'utf8') });
    out.push(result(8, 'body changed after signing is refused', tampered.reason === 'digest_mismatch'
      && tampered.ucp_error && tampered.ucp_error.http_status === 400 && tampered.ucp_error.jsonrpc_code === -32600,
    `${tampered.reason} -> ${tampered.ucp_error ? `${tampered.ucp_error.code} ${tampered.ucp_error.http_status}/${tampered.ucp_error.jsonrpc_code}` : 'none'}`));

    // 9: no signature at all.
    const unsignedHeaders = { ...req.headers };
    delete unsignedHeaders['signature-input'];
    delete unsignedHeaders.signature;
    const unsigned = await verifier.verifyRequest({ ...req, headers: unsignedHeaders }, { rawBody });
    out.push(result(9, 'unsigned request is refused', unsigned.reason === 'signature_missing'
      && unsigned.ucp_error.http_status === 401 && unsigned.ucp_error.jsonrpc_code === -32000,
    `${unsigned.reason} -> ${unsigned.ucp_error.http_status}/${unsigned.ucp_error.jsonrpc_code}`));
  }

  await client.createCart(SELF_ENDPOINT, { lineItems: [{ item: { id: 'gid://placeholder/ProductVariant/1' }, quantity: 1 }] }).catch(() => null);
  const cart = lastMcpCall(cap.calls, 'create_cart');
  if (!cart) {
    out.push(result(2, 'create_cart signed with idempotency-key covered', false, 'the client sent no create_cart call'));
  } else {
    const { req, rawBody } = asVerifierRequest(cart);
    const r = await verifier.verifyRequest(req, { rawBody });
    out.push(result(2, 'create_cart signed with idempotency-key covered', r.verified && (r.covered || []).includes('"idempotency-key"'),
      `${r.reason}; idempotency-key ${req.headers['idempotency-key'] ? 'sent' : 'NOT sent'}`));
  }

  out.push(result(3, 'backend signer parity', true, 'pinned by tests/ucp_request_signature_vectors (gateway) + tests/test_ucp_request_signing.py (backend)', SKIP));

  await client.searchCatalog(`${SELF_ENDPOINT}?shop=probe`, { query: 'probe' }).catch(() => null);
  const queried = [...cap.calls].reverse().find((c) => c.url.includes('?shop=probe'));
  if (!queried) {
    out.push(result(4, 'query string covered as @query', false, 'the client sent no call to the query-string endpoint'));
  } else {
    const { req, rawBody } = asVerifierRequest(queried);
    const r = await verifier.verifyRequest(req, { rawBody });
    out.push(result(4, 'query string covered as @query', r.verified && (r.covered || []).includes('"@query"'), r.reason));
  }

  out.push(...await runWebhookSelfCase());
  return out;
}

/** Case 10: a business-signed RFC 9421 order webhook (the spec's shape) through our real receiver. */
async function runWebhookSelfCase() {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'probe-business-key' };
  const receiver = createUcpOrderWebhookReceiver({
    env: {
      UCP_ORDER_WEBHOOK_RECEIVER_ENABLED: '1',
      UCP_ORDER_WEBHOOK_RFC9421_MODE: 'accept',
      UCP_ORDER_WEBHOOK_TRUSTED_BUSINESS_PROFILES: SELF_BUSINESS_PROFILE,
    },
    fetchImpl: profileServingFetch(SELF_BUSINESS_PROFILE, { ucp: { signing_keys: [jwk] } }),
    logger: null,
  });
  const body = JSON.stringify({ id: 'order-probe-1', checkout_id: 'co-probe-1', status: 'confirmed' });
  const now = Math.floor(Date.now() / 1000);
  const { headers: sig } = signUcpRequest({
    method: 'POST', url: `https://${OUR_WEBHOOK_HOST}/ucp/order-webhook`, bodyString: body,
    ucpAgentValue: `profile="${SELF_BUSINESS_PROFILE}"`, keyObject: privateKey, keyid: jwk.kid, created: now, expires: now + 300,
  });
  const headers = { host: OUR_WEBHOOK_HOST, 'content-type': 'application/json', 'ucp-agent': `profile="${SELF_BUSINESS_PROFILE}"`, 'webhook-id': 'evt-probe-1', ...sig };
  const post = (b) => receiver.handleOrderWebhook({
    headers, rawBody: b, rawBodyBytes: Buffer.from(b, 'utf8'), body: JSON.parse(b), request: { method: 'POST', originalUrl: '/ucp/order-webhook' },
  });
  const good = await post(body);
  const bad = await post(body.replace('confirmed', 'cancelled'));
  return [
    result(10, 'inbound RFC 9421 order webhook accepted; tampered one refused',
      good.status === 200 && good.body.meta && good.body.meta.signature_scheme === 'rfc9421' && bad.status === 401 && bad.body.code === 'digest_mismatch',
      `good=${good.status} tampered=${bad.status} ${bad.body && bad.body.code}`),
  ];
}

// ---- live: case 6, our profile endpoint -----------------------------------------------------------------

function maxAgeOf(cacheControl) {
  const m = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(String(cacheControl || ''));
  return m ? Number(m[1]) : null;
}

async function checkProfileEndpoint({ profileUrl = CANONICAL_PROFILE_URL, keyId, fetchImpl = globalThis.fetch }) {
  let res;
  try {
    res = await fetchImpl(profileUrl, { redirect: 'manual', headers: { accept: 'application/json' } });
  } catch (err) {
    return [result(6, 'profile endpoint conforms', false, `fetch failed: ${err && err.message}`)];
  }
  const cc = res.headers.get('cache-control');
  const maxAge = maxAgeOf(cc);
  let doc = null;
  try { doc = JSON.parse(await res.text()); } catch { doc = null; }
  const kidsOf = (arr) => (Array.isArray(arr) ? arr.map((k) => k && k.kid).filter(Boolean).sort() : null);
  const sk = kidsOf(doc && doc.signing_keys);
  const k = kidsOf(doc && doc.keys);
  const checks = {
    status_200: res.status === 200,
    no_redirect: !(res.status >= 300 && res.status < 400),
    cache_public: /(?:^|,)\s*public\s*(?:,|$)/i.test(String(cc || '')),
    max_age_ge_60: maxAge !== null && maxAge >= 60,
    kid_in_signing_keys: Boolean(sk && keyId && sk.includes(keyId)),
    kid_in_keys: Boolean(k && keyId && k.includes(keyId)),
    same_kids_both_arrays: Boolean(sk && k && sk.join() === k.join()),
  };
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([n]) => n);
  return [result(6, 'profile endpoint conforms', failed.length === 0,
    `status=${res.status} cache-control=${cc || 'none'} signing_keys=${sk ? sk.join('|') : 'none'} keys=${k ? k.join('|') : 'none'}${failed.length ? ` FAILED: ${failed.join(', ')}` : ''}`)];
}

// ---- live: cases 1, 8, 9 against a partner sandbox ------------------------------------------------------

function rpcErrorCode(json) {
  const e = json && json.error;
  if (!e) return null;
  return { jsonrpc_code: e.code, code: (e.data && e.data.code) || null };
}

async function sendLiveCases({ target, privateKeyRaw, keyId, profileUrl = CANONICAL_PROFILE_URL, fetchImpl = globalThis.fetch }) {
  const { keyObject } = loadSigningPrivateKey(privateKeyRaw);
  const ucpAgentValue = `profile="${profileUrl}"`;
  const body = (query) => JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'search_catalog', arguments: { meta: { 'ucp-agent': { profile: profileUrl } }, catalog: { query } } },
  });
  const send = async (headers, bodyString) => {
    const res = await fetchImpl(target, { method: 'POST', redirect: 'manual', headers, body: bodyString });
    let json = null;
    try { json = JSON.parse(await res.text()); } catch { json = null; }
    return { status: res.status, rpc: rpcErrorCode(json) };
  };
  const signed = (bodyString) => {
    const now = Math.floor(Date.now() / 1000);
    const { headers } = signUcpRequest({ method: 'POST', url: target, bodyString, ucpAgentValue, keyObject, keyid: keyId, created: now, expires: now + 300 });
    return { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'ucp-agent': ucpAgentValue, ...headers };
  };
  const describe = (r) => `http=${r.status}${r.rpc ? ` rpc=${r.rpc.jsonrpc_code} ${r.rpc.code || ''}` : ''}`;
  const out = [];
  const ok = await send(signed(body('serum')), body('serum'));
  out.push(result('1L', 'sandbox accepts our signed search_catalog', ok.status === 200 && !ok.rpc, describe(ok)));
  const tampered = await send(signed(body('serum')), body('tampered'));
  out.push(result('8L', 'sandbox refuses a body changed after signing (digest_mismatch)',
    tampered.status === 400 || (tampered.rpc && (tampered.rpc.code === 'digest_mismatch' || tampered.rpc.jsonrpc_code === -32600)), describe(tampered)));
  const unsigned = await send({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'ucp-agent': ucpAgentValue }, body('serum'));
  out.push(result('9L', 'sandbox refuses an unsigned request (signature_missing)',
    unsigned.status === 401 || (unsigned.rpc && (unsigned.rpc.code === 'signature_missing' || unsigned.rpc.jsonrpc_code === -32000)), describe(unsigned)));
  return out;
}

// ---- CLI ------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { json: false, live: false, testKey: false, checkProfile: false };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new Error(`${v} needs a value`); return argv[i]; };
    if (v === '--json') a.json = true;
    else if (v === '--live') a.live = true;
    else if (v === '--test-key') a.testKey = true;
    else if (v === '--check-profile') a.checkProfile = true;
    else if (v === '--profile-file') a.profileFile = next();
    else if (v === '--profile-url') a.profileUrl = next();
    else if (v === '--target') a.target = next();
    else if (v === '--allow-host') a.allowHost = next();
    else throw new Error(`unknown argument ${v}`);
  }
  return a;
}

/** Validate a --target: https, and exactly the host --allow-host names. */
function checkTarget(target, allowHost) {
  let u;
  try { u = new URL(String(target)); } catch { return 'target is not a URL'; }
  if (u.protocol !== 'https:') return 'target must be https';
  if (!allowHost || u.host.toLowerCase() !== String(allowHost).toLowerCase()) return `target host ${u.host} is not the --allow-host value`;
  return null;
}

async function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, fetchImpl } = {}) {
  let args;
  try {
    args = parseArgs(argv);
    if ((args.target || args.checkProfile) && !args.live) throw new Error('--target and --check-profile reach the network: add --live');
    if (args.target) {
      const bad = checkTarget(args.target, args.allowHost);
      if (bad) throw new Error(bad);
    }
  } catch (err) {
    stdout.write(`usage error: ${err.message}\n`);
    return 2;
  }
  const profileUrl = args.profileUrl || CANONICAL_PROFILE_URL;

  let privateKeyRaw;
  let keyId;
  let profileDoc;
  try {
    if (args.testKey) {
      ({ privateKeyRaw, keyId, profileDoc } = ephemeralKey());
    } else {
      privateKeyRaw = String(env.UCP_AGENT_SIGNING_PRIVATE_KEY || '').trim();
      if (!privateKeyRaw) throw new Error('no UCP_AGENT_SIGNING_PRIVATE_KEY (or pass --test-key)');
      keyId = String(env.UCP_AGENT_SIGNING_KEY_ID || '').trim() || loadSigningPrivateKey(privateKeyRaw).kid;
      if (!keyId) throw new Error('no UCP_AGENT_SIGNING_KEY_ID and no kid in the JWK');
      if (args.profileFile) profileDoc = profileDocFromJson(JSON.parse(fs.readFileSync(args.profileFile, 'utf8')));
    }
  } catch (err) {
    // Never echo key material: the message is ours, or a parse error about a file path.
    stdout.write(`usage error: ${err.message}\n`);
    return 2;
  }

  const results = [];
  if (args.live && args.checkProfile) {
    results.push(...await checkProfileEndpoint({ profileUrl, keyId, fetchImpl: fetchImpl || globalThis.fetch }));
  }
  if (args.live && args.target) {
    results.push(...await sendLiveCases({ target: args.target, privateKeyRaw, keyId, profileUrl, fetchImpl: fetchImpl || globalThis.fetch }));
  }
  if (!args.target && !args.checkProfile) {
    if (!profileDoc) {
      stdout.write('usage error: self mode needs --profile-file (or --test-key)\n');
      return 2;
    }
    results.push(...await runSelfCases({ privateKeyRaw, keyId, profileDoc, profileUrl }));
  }

  if (args.json) {
    stdout.write(`${JSON.stringify({ profile_url: profileUrl, kid: keyId, results }, null, 2)}\n`);
  } else {
    stdout.write(`UCP platform signature probe — profile ${profileUrl}, kid ${keyId}\n`);
    for (const r of results) stdout.write(`${r.status.padEnd(4)}  ${r.id.padEnd(3)} ${r.name} — ${r.detail}\n`);
  }
  return results.some((r) => r.status === FAIL) ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    process.stdout.write(`probe error: ${err && err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CANONICAL_PROFILE_URL,
  main,
  parseArgs,
  checkTarget,
  profileDocFromJson,
  keyMatchesProfile,
  runSelfCases,
  checkProfileEndpoint,
  sendLiveCases,
  maxAgeOf,
};
