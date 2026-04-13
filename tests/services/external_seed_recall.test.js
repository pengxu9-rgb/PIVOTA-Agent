const {
  buildExternalSeedRecallDoc,
  buildExternalSeedRecallLikePredicate,
  resolveExternalSeedRecallDoc,
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
    expect(doc.quality_state).toBe('limited');
    expect(doc.suppression_flags).toEqual(
      expect.objectContaining({
        exclude_from_recall: false,
        exclude_from_similar: true,
      }),
    );
  });

  test('blocks obvious non-merch pages from recall and similar', () => {
    const doc = buildExternalSeedRecallDoc({
      row: {
        id: 'eps_non_merch',
        title: 'Store Locator',
        canonical_url: 'https://brand.example/pages/store-locator',
        destination_url: 'https://brand.example/pages/store-locator',
        source_page_type: 'page',
      },
      seedData: {
        description: 'Find a store near you.',
      },
      snapshot: {},
    });

    expect(doc.quality_state).toBe('blocked');
    expect(doc.suppression_flags).toEqual(
      expect.objectContaining({
        exclude_from_recall: true,
        exclude_from_similar: true,
        suppress_facts: true,
      }),
    );
  });

  test('re-cleans stored recall docs before using them for PDP recall', () => {
    const doc = resolveExternalSeedRecallDoc({
      row: {
        id: 'eps_fenty_bha',
        title: "Blemish Defeat'r BHA Spot-Targeting Gel",
        canonical_url: 'https://fentybeauty.com/products/blemish-defeatr-bha-spot-targeting-gel',
      },
      seedData: {
        brand: 'Fenty Beauty',
        pdp_description_raw:
          "THE UNDERCOVER BLEMISH FIGHTER THE BLEMISH FIX SO STEALTH, YOU'LL NEVER SEE IT UNDER MAKEUP Fragrance-free spot care with salicylic acid.",
        derived: {
          recall: {
            retrieval_title: "Blemish Defeat&#39;r BHA Spot-Targeting Gel",
            retrieval_summary:
              "Details\n\nDetails\n\nTHE UNDERCOVER BLEMISH FIGHTER THE BLEMISH FIX SO STEALTH, YOU'LL NEVER SEE IT UNDER MAKEUP Fragrance-free spot care with salicylic acid. Learn more Close BHA-GEL GEGEN AKNE",
            retrieval_body:
              "THE UNDERCOVER BLEMISH FIGHTER THE BLEMISH FIX SO STEALTH, YOU'LL NEVER SEE IT UNDER MAKEUP Fragrance-free spot care with salicylic acid.\n\nLearn more\n\nClose\n\nBHA-GEL GEGEN AKNE",
            brand: 'Fenty Beauty',
            category: 'Treatment',
            vertical: 'fragrance',
            ingredient_tokens: ['salicylic', 'acid'],
            alias_tokens: ['blemish', 'bha'],
            exclusion_flags: {
              gift_card: false,
              donation_bundle: false,
              non_merchandise: false,
            },
            quality_signals: {
              template_polluted: false,
              synthetic_summary: false,
              extractor_description_present: true,
            },
            version: 'v1',
          },
        },
      },
      snapshot: {},
    });

    expect(doc.retrieval_title).toBe("Blemish Defeat'r BHA Spot-Targeting Gel");
    expect(doc.retrieval_summary).not.toMatch(/details|learn more|bha-gel/i);
    expect(doc.retrieval_summary).not.toMatch(/THE UNDERCOVER|BLEMISH FIX SO STEALTH|YOU'LL NEVER SEE IT UNDER MAKEUP/i);
    expect(doc.retrieval_body).not.toMatch(/learn more|bha-gel/i);
    expect(doc.retrieval_body).not.toMatch(/THE UNDERCOVER|BLEMISH FIX SO STEALTH|YOU'LL NEVER SEE IT UNDER MAKEUP/i);
    expect(doc.vertical).toBe('skincare');
  });

  test('cuts section soup before it reaches recall summary and body', () => {
    const doc = buildExternalSeedRecallDoc({
      row: {
        id: 'eps_sigma_ambiance',
        title: 'Ambiance Eyeshadow Palette',
        canonical_url: 'https://sigmabeauty.com/products/ambiance-eyeshadow-palette',
      },
      seedData: {
        brand: 'sigma beauty',
        category: 'Eyeshadow',
        pdp_description_raw:
          'DESCRIPTION Get the ultimate golden-hour glow with warm matte eyeshadows and shimmer eyeshadows. Inspired by the sun’s peaceful light. HOW TO USE Apply and blend the eyeshadow shade(s) of your choice. Net Wt. 0.49oz./14g INGREDIENTS Mica, Magnesium Stearate, Silica.',
      },
      snapshot: {},
    });

    expect(doc.retrieval_summary).toContain('Get the ultimate golden-hour glow');
    expect(doc.retrieval_summary).not.toMatch(/DESCRIPTION|HOW TO USE|INGREDIENTS|Net Wt/i);
    expect(doc.retrieval_body).not.toMatch(/DESCRIPTION|HOW TO USE|INGREDIENTS|Net Wt/i);
  });

  test('prefers title and category over stray scent words when inferring recall vertical', () => {
    const doc = buildExternalSeedRecallDoc({
      row: {
        id: 'eps_fenty_instant_reset',
        title:
          'Instant Reset Brightening Overnight Recovery Gel-Cream with Niacinamide + Kalahari Melon Oil',
        canonical_url:
          'https://fentybeauty.com/products/instant-reset-brightening-overnight-recovery-gel-cream',
      },
      seedData: {
        brand: 'Fenty Beauty',
        category: 'Moisturizer',
        pdp_description_raw:
          'Take it to bed-wake up transformed. Helps improve the look of pores in just 1 week and deeply hydrates skin overnight. Refreshes with a lush, tropical fruit and floral scent.',
      },
      snapshot: {},
    });

    expect(doc.vertical).toBe('skincare');
  });

  test('builds recall-first SQL with raw seed fallback only at the end', () => {
    const predicate = buildExternalSeedRecallLikePredicate('$3', { includeLegacyFallback: true });
    expect(predicate).toMatch(/retrieval_title/);
    expect(predicate).toMatch(/retrieval_summary/);
    expect(predicate).toMatch(/brand_name/);
    expect(predicate).toMatch(/vendor/);
    expect(predicate).toMatch(/ingredient_tokens/);
    expect(predicate).toMatch(/alias_tokens/);
    expect(predicate).toMatch(/seed_data::text/);
    expect(predicate.indexOf('retrieval_title')).toBeLessThan(predicate.indexOf('seed_data::text'));
  });

  test('authority alias SQL reads refreshed raw seed aliases before legacy fallback', () => {
    const predicate = buildExternalSeedRecallLikePredicate('$3', { includeLegacyFallback: true });

    expect(predicate).toMatch(/seed_data#>>'\{derived,recall,alias_tokens\}'/);
    expect(predicate).toMatch(/seed_data#>>'\{search_aliases\}'/);
    expect(predicate).toMatch(/seed_data#>>'\{snapshot,search_aliases\}'/);
    expect(predicate.indexOf("seed_data#>>'{search_aliases}'")).toBeLessThan(predicate.indexOf('seed_data::text'));
  });

  test('expands alias tokens for punctuation and SPF-normalized recall matching', () => {
    const doc = buildExternalSeedRecallDoc({
      row: {
        title: 'Anthelios Ultra-Light Invisible Fluid SPF 50+',
      },
      seedData: {
        brand: 'La Roche-Posay',
        search_aliases: ['Anthelios Invisible Fluid SPF50+', 'Ultra Light Invisible Fluid'],
      },
      snapshot: {},
    });

    expect(doc.alias_tokens).toEqual(
      expect.arrayContaining([
        'anthelios ultra light invisible fluid spf50+',
        'anthelios ultra light invisible fluid spf 50 plus',
        'ultra light',
        'invisible fluid',
      ]),
    );
  });
});
