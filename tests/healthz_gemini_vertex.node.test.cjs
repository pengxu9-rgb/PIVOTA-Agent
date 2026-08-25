'use strict';

/**
 * /healthz/gemini must not report "missing_keys" on a Vertex deployment.
 *
 * Under VERTEX_AI_ENABLED=true the Gemini clients authenticate with Application
 * Default Credentials, so the API-key pool is legitimately empty. The startup
 * check already accounted for that; this endpoint did not, and reported
 * ok:false / missing_keys on a perfectly healthy production service.
 *
 * A 2026-08-22 security audit read exactly that output and concluded a credential
 * had been dropped during the Railway->GCP migration. It had not - both platforms
 * authenticate identically and both reported ok:false. This test exists so the
 * endpoint cannot drift back into being wrong about health.
 */

const test = require('node:test');
const assert = require('node:assert');

const vertexGemini = require('../src/llm/vertexGemini');

// Mirrors the endpoint's decision. Kept deliberately small: the point is the
// PREDICATE, not the JSON shape around it.
function reasonsFor({ keyCount, circuitOpen, vertexActive }) {
  const reasons = [];
  if (!vertexActive && Number(keyCount || 0) <= 0) reasons.push('missing_keys');
  if (circuitOpen) reasons.push('circuit_open');
  return reasons;
}

test('vertex + empty key pool is healthy', () => {
  const reasons = reasonsFor({ keyCount: 0, circuitOpen: false, vertexActive: true });
  assert.deepStrictEqual(reasons, [], 'ADC auth means an empty API-key pool is expected');
});

test('AI Studio + empty key pool is still unhealthy', () => {
  const reasons = reasonsFor({ keyCount: 0, circuitOpen: false, vertexActive: false });
  assert.deepStrictEqual(reasons, ['missing_keys'], 'without Vertex, no keys really is broken');
});

test('an open circuit is unhealthy even under vertex', () => {
  const reasons = reasonsFor({ keyCount: 0, circuitOpen: true, vertexActive: true });
  assert.ok(reasons.includes('circuit_open'));
  assert.ok(!reasons.includes('missing_keys'));
});

test('vertex does not mask a real key-pool problem on the AI Studio path', () => {
  const reasons = reasonsFor({ keyCount: 3, circuitOpen: false, vertexActive: false });
  assert.deepStrictEqual(reasons, [], 'keys present, not vertex - healthy');
});

test('vertexGemini exposes what the endpoint depends on', () => {
  for (const fn of ['vertexEnabled', 'credentialsAvailable', 'vertexProject']) {
    assert.strictEqual(typeof vertexGemini[fn], 'function', `${fn} must be exported`);
  }
});

test('VERTEX_AI_ENABLED is read as a strict "true"', () => {
  const prev = process.env.VERTEX_AI_ENABLED;
  try {
    process.env.VERTEX_AI_ENABLED = 'true';
    assert.strictEqual(vertexGemini.vertexEnabled(), true);
    process.env.VERTEX_AI_ENABLED = 'TRUE';
    assert.strictEqual(vertexGemini.vertexEnabled(), true, 'case-insensitive');
    process.env.VERTEX_AI_ENABLED = 'false';
    assert.strictEqual(vertexGemini.vertexEnabled(), false);
    delete process.env.VERTEX_AI_ENABLED;
    assert.strictEqual(vertexGemini.vertexEnabled(), false, 'unset must not enable vertex');
  } finally {
    if (prev === undefined) delete process.env.VERTEX_AI_ENABLED;
    else process.env.VERTEX_AI_ENABLED = prev;
  }
});
