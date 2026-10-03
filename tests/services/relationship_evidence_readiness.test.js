const { productReadiness, summarizeRelationshipEvidenceReadiness: summarize, buildRelationshipEvidenceAcquisitionPlan: plan } = require('../../src/services/relationshipEvidenceReadiness');
const { parseArgs, run } = require('../../scripts/plan-relationship-evidence-acquisition');
const NOW = Date.parse('2026-10-03T00:00:00Z');
const AT = '2026-10-02T00:00:00Z';
const INCI = 'Water, Glycerin, Squalane, Ceramide NP, Panthenol, Phenoxyethanol';
function product(id, extra = {}) {
  const url = `https://example.com/products/${id}`;
  return { product_key: `cp_${id}`, product_ref: `product:sig_${id}`, pivota_signature_id: `sig_${id}`, market: 'US',
    name: 'Same display title', url, price: 20, price_currency: 'USD', price_observed_at: AT,
    source_refs: [{ type: 'catalog_products', name: `cp_${id}`, authoritative: true, url }],
    ingredient_text: INCI, ingredient_evidence: [{ product_key: `cp_${id}`, ingredient_text: INCI, observed_at: AT }],
    product_intel: { canonical_product_ref: { product_key: `cp_${id}`, market: 'US' }, quality_state: 'reviewed',
      freshness: { generated_at: AT }, product_intel_core: { what_it_is: 'Serum' } }, ...extra };
}
const opts = (products, pairs = []) => ({ products, pairs, nowMs: NOW });
test('current attributed evidence remains supporting data, never approval eligibility', () => {
  const a = product('a'); const b = product('b');
  const result = summarize(opts([a, b], [{ anchor: a, candidate: b }]));
  expect(result.approval_eligibility_assessed).toBe(false);
  expect(result.pairs).toMatchObject({ both_substantial_current_owned_ingredients: 1, alternative_supporting_evidence_pairs: 1, dupe_evidence_gap_pairs: 0 });
  expect(plan(opts([a, b])).tasks).toEqual([]);
});
test.each([
  ['ingredient_evidence_conflict', true, 'conflict'], ['ingredient_evidence_incomplete', true, 'incomplete'],
  ['ingredient_text', 'Water, Glycerin', 'partial'], ['ingredient_evidence', [], 'unbound'],
])('ingredient gap %s survives', (field, value, expected) => {
  expect(productReadiness(product('a', { [field]: value }), { nowMs: NOW }).ingredients).toBe(expected);
});
test.each([{ product_key: 'cp_other' }, { product_key: 'cp_a', market: 'JP' }, { product_key: 'cp_a', ingest_allowed: false },
  { product_key: 'cp_a', review_status: 'rejected' }])('borrowed/denied ingredients do not count: %j', (binding) => {
  const a = product('a', { ingredient_evidence: [{ ...binding, ingredient_text: INCI, observed_at: AT }] });
  expect(productReadiness(a, { nowMs: NOW }).ingredients).toBe('unbound');
});
test.each(['2026-12-01', '2020-01-01', null])('unknown/stale/future ingredient dates fail currentness: %s', (observed_at) => {
  const a = product('a'); a.ingredient_evidence[0].observed_at = observed_at;
  expect(productReadiness(a, { nowMs: NOW }).ingredients).toBe('stale');
});
test('rejected Insights overrides approved quality, source updated timestamp cannot refresh old generated content', () => {
  const a = product('a'); a.product_intel.provenance = { review_decision: 'reject_external' };
  expect(productReadiness(a, { nowMs: NOW }).insights).toBe('rejected');
  delete a.product_intel.provenance; a.product_intel.freshness.generated_at = '2020-01-01'; a.observed_at = AT;
  expect(productReadiness(a, { nowMs: NOW }).insights).toBe('stale');
});
test('source url must be current exact listing, authoritative, credential free', () => {
  for (const extra of [{ source_refs: [] }, { url: 'https://example.com/other' },
    { url: 'https://u:p@example.com/products/a' }, { url: 'https://example.com/products/a?api_key=SECRET' }]) {
    const manifest = plan(opts([product('a', { ...extra, ingredient_text: '' })]));
    expect(manifest.tasks.every((task) => !task.execution_ready && task.source_binding.url === null)).toBe(true);
  }
});
test('display titles and bare refs cannot bind acquisition tasks; exact differing listing identities remain separate', () => {
  expect(plan(opts([{ product_ref: 'product:123', name: 'Same display title' }])).tasks).toEqual([]);
  const result = plan(opts([product('a', { ingredient_text: '' }), product('b', { ingredient_text: '' })]));
  expect(result.tasks).toHaveLength(2);
  expect(result.summary.unique_exact_listings).toBe(2);
});
test('alias disagreement needs reconciliation even if both aliases claim current good data', () => {
  const a = product('a'); const other = product('a', { ingredient_text: 'Water, Glycerin, Salicylic Acid, Sodium Chloride, Propanediol' });
  other.ingredient_evidence[0].ingredient_text = other.ingredient_text;
  other.product_intel.product_intel_core.what_it_is = 'Other serum';
  const result = plan(opts([a, other]));
  expect(result.tasks.filter((task) => task.action === 'reconcile_exact_listing_evidence')).toHaveLength(2);
  expect(result.tasks.every((task) => task.execution_ready === false)).toBe(true);
});
test('same merchant product ids with differing stores/platforms/market/variant never dedupe', () => {
  const result = summarize(opts(['a', 'b'].map((merchant_id) => ({ product_id: '123', merchant_id, platform: 'shopify', market: 'US' }))));
  expect(result.unique_exact_listings).toBe(2);
});
test('offer currency and market differences cannot support a pair', () => {
  const a = product('a'); const b = product('b', { price_currency: 'JPY', market: 'JP' });
  expect(summarize(opts([a, b], [{ anchor: a, candidate: b }])).pairs.both_current_owned_same_currency_offers).toBe(0);
});
test('plan prioritizes opportunity, is deterministic, bounded and deduplicates pairs', () => {
  const a = product('a', { ingredient_text: '' }); const b = product('b', { ingredient_text: '' }); const c = product('c', { ingredient_text: '' });
  const pairs = [{ anchor: b, candidate: c, score: .9 }, { anchor: b, candidate: c, score: .9 }];
  const result = plan({ ...opts([a, b, c], pairs), maxTasks: 1 });
  expect(result.tasks[0].opportunity_score).toBe(.9);
  expect(result.total_gap_tasks).toBe(3);
  expect(result.omitted_gap_tasks).toBe(2);
  expect(plan({ ...opts([c, a, b], pairs), maxTasks: 1 })).toEqual(result);
});
test('verified borrowed/stale/missing-clock curated pairs do not count as current proof', () => {
  const a = product('a'); const b = product('b', { curated_pair_evidence: { verified: true, relation_type: 'dupe', anchor_ref: a.product_ref, candidate_ref: 'product:other', verified_at: AT } });
  const pairs = [{ anchor: a, candidate: b, relation_type: 'dupe' }];
  expect(summarize(opts([], pairs)).pairs.curated_dupe_verification_gap).toBe(1);
  expect(plan(opts([], [...pairs, ...pairs])).tasks).toHaveLength(1);
  b.curated_pair_evidence.candidate_ref = b.product_ref;
  b.curated_pair_evidence.anchor_product_key = a.product_key;
  b.curated_pair_evidence.candidate_product_key = b.product_key;
  b.curated_pair_evidence.market = 'US';
  expect(summarize(opts([], pairs)).pairs.curated_dupe_verification_current).toBe(1);
});
test('oversized inputs and invalid clocks/bounds fail closed', () => {
  expect(() => summarize(opts(Array(501).fill(product('a'))))).toThrow('evidence_input_exceeds_bound');
  expect(() => summarize({ products: [], nowMs: NaN })).toThrow();
  expect(() => plan({ maxTasks: 0 })).toThrow();
});
test('offline operator defaults to aggregate only and does not leak input facts', () => {
  const writeManifest = jest.fn(); const summary = run({ options: { inputFile: 'private', nowMs: NOW }, readInput: () => opts([product('SECRET')]), writeManifest });
  expect(writeManifest).not.toHaveBeenCalled(); expect(JSON.stringify(summary)).not.toContain('SECRET');
});
test('explicit manifest output invokes private writer only after validation, argument errors reject', () => {
  const writeManifest = jest.fn();
  run({ options: { inputFile: 'private', manifestOut: 'plan', nowMs: NOW, maxTasks: 1 }, readInput: () => opts([product('a', { ingredient_text: '' })]), writeManifest });
  expect(writeManifest).toHaveBeenCalledTimes(1);
  expect(parseArgs(['--input', 'private', '--max-tasks', '3', '--now', AT]).maxTasks).toBe(3);
  expect(() => parseArgs(['--input', 'private', '--input', 'again'])).toThrow();
});
test('truncated ingredient text remains incomplete even if exact row is present', () => {
  expect(productReadiness(product('a', { ingredient_text_truncated: true }), { nowMs: NOW }).ingredients).toBe('incomplete');
});
test('two differently bound identities under one catalog key require deterministic reconciliation', () => {
  const a = product('a'); const b = product('a', { pivota_signature_id: 'sig_other', source_product_id: 'other_id' });
  const first = plan(opts([a, b])); const reversed = plan(opts([b, a]));
  expect(first).toEqual(reversed);
  expect(first.tasks).toHaveLength(3);
  expect(first.tasks.every((task) => !task.execution_ready && task.action === 'reconcile_exact_listing_evidence')).toBe(true);
});
test('same URL with wrong source owner or title instead of immutable catalog key is unresolved', () => {
  const a = product('a'); a.source_refs[0].name = a.name;
  expect(plan(opts([a])).tasks.every((task) => !task.execution_ready)).toBe(true);
  a.source_refs[0].name = a.product_key;
  a.source_refs[0].product_key = 'cp_other';
  expect(productReadiness(a, { nowMs: NOW }).acquisition_source_bound).toBe(false);
});
test('duplicate curated pair work retains maximum opportunity regardless input order', () => {
  const a = product('a'); const b = product('b');
  const pairs = [.1, .9].map((score) => ({ anchor: a, candidate: b, relation_type: 'dupe', score }));
  expect(plan(opts([], pairs))).toEqual(plan(opts([], [...pairs].reverse())));
  expect(plan(opts([], pairs)).tasks[0].opportunity_score).toBe(.9);
});
test.each(['JP', ''])('curated proof requires current known same market on both listings: %s', (market) => {
  const a = product('a'); const b = product('b', { market });
  b.curated_pair_evidence = { verified: true, relation_type: 'dupe', anchor_ref: a.product_ref, candidate_ref: b.product_ref,
    anchor_listing: { product_key: a.product_key, market: 'US' }, candidate_listing: { product_key: b.product_key, market },
    market: 'US', verified_at: AT };
  expect(summarize(opts([], [{ anchor: a, candidate: b }])).pairs.curated_dupe_verification_current).toBe(0);
});
test('private operator creates0600 manifest and refuses overwriting existing file', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-evidence-plan-'));
  try {
    const inputFile = path.join(dir, 'input.json'); const manifestOut = path.join(dir, 'plan.json');
    fs.writeFileSync(inputFile, JSON.stringify({ products: [product('a', { ingredient_text: '' })] }));
    const options = { inputFile, manifestOut, nowMs: NOW, maxTasks: 1 };
    run({ options });
    expect(fs.statSync(manifestOut).mode & 0o777).toBe(0o600);
    const original = fs.readFileSync(manifestOut, 'utf8');
    expect(() => run({ options })).toThrow();
    expect(fs.readFileSync(manifestOut, 'utf8')).toBe(original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('explicit contradictory binding overrides otherwise owned canonical Insights', () => {
  const a=product('a');
  a.product_intel_binding={schema:'relgraph.product_intel_binding.v1',source_record_ref:'fixture_record',
    identity:{product_key:'cp_other'},matched_identity_keys:['product_key:cp_other']};
  expect(productReadiness(a,{nowMs:NOW}).insights).toBe('unbound');
});
test.each([{pivotaSignatureId:'sig_a'},{product_id:'product:sig_a'},{product_ref:'product:sig_a'}])(
  'readiness understands encoded exact signatures but does not bind bare display refs: %j', (canonical) => {
    const a=product('a'); a.product_intel.canonical_product_ref=canonical;
    expect(productReadiness(a,{nowMs:NOW}).insights).toBe('approved_current_owned');
    a.product_intel.canonical_product_ref={product_ref:'product:123'};
    expect(productReadiness(a,{nowMs:NOW}).insights).toBe('unbound');
  });
test('contradictory single-record aliases produce reconciliation rather than disappearing from the plan', () => {
  const a=product('a',{pivotaSignatureId:'sig_other'});
  const result=plan(opts([a]));
  expect(result.tasks).toHaveLength(3);
  expect(result.tasks.every(task=>task.action==='reconcile_exact_listing_evidence'&&!task.execution_ready)).toBe(true);
});
test('strong binding identity with a forged unrelated match key cannot count as owned Insights', () => {
  const a=product('a'); a.product_intel.canonical_product_ref={};
  a.product_intel_binding={schema:'relgraph.product_intel_binding.v1',source_record_ref:'fixture_record',
    identity:{product_key:'cp_a'},matched_identity_keys:['product_key:cp_other']};
  expect(productReadiness(a,{nowMs:NOW}).insights).toBe('unbound');
});
