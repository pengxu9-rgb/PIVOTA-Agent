'use strict';

// THE STEP TAXONOMY IS THE ROUTE, NOT A LOOKUP TABLE.
//
// `recoTargetStep.js` held exactly nine skincare steps, and every consumer treated "no step" as
// "nothing to look for". So for a makeup archetype the grounding pass ran ZERO queries — measured:
// `normalizeRecoTargetStep('bronzer')` returned null, `buildSameFamilyQueryLevels` returns [] on a
// falsy step, and the shortlist was then emptied because nothing grounded. The lane was never
// failing to FIND bronzers. It was never searching for them.
//
// Worse than silence: 'cream blush' matched the moisturizer patterns via the bare token `cream`, so
// a blush was resolved as a moisturizer and grounded against moisturizers.
//
// The widened prompt (reco_main_v1_3) recommends makeup and fragrance. The taxonomy the answer is
// resolved against has to know they exist — this is the main route, not a fallback for when it
// fails. Nothing here adds a "when no step resolves" escape hatch, deliberately: that would be the
// seventh workaround stacked on the same defect.

process.env.AURORA_BFF_USE_MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeRecoTargetStep,
  extractRecoTargetStepFromText,
  getRecoTargetFamilyRelation,
  CANONICAL_STEP_FAMILY_MAP,
} = require('../src/auroraBff/recoTargetStep');
const {
  buildSameFamilyQueryLevels,
  STEP_QUERY_ALIASES,
} = require('../src/auroraBff/recommendationSharedStack');

const MAKEUP_STEPS = [
  'blush', 'bronzer', 'highlighter', 'foundation', 'concealer',
  'face_powder', 'primer', 'lip_colour', 'eye_colour', 'fragrance',
];

test('every canonical step normalises to itself', () => {
  // THE INVARIANT THAT CAUGHT A BUG IN THIS VERY CHANGE. The skincare steps get it for free — each
  // is a single word its own pattern matches — but `lip_colour`, `eye_colour` and `face_powder` do
  // not, and a canonical step that does not round-trip resolves to null, which puts it straight back
  // into the "no step, no queries" hole this change exists to fill.
  const steps = Object.keys(CANONICAL_STEP_FAMILY_MAP);
  assert.ok(steps.length >= 19, `expected skincare + beauty families, got ${steps.length}`);
  for (const step of steps) {
    assert.equal(normalizeRecoTargetStep(step), step,
      `canonical step "${step}" must normalise to itself, or every consumer sees null`);
  }
});

test('a makeup or fragrance need resolves to a step, from the alias and from free text', () => {
  const cases = [
    ['bronzer', 'bronzer'],
    ['a warm-toned bronzer for contouring my cheekbones', 'bronzer'],
    ['bronzing powder', 'bronzer'],
    ['lipstick', 'lip_colour'],
    ['a long-wear liquid lipstick in brick red', 'lip_colour'],
    ['mascara', 'eye_colour'],
    ['eau de toilette', 'fragrance'],
    ['a fresh citrus eau de parfum for daytime', 'fragrance'],
    ['setting powder', 'face_powder'],
    ['口红', 'lip_colour'],
    ['香水', 'fragrance'],
    ['修容', 'bronzer'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(normalizeRecoTargetStep(text), expected, `alias: ${text}`);
    assert.equal(extractRecoTargetStepFromText(text), expected, `free text: ${text}`);
  }
});

test('a cream blush is a blush, not a moisturizer', () => {
  // The observed defect. `cream` and `lotion` are modifiers at least as often as they are products,
  // and matching them as moisturizer both stole the step AND made the answer ambiguous.
  for (const text of ['cream blush', 'cream bronzer', 'cream eyeshadow']) {
    const step = normalizeRecoTargetStep(text);
    assert.notEqual(step, 'moisturizer', `${text} must not resolve as skincare`);
    assert.equal(extractRecoTargetStepFromText(text), step, `${text} must not be left ambiguous`);
  }
  // CONTROL: the skincare senses of the same words are untouched.
  for (const [text, expected] of [['face cream', 'moisturizer'], ['a rich night cream', 'moisturizer'],
                                  ['body lotion', 'moisturizer'], ['cream', 'moisturizer']]) {
    assert.equal(normalizeRecoTargetStep(text), expected, `${text} is still a moisturizer`);
  }
});

test('grounding builds a real query ladder for every beauty step — the decisive property', () => {
  // This is the whole point. Before, each of these returned ZERO levels and the grounding pass made
  // no catalog query at all, so a model that correctly named a bronzer had its answer emptied.
  for (const step of MAKEUP_STEPS) {
    const levels = buildSameFamilyQueryLevels({
      targetContext: { resolved_target_step: step, resolved_target_step_token: '' },
      profileSummary: null, ingredientContext: null, lang: 'EN', seedTerms: [],
    }) || [];
    const queries = levels.flatMap((l) => (l.queries || []).map((q) => q.query));
    assert.ok(levels.length > 0, `${step}: grounding must build at least one ladder level`);
    assert.ok(queries.length > 0, `${step}: grounding must issue at least one query`);
    assert.ok(queries.some((q) => q && q.trim()), `${step}: queries must not be blank`);
  }
});

test('every beauty step has query aliases, so its ladder is wider than the bare token', () => {
  for (const step of MAKEUP_STEPS) {
    const aliases = STEP_QUERY_ALIASES[step];
    assert.ok(Array.isArray(aliases) && aliases.length >= 3,
      `${step} needs aliases, or it recalls only its own name`);
  }
});

test('beauty families are near-substitutes, and never cross into skincare', () => {
  // A bronzer and a blush are adjacent; a bronzer and a serum are not. Without this the family
  // relation would let an off-category row through as "same family".
  assert.equal(getRecoTargetFamilyRelation('bronzer', 'blush'), 'adjacent_family');
  assert.equal(getRecoTargetFamilyRelation('bronzer', 'bronzer'), 'same_family');
  for (const skincare of ['serum', 'moisturizer', 'cleanser', 'sunscreen']) {
    assert.notEqual(getRecoTargetFamilyRelation('bronzer', skincare), 'same_family',
      `a ${skincare} is not the same family as a bronzer`);
    assert.notEqual(getRecoTargetFamilyRelation('bronzer', skincare), 'adjacent_family',
      `a ${skincare} is not an acceptable substitute for a bronzer — that is #2155 verbatim`);
  }
  // Lip, eye and fragrance take no substitutes at all.
  for (const isolated of ['lip_colour', 'eye_colour', 'fragrance']) {
    assert.deepEqual(CANONICAL_STEP_FAMILY_MAP[isolated].adjacent_family, [],
      `${isolated} must not accept a near-substitute`);
  }
});

test('skincare resolution is unchanged', () => {
  // The taxonomy is shared by chat, the consumer lane and the agent door. Widening it must not move
  // a single skincare answer.
  for (const [text, expected] of [
    ['serum', 'serum'], ['a gentle retinol for beginners', 'treatment'],
    ['sunscreen', 'sunscreen'], ['cleanser', 'cleanser'], ['toner', 'toner'],
    ['essence', 'essence'], ['face oil', 'oil'], ['面膜', 'mask'],
  ]) {
    assert.equal(normalizeRecoTargetStep(text), expected, `skincare: ${text}`);
  }
});

// ---------------------------------------------------------------------------------------------
// WIDENING A VOCABULARY MAKES PREVIOUSLY-UNAMBIGUOUS TEXT AMBIGUOUS, and ambiguity here resolves to
// NO STEP AT ALL. Measured over 12,818 strings drawn from this repo, the first version of this
// change cost 61 of them their step — and product titles reach this resolver too (the candidate
// salvage in beautyRecoCoarseClassifier, ingredientSkuEvidence), so a fragrance-free moisturiser
// stopped being a moisturiser to the ranker. Every test below is one of those 61.

test('a phrase that names a category in order to DENY it is not a request for it', () => {
  const cases = [
    ['A 2-step fragrance-free moisturizer routine for sensitive face skin', 'moisturizer'],
    ['24-7 Moisture Fragrance Free Hydrating Day & Night Cream', 'moisturizer'],
    ['Sensitive skin face cream without fragrance.', 'moisturizer'],
    ['Ceramide barrier repair moisturizer fragrance free', 'moisturizer'],
    ['fragrance free exfoliant', 'treatment'],
    ['gentle cleanser rosacea sensitive fragrance free', 'cleanser'],
    ['gentle brightening serum sensitive fragrance free', 'serum'],
    // An ingredient list, not a category.
    ['15% L-AA Vitamin C Serum with Alcohol and Fragrance', 'serum'],
    ['Can my toddler use a fragrance essential oil cream?', 'moisturizer'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(extractRecoTargetStepFromText(text), expected, text);
  }
  // The control: an actual fragrance request still resolves to one.
  assert.equal(extractRecoTargetStepFromText('a fresh citrus eau de toilette'), 'fragrance');
  assert.equal(extractRecoTargetStepFromText('recommend a perfume for evenings'), 'fragrance');
});

test('two patterns matching the SAME WORDS have named one category, not two', () => {
  const cases = [
    // 'foundation' over the whole phrase, 'moisturizer' over its last word.
    ['tinted moisturizer', 'foundation'],
    ['bb cream', 'foundation'],
    ['cc cream', 'foundation'],
    // 'fragrance' over 'body mist', 'toner' over 'mist'.
    ['body mist', 'fragrance'],
    // 'sunscreen' over all four characters, 'foundation' over the first two.
    ['隔离防晒', 'sunscreen'],
    // 'oil' over 'oil serum', 'serum' over its last word.
    ['oil serum', 'oil'],
    ['sun lotion', 'sunscreen'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(extractRecoTargetStepFromText(text), expected, text);
  }
});

test('two nouns listed side by side are still ambiguous, and must not acquire a step', () => {
  // The counterpart of the test above, and the reason overlap is the test rather than "last noun
  // wins". A routine request names several steps and owns none of them.
  for (const text of [
    'a full routine: cleanser, serum and moisturizer',
    'I need a cleanser and a toner',
    'should I get a serum or a moisturizer',
  ]) {
    assert.equal(extractRecoTargetStepFromText(text), null, text);
  }
});

test('SPF is a claim printed on complexion products, and yields only to a MAKEUP category', () => {
  for (const text of [
    'Protec(tint) Daily Skin Tint SPF 50',
    'A hydrating foundation with broad spectrum SPF 50+ protection and a radiant finish.',
    'SPF foundation',
  ]) {
    assert.equal(extractRecoTargetStepFromText(text), 'foundation', text);
  }
  // THE CONTROL, and it is the whole reason this rule is scoped. Demoting `spf` against every step
  // moved 70 SKINCARE strings in this repo's corpus onto a lane this change has no business
  // touching. A moisturiser with SPF is genuinely both and keeps saying so by resolving to nothing.
  for (const text of [
    'Daily Moisturizer SPF 30',
    'Fenty Beauty Hydra Vizor Invisible Moisturizer Broad Spectrum SPF 30 Sunscreen',
    'A lightweight SPF 45 sunscreen serum for daily UV protection.',
  ]) {
    assert.equal(extractRecoTargetStepFromText(text), null, `${text} must stay ambiguous`);
  }
  // And a real sunscreen still resolves: `sunscreen`/`sunblock`/防晒 name the category.
  assert.equal(extractRecoTargetStepFromText('A fragrance-free broad spectrum sunscreen'), 'sunscreen');
});

test('pattern ORDER inside a step does not decide its match', () => {
  // `sunscreen` carries both /防晒/ and /隔离防晒/. Taking the first pattern that matched left it
  // holding the two-character surface, which no longer overlapped `foundation`'s /隔离/, so
  // '隔离防晒' read as two categories and resolved to none.
  const { collectHighConfidenceMatchDetails } = require('../src/auroraBff/recoTargetStep');
  const details = collectHighConfidenceMatchDetails('隔离防晒霜');
  const sunscreen = details.find((d) => d.step === 'sunscreen');
  assert.ok(sunscreen, 'sunscreen must be among the matches');
  assert.equal(sunscreen.token, '隔离防晒', 'the LONGEST of the step’s own patterns wins');
});

test('a makeup category named as WEAR CONTEXT is not a request for it', () => {
  // /v1/chat derives step-aware intent from this resolver, and a buyer describing the makeup they
  // already wear was naming a second category. 16 of 28 realistic phrasings lost their step.
  const cases = [
    ['a sunscreen that won’t pill under my foundation', 'sunscreen'],
    ['sunscreen for under foundation', 'sunscreen'],
    ['moisturizer to wear under foundation', 'moisturizer'],
    ['cleanser that removes mascara and eyeliner', 'cleanser'],
    ['toner to use before primer', 'toner'],
    ['eye cream that won’t crease my concealer', 'moisturizer'],
    ['sunscreen that doubles as a primer', 'sunscreen'],
    ['I use foundation daily, need a sunscreen without white cast', 'sunscreen'],
    ['Compare the cards: I use foundation, want less white cast, and need a sunscreen option.', 'sunscreen'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(extractRecoTargetStepFromText(text), expected, text);
  }
  // THE CONTROL. Masking wear-context must not swallow the request itself.
  for (const [text, expected] of [
    ['recommend a foundation for warm undertones', 'foundation'],
    ['what primer should I buy', 'primer'],
    ['a mascara that does not smudge', 'eye_colour'],
    ['a concealer for dark circles', 'concealer'],
    ['a bronzer for contouring my cheekbones', 'bronzer'],
  ]) {
    assert.equal(extractRecoTargetStepFromText(text), expected, `control: ${text}`);
  }
});

test('normalizeRecoTargetStep reads the same masked text the intent resolver does', () => {
  // A SECOND RESOLVER THAT DID NOT SHARE THE MASK IS A SECOND SET OF ANSWERS. This one takes the
  // first pattern that matches and the makeup entries are listed first, so a `Fragrance-Free` title
  // resolved `fragrance` here while the intent resolver said `moisturizer` — and
  // ingredientSkuEvidence.resolveRecallCandidateStep calls THIS one, on a bare title, first.
  for (const [text, expected] of [
    ['CeraVe Daily Moisturizing Lotion, Fragrance-Free', 'moisturizer'],
    ['Fragrance-Free Barrier Cream', 'moisturizer'],
    ['gentle cleanser sensitive skin fragrance free', 'cleanser'],
  ]) {
    assert.equal(normalizeRecoTargetStep(text), expected, text);
  }
  // The canonical-name lookup runs BEFORE the mask, so an explicit step still normalises to itself.
  assert.equal(normalizeRecoTargetStep('fragrance'), 'fragrance');
  assert.equal(normalizeRecoTargetStep('perfume'), 'fragrance');
  assert.equal(normalizeRecoTargetStep('lip_colour'), 'lip_colour');
});

test('SPF outranks primer, and yields to the complexion-colour categories', () => {
  // Unseen, Dewscreen and Glowscreen are sun care that primes. Letting `primer` win moved them out
  // of the sunscreen pipeline — on a `sunscreen` query the row went same_family → incompatible —
  // and "spf primer" collapsed its result set from 75 to 2.
  for (const text of ['spf primer', 'primer with spf', 'Dewscreen Hydrating Primer SPF 50', 'Supergoop Glowscreen SPF 40']) {
    assert.equal(extractRecoTargetStepFromText(text), 'sunscreen', text);
  }
  // A foundation with SPF is sold on coverage, so there `spf` still yields.
  assert.equal(extractRecoTargetStepFromText('Protec(tint) Daily Skin Tint SPF 50'), 'foundation');
  // And a primer with no SPF claim is still a primer.
  assert.equal(extractRecoTargetStepFromText('a makeup primer for large pores'), 'primer');
});

test('a delivery FORMAT is not a category', () => {
  // Sunscreen, haircare and fragrance all ship as a body mist or a body spray. Read as a category,
  // the format made Supergoop's own sunscreens name two categories and resolve to neither.
  for (const text of [
    'A weightless, non-aerosol sunscreen body spray for face and body',
    'PLAY Antioxidant Body Mist SPF 30 with Vitamin C',
  ]) {
    assert.equal(extractRecoTargetStepFromText(text), 'sunscreen', text);
  }
  // THE CONTROL. When the format is the ONLY thing that matched, it is the category.
  for (const text of ['body mist', 'Allover Body Mist - Green Raspberry']) {
    assert.equal(extractRecoTargetStepFromText(text), 'fragrance', text);
  }
});

test('overlap resolves BEFORE the weak-surface rules, not after', () => {
  // The weak-surface rules reason about which SURFACES survived. Run first, they saw a `mist` that
  // `body mist` was about to absorb and counted it as a third category, so "PLAY Antioxidant Body
  // Mist SPF 30" kept a spurious `toner` and resolved to nothing.
  const { collectHighConfidenceMatchDetails } = require('../src/auroraBff/recoTargetStep');
  const details = collectHighConfidenceMatchDetails('PLAY Antioxidant Body Mist SPF 30 with Vitamin C');
  assert.deepEqual(details.map((d) => d.step), ['sunscreen'],
    'body mist absorbs mist, then the format yields to the SPF claim — one step, not three');
});
