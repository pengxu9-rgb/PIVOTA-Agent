const {
  buildHighlightSourcesSummary,
  buildDisplayableProofBadge,
  filterDisplayableMarketSignalBadges,
  filterSurfaceableExternalHighlightSignals,
  hasDisplayableBadgeEvidence,
  normalizeExternalHighlightSignals,
} = require('../src/services/pivotaEvidenceSignals');

describe('pivota evidence signals', () => {
  test('keeps verified review badges visible', () => {
    expect(
      buildDisplayableProofBadge(
        {
          review_summary: {
            rating: 4.8,
            review_count: 412,
          },
        },
        {
          formatCompactCount: (count) => String(count),
        },
      ),
    ).toEqual({
      badge_type: 'review_signal',
      badge_label: '4.8★ (412)',
      review_summary: {
        rating: 4.8,
        review_count: 412,
      },
    });
  });

  test('suppresses weak editorial and creator badges without metadata', () => {
    expect(
      filterDisplayableMarketSignalBadges(
        [
          {
            badge_type: 'editorial_signal',
            badge_label: 'Seen in 4 editor picks',
          },
          {
            badge_type: 'creator_signal',
            badge_label: 'Seen in 12 creator mentions',
          },
        ],
        {
          community_signals: {
            status: 'available',
            source_counts: {
              editorial: 4,
              creator_mentions: 12,
            },
          },
        },
      ),
    ).toEqual([]);
  });

  test('allows creator consensus badges only with explicit strong metadata', () => {
    expect(
      filterDisplayableMarketSignalBadges([
        {
          badge_type: 'creator_signal',
          badge_label: 'Seen across creator routines',
          source_type: 'creator_consensus',
          sponsorship_status: 'organic',
          evidence_strength: 'strong',
          independence_count: 3,
        },
      ]),
    ).toEqual([
      {
        badge_type: 'creator_signal',
        badge_label: 'Seen across creator routines',
        source_type: 'creator_consensus',
        sponsorship_status: 'organic',
        evidence_strength: 'strong',
        independence_count: 3,
      },
    ]);
  });

  test('requires visible evidence instead of raw mention counts', () => {
    expect(
      hasDisplayableBadgeEvidence({
        community_signals: {
          status: 'available',
          source_counts: {
            editorial: 6,
            creator_mentions: 15,
          },
        },
      }),
    ).toBe(false);
  });

  test('keeps editorial support in evidence pack but not as visible highlight', () => {
    const signals = normalizeExternalHighlightSignals([
      {
        signal_id: 'editorial_1',
        source_type: 'editorial_support',
        claim_type: 'standout',
        claim_text: 'Featured in an editor roundup for lightweight layering.',
        independence_count: 2,
        evidence_strength: 'moderate',
      },
    ]);

    expect(signals).toEqual([
      expect.objectContaining({
        signal_id: 'editorial_1',
        source_type: 'editorial_support',
        surfaceable: false,
      }),
    ]);
    expect(filterSurfaceableExternalHighlightSignals(signals)).toEqual([]);
  });

  test('allows creator consensus highlights when source metadata clears the wider highlight policy', () => {
    const signals = normalizeExternalHighlightSignals([
      {
        signal_id: 'creator_1',
        source_type: 'creator_social_consensus',
        claim_type: 'card_hook',
        claim_text: 'Creators repeatedly point to the cushioned gel-cream texture.',
        independence_count: 4,
        sponsorship_status: 'organic',
        evidence_strength: 'strong',
      },
    ]);

    expect(filterSurfaceableExternalHighlightSignals(signals, { surfaceTarget: 'shopping_card_highlight' })).toEqual([
      expect.objectContaining({
        signal_id: 'creator_1',
        surfaceable: true,
      }),
    ]);
    expect(buildHighlightSourcesSummary(signals)).toEqual([
      expect.objectContaining({
        signal_id: 'creator_1',
        source_type: 'creator_social_consensus',
        surfaceable: true,
      }),
    ]);
  });
});
