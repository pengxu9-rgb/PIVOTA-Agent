const {
  AGENT_PRODUCT_CONTEXT_CONTRACT_VERSION,
  QUALITY_LANES,
  assessPivotaInsightReplacement,
  buildAgentProductContext,
  buildPivotaInsightInventoryRow,
  classifyPivotaInsightQualityLane,
  ensureAgentContextOnBundle,
  hasCommerceTruthClaim,
  hashJson,
  stampReplacementProvenance,
  summarizePivotaInsightInventory,
} = require('../src/services/pivotaInsightsQuality');

function reviewedBundle(overrides = {}) {
  const qualityState = overrides.quality_state || 'reviewed';
  const evidenceProfile = overrides.evidence_profile || 'seller_plus_formula';
  const highlight = overrides.highlight === undefined ? 'Mineral SPF' : overrides.highlight;
  const bundle = {
    contract_version: 'pivota.product_intel.v1',
    quality_state: qualityState,
    evidence_profile: evidenceProfile,
    canonical_product_ref: {
      merchant_id: 'external_seed',
      product_id: 'ext_quality_case',
    },
    product_intel_core: {
      quality_state: qualityState,
      evidence_profile: evidenceProfile,
      what_it_is: {
        headline: 'Tinted mineral sunscreen',
        body: 'A zinc oxide mineral sunscreen with a fluid tint and daily SPF coverage.',
      },
      why_it_stands_out: [
        {
          headline: 'Zinc oxide protection',
          body: 'Uses zinc oxide for daily mineral UV protection.',
        },
      ],
      best_for: [{ label: 'Mineral SPF', tag: 'spf', confidence: 'moderate' }],
      watchouts: [{ body: 'Patch test before daily use.' }],
      ...(overrides.product_intel_core || {}),
    },
    shopping_card: {
      title: 'Daily Mineral Sunscreen',
      subtitle: 'Tinted Mineral Sunscreen',
      ...(highlight ? { highlight } : {}),
    },
    search_card: {
      title_candidate: 'Daily Mineral Sunscreen',
      compact_candidate: 'Tinted Mineral Sunscreen',
      ...(highlight ? { highlight_candidate: highlight } : {}),
    },
    provenance: {
      review_status: 'completed',
      review_decision: 'rewrite',
      reviewer: 'Human QA',
      reviewer_kind: 'human',
      review_tier: 'strict_human',
      ...(overrides.provenance || {}),
    },
    ...overrides,
  };
  return bundle;
}

function kbRow(productId, bundle) {
  return {
    kb_key: `product:${productId}`,
    analysis: { product_intel_v1: bundle },
    source: 'aurora_product_intel_kb',
    source_meta: {},
  };
}

describe('pivota insights quality lanes', () => {
  test('keeps protected high-quality content', () => {
    const lane = classifyPivotaInsightQualityLane(
      kbRow('ext_quality_case', reviewedBundle({ quality_state: 'verified' })),
    );

    expect(lane.lane).toBe(QUALITY_LANES.KEEP);
    expect(lane.protected).toBe(true);
    expect(lane.public_ready).toBe(true);
  });

  test('marks reviewed seller-only content as agent-readable but not public-quality-ready', () => {
    const lane = classifyPivotaInsightQualityLane(
      kbRow(
        'ext_quality_case',
        reviewedBundle({
          quality_state: 'reviewed',
          evidence_profile: 'seller_only',
        }),
      ),
    );

    expect(lane.lane).toBe(QUALITY_LANES.SUPPRESS_PUBLIC);
    expect(lane.agent_readable).toBe(true);
    expect(lane.public_ready).toBe(false);
    expect(lane.issues).toContain('seller_only_evidence');
  });

  test('routes reviewed displayable bundles with fixable card gaps to repair', () => {
    const lane = classifyPivotaInsightQualityLane(
      kbRow('ext_quality_case', reviewedBundle({ highlight: '' })),
    );

    expect(lane.lane).toBe(QUALITY_LANES.REPAIR);
    expect(lane.blocking_issues).toContain('missing_card_highlight');
  });

  test('holds missing KB without source evidence but regenerates when source exists', () => {
    expect(classifyPivotaInsightQualityLane(null).lane).toBe(QUALITY_LANES.HOLD_FOR_EVIDENCE);
    expect(classifyPivotaInsightQualityLane(null, { canonicalUrl: 'https://brand.example/p/1' }).lane).toBe(
      QUALITY_LANES.REGENERATE,
    );
  });

  test('summarizes inventory rows by lane and issue', () => {
    const rows = [
      buildPivotaInsightInventoryRow(
        kbRow('ext_keep', reviewedBundle({ quality_state: 'verified' })),
      ),
      buildPivotaInsightInventoryRow(kbRow('ext_repair', reviewedBundle({ highlight: '' }))),
    ];
    const summary = summarizePivotaInsightInventory(rows);

    expect(summary.scanned).toBe(2);
    expect(summary.lanes).toEqual(
      expect.arrayContaining([
        { key: QUALITY_LANES.KEEP, count: 1 },
        { key: QUALITY_LANES.REPAIR, count: 1 },
      ]),
    );
    expect(summary.blocking_issues).toEqual(
      expect.arrayContaining([{ key: 'missing_card_highlight', count: 1 }]),
    );
  });
});

describe('pivota insights agent context and replacement guard', () => {
  test('builds agent context without commerce-truth fallbacks', () => {
    const context = buildAgentProductContext(reviewedBundle());

    expect(context.contract_version).toBe(AGENT_PRODUCT_CONTEXT_CONTRACT_VERSION);
    expect(context.facts.what_it_is).toContain('zinc oxide');
    expect(context.guardrails.no_price_or_availability_claims).toBe(true);
    expect(context.guardrails.commerce_truth_source).toBe('commerce_mainline_only');
  });

  test('flags commerce-truth claims embedded in product intel copy', () => {
    const bundle = reviewedBundle({
      shopping_card: {
        title: 'Daily Mineral Sunscreen',
        subtitle: 'Tinted Mineral Sunscreen',
        highlight: '$29 and in stock',
      },
    });

    expect(hasCommerceTruthClaim(bundle)).toBe(true);
    expect(classifyPivotaInsightQualityLane(kbRow('ext_quality_case', bundle)).lane).toBe(
      QUALITY_LANES.REPAIR,
    );

    expect(
      hasCommerceTruthClaim(
        reviewedBundle({
          product_intel_core: {
            what_it_is: {
              body: 'A palette listed on the official source page as Rosy Eyeshadow Palette (100% off).',
            },
          },
        }),
      ),
    ).toBe(true);
    expect(
      hasCommerceTruthClaim(
        reviewedBundle({
          product_intel_core: {
            what_it_is: {
              body: 'A customizable eye trio. Save 20% with this kit.',
            },
          },
        }),
      ),
    ).toBe(true);
    expect(
      hasCommerceTruthClaim(
        reviewedBundle({
          product_intel_core: {
            what_it_is: {
              body: 'A toner described with 5% glycolic acid in the official ingredient context.',
            },
          },
        }),
      ),
    ).toBe(false);
  });

  test('preserves existing agent context when present', () => {
    const bundle = reviewedBundle({
      agent_context: {
        contract_version: AGENT_PRODUCT_CONTEXT_CONTRACT_VERSION,
        custom: true,
      },
    });

    expect(ensureAgentContextOnBundle(bundle).agent_context.custom).toBe(true);
  });

  test('blocks replacement of protected content without explicit human approval', () => {
    const existingEntry = kbRow('ext_quality_case', reviewedBundle({ quality_state: 'verified' }));
    const candidateEntry = kbRow('ext_quality_case', reviewedBundle({ quality_state: 'reviewed' }));

    const assessment = assessPivotaInsightReplacement({ existingEntry, candidateEntry });

    expect(assessment.allowed).toBe(false);
    expect(assessment.reason).toBe(
      'protected_existing_bundle_requires_explicit_human_replacement_review',
    );
  });

  test('allows explicit human-reviewed replacement and records previous hash', () => {
    const existingBundle = reviewedBundle({ quality_state: 'verified' });
    const existingEntry = {
      ...kbRow('ext_quality_case', existingBundle),
      source: 'aurora_product_intel_kb',
      source_meta: { review_batch: 'previous_good_batch' },
    };
    const candidateEntry = kbRow('ext_quality_case', reviewedBundle({ quality_state: 'reviewed' }));

    const assessment = assessPivotaInsightReplacement({
      existingEntry,
      candidateEntry,
      sourceRow: {
        quality_improvement_review: {
          decision: 'approved_replacement',
          reviewer_kind: 'human',
          reason: 'Candidate has fresher official PDP evidence and preserves all required fields.',
        },
      },
    });
    const stamped = stampReplacementProvenance(candidateEntry, assessment);

    expect(assessment.allowed).toBe(true);
    expect(assessment.previous_bundle_hash).toBe(hashJson(existingBundle));
    expect(stamped.source_meta.quality_improvement.previous_bundle_hash).toBe(hashJson(existingBundle));
    expect(stamped.source_meta.quality_improvement.previous_source).toBe('aurora_product_intel_kb');
    expect(stamped.source_meta.quality_improvement.previous_source_meta.review_batch).toBe(
      'previous_good_batch',
    );
    expect(stamped.analysis.product_intel_v1.provenance.quality_improvement.existing_quality_lane).toBe(
      QUALITY_LANES.KEEP,
    );
  });

  test('allows explicit owner-delegated assistant replacement without human-labeling it', () => {
    const existingBundle = reviewedBundle({ quality_state: 'verified' });
    const existingEntry = kbRow('ext_quality_case', existingBundle);
    const candidateEntry = kbRow('ext_quality_case', reviewedBundle({ quality_state: 'reviewed' }));

    const assessment = assessPivotaInsightReplacement({
      existingEntry,
      candidateEntry,
      sourceRow: {
        quality_improvement_review: {
          decision: 'approved_replacement',
          reviewer_kind: 'assistant',
          owner_delegated: true,
          reason: 'Owner delegated assistant review confirms the replacement fixes generic copy without field loss.',
        },
      },
    });

    expect(assessment.allowed).toBe(true);
    expect(assessment.replacement_review).toEqual(
      expect.objectContaining({
        approval_kind: 'owner_delegated_assistant',
        reviewer_kind: 'assistant',
        owner_delegated: true,
      }),
    );
  });

  test('blocks candidate bundles that are not publish-quality-ready', () => {
    const assessment = assessPivotaInsightReplacement({
      candidateEntry: kbRow('ext_quality_case', reviewedBundle({ highlight: '' })),
    });

    expect(assessment.allowed).toBe(false);
    expect(assessment.reason).toBe('candidate_not_publish_quality_ready');
    expect(assessment.candidate.blocking_issues).toContain('missing_card_highlight');
  });

  test('blocks candidate bundles that contain price or availability claims', () => {
    const assessment = assessPivotaInsightReplacement({
      candidateEntry: kbRow(
        'ext_quality_case',
        reviewedBundle({
          product_intel_core: {
            what_it_is: {
              headline: 'Tinted mineral sunscreen',
              body: 'A zinc oxide mineral sunscreen that is in stock for checkout today.',
            },
            why_it_stands_out: [
              {
                headline: 'Zinc oxide protection',
                body: 'Uses zinc oxide for daily mineral UV protection.',
              },
            ],
            best_for: [{ label: 'Mineral SPF', tag: 'spf', confidence: 'moderate' }],
            watchouts: [{ body: 'Patch test before daily use.' }],
          },
        }),
      ),
    });

    expect(assessment.allowed).toBe(false);
    expect(assessment.reason).toBe('candidate_not_publish_quality_ready');
    expect(assessment.candidate.blocking_issues).toContain('commerce_truth_claim');
  });
});
