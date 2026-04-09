const path = require('path');

const {
  assertAllReviewRowsPassed,
  buildReviewRows,
  buildSearchCardCompactCandidate,
  buildSearchCardTitleCandidate,
  compactCardIntroCandidate,
  displayPath,
  renderReviewMarkdown,
} = require('../scripts/pivota_insights_review_workflow');

describe('pivota insights review workflow', () => {
  test('buildReviewRows shapes review packet rows with search-card candidate', () => {
    const compareReport = {
      rows: [
        {
          case_id: 'live_ext_demo',
          selected: {
            selected_mode: 'manual_override',
            bundle: {
              canonical_product_ref: {
                merchant_id: 'external_seed',
                product_id: 'ext_demo',
              },
              evidence_profile: 'seller_only',
              quality_state: 'limited',
              market_signal_badges: [
                {
                  badge_type: 'editorial_signal',
                  badge_label: 'Editorial: top pick',
                },
              ],
              product_intel_core: {
                what_it_is: {
                  headline: 'Brightening serum',
                  body: 'A brightening serum that combines niacinamide and vitamin C for dullness and uneven tone.',
                },
                why_it_stands_out: [
                  {
                    headline: 'Niacinamide plus vitamin C',
                    body: 'Keeps two familiar brightening ingredients in one serum step.',
                  },
                ],
              },
            },
          },
        },
      ],
    };
    const casesPayload = {
      rows: [
        {
          case_id: 'live_ext_demo',
          product: {
            merchant_id: 'external_seed',
            product_id: 'ext_demo',
            brand: 'Brand',
            title: 'Glow Serum',
          },
        },
      ],
    };

    const rows = buildReviewRows(compareReport, casesPayload);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      case_id: 'live_ext_demo',
      product_id: 'ext_demo',
      merchant_id: 'external_seed',
      brand: 'Brand',
      title: 'Glow Serum',
      selected_mode: 'manual_override',
      evidence_profile: 'seller_only',
      quality_state: 'limited',
      review_status: 'pending',
    });
    expect(rows[0].search_card_intro_candidate).toMatch(/brightening serum/i);
    expect(rows[0].search_card_title_candidate).toBe('Brand Brightening Serum');
    expect(rows[0].search_card_proof_badge_candidate).toBe('Editorial: top pick');
    expect(rows[0].search_card_compact_candidate).toBe('Brightening serum');
    expect(rows[0].search_card_title_guidance).toMatch(/brand \+ product type/i);
  });

  test('assertAllReviewRowsPassed blocks publish until every row is marked pass', () => {
    expect(() =>
      assertAllReviewRowsPassed({
        rows: [
          { case_id: 'a', review_status: 'pass' },
          { case_id: 'b', review_status: 'rewrite' },
        ],
      }),
    ).toThrow(/review_not_ready/i);

    expect(
      assertAllReviewRowsPassed({
        rows: [
          { case_id: 'a', review_status: 'pass' },
          { case_id: 'b', review_status: 'pass' },
        ],
      }),
    ).toEqual(['a', 'b']);
  });

  test('renderReviewMarkdown includes search-card candidate and review gate text', () => {
    const markdown = renderReviewMarkdown({
      meta: {
        generated_at: '2026-04-09T00:00:00.000Z',
        model: 'gemini-3-pro-preview',
      },
      rows: [
        {
          case_id: 'live_ext_demo',
          brand: 'Brand',
          title: 'Glow Serum',
          review_status: 'pending',
          selected_mode: 'manual_override',
          evidence_profile: 'seller_only',
          quality_state: 'limited',
          what_it_is: { body: 'A brightening serum for dullness.' },
          why_it_stands_out: [{ headline: 'Vitamin C plus niacinamide', body: 'Two brightening actives in one step.' }],
          search_card_proof_badge_candidate: 'Editorial: top pick',
          search_card_intro_candidate: 'A brightening serum for dullness.',
          search_card_compact_candidate: 'Brightening serum',
          review_notes: '',
        },
      ],
    });

    expect(markdown).toMatch(/Only publish rows marked `pass`/);
    expect(markdown).toMatch(/search_card_title_candidate:/);
    expect(markdown).toMatch(/search_card_proof_badge_candidate: Editorial: top pick/);
    expect(markdown).toMatch(/search_card_compact_candidate:/);
    expect(markdown).toMatch(/search_card_intro_candidate: A brightening serum for dullness\./);
  });

  test('compactCardIntroCandidate trims long copy to a card-friendly length', () => {
    const intro = compactCardIntroCandidate(
      'A serum that combines niacinamide, vitamin C, peach extract, hyaluronic acid, and polyglutamic acid to brighten, smooth, and hydrate skin in one pre-moisturizer step.',
      90,
    );

    expect(intro.length).toBeLessThanOrEqual(91);
    expect(intro.endsWith('…')).toBe(true);
  });

  test('displayPath keeps repo-local paths relative and leaves external paths absolute', () => {
    const rootDir = '/tmp/repo';

    expect(displayPath(rootDir, '/tmp/repo/reports/review.json')).toBe(
      path.join('reports', 'review.json'),
    );
    expect(displayPath(rootDir, '/tmp/outside/review.json')).toBe('/tmp/outside/review.json');
  });

  test('buildSearchCardCompactCandidate keeps compact card copy to a short noun phrase', () => {
    expect(
      buildSearchCardCompactCandidate({
        what_it_is: {
          headline: 'Color-correcting eye treatment stick',
          body: 'A targeted under-eye stick for dark-circle correction.',
        },
      }),
    ).toBe('Color-correcting eye stick');

    expect(
      buildSearchCardCompactCandidate({
        what_it_is: {
          headline: '',
          body: 'A daily moisturizer with broad-spectrum SPF 30 and niacinamide.',
        },
      }),
    ).toBe('SPF 30 moisturizer');

    expect(
      buildSearchCardCompactCandidate({
        what_it_is: {
          headline: 'Treatment serum',
          body: 'A serum that combines vitamin C, retinol, and niacinamide.',
        },
        why_it_stands_out: [{ headline: 'Multi-active formula' }],
      }),
    ).toBe('Multi-active serum');
  });

  test('buildSearchCardTitleCandidate keeps compact cards attribute-led and short', () => {
    expect(
      buildSearchCardTitleCandidate('Naturium', {
        what_it_is: {
          headline: 'Treatment serum',
          body: 'A multi-active treatment serum that combines vitamin C, retinol, niacinamide, and salicylic acid.',
        },
        why_it_stands_out: [{ headline: 'Multi-active formula' }],
      }),
    ).toBe('Naturium Multi-Active Serum');

    expect(
      buildSearchCardTitleCandidate('Fenty', {
        what_it_is: {
          headline: 'Moisturizer with SPF',
          body: 'A daily moisturizer with broad-spectrum SPF 30 and hydration support in one morning step.',
        },
        why_it_stands_out: [{ headline: 'Moisturizer and sunscreen in one step' }],
      }),
    ).toBe('Fenty SPF 30 Moisturizer');

    expect(
      buildSearchCardTitleCandidate('Olehenriksen', {
        what_it_is: {
          headline: 'Brightening moisturizer',
          body: 'A brightening moisturizer with vitamin C and niacinamide for dullness and uneven tone.',
        },
        why_it_stands_out: [{ headline: 'Vitamin C + niacinamide support' }],
      }),
    ).toBe('Olehenriksen Vitamin C + Niacinamide Brightening Cream');
  });
});
