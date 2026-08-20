// The hosted cc.pivota.insights JSON Schema is a CONTRACT WITH ANOTHER REPO, and nothing enforced it.
//
// pivota-marketing serves https://pivota.cc/ucp/schemas/insights.json; this repo serves the tools that
// must satisfy it. A review found the two had already diverged on the response side — the schema declared
// `why_it_stands_out` / `best_for` as string arrays while the handler emits objects, so EVERY non-empty
// get_intel result was schema-invalid (the empty case, which every smoke test produces, validated fine).
//
// So the schema is vendored here as a fixture and driven both ways:
//   requests  — the door's published inputSchema must accept exactly what the hosted schema accepts;
//   responses — realistic handler output must validate against the hosted response definitions.
// A change on either side without the other fails here instead of at a platform integration.
//
// KEEPING THE FIXTURE HONEST: `fixtures/insights.json` is a byte copy of what pivota-marketing publishes.
// When that file changes, copy it again — the drift this test catches is the pair moving apart, and a
// fixture that is silently regenerated from this repo's own beliefs would catch nothing.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { UCP_INPUT_SCHEMAS } from '../src/ucpArgumentAdapter.js';
import { relationshipEdgesToSignals } from '../../src/agentSignals/relationshipEdgeToSignal.js';
import { offersToSignals } from '../../src/agentSignals/offerToSignal.js';
import { intelToSignal } from '../../src/agentSignals/intelToSignal.js';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOSTED = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'insights.json'), 'utf8'));

function validator(defName) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema(HOSTED, 'hosted');
  return ajv.compile({ $ref: `hosted#/$defs/${defName}` });
}

function assertValid(defName, payload) {
  const validate = validator(defName);
  const ok = validate(payload);
  assert.ok(ok, `${defName}: ${JSON.stringify(validate.errors, null, 2)}`);
}

describe('the hosted schema and the door agree on REQUESTS', () => {
  const pairs = [
    ['get_alternatives', 'get_alternatives_request'],
    ['get_offers', 'get_offers_request'],
    ['get_intel', 'get_intel_request'],
  ];

  test('required members, strictness and the nesting rule match leaf for leaf', () => {
    for (const [opId, defName] of pairs) {
      const published = UCP_INPUT_SCHEMAS[opId];
      const hosted = HOSTED.$defs[defName];
      assert.deepEqual(published.required, hosted.required, `${opId}: required`);
      assert.equal(published.additionalProperties, hosted.additionalProperties, `${opId}: additionalProperties`);
      const p = published.properties.insights;
      const h = hosted.properties.insights;
      assert.deepEqual(p.required, h.required, `${opId}: insights.required`);
      assert.equal(p.additionalProperties, h.additionalProperties, `${opId}: insights.additionalProperties`);
      assert.deepEqual(Object.keys(p.properties).sort(), Object.keys(h.properties).sort(), `${opId}: insights members`);
      const resolve = (node) => (node && node.$ref ? HOSTED.$defs[String(node.$ref).split('/').pop()] : node);
      for (const [name, sub] of Object.entries(p.properties)) {
        const hostedSub = resolve(h.properties[name]);
        assert.equal(sub.type, hostedSub.type, `${opId}: insights.${name} type`);
        if (sub.enum) assert.deepEqual(sub.enum, hostedSub.enum, `${opId}: insights.${name} enum`);
        // The published BOUNDS are the ones the mapper clamps to; a schema that promises a different
        // maximum is a lie to every platform that generates a client from it.
        assert.equal(sub.maximum, hostedSub.maximum, `${opId}: insights.${name} maximum`);
        assert.equal(sub.minimum, hostedSub.minimum, `${opId}: insights.${name} minimum`);
      }
    }
  });

  test('a maximal request the door accepts also validates against the hosted schema', () => {
    assertValid('get_alternatives_request', {
      meta: {}, insights: { id: 'sig_a', relation: 'dupe', include_dupes: true, market: 'US', max_price_ratio: 1, limit: 20 },
    });
    assertValid('get_offers_request', { meta: {}, insights: { id: 'sig_a', currency: 'USD', limit: 10 } });
    assertValid('get_intel_request', { meta: {}, insights: { id: 'sig_a' } });
  });
});

describe('the hosted schema accepts REAL handler output', () => {
  test('get_alternatives: a graph edge projects to a schema-valid signal (incl. a STRING price from the DB)', () => {
    const signals = relationshipEdgesToSignals(
      [{
        relation_type: 'competitive_alternative',
        candidate_product_ref: 'sig_b',
        // node-pg returns NUMERIC as a string — the projector must coerce, or the published
        // `number|null` contract breaks on the first real row.
        candidate_snapshot: { title: 'Rival Serum', brand: 'Rival', price: '19.99', currency: 'USD', image_url: 'https://x/y.jpg' },
        price_evidence: { price_ratio: 0.8 },
        tradeoffs: ['smaller bottle'],
        watchouts: ['fragrance'],
        why_candidate: 'same active, lower price',
        evidence_grade: 'B',
        score_total: 0.77,
        source_refs: [{ type: 'crawl', ref: 'https://x' }],
        last_verified_at: '2026-08-01T00:00:00Z',
      }],
      { anchorId: 'sig_a' },
    );
    assert.equal(signals.length, 1);
    assert.equal(signals[0].value.related.price, 19.99, 'price must be a NUMBER on the wire');
    assertValid('alternative_signal', signals[0]);
    assertValid('get_alternatives_response', { subject: { kind: 'product', id: 'sig_a' }, signals, metadata: { edge_count: 1 } });
  });

  test('get_offers: offers project to schema-valid signals', () => {
    const { best_offer, signals } = offersToSignals(
      [{ merchant_id: 'm1', merchant_name: 'Shop', price: 12.5, currency: 'USD', availability: 'in_stock', is_primary: true, url: 'https://s/p' }],
      { productId: 'sig_a' },
    );
    assertValid('get_offers_response', { subject: { kind: 'product', id: 'sig_a' }, best_offer, signals, metadata: { offer_count: 1 } });
  });

  test('get_intel: a REVIEWED bundle — the case that used to be schema-invalid — validates', () => {
    const signal = intelToSignal(
      {
        kb_key: 'product:sig_a',
        analysis: {
          product_intel_v1: {
            product_intel_core: {
              why_it_stands_out: [{ headline: 'High tolerance', body: 'Fragrance-free, dermatologist tested.' }],
              best_for: [{ label: 'sensitive skin', tag: 'skin_type' }],
              evidence_profile: 'clinical + user reports',
            },
            provenance: { review_decision: 'approved' },
          },
        },
      },
      { productId: 'sig_a', isReviewed: () => true, filterPublicSafeClaims: () => [] },
    );
    assert.ok(signal, 'the fixture must produce a signal — otherwise this test proves nothing');
    assert.equal(typeof signal.value.why_it_stands_out[0], 'object');
    assertValid('decision_signal', signal);
    assertValid('get_intel_response', { subject: { kind: 'product', id: 'sig_a' }, signals: [signal], metadata: { kb_key: 'product:sig_a' } });
  });

  test('the empty answers every disabled/not-found path returns are valid too', () => {
    assertValid('get_intel_response', { subject: { kind: 'product', id: 'sig_a' }, signals: [], metadata: { reason: 'not_found' } });
    assertValid('get_alternatives_response', { subject: { kind: 'product', id: 'sig_a' }, signals: [], metadata: { reason: 'disabled' } });
    assertValid('get_offers_response', { subject: { kind: 'product', id: 'sig_a' }, best_offer: null, signals: [], metadata: { reason: 'offers_source_unavailable' } });
  });
});
