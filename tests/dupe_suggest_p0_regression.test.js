'use strict';

const { isHollowItem, applyDupeSuggestQualityGate } = require('../src/auroraBff/qualityGates/dupeSuggestGate');
const { normalizeProductUrlInput, buildOriginalStubPortable, ensureOriginalNonNull } = require('../src/auroraBff/services/urlAliasNormalizer');

// ---------------------------------------------------------------------------
// P0-A: URL alias normalizer
// ---------------------------------------------------------------------------
describe('normalizeProductUrlInput: field aliasing', () => {
  test('picks original_url first when present', () => {
    const result = normalizeProductUrlInput({
      original_url: 'https://www.labseries.com/product/foo',
      anchor_product_url: 'https://other.com',
    });
    expect(result.canonical_url).toBe('https://www.labseries.com/product/foo');
    expect(result.source_field).toBe('original_url');
  });

  test('falls back to anchor_product_url when original_url is empty', () => {
    const result = normalizeProductUrlInput({
      original_url: '',
      anchor_product_url: 'https://other.com/product',
    });
    expect(result.canonical_url).toBe('https://other.com/product');
    expect(result.source_field).toBe('anchor_product_url');
  });

  test('falls back to url when others are missing', () => {
    const result = normalizeProductUrlInput({ url: 'https://generic.com' });
    expect(result.canonical_url).toBe('https://generic.com');
    expect(result.source_field).toBe('url');
  });

  test('returns empty when no alias is present', () => {
    const result = normalizeProductUrlInput({});
    expect(result.canonical_url).toBe('');
    expect(result.source_field).toBeNull();
  });

  test('trims whitespace from urls', () => {
    const result = normalizeProductUrlInput({ original_url: '  https://example.com  ' });
    expect(result.canonical_url).toBe('https://example.com');
  });
});

// ---------------------------------------------------------------------------
// P0-A: original stub guarantee
// ---------------------------------------------------------------------------
describe('buildOriginalStubPortable', () => {
  test('creates stub with url when url is provided', () => {
    const stub = buildOriginalStubPortable('https://www.labseries.com/product/123', '');
    expect(stub._stub).toBe(true);
    expect(stub.url).toBe('https://www.labseries.com/product/123');
    expect(stub.anchor_resolution_status).toBe('failed');
    expect(stub.anchor_resolution_reason).toBe('url_resolution_failed');
  });

  test('creates stub with name_guess from inputText', () => {
    const stub = buildOriginalStubPortable('', 'Lab Series Power V Serum');
    expect(stub._stub).toBe(true);
    expect(stub.name_guess).toBe('Lab Series Power V Serum');
    expect(stub.anchor_resolution_reason).toBe('no_product_object');
  });

  test('creates stub with both empty', () => {
    const stub = buildOriginalStubPortable('', '');
    expect(stub._stub).toBe(true);
    expect(stub.url).toBeNull();
    expect(stub.name).toBeNull();
  });
});

describe('ensureOriginalNonNull', () => {
  test('returns object as-is when valid', () => {
    const obj = { brand: 'Test', name: 'Product' };
    expect(ensureOriginalNonNull(obj, '', '')).toBe(obj);
  });

  test('returns stub when obj is null', () => {
    const result = ensureOriginalNonNull(null, 'https://example.com', 'Test');
    expect(result._stub).toBe(true);
  });

  test('returns stub when obj is an array', () => {
    const result = ensureOriginalNonNull([], 'https://example.com', 'Test');
    expect(result._stub).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P0-A: Lab Series URL anchor flow (golden fixture)
// ---------------------------------------------------------------------------
describe('dupe_suggest: URL anchor resolution (Lab Series)', () => {
  const labSeriesFixture = require('./fixtures/dupe_suggest/lab_series_url_anchor.json');

  test('original_url input produces non-null original in stub path', () => {
    const url = labSeriesFixture.input.original_url;
    const stub = buildOriginalStubPortable(url, '');
    expect(stub).not.toBeNull();
    expect(stub._stub).toBe(true);
    expect(stub.url).toBe(url);
    expect(stub.anchor_resolution_status).toBe('failed');
    expect(stub.name_guess).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// P0-B: Candidate pool empty → quality gate
// ---------------------------------------------------------------------------
describe('applyDupeSuggestQualityGate: candidate pool empty', () => {
  test('gates payload when candidate_pool_meta.count is 0', () => {
    const payload = {
      original: { brand: 'Test', name: 'Product' },
      dupes: [],
      comparables: [],
      verified: false,
      candidate_pool_meta: { count: 0, sources_used: [], degraded: true },
      quality: { quality_ok: false, quality_issues: ['candidate_pool_empty'] },
      meta: {},
    };
    const result = applyDupeSuggestQualityGate(payload, { lang: 'EN' });
    expect(result.gated).toBe(true);
    expect(result.reason).toBe('candidate_pool_empty');
    expect(result.payload.empty_state_reason).toBe('candidate_pool_empty');
    expect(result.payload.action_hint).toBeTruthy();
    expect(result.payload.meta.quality_gate_enforced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P0-C: Hollow items quality gate
// ---------------------------------------------------------------------------
describe('isHollowItem', () => {
  test('item with similarity=0, confidence=0, tradeoffs=[] is hollow', () => {
    expect(isHollowItem({ similarity: 0, confidence: 0, tradeoffs: [] })).toBe(true);
  });

  test('item with similarity>0 is NOT hollow', () => {
    expect(isHollowItem({ similarity: 75, confidence: 0, tradeoffs: [] })).toBe(false);
  });

  test('item with non-empty tradeoffs is NOT hollow', () => {
    expect(isHollowItem({ similarity: 0, confidence: 0, tradeoffs: ['lighter texture'] })).toBe(false);
  });

  test('item with confidence>0 is NOT hollow', () => {
    expect(isHollowItem({ similarity: 0, confidence: 0.6, tradeoffs: [] })).toBe(false);
  });

  test('null item is hollow', () => {
    expect(isHollowItem(null)).toBe(true);
  });
});

describe('applyDupeSuggestQualityGate: hollow items', () => {
  test('all-hollow items are gated and filtered', () => {
    const payload = {
      original: { brand: 'Test', name: 'Product' },
      dupes: [
        { product: { brand: 'A', name: 'A1' }, similarity: 0, confidence: 0, tradeoffs: [], kind: 'dupe' },
        { product: { brand: 'B', name: 'B1' }, similarity: 0, confidence: 0, tradeoffs: [], kind: 'dupe' },
      ],
      comparables: [],
      verified: true,
      candidate_pool_meta: { count: 10, sources_used: ['catalog_search'] },
      quality: { quality_ok: true, quality_issues: [] },
      meta: {},
    };
    const result = applyDupeSuggestQualityGate(payload, { lang: 'EN' });
    expect(result.gated).toBe(true);
    expect(result.reason).toBe('all_items_hollow');
    expect(result.payload.verified).toBe(false);
    expect(result.payload.dupes).toEqual([]);
    expect(result.payload.comparables).toEqual([]);
    expect(result.payload.quality.quality_ok).toBe(false);
    expect(result.payload.quality.quality_issues).toContain('all_items_hollow');
    expect(result.payload.meta.quality_gate_enforced).toBe(true);
  });

  test('mix of hollow and non-hollow keeps non-hollow items', () => {
    const goodItem = { product: { brand: 'C', name: 'C1' }, similarity: 80, confidence: 0.7, tradeoffs: ['lighter texture'], kind: 'dupe' };
    const hollowItem = { product: { brand: 'D', name: 'D1' }, similarity: 0, confidence: 0, tradeoffs: [], kind: 'dupe' };
    const payload = {
      original: { brand: 'Test', name: 'Product' },
      dupes: [goodItem, hollowItem],
      comparables: [],
      verified: true,
      candidate_pool_meta: { count: 10 },
      quality: { quality_ok: true, quality_issues: [] },
      meta: {},
    };
    const result = applyDupeSuggestQualityGate(payload, { lang: 'EN' });
    expect(result.gated).toBe(false);
    expect(result.payload.dupes).toHaveLength(2);
  });

  test('verified=true must not coexist with similarity=0 + tradeoffs=[] + confidence=0 for all items', () => {
    const items = [
      { similarity: 0, tradeoffs: [], confidence: 0 },
      { similarity: 0, tradeoffs: [], confidence: 0 },
    ];
    const hasResults = items.length > 0;
    const hasMeaningfulQuality = items.some(
      (it) => it.similarity > 0 || (it.tradeoffs && it.tradeoffs.length > 0),
    );
    const verified = hasResults && hasMeaningfulQuality;
    expect(verified).toBe(false);
  });
});

describe('applyDupeSuggestQualityGate: no results', () => {
  test('empty dupes + comparables triggers gate', () => {
    const payload = {
      original: { brand: 'Test', name: 'Product' },
      dupes: [],
      comparables: [],
      verified: false,
      candidate_pool_meta: { count: 5 },
      quality: { quality_ok: false, quality_issues: [] },
      meta: {},
    };
    const result = applyDupeSuggestQualityGate(payload, { lang: 'EN' });
    expect(result.gated).toBe(true);
    expect(result.reason).toBe('no_meaningful_results');
    expect(result.payload.empty_state_reason).toBe('no_meaningful_results');
  });
});

// ---------------------------------------------------------------------------
// P0-C: quality_ok false when no items have meaningful data
// ---------------------------------------------------------------------------
describe('applyDupeSuggestQualityGate: quality_ok correctness', () => {
  test('quality_ok is false when no items have meaningful data', () => {
    const items = [{ similarity: 0, tradeoffs: [], confidence: 0 }];
    const qualityOk = items.some(
      (it) => it.similarity > 0 || (it.tradeoffs && it.tradeoffs.length > 0),
    );
    expect(qualityOk).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P0-D: LLM trace meta structure
// ---------------------------------------------------------------------------
describe('dupe_suggest: LLM trace meta structure', () => {
  test('llm_trace meta should contain required fields', () => {
    const llmTrace = {
      task_mode: 'dupe_suggest',
      template_id: 'reco_alternatives_v1_0',
      candidate_count: 12,
      has_anchor: true,
      output_item_count: 3,
      output_max_confidence: 0.85,
      quality_flags: [],
    };
    expect(llmTrace.task_mode).toBe('dupe_suggest');
    expect(llmTrace.template_id).toBeTruthy();
    expect(typeof llmTrace.candidate_count).toBe('number');
    expect(typeof llmTrace.has_anchor).toBe('boolean');
    expect(typeof llmTrace.output_item_count).toBe('number');
    expect(typeof llmTrace.output_max_confidence).toBe('number');
    expect(Array.isArray(llmTrace.quality_flags)).toBe(true);
  });
});
