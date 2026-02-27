const { ChatCardsResponseSchema } = require('./chatCardsSchema');
const { mapLegacyCardToSpecCards } = require('./chatCardFactory');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRiskLevel(safetyDecision) {
  const blockLevel = asString(safetyDecision && safetyDecision.block_level).toUpperCase();
  if (blockLevel === 'BLOCK') return 'high';
  if (blockLevel === 'REQUIRE_INFO') return 'medium';
  if (blockLevel === 'WARN') return 'low';
  return 'none';
}

function normalizeFollowUpAndQuickReplies({ envelope, language = 'EN', intent = '' } = {}) {
  const chips = envelope && Array.isArray(envelope.suggested_chips) ? envelope.suggested_chips : [];
  const source = asArray(chips)
    .map((chip) => {
      if (!isPlainObject(chip)) return null;
      const id = asString(chip.chip_id);
      const label = asString(chip.label);
      const data = isPlainObject(chip.data) ? chip.data : {};
      const value = asString(data.reply_text) || label;
      if (!id || !label) return null;
      return {
        id: id.slice(0, 120),
        label: label.slice(0, 120),
        value: value.slice(0, 300),
        metadata: data,
      };
    })
    .filter(Boolean);

  const isRoutine = String(intent || '').toLowerCase() === 'routine';
  const questionLimit = isRoutine ? 3 : 2;
  const quickReplies = source.slice(0, 8);
  const followUpQuestions = [];

  const sessionPatch = isPlainObject(envelope && envelope.session_patch) ? envelope.session_patch : {};
  const pending = isPlainObject(sessionPatch.pending_clarification) ? sessionPatch.pending_clarification : null;
  const pendingCurrent = pending && isPlainObject(pending.current) ? pending.current : null;
  const pendingQuestion = asString(
    pendingCurrent && (pendingCurrent.question || pendingCurrent.prompt || pendingCurrent.text),
  );
  const pendingId = asString(
    pendingCurrent && (pendingCurrent.id || pendingCurrent.norm_id || pendingCurrent.normId),
  ) || `fup_${Date.now()}`;
  const pendingOptions = asArray(pendingCurrent && pendingCurrent.options)
    .map((option, idx) => {
      if (isPlainObject(option)) {
        const label = asString(option.label || option.value || option.reply_text);
        const value = asString(option.reply_text || option.value || option.label);
        if (!label) return null;
        return {
          id: asString(option.id) || `${pendingId}_${idx + 1}`,
          label: label.slice(0, 120),
          value: value.slice(0, 300) || label.slice(0, 300),
          metadata: option,
        };
      }
      const text = asString(option);
      if (!text) return null;
      return {
        id: `${pendingId}_${idx + 1}`,
        label: text.slice(0, 120),
        value: text.slice(0, 300),
      };
    })
    .filter(Boolean);
  if (pendingQuestion) {
    followUpQuestions.push({
      id: pendingId.slice(0, 120),
      question: pendingQuestion.slice(0, 500),
      options: pendingOptions.slice(0, isRoutine ? 3 : 2),
      required: true,
    });
  } else if (source.length > 0) {
    followUpQuestions.push({
      id: `fup_${Date.now()}`,
      question:
        language === 'CN'
          ? '你希望我下一步怎么继续？'
          : 'How should I continue for the next step?',
      options: source.slice(0, isRoutine ? 3 : 2),
      required: false,
    });
  }

  return {
    quickReplies,
    followUpQuestions: followUpQuestions.slice(0, questionLimit),
  };
}

function normalizeOps({ envelope, threadOps } = {}) {
  const sessionPatch = isPlainObject(envelope && envelope.session_patch) ? envelope.session_patch : {};
  const profilePatch = isPlainObject(sessionPatch.profile) ? sessionPatch.profile : null;
  const routinePatch =
    isPlainObject(sessionPatch.routine_patch)
      ? sessionPatch.routine_patch
      : isPlainObject(sessionPatch.currentRoutine)
        ? { currentRoutine: sessionPatch.currentRoutine }
        : null;
  const sessionExperiments = asArray(sessionPatch.experiment_events).filter((row) => isPlainObject(row));
  const eventDerivedExperiments = asArray(envelope && envelope.events)
    .map((evt) => {
      if (!isPlainObject(evt)) return null;
      const eventName = asString(evt.event_name);
      if (!eventName) return null;
      if (
        eventName !== 'recos_requested' &&
        eventName !== 'loop_breaker_triggered' &&
        eventName !== 'safety_gate_block' &&
        eventName !== 'catalog_availability_shortcircuit' &&
        eventName !== 'simulate_conflict' &&
        eventName !== 'value_moment'
      ) {
        return null;
      }
      const data = isPlainObject(evt.data) ? evt.data : {};
      const tsRaw = Number(evt.timestamp_ms);
      return {
        event_type: eventName,
        event_data: data,
        timestamp_ms: Number.isFinite(tsRaw) ? Math.max(0, Math.trunc(tsRaw)) : Date.now(),
      };
    })
    .filter(Boolean);
  const experiments = [...sessionExperiments, ...eventDerivedExperiments];

  return {
    thread_ops: asArray(threadOps).filter((row) => isPlainObject(row)).slice(0, 4),
    profile_patch: profilePatch ? [profilePatch] : [],
    routine_patch: routinePatch ? [routinePatch] : [],
    experiment_events: experiments.slice(0, 8),
  };
}

function normalizeCards({ envelope, requestId, language }) {
  const legacyCards = asArray(envelope && envelope.cards);
  const mapped = [];
  for (let idx = 0; idx < legacyCards.length; idx += 1) {
    const card = legacyCards[idx];
    const next = mapLegacyCardToSpecCards(card, {
      requestId,
      language,
      index: idx,
    });
    mapped.push(...asArray(next));
  }

  const compact = mapped.filter((card) => {
    if (!isPlainObject(card)) return false;
    const title = asString(card.title);
    return Boolean(title);
  });

  if (compact.length === 0) {
    return [
      {
        id: `nudge_${requestId}`,
        type: 'nudge',
        priority: 3,
        title: language === 'CN' ? '先给你一个保守建议' : 'Conservative next step',
        tags: [language === 'CN' ? '保守建议' : 'Conservative'],
        sections: [
          {
            kind: 'bullets',
            title: language === 'CN' ? '建议' : 'Recommendation',
            items: [
              language === 'CN'
                ? '当前信息还不完整，我先给你低风险可执行建议，再逐步细化。'
                : 'Context is incomplete, so I am giving a low-risk executable suggestion first.',
            ],
          },
        ],
        actions: [],
      },
    ];
  }

  return compact.slice(0, 3);
}

function buildChatCardsResponse({
  envelope,
  ctx,
  intent = 'unknown',
  intentConfidence = 0,
  entities = [],
  safetyDecision = null,
  threadOps = [],
} = {}) {
  const base = isPlainObject(envelope) ? envelope : {};
  const requestId = asString(base.request_id) || asString(ctx && ctx.request_id) || `req_${Date.now()}`;
  const traceId = asString(base.trace_id) || asString(ctx && ctx.trace_id) || `trace_${Date.now()}`;
  const language = asString(ctx && ctx.lang).toUpperCase() === 'CN' ? 'CN' : 'EN';

  const assistantText =
    asString(base?.assistant_message?.content) ||
    (language === 'CN'
      ? '我先给你一个低风险可执行建议，再按你的补充逐步细化。'
      : 'I will start with a low-risk actionable suggestion, then refine with your context.');
  const cards = normalizeCards({ envelope: base, requestId, language });
  const { quickReplies, followUpQuestions } = normalizeFollowUpAndQuickReplies({
    envelope: base,
    language,
    intent,
  });

  const riskLevel = normalizeRiskLevel(safetyDecision);
  const redFlags = asArray(safetyDecision && safetyDecision.reasons)
    .map((row) => asString(row))
    .filter(Boolean)
    .slice(0, 8);
  const disclaimer =
    riskLevel === 'high'
      ? language === 'CN'
        ? '检测到高风险信号：暂停强功效叠加，必要时及时就医。'
        : 'High-risk signal detected: pause aggressive actives and seek medical care when needed.'
      : '';

  const ops = normalizeOps({ envelope: base, threadOps });

  const response = {
    version: '1.0',
    request_id: requestId,
    trace_id: traceId,
    assistant_text: assistantText,
    cards,
    follow_up_questions: followUpQuestions,
    suggested_quick_replies: quickReplies,
    ops,
    safety: {
      risk_level: riskLevel,
      red_flags: redFlags,
      disclaimer,
    },
    telemetry: {
      intent: asString(intent) || 'unknown',
      intent_confidence: Number.isFinite(Number(intentConfidence))
        ? Math.max(0, Math.min(1, Number(intentConfidence)))
        : 0,
      entities: asArray(entities)
        .map((row) => {
          if (isPlainObject(row)) return row;
          if (typeof row === 'string') return { value: row };
          return null;
        })
        .filter(Boolean)
        .slice(0, 16),
    },
  };

  const parsed = ChatCardsResponseSchema.safeParse(response);
  if (parsed.success) return parsed.data;

  return {
    version: '1.0',
    request_id: requestId,
    trace_id: traceId,
    assistant_text:
      language === 'CN'
        ? '系统暂时无法生成完整结构化回复，我先给你保守建议。'
        : 'Failed to generate a full structured response, returning a conservative fallback.',
    cards: [],
    follow_up_questions: [],
    suggested_quick_replies: [],
    ops: {
      thread_ops: [],
      profile_patch: [],
      routine_patch: [],
      experiment_events: [],
    },
    safety: {
      risk_level: 'none',
      red_flags: [],
      disclaimer: '',
    },
    telemetry: {
      intent: 'unknown',
      intent_confidence: 0,
      entities: [],
    },
  };
}

module.exports = {
  buildChatCardsResponse,
};
