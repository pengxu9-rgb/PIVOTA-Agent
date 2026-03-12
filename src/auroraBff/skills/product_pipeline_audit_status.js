const BaseSkill = require('./BaseSkill');
const { getExternalSeedPipelineStatus } = require('../../services/externalSeedPipelineStatus');

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function resolveProductUrl(params = {}) {
  const direct = normalizeNonEmptyString(params.product_url || params.productUrl);
  if (direct) return direct;
  const anchor = params.product_anchor;
  if (typeof anchor === 'string') return normalizeNonEmptyString(anchor);
  if (anchor && typeof anchor === 'object') {
    return normalizeNonEmptyString(anchor.url || anchor.product_url || anchor.canonical_url);
  }
  return '';
}

class ProductPipelineAuditStatusSkill extends BaseSkill {
  constructor() {
    super('product.pipeline.audit_status', '1.0.0');
  }

  async checkPreconditions(request) {
    const params = request.params || {};
    const externalSeedId = normalizeNonEmptyString(params.external_seed_id || params.externalSeedId);
    const productUrl = resolveProductUrl(params);

    if (!externalSeedId && !productUrl) {
      return {
        met: false,
        failures: [
          {
            rule_id: 'pre_has_product_url_or_seed_id',
            reason: 'No external seed id or product URL provided',
            on_fail_message_en: 'Share an external seed id or product URL so I can inspect pipeline status.',
            on_fail_message_zh: '请提供 external seed id 或产品链接，我才能查看这条管线状态。',
          },
        ],
      };
    }

    return { met: true, failures: [] };
  }

  async execute(request) {
    const params = request.params || {};
    const externalSeedId = normalizeNonEmptyString(params.external_seed_id || params.externalSeedId);
    const productUrl = resolveProductUrl(params);
    const status = params.audit_status_snapshot || (await getExternalSeedPipelineStatus({ externalSeedId, productUrl }));

    if (!status) {
      return {
        cards: [
          {
            card_type: 'text_response',
            sections: [
              {
                type: 'text_answer',
                text_en: 'I could not find a matching external seed for that product reference.',
                text_zh: '我没有找到对应的 external seed 记录。',
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
              event: 'product_pipeline_audit_status_missing',
              external_seed_id: externalSeedId || null,
              product_url: productUrl || null,
            },
          ],
        },
        next_actions: [
          {
            action_type: 'request_input',
            label: {
              en: 'Share another product URL',
              zh: '换一个产品链接',
            },
          },
        ],
        _taskMode: 'product_pipeline_status',
        _llmCalls: 0,
      };
    }

    const blockerCount = Number(status.audit_summary?.by_severity?.blocker || 0);
    const reviewCount = Number(status.audit_summary?.by_severity?.review || 0);
    const coverage = status.coverage || {};
    const gating = status.gating || {};
    const diagnostics = status.seed?.diagnostics || {};
    const seedTitle = normalizeNonEmptyString(status.seed?.title || 'Unknown Product');
    const seedUrl = normalizeNonEmptyString(status.seed?.canonical_url);
    const summaryEn =
      blockerCount > 0
        ? `${seedTitle} is currently blocked in the pipeline: ${blockerCount} blocker finding(s), ${reviewCount} review finding(s), and ingredient coverage status ${coverage.ingredient_coverage_status || 'unknown'}.`
        : `${seedTitle} is not blocked. Review findings: ${reviewCount}. Ingredient coverage is ${coverage.ingredient_coverage_status || 'unknown'} and KB coverage is ${coverage.kb_coverage_status || 'unknown'}.`;
    const summaryZh =
      blockerCount > 0
        ? `${seedTitle} 当前在管线中被阻断：${blockerCount} 条 blocker，${reviewCount} 条 review，ingredient 覆盖状态为 ${coverage.ingredient_coverage_status || 'unknown'}。`
        : `${seedTitle} 当前没有 blocker。Review 异常 ${reviewCount} 条；ingredient 覆盖是 ${coverage.ingredient_coverage_status || 'unknown'}，KB 覆盖是 ${coverage.kb_coverage_status || 'unknown'}。`;

    return {
      cards: [
        {
          card_type: 'text_response',
          sections: [
            {
              type: 'text_answer',
              text_en: summaryEn,
              text_zh: summaryZh,
            },
            {
              type: 'pipeline_audit_status',
              seed: status.seed,
              audit_summary: status.audit_summary,
              coverage: status.coverage,
              gating: status.gating,
              findings: status.audit?.findings || [],
              diagnostics: {
                failure_category: diagnostics.failure_category || null,
                discovery_strategy: diagnostics.discovery_strategy || null,
              },
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
            event: 'product_pipeline_audit_status_viewed',
            external_seed_id: status.seed?.id || null,
            product_url: seedUrl || productUrl || null,
            audit_status: gating.audit_status || null,
            kb_coverage_status: coverage.kb_coverage_status || null,
          },
        ],
      },
      next_actions: [
        {
          action_type: 'navigate_skill',
          target_skill_id: 'product.analyze',
          label: {
            en: 'Analyze this product',
            zh: '分析这个产品',
          },
          params: seedUrl ? { product_anchor: { url: seedUrl } } : undefined,
        },
        {
          action_type: 'navigate_skill',
          target_skill_id: 'ingredient.report',
          label: {
            en: 'Inspect ingredient science',
            zh: '查看成分分析',
          },
        },
      ],
      _taskMode: 'product_pipeline_status',
      _llmCalls: 0,
    };
  }
}

module.exports = ProductPipelineAuditStatusSkill;
