function createProfileSessionRuntime(options = {}) {
  const {
    isPlainObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value),
    tryParseRoutineObject = (value) => {
      if (value == null) return null;
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }
      return value != null && typeof value === 'object' && !Array.isArray(value) ? value : null;
    },
    UserProfilePatchSchema,
    inferGoalFromClarificationText = () => '',
    resolvePreferredLegacyTravelPlan = (profile) => {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
      if (profile.travel_plan && typeof profile.travel_plan === 'object' && !Array.isArray(profile.travel_plan)) {
        return profile.travel_plan;
      }
      if (profile.travelPlan && typeof profile.travelPlan === 'object' && !Array.isArray(profile.travelPlan)) {
        return profile.travelPlan;
      }
      return null;
    },
    INTENT_ENUM = {},
    profileV2EnabledDefault = false,
    resolveIdentity,
    getProfileForIdentity,
    getRecentSkinLogsForIdentity,
    isCheckinDue,
    upsertProfileForIdentity,
    deleteIdentityData,
    deleteHardCasesForIdentity,
    logger = null,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora profile session runtime missing dependency: ${name}`);
  }

  function extractLatestArtifactIdFromSession(session) {
    if (!session || typeof session !== 'object' || Array.isArray(session)) return null;
    const state = session.state && typeof session.state === 'object' && !Array.isArray(session.state) ? session.state : null;
    if (!state) return null;
    const artifactId = String(state.latest_artifact_id || '').trim();
    return artifactId || null;
  }

  function appendLatestArtifactToSessionPatch(sessionPatch, artifactId) {
    if (!sessionPatch || typeof sessionPatch !== 'object') return;
    const id = String(artifactId || '').trim();
    if (!id) return;
    const state = isPlainObject(sessionPatch.state) ? { ...sessionPatch.state } : {};
    state.latest_artifact_id = id;
    sessionPatch.state = state;
  }

  function normalizeRecoSourceDetail(raw) {
    const token = String(raw || '').trim().toLowerCase();
    if (token === 'goal_driven' || token === 'ingredient_driven' || token === 'profile_refine_rerun') return token;
    return 'goal_driven';
  }

  function sanitizeRecoRequestContext(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const message = String(raw.message || '').trim();
    const actionId = String(raw.action_id || '').trim();
    const sourceDetail = normalizeRecoSourceDetail(raw.source_detail || raw.sourceDetail);
    const intent = String(raw.intent || '').trim().toLowerCase();
    const triggerSource = String(raw.trigger_source || raw.triggerSource || '').trim().toLowerCase();
    const ingredientQuery = String(raw.ingredient_query || raw.ingredientQuery || '').trim();
    const goal = String(raw.goal || '').trim();
    const createdAtMsRaw = Number(raw.created_at_ms || raw.createdAtMs);
    const createdAtMs = Number.isFinite(createdAtMsRaw) ? Math.max(0, Math.trunc(createdAtMsRaw)) : Date.now();
    const includeAlternatives = raw.include_alternatives === true;
    const out = {
      source_detail: sourceDetail,
      intent: intent || 'reco_products',
      trigger_source: triggerSource || 'chat',
      created_at_ms: createdAtMs,
      include_alternatives: includeAlternatives,
    };
    if (message) out.message = message.slice(0, 240);
    if (actionId) out.action_id = actionId.slice(0, 120);
    if (ingredientQuery) out.ingredient_query = ingredientQuery.slice(0, 120);
    if (goal) out.goal = goal.slice(0, 80);
    return out;
  }

  function extractLatestRecoContextFromSession(session) {
    if (!session || typeof session !== 'object' || Array.isArray(session)) return null;
    const state = isPlainObject(session.state) ? session.state : null;
    if (!state) return null;
    const context = sanitizeRecoRequestContext(
      state.latest_reco_context && typeof state.latest_reco_context === 'object'
        ? state.latest_reco_context
        : null,
    );
    if (!context) return null;
    return context;
  }

  function appendLatestRecoContextToSessionPatch(sessionPatch, context) {
    if (!sessionPatch || typeof sessionPatch !== 'object') return;
    const normalized = sanitizeRecoRequestContext(context);
    if (!normalized) return;
    const state = isPlainObject(sessionPatch.state) ? { ...sessionPatch.state } : {};
    state.latest_reco_context = normalized;
    sessionPatch.state = state;
  }

  function extractProfilePatchFromSession(session) {
    const s = session && typeof session === 'object' ? session : null;
    if (!s) return null;

    const rawProfile =
      (s.profile_patch && typeof s.profile_patch === 'object' ? s.profile_patch : null) ||
      (s.profilePatch && typeof s.profilePatch === 'object' ? s.profilePatch : null) ||
      (s.profile && typeof s.profile === 'object' ? s.profile : null) ||
      null;
    if (!rawProfile) return null;

    const patch = {};
    const mergeMissingPatchFields = (target, source) => {
      const base = target && typeof target === 'object' ? target : {};
      const extra = source && typeof source === 'object' ? source : null;
      if (!extra) return base;
      if (!base.skinType && typeof extra.skinType === 'string' && extra.skinType.trim()) base.skinType = extra.skinType.trim();
      if (!base.sensitivity && typeof extra.sensitivity === 'string' && extra.sensitivity.trim()) base.sensitivity = extra.sensitivity.trim();
      if (!base.barrierStatus && typeof extra.barrierStatus === 'string' && extra.barrierStatus.trim()) {
        base.barrierStatus = extra.barrierStatus.trim();
      }
      if ((!Array.isArray(base.goals) || base.goals.length === 0) && Array.isArray(extra.goals) && extra.goals.length) {
        base.goals = extra.goals.slice(0, 12);
      }
      return base;
    };

    const copyString = (toKey, ...fromKeys) => {
      for (const key of fromKeys) {
        const value = rawProfile[key];
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (!trimmed) continue;
        patch[toKey] = trimmed;
        return;
      }
    };
    copyString('skinType', 'skinType', 'skin_type');
    copyString('sensitivity', 'sensitivity');
    copyString('barrierStatus', 'barrierStatus', 'barrier_status');
    copyString('region', 'region');
    copyString('budgetTier', 'budgetTier', 'budget_tier');
    copyString('age_band', 'age_band', 'ageBand');
    copyString('pregnancy_status', 'pregnancy_status', 'pregnancyStatus');
    copyString('lactation_status', 'lactation_status', 'lactationStatus');
    const dropUnknownOptionalSafetyField = (key) => {
      const raw = patch[key];
      if (typeof raw !== 'string') return;
      if (raw.trim().toLowerCase() !== 'unknown') return;
      delete patch[key];
    };
    dropUnknownOptionalSafetyField('age_band');
    dropUnknownOptionalSafetyField('pregnancy_status');
    dropUnknownOptionalSafetyField('lactation_status');
    const pregnancyDueDateRaw =
      typeof rawProfile.pregnancy_due_date === 'string'
        ? rawProfile.pregnancy_due_date
        : typeof rawProfile.pregnancyDueDate === 'string'
          ? rawProfile.pregnancyDueDate
          : '';
    const pregnancyDueDate = pregnancyDueDateRaw.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(pregnancyDueDate)) patch.pregnancy_due_date = pregnancyDueDate;

    if (Array.isArray(rawProfile.goals)) {
      const goals = rawProfile.goals
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
        .slice(0, 12);
      if (goals.length) patch.goals = goals;
    }
    if (Array.isArray(rawProfile.contraindications)) {
      const contraindications = rawProfile.contraindications
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
        .slice(0, 24);
      if (contraindications.length) patch.contraindications = contraindications;
    }
    if (Array.isArray(rawProfile.high_risk_medications)) {
      const medications = rawProfile.high_risk_medications
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
        .slice(0, 30);
      if (medications.length) patch.high_risk_medications = medications;
    }

    if (rawProfile.currentRoutine != null) patch.currentRoutine = rawProfile.currentRoutine;
    if (rawProfile.current_routine != null) patch.currentRoutine = rawProfile.current_routine;
    if (rawProfile.itinerary != null) patch.itinerary = rawProfile.itinerary;
    if (rawProfile.travel_plan && typeof rawProfile.travel_plan === 'object' && !Array.isArray(rawProfile.travel_plan)) {
      patch.travel_plan = rawProfile.travel_plan;
    }
    if (rawProfile.travelPlan && typeof rawProfile.travelPlan === 'object' && !Array.isArray(rawProfile.travelPlan)) {
      patch.travel_plan = rawProfile.travelPlan;
    }
    mergeMissingPatchFields(patch, extractProfilePatchFromRoutinePayload(patch.currentRoutine));

    const parsed = UserProfilePatchSchema.safeParse(patch);
    if (!parsed.success) return null;
    const clean = parsed.data;
    return Object.keys(clean).length ? clean : null;
  }

  function extractProfilePatchFromRoutinePayload(routineInput) {
    const routineRoot = tryParseRoutineObject(routineInput) || (isPlainObject(routineInput) ? routineInput : null);
    if (!routineRoot) return null;

    const candidates = [];
    const visited = new Set();
    const visit = (node, depth = 0) => {
      if (depth > 3 || !isPlainObject(node) || visited.has(node)) return;
      visited.add(node);
      candidates.push(node);
      for (const key of ['profile', 'profile_patch', 'profilePatch', 'skin_profile', 'skinProfile', 'goal_profile', 'goalProfile', 'meta', 'metadata', 'context']) {
        visit(node[key], depth + 1);
      }
    };
    visit(routineRoot);

    const readString = (...aliases) => {
      for (const node of candidates) {
        for (const alias of aliases) {
          const value = node && typeof node === 'object' ? node[alias] : null;
          if (typeof value !== 'string') continue;
          const trimmed = value.trim();
          if (!trimmed) continue;
          return trimmed;
        }
      }
      return '';
    };

    const readGoalArray = () => {
      const out = [];
      const seen = new Set();
      const pushGoal = (value) => {
        const normalized = typeof value === 'string' ? value.trim() : '';
        if (!normalized) return;
        const key = normalized.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(normalized);
      };

      for (const node of candidates) {
        for (const alias of ['goals', 'selected_goals', 'selectedGoals', 'pending_goals', 'pendingGoals']) {
          const values = node && typeof node === 'object' ? node[alias] : null;
          if (!Array.isArray(values)) continue;
          values.forEach(pushGoal);
        }
        pushGoal(node && typeof node === 'object' ? node.custom_input : null);
        pushGoal(node && typeof node === 'object' ? node.customInput : null);
      }

      return out.slice(0, 12);
    };

    const patch = {};
    const skinType = readString('skinType', 'skin_type', 'skin_type_tendency', 'skinTypeTendency');
    if (skinType) patch.skinType = skinType;
    const sensitivity = readString('sensitivity', 'sensitivity_level', 'sensitivityLevel', 'sensitivity_tendency', 'sensitivityTendency');
    if (sensitivity) patch.sensitivity = sensitivity;
    const barrierStatus = readString('barrierStatus', 'barrier_status', 'barrier', 'barrier_state', 'barrierState');
    if (barrierStatus) patch.barrierStatus = barrierStatus;
    const goals = readGoalArray();
    if (goals.length) patch.goals = goals;

    const parsed = UserProfilePatchSchema.safeParse(patch);
    if (!parsed.success) return null;
    const clean = parsed.data;
    return Object.keys(clean).length ? clean : null;
  }

  function parseTravelTimeWindowFromText(message) {
    const text = String(message || '').trim();
    if (!text) return null;
    if (/下周|\bnext\s+week\b/i.test(text)) return 'next_week';
    if (/这周|\bthis\s+week\b/i.test(text)) return 'this_week';
    if (/下个月|\bnext\s+month\b/i.test(text)) return 'next_month';
    if (/这个月|\bthis\s+month\b/i.test(text)) return 'this_month';
    if (/周末|\bweekend\b/i.test(text)) return 'weekend';
    if (/明天|\btomorrow\b/i.test(text)) return 'tomorrow';
    if (/今天|\btoday\b/i.test(text)) return 'today';
    if (/travel|trip|itinerary|出差|旅行/i.test(text)) return 'unknown';
    return null;
  }

  function normalizePregnancyStatusForPolicy(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return 'unknown';
    if (raw === 'not_pregnant' || raw === 'pregnant' || raw === 'trying' || raw === 'unknown') return raw;
    if (/not[_\s-]?pregnant/.test(raw)) return 'not_pregnant';
    if (/pregnan|怀孕|孕/.test(raw)) return 'pregnant';
    if (/trying|ttc|备孕|准备怀孕/.test(raw)) return 'trying';
    return 'unknown';
  }

  function normalizePregnancyDueDateForPolicy(value) {
    if (value == null) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    return raw;
  }

  function utcTodayIsoDate() {
    return new Date().toISOString().slice(0, 10);
  }

  function derivePregnancyPolicyPatch({ profile, message, todayUtc } = {}) {
    const source = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {};
    const text = String(message || '');
    const nowUtc = normalizePregnancyDueDateForPolicy(todayUtc) || utcTodayIsoDate();
    let status = normalizePregnancyStatusForPolicy(source.pregnancy_status);
    let dueDate = normalizePregnancyDueDateForPolicy(source.pregnancy_due_date);
    const patch = {};
    const events = [];

    const tryingDetected = /\b(trying(\s+to\s+conceive)?|ttc)\b/i.test(text) || /备孕|准备怀孕/.test(text);
    if (tryingDetected && status !== 'trying') {
      status = 'trying';
      patch.pregnancy_status = 'trying';
    }

    if (status !== 'pregnant' && dueDate) {
      dueDate = null;
      patch.pregnancy_due_date = null;
    }

    if (status === 'pregnant' && dueDate && dueDate < nowUtc) {
      status = 'not_pregnant';
      dueDate = null;
      patch.pregnancy_status = 'not_pregnant';
      patch.pregnancy_due_date = null;
      events.push({
        event_name: 'pregnancy_status_auto_reset',
        data: { from: 'pregnant', to: 'not_pregnant', effective_date_utc: nowUtc },
      });
    }

    if (status === 'unknown') {
      patch.pregnancy_status = 'not_pregnant';
      patch.pregnancy_due_date = null;
      events.push({
        event_name: 'pregnancy_status_defaulted',
        data: { default_status: 'not_pregnant', reason: 'missing_or_unknown', effective_date_utc: nowUtc },
      });
    }

    return {
      patch: Object.keys(patch).length > 0 ? patch : null,
      events,
    };
  }

  function extractProfilePatchFromFreeText({ message, canonicalIntent } = {}) {
    const text = String(message || '').trim();
    if (!text) return null;
    const lower = text.toLowerCase();
    const patch = {};

    if (/(怀孕|孕期|孕妇|妊娠|孕\s*\d+\s*周|\bpregnan(t|cy)\b|\b\d+\s*weeks?\s*pregnant\b)/i.test(text)) {
      patch.pregnancy_status = 'pregnant';
    } else if (/备孕|准备怀孕|trying to conceive|ttc/i.test(text)) {
      patch.pregnancy_status = 'trying';
    } else if (/未怀孕|没怀孕|\bnot\s+pregnant\b/i.test(text)) {
      patch.pregnancy_status = 'not_pregnant';
    }

    if (/哺乳|母乳|正在喂奶|breastfeed|breastfeeding|lactat/i.test(text)) {
      patch.lactation_status = 'lactating';
    } else if (/不哺乳|未哺乳|not\s+lactating|not\s+breastfeeding/i.test(lower)) {
      patch.lactation_status = 'not_lactating';
    }

    if (/(油皮|油性|出油|oily\b|very oily|greasy)/i.test(text)) {
      patch.skinType = 'oily';
    } else if (/(干皮|干性|起皮|紧绷|dry skin|very dry|dry\b)/i.test(text)) {
      patch.skinType = 'dry';
    } else if (/(混合皮|混合性|t区|combination|combo)/i.test(text)) {
      patch.skinType = 'combination';
    } else if (/(中性皮|normal skin|normal\b)/i.test(text)) {
      patch.skinType = 'normal';
    } else if (/(敏感肌|敏感性皮肤|sensitive skin)/i.test(text)) {
      patch.skinType = 'sensitive';
    }

    if (/(高敏|敏感严重|very sensitive|high sensitivity|easily irritated)/i.test(text)) {
      patch.sensitivity = 'high';
    } else if (/(低敏|不敏感|not sensitive|low sensitivity|resilient)/i.test(text)) {
      patch.sensitivity = 'low';
    } else if (/(中敏|medium sensitivity|moderately sensitive)/i.test(text)) {
      patch.sensitivity = 'medium';
    }

    if (/(屏障受损|屏障不稳|刺痛|泛红|barrier impaired|barrier damaged|stinging|burning|reactive)/i.test(text)) {
      patch.barrierStatus = 'impaired';
    } else if (/(屏障稳定|状态稳定|barrier healthy|barrier stable|well tolerated)/i.test(text)) {
      patch.barrierStatus = 'healthy';
    }

    const inferredGoal = inferGoalFromClarificationText(text);
    if (inferredGoal) {
      patch.goals = Array.from(new Set([...(Array.isArray(patch.goals) ? patch.goals : []), inferredGoal])).slice(0, 4);
    }

    const routineMatch =
      text.match(/(?:current routine|my routine|现在在用|目前在用|当前用的是|routine[:：])\s*([^\n]{4,260})/i) ||
      text.match(/(?:am|pm|早上|晚上).{0,160}(?:cleanser|serum|cream|spf|洁面|精华|面霜|防晒)/i);
    if (routineMatch) {
      const routineText = String(routineMatch[1] || routineMatch[0] || '').trim();
      if (routineText) patch.currentRoutine = routineText.slice(0, 500);
    }

    const travelEntities = canonicalIntent && canonicalIntent.entities && typeof canonicalIntent.entities === 'object'
      ? canonicalIntent.entities
      : {};
    const looksTravel =
      canonicalIntent &&
      (canonicalIntent.intent === INTENT_ENUM.TRAVEL_PLANNING || canonicalIntent.intent === INTENT_ENUM.WEATHER_ENV);
    if (looksTravel || /出差|旅行|飞行|flight|trip|itinerary|weather|climate|天气|气候/i.test(text)) {
      const baseTravel = {};
      if (typeof travelEntities.destination === 'string' && travelEntities.destination.trim()) {
        baseTravel.destination = travelEntities.destination.trim().slice(0, 100);
      }
      if (travelEntities.date_range && typeof travelEntities.date_range === 'object') {
        if (typeof travelEntities.date_range.start === 'string' && travelEntities.date_range.start.trim()) {
          baseTravel.start_date = travelEntities.date_range.start.trim().slice(0, 20);
        }
        if (typeof travelEntities.date_range.end === 'string' && travelEntities.date_range.end.trim()) {
          baseTravel.end_date = travelEntities.date_range.end.trim().slice(0, 20);
        }
      }
      const inferredWindow =
        (typeof travelEntities.time_window === 'string' && travelEntities.time_window.trim()) ||
        parseTravelTimeWindowFromText(text);
      if (inferredWindow) baseTravel.time_window = String(inferredWindow).trim().slice(0, 20);
      if (Object.keys(baseTravel).length) patch.travel_plan = baseTravel;
    }

    const parsed = UserProfilePatchSchema.safeParse(patch);
    if (!parsed.success) return null;
    const clean = parsed.data;
    return Object.keys(clean).length ? clean : null;
  }

  function profileHasOptionalSafetyFieldValue(profile, field) {
    const source = profile && typeof profile === 'object' ? profile : {};
    if (field === 'high_risk_medications') {
      return Array.isArray(source.high_risk_medications);
    }
    if (field === 'pregnancy_status' || field === 'age_band') {
      const value = typeof source[field] === 'string' ? source[field].trim().toLowerCase() : '';
      return Boolean(value) && value !== 'unknown';
    }
    return false;
  }

  function summarizeProfileForContext(profile, options = {}) {
    if (!profile) return null;
    const includeProfileV2 =
      Object.prototype.hasOwnProperty.call(options, 'profileV2Enabled')
        ? Boolean(options.profileV2Enabled)
        : Boolean(profileV2EnabledDefault);
    const currentRoutineRaw = profile.currentRoutine;
    let currentRoutine = null;
    if (typeof currentRoutineRaw === 'string') {
      const trimmed = currentRoutineRaw.trim();
      currentRoutine = trimmed ? trimmed.slice(0, 4000) : null;
    } else if (currentRoutineRaw && typeof currentRoutineRaw === 'object') {
      try {
        const json = JSON.stringify(currentRoutineRaw);
        currentRoutine = json.length > 5000 ? `${json.slice(0, 5000)}…` : json;
      } catch {
        currentRoutine = null;
      }
    }

    const itineraryRaw = profile.itinerary;
    let itinerary = null;
    if (typeof itineraryRaw === 'string') {
      const trimmed = itineraryRaw.trim();
      itinerary = trimmed ? trimmed.slice(0, 1200) : null;
    } else if (itineraryRaw && typeof itineraryRaw === 'object') {
      try {
        const json = JSON.stringify(itineraryRaw);
        itinerary = json.length > 1500 ? `${json.slice(0, 1500)}…` : json;
      } catch {
        itinerary = null;
      }
    }

    const contraindications = Array.isArray(profile.contraindications)
      ? profile.contraindications.filter((value) => typeof value === 'string' && value.trim()).slice(0, 12)
      : [];
    const highRiskMedications = Array.isArray(profile.high_risk_medications)
      ? profile.high_risk_medications.filter((value) => typeof value === 'string' && value.trim()).slice(0, 16)
      : [];

    const travelPlanRaw = resolvePreferredLegacyTravelPlan(profile);
    const travelPlan = travelPlanRaw
      ? {
        ...(typeof travelPlanRaw.destination === 'string' && travelPlanRaw.destination.trim()
          ? { destination: travelPlanRaw.destination.trim().slice(0, 100) }
          : {}),
        ...(typeof travelPlanRaw.start_date === 'string' && travelPlanRaw.start_date.trim()
          ? { start_date: travelPlanRaw.start_date.trim().slice(0, 20) }
          : {}),
        ...(typeof travelPlanRaw.end_date === 'string' && travelPlanRaw.end_date.trim()
          ? { end_date: travelPlanRaw.end_date.trim().slice(0, 20) }
          : {}),
        ...(typeof travelPlanRaw.time_window === 'string' && travelPlanRaw.time_window.trim()
          ? { time_window: travelPlanRaw.time_window.trim().slice(0, 20) }
          : {}),
        ...(Number.isFinite(Number(travelPlanRaw.indoor_outdoor_ratio))
          ? { indoor_outdoor_ratio: Math.max(0, Math.min(1, Number(travelPlanRaw.indoor_outdoor_ratio))) }
          : {}),
      }
      : null;

    return {
      skinType: profile.skinType || null,
      sensitivity: profile.sensitivity || null,
      barrierStatus: profile.barrierStatus || null,
      goals: Array.isArray(profile.goals) ? profile.goals : [],
      region: profile.region || null,
      budgetTier: profile.budgetTier || null,
      currentRoutine,
      itinerary,
      contraindications,
      ...(includeProfileV2
        ? {
          age_band: profile.age_band || 'unknown',
          pregnancy_status: profile.pregnancy_status || 'unknown',
          pregnancy_due_date: normalizePregnancyDueDateForPolicy(profile.pregnancy_due_date),
          lactation_status: profile.lactation_status || 'unknown',
          high_risk_medications: highRiskMedications,
          travel_plan: travelPlan,
        }
        : {}),
    };
  }

  async function loadIdentityProfileSnapshot(req, ctx, recentLogLimit = 7) {
    const resolveIdentityFn = requireFunction('resolveIdentity', resolveIdentity);
    const getProfileForIdentityFn = requireFunction('getProfileForIdentity', getProfileForIdentity);
    const getRecentSkinLogsForIdentityFn = requireFunction(
      'getRecentSkinLogsForIdentity',
      getRecentSkinLogsForIdentity,
    );
    const isCheckinDueFn = requireFunction('isCheckinDue', isCheckinDue);

    const identity = await resolveIdentityFn(req, ctx);
    let profile = null;
    let recentLogs = [];
    let dbError = null;
    try {
      profile = await getProfileForIdentityFn({ auroraUid: identity.auroraUid, userId: identity.userId });
      recentLogs = await getRecentSkinLogsForIdentityFn(
        { auroraUid: identity.auroraUid, userId: identity.userId },
        recentLogLimit,
      );
    } catch (err) {
      dbError = err;
    }

    const isReturning = Boolean(profile) || recentLogs.length > 0;
    const checkinDue = isCheckinDueFn(recentLogs);
    return {
      identity,
      profile,
      recentLogs,
      dbError,
      isReturning,
      checkinDue,
    };
  }

  function parseProfileUpdateBody(rawBody) {
    const body = isPlainObject(rawBody) ? rawBody : {};
    const derivedProfilePatch = extractProfilePatchFromRoutinePayload(
      body.currentRoutine ?? body.current_routine,
    );
    return UserProfilePatchSchema.safeParse({
      ...(derivedProfilePatch && typeof derivedProfilePatch === 'object' ? derivedProfilePatch : {}),
      ...body,
    });
  }

  async function saveProfilePatchForIdentity(req, ctx, patch) {
    const resolveIdentityFn = requireFunction('resolveIdentity', resolveIdentity);
    const upsertProfileForIdentityFn = requireFunction('upsertProfileForIdentity', upsertProfileForIdentity);
    const identity = await resolveIdentityFn(req, ctx);
    const updated = await upsertProfileForIdentityFn(
      { auroraUid: identity.auroraUid, userId: identity.userId },
      patch,
    );
    return { identity, updated };
  }

  async function deleteProfileForIdentity(req, ctx) {
    const resolveIdentityFn = requireFunction('resolveIdentity', resolveIdentity);
    const deleteIdentityDataFn = requireFunction('deleteIdentityData', deleteIdentityData);
    const deleteHardCasesForIdentityFn = requireFunction(
      'deleteHardCasesForIdentity',
      deleteHardCasesForIdentity,
    );

    const identity = await resolveIdentityFn(req, ctx);
    const result = await deleteIdentityDataFn({ auroraUid: identity.auroraUid, userId: identity.userId });

    try {
      const hardCases = await deleteHardCasesForIdentityFn({
        auroraUid: identity.auroraUid,
        userId: identity.userId,
        logger,
      });
      if (hardCases && hardCases.deleted) {
        logger?.info?.(
          { kind: 'hard_case_delete', request_id: ctx?.request_id || null, deleted: hardCases.deleted },
          'hard case sampler: deleted on profile delete',
        );
      }
    } catch (err) {
      logger?.warn?.(
        { err: err && err.message ? err.message : String(err) },
        'hard case sampler: profile delete cleanup failed',
      );
    }

    return { identity, result };
  }

  return {
    extractLatestArtifactIdFromSession,
    appendLatestArtifactToSessionPatch,
    normalizeRecoSourceDetail,
    extractLatestRecoContextFromSession,
    appendLatestRecoContextToSessionPatch,
    extractProfilePatchFromSession,
    extractProfilePatchFromRoutinePayload,
    normalizePregnancyDueDateForPolicy,
    utcTodayIsoDate,
    derivePregnancyPolicyPatch,
    extractProfilePatchFromFreeText,
    profileHasOptionalSafetyFieldValue,
    summarizeProfileForContext,
    loadIdentityProfileSnapshot,
    parseProfileUpdateBody,
    saveProfilePatchForIdentity,
    deleteProfileForIdentity,
  };
}

module.exports = {
  createProfileSessionRuntime,
};
