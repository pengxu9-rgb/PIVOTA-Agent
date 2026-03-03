const { ChatCardsResponseSchema } = require('./chatCardsSchema');
const { mapLegacyCardToSpecCards } = require('./chatCardFactory');

const AURORA_CARD_FIRST_DEDUPE_V1 = (() => {
  const raw = String(process.env.AURORA_CARD_FIRST_DEDUPE_V1 || 'true')
    .trim()
    .toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
})();

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

function normalizeLanguageToken(value, fallback = 'EN') {
  const token = asString(value).toUpperCase();
  if (token === 'CN' || token === 'ZH' || token === 'ZH-CN' || token === 'ZH_HANS') return 'CN';
  if (token === 'EN') return 'EN';
  return fallback === 'CN' ? 'CN' : 'EN';
}

function normalizeLanguageResolutionSource(value, fallback = 'text_detected') {
  const token = asString(value).toLowerCase();
  if (token === 'header' || token === 'body' || token === 'text_detected' || token === 'mixed_override') return token;
  return fallback;
}

function normalizeBlockLevelToRisk(value) {
  const token = asString(value).toUpperCase();
  if (token === 'BLOCK') return 'high';
  if (token === 'REQUIRE_INFO') return 'medium';
  if (token === 'WARN') return 'low';
  if (token === 'INFO') return 'none';
  return '';
}

function riskRank(level) {
  if (level === 'high') return 3;
  if (level === 'medium') return 2;
  if (level === 'low') return 1;
  return 0;
}

function inferRiskFromEnvelopeEvents(envelope) {
  const events = asArray(envelope && envelope.events);
  let highest = 'none';
  for (const evt of events) {
    if (!isPlainObject(evt)) continue;
    const eventName = asString(evt.event_name).toLowerCase();
    if (!eventName) continue;
    const data = isPlainObject(evt.data) ? evt.data : {};
    const fromLevel = normalizeBlockLevelToRisk(data.block_level || data.level);
    if (fromLevel && riskRank(fromLevel) > riskRank(highest)) {
      highest = fromLevel;
    }
    if (eventName === 'safety_advisory_inline' && riskRank('low') > riskRank(highest)) {
      highest = 'low';
    }
  }
  return highest;
}

function normalizeRiskLevel({ safetyDecision, envelope } = {}) {
  const decision = isPlainObject(safetyDecision) ? safetyDecision : {};

  const explicitRisk = asString(decision.risk_level || decision.riskLevel).toLowerCase();
  if (explicitRisk === 'high' || explicitRisk === 'medium' || explicitRisk === 'low' || explicitRisk === 'none') {
    return explicitRisk;
  }

  const fromBlockLevel = normalizeBlockLevelToRisk(decision.block_level || decision.blockLevel);
  if (fromBlockLevel) return fromBlockLevel;

  let matchedHighest = 'none';
  const matchedRules = asArray(decision.matched_rules || decision.matchedRules);
  for (const rule of matchedRules) {
    if (!isPlainObject(rule)) continue;
    const next = normalizeBlockLevelToRisk(rule.level || rule.block_level);
    if (next && riskRank(next) > riskRank(matchedHighest)) {
      matchedHighest = next;
    }
  }
  if (matchedHighest !== 'none') return matchedHighest;

  const fromEvents = inferRiskFromEnvelopeEvents(envelope);
  if (fromEvents !== 'none') return fromEvents;

  if (asArray(decision.reasons).some((row) => asString(row))) return 'low';
  return 'none';
}

function normalizeSafetyRedFlags({ safetyDecision, envelope } = {}) {
  const decision = isPlainObject(safetyDecision) ? safetyDecision : {};
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const text = asString(value);
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };

  for (const value of asArray(decision.reasons)) push(value);
  for (const value of asArray(decision.reason_codes || decision.reasonCodes)) push(value);
  for (const value of asArray(decision.required_questions || decision.requiredQuestions)) push(value);
  for (const rule of asArray(decision.matched_rules || decision.matchedRules)) {
    if (!isPlainObject(rule)) continue;
    push(rule.id);
  }

  if (out.length === 0) {
    const events = asArray(envelope && envelope.events);
    for (const evt of events) {
      if (!isPlainObject(evt)) continue;
      const eventName = asString(evt.event_name).toLowerCase();
      if (!eventName.startsWith('safety_')) continue;
      if (eventName === 'safety_gate_block') push('safety_gate_block');
      if (eventName === 'safety_advisory_inline') push('safety_advisory_inline');
      const data = isPlainObject(evt.data) ? evt.data : {};
      push(data.reason);
    }
  }

  return out.slice(0, 8);
}

function buildSafetyDisclaimer({ riskLevel, language }) {
  if (riskLevel === 'high') {
    return language === 'CN'
      ? '检测到高风险信号：暂停强功效叠加，必要时及时就医。'
      : 'High-risk signal detected: pause aggressive actives and seek medical care when needed.';
  }
  if (riskLevel === 'medium') {
    return language === 'CN'
      ? '存在中等风险：补充关键安全信息前，请先按保守方案执行。'
      : 'Medium-risk signal detected: use conservative options until key safety details are confirmed.';
  }
  if (riskLevel === 'low') {
    return language === 'CN'
      ? '有低风险提示：建议降低活性强度并观察皮肤反应。'
      : 'Low-risk note: consider reducing active intensity and monitor skin response.';
  }
  return '';
}

function normalizeFollowUpAndQuickReplies({ envelope, language = 'EN', intent = '' } = {}) {
  const chips = envelope && Array.isArray(envelope.suggested_chips) ? envelope.suggested_chips : [];
  const cards = asArray(envelope && envelope.cards);
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
  const cardTypeSet = new Set(
    cards
      .map((card) => asString(card && card.type).toLowerCase())
      .filter(Boolean),
  );
  const hasStrongGuideCard =
    AURORA_CARD_FIRST_DEDUPE_V1 &&
    (
      cardTypeSet.has('analysis_summary') ||
      cardTypeSet.has('skin_status') ||
      cardTypeSet.has('routine') ||
      cardTypeSet.has('analysis_story_v2') ||
      cardTypeSet.has('confidence_notice') ||
      cardTypeSet.has('diagnosis_gate')
    );

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
  } else if (source.length > 0 && !hasStrongGuideCard) {
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

function resolveResponseContractMode() {
  const raw = asString(process.env.AURORA_CHATCARDS_RESPONSE_CONTRACT).toLowerCase();
  if (raw === 'legacy' || raw === 'dual') return raw;
  return 'chatcards';
}

function buildLegacyEnvelopeView({ envelope, assistantText }) {
  const base = isPlainObject(envelope) ? envelope : {};
  const assistantMessage =
    isPlainObject(base.assistant_message) && asString(base.assistant_message.content)
      ? base.assistant_message
      : {
          role: 'assistant',
          content: asString(assistantText),
          format: 'markdown',
        };
  return {
    assistant_message: assistantMessage,
    suggested_chips: asArray(base.suggested_chips),
    cards: asArray(base.cards),
    session_patch: isPlainObject(base.session_patch) ? base.session_patch : {},
    events: asArray(base.events),
    ...(isPlainObject(base.meta) ? { meta: base.meta } : {}),
  };
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
  const uiLanguage = normalizeLanguageToken(ctx && (ctx.ui_lang || ctx.lang), 'EN');
  const matchingLanguage = normalizeLanguageToken(ctx && ctx.match_lang, uiLanguage);
  const languageMismatch = Boolean((ctx && ctx.language_mismatch) === true || uiLanguage !== matchingLanguage);
  const languageResolutionSource = normalizeLanguageResolutionSource(
    ctx && ctx.language_resolution_source,
    languageMismatch ? 'mixed_override' : 'text_detected',
  );

  const assistantText =
    asString(base?.assistant_message?.content) ||
    (uiLanguage === 'CN'
      ? '我先给你一个低风险可执行建议，再按你的补充逐步细化。'
      : 'I will start with a low-risk actionable suggestion, then refine with your context.');
  const cards = normalizeCards({ envelope: base, requestId, language: uiLanguage });
  const { quickReplies, followUpQuestions } = normalizeFollowUpAndQuickReplies({
    envelope: base,
    language: uiLanguage,
    intent,
  });

  const riskLevel = normalizeRiskLevel({ safetyDecision, envelope: base });
  const redFlags = normalizeSafetyRedFlags({ safetyDecision, envelope: base });
  const disclaimer = buildSafetyDisclaimer({ riskLevel, language: uiLanguage });

  const ops = normalizeOps({ envelope: base, threadOps });

  const response = {
    version: '1.0',
    request_id: requestId,
    trace_id: traceId,
    assistant_text: assistantText,
    cards,
    follow_up_questions: followUpQuestions,
    suggested_quick_replies: quickReplies,
    session_patch: isPlainObject(base.session_patch) ? base.session_patch : {},
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
      ui_language: uiLanguage,
      matching_language: matchingLanguage,
      language_mismatch: languageMismatch,
      language_resolution_source: languageResolutionSource,
    },
  };

  const parsed = ChatCardsResponseSchema.safeParse(response);
  if (parsed.success) {
    const mode = resolveResponseContractMode();
    if (mode === 'chatcards') return parsed.data;

    const legacy = buildLegacyEnvelopeView({ envelope: base, assistantText });
    if (mode === 'legacy') {
      return {
        request_id: requestId,
        trace_id: traceId,
        ...legacy,
      };
    }

    return {
      ...parsed.data,
      cards_chatcards: parsed.data.cards,
      ...legacy,
    };
  }

  return {
    version: '1.0',
    request_id: requestId,
    trace_id: traceId,
    assistant_text:
      uiLanguage === 'CN'
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
      ui_language: uiLanguage,
      matching_language: matchingLanguage,
      language_mismatch: languageMismatch,
      language_resolution_source: languageResolutionSource,
    },
  };
}

module.exports = {
  buildChatCardsResponse,
};
