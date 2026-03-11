const BaseSkill = require('./BaseSkill');

function isLlmQualityError(error) {
  return Boolean(error) && String(error.name || '') === 'LlmQualityError';
}

function normalizeFollowUpQuestions(questions, locale) {
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const isCN = String(locale || '').toLowerCase().startsWith('zh');
  return questions
    .map((question, qi) => {
      if (!question || typeof question !== 'object') return null;
      const questionText =
        question.question
        || (isCN ? (question.question_zh || question.question_en) : (question.question_en || question.question_zh))
        || '';
      const rawOptions = Array.isArray(question.options) ? question.options : [];
      const options = rawOptions
        .map((opt, oi) => {
          if (typeof opt === 'string') {
            const label = opt.trim();
            if (!label) return null;
            return {
              id: `opt_${qi}_${oi}`,
              label,
              label_en: label,
              label_zh: null,
            };
          }
          if (opt && typeof opt === 'object') {
            const label =
              (typeof opt.label === 'string' && opt.label.trim())
              || (isCN
                ? (typeof opt.label_zh === 'string' && opt.label_zh.trim()) || (typeof opt.label_en === 'string' && opt.label_en.trim())
                : (typeof opt.label_en === 'string' && opt.label_en.trim()) || (typeof opt.label_zh === 'string' && opt.label_zh.trim()))
              || (typeof opt.value === 'string' && opt.value.trim())
              || (typeof opt.id === 'string' && opt.id.trim())
              || `Option ${oi + 1}`;
            return {
              id: (typeof opt.id === 'string' && opt.id.trim()) || `opt_${qi}_${oi}`,
              label,
              label_en: (typeof opt.label_en === 'string' && opt.label_en.trim()) || (typeof opt.label === 'string' && opt.label.trim()) || label,
              label_zh: (typeof opt.label_zh === 'string' && opt.label_zh.trim()) || null,
            };
          }
          return null;
        })
        .filter(Boolean);

      if (!questionText || options.length === 0) return null;
      return {
        id: (typeof question.id === 'string' && question.id.trim()) || `fq_${qi}`,
        question: questionText,
        question_en: (typeof question.question_en === 'string' && question.question_en.trim()) || questionText,
        question_zh: (typeof question.question_zh === 'string' && question.question_zh.trim()) || null,
        options,
      };
    })
    .filter(Boolean);
}

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
      llmCalls = 1;
      try {
        const llmResult = await llmGateway.call({
          templateId: 'diagnosis_v2_start_personalized',
          taskMode: 'diagnosis',
          schema: 'DiagnosisStartOutput',
          params: {
            skin_type: profile.skin_type,
            concerns: profile.concerns,
            locale,
          },
        });
        followUpQuestions = normalizeFollowUpQuestions(llmResult.parsed?.follow_up_questions, locale);
        promptHash = llmResult.promptHash;
      } catch (error) {
        if (!isLlmQualityError(error)) {
          throw error;
        }
      }
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
