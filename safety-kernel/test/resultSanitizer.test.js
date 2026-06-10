// resultSanitizer tests — the single chokepoint every protocol adapter (MCP, ACP REST) runs before echoing a
// kernel/connector result to an agent. Covers: (1) secret/PAN redaction still holds, (2) internal ranking/debug
// noise is dropped at any depth, (3) bare score/confidence are dropped only on a product node (nested
// review.score survives), (4) the "why" prose survives, (5) the strip can be turned off via opts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeResult } from '../src/protocol/resultSanitizer.js';

test('drops internal ranking/debug keys at any depth; keeps catalog + why prose', () => {
  const out = sanitizeResult({
    products: [
      {
        product_id: 'p1', title: 'Vitamin C Serum', price: 29, currency: 'USD',
        ranking_features: { source: 'rerank_llm' }, ranking_score: 0.9, ranking_features_summary: 'overlap',
        candidate_source: 'vector_recall', score_breakdown: { fit: 0.5 }, x_score: 0.4,
        score: 0.88, confidence: 0.7,
        recommendation_reason: 'good for oily skin', match_reason: 'matches need', why_this_one: 'best value',
        review: { author: 'Jane', score: 4.5 },
      },
    ],
    metadata: { candidate_source: 'multi_provider', debug: { trace: 'x' }, total: 1 },
  });
  const p = out.products[0];
  for (const k of ['ranking_features', 'ranking_score', 'ranking_features_summary', 'candidate_source',
    'score_breakdown', 'x_score', 'score', 'confidence']) {
    assert.ok(!(k in p), `${k} must be stripped`);
  }
  // catalog + why survive
  assert.equal(p.title, 'Vitamin C Serum');
  assert.equal(p.price, 29);
  assert.equal(p.recommendation_reason, 'good for oily skin');
  assert.equal(p.match_reason, 'matches need');
  assert.equal(p.why_this_one, 'best value');
  // product-node-scoped: nested non-product review.score is preserved
  assert.equal(p.review.score, 4.5);
  assert.equal(p.review.author, 'Jane');
  // metadata-level internal keys also dropped
  assert.ok(!('candidate_source' in out.metadata));
  assert.ok(!('debug' in out.metadata));
  assert.equal(out.metadata.total, 1);
});

test('score/confidence are NOT stripped off a non-product object', () => {
  const out = sanitizeResult({ rating_summary: { score: 4.2, confidence: 0.9, count: 100 } });
  assert.equal(out.rating_summary.score, 4.2);
  assert.equal(out.rating_summary.confidence, 0.9);
});

test('no regression: secrets and PANs are still redacted alongside the ranking strip', () => {
  const out = sanitizeResult({
    product_id: 'p1', title: 'X', score: 0.5,
    access_token: 'at_secret', card_number: '4111 1111 1111 1111',
    note: 'pan 4242 4242 4242 4242 here',
  });
  assert.ok(!('score' in out));
  assert.equal(out.access_token, '[REDACTED]');
  assert.equal(out.card_number, '[REDACTED]');
  assert.equal(out.note, 'pan [REDACTED_PAN] here');
  assert.equal(out.title, 'X');
});

test('stripRankingInternals: false leaves ranking fields intact (still scrubs secrets)', () => {
  const out = sanitizeResult(
    { product_id: 'p1', title: 'X', ranking_score: 0.9, score: 0.5, access_token: 'at_secret' },
    { stripRankingInternals: false },
  );
  assert.equal(out.ranking_score, 0.9);
  assert.equal(out.score, 0.5);
  assert.equal(out.access_token, '[REDACTED]');
});
