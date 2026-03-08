const BaseSkill = require('./BaseSkill');

class TrackerCheckinLogSkill extends BaseSkill {
  constructor() {
    super('tracker.checkin_log', '1.0.0');
  }

  async checkPreconditions(request) {
    const diagnosisId = request.thread_state?.active_diagnosis_id;
    const routine = request.context?.current_routine;

    if (!diagnosisId && !routine) {
      return {
        met: false,
        failures: [
          {
            rule_id: 'pre_has_active_diagnosis_or_routine',
            reason: 'No active diagnosis or routine to bind check-in to',
            on_fail_target: 'diagnosis_v2.start',
            on_fail_message_en: 'Start a diagnosis or set up a routine to begin tracking.',
            on_fail_message_zh: '请先开始诊断或建立护肤流程，然后再打卡记录。',
          },
        ],
      };
    }
    return { met: true, failures: [] };
  }

  async execute(request, _llmGateway) {
    const { context, params, thread_state: threadState } = request;
    const checkinData = params?.checkin || {};

    const checkinEntry = {
      checkin_id: `checkin_${Date.now()}`,
      timestamp: new Date().toISOString(),
      text: checkinData.text || null,
      sensation_level: checkinData.sensation_level || null,
      has_photo: checkinData.has_photo || false,
      bound_diagnosis_id: threadState?.active_diagnosis_id || null,
      bound_routine_id: context.current_routine?.routine_id || null,
    };

    const sections = [
      {
        type: 'nudge_structured',
        title_en: 'Check-in logged!',
        title_zh: '打卡成功！',
        summary_en: this._buildSummary(checkinEntry, 'en'),
        summary_zh: this._buildSummary(checkinEntry, 'zh'),
      },
    ];

    const nextActions = [
      {
        action_type: 'show_chip',
        label: { en: 'View my progress', zh: '查看我的进展' },
        params: { navigate_to: 'tracker.checkin_insights' },
      },
    ];

    const totalCheckins = (context.recent_logs?.length || 0) + 1;
    if (totalCheckins >= 3) {
      nextActions.unshift({
        action_type: 'navigate_skill',
        target_skill_id: 'tracker.checkin_insights',
        label: { en: 'See trends & insights', zh: '查看趋势与洞察' },
      });
    }

    if (!checkinData.has_photo) {
      nextActions.push({
        action_type: 'trigger_photo',
        label: { en: 'Add a progress photo', zh: '添加进展照片' },
      });
    }

    return {
      cards: [{ card_type: 'nudge', sections }],
      ops: {
        thread_ops: [
          { op: 'append', key: 'checkin_log', value: checkinEntry },
        ],
        profile_patch: {},
        routine_patch: {},
        experiment_events: [
          {
            event: 'checkin_logged',
            has_text: !!checkinData.text,
            has_photo: !!checkinData.has_photo,
            sensation_level: checkinData.sensation_level,
          },
        ],
      },
      next_actions: nextActions,
      _taskMode: 'tracker',
      _llmCalls: 0,
    };
  }

  _buildSummary(entry, locale) {
    const parts = [];
    if (locale === 'zh') {
      if (entry.sensation_level != null) {
        const labels = { 1: '很好', 2: '还行', 3: '有些刺激' };
        parts.push(`肤感：${labels[entry.sensation_level] || entry.sensation_level}`);
      }
      if (entry.text) parts.push(`备注：${entry.text}`);
      if (entry.has_photo) parts.push('已附照片');
      return parts.join(' · ') || '已记录';
    }

    if (entry.sensation_level != null) {
      const labels = { 1: 'Great', 2: 'Okay', 3: 'Some irritation' };
      parts.push(`Feeling: ${labels[entry.sensation_level] || entry.sensation_level}`);
    }
    if (entry.text) parts.push(`Note: ${entry.text}`);
    if (entry.has_photo) parts.push('Photo attached');
    return parts.join(' · ') || 'Logged';
  }

  async validateOutput(response, request) {
    const baseResult = await super.validateOutput(response, request);
    const issues = [...baseResult.issues];

    const hasBinding = response.ops?.thread_ops?.some(
      (op) => op.key === 'checkin_log' && op.value?.bound_diagnosis_id || op.value?.bound_routine_id
    );

    if (!hasBinding) {
      issues.push({
        code: 'UNBOUND_CHECKIN',
        message: 'Check-in not bound to diagnosis_id or routine_id',
        severity: 'warning',
      });
    }

    return {
      quality_ok: issues.filter((i) => i.severity === 'error').length === 0,
      issues,
    };
  }
}

module.exports = TrackerCheckinLogSkill;
