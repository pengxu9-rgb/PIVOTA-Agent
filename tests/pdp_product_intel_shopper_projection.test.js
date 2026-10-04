const { buildPublicProductIntelProjection, normalizePublishedProductIntelBundle } = require('../src/pdpProductIntel');
const { sanitizeProductIntelShopperCopy } = require('../src/services/productIntelShopperCopy');
const legacy = require('./fixtures/judydoll_product_intel_legacy_review_copy.json');

test('actual Judydoll legacy copy is suppressed while product facts and watchouts survive', () => {
  const before = JSON.stringify(legacy);
  const publicBundle = buildPublicProductIntelProjection(legacy);
  expect(publicBundle.public_display_eligible).toBe(true);
  expect(publicBundle.product_intel_core.why_it_stands_out).toEqual([]);
  expect(publicBundle.product_intel_core.what_it_is.body).toContain('Silky Matte Lip Ink');
  expect(publicBundle.product_intel_core.watchouts).toEqual(legacy.product_intel_core.watchouts);
  expect(publicBundle.product_intel_core.routine_fit.pairing_notes).toEqual(legacy.product_intel_core.routine_fit.pairing_notes);
  expect(JSON.stringify(publicBundle)).not.toMatch(/strict_human|human_standard|codex_manual_review|field_sources|quality_improvement|source_version|Reviewed lip cues|reducing ambiguity/);
  expect(JSON.stringify(legacy)).toBe(before);
});

test('client eligibility cannot override unreviewed, blocked or rejected input', () => {
  for (const provenance of [{}, { review_status: 'pending' }]) {
    expect(buildPublicProductIntelProjection({ ...legacy, provenance, public_display_eligible: true })).toBeNull();
  }
  expect(buildPublicProductIntelProjection({ ...legacy, quality_state: 'blocked' })).toBeNull();
  expect(buildPublicProductIntelProjection({ ...legacy, product_intel_core: { ...legacy.product_intel_core, quality_state: 'blocked' } })).toBeNull();
  expect(buildPublicProductIntelProjection({ ...legacy, evidence_profile: 'seller_only_fallback' })).toBeNull();
});

test('allowlist removes internal metadata attached to otherwise safe shopper items', () => {
  const publicBundle = buildPublicProductIntelProjection({
    ...legacy,
    agent_context: { facts: {}, guardrails: { secret_standard: 'internal' } },
    product_intel_core: {
      ...legacy.product_intel_core,
      what_it_is: { ...legacy.product_intel_core.what_it_is, internal_standard: 'internal' },
      why_it_stands_out: [{ headline: 'Soft matte finish', body: 'A lightweight matte lip color.', review_notes: 'internal' }],
      routine_fit: { ...legacy.product_intel_core.routine_fit, quality_gate: 'internal' },
    },
  });
  expect(publicBundle.product_intel_core.why_it_stands_out).toEqual([{ headline: 'Soft matte finish', body: 'A lightweight matte lip color.' }]);
  expect(JSON.stringify(publicBundle)).not.toContain('internal');
  expect(publicBundle).not.toHaveProperty('provenance');
  expect(publicBundle).not.toHaveProperty('agent_context');
});

test('serving guard checks complete text and alternate narrative slots without broad keyword suppression', () => {
  const safe = 'A matte finish with clear shade labels. Dermatologist reviewed for sensitive skin.';
  const input = { product_intel_core: { why_it_stands_out: [
    { headline: 'Finish', body: safe },
    { headline: 'Finish', body: `${'Product context. '.repeat(60)}Reviewed lip cues such as shade clarity identify context before the shopper leaves Pivota.` },
  ], routine_fit: { pairing_notes: ['Apply from the center of your lips.', 'Reviewed usage context is present, including: apply outward.'] } }, shopping_card: { subtitle: 'Lip ink', highlight: 'Shade and size are explicit' } };
  const cleaned = sanitizeProductIntelShopperCopy(input);
  expect(cleaned.product_intel_core.why_it_stands_out).toEqual([{ headline: 'Finish', body: safe }]);
  expect(cleaned.product_intel_core.routine_fit.pairing_notes).toEqual(['Apply from the center of your lips.']);
  expect(cleaned.shopping_card).toEqual({ subtitle: 'Lip ink' });
});

test.each(['human_standard', 'strict_human_manual_rewrite', 'gemini_quality_gate', 'internal standards', 'review criteria'])(
  'internal audit marker %s cannot appear in a shopper narrative', (marker) => {
    const result = sanitizeProductIntelShopperCopy({ product_intel_core: {
      watchouts: [{ label: `Product passed ${marker}.` }, { label: 'Shade appearance varies with lip tone.' }],
    } });
    expect(result.product_intel_core.watchouts).toEqual([{ label: 'Shade appearance varies with lip tone.' }]);
  },
);

test('legacy internal metadata remains available to internal normalizer, outside public projection', () => {
  expect(normalizePublishedProductIntelBundle(legacy).provenance).toEqual(legacy.provenance);
});

test('legacy lip-set clarity reviews are suppressed without removing actual components or finish', () => {
  const cleaned = sanitizeProductIntelShopperCopy({ product_intel_core: { why_it_stands_out: [
    { headline: 'Component pairing is clear', body: 'The PDP identifies the paired components as liner and gloss, so a shopper can tell the format before leaving the page.' },
    { headline: 'Finish role is easy to compare', body: 'The stored product facts call out matte finish, which helps shoppers decide whether the set is better for a layered look.' },
    { headline: 'Liner and gloss set', body: 'Includes a lip liner and gloss for a glossy finish.' },
  ] } });
  expect(cleaned.product_intel_core.why_it_stands_out).toEqual([
    { headline: 'Liner and gloss set', body: 'Includes a lip liner and gloss for a glossy finish.' },
  ]);
});
