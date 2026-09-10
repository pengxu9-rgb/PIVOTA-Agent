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

test('NOT A BEAUTY PRODUCT never relaxes, whatever was requested', () => {
  // The half of the old list that was doing real work. No request makes a dog collar admissible.
  for (const step of [undefined, 'bronzer', 'eau de toilette', 'serum']) {
    for (const name of ['Dog Collar', 'Plush Toy', 'Lingerie Set', 'Loofah']) {
      assert.equal(at(name, step).hard_reject, true,
        `${name} must stay fatal with requestedStep=${String(step)}`);
    }
  }
});

test('a makeup row is still rejected from a SKINCARE shortlist', () => {
  // The gate has to work in both directions, or this trades #2155 for its mirror image.
  for (const name of ['Hoola Matte Bronzer', 'Cream Blush', 'Chanel No 5 perfume', '口红']) {
    assert.equal(at(name).hard_reject, true, `${name} must not enter a shortlist that asked for skincare`);
  }
  // `Cream Blush` in particular: 'cream' is an allow-token, and letting it excuse a blush would
  // admit makeup to every skincare shortlist. It was fatal before this change for that reason.
  assert.equal(at('Cream Blush').reason, 'explicit_wrong_beauty_category');
});

test('the CJK half of the block list actually fires — it never did', () => {
  // JS \b is defined against [A-Za-z0-9_], so a CJK character never forms a word boundary and
  // /\b彩妆\b/ CANNOT match. Verified against origin/main: every CJK token in these lists tested
  // false, so a 宠物项圈 (pet collar) was admissible to a beauty shortlist.
  for (const name of ['宠物项圈', '玩具', '内衣']) {
    assert.equal(at(name).hard_reject, true, `${name} must be rejected as non-beauty`);
    assert.equal(at(name, 'bronzer').hard_reject, true, `${name} must stay rejected on any request`);
  }
  // ...and the CJK makeup tokens are category-relaxable, exactly like their English twins.
  assert.equal(at('口红', 'lipstick').hard_reject, false);
  assert.equal(at('香水', 'eau de toilette').hard_reject, false);
  assert.equal(at('口红').hard_reject, true, 'still fatal when no makeup was requested');
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
