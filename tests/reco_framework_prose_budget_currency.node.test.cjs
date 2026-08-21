'use strict';

// A prose budget ("under $40") cannot be checked against a price in another currency -- and the
// buyer has to be TOLD that, on the card and in the answer.
//
// isConcernFrameworkCandidateOverBudget is the framework lane's hard drop: addSelectedCandidate
// refuses any row it calls over budget. resolveConcernFrameworkBudgetCeiling hardcodes
// `currency: 'USD'` on the PROSE path (the one that parses "under $40" out of the request text, as
// opposed to a structured budget_ceiling), and the gate refuses to compare across units.
//
// That refusal only became REACHABLE with #2065. Before it, extractCatalogCandidatePrice stamped
// every scalar-priced row USD, so {price_amount: 88, currency: 'GBP'} was read as USD 88, judged over
// a USD 40 budget, and dropped. After it the row reads GBP 88, the units differ, and the gate --
// which answers a BOOLEAN -- reports "not over budget". The row is selected and shown.
//
// Admitting it is the right call and this suite pins it: this lane holds no FX rates, and guessing
// fabricates a verdict in BOTH directions -- the same reader also dropped a 4500 JPY item (about 30
// USD) that HONOURED a $40 budget. It is the doctrine classifyRecoCandidateAgainstPriceCeiling
// ('unknown' across currencies) and the agent bridge's checkPriceMax ('unverifiable') already state.
//
// What was NOT right is admitting it SILENTLY. This is the prose path, so no structured priceCeiling
// exists and neither recoPriceCeiling nor the bridge's markPriceUnverifiable ever runs: the buyer
// asked for under $40 and got a GBP 88 card with nothing on screen saying the budget could not be
// checked. Every test below that asserts a marker fails at 822cd9f5f; the ones labelled GUARD pass
// there and pin the drop semantics this change must not move.
//
// Measured 2026-08-21 against the live catalog search this lane recalls from (66 queries x 24 rows):
// ~1.3% of recalled rows declare a non-USD currency overall, but 0/24 for most category queries and
// 4-5/24 (17-21%) for "natural"/"organic"/"gentle" phrasings -- the phrasings that also carry a prose
// budget. Of 17 distinct non-USD rows, 3 exceed a $40 prose budget and 9 exceed a $20 one.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/auroraBff/routes');

const ROLE_PRIMARY = {
  role_id: 'acne_clogged_pore_treatment',
  rank: 1,
  preferred_step: 'treatment',
  alternate_steps: ['serum'],
  label: 'Acne and clogged-pore treatment',
  query_terms: ['salicylic acid serum clogged pores'],
  fit_keywords: ['acne', 'clogged', 'pores', 'niacinamide', 'oil control', 'blemish'],
};

const ROLE_SUPPORT = {
  role_id: 'barrier_support_moisturizer',
  rank: 2,
  preferred_step: 'moisturizer',
  alternate_steps: ['cream'],
  label: 'Barrier-support moisturizer',
  query_terms: ['ceramide moisturizer barrier'],
  fit_keywords: ['ceramide', 'barrier', 'moisturizer', 'hydration'],
};

const PROSE_REQUEST = 'I have acne-prone oily skin and want one serum under $40. What should I get?';

function targetContext(overrides = {}) {
  return {
    framework_id: 'recofw_prose_budget_currency',
    primary_role_id: ROLE_PRIMARY.role_id,
    request_text: PROSE_REQUEST,
    semantic_plan: {
      routine_mode: 'single_product',
      comparison_mode: 'single_product',
      must_satisfy_constraints: ['one serum under $40'],
    },
    framework_roles: [ROLE_PRIMARY],
    ...overrides,
  };
}

// The live shape this fires on: a SCALAR price plus a sibling currency. That is exactly what
// sanitizeRecoRecallPoolCandidate writes when it flattens a cached pool row, and what
// external_product_seeds selects (price_amount + price_currency).
function candidate(productId, priceAmount, currency, overrides = {}) {
  return {
    product_id: productId,
    merchant_id: `merchant_${productId}`,
    brand: 'Testbrand',
    name: 'Salicylic Acid Serum 2%',
    display_name: `Testbrand ${productId}`,
    category: 'serum',
    product_type: 'serum',
    retrieval_source: 'catalog',
    retrieval_query: 'salicylic acid serum clogged pores',
    retrieval_step: 'treatment',
    retrieval_role_id: ROLE_PRIMARY.role_id,
    benefit_tags: ['salicylic acid', 'acne'],
    short_description: 'A clarifying acne serum for clogged pores.',
    price_amount: priceAmount,
    currency,
    ...overrides,
  };
}

function supportCandidate(productId, priceAmount, currency) {
  return {
    product_id: productId,
    merchant_id: `merchant_${productId}`,
    brand: 'Testbrand',
    name: 'Ceramide Barrier Cream',
    display_name: `Testbrand ${productId}`,
    category: 'moisturizer',
    product_type: 'moisturizer',
    retrieval_source: 'catalog',
    retrieval_query: 'ceramide moisturizer barrier',
    retrieval_step: 'moisturizer',
    retrieval_role_id: ROLE_SUPPORT.role_id,
    benefit_tags: ['ceramide', 'barrier', 'hydration'],
    short_description: 'A ceramide moisturizer for barrier support.',
    price_amount: priceAmount,
    currency,
  };
}

function selectedIds(state) {
  return state.selected_recommendations.map((row) => row.product_id);
}

function markerFor(state, productId) {
  const row = state.selected_recommendations.find((item) => item.product_id === productId) || null;
  return row ? row.budget_check || null : null;
}

// --- the prose parse itself -------------------------------------------------------------------

// GUARD (passes at 822cd9f5f): the prose ceiling is USD by construction and "under" is exclusive.
// Everything below depends on this being the budget the gate compares against.
test('GUARD: a prose "under $40" budget resolves to an EXCLUSIVE USD 40 ceiling', () => {
  assert.deepEqual(__internal.resolveConcernFrameworkBudgetCeiling(targetContext()), {
    amount: 40,
    currency: 'USD',
    exclusive: true,
  });
});

test('GUARD: no budget in the request text yields no ceiling at all', () => {
  const ctx = targetContext({
    request_text: 'I have acne-prone oily skin. What serum should I get?',
    semantic_plan: { routine_mode: 'single_product', comparison_mode: 'single_product', must_satisfy_constraints: [] },
  });
  assert.equal(__internal.resolveConcernFrameworkBudgetCeiling(ctx), null);
});

// --- the gate's currency branch ---------------------------------------------------------------

test('a foreign-currency price is unverifiable, never over budget', () => {
  const ctx = targetContext();
  assert.equal(
    __internal.classifyConcernFrameworkCandidateAgainstBudget(candidate('gbp_88', 88, 'GBP'), ctx).status,
    'unverifiable_currency',
  );
  // The mirror case that makes guessing indefensible: 4500 JPY is about 30 USD and HONOURS the
  // budget, and the pre-#2065 reader dropped it as "over $40".
  assert.equal(
    __internal.classifyConcernFrameworkCandidateAgainstBudget(candidate('jpy_4500', 4500, 'JPY'), ctx).status,
    'unverifiable_currency',
  );
  // Under the budget NUMERICALLY is still unverifiable: without an FX rate the comparison cannot be
  // made in either direction, so "GBP 9 is under $40" is as much a guess as "GBP 88 is over".
  assert.equal(
    __internal.classifyConcernFrameworkCandidateAgainstBudget(candidate('gbp_9', 9, 'GBP'), ctx).status,
    'unverifiable_currency',
  );
});

test('GUARD: a same-currency price still classifies over/conforming against the exclusive ceiling', () => {
  const ctx = targetContext();
  const status = (row) => __internal.classifyConcernFrameworkCandidateAgainstBudget(row, ctx).status;
  assert.equal(status(candidate('usd_45', 45, 'USD')), 'over');
  assert.equal(status(candidate('usd_40', 40, 'USD')), 'over'); // exclusive: "under $40" excludes 40
  assert.equal(status(candidate('usd_39', 39, 'USD')), 'conforming');
  assert.equal(status(candidate('usd_12', 12, 'USD')), 'conforming');
});

test('GUARD: the hard-drop predicate stays false for a foreign currency and true only for a same-unit overage', () => {
  const ctx = targetContext();
  assert.equal(__internal.isConcernFrameworkCandidateOverBudget(candidate('gbp_88', 88, 'GBP'), ctx), false);
  assert.equal(__internal.isConcernFrameworkCandidateOverBudget(candidate('usd_45', 45, 'USD'), ctx), true);
  assert.equal(__internal.isConcernFrameworkCandidateOverBudget(candidate('usd_12', 12, 'USD'), ctx), false);
});

test('a currency-unverifiable row is symmetric: a USD price against a GBP structured budget is also unverifiable', () => {
  const ctx = targetContext({
    request_text: 'I have acne-prone oily skin. What serum should I get?',
    budget_ceiling: { amount: 40, currency: 'GBP', exclusive_upper_bound: true },
    semantic_plan: { routine_mode: 'single_product', comparison_mode: 'single_product', must_satisfy_constraints: [] },
  });
  assert.equal(
    __internal.classifyConcernFrameworkCandidateAgainstBudget(candidate('usd_88', 88, 'USD'), ctx).status,
    'unverifiable_currency',
  );
  assert.equal(
    __internal.classifyConcernFrameworkCandidateAgainstBudget(candidate('gbp_12', 12, 'GBP'), ctx).status,
    'conforming',
  );
});

// --- selection: admitted, and MARKED ------------------------------------------------------------

test('a foreign-currency row over the prose budget is selected AND carries the unverifiable marker', () => {
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [candidate('gbp_88', 88, 'GBP'), candidate('usd_45', 45, 'USD'), candidate('usd_12', 12, 'USD')],
    { targetContext: targetContext() },
  );
  const ids = selectedIds(state);
  // Admitted, not suppressed -- the whole point of refusing to guess an FX rate.
  assert.ok(ids.includes('gbp_88'), `expected gbp_88 selected, got ${ids.join(',')}`);
  // The same-currency overage is still dropped: this change moves no drop.
  assert.ok(!ids.includes('usd_45'), `expected usd_45 dropped, got ${ids.join(',')}`);
  assert.ok(ids.includes('usd_12'));

  assert.deepEqual(markerFor(state, 'gbp_88'), {
    status: 'unverifiable_currency',
    requested_amount: 40,
    requested_currency: 'USD',
    price_currency: 'GBP',
  });
  // A row whose price WAS checkable must not be marked -- a marker on everything says nothing.
  assert.equal(markerFor(state, 'usd_12'), null);
});

test('a foreign-currency row UNDER the budget numerically is marked too', () => {
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [candidate('gbp_9', 9, 'GBP'), candidate('usd_12', 12, 'USD')],
    { targetContext: targetContext() },
  );
  assert.ok(selectedIds(state).includes('gbp_9'));
  assert.equal(markerFor(state, 'gbp_9')?.status, 'unverifiable_currency');
  assert.equal(markerFor(state, 'gbp_9')?.price_currency, 'GBP');
});

test('with no budget in the request, no row is marked', () => {
  const ctx = targetContext({
    request_text: 'I have acne-prone oily skin. What serum should I get?',
    semantic_plan: { routine_mode: 'single_product', comparison_mode: 'single_product', must_satisfy_constraints: [] },
  });
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [candidate('gbp_88', 88, 'GBP'), candidate('usd_45', 45, 'USD')],
    { targetContext: ctx },
  );
  assert.ok(selectedIds(state).includes('gbp_88'));
  // No ceiling means nothing was refused, so there is nothing to disclose.
  assert.equal(markerFor(state, 'gbp_88'), null);
  assert.equal(markerFor(state, 'usd_45'), null);
});

// --- the card ----------------------------------------------------------------------------------

function cardsForProseBudget({ language = 'EN', rows = null } = {}) {
  const ctx = targetContext();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    rows || [candidate('gbp_88', 88, 'GBP'), candidate('usd_12', 12, 'USD')],
    { targetContext: ctx },
  );
  return {
    ctx,
    state,
    cards: __internal.buildConcernRecommendationsFromSelectedCandidates(state.selected_recommendations, {
      targetContext: ctx,
      language,
    }),
  };
}

test('the card carries the marker and says it in words, naming both the price currency and the budget', () => {
  const { cards } = cardsForProseBudget();
  const marked = cards.find((card) => card.product_id === 'gbp_88');
  const clean = cards.find((card) => card.product_id === 'usd_12');
  assert.ok(marked, 'gbp_88 card missing');

  assert.equal(marked.budget_check.status, 'unverifiable_currency');
  assert.equal(marked.budget_check.price_currency, 'GBP');
  assert.equal(marked.budget_check.requested_amount, 40);
  assert.equal(marked.budget_check.requested_currency, 'USD');
  assert.equal(
    marked.budget_check.note,
    'Priced in GBP; we could not check it against your $40 budget.',
  );

  // The price is still shown in its real unit -- the marker explains the price, it does not hide it.
  assert.equal(marked.price_label, 'GBP 88');

  // FIRST note. buildFrameworkRecommendationNotes caps its own output at 3 entries, so a marker
  // appended after role blurbs is exactly the kind of line that quietly falls off the card.
  assert.equal(marked.notes[0], 'Priced in GBP; we could not check it against your $40 budget.');

  assert.equal(clean.budget_check, undefined);
  assert.ok(
    !clean.notes.some((note) => /could not check/i.test(String(note))),
    'a checkable USD row must carry no budget disclaimer',
  );
});

test('the card note is localized', () => {
  const { cards } = cardsForProseBudget({ language: 'CN' });
  const marked = cards.find((card) => card.product_id === 'gbp_88');
  assert.equal(marked.budget_check.note, '该商品以 GBP 计价，无法与你的 $40 预算直接比较。');
  assert.equal(marked.notes[0], '该商品以 GBP 计价，无法与你的 $40 预算直接比较。');
});

// --- the prompt ---------------------------------------------------------------------------------

function promptFor(cards, { language = 'EN', roles = [ROLE_PRIMARY] } = {}) {
  return __internal.buildRecoAssistantRewritePrompt({
    payload: {
      recommendations: cards,
      roles,
      recommendation_meta: {
        resolved_target_step: 'treatment',
        primary_target_id: ROLE_PRIMARY.role_id,
        ranked_targets: roles.map((role) => ({ target_id: role.role_id, resolved_target_step: role.preferred_step })),
        selected_target_ids: roles.map((role) => role.role_id),
        request_text: PROSE_REQUEST,
      },
    },
    language,
    profile: { skinType: 'oily', goals: ['acne'] },
    userRequestText: PROSE_REQUEST,
  });
}

test('the marker reaches the PROMPT, not just the card', () => {
  const { cards } = cardsForProseBudget();
  const prompt = promptFor(cards);

  // buildStrictSelectedOnlyRecoAssistantPromptContext rebuilds selected_product_details from an
  // ALLOWLIST -- a field it does not name never reaches the model, however well the card carries it.
  assert.match(prompt, /"budget_check_status":"unverifiable_currency"/);
  assert.match(
    prompt,
    /"budget_check_note":"Priced in GBP; we could not check it against your \$40 budget\."/,
  );

  // And the model is told what it may not say.
  assert.match(
    prompt,
    /If a selected_product_details entry has budget_check_status "unverifiable_currency", never state or imply that product meets the stated budget/,
  );

  // The checkable row must not pick up a marker on the way through.
  assert.equal(prompt.match(/"budget_check_status"/g).length, 1);
});

test('the marker survives the price-hint suppression that strips price_label', () => {
  // "under $40" does NOT match recoAssistantUserExplicitlyAskedForPriceComparison, so a multi-role
  // answer to a budgeted request lands in the branch that nulls price, price_label and
  // price_position. Stripping the disclosure alongside them would leave the model free to claim the
  // budget was met on the one row where the card says it could not be checked.
  const ctx = targetContext({
    framework_roles: [ROLE_PRIMARY, ROLE_SUPPORT],
    semantic_plan: {
      routine_mode: 'routine_mix',
      comparison_mode: 'routine_mix',
      must_satisfy_constraints: ['one serum under $40'],
    },
  });
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [candidate('gbp_88', 88, 'GBP'), supportCandidate('usd_18_support', 18, 'USD')],
    { targetContext: ctx },
  );
  const cards = __internal.buildConcernRecommendationsFromSelectedCandidates(state.selected_recommendations, {
    targetContext: ctx,
    language: 'EN',
  });
  assert.equal(cards.length, 2, `expected a two-role card set, got ${cards.map((c) => c.product_id).join(',')}`);
  const prompt = promptFor(cards, { roles: [ROLE_PRIMARY, ROLE_SUPPORT] });

  assert.match(prompt, /"selected_product_role_mix":"routine_mix"/);
  // Price hints ARE suppressed on this branch...
  assert.doesNotMatch(prompt, /"price_label":"GBP 88"/);
  // ...and the disclosure is not.
  assert.match(prompt, /"budget_check_status":"unverifiable_currency"/);
  assert.match(prompt, /"budget_check_note":"Priced in GBP; we could not check it against your \$40 budget\./);
});

test('a prompt built from checkable rows carries no budget_check field at all', () => {
  const ctx = targetContext();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [candidate('usd_12', 12, 'USD'), candidate('usd_19', 19, 'USD')],
    { targetContext: ctx },
  );
  const cards = __internal.buildConcernRecommendationsFromSelectedCandidates(state.selected_recommendations, {
    targetContext: ctx,
    language: 'EN',
  });
  const prompt = promptFor(cards);
  assert.doesNotMatch(prompt, /"budget_check_status"/);
  assert.doesNotMatch(prompt, /"budget_check_note"/);
  // The rule line goes with the field. This prompt runs under a size budget that a sibling suite
  // pins at 8000 chars for same-role payloads, and an unconditional line spent those bytes on every
  // request that had nothing to disclose -- which is nearly all of them.
  assert.doesNotMatch(prompt, /budget_check_status "unverifiable_currency"/);
});

// --- the marker's own shape guards --------------------------------------------------------------

test('a marker that cannot be read produces no sentence rather than a broken one', () => {
  const full = {
    status: 'unverifiable_currency',
    requested_amount: 40,
    requested_currency: 'USD',
    price_currency: 'GBP',
  };
  assert.equal(
    __internal.formatConcernFrameworkBudgetCheckNote(full, { language: 'EN' }),
    'Priced in GBP; we could not check it against your $40 budget.',
  );
  // Each of these would otherwise reach the buyer as a sentence with a hole in it -- "Priced in ;
  // we could not check it against your  budget." A blank disclosure is worse than none: it occupies
  // the slot that would have told them something.
  for (const broken of [
    { ...full, price_currency: '' },
    { ...full, price_currency: 'POUNDS' },
    { ...full, requested_currency: '' },
    { ...full, requested_amount: 0 },
    { ...full, requested_amount: null },
    { ...full, status: 'conforming' },
    null,
  ]) {
    assert.equal(__internal.formatConcernFrameworkBudgetCheckNote(broken, { language: 'EN' }), '');
  }
});

test('a statusless budget_check object is not a marker', () => {
  assert.equal(__internal.pickConcernFrameworkBudgetCheckMarker({ budget_check: {} }), null);
  assert.equal(__internal.pickConcernFrameworkBudgetCheckMarker({ budget_check: { status: '  ' } }), null);
  assert.equal(__internal.pickConcernFrameworkBudgetCheckMarker({ budget_check: 'unverifiable' }), null);
  assert.equal(__internal.pickConcernFrameworkBudgetCheckMarker({}), null);
  assert.equal(__internal.pickConcernFrameworkBudgetCheckMarker(null), null);
  assert.deepEqual(
    __internal.pickConcernFrameworkBudgetCheckMarker({ budget_check: { status: 'unverifiable_currency' } }),
    { status: 'unverifiable_currency' },
  );
});

test('a verdict with no readable budget or price yields no marker', () => {
  const verdict = {
    status: 'unverifiable_currency',
    budget: { amount: 40, currency: 'USD', exclusive: true },
    price: { amount: 88, currency: 'GBP' },
  };
  assert.ok(__internal.buildConcernFrameworkBudgetCheckMarker(verdict));
  assert.equal(__internal.buildConcernFrameworkBudgetCheckMarker({ ...verdict, budget: null }), null);
  assert.equal(__internal.buildConcernFrameworkBudgetCheckMarker({ ...verdict, price: null }), null);
  assert.equal(__internal.buildConcernFrameworkBudgetCheckMarker({ ...verdict, status: 'over' }), null);
  assert.equal(__internal.buildConcernFrameworkBudgetCheckMarker(null), null);
});

// --- the budget label matches the card's own price dialect ----------------------------------------

test('the budget label uses the same dialect as the card price_label, and the card and prompt sentences are identical', () => {
  // A GBP ceiling is the only way to see the dialect at all -- the PROSE ceiling is USD by
  // construction and "$40" renders identically everywhere, so a USD-only suite cannot tell one
  // formatter from another.
  //
  // #2069 split rendering into formatDisplayPriceLabel (glyph, for a person) and
  // formatPromptPriceLabel (ISO code, for a model), and the tempting reading is that a card sentence
  // takes the display half. It must not here: this lane sets the card's OWN price_label with the
  // prompt formatter, and normalizeRecommendationProductCard keeps a price_label the row already
  // carries. So the buyer sees "GBP 88" for the price, and a "£40" budget beside it would print two
  // currency dialects on one card.
  const ctx = targetContext({
    request_text: 'I have acne-prone oily skin. What serum should I get?',
    budget_ceiling: { amount: 40, currency: 'GBP', exclusive_upper_bound: true },
    semantic_plan: { routine_mode: 'single_product', comparison_mode: 'single_product', must_satisfy_constraints: [] },
  });
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [candidate('usd_88', 88, 'USD'), candidate('gbp_12', 12, 'GBP')],
    { targetContext: ctx },
  );
  assert.ok(selectedIds(state).includes('usd_88'));
  assert.equal(markerFor(state, 'usd_88')?.requested_currency, 'GBP');
  assert.equal(markerFor(state, 'usd_88')?.price_currency, 'USD');
  // The row the ceiling COULD be checked against carries no marker, in either currency direction.
  assert.equal(markerFor(state, 'gbp_12'), null);

  const cards = __internal.buildConcernRecommendationsFromSelectedCandidates(state.selected_recommendations, {
    targetContext: ctx,
    language: 'EN',
  });
  const marked = cards.find((card) => card.product_id === 'usd_88');
  const expected = 'Priced in USD; we could not check it against your GBP 40 budget.';
  assert.equal(marked.budget_check.note, expected);
  assert.equal(marked.notes[0], expected);
  // Same card, same RENDERER -- which is the invariant, not a single glyph style. USD is the one code
  // in the prompt table with a symbol, so this card reads "$88" for the price and "GBP 40" for the
  // budget: both are what formatRecoAssistantPromptPriceLabel produces for their own currency. What
  // must never happen is one of the two coming from the OTHER formatter, which is how "£40" would end
  // up beside "GBP 88".
  assert.equal(marked.price_label, '$88');
  assert.equal(
    __internal.formatConcernFrameworkBudgetCheckNote(marked.budget_check, { language: 'EN' }),
    marked.budget_check.note,
  );

  // And the prompt carries the SAME string, not a second rendering of it. Fully anchored on both
  // ends: an unanchored match would still pass if the compact field silently truncated the sentence.
  const prompt = promptFor(cards);
  assert.match(prompt, new RegExp(`"budget_check_note":"${expected.replace(/[.$]/g, '\\$&')}"`));
  assert.doesNotMatch(prompt, /"budget_check_note":"[^"]*£/);
});

// --- the OTHER card builder for the same rows -----------------------------------------------------

test('the beauty-mainline card builder carries the marker too', () => {
  // REGRESSION, found by review. buildRecoRowsFromMainlineProducts is the second card builder for the
  // SAME selected rows -- buildBeautyMainlineLocalSearchResult returns
  // effectiveCandidateState.selected_recommendations as its `products`, and isBeautyOwnedChatRecoRequest
  // routes every request carrying framework_roles down that path, so this is where most marked rows
  // actually land. It is an allowlist object literal, not a spread, so the marker was built during
  // selection and discarded one function later: a GBP 88 card against a "$40" ask, no disclosure, and
  // no rule line in the prompt either. Every card test above passed while this hole was open, which is
  // exactly why this one drives the OTHER builder.
  const ctx = targetContext();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [candidate('gbp_88', 88, 'GBP'), candidate('usd_12', 12, 'USD')],
    { targetContext: ctx },
  );
  const cards = __internal.buildRecoRowsFromMainlineProducts(state.selected_recommendations, {
    targetContext: ctx,
    language: 'EN',
  });
  const marked = cards.find((card) => card.product_id === 'gbp_88');
  const clean = cards.find((card) => card.product_id === 'usd_12');
  assert.ok(marked, `gbp_88 card missing from ${cards.map((c) => c.product_id).join(',')}`);
  assert.equal(marked.budget_check.status, 'unverifiable_currency');
  assert.equal(marked.budget_check.price_currency, 'GBP');
  assert.equal(
    marked.budget_check.note,
    'Priced in GBP; we could not check it against your $40 budget.',
  );
  assert.equal(marked.notes[0], 'Priced in GBP; we could not check it against your $40 budget.');
  assert.equal(clean.budget_check, undefined);
  assert.ok(!clean.notes.some((note) => /could not check/i.test(String(note))));
});

// --- shapes the first pass left unpinned ----------------------------------------------------------

test('a marked row that is the LEAD card still leads with its disclosure', () => {
  // The highest-visibility case: the marker must not depend on the row being a support pick.
  const ctx = targetContext();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [candidate('gbp_88', 88, 'GBP')],
    { targetContext: ctx },
  );
  assert.equal(state.primary_recommendation_id, 'gbp_88');
  const cards = __internal.buildConcernRecommendationsFromSelectedCandidates(state.selected_recommendations, {
    targetContext: ctx,
    language: 'EN',
  });
  assert.equal(cards[0].product_id, 'gbp_88');
  assert.equal(cards[0].notes[0], 'Priced in GBP; we could not check it against your $40 budget.');
});

test('two marked rows each carry their own currency, and the prompt rule is stated once', () => {
  const ctx = targetContext();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [candidate('gbp_88', 88, 'GBP'), candidate('eur_60', 60, 'EUR')],
    { targetContext: ctx },
  );
  const cards = __internal.buildConcernRecommendationsFromSelectedCandidates(state.selected_recommendations, {
    targetContext: ctx,
    language: 'EN',
  });
  assert.equal(cards.length, 2);
  const byId = new Map(cards.map((card) => [card.product_id, card]));
  assert.equal(byId.get('gbp_88').budget_check.price_currency, 'GBP');
  assert.equal(byId.get('eur_60').budget_check.price_currency, 'EUR');
  assert.match(byId.get('eur_60').notes[0], /^Priced in EUR;/);

  const prompt = promptFor(cards);
  assert.equal(prompt.match(/"budget_check_status"/g).length, 2);
  // The rule is a rule, not a per-row annotation: repeating it per row would spend the prompt budget
  // the conditional gate exists to protect.
  assert.equal(prompt.match(/budget_check_status "unverifiable_currency"/g).length, 1);
});

test('the disclosure reaches the prompt in CN too', () => {
  // Only the CARD was CN-tested before; the prompt leg re-renders through its own compaction, which
  // has a maxLen and could in principle mangle multi-byte text.
  const ctx = targetContext();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [candidate('gbp_88', 88, 'GBP'), candidate('usd_12', 12, 'USD')],
    { targetContext: ctx },
  );
  const cards = __internal.buildConcernRecommendationsFromSelectedCandidates(state.selected_recommendations, {
    targetContext: ctx,
    language: 'CN',
  });
  const prompt = promptFor(cards, { language: 'CN' });
  assert.match(prompt, /"budget_check_status":"unverifiable_currency"/);
  assert.match(prompt, /该商品以 GBP 计价，无法与你的 \$40 预算直接比较。/);
});
