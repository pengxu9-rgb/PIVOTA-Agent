const BaseSkill = require('./BaseSkill');

class DiagnosisStartSkill extends BaseSkill {
  constructor() {
    super('diagnosis_v2.start', '1.0.0');
  }

  async execute(request, llmGateway) {
    const locale = request.context?.locale || 'en';
    const profile = request.context?.profile || {};

    const goalOptions = [
      { id: 'acne', label_en: 'Clear acne & breakouts', label_zh: '祛痘控油' },
      { id: 'anti_aging', label_en: 'Anti-aging & firmness', label_zh: '抗老紧致' },
      { id: 'brightening', label_en: 'Brighten & even tone', label_zh: '提亮均匀肤色' },
      { id: 'hydration', label_en: 'Deep hydration', label_zh: '深层补水' },
      { id: 'sensitivity', label_en: 'Calm sensitive skin', label_zh: '舒缓敏感肌' },
      { id: 'barrier', label_en: 'Repair skin barrier', label_zh: '修护屏障' },
      { id: 'pigmentation', label_en: 'Reduce dark spots', label_zh: '淡斑祛印' },
    ];

    let followUpQuestions = null;
    let promptHash = null;
    let llmCalls = 0;

    if (profile.skin_type || profile.concerns?.length > 0) {
      const llmResult = await llmGateway.call({
        templateId: 'diagnosis_v2_start_personalized',
        taskMode: 'diagnosis',
        params: {
          skin_type: profile.skin_type,
          concerns: profile.concerns,
          locale,
        },
      });
      followUpQuestions = llmResult.parsed?.follow_up_questions;
      promptHash = llmResult.promptHash;
      llmCalls = 1;
    }

    const sections = [
      {
        type: 'goal_selection',
        title_en: 'What\'s your main skin goal?',
        title_zh: '你最想改善什么？',
        options: goalOptions,
        allow_multiple: true,
        max_selections: 3,
      },
    ];

    if (followUpQuestions) {
      sections.push({
        type: 'follow_up_questions',
        questions: followUpQuestions,
      });
    }

    return {
      cards: [
        {
          card_type: 'diagnosis_gate',
          sections,
        },
      ],
      ops: {
        thread_ops: [{ op: 'set', key: 'diagnosis_state', value: 'goal_selection' }],
        profile_patch: {},
        routine_patch: {},
        experiment_events: [],
      },
      next_actions: [
        {
          action_type: 'request_input',
          label: {
            en: 'Select your goals and tap continue',
            zh: '选择目标后点击继续',
          },
        },
        {
          action_type: 'trigger_photo',
          label: {
            en: 'Take a selfie for better analysis',
            zh: '拍张自拍获得更精准分析',
          },
        },
      ],
      _promptHash: promptHash,
      _taskMode: 'diagnosis',
      _llmCalls: llmCalls,
    };
  }
}

module.exports = DiagnosisStartSkill;
