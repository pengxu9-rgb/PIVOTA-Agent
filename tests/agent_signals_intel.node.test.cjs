'use strict';

// Unit tests for the product-intelligence agent projection (get_intel / intelToSignal).
// Pure adapter + injected handler — no DB, no network. Run: node --test tests/agent_signals_intel.node.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { intelToSignal } = require('../src/agentSignals/intelToSignal');
const { makeGetIntel } = require('../src/agentSignals/intelligenceReads');

function sampleEntry(over = {}) {
  return {
    kb_key: 'product:p1',
    source: 'aurora_product_intel_kb',
    last_success_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-02T00:00:00Z',
    analysis: {
      product_intel_v1: {
        contract_version: 'pivota.product_intel.v1',
        product_intel_core: {
          why_it_stands_out: [
            { headline: 'Clinically backed', body: 'Two peer-reviewed studies on the active.' },
            { headline: '', body: '' },
          ],
          best_for: [
            { label: 'Dry skin', tag: 'dry_skin' },
            { tag: 'sensitive' },
            { label: '' },
          ],
          evidence_profile: 'seller_plus_formula',
        },
        provenance: { review_decision: 'pass', review_tier: 'assistant_reviewed' },
      },
    },
    ...over,
  };
}

test('intelToSignal: maps a reviewed KB entry to a decision Signal', () => {
  const s = intelToSignal(sampleEntry(), { productId: 'p1' });
  assert.equal(s.signal_type, 'decision');
  assert.deepEqual(s.subject, { kind: 'product', id: 'p1' });
  assert.equal(s.value.evidence_profile, 'seller_plus_formula');
  // empty why row filtered out; valid one kept
  assert.equal(s.value.why_it_stands_out.length, 1);
  assert.equal(s.value.why_it_stands_out[0].headline, 'Clinically backed');
  // best_for: label or tag-as-label kept; empty dropped
  assert.deepEqual(s.value.best_for.map((b) => b.label), ['Dry skin', 'sensitive']);
  assert.equal(s.evidence.method, 'published_intel');
  assert.deepEqual(s.evidence.sources, [{ type: 'product_intel_kb', ref: 'product:p1' }]);
  assert.equal(s.review_state, 'pass');
  assert.equal(s.visibility, 'buyer_safe');
});

test('intelToSignal: surfaces public-safe grounded claims (citations + grade) when the filter is injected', () => {
  const entry = sampleEntry();
  entry.analysis.product_intel_v1.product_intel_core.evidence_claims = [
    {
      claim_text: 'Niacinamide supports the skin barrier.',
      substantiation_status: 'substantiated',
      evidence_grade: 'A',
      source_refs: ['https://pubmed.ncbi.nlm.nih.gov/1', 'https://pubmed.ncbi.nlm.nih.gov/2'],
    },
    {
      claim_text: 'Soy isoflavones improve firmness.',
      substantiation_status: 'substantiated',
      evidence_grade: 'B',
      source_refs: ['https://pubmed.ncbi.nlm.nih.gov/3'],
    },
    // Unsubstantiated/grade-D rows must be dropped by the real filter, never reaching the agent.
    { claim_text: 'Cures wrinkles overnight.', substantiation_status: 'flagged', evidence_grade: 'D', source_refs: [] },
  ];
  const { filterPublicSafeClaims } = require('../src/services/pivotaInsightsQuality');
  const s = intelToSignal(entry, { productId: 'p1', filterPublicSafeClaims });
  // Two graded+substantiated claims survive; the flagged grade-D one is dropped.
  assert.equal(s.evidence.claims.length, 2);
  assert.equal(s.evidence.claims[0].claim_text, 'Niacinamide supports the skin barrier.');
  assert.equal(s.evidence.claims[0].evidence_grade, 'A');
  // Citation URLs are preserved (the whole point) — capped at 3.
  assert.deepEqual(s.evidence.claims[0].source_refs, [
    'https://pubmed.ncbi.nlm.nih.gov/1',
    'https://pubmed.ncbi.nlm.nih.gov/2',
  ]);
  // Bundle-level grade = strongest claim grade present.
  assert.equal(s.evidence.grade, 'A');
});

test('intelToSignal: no claims key when the filter is not injected (byte-for-byte prior shape)', () => {
  const entry = sampleEntry();
  entry.analysis.product_intel_v1.product_intel_core.evidence_claims = [
    { claim_text: 'x', substantiation_status: 'substantiated', evidence_grade: 'A', source_refs: ['u'] },
  ];
  const s = intelToSignal(entry, { productId: 'p1' });
  assert.equal(s.evidence.grade, null);
  assert.ok(!('claims' in s.evidence));
});

test('intelToSignal: a claims-only bundle is meaningful (not treated as hollow)', () => {
  const entry = sampleEntry();
  entry.analysis.product_intel_v1.product_intel_core = {
    why_it_stands_out: [],
    best_for: [],
    evidence_claims: [
      { claim_text: 'Backed.', substantiation_status: 'substantiated', evidence_grade: 'C', source_refs: ['u'] },
    ],
  };
  const { filterPublicSafeClaims } = require('../src/services/pivotaInsightsQuality');
  const s = intelToSignal(entry, { productId: 'p1', filterPublicSafeClaims });
  assert.ok(s, 'claims alone should yield a signal');
  assert.equal(s.evidence.claims.length, 1);
  assert.equal(s.evidence.grade, 'C');
});

test('intelToSignal: a throwing filter fails closed to no claims (never breaks the signal)', () => {
  const s = intelToSignal(sampleEntry(), {
    productId: 'p1',
    filterPublicSafeClaims: () => {
      throw new Error('boom');
    },
  });
  assert.ok(s);
  assert.equal(s.evidence.grade, null);
  assert.ok(!('claims' in s.evidence));
});

test('intelToSignal: drops a rejected-review bundle (never reaches a buyer)', () => {
  const entry = sampleEntry();
  entry.analysis.product_intel_v1.provenance.review_decision = 'reject_external';
  assert.equal(intelToSignal(entry, { productId: 'p1' }), null);
});

test('intelToSignal: returns null when there is no usable intel (no fabrication)', () => {
  const entry = sampleEntry();
  entry.analysis.product_intel_v1.product_intel_core = { why_it_stands_out: [], best_for: [] };
  assert.equal(intelToSignal(entry, { productId: 'p1' }), null);
  assert.equal(intelToSignal({ analysis: {} }, { productId: 'p1' }), null);
  assert.equal(intelToSignal(null), null);
});

test('intelToSignal: accepts contract-at-root and product_intel nesting', () => {
  const rootEntry = {
    kb_key: 'product:p2',
    analysis: {
      contract_version: 'pivota.product_intel.v1',
      product_intel_core: { why_it_stands_out: [{ headline: 'Hydrating', body: 'HA + ceramides' }], best_for: [] },
      provenance: {},
    },
  };
  const s = intelToSignal(rootEntry, { productId: 'p2' });
  assert.equal(s.value.why_it_stands_out[0].headline, 'Hydrating');
});

test('intelToSignal: require-reviewed gate drops unreviewed/pilot content', async () => {
  // The thin pilot entry the live prod probe surfaced: no review provenance → must be dropped when an
  // isReviewed predicate is supplied.
  const pilot = sampleEntry();
  pilot.analysis.product_intel_v1.provenance = {};
  assert.equal(intelToSignal(pilot, { productId: 'p1', isReviewed: () => false }), null);
  // A reviewed bundle passes the gate.
  assert.ok(intelToSignal(sampleEntry(), { productId: 'p1', isReviewed: () => true }));
  // A throwing predicate fails closed (treated as not-reviewed).
  assert.equal(intelToSignal(sampleEntry(), { productId: 'p1', isReviewed: () => { throw new Error('x'); } }), null);
  // No predicate → unchanged behavior (gate only applies when injected).
  assert.ok(intelToSignal(pilot, { productId: 'p1' }));
});

test('makeGetIntel: passes isReviewed through, reports no_reviewed_signal when gated out', async () => {
  const getIntel = makeGetIntel({
    getProductIntelKbEntry: async () => sampleEntry({ kb_key: 'product:p1' }),
    isEnabled: () => true,
    isReviewed: () => false,
    resolveKbKeys: async () => ['product:p1'],
  });
  const res = await getIntel({ payload: { product_id: 'p1' } });
  assert.deepEqual(res.signals, []);
  assert.equal(res.metadata.reason, 'no_reviewed_signal');
});

test('makeGetIntel: fail-closed when disabled', async () => {
  const getIntel = makeGetIntel({
    getProductIntelKbEntry: async () => {
      throw new Error('should not read when disabled');
    },
    isEnabled: () => false,
  });
  const res = await getIntel({ payload: { product_id: 'p1' } });
  assert.deepEqual(res.signals, []);
  assert.equal(res.metadata.reason, 'disabled');
});

test('makeGetIntel: resolves keys, reads batch, emits a signal', async () => {
  const map = new Map([['product:sig_1', sampleEntry({ kb_key: 'product:sig_1' })]]);
  const getIntel = makeGetIntel({
    getProductIntelKbEntries: async (keys) => {
      assert.ok(keys.includes('product:sig_1'));
      return map;
    },
    getProductIntelKbEntry: async () => null,
    isEnabled: () => true,
    resolveKbKeys: async (p) => [`product:${p.pivota_signature_id}`, `product:${p.product_id}`],
  });
  const res = await getIntel({ payload: { product_id: 'p1', pivota_signature_id: 'sig_1' } });
  assert.equal(res.signals.length, 1);
  assert.equal(res.signals[0].signal_type, 'decision');
  assert.equal(res.metadata.kb_key, 'product:sig_1');
});

test('makeGetIntel: per-key fallback + not_found when nothing matches', async () => {
  const getIntel = makeGetIntel({
    getProductIntelKbEntry: async (k) => (k === 'product:hit' ? sampleEntry({ kb_key: 'product:hit' }) : null),
    isEnabled: () => true,
    resolveKbKeys: async () => ['product:miss', 'product:hit'],
  });
  const hit = await getIntel({ payload: { product_id: 'x' } });
  assert.equal(hit.signals.length, 1);

  const getIntelMiss = makeGetIntel({
    getProductIntelKbEntry: async () => null,
    isEnabled: () => true,
    resolveKbKeys: async () => ['product:none'],
  });
  const miss = await getIntelMiss({ payload: { product_id: 'x' } });
  assert.deepEqual(miss.signals, []);
  assert.equal(miss.metadata.reason, 'not_found');
});
