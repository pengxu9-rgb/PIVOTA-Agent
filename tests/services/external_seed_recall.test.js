const {
  buildExternalSeedRecallDoc,
  buildExternalSeedRecallLikePredicate,
} = require('../../src/services/externalSeedRecall');

describe('externalSeedRecall', () => {
  test('builds a cleaned recall document and removes template or support noise', () => {
    const doc = buildExternalSeedRecallDoc({
      row: {
        id: 'eps_fenty_body_1',
        title: 'Fenty Beauty - Butta Drop Whipped Oil Body Cream',
        canonical_url: 'https://fentybeauty.com/products/butta-drop-whipped-oil-body-cream',
        destination_url: 'https://fentybeauty.com/products/butta-drop-whipped-oil-body-cream',
      },
      seedData: {
        brand: 'Fenty Beauty',
        pdp_description_raw:
          'OFFICIAL: Rich body cream for deep moisture. /// SOCIAL HIGHLIGHTS: customer service approved.',
        pdp_details_sections: [
          { heading: 'Overview', body: 'A rich body cream with tropical oils that leaves skin soft and radiant.' },
          { heading: 'Impact', body: 'About us blog foundation transparency give 20%.' },
        ],
      },
      snapshot: {},
    });

    expect(doc.retrieval_title).toBe('Butta Drop Whipped Oil Body Cream');
    expect(doc.retrieval_summary).toContain('A rich body cream with tropical oils');
    expect(doc.retrieval_summary).not.toMatch(/SOCIAL HIGHLIGHTS|customer service/i);
    expect(doc.retrieval_body).not.toMatch(/about us|blog|transparency|give 20%/i);
    expect(doc.quality_signals.synthetic_summary).toBe(true);
    expect(doc.quality_signals.template_polluted).toBe(true);
    expect(doc.exclusion_flags).toEqual({
      gift_card: false,
      donation_bundle: false,
      non_merchandise: false,
    });
    expect(doc.vertical).toBe('skincare');
  });

  test('marks gift cards and donation bundles as exclusion rows', () => {
    const doc = buildExternalSeedRecallDoc({
      row: {
        id: 'eps_fenty_gift_1',
        title: 'Fenty Beauty E-Gift Card Donation Bundle',
        canonical_url: 'https://fentybeauty.com/products/e-gift-card-donation-bundle',
        destination_url: 'https://fentybeauty.com/products/e-gift-card-donation-bundle',
      },
      seedData: {
        brand: 'Fenty Beauty',
        description: 'Digital gift card supporting a donation campaign.',
      },
      snapshot: {},
    });

    expect(doc.exclusion_flags.gift_card).toBe(true);
    expect(doc.exclusion_flags.donation_bundle).toBe(true);
    expect(doc.vertical).toBe('gift_card');
  });

  test('builds recall-first SQL with raw seed fallback only at the end', () => {
    const predicate = buildExternalSeedRecallLikePredicate('$3', { includeLegacyFallback: true });
    expect(predicate).toMatch(/retrieval_title/);
    expect(predicate).toMatch(/retrieval_summary/);
    expect(predicate).toMatch(/ingredient_tokens/);
    expect(predicate).toMatch(/alias_tokens/);
    expect(predicate).toMatch(/seed_data::text/);
    expect(predicate.indexOf('retrieval_title')).toBeLessThan(predicate.indexOf('seed_data::text'));
  });
});
