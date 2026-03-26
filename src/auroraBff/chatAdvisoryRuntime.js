function createChatAdvisoryRuntime(options = {}) {
  const {
    logger = null,
    isPlainObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value),
    makeEvent,
    BLOCK_LEVEL = {
      INFO: 'info',
      WARN: 'warn',
      REQUIRE_INFO: 'require_info',
      BLOCK: 'block',
    },
    GATE_MODE = {
      BYPASS: 'bypass',
      ADVISORY: 'advisory',
      BLOCK: 'block',
    },
    OPTIONAL_SAFETY_PROFILE_FIELDS = [],
    profileHasOptionalSafetyFieldValue = () => false,
    normalizeSafetyPromptStateForChat = (value) => {
      const askedOnce =
        value && typeof value === 'object' && !Array.isArray(value) && value.asked_once_fields && typeof value.asked_once_fields === 'object'
          ? value.asked_once_fields
          : {};
      return {
        asked_once_fields: { ...askedOnce },
        asked_at_ms: value && typeof value === 'object' ? value.asked_at_ms || null : null,
      };
    },
    buildSafetyAdvisoryChipsByField = () => [],
    upsertProfileForIdentity,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat advisory runtime missing dependency: ${name}`);
  }

  function dedupeArrayStrings(values, max = 8) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(values) ? values : []) {
      const value = String(raw || '').trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
      if (out.length >= max) break;
    }
    return out;
  }

  function normalizeIdentity(identity) {
    return {
      auroraUid: identity && identity.auroraUid ? identity.auroraUid : null,
      userId: identity && identity.userId ? identity.userId : null,
    };
  }

  function buildBaseEnvelope(envelope) {
    return envelope && typeof envelope === 'object' && !Array.isArray(envelope)
      ? { ...envelope }
      : { assistant_message: null, suggested_chips: [], cards: [], session_patch: {}, events: [] };
  }

  function buildSafetyNoticeText({ safety, language } = {}) {
    const s = safety && typeof safety === 'object' ? safety : null;
    if (!s) return '';
    const reasons = Array.isArray(s.reasons) ? s.reasons.slice(0, 3) : [];
    const alternatives = Array.isArray(s.safe_alternatives) ? s.safe_alternatives.slice(0, 3) : [];
    const requiredQuestions = Array.isArray(s.required_questions) ? s.required_questions.slice(0, 1) : [];
    const lang = String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
    if (s.block_level === BLOCK_LEVEL.BLOCK) {
      return lang === 'CN'
        ? [
          '基于你当前情况，我不能给出激进活性方案。',
          ...(reasons.length ? reasons.map((line) => `- ${line}`) : []),
          ...(alternatives.length ? ['更安全替代：', ...alternatives.map((line) => `- ${line}`)] : []),
        ].join('\n')
        : [
          'Given your current context, I cannot provide an aggressive-active recommendation.',
          ...(reasons.length ? reasons.map((line) => `- ${line}`) : []),
          ...(alternatives.length ? ['Safer alternatives:', ...alternatives.map((line) => `- ${line}`)] : []),
        ].join('\n');
    }
    if (s.block_level === BLOCK_LEVEL.REQUIRE_INFO) {
      return lang === 'CN'
        ? [
          '继续前我需要一个关键安全信息：',
          ...(requiredQuestions.length ? requiredQuestions.map((line) => `- ${line}`) : []),
          ...(alternatives.length ? ['在确认前先按保守替代执行：', ...alternatives.map((line) => `- ${line}`)] : []),
        ].join('\n')
        : [
          'Before continuing, I need one key safety detail:',
          ...(requiredQuestions.length ? requiredQuestions.map((line) => `- ${line}`) : []),
          ...(alternatives.length ? ['Conservative options before confirmation:', ...alternatives.map((line) => `- ${line}`)] : []),
        ].join('\n');
    }
    if (s.block_level === BLOCK_LEVEL.WARN) {
      return lang === 'CN'
        ? [
          '风险提示：',
          ...(reasons.length ? reasons.map((line) => `- ${line}`) : []),
          ...(alternatives.length ? ['可执行替代：', ...alternatives.map((line) => `- ${line}`)] : []),
        ].join('\n')
        : [
          'Risk note:',
          ...(reasons.length ? reasons.map((line) => `- ${line}`) : []),
          ...(alternatives.length ? ['Practical alternatives:', ...alternatives.map((line) => `- ${line}`)] : []),
        ].join('\n');
    }
    return '';
  }

  function applyPendingSafetyAdvisoryToEnvelope({ envelope, pendingSafetyAdvisory, ctx } = {}) {
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const base = buildBaseEnvelope(envelope);
    const advisory =
      pendingSafetyAdvisory && typeof pendingSafetyAdvisory === 'object' ? pendingSafetyAdvisory : null;

    const sessionPatch = isPlainObject(base.session_patch) ? { ...base.session_patch } : {};
    const sessionMeta =
      sessionPatch.meta && typeof sessionPatch.meta === 'object' && !Array.isArray(sessionPatch.meta)
        ? { ...sessionPatch.meta }
        : {};
    sessionMeta.safety_gate_mode = 'advisory_only_v1';
    sessionMeta.safety_advisory_emitted = Boolean(advisory);
    if (advisory && Array.isArray(advisory.missing_optional_fields) && advisory.missing_optional_fields.length > 0) {
      sessionMeta.safety_missing_optional_fields = advisory.missing_optional_fields.slice(0, 6);
    } else if (Object.prototype.hasOwnProperty.call(sessionMeta, 'safety_missing_optional_fields')) {
      delete sessionMeta.safety_missing_optional_fields;
    }
    if (advisory) {
      sessionMeta.passive_gate_suppressed = true;
      sessionMeta.suppressed_gate_ids = dedupeArrayStrings(
        [
          ...(Array.isArray(sessionMeta.suppressed_gate_ids) ? sessionMeta.suppressed_gate_ids : []),
          advisory.reason || 'safety_optional_profile_missing',
        ],
        16,
      );
    }
    sessionPatch.meta = sessionMeta;
    base.session_patch = sessionPatch;

    if (!advisory) return base;

    const events = Array.isArray(base.events) ? base.events.slice(0, 96) : [];
    if (!events.some((evt) => evt && evt.event_name === 'safety_advisory_inline')) {
      events.push(
        makeEventFn(ctx, 'safety_advisory_inline', {
          reason: advisory.reason || 'safety_optional_profile_missing',
          missing_fields: Array.isArray(advisory.missing_optional_fields)
            ? advisory.missing_optional_fields.slice(0, 6)
            : [],
          question: advisory.required_question || null,
        }),
      );
    }
    base.events = events;
    return base;
  }

  function enqueueGateAdvisory({ pendingGateAdvisories, gate_id, message, reason_codes, actions, chips } = {}) {
    if (!Array.isArray(pendingGateAdvisories)) return;
    const gateId = String(gate_id || '').trim();
    if (!gateId) return;
    const existing = pendingGateAdvisories.find((item) => item && item.gate_id === gateId);
    const next = {
      gate_id: gateId,
      message: String(message || '').trim(),
      reason_codes: dedupeArrayStrings(reason_codes, 8),
      actions: dedupeArrayStrings(actions, 6),
      chips: Array.isArray(chips) ? chips.slice(0, 6) : [],
    };
    if (!existing) {
      pendingGateAdvisories.push(next);
      return;
    }
    existing.message = existing.message || next.message;
    existing.reason_codes = dedupeArrayStrings([...(existing.reason_codes || []), ...(next.reason_codes || [])], 8);
    existing.actions = dedupeArrayStrings([...(existing.actions || []), ...(next.actions || [])], 6);
    if ((!Array.isArray(existing.chips) || existing.chips.length === 0) && next.chips.length > 0) {
      existing.chips = next.chips.slice(0, 6);
    }
  }

  function applyPendingGateAdvisoriesToEnvelope({ envelope, pendingGateAdvisories, ctx } = {}) {
    if (!Array.isArray(pendingGateAdvisories) || pendingGateAdvisories.length === 0) return envelope;
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const base = buildBaseEnvelope(envelope);
    const sessionPatch = isPlainObject(base.session_patch) ? { ...base.session_patch } : {};
    const sessionMeta =
      sessionPatch.meta && typeof sessionPatch.meta === 'object' && !Array.isArray(sessionPatch.meta)
        ? { ...sessionPatch.meta }
        : {};
    sessionMeta.passive_gate_suppressed = true;
    sessionMeta.suppressed_gate_ids = dedupeArrayStrings(
      [
        ...(Array.isArray(sessionMeta.suppressed_gate_ids) ? sessionMeta.suppressed_gate_ids : []),
        ...pendingGateAdvisories.map((advisory) => (advisory && advisory.gate_id ? advisory.gate_id : 'gate_advisory')),
      ],
      24,
    );
    sessionPatch.meta = sessionMeta;
    base.session_patch = sessionPatch;

    const events = Array.isArray(base.events) ? base.events.slice(0, 96) : [];
    const advisoryEventGateIds = new Set(
      events
        .filter((evt) => evt && evt.event_name === 'gate_advisory_inline')
        .map((evt) => String((evt.event_data && evt.event_data.gate_id) || '').trim())
        .filter(Boolean),
    );
    for (const advisory of pendingGateAdvisories.slice(0, 8)) {
      if (!advisory || typeof advisory !== 'object') continue;
      const gateId = String(advisory.gate_id || '').trim();
      if (gateId && advisoryEventGateIds.has(gateId)) continue;
      if (gateId) advisoryEventGateIds.add(gateId);
      events.push(
        makeEventFn(ctx, 'gate_advisory_inline', {
          gate_id: gateId || 'gate_advisory',
          reason_codes: Array.isArray(advisory.reason_codes) ? advisory.reason_codes.slice(0, 8) : [],
          actions: Array.isArray(advisory.actions) ? advisory.actions.slice(0, 6) : [],
          suppressed: true,
        }),
      );
    }
    base.events = events.slice(0, 96);
    return base;
  }

  function mergePendingSafetyAdvisory({ pendingSafetyAdvisory, incoming } = {}) {
    if (!incoming || typeof incoming !== 'object') return pendingSafetyAdvisory;
    if (!pendingSafetyAdvisory) return incoming;
    const currentMissing = Array.isArray(pendingSafetyAdvisory.missing_optional_fields)
      ? pendingSafetyAdvisory.missing_optional_fields
      : [];
    const incomingMissing = Array.isArray(incoming.missing_optional_fields)
      ? incoming.missing_optional_fields
      : [];
    return {
      ...pendingSafetyAdvisory,
      details: dedupeArrayStrings([...(pendingSafetyAdvisory.details || []), ...(incoming.details || [])], 6),
      assumptions: dedupeArrayStrings(
        [...(pendingSafetyAdvisory.assumptions || []), ...(incoming.assumptions || [])],
        4,
      ),
      actions: dedupeArrayStrings([...(pendingSafetyAdvisory.actions || []), ...(incoming.actions || [])], 6),
      chips:
        Array.isArray(pendingSafetyAdvisory.chips) && pendingSafetyAdvisory.chips.length > 0
          ? pendingSafetyAdvisory.chips
          : incoming.chips,
      missing_optional_fields: dedupeArrayStrings([...currentMissing, ...incomingMissing], 6),
      reason_codes: dedupeArrayStrings(
        [...(pendingSafetyAdvisory.reason_codes || []), ...(incoming.reason_codes || [])],
        6,
      ),
    };
  }

  function resolveSafetyGateAction({
    safety,
    profileValue,
    conflictIntent,
    language,
    pushGateDecision,
  } = {}) {
    const pushGateDecisionFn = requireFunction('pushGateDecision', pushGateDecision);
    const s = safety && typeof safety === 'object' ? safety : null;
    if (!s) return { mode: 'bypass', advisory: null, ask_once_fields: [] };
    const blockLevel = String(s.block_level || '').trim();
    if (!blockLevel || blockLevel === BLOCK_LEVEL.INFO) {
      return { mode: 'bypass', advisory: null, ask_once_fields: [] };
    }

    const requiredFields = (Array.isArray(s.required_fields) ? s.required_fields : [])
      .map((field) => String(field || '').trim())
      .filter(Boolean);
    const optionalRequiredFields = requiredFields.filter((field) => OPTIONAL_SAFETY_PROFILE_FIELDS.includes(field));
    const missingOptionalFields = optionalRequiredFields.filter(
      (field) => !profileHasOptionalSafetyFieldValue(profileValue, field),
    );
    const safetyPromptState = normalizeSafetyPromptStateForChat(
      profileValue && profileValue.safetyPromptState ? profileValue.safetyPromptState : null,
    );
    const unaskedOptionalFields = missingOptionalFields.filter(
      (field) => !Boolean(safetyPromptState.asked_once_fields[field]),
    );

    const reasonCodes = Array.isArray(s.reason_codes) ? s.reason_codes.slice(0, 6) : [];
    const policyDecision =
      blockLevel === BLOCK_LEVEL.BLOCK
        ? pushGateDecisionFn('safety_hard_block', {
          is_hard_contraindication: true,
          reason_codes: reasonCodes,
        })
        : pushGateDecisionFn('safety_optional_profile', {
          is_hard_contraindication: false,
          reason_codes: reasonCodes,
        });
    const policyMode = policyDecision && typeof policyDecision.mode === 'string' ? policyDecision.mode : GATE_MODE.BYPASS;
    const effectiveMode =
      conflictIntent && policyMode === GATE_MODE.BLOCK
        ? GATE_MODE.ADVISORY
        : policyMode;
    if (effectiveMode === GATE_MODE.BLOCK) return { mode: 'block', advisory: null, ask_once_fields: [] };
    if (effectiveMode !== GATE_MODE.ADVISORY) return { mode: 'bypass', advisory: null, ask_once_fields: [] };

    const lang = String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
    const safetyQuestions = Array.isArray(s.required_questions) ? s.required_questions : [];
    const firstQuestion = safetyQuestions[0] || (lang === 'CN'
      ? '请先补充一个安全信息（可选）。'
      : 'Please share one optional safety detail.');
    const noticePrefix = buildSafetyNoticeText({ safety: s, language: lang });
    const followup =
      unaskedOptionalFields.length > 0
        ? firstQuestion
        : lang === 'CN'
          ? '你可以稍后在 Profile 里补充可选安全信息，我会继续给出保守建议。'
          : 'You can add optional safety details in Profile later; I will continue with conservative assumptions.';
    const message = [noticePrefix, followup].filter(Boolean).join('\n\n');
    const chips = unaskedOptionalFields.length > 0
      ? buildSafetyAdvisoryChipsByField({
        field: unaskedOptionalFields[0],
        language: lang,
      })
      : [];
    const assumptions = missingOptionalFields.map((field) =>
      field === 'pregnancy_status'
        ? 'pregnancy_status unknown'
        : field === 'age_band'
          ? 'age_band unknown'
          : 'high_risk_medications unknown',
    );
    const advisory = {
      reason: 'safety_optional_profile_missing',
      non_blocking: true,
      severity: blockLevel === BLOCK_LEVEL.BLOCK ? 'block' : 'warn',
      message,
      details: Array.isArray(s.reasons) ? s.reasons.slice(0, 4) : [],
      assumptions: assumptions.slice(0, 3),
      actions: ['update_optional_profile', 'continue_conservative_mode'],
      chips,
      missing_optional_fields: missingOptionalFields,
      required_question: firstQuestion,
      reason_codes: Array.isArray(s.reason_codes) ? s.reason_codes.slice(0, 4) : [],
    };
    return { mode: 'inline', advisory, ask_once_fields: unaskedOptionalFields };
  }

  async function persistSafetyPromptAskedOnce({ fields, profile, identity } = {}) {
    const targets = (Array.isArray(fields) ? fields : [])
      .map((field) => String(field || '').trim())
      .filter((field) => OPTIONAL_SAFETY_PROFILE_FIELDS.includes(field));
    if (!targets.length) return profile;

    const normalizeSafetyPromptStateForChatFn = requireFunction(
      'normalizeSafetyPromptStateForChat',
      normalizeSafetyPromptStateForChat,
    );
    const current = normalizeSafetyPromptStateForChatFn(profile && profile.safetyPromptState);
    const nextAsked = { ...(current.asked_once_fields || {}) };
    let changed = false;
    for (const field of targets) {
      if (nextAsked[field] === true) continue;
      nextAsked[field] = true;
      changed = true;
    }
    if (!changed) return profile;

    const nextState = {
      asked_once_fields: nextAsked,
      asked_at_ms: Date.now(),
    };
    let nextProfile = { ...(profile || {}), safetyPromptState: nextState };
    try {
      const upsertProfileForIdentityFn = requireFunction('upsertProfileForIdentity', upsertProfileForIdentity);
      const saved = await upsertProfileForIdentityFn(normalizeIdentity(identity), {
        safetyPromptState: nextState,
      });
      if (saved && typeof saved === 'object') nextProfile = saved;
    } catch (err) {
      logger?.warn?.(
        { err: err && (err.code || err.message) ? err.code || err.message : String(err) },
        'aurora bff: failed to persist safety prompt state',
      );
    }
    return nextProfile;
  }

  return {
    buildSafetyNoticeText,
    applyPendingSafetyAdvisoryToEnvelope,
    enqueueGateAdvisory,
    applyPendingGateAdvisoriesToEnvelope,
    mergePendingSafetyAdvisory,
    resolveSafetyGateAction,
    persistSafetyPromptAskedOnce,
  };
}

module.exports = {
  createChatAdvisoryRuntime,
};
