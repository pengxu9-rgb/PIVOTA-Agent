'use strict';

// THE OFF-VERTICAL GATE WAS A SKINCARE GATE WEARING A BEAUTY BADGE.
//
// One regex answered two different questions: "is this a beauty product at all?" (lingerie, a dog
// collar, a plush toy) and "is this a beauty product in the category we were built for?" (a blush, a
// perfume). Collapsed together, a bronzer on a BRONZER REQUEST was hard-rejected at recall —
// deleted before ranking, before the model ever saw it. Measured on origin/main: bronzer, blush,
// lipstick, foundation and eau de toilette all `hard_reject: true`.
//
// Split, so the relaxable half relaxes and the other half never does. This is item 2 of the makeup
// chain; item 1 (#2178) taught the taxonomy that makeup exists, and this consumes that single source
// rather than growing a seventh copy of the vocabulary.

process.env.AURORA_BFF_USE_MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../src/auroraBff/usecases/recoHybridResolveCandidates');
const classify = (mod.__internal && mod.__internal.classifySkincareCandidate) || mod.classifySkincareCandidate;
const at = (name, requestedStep) => classify({ name }, requestedStep ? { requestedStep } : undefined);

test('the requested beauty category is admitted, and only that category', () => {
  for (const name of ['Hoola Matte Bronzer', 'Bronzing Powder', '修容盘']) {
    const r = at(name, 'bronzer');
    assert.equal(r.hard_reject, false, `${name} must survive a bronzer request`);
    assert.equal(r.penalty, 0, `${name} must not be penalised on the request that named it`);
    assert.equal(r.classification, 'explicit_requested_beauty_category');
  }
  // FRAGRANCE, the positive case. Without this the fragrance half of the gate can be deleted
  // entirely and every test still passes: a perfume falls through to the older soft block list and
  // is rejected, which looks the same from `hard_reject` alone on a request that never admitted it.
  for (const name of ['Chanel No 5 perfume', 'A fresh citrus eau de toilette', '香水']) {
    const r = at(name, 'eau de toilette');
    assert.equal(r.hard_reject, false, `${name} must survive a fragrance request`);
    assert.equal(r.classification, 'explicit_requested_beauty_category', `${name} classification`);
    assert.equal(r.penalty, 0, `${name} must not be penalised on the request that named it`);
  }

  // A DIFFERENT beauty category is still fatal. Asking for a bronzer does not open the door to
  // perfume, which is the substitution #2155 is about.
  assert.equal(at('Chanel No 5 perfume', 'bronzer').hard_reject, true);
  assert.equal(at('Hoola Matte Bronzer', 'eau de toilette').hard_reject, true);
  // And a skincare row on a makeup request is not off-vertical — it is simply the wrong product,
  // which ranking decides, not this gate. But it must NOT be relabelled as the requested category:
  // that would hand a serum the same penalty-0 standing as a bronzer on a bronzer request, which is
  // how a serum out-ranks a bronzer in the first place.
  const serumOnMakeupAsk = at('Niacinamide Serum', 'bronzer');
  assert.equal(serumOnMakeupAsk.hard_reject, false);
  assert.notEqual(serumOnMakeupAsk.classification, 'explicit_requested_beauty_category',
    'a cleanser does not become a bronzer because a bronzer was requested');
  assert.equal(serumOnMakeupAsk.classification, 'explicit_face_skincare');
});

test('NOT A BEAUTY PRODUCT never relaxes — including when it also names the requested category', () => {
  // THE ORIGINAL VERSION OF THIS TEST COULD NOT FAIL. It used Dog Collar / Plush Toy / Lingerie Set
  // / Loofah — no name that ALSO carries a makeup token — so moving the non-beauty check after the
  // requested-category admit passed it. With the check moved, every name below is admitted at
  // penalty 0 on the request it names.
  for (const name of ['Eyeshadow Brush', 'Lipstick Applicator Brush', 'Nail Clipper Tool', 'Blush Brush Set']) {
    for (const step of ['eyeshadow', 'lipstick', 'bronzer', 'blush', undefined]) {
      const r = at(name, step);
      assert.equal(r.hard_reject, true, `${name} on a ${step || 'bare'} request`);
      assert.equal(r.penalty, 1, `${name} must not be admitted at penalty 0`);
    }
  }
  // An ACCESSORY for a category is not that category either, and these are in no fatal list.
  for (const name of ['Beauty Sponge for blush', 'Eyeshadow Palette Case', 'Powder Puff for setting powder']) {
    assert.equal(at(name, 'bronzer').hard_reject, true, `${name} must not answer a bronzer request`);
  }
});

test('NOT A BEAUTY PRODUCT never relaxes, whatever was requested', () => {
  // The half of the old list that was doing real work. No request makes a dog collar admissible.
  for (const step of [undefined, 'bronzer', 'eau de toilette', 'serum']) {
    for (const name of ['Dog Collar', 'Plush Toy', 'Lingerie Set', 'Loofah']) {
      assert.equal(at(name, step).hard_reject, true,
        `${name} must stay fatal with requestedStep=${String(step)}`);
    }
  }
});

test('a makeup row is rejected from a SKINCARE shortlist — but only on a THREADED call', () => {
  // With no requested step the verdict is main's, unchanged: `bronzer` was in neither of main's
  // lists, so a bronzer is `ambiguous` and pays 0.18. Adding it to a block list would buy a
  // stricter answer at the cost of the identity invariant below, and it is not the direction #2155
  // is about. Threaded, the requested domain is known and the answer can be exact.
  assert.equal(at('Hoola Matte Bronzer').hard_reject, false, 'unthreaded: exactly as on main');
  assert.equal(at('Hoola Matte Bronzer', 'serum').hard_reject, true,
    'a bronzer must not answer a serum request');
  assert.equal(at('Hoola Matte Bronzer', 'serum').reason, 'explicit_wrong_beauty_category',
    'the THREADED rejection is the one new reason — it has no unthreaded twin to break');
  assert.equal(at('Positive Light Liquid Luminizer highlighter', 'moisturizer').hard_reject, true);
  // And the fragrance-free row is NOT read as a fragrance by that same rule — the lens is masked.
  assert.equal(at('CeraVe Daily Moisturizing Lotion, Fragrance-Free', 'moisturizer').hard_reject, false);
});

test('the makeup rows main already rejected are still rejected', () => {
  // The gate has to work in both directions, or this trades #2155 for its mirror image.
  for (const name of ['Cream Blush', 'Chanel No 5 perfume', 'Hoola Bronzer and Blush Duo']) {
    assert.equal(at(name).hard_reject, true, `${name} must not enter a shortlist that asked for skincare`);
  }
  // `Cream Blush` in particular: 'cream' is an allow-token, and letting it excuse a blush would
  // admit makeup to every skincare shortlist. It was fatal before this change for that reason.
  // The REASON STRING is main's, deliberately. Renaming it moved 4,358 corpus strings onto reasons
  // no dashboard knows; the split this PR makes is in the code, not in the telemetry.
  assert.equal(at('Cream Blush').reason, 'explicit_non_skincare');
});

test('an unthreaded caller gets exactly the historical behaviour', () => {
  // Every call site that does not pass a step must be byte-identical to before, or this change has a
  // blast radius nobody measured.
  const cases = [
    ['A Gentle Cleanser', false], ['Niacinamide Serum', false], ['Hydrating Moisturizer', false],
    ['Cream Blush', true], ['Chanel No 5 perfume', true], ['Dog Collar', true], ['Loofah', true],
  ];
  for (const [name, rejected] of cases) {
    assert.equal(at(name).hard_reject, rejected, `${name} with no requestedStep`);
  }
});

test('RANKING asks the same question, with the same answer', async () => {
  // BOTH READERS, OR NEITHER. classifyRecommendationCandidate re-asks the domain question at ranking
  // time, and it was calling the classifier with no requested step. Once this PR taught the gate to
  // RECOGNISE `bronzer` as makeup, that unthreaded call started classifying a bronzer as
  // explicit_non_skincare — so a bronzer request produced `terminal_success: false` and selected
  // NOTHING. Widening the gate without threading this reader is strictly worse than not widening it,
  // which is why the two live in one PR.
  const stack = require('../src/auroraBff/recommendationSharedStack');
  const pool = [
    { product_id: 'b1', name: 'Hoola Matte Bronzer', product_type: 'bronzer' },
    { product_id: 's1', name: 'Niacinamide 10% Serum', product_type: 'serum' },
    { product_id: 'b2', name: 'Bronzing Powder', product_type: 'bronzer' },
    { product_id: 'm1', name: 'Hydrating Moisturizer', product_type: 'moisturizer' },
    { product_id: 'b3', name: 'Cream Bronzer Stick', product_type: 'bronzer' },
  ];
  const out = stack.finalizeRecommendationCandidatePools(pool, {
    targetContext: { resolved_target_step: 'bronzer', step_aware_intent: true, framework_roles: [] },
    recoContext: null,
    priceCeiling: null,
  }) || {};
  const selected = (out.selected_recommendations || []).map((r) => r.name);

  assert.equal(out.terminal_success, true, 'a bronzer request must produce a viable pool');
  assert.equal(selected.length, 3, 'the shortlist is sliced to three — they must be the right three');
  for (const name of selected) {
    assert.match(name, /Bronz/i, `${name} is not a bronzer, and a bronzer was asked for`);
  }
  // The control: the same pool on a SKINCARE request selects skincare, not bronzers.
  const skincare = stack.finalizeRecommendationCandidatePools(pool, {
    targetContext: { resolved_target_step: 'serum', step_aware_intent: true, framework_roles: [] },
    recoContext: null,
    priceCeiling: null,
  }) || {};
  for (const r of (skincare.selected_recommendations || [])) {
    assert.doesNotMatch(String(r.name), /Bronz/i, 'a bronzer must not be served to a serum request');
  }
});

// ---------------------------------------------------------------------------------------------
// THE FIRST VERSION OF THIS CHANGE HARD-REJECTED FRAGRANCE-FREE SKINCARE, on every lane, including
// lanes it never intended to touch. It promoted bare `fragrance` into a fatal branch that fires
// BEFORE the allow-excuse, and `fragrance` is the word a sensitive-skin moisturiser prints on its
// own label to say it contains none. Measured against the live catalog: 11 of 193 rows flipped to
// hard_reject, eight of them for advertising the absence of the thing.

test('a fragrance-free skincare row is admitted — on every lane, whatever was requested', () => {
  const rows = [
    'CeraVe Daily Moisturizing Lotion, Fragrance-Free',
    'EltaMD UV Clear Broad-Spectrum SPF 46, fragrance-free',
    'Vanicream Gentle Facial Cleanser — free of fragrance',
    'La Roche-Posay Toleriane Double Repair Face Moisturizer, fragrance free',
    'Ceramide Barrier Serum with no added fragrance',
  ];
  for (const name of rows) {
    for (const step of [undefined, 'moisturizer', 'serum', 'bronzer', 'eau de toilette']) {
      const r = at(name, step);
      assert.equal(r.hard_reject, false,
        `${name} must not be hard-rejected (requestedStep=${step || 'none'}) — got ${r.reason}`);
    }
  }
  // A row that lists fragrance as an ingredient is a skincare row too.
  assert.equal(at("Kiehl's Ultra Facial Cream, contains fragrance").hard_reject, false);
});

// THE INVARIANT THAT BOUNDS THE BLAST RADIUS. NON_BEAUTY_FATAL and WRONG_CATEGORY_FATAL together
// are, token for token, main's single fatal list; the allow-excused list is untouched. So a call
// that passes no step must reach the verdict main reached — not "roughly", exactly. Verified over
// 10,402 ASCII strings from this repo against origin/main at 205e9f1cd: 0 decisions differ.
test('an unthreaded caller gets exactly the historical verdict', () => {
  const cases = [
    // Rejected on main, and still rejected.
    ['Cream Blush', true], ['Hoola Matte Bronzer for cheeks and eyeshadow', true],
    ['Chanel No 5 perfume', true], ['Nail Polish', true], ['Dog Collar', true],
    ['Loofah', true], ['Silk Lingerie Set', true], ['Makeup Brush Set', true],
    // Admitted on main, and still admitted — every one of these contains a token the split touched.
    ['A Gentle Cleanser', false], ['Niacinamide 10% Serum', false],
    ['Hydrating Moisturizer, fragrance-free', false],
    ['Broad Spectrum Sunscreen SPF 50', false],
    ['Barrier Repair Cream for sensitive skin', false],
  ];
  for (const [name, rejected] of cases) {
    assert.equal(at(name).hard_reject, rejected, `${name} with no requestedStep`);
  }
});

// ---------------------------------------------------------------------------------------------
// THE RANKER IS NOT THE BOUNDARY. Threading the step into ranking alone fixed nothing a buyer could
// see: the recall boundary runs FIRST, deletes the row, and the ranker never gets to score it.

test('the recall boundary asks the same question, with the same answer', () => {
  const { classifyConcernScopeCandidate } = require('../src/auroraBff/productScopeClassifier');
  const bronzer = { name: 'Cream Blush Bronzer Duo', title: 'Cream Blush Bronzer Duo' };
  assert.equal(classifyConcernScopeCandidate(bronzer).hard_reject, true,
    'no requested step: off-vertical, exactly as on main');
  assert.equal(classifyConcernScopeCandidate(bronzer, { requestedStep: 'bronzer' }).hard_reject, false,
    'it must survive the RECALL boundary on a bronzer request, not just the ranker');
  assert.equal(
    classifyConcernScopeCandidate({ name: 'Hoola Matte Bronzer' }, { requestedStep: 'serum' }).hard_reject,
    true,
    'and the boundary rejects the wrong category once it knows which one was asked for',
  );
  const serum = { name: 'Niacinamide Serum', title: 'Niacinamide Serum' };
  assert.equal(classifyConcernScopeCandidate(serum, { requestedStep: 'bronzer' }).hard_reject, false);
  assert.notEqual(
    classifyConcernScopeCandidate(serum, { requestedStep: 'bronzer' }).classification,
    'explicit_requested_beauty_category',
    'a serum does not become a bronzer because a bronzer was requested',
  );
  // And the fragrance-free row survives the boundary too — this is where the P0 above would bite.
  assert.equal(
    classifyConcernScopeCandidate({ name: 'CeraVe Moisturizing Lotion Fragrance-Free' }).hard_reject,
    false,
  );
});

test('the beauty mainline boundary passes the step it recalled for', () => {
  const { __internal } = require('../src/auroraBff/routes');
  const fn = __internal.classifyBeautyMainlineBoundaryRejectCandidate;
  assert.equal(typeof fn, 'function', 'the boundary must be reachable to be pinned');
  const bronzer = { name: 'Cream Blush Bronzer Duo', title: 'Cream Blush Bronzer Duo' };
  assert.equal(fn(bronzer).rejected, true, 'unthreaded: unchanged');
  assert.equal(fn(bronzer, { requestedStep: 'bronzer' }).rejected, false,
    'the boundary must admit the category the ladder was searching for');
  assert.equal(fn({ name: 'CeraVe Moisturizing Lotion Fragrance-Free' }, { requestedStep: 'moisturizer' }).rejected,
    false, 'and must not delete a fragrance-free moisturiser from a moisturizer recall');
});

// ---------------------------------------------------------------------------------------------
// WHAT THE PRODUCT IS, NOT WHAT IS IN IT. The category lens read descriptions and ingredient lists,
// so "Ingredients: Aqua, Glycerin, Fragrance (Parfum)" made a moisturiser a fragrance and deleted it
// from a moisturizer request — at the recall boundary, on all three reco lanes.

test('an ingredient list does not decide a category', () => {
  const rows = [
    { title: 'La Roche-Posay Toleriane Double Repair Face Moisturizer', description: 'Fragrance: none. Ingredients: Aqua, Glycerin, Parfum' },
    { title: 'EltaMD UV Clear Broad-Spectrum SPF 46', description: 'Free from: Alcohol Fragrance Paraben', category: 'Sunscreen' },
    { title: 'Paula’s Choice 2% BHA Liquid Exfoliant', ingredients: ['Water', 'Salicylic Acid', 'Fragrance'] },
    { title: 'Volume Cream', description: 'Formulated with no synthetic fragrance' },
    { title: 'Kiehl’s Ultra Facial Cream', description: 'has a subtle fragrance of chamomile' },
    // The MAKEUP half of the same lens, with no fragrance wording at all.
    { title: 'Daily Face Moisturizer', description: 'gives a healthy bronzing effect without shimmer' },
    { title: 'Barrier Repair Moisturizer', description: 'leaves a setting powder finish' },
  ];
  for (const row of rows) {
    for (const step of ['moisturizer', 'serum', 'cleanser', 'sunscreen', 'treatment']) {
      const r = classify(row, { requestedStep: step });
      assert.equal(r.hard_reject, false,
        `${row.title} must survive a ${step} request — got ${r.reason}`);
    }
  }
});

test('the identity fields still decide it, in both directions', () => {
  const bronzerByCategory = { title: 'Hoola', category: 'Makeup > Face > Bronzer' };
  assert.equal(classify(bronzerByCategory, { requestedStep: 'bronzer' }).classification,
    'explicit_requested_beauty_category', 'a category path names the category');
  assert.equal(classify(bronzerByCategory, { requestedStep: 'serum' }).hard_reject, true);
  for (const title of ['Tom Ford Black Orchid Eau de Parfum', 'Hoola Matte Bronzer', 'Charlotte Tilbury Pillow Talk Lipstick']) {
    assert.equal(classify({ title }, { requestedStep: 'moisturizer' }).hard_reject, true,
      `${title} must not answer a moisturizer request`);
  }
});


// ---------------------------------------------------------------------------------------------
// EVERY THREADED CALL SITE, PINNED. Three of them had no test at all: reverting each to an
// unthreaded call passed the entire 3,778-test gate.

test('the framework pool finalizer threads the step it recalled for', () => {
  const { __internal } = require('../src/auroraBff/routes');
  const finalize = __internal.finalizeConcernFrameworkCandidatePools;
  assert.equal(typeof finalize, 'function', 'the finalizer must be reachable to be pinned');
  const run = (step) => finalize(
    [{ product_id: 'p1', name: 'Hoola Matte Bronzer', title: 'Hoola Matte Bronzer', matched_role_id: 'primary' }],
    {
      targetContext: {
        resolved_target_step: step,
        framework_roles: [{ role_id: 'primary', label: 'Primary', preferred_step: step }],
      },
    },
  ) || {};
  // Asserted on the SCOPE verdict the finalizer records, not on survival: on a bronzer request the
  // row still drops further down for `framework_hard_mismatch`, a different mechanism this test is
  // not about. What this pins is that the scope gate is no longer the thing that removed it.
  const bronzer = run('bronzer');
  assert.equal(bronzer.scope_classification_stats.explicit_requested_beauty_category, 1,
    'a bronzer must clear the framework pool’s scope gate on a bronzer request');
  assert.ok(!(bronzer.hard_reject || []).some((entry) => entry.reason === 'explicit_wrong_beauty_category'),
    'and must not be removed BY that gate');
  const serum = run('serum');
  assert.equal(serum.scope_classification_stats.explicit_non_skincare, 1);
  assert.deepEqual((serum.hard_reject || []).map((entry) => entry.reason), ['explicit_wrong_beauty_category'],
    'on a serum request the scope gate is exactly what removes it');
  assert.equal(serum.scope_classification_stats.explicit_requested_beauty_category, 0,
    'the class needs its own telemetry bucket, or it is counted as ambiguous');
});

test('the winner-safety check threads the primary role step', () => {
  const { isConcernPrimaryRoleWinnerSafe } = require('../src/auroraBff/selectorWinnerPolicy');
  const semanticPlan = { core_roles: [{ role_id: 'primary', preferred_step: 'bronzer' }] };
  const row = { name: 'Hoola Matte Bronzer', title: 'Hoola Matte Bronzer', matched_role_id: 'primary' };
  assert.equal(isConcernPrimaryRoleWinnerSafe(row, { semanticPlan }), true,
    'the bronzer the lane recalled must be allowed to WIN; unthreaded, this returned false');
  const serumPlan = { core_roles: [{ role_id: 'primary', preferred_step: 'serum' }] };
  assert.equal(isConcernPrimaryRoleWinnerSafe(row, { semanticPlan: serumPlan }), false,
    'and must not win a serum role');
});


// THE CJK HALF OF BOTH LISTS IS STILL DEAD, and that is this change's deliberate scope line. JS \b
// never forms a boundary against CJK, so /\b彩妆\b/ cannot match and a 宠物项圈 is admissible to a
// beauty shortlist today. Waking it needs its own PR: two review rounds on this one found that a
// live /猫/ rejects 熊猫眼 (dark circles) eye creams, that 彩妆 sat in the fatal half while its ASCII
// twin `makeup` is allow-excused, and that a live block half with a dead ALLOW half can reject a
// Chinese row nothing can excuse. Pinned so the scope line is visible rather than assumed.
test('CJK rows are untouched by this change — the gate half that has never fired still does not', () => {
  for (const name of ['宠物项圈', '口红', '彩妆套盒', '温和洁面乳 一步卸除彩妆和防晒', '娃娃脸腮红']) {
    assert.equal(at(name).hard_reject, false, `${name}: unchanged from main, in both directions`);
  }
});
