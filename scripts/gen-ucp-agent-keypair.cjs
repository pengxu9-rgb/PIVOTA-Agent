#!/usr/bin/env node
'use strict';

/*
 * scripts/gen-ucp-agent-keypair.cjs — generate Pivota's UCP buyer-agent SIGNED-tier keypair (ECDSA P-256).
 *
 * The SIGNED trust tier (shopify.dev/docs/agents/profiles/auth-and-rate-limiting) is "No registration required":
 * Pivota signs UCP requests (RFC 9421) with its OWN key and publishes the PUBLIC half in its hosted profile's
 * `ucp.signing_keys`. This script mints that keypair. It DOES NOT write any repo file — you copy the outputs into
 * secrets/env yourself, so a real key is never committed.
 *
 *   node scripts/gen-ucp-agent-keypair.cjs [--kid <key-id>]
 *
 * Outputs:
 *   1. PUBLIC JWK  -> set as env  UCP_AGENT_SIGNING_PUBLIC_JWK  (published in the profile; safe to commit/share).
 *   2. PRIVATE key -> set as env  UCP_AGENT_SIGNING_PRIVATE_KEY (PEM). STORE AS A SECRET. NEVER COMMIT / LOG.
 *   3. key id      -> set as env  UCP_AGENT_SIGNING_KEY_ID      (matches the JWK `kid`; the request `keyid`).
 *
 * HARD BOUND: the private key is printed ONCE to stdout for you to store in a secret manager. It is not written
 * to disk by this script. Run it in a trusted terminal, capture the private key into your secret store, and
 * clear your scrollback.
 */

const crypto = require('node:crypto');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--kid') { out.kid = argv[i + 1]; i += 1; }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const kid = args.kid || `pivota-ucp-agent-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const publicJwk = publicKey.export({ format: 'jwk' });
  publicJwk.kid = kid;
  publicJwk.use = 'sig';
  // crv is already 'P-256'; kty 'EC'. No `alg` needed — verifiers derive it from crv.

  const w = (s) => process.stdout.write(`${s}\n`);
  w('==============================================================================');
  w(' Pivota UCP buyer-agent SIGNED-tier keypair (ECDSA P-256 / RFC 9421)');
  w('==============================================================================');
  w('');
  w(`key id (kid): ${kid}`);
  w('');
  w('---- 1) PUBLIC JWK — publish in the profile. Set as env UCP_AGENT_SIGNING_PUBLIC_JWK ----');
  w('     (safe to share/commit — it is the PUBLIC key)');
  w(JSON.stringify(publicJwk));
  w('');
  w('---- 2) UCP_AGENT_SIGNING_KEY_ID ----');
  w(kid);
  w('');
  w('******************************************************************************');
  w('* 3) PRIVATE KEY — set as env UCP_AGENT_SIGNING_PRIVATE_KEY                   *');
  w('*    >>> STORE THIS IN A SECRET MANAGER. NEVER COMMIT IT. NEVER LOG IT. <<<   *');
  w('*    It is printed here ONCE and is NOT written to any file by this script.   *');
  w('******************************************************************************');
  w(privatePem.trim());
  w('');
  w('After storing the secret, clear your terminal scrollback.');
}

main();
