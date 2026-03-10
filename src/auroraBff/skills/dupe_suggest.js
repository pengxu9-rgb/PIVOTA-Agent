const BaseSkill = require('./BaseSkill');
const {
  buildAnchorIdentity,
  buildAnchorFingerprint,
  deduplicateCandidates,
  detectSelfReference,
  detectUrlAsName,
  filterSelfReferences,
  getCandidateIdentity,
  normalizeBrand,
  sanitizeCandidates,
} = require('./dupe_utils');

const MIN_DISPLAY_COUNT = 2;
const VALID_BUCKETS = new Set([
  'dupe',
  'cheaper_alternative',
  'premium_alternative',
  'price_unknown_alternative',
  'functional_alternative',
]);

const LIMITED_STATE_NEXT_ACTIONS = [
  {
    action_type: 'request_input',
    label: { en: 'Enter a more specific product name', zh: '输入更具体的产品名称' },
  },
  {
    action_type: 'show_chip',
    label: { en: 'Expand matching range', zh: '扩大匹配范围' },
  },
  {
    action_type: 'show_chip',
    label: { en: 'Try functional alternatives', zh: '尝试功能型替代品' },
  },
];

class DupeSuggestSkill extends BaseSkill {
  constructor() {
    super('dupe.suggest', '2.0.0');
  }

  async checkPreconditions(request) {
    const failures = [];

    if (!request.params?.product_anchor) {
      failures.push({
        rule_id: 'pre_has_anchor_product',
        reason: 'No anchor product provided',
        on_fail_message_en: 'Please share a product link or name so I can find alternatives.',
        on_fail_message_zh: '请粘贴产品链接或输入品牌+产品名，我来帮你找替代品。',
      });
    }

    const candidatePool = request.params?._candidate_pool;
    if (request.params?.product_anchor && (!candidatePool || candidatePool.length === 0)) {
      failures.push({
        rule_id: 'pre_has_candidate_pool',
        reason: 'Candidate pool is empty',
        on_fail_message_en: "I couldn't find alternatives for this product in our database.",
        on_fail_message_zh: '在数据库中没有找到该产品的替代品。',
      });
    }

    return { met: failures.length === 0, failures };
  }

  async execute(request, llmGateway) {
    const { context, params } = request;
    const anchor = params.product_anchor;
    const candidatePool = params._candidate_pool || [];
    const anchorIdentity = buildAnchorIdentity(anchor);
    const anchorFingerprint = buildAnchorFingerprint(anchor);

    const llmResult = await llmGateway.call({
      templateId: 'dupe_suggest',
      taskMode: 'dupe',
      params: {
        anchor_identity: anchorIdentity,
        anchor_fingerprint: anchorFingerprint,
        candidates: candidatePool,
        profile: context.profile,
        locale: context.locale || 'en',
      },
      schema: 'DupeSuggestOutput',
    });

    const result = llmResult.parsed || {};
    const rawCandidates = Array.isArray(result.candidates) ? result.candidates : [];

    const { sanitized: sanitizedCandidates, issues: sanitizeIssues } = sanitizeCandidates(rawCandidates);
    const filterResult = filterSelfReferences(sanitizedCandidates, anchor);
    const { kept: filteredCandidates, stats: filterStats } = filterResult;
    const { deduplicated, duplicateIssues } = deduplicateCandidates(filteredCandidates);
    const pipelineIssues = [...sanitizeIssues, ...duplicateIssues];

    const qualityCheck = this._checkQualityThresholds(deduplicated, anchor);
    if (qualityCheck.isLimitedState) {
      return this._buildLimitedState({
        anchorSummary: result.anchor_summary,
        reason: qualityCheck.reason,
        promptHash: llmResult.promptHash,
        filterStats,
        pipelineIssues,
      });
    }

    const enriched = this._enrichCandidates(deduplicated, anchorIdentity);
    const buckets = this._bucketCandidates(enriched);
    const allKept = this._collectAllCandidates(buckets);
    const firstCandidateIdentity = getCandidateIdentity(allKept[0]);

    return {
      cards: [
        {
          card_type: 'product_verdict',
          sections: [
            {
              type: 'product_verdict_structured',
              anchor_product: result.anchor_summary || {},
              dupe: buckets.dupe,
              cheaper_alternative: buckets.cheaper_alternative,
              premium_alternative: buckets.premium_alternative,
              price_unknown_alternative: buckets.price_unknown_alternative,
              functional_alternative: buckets.functional_alternative,
              total_candidates: allKept.length,
            },
          ],
        },
      ],
      ops: {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {},
        experiment_events: [
          {
            event: 'dupe_suggest_shown',
            anchor: params.product_anchor,
            candidate_count: allKept.length,
          },
        ],
      },
      next_actions: [
        {
          action_type: 'navigate_skill',
          target_skill_id: 'dupe.compare',
          label: { en: 'Compare in detail', zh: '详细对比' },
          params: {
            product_anchor: params.product_anchor,
            comparison_targets: allKept.slice(0, 3),
          },
        },
        {
          action_type: 'navigate_skill',
          target_skill_id: 'product.analyze',
          label: { en: 'Analyze a candidate', zh: '分析候选产品' },
          params: firstCandidateIdentity?.name
            ? {
                product_anchor: {
                  brand: firstCandidateIdentity.brand,
                  name: firstCandidateIdentity.name,
                  product_id: firstCandidateIdentity.product_id,
                  url: firstCandidateIdentity.url,
                },
              }
            : {},
        },
      ],
      _promptHash: llmResult.promptHash,
      _taskMode: 'dupe',
      _llmCalls: 1,
    };
  }

  _enrichCandidates(candidates, anchorIdentity) {
    const anchorBrand = normalizeBrand(anchorIdentity?.brand);
    return candidates.map((candidate) => {
      const identity = getCandidateIdentity(candidate);
      const candidateBrand = normalizeBrand(identity.brand);
      if (anchorBrand && candidateBrand && anchorBrand === candidateBrand && !candidate.why_not_the_same_product) {
        return {
          ...candidate,
          why_not_the_same_product: 'Same brand but different product line (auto-flagged: review needed)',
        };
      }
      return candidate;
    });
  }

  _bucketCandidates(candidates) {
    const buckets = {
      dupe: [],
      cheaper_alternative: [],
      premium_alternative: [],
      price_unknown_alternative: [],
      functional_alternative: [],
    };

    for (const candidate of candidates) {
      if (candidate.confidence === 0) continue;
      const bucket = this._mapLegacyBucket(candidate.bucket || candidate.price_comparison || 'price_unknown_alternative');
      buckets[bucket].push({
        ...candidate,
        bucket,
      });
    }

    return buckets;
  }

  _mapLegacyBucket(bucket) {
    if (VALID_BUCKETS.has(bucket)) return bucket;
    const legacyMap = {
      same_price: 'dupe',
      cheaper: 'cheaper_alternative',
      more_expensive: 'premium_alternative',
      unknown_price: 'price_unknown_alternative',
      similar: 'functional_alternative',
      premium: 'premium_alternative',
    };
    return legacyMap[bucket] || 'price_unknown_alternative';
  }

  _collectAllCandidates(buckets) {
    return [
      ...buckets.dupe,
      ...buckets.cheaper_alternative,
      ...buckets.premium_alternative,
      ...buckets.price_unknown_alternative,
      ...buckets.functional_alternative,
    ];
  }

  _checkQualityThresholds(candidates, anchor) {
    if (!anchor) {
      return { isLimitedState: true, reason: 'Anchor product missing' };
    }
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { isLimitedState: true, reason: 'No candidates available after filtering' };
    }

    const allZeroConfidence = candidates.every((candidate) => {
      const confidence = Number(candidate.confidence);
      return !Number.isFinite(confidence) || confidence === 0;
    });
    if (allZeroConfidence) {
      return { isLimitedState: true, reason: 'All candidates have zero confidence' };
    }

    const allHollow = candidates.every((candidate) => {
      const noDifferences = !Array.isArray(candidate.key_differences) || candidate.key_differences.length === 0;
      const noTradeoff = !candidate.tradeoff && (!Array.isArray(candidate.tradeoffs) || candidate.tradeoffs.length === 0);
      const confidence = Number(candidate.confidence);
      return noDifferences && noTradeoff && (!Number.isFinite(confidence) || confidence === 0);
    });
    if (allHollow) {
      return { isLimitedState: true, reason: 'All candidates lack differences, tradeoffs, and confidence' };
    }

    if (candidates.length < MIN_DISPLAY_COUNT) {
      const viable = candidates.filter((candidate) => {
        const confidence = Number(candidate.confidence);
        return Number.isFinite(confidence) && confidence > 0;
      });
      if (viable.length === 0) {
        return { isLimitedState: true, reason: 'Insufficient viable candidates after filtering' };
      }
    }

    return { isLimitedState: false, reason: null };
  }

  _buildLimitedState({ anchorSummary, reason, promptHash, filterStats, pipelineIssues }) {
    return {
      cards: [
        {
          card_type: 'product_verdict',
          sections: [
            {
              type: 'product_verdict_structured',
              anchor_product: anchorSummary || {},
              dupe: [],
              cheaper_alternative: [],
              premium_alternative: [],
              price_unknown_alternative: [],
              functional_alternative: [],
              total_candidates: 0,
              limited_state: true,
              limited_state_reason: reason,
            },
          ],
        },
      ],
      ops: {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {},
        experiment_events: [
          {
            event: 'dupe_suggest_limited_state',
            reason,
          },
        ],
      },
      next_actions: LIMITED_STATE_NEXT_ACTIONS,
      _promptHash: promptHash,
      _taskMode: 'dupe',
      _llmCalls: 1,
      _meta: {
        quality_ok: false,
        quality_issues: [
          { code: 'INSUFFICIENT_CANDIDATES', message: reason, severity: 'warning' },
          ...pipelineIssues,
        ],
        ...filterStats,
      },
    };
  }

  async validateOutput(response, request) {
    const baseResult = await super.validateOutput(response, request);
    const issues = [...baseResult.issues];
    const anchor = request.params?.product_anchor;

    if (!anchor) {
      return {
        quality_ok: false,
        issues: [
          ...issues,
          {
            code: 'NO_ANCHOR',
            message: 'Anchor missing at validation',
            severity: 'error',
          },
        ],
      };
    }

    const anchorIdentity = buildAnchorIdentity(anchor);
    const anchorFingerprint = buildAnchorFingerprint(anchor);
    let removedInValidation = 0;

    for (const card of response.cards || []) {
      for (const section of card.sections || []) {
        if (section.type !== 'product_verdict_structured') continue;
        if (section.limited_state) continue;

        const bucketKeys = [
          'dupe',
          'cheaper_alternative',
          'premium_alternative',
          'price_unknown_alternative',
          'functional_alternative',
        ];
        let totalRemaining = 0;

        for (const key of bucketKeys) {
          if (!Array.isArray(section[key])) continue;
          const cleaned = [];
          for (const candidate of section[key]) {
            const detection = detectSelfReference(candidate, anchorIdentity, anchorFingerprint);
            if (detection.isSelfRef) {
              removedInValidation += 1;
              const identity = getCandidateIdentity(candidate);
              issues.push({
                code: 'SELF_REFERENCE_CANDIDATE_FOUND',
                message: `Validation caught self-ref: "${identity.brand || 'unknown'} - ${identity.name || 'unknown'}" (${detection.reason})`,
                severity: 'error',
              });
              continue;
            }
            cleaned.push(candidate);
          }
          section[key] = cleaned;
          totalRemaining += cleaned.length;
        }

        if (removedInValidation > 0) {
          issues.push({
            code: 'SELF_REFERENCE_CANDIDATES_DROPPED',
            message: `${removedInValidation} self-reference candidate(s) removed during validation`,
            severity: 'warning',
          });
          section.total_candidates = totalRemaining;
        }

        if (section.total_candidates === 0 && !section.limited_state) {
          issues.push({
            code: 'EMPTY_CANDIDATE_POOL',
            message: 'No candidates remaining after validation; converting to limited-state',
            severity: 'error',
          });
          section.limited_state = true;
          section.limited_state_reason = 'All candidates removed during validation';
          response.next_actions = LIMITED_STATE_NEXT_ACTIONS;
        }

        const allCandidates = bucketKeys.flatMap((key) => section[key] || []);
        const seen = new Map();

        for (const candidate of allCandidates) {
          const identity = getCandidateIdentity(candidate);
          const duplicateKey = `${normalizeBrand(identity.brand)}::${String(identity.name || '').toLowerCase()}`;
          if (seen.has(duplicateKey)) {
            issues.push({
              code: 'DUPLICATE_IDENTITY_CANDIDATES',
              message: `Duplicate candidate identity: "${identity.brand || 'unknown'} - ${identity.name || 'unknown'}"`,
              severity: 'warning',
            });
          } else {
            seen.set(duplicateKey, true);
          }
        }

        for (const candidate of allCandidates) {
          const identity = getCandidateIdentity(candidate);
          const detectedUrlName = detectUrlAsName(identity.name);
          if (detectedUrlName.isUrlName) {
            issues.push({
              code: 'NAME_IS_URL',
              message: `Candidate name is a URL instead of a product name: "${identity.name}"`,
              severity: 'error',
            });
          }
          if (!Array.isArray(candidate.key_differences) || candidate.key_differences.length === 0) {
            issues.push({
              code: 'MISSING_DIFFERENCES',
              message: `Candidate ${identity.name || 'unknown'} missing key_differences[]`,
              severity: 'error',
            });
          }
          if (!candidate.tradeoff && (!Array.isArray(candidate.tradeoffs) || candidate.tradeoffs.length === 0)) {
            issues.push({
              code: 'MISSING_TRADEOFFS',
              message: `Candidate ${identity.name || 'unknown'} missing tradeoff`,
              severity: 'error',
            });
          }
          if (!candidate.bucket || !VALID_BUCKETS.has(candidate.bucket)) {
            issues.push({
              code: 'INVALID_BUCKET',
              message: `Candidate ${identity.name || 'unknown'} has invalid bucket: "${candidate.bucket}"`,
              severity: 'warning',
            });
          }
          if (candidate.confidence == null) {
            issues.push({
              code: 'MISSING_CONFIDENCE',
              message: `Candidate ${identity.name || 'unknown'} missing confidence`,
              severity: 'warning',
            });
          }

          const candidateBrand = normalizeBrand(identity.brand);
          const anchorBrand = anchorFingerprint.brand_norm;
          if (candidateBrand && anchorBrand && candidateBrand === anchorBrand && !candidate.why_not_the_same_product) {
            issues.push({
              code: 'MISSING_SAME_BRAND_JUSTIFICATION',
              message: `Same-brand candidate "${identity.brand || 'unknown'} - ${identity.name || 'unknown'}" missing why_not_the_same_product`,
              severity: 'warning',
            });
          }
        }
      }
    }

    return {
      quality_ok: issues.filter((issue) => issue.severity === 'error').length === 0,
      issues,
    };
  }
}

module.exports = DupeSuggestSkill;
