const { buildPublicProductIntelProjection } = require('../src/pdpProductIntel');
const { filterPublicSafeClaims } = require('../src/services/pivotaInsightsQuality');
const legacy = require('./fixtures/judydoll_product_intel_legacy_review_copy.json');

const clone = (value) => JSON.parse(JSON.stringify(value));
const privateValue = { provenance: { generator: 'PRIVATE_OPERATOR_SENTINEL' }, agent_context: { guardrails: 'PRIVATE_OPERATOR_SENTINEL' } };

test.each([
  ['headline', (b) => { b.product_intel_core.what_it_is.headline = privateValue; }],
  ['tag', (b) => { b.product_intel_core.best_for = [{ tag: privateValue, label: 'Lip color', confidence: 'moderate' }]; }],
  ['watchout', (b) => { b.product_intel_core.watchouts = [{ type: 'shade_fit', label: privateValue, severity: 'low' }]; }],
  ['routine list', (b) => { b.product_intel_core.routine_fit.pairing_notes = ['Apply to lips.', privateValue]; }],
  ['routine enum', (b) => { b.product_intel_core.routine_fit.am_pm = [privateValue]; }],
  ['community', (b) => { b.community_signals = { status: 'available', top_loves: [privateValue], top_complaints: [privateValue], confidence: privateValue }; }],
  ['texture', (b) => { b.texture_finish = { texture: privateValue, finish: privateValue }; }],
  ['freshness', (b) => { b.freshness = { generated_at: privateValue }; }],
  ['product ref', (b) => { b.canonical_product_ref = { merchant_id: 'merchant', product_id: 'product', provenance: privateValue }; }],
])('public projection rejects nested operator objects in allowed %s values', (_, mutate) => {
  const bundle = clone(legacy);
  mutate(bundle);
  const projected = buildPublicProductIntelProjection(bundle);
  expect(projected).not.toBeNull();
  expect(JSON.stringify(projected)).not.toContain('PRIVATE_OPERATOR_SENTINEL');
  expect(JSON.stringify(projected)).not.toContain('agent_context');
});

test('already stamped public claims remain citable without exporting the internal claim dossier', () => {
  const claims = [{ claim_text: 'A matte lip color.', substantiation_status: 'substantiated', evidence_grade: 'B', source_ref: 'https://brand.example/product', concern: 'finish', source_refs: ['https://brand.example/product'] }];
  const bundle = clone(legacy);
  bundle.public_ready = true;
  bundle.product_intel_core.evidence_claims = claims;
  bundle.product_intel_core.public_claims = filterPublicSafeClaims(claims);
  const projected = buildPublicProductIntelProjection(bundle);
  expect(projected.product_intel_core.public_claims).toEqual(filterPublicSafeClaims(claims));
  expect(projected.product_intel_core).not.toHaveProperty('evidence_claims');
  expect(projected.public_ready).toBe(true);
});

test('public claims require the original publication flag and actual substantiation predicates', () => {
  const safe = { claim_text: 'A matte lip color.', substantiation_status: 'substantiated', evidence_grade: 'B' };
  const bundle = clone(legacy);
  bundle.product_intel_core.evidence_claims = [safe];
  bundle.product_intel_core.public_claims = filterPublicSafeClaims([safe]);
  expect(buildPublicProductIntelProjection(bundle).product_intel_core).not.toHaveProperty('public_claims');
  bundle.public_ready = true;
  bundle.product_intel_core.evidence_claims = [
    { ...safe, substantiation_status: 'unverified' },
    { ...safe, evidence_grade: 'D' },
    { ...safe, substantiation_status: undefined },
  ];
  expect(buildPublicProductIntelProjection(bundle).product_intel_core).not.toHaveProperty('public_claims');
});

test('a forged public eligibility flag and client-like projection are not reaccepted as reviewed evidence', () => {
  const forged = clone(legacy);
  delete forged.provenance;
  delete forged.product_intel_core.freshness;
  delete forged.freshness;
  forged.public_display_eligible = true;
  expect(buildPublicProductIntelProjection(forged)).toBeNull();
  const projected = buildPublicProductIntelProjection(legacy);
  expect(buildPublicProductIntelProjection(projected)).toBeNull();
});

test.each(['blocked', ' BLOCKED ', 'Blocked'])('blocked parent quality %s cannot be overridden by a reviewed child', (state) => {
  expect(buildPublicProductIntelProjection({ ...legacy, quality_state: state })).toBeNull();
});

test('shopper descriptions containing reviewed and standards vocabulary are retained', () => {
  const bundle = clone(legacy);
  bundle.product_intel_core.why_it_stands_out = [
    { headline: 'Dermatologist reviewed', body: 'A matte finish with color choices for everyday wear.' },
    { headline: 'Safety standard', body: 'Meets the stated cosmetic safety standard.' },
    { headline: 'Easy shade selection', body: 'Compare shade swatches in daylight.' },
  ];
  const projected = buildPublicProductIntelProjection(bundle);
  expect(projected.product_intel_core.why_it_stands_out).toEqual(bundle.product_intel_core.why_it_stands_out);
});

test.each([
  'Judydoll Lip Ink is a lip color from Judydoll. Available variants clarify Shade: 07 Burgundy.',
  'Judydoll Lip Ink is a lip color from Judydoll. An ingredient list is available for formula review.',
  'A fragrance from Example, with source-backed scent cues including rose and vanilla.',
  'A serum from Example, with source-backed ingredient cues around vitamin C.',
])('legacy fallback what-it-is evaluation criteria are withheld: %s', (body) => {
  const bundle = clone(legacy);
  bundle.product_intel_core.what_it_is.body = body;
  const projected = buildPublicProductIntelProjection(bundle);
  expect(projected.product_intel_core.what_it_is).not.toHaveProperty('body');
  expect(projected.product_intel_core.watchouts).toEqual(bundle.product_intel_core.watchouts);
});
