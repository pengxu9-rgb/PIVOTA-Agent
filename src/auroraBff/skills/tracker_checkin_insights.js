const BaseSkill = require('./BaseSkill');

class TrackerCheckinInsightsSkill extends BaseSkill {
  constructor() {
    super('tracker.checkin_insights', '1.0.0');
  }

  async checkPreconditions(request) {
    const logs = request.context?.recent_logs || [];
    if (logs.length < 3) {
      return {
        met: false,
        failures: [
          {
            rule_id: 'pre_has_checkin_history',
            reason: `Only ${logs.length} check-ins; need at least 3`,
            on_fail_target: 'tracker.checkin_log',
            on_fail_message_en: 'Log at least 3 check-ins before we can show trends.',
            on_fail_message_zh: '至少记录 3 次打卡后才能查看趋势分析。',
          },
        ],
      };
    }
    return { met: true, failures: [] };
  }

  async execute(request, llmGateway) {
    const { context } = request;
    const logs = context.recent_logs || [];
    const hasPhotos = logs.some((l) => l.has_photo);

    const llmResult = await llmGateway.call({
      templateId: 'tracker_checkin_insights',
      taskMode: 'tracker',
      params: {
        checkin_logs: logs,
        profile: context.profile,
        routine: context.current_routine,
        has_photo: hasPhotos,
        locale: context.locale || 'en',
      },
      schema: 'CheckinInsightsOutput',
    });

    const insights = llmResult.parsed;

    const sections = [
      {
        type: 'nudge_structured',
        title_en: 'Your Skin Progress',
        title_zh: '你的肌肤进展',
        trend_summary: insights.trend_summary,
        sensation_trend: insights.sensation_trend,
        total_checkins: logs.length,
        days_tracked: insights.days_tracked,
      },
    ];

    if (insights.attribution) {
      sections.push({
        type: 'attribution_analysis',
        likely_positive: insights.attribution.likely_positive,
        likely_negative: insights.attribution.likely_negative,
        uncertain: insights.attribution.uncertain,
      });
    }

    const cards = [{ card_type: 'nudge', sections }];

    if (insights.detailed_review) {
      cards.push({
        card_type: 'effect_review',
        sections: [
          {
            type: 'effect_review_structured',
            ...insights.detailed_review,
          },
        ],
      });
    }

    const nextActions = [];

    if (insights.suggested_action === 'escalate') {
      sections.push({
        type: 'safety_escalation',
        message_en: 'Your recent check-ins suggest symptoms that may benefit from professional evaluation. Please consider pausing strong actives and consulting a dermatologist or medical professional.',
        message_zh: '你最近的打卡记录显示可能需要专业评估的症状。建议暂停强功效成分，并咨询皮肤科医生或医疗专业人士。',
      });
      nextActions.push({
        action_type: 'show_chip',
        label: { en: 'Pause strong actives', zh: '暂停强功效成分' },
      });
    } else {
      if (insights.suggested_action === 'optimize') {
        nextActions.push({
          action_type: 'navigate_skill',
          target_skill_id: 'routine.audit_optimize',
          label: { en: 'Optimize my routine', zh: '优化我的护肤流程' },
        });
      }

      if (insights.suggested_action === 'dupe') {
        nextActions.push({
          action_type: 'navigate_skill',
          target_skill_id: 'dupe.suggest',
          label: { en: 'Find alternatives', zh: '寻找替代品' },
        });
      }

      if (!hasPhotos) {
        nextActions.push({
          action_type: 'trigger_photo',
          label: { en: 'Add a progress photo', zh: '添加进展照片' },
        });
      }

      nextActions.push({
        action_type: 'navigate_skill',
        target_skill_id: 'tracker.checkin_log',
        label: { en: 'Log another check-in', zh: '继续打卡' },
      });
    }

    return {
      cards,
      ops: {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {},
        experiment_events: [
          {
            event: 'insights_viewed',
            total_checkins: logs.length,
            suggested_action: insights.suggested_action,
          },
        ],
      },
      next_actions: nextActions,
      _promptHash: llmResult.promptHash,
      _taskMode: 'tracker',
      _llmCalls: 1,
    };
  }

  async validateOutput(response, request) {
    const baseResult = await super.validateOutput(response, request);
    const issues = [...baseResult.issues];
    const hasPhotos = request.context?.recent_logs?.some((l) => l.has_photo);

    if (!hasPhotos) {
      for (const card of response.cards || []) {
        for (const section of card.sections || []) {
          const text = JSON.stringify(section).toLowerCase();
          const visualTerms = ['visible improvement', 'can see', 'looks like', 'photo shows', '可见改善', '看起来'];
          for (const term of visualTerms) {
            if (text.includes(term)) {
              issues.push({
                code: 'NO_PHOTO_VISUAL_REF',
                message: `References visual observation "${term}" but no photos in check-in history`,
                severity: 'error',
              });
            }
          }
        }
      }
    }

    return {
      quality_ok: issues.filter((i) => i.severity === 'error').length === 0,
      issues,
    };
  }
}

module.exports = TrackerCheckinInsightsSkill;
