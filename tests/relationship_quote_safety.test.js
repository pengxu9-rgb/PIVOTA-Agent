const { isShowableQuote, sanitizeWhyCandidateQuotes, quotePartIsSpecific, DEFAULT_REASONS_USER_VISIBLE, brandAliases } = require('../src/auroraBff/relationshipQuoteSafety');
const { coerceRelationshipEdge } = require('../src/auroraBff/productRelationshipGraph');

// 2026-10-20 (#2478 review): every serving path reads why_candidate through coerceRelationshipEdge, so
// rows approved before validator v3 cannot show a stitched, JSON-shaped, generic or brand-only quote.
test('a showable quote is one specific fact', () => {
  expect(isShowableQuote('Niacinamide')).toBe(true);
  expect(isShowableQuote('dry skin')).toBe(true);
  expect(isShowableQuote('non … comedogenic')).toBe(false);
  expect(isShowableQuote('Suitable for ... sensitive skin')).toBe(false);
  expect(isShowableQuote('category": "toner')).toBe(false);
  expect(isShowableQuote('cream')).toBe(false);
  expect(isShowableQuote('Water')).toBe(false);
  expect(isShowableQuote('USD')).toBe(false);
  expect(isShowableQuote('AAA', 'AAA')).toBe(false);
  expect(isShowableQuote('AAA Cream', 'AAA')).toBe(false);
  expect(quotePartIsSpecific('AAA Calming Toner', 'AAA')).toBe(true);
});

test('the edge reader drops unshowable quotes and the reasons built from them, and keeps the rest', () => {
  const edge = coerceRelationshipEdge({
    id: 'e1', anchor_ref: 'product:a', candidate_product_ref: 'product:b', relation_type: 'competitive_alternative',
    anchor_snapshot: { brand: 'AAA', title: 'Rich Toner' }, candidate_snapshot: { brand: 'BBB', title: 'Clear Toner' },
    why_candidate: {
      summary: 'A distinct product option.',
      shared_evidence: [{ anchor_fact: 'AAA', candidate_fact: 'BBB' }, { anchor_fact: 'Niacinamide', candidate_fact: 'Niacinamide' },
        { anchor_fact: 'cream', candidate_fact: 'cream' }],
      reasons_user_visible: ['AAA / BBB', 'Niacinamide / Niacinamide', 'cream / cream', 'Same routine step'],
    },
  });
  expect(edge.why_candidate.shared_evidence).toEqual([{ anchor_fact: 'Niacinamide', candidate_fact: 'Niacinamide' }]);
  expect(edge.why_candidate.reasons_user_visible).toEqual(['Niacinamide / Niacinamide', 'Same routine step']);
  expect(edge.why_candidate.summary).toBe('A distinct product option.');
});

test('a why_candidate without quotes is left exactly as it was', () => {
  const why = { summary: 's', reasons_user_visible: ['Same category'] };
  expect(sanitizeWhyCandidateQuotes(why)).toBe(why);
  const clean = { shared_evidence: [{ anchor_fact: 'Niacinamide', candidate_fact: 'Allantoin' }] };
  expect(sanitizeWhyCandidateQuotes(clean, {})).toBe(clean);
});

test('short actives and CJK words count; stopwords and one word of a multi-word brand do not', () => {
  for (const q of ['AHA', 'BHA', 'SPF', 'SPF 50']) expect(isShowableQuote(q)).toBe(true);
  expect(isShowableQuote('미백 기능성')).toBe(true);
  expect(isShowableQuote('保湿')).toBe(true);
  for (const q of ['of the', 'with a', 'with', 'toner']) expect(isShowableQuote(q)).toBe(false);
  expect(isShowableQuote('Ordinary', 'The Ordinary')).toBe(false);
  expect(isShowableQuote('[THE ORDINARY] Retinol 0.2% in Squalane')).toBe(true);
});

test('when every quote reason is dropped the fixed default reasons stand in, never the row summary', () => {
  // Summaries were the model's own recommendation_reason before 2026-10-01, and renewal keeps such rows alive.
  const why = { summary: 'Model-written: clinically better than the original.', shared_evidence: [{ anchor_fact: 'cream', candidate_fact: 'cream' }],
    reasons_user_visible: ['cream / cream'] };
  const out = sanitizeWhyCandidateQuotes(why);
  expect(out.reasons_user_visible).toEqual(DEFAULT_REASONS_USER_VISIBLE);
  expect(out.reasons_user_visible).not.toContain(why.summary);
  expect(require('../src/auroraBff/productRelationshipGraphBuilder.js')).toBeTruthy();
});

test('a native-script brand name is the brand ("에뛰드" for ETUDE)', () => {
  const etude = { brand: 'ETUDE', title: '에뛰드 순정 약산성 클렌징 폼' };
  expect(isShowableQuote('에뛰드', brandAliases(etude))).toBe(false);
  // a known transliteration, or a token brand punctuation marks; never a bare first word (it is often the product)
  expect(brandAliases({ brand: 'BBB', title: '레티놀 시카 크림' })).toBe('BBB');
  expect(isShowableQuote('레티놀', brandAliases({ brand: 'ETUDE', title: '레티놀 시카 크림' }))).toBe(true);
  expect(brandAliases({ brand: 'BBB', title: '[에뛰드] 수분 크림' })).toBe('BBB 에뛰드');
  expect(brandAliases({ brand: 'BBB', title: '에뛰드 | 수분 크림' })).toBe('BBB 에뛰드');
  expect(isShowableQuote('에뛰드', brandAliases({ brand: 'ETUDE', title: 'NEW 에뛰드 크림' }))).toBe(false);
  expect(isShowableQuote('약산성 클렌징 폼', brandAliases(etude))).toBe(true);
  for (const word of ['크림', '정제수', '글리세린', '精华', '化粧水']) expect(isShowableQuote(word)).toBe(false);
  // a single CJK character is never specific (N35)
  expect(isShowableQuote('美')).toBe(false);
  // two short words are not specific without a real word of three letters (N43)
  expect(isShowableQuote('ab cd')).toBe(false);
  expect(isShowableQuote('pH 5.5')).toBe(true);
});
