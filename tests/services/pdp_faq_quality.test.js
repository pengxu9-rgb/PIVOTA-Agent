const { isDisplayablePdpFaqItem } = require('../../src/services/pdpFaqQuality');

describe('pdpFaqQuality', () => {
  test('drops transactional booking flow questions', () => {
    expect(
      isDisplayablePdpFaqItem({
        question: 'Are you sure you want to quit?',
        answer:
          'If you quit, your current selections will be lost, and no booking request will be made.',
        source_url: 'https://theordinary.com/en-us/amino-acids-b5-serum-100403.html',
      }),
    ).toBe(false);
  });

  test('drops split regimen guide fragments', () => {
    expect(
      isDisplayablePdpFaqItem({
        question: 'How to Build a Skincare',
        answer: 'Regimen guide.',
        source_url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
      }),
    ).toBe(false);
  });

  test('keeps topical product faq', () => {
    expect(
      isDisplayablePdpFaqItem({
        question: 'How should I use UV Filters SPF 45 Serum in my routine?',
        answer:
          'Apply evenly to the face as the final step of your skincare routine, before makeup and after moisturizer.',
        source_url: 'https://theordinary.com/en-us/uv-filters-spf-45-serum-100720.html',
      }),
    ).toBe(true);
  });
});
