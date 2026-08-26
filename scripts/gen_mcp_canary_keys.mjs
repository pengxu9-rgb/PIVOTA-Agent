#!/usr/bin/env node
/*
 * Generate the ES256 keypairs the pure-MCP paid canary (scripts/probe_pure_mcp_paid_canary.mjs) needs:
 *   - IDENTITY key — signs the buyer X-Agent-User-JWT (claims: { acp_session_id }, iss/aud/sub)
 *   - PAYMENT  key — signs the delegated payment grant (claims: { allowance: { max_amount, currency,
 *                    merchant_id, checkout_session_id, user_ref } }, iss/aud)
 *
 * Writes the PRIVATE JWKs to tmp/canary-keys/ (gitignored) for the operator to load as env vars, and prints
 * the PUBLIC issuer-registry objects to ADD (additively) to the gateway's IDENTITY_ISSUERS_JSON and
 * PAYMENT_ISSUERS_JSON. Private key material is NEVER printed to stdout and NEVER committed.
 *
 * Override the iss/aud/sub/merchant via env: CANARY_IDENTITY_ISS, CANARY_IDENTITY_AUD, CANARY_IDENTITY_SUB,
 * CANARY_PAYMENT_ISS, CANARY_PAYMENT_AUD, PROBE_MERCHANT_ID. The aud values MUST match what the gateway's
 * identity/payment verifiers expect (they are checked against the issuer-registry `aud`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function loadJose() {
  try {
    return await import('jose');
  } catch {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const fallback = path.join(here, '..', 'safety-kernel', 'node_modules', 'jose', 'dist', 'webapi', 'index.js');
    return import(pathToFileURL(fallback).href);
  }
}

function env(name, dflt) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : dflt;
}

const IDENTITY_ISS = env('CANARY_IDENTITY_ISS', 'https://canary.pivota.cc/identity');
const IDENTITY_AUD = env('CANARY_IDENTITY_AUD', 'https://agent.pivota.cc/mcp');
const IDENTITY_SUB = env('CANARY_IDENTITY_SUB', 'canary-buyer-001');
const PAYMENT_ISS = env('CANARY_PAYMENT_ISS', 'https://canary.pivota.cc/payments');
const PAYMENT_AUD = env('CANARY_PAYMENT_AUD', 'https://agent.pivota.cc/mcp');
const MERCHANT_ID = env('PROBE_MERCHANT_ID', 'merch_efbc46b4619cfbdf');

const { generateKeyPair, exportJWK } = await loadJose();

async function makeKey(kid) {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const priv = await exportJWK(privateKey);
  const pub = await exportJWK(publicKey);
  priv.alg = pub.alg = 'ES256';
  priv.kid = pub.kid = kid;
  pub.use = 'sig';
  return { priv, pub };
}

const identity = await makeKey('canary-identity-1');
const payment = await makeKey('canary-payment-1');

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'tmp', 'canary-keys');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'identity.private.jwk.json'), JSON.stringify(identity.priv));
writeFileSync(path.join(outDir, 'payment.private.jwk.json'), JSON.stringify(payment.priv));

const identityIssuer = { iss: IDENTITY_ISS, aud: IDENTITY_AUD, algs: ['ES256'], jwks: { keys: [identity.pub] } };
const paymentIssuer = { iss: PAYMENT_ISS, aud: PAYMENT_AUD, algs: ['ES256'], jwks: { keys: [payment.pub] } };

// The user_ref the gateway derives from the identity token (sha256(iss|sub) → base64url[:32], usr_ prefix).
const userRef = `usr_${createHash('sha256').update(`${IDENTITY_ISS}|${IDENTITY_SUB}`, 'utf8').digest('base64url').slice(0, 32)}`;

console.log('# ===== GATEWAY config (PUBLIC keys) — add these objects to the EXISTING arrays (additive) =====');
console.log('# Append to IDENTITY_ISSUERS_JSON:');
console.log(JSON.stringify(identityIssuer));
console.log('# Append to PAYMENT_ISSUERS_JSON:');
console.log(JSON.stringify(paymentIssuer));
console.log('');
console.log('# ===== CANARY env (operator-held; private JWKs in tmp/canary-keys/, gitignored) =====');
console.log("export MCP_IDENTITY_PRIVATE_JWK=\"$(cat tmp/canary-keys/identity.private.jwk.json)\"");
console.log(`export MCP_IDENTITY_ISS='${IDENTITY_ISS}'`);
console.log(`export MCP_IDENTITY_AUD='${IDENTITY_AUD}'`);
console.log(`export MCP_IDENTITY_SUB='${IDENTITY_SUB}'`);
console.log("export MCP_PAYMENT_PRIVATE_JWK=\"$(cat tmp/canary-keys/payment.private.jwk.json)\"");
console.log(`export MCP_PAYMENT_ISS='${PAYMENT_ISS}'`);
console.log(`export MCP_PAYMENT_AUD='${PAYMENT_AUD}'`);
console.log('');
console.log(`# Gateway payment verifier MERCHANT_ID must equal: ${MERCHANT_ID}`);
console.log(`# Expected gateway-derived user_ref: ${userRef}`);
console.log('# Private keys: tmp/canary-keys/{identity,payment}.private.jwk.json  (gitignored — keep secret, never paste)');
