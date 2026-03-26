const crypto = require('crypto');

const PENDING_CLARIFICATION_SCHEMA_V1 = 1;
const PENDING_CLARIFICATION_MAX_RESUME_USER_TEXT = 800;
const PENDING_CLARIFICATION_MAX_QUEUE = 5;
const PENDING_CLARIFICATION_MAX_OPTIONS = 8;
const PENDING_CLARIFICATION_MAX_QUESTION = 200;
const PENDING_CLARIFICATION_MAX_OPTION = 80;
const PENDING_CLARIFICATION_MAX_HISTORY = 6;

function fallbackStableHashBase36(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function truncate(value, maxChars) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { value: '', truncated: false };
  if (text.length <= maxChars) return { value: text, truncated: false };
  return { value: text.slice(0, maxChars), truncated: true };
}

function capArray(items, maxCount) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= maxCount) return { values: list, dropped: 0 };
  return { values: list.slice(0, maxCount), dropped: list.length - maxCount };
}

function createClarificationRuntime(options = {}) {
  const {
    cryptoClient = crypto,
    stableHashBase36 = fallbackStableHashBase36,
    normalizeClarificationField = (value) => String(value || '').trim() || 'clarify',
    filterableClarificationFields = new Set(),
    hasKnownClarificationFieldValue = () => false,
    recordClarificationSchemaInvalid = () => {},
    recordClarificationQuestionFiltered = () => {},
    recordRepeatedClarifyField = () => {},
    recordClarificationAllQuestionsFiltered = () => {},
    recordPendingClarificationUpgraded = () => {},
    recordPendingClarificationTruncated = () => {},
    isPlainObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value),
  } = options;

  function filterClarificationQuestionsForChips({ clarification, profileSummary, filterKnown } = {}) {
    if (!clarification || typeof clarification !== 'object') return [];

    const rawQuestions = clarification.questions;
    if (!Array.isArray(rawQuestions)) {
      recordClarificationSchemaInvalid({ reason: 'questions_not_array' });
      return [];
    }

    const questions = [];
    let filteredKnownCount = 0;
    let validQuestionCount = 0;
    for (const rawQuestion of rawQuestions) {
      if (!rawQuestion || typeof rawQuestion !== 'object' || Array.isArray(rawQuestion)) {
        recordClarificationSchemaInvalid({ reason: 'question_not_object' });
        continue;
      }

      const qidRaw = typeof rawQuestion.id === 'string' ? rawQuestion.id.trim() : '';
      const qid = qidRaw || 'clarify';
      if (!qidRaw) recordClarificationSchemaInvalid({ reason: 'question_id_missing' });

      if (!Array.isArray(rawQuestion.options)) {
        recordClarificationSchemaInvalid({ reason: 'question_options_not_array' });
        continue;
      }

      let hasInvalidOptionType = false;
      const options = [];
      for (const rawOption of rawQuestion.options) {
        if (typeof rawOption !== 'string') {
          hasInvalidOptionType = true;
          continue;
        }
        const option = rawOption.trim();
        if (option) options.push(option);
      }
      if (hasInvalidOptionType) {
        recordClarificationSchemaInvalid({ reason: 'question_option_non_string' });
      }
      if (!options.length) {
        recordClarificationSchemaInvalid({ reason: 'question_options_empty' });
        continue;
      }

      const question = typeof rawQuestion.question === 'string' ? rawQuestion.question.trim() : '';
      validQuestionCount += 1;
      const field = normalizeClarificationField(qid);
      const shouldFilterKnown =
        Boolean(filterKnown) &&
        filterableClarificationFields.has(field) &&
        hasKnownClarificationFieldValue(profileSummary, field);
      if (shouldFilterKnown) {
        filteredKnownCount += 1;
        recordClarificationQuestionFiltered({ field });
        recordRepeatedClarifyField({ field });
        continue;
      }

      questions.push({ id: qid, question, options });
    }

    if (Boolean(filterKnown) && validQuestionCount > 0 && filteredKnownCount > 0 && questions.length === 0) {
      recordClarificationAllQuestionsFiltered();
    }

    return questions;
  }

  function makeFlowId() {
    const rand = cryptoClient.randomBytes(6).toString('hex').slice(0, 12);
    return `pc_${rand || Math.random().toString(36).slice(2, 10)}`;
  }

  function normalizePendingClarificationId(rawId) {
    const idRaw = typeof rawId === 'string' ? rawId.trim() : '';
    const id = idRaw || 'clarify';
    const normId = normalizeClarificationField(id);
    return { id, norm_id: normId };
  }

  function recordPendingClarificationTruncationFields(fields) {
    for (const field of Array.from(fields || [])) {
      recordPendingClarificationTruncated({ field });
    }
  }

  function normalizeClarificationQuestionForPending(
    rawQuestion,
    { recordTruncationMetrics = true, truncationFields } = {},
  ) {
    if (!rawQuestion || typeof rawQuestion !== 'object' || Array.isArray(rawQuestion)) return null;
    if (!Array.isArray(rawQuestion.options)) return null;

    const localTruncationFields = new Set();
    const idInfo = normalizePendingClarificationId(rawQuestion.id);
    const questionTextRaw = typeof rawQuestion.question === 'string' ? rawQuestion.question.trim() : '';
    const questionTrimmed = truncate(questionTextRaw, PENDING_CLARIFICATION_MAX_QUESTION);
    if (questionTrimmed.truncated) localTruncationFields.add('question');

    const options = [];
    for (const rawOption of rawQuestion.options) {
      if (typeof rawOption !== 'string') continue;
      const optionText = rawOption.trim();
      if (!optionText) continue;
      const optionTrimmed = truncate(optionText, PENDING_CLARIFICATION_MAX_OPTION);
      if (optionTrimmed.truncated) localTruncationFields.add('option');
      options.push(optionTrimmed.value);
    }
    if (!options.length) return null;

    const cappedOptions = capArray(options, PENDING_CLARIFICATION_MAX_OPTIONS);
    if (cappedOptions.dropped > 0) localTruncationFields.add('options');

    for (const field of Array.from(localTruncationFields)) {
      if (truncationFields && truncationFields.add) truncationFields.add(field);
    }
    if (recordTruncationMetrics && localTruncationFields.size > 0) {
      recordPendingClarificationTruncationFields(localTruncationFields);
    }

    return {
      id: idInfo.id,
      norm_id: idInfo.norm_id,
      question: questionTrimmed.value,
      options: cappedOptions.values,
    };
  }

  function sanitizePendingClarification(rawPending, { recordMetrics = true } = {}) {
    if (!rawPending || typeof rawPending !== 'object' || Array.isArray(rawPending)) return null;
    const truncationFields = new Set();

    const createdAtRaw = Number(rawPending.created_at_ms);
    if (!Number.isFinite(createdAtRaw) || createdAtRaw <= 0) return null;
    const createdAtMs = Math.trunc(createdAtRaw);

    const resumeTextRaw =
      typeof rawPending.resume_user_text === 'string' ? rawPending.resume_user_text.trim() : '';
    if (!resumeTextRaw) return null;
    const resumeText = truncate(resumeTextRaw, PENDING_CLARIFICATION_MAX_RESUME_USER_TEXT);
    if (resumeText.truncated) truncationFields.add('resume_user_text');

    const flowIdRaw = typeof rawPending.flow_id === 'string' ? rawPending.flow_id.trim() : '';
    const flowId = /^pc_[a-z0-9]+$/i.test(flowIdRaw) ? flowIdRaw.slice(0, 32) : makeFlowId();

    const resumeUserHashRaw =
      typeof rawPending.resume_user_hash === 'string' ? rawPending.resume_user_hash.trim() : '';
    const resumeUserHashSafe = (
      resumeUserHashRaw || stableHashBase36(resumeText.value).slice(0, 20)
    )
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 24);

    if (!Array.isArray(rawPending.queue)) return null;
    const normalizedQueue = [];
    for (const rawQuestion of rawPending.queue) {
      const normalized = normalizeClarificationQuestionForPending(rawQuestion, {
        recordTruncationMetrics: false,
        truncationFields,
      });
      if (normalized) normalizedQueue.push(normalized);
    }
    if (normalizedQueue.length < rawPending.queue.length) truncationFields.add('queue');
    const cappedQueue = capArray(normalizedQueue, PENDING_CLARIFICATION_MAX_QUEUE);
    if (cappedQueue.dropped > 0) truncationFields.add('queue');

    let current = null;
    if (rawPending.current && typeof rawPending.current === 'object' && !Array.isArray(rawPending.current)) {
      const currentIdRaw = typeof rawPending.current.id === 'string' ? rawPending.current.id.trim() : '';
      if (currentIdRaw) {
        const currentIdInfo = normalizePendingClarificationId(currentIdRaw);
        current = { id: currentIdInfo.id, norm_id: currentIdInfo.norm_id };
      }
    }

    const historyRaw = Array.isArray(rawPending.history) ? rawPending.history : [];
    if (!Array.isArray(rawPending.history) && rawPending.history != null) {
      truncationFields.add('history');
    }
    const normalizedHistory = [];
    for (const entry of historyRaw) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const questionIdRaw = typeof entry.question_id === 'string' ? entry.question_id.trim() : '';
      const optionRaw = typeof entry.option === 'string' ? entry.option.trim() : '';
      const tsMsRaw = Number(entry.ts_ms);
      if (!questionIdRaw || !optionRaw || !Number.isFinite(tsMsRaw) || tsMsRaw <= 0) continue;

      const questionIdInfo = normalizePendingClarificationId(questionIdRaw);
      const optionTrimmed = truncate(optionRaw, PENDING_CLARIFICATION_MAX_OPTION);
      if (optionTrimmed.truncated) truncationFields.add('option');

      normalizedHistory.push({
        question_id: questionIdInfo.id,
        norm_id:
          typeof entry.norm_id === 'string' && entry.norm_id.trim()
            ? entry.norm_id.trim().slice(0, 80)
            : questionIdInfo.norm_id,
        option: optionTrimmed.value,
        ts_ms: Math.trunc(tsMsRaw),
      });
    }
    if (normalizedHistory.length < historyRaw.length) truncationFields.add('history');
    let history = normalizedHistory;
    if (normalizedHistory.length > PENDING_CLARIFICATION_MAX_HISTORY) {
      history = normalizedHistory.slice(-PENDING_CLARIFICATION_MAX_HISTORY);
      truncationFields.add('history');
    }

    const canonical = {
      v: PENDING_CLARIFICATION_SCHEMA_V1,
      flow_id: flowId,
      created_at_ms: createdAtMs,
      resume_user_text: resumeText.value,
      ...(resumeUserHashSafe ? { resume_user_hash: resumeUserHashSafe } : {}),
      step_index: history.length,
      ...(current ? { current } : {}),
      queue: cappedQueue.values,
      history,
    };

    const upgraded = Number(rawPending.v) !== PENDING_CLARIFICATION_SCHEMA_V1;
    if (recordMetrics) {
      if (upgraded) recordPendingClarificationUpgraded({ from: 'legacy' });
      if (truncationFields.size > 0) recordPendingClarificationTruncationFields(truncationFields);
    }

    return { pending: canonical, upgraded };
  }

  function getPendingClarification(session) {
    const s = session && typeof session === 'object' ? session : null;
    if (!s) return null;
    const state = s.state && typeof s.state === 'object' && !Array.isArray(s.state) ? s.state : null;
    if (!state) return null;
    const raw = state.pending_clarification;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return sanitizePendingClarification(raw, { recordMetrics: true });
  }

  function emitPendingClarificationPatch(sessionPatch, pendingOrNull) {
    if (!sessionPatch || typeof sessionPatch !== 'object') return;
    const state = isPlainObject(sessionPatch.state) ? { ...sessionPatch.state } : {};
    state.pending_clarification = pendingOrNull || null;
    sessionPatch.state = state;
  }

  function buildChipsForQuestion(question, { stepIndex } = {}) {
    const q = normalizeClarificationQuestionForPending(question);
    if (!q) return [];
    const qid = String(q.id || 'clarify').trim() || 'clarify';
    const step = Number.isFinite(Number(stepIndex)) ? Math.max(1, Math.trunc(Number(stepIndex))) : 1;
    return q.options.slice(0, 8).map((option) => ({
      chip_id: `chip.clarify.${qid}.${option.trim().slice(0, 40).replace(/\s+/g, '_')}`,
      label: option,
      kind: 'quick_reply',
      data: {
        reply_text: option,
        clarification_id: qid,
        clarification_question_id: qid,
        clarification_norm_id: String(q.norm_id || ''),
        clarification_step: step,
      },
    }));
  }

  function advancePendingClarification(pending, selectedOption, selectedQuestionId) {
    const nowMs = Date.now();
    const option = typeof selectedOption === 'string' ? selectedOption.trim() : '';
    const currentId =
      (typeof selectedQuestionId === 'string' && selectedQuestionId.trim()) ||
      (pending && pending.current && typeof pending.current.id === 'string' && pending.current.id.trim()) ||
      'clarify';
    const currentIdInfo = normalizePendingClarificationId(currentId);
    const optionTrimmed = truncate(option || '(empty)', PENDING_CLARIFICATION_MAX_OPTION);
    if (optionTrimmed.truncated) recordPendingClarificationTruncated({ field: 'option' });

    const entry = {
      question_id: currentIdInfo.id,
      norm_id: currentIdInfo.norm_id,
      option: optionTrimmed.value || '(empty)',
      ts_ms: nowMs,
    };

    const history = Array.isArray(pending && pending.history) ? [...pending.history, entry] : [entry];
    const queue = Array.isArray(pending && pending.queue) ? pending.queue : [];
    const historyState = sanitizePendingClarification(
      {
        v: PENDING_CLARIFICATION_SCHEMA_V1,
        flow_id: pending && typeof pending.flow_id === 'string' ? pending.flow_id : makeFlowId(),
        created_at_ms: Number(pending && pending.created_at_ms) || nowMs,
        resume_user_text:
          pending && typeof pending.resume_user_text === 'string' ? pending.resume_user_text : '(no message)',
        ...(pending && typeof pending.resume_user_hash === 'string'
          ? { resume_user_hash: pending.resume_user_hash }
          : {}),
        step_index: history.length,
        ...(pending && pending.current ? { current: pending.current } : {}),
        queue,
        history,
      },
      { recordMetrics: true },
    );
    const boundedHistory = historyState
      ? historyState.pending.history
      : history.slice(-PENDING_CLARIFICATION_MAX_HISTORY);
    if (!queue.length) {
      return { nextPending: null, nextQuestion: null, history: boundedHistory };
    }

    const nextQuestion = normalizeClarificationQuestionForPending(queue[0], {
      recordTruncationMetrics: true,
    });
    if (!nextQuestion) return { nextPending: null, nextQuestion: null, history: boundedHistory };

    const nextPendingState = sanitizePendingClarification(
      {
        v: PENDING_CLARIFICATION_SCHEMA_V1,
        flow_id: pending && typeof pending.flow_id === 'string' ? pending.flow_id : makeFlowId(),
        created_at_ms: Number(pending && pending.created_at_ms) || nowMs,
        resume_user_text:
          pending && typeof pending.resume_user_text === 'string' ? pending.resume_user_text : '(no message)',
        ...(pending && typeof pending.resume_user_hash === 'string'
          ? { resume_user_hash: pending.resume_user_hash }
          : {}),
        step_index: boundedHistory.length,
        current: { id: nextQuestion.id, norm_id: nextQuestion.norm_id },
        queue: queue.slice(1),
        history: boundedHistory,
      },
      { recordMetrics: true },
    );
    if (!nextPendingState || !nextPendingState.pending) {
      return { nextPending: null, nextQuestion: null, history: boundedHistory };
    }
    return {
      nextPending: nextPendingState.pending,
      nextQuestion,
      history: nextPendingState.pending.history,
    };
  }

  function compactClarificationHistory(history) {
    const out = [];
    const list = Array.isArray(history) ? history : [];
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const questionId = typeof item.question_id === 'string' ? item.question_id.trim() : '';
      const option = typeof item.option === 'string' ? item.option.trim() : '';
      if (!questionId || !option) continue;
      out.push({
        question_id: questionId.slice(0, 120),
        option: option.slice(0, 120),
      });
      if (out.length >= 5) break;
    }
    return out;
  }

  return {
    PENDING_CLARIFICATION_SCHEMA_V1,
    filterClarificationQuestionsForChips,
    makeFlowId,
    sanitizePendingClarification,
    getPendingClarification,
    emitPendingClarificationPatch,
    buildChipsForQuestion,
    advancePendingClarification,
    compactClarificationHistory,
  };
}

module.exports = {
  PENDING_CLARIFICATION_SCHEMA_V1,
  createClarificationRuntime,
};
