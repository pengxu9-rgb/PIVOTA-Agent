// Sunscreen is never inferred from description / FAQ text, and a title that names a sunscreen the
// way sunscreens are actually titled ("SPF50+", "Suncream", "Sun Stick") is one.
//
// Measured 2026-09-25 on prod external_product_seeds: 169 seeds carried recall category
// "Sunscreen"; 37 of them were retinoids, acids, eye patches, a self-tanner, kits and a pouch,
// labelled from copy such as "Wear SPF during the day". The wording below is theirs. Real
// sunscreens titled "Suncream ... SPF50+" had only been labelled through that same text scan.
const { buildExternalSeedRecallDoc } = require('../../src/services/externalSeedRecall');

function categoryOf({ title, description = '', productType = '', faq = [] }) {
  const seedData = {
    title,
    description,
    ...(productType ? { product_type: productType } : {}),
    ...(faq.length ? { pdp_faq_items: faq } : {}),
  };
  return buildExternalSeedRecallDoc({ row: { title }, seedData, snapshot: {} }).category;
}

describe('external seed recall category: sunscreen', () => {
  test.each([
    [
      'retinoid usage advice',
      'Retinol 1% in Squalane',
      'We recommend using this formulation at night. We strongly advise applying sunscreen if using this product during the day.',
    ],
    [
      'acid usage advice',
      'Tranexamic Topical Acid 5%',
      'If irritation or redness occurs, reduce frequency of use until skin adjusts. Wear SPF during the day. Patch test prior to use.',
    ],
    [
      'eye patches warning',
      'FortifEYE Single-Use Eye Patches',
      'If you are pregnant or nursing, consult your doctor before use. Use sunscreen daily as retinol can increase sun sensitivity.',
    ],
    [
      'removal copy',
      'Plumptuous Lip Jelly',
      'How to Pair: Makeup Re-Wined gently takes off makeup, sunscreen, and impurities.',
    ],
    [
      'accessory copy',
      'Supergoop! Mesh Zip Pouch Bag',
      'A travel-ready monogram mesh pouch perfect for organizing your daily SPF and beauty essentials.',
    ],
  ])('text that only mentions sunscreen does not make a %s product a Sunscreen', (_label, title, description) => {
    expect(categoryOf({ title, description })).not.toBe('Sunscreen');
  });

  test('a sunscreen mention in an FAQ does not make a cleanser a Sunscreen', () => {
    const category = categoryOf({
      title: 'Barrier Builder',
      faq: [{
        question: 'Can this cleanser be paired with a sunscreen?',
        answer: 'Yes, you can pair it with a sunscreen that contains antioxidants.',
      }],
    });
    expect(category).not.toBe('Sunscreen');
  });

  test.each([
    ['Centella Air-Fit Suncream Plus SPF50+ PA++++'],
    ['Relief Sun : Rice + Probiotics (SPF50+ PA++++)'],
    ['Hyalu-Cica Silky-Fit Sun Stick'],
    ['Madecassoside Moisture Sun Serum'],
    ['Aloe Soothing Sun Cream SPF50+/ PA+++'],
    ['Sun Project Soothing Sun Lotion SPF30'],
    ['Daily Mineral Sunscreen'],
  ])('accepts: a title that names a sunscreen is a Sunscreen (%s)', (title) => {
    expect(categoryOf({ title, description: 'Lightweight daily protection.' })).toBe('Sunscreen');
  });

  test('accepts: a sunscreen product_type still labels a title the patterns cannot read', () => {
    expect(categoryOf({ title: 'ビオレ ＵＶ アクアリッチ ウォータリーエッセンス', productType: 'face sunscreen' })).toBe('Sunscreen');
  });

  test('a "non-SPF" title is not a Sunscreen', () => {
    expect(categoryOf({ title: 'Oil-Free Non-SPF Moisturizer' })).not.toBe('Sunscreen');
  });
});
