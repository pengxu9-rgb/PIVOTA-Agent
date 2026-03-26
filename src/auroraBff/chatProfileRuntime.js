function createChatProfileRuntime(options = {}) {
  const {
    logger = null,
    isPlainObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value),
    resolveIdentity,
    getProfileForIdentity,
    getRecentSkinLogsForIdentity,
    getChatContextForIdentity,
    recordProfileContextMissing = () => {},
    extractProfilePatchFromSession,
    parseProfilePatchFromAction,
    UserProfilePatchSchema,
    upsertProfileForIdentity,
    derivePregnancyPolicyPatch,
    utcTodayIsoDate = () => new Date().toISOString().slice(0, 10),
    makeEvent,
    extractProfilePatchFromFreeText,
    recordAuroraProfileAutoPatch = () => {},
    shouldPersistProfilePatch = () => true,
    extractTrackerLogFromFreeText,
    upsertSkinLogForIdentity,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat profile runtime missing dependency: ${name}`);
  }

  function requireSchema(name, value) {
    if (value && typeof value.safeParse === 'function') return value;
    throw new Error(`aurora chat profile runtime missing schema: ${name}`);
  }

  function normalizeIdentity(identity) {
    return {
      auroraUid: identity && identity.auroraUid ? identity.auroraUid : null,
      userId: identity && identity.userId ? identity.userId : null,
    };
  }

  async function persistProfilePatch(identity, patch, warnMessage) {
    if (!isPlainObject(patch) || Object.keys(patch).length === 0) return null;
    const upsertProfileForIdentityFn = requireFunction('upsertProfileForIdentity', upsertProfileForIdentity);
    try {
      return await upsertProfileForIdentityFn(normalizeIdentity(identity), patch);
    } catch (err) {
      logger?.warn?.({ err: err && (err.code || err.message) ? err.code || err.message : String(err) }, warnMessage);
      return null;
    }
  }

  async function loadIdentityContext({ req, ctx, session, recentLogLimit = 7 } = {}) {
    const resolveIdentityFn = requireFunction('resolveIdentity', resolveIdentity);
    const getProfileForIdentityFn = requireFunction('getProfileForIdentity', getProfileForIdentity);
    const getRecentSkinLogsForIdentityFn = requireFunction('getRecentSkinLogsForIdentity', getRecentSkinLogsForIdentity);
    const getChatContextForIdentityFn = requireFunction('getChatContextForIdentity', getChatContextForIdentity);
    const extractProfilePatchFromSessionFn = requireFunction(
      'extractProfilePatchFromSession',
      extractProfilePatchFromSession,
    );

    const identity = await resolveIdentityFn(req, ctx);
    let profile = null;
    let recentLogs = [];
    let chatContext = null;
    let storageContextLoadFailed = false;
    try {
      profile = await getProfileForIdentityFn(normalizeIdentity(identity));
      recentLogs = await getRecentSkinLogsForIdentityFn(normalizeIdentity(identity), recentLogLimit);
      chatContext = await getChatContextForIdentityFn(normalizeIdentity(identity));
    } catch (err) {
      storageContextLoadFailed = true;
      logger?.warn?.(
        { err: err && (err.code || err.message) ? err.code || err.message : String(err) },
        'aurora bff: failed to load memory context',
      );
    }
    if (storageContextLoadFailed) {
      recordProfileContextMissing({ side: 'backend' });
    }

    const profilePatchFromSession = extractProfilePatchFromSessionFn(session);
    if (!profilePatchFromSession) {
      recordProfileContextMissing({ side: 'frontend' });
    }
    if (profilePatchFromSession) {
      profile = { ...(profile || {}), ...profilePatchFromSession };
    }
    if (
      !chatContext &&
      profile &&
      typeof profile === 'object' &&
      !Array.isArray(profile) &&
      profile.chatContext &&
      typeof profile.chatContext === 'object' &&
      !Array.isArray(profile.chatContext)
    ) {
      chatContext = profile.chatContext;
    }

    return {
      identity,
      profile,
      recentLogs,
      chatContext,
      storageContextLoadFailed,
      profilePatchFromSession,
    };
  }

  async function applyProfilePatchFromAction({ identity, normalizedActionPayload, profile } = {}) {
    const parseProfilePatchFromActionFn = requireFunction(
      'parseProfilePatchFromAction',
      parseProfilePatchFromAction,
    );
    const userProfilePatchSchema = requireSchema('UserProfilePatchSchema', UserProfilePatchSchema);
    const profilePatchFromAction = parseProfilePatchFromActionFn(normalizedActionPayload);
    if (!profilePatchFromAction) {
      return {
        profile,
        appliedProfilePatch: null,
      };
    }

    const patchParsed = userProfilePatchSchema.safeParse(profilePatchFromAction);
    if (!patchParsed.success) {
      return {
        profile,
        appliedProfilePatch: null,
      };
    }

    const appliedProfilePatch = patchParsed.data;
    let nextProfile = { ...(profile || {}), ...appliedProfilePatch };
    const saved = await persistProfilePatch(
      identity,
      appliedProfilePatch,
      'aurora bff: failed to apply profile chip patch',
    );
    if (saved && typeof saved === 'object') nextProfile = saved;
    return {
      profile: nextProfile,
      appliedProfilePatch,
    };
  }

  async function applyPregnancyPolicy({ ctx, identity, profile, message, appliedProfilePatch } = {}) {
    const derivePregnancyPolicyPatchFn = requireFunction('derivePregnancyPolicyPatch', derivePregnancyPolicyPatch);
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const pregnancyPolicy = derivePregnancyPolicyPatchFn({
      profile,
      message,
      todayUtc: utcTodayIsoDate(),
    });
    const pendingPregnancyPolicyEvents =
      pregnancyPolicy && Array.isArray(pregnancyPolicy.events)
        ? pregnancyPolicy.events.map((evt) =>
            makeEventFn(ctx, evt.event_name, evt && evt.data && typeof evt.data === 'object' ? evt.data : {}),
          )
        : [];
    if (!(pregnancyPolicy && pregnancyPolicy.patch)) {
      return {
        profile,
        appliedProfilePatch,
        pendingPregnancyPolicyEvents,
        pregnancyPolicy,
      };
    }

    const mergedPatch = {
      ...(appliedProfilePatch && typeof appliedProfilePatch === 'object' ? appliedProfilePatch : {}),
      ...pregnancyPolicy.patch,
    };
    let nextProfile = { ...(profile || {}), ...pregnancyPolicy.patch };
    const saved = await persistProfilePatch(
      identity,
      pregnancyPolicy.patch,
      'aurora bff: failed to persist pregnancy policy patch',
    );
    if (saved && typeof saved === 'object') nextProfile = saved;
    return {
      profile: nextProfile,
      appliedProfilePatch: mergedPatch,
      pendingPregnancyPolicyEvents,
      pregnancyPolicy,
    };
  }

  async function applyTextDerivedProfilePatch({
    ctx,
    identity,
    profile,
    message,
    canonicalIntent,
    appliedProfilePatch,
  } = {}) {
    const extractProfilePatchFromFreeTextFn = requireFunction(
      'extractProfilePatchFromFreeText',
      extractProfilePatchFromFreeText,
    );
    const textDerivedPatch = extractProfilePatchFromFreeTextFn({ message, canonicalIntent });
    if (!textDerivedPatch) {
      return {
        profile,
        appliedProfilePatch,
        textDerivedProfilePatch: null,
      };
    }

    const profileBeforePatch = profile && typeof profile === 'object' ? profile : null;
    const normalizedPatch = {
      ...textDerivedPatch,
      ...(textDerivedPatch.travel_plan && typeof textDerivedPatch.travel_plan === 'object'
        ? {
            travel_plan: {
              ...(profileBeforePatch &&
              profileBeforePatch.travel_plan &&
              typeof profileBeforePatch.travel_plan === 'object' &&
              !Array.isArray(profileBeforePatch.travel_plan)
                ? profileBeforePatch.travel_plan
                : {}),
              ...textDerivedPatch.travel_plan,
            },
          }
        : {}),
    };

    let nextProfile = { ...(profile || {}), ...normalizedPatch };
    const mergedPatch = {
      ...(appliedProfilePatch && typeof appliedProfilePatch === 'object' ? appliedProfilePatch : {}),
      ...normalizedPatch,
    };
    const patchFields = Object.keys(normalizedPatch);
    for (const field of patchFields) {
      recordAuroraProfileAutoPatch({ field, outcome: 'applied' });
      const beforeValue =
        profileBeforePatch && Object.prototype.hasOwnProperty.call(profileBeforePatch, field)
          ? profileBeforePatch[field]
          : undefined;
      const afterValue = normalizedPatch[field];
      if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
        recordAuroraProfileAutoPatch({ field, outcome: 'corrected' });
      }
    }

    const shouldPersist = shouldPersistProfilePatch(profileBeforePatch, normalizedPatch);
    if (shouldPersist) {
      const saved = await persistProfilePatch(
        identity,
        normalizedPatch,
        'aurora bff: failed to apply text-derived profile patch',
      );
      if (saved && typeof saved === 'object') {
        nextProfile = saved;
      }
      for (const field of patchFields) {
        recordAuroraProfileAutoPatch({ field, outcome: saved ? 'persisted' : 'persist_error' });
      }
    } else {
      for (const field of patchFields) {
        recordAuroraProfileAutoPatch({ field, outcome: 'skipped' });
      }
    }

    return {
      profile: nextProfile,
      appliedProfilePatch: mergedPatch,
      textDerivedProfilePatch: normalizedPatch,
    };
  }

  async function applyTextDerivedSkinLog({ identity, recentLogs, message } = {}) {
    const extractTrackerLogFromFreeTextFn = requireFunction(
      'extractTrackerLogFromFreeText',
      extractTrackerLogFromFreeText,
    );
    const upsertSkinLogForIdentityFn = requireFunction('upsertSkinLogForIdentity', upsertSkinLogForIdentity);
    const textDerivedSkinLog = extractTrackerLogFromFreeTextFn({ message });
    if (!textDerivedSkinLog) {
      return {
        recentLogs,
        textDerivedSkinLog: null,
      };
    }

    try {
      const savedLog = await upsertSkinLogForIdentityFn(normalizeIdentity(identity), textDerivedSkinLog);
      recordAuroraProfileAutoPatch({ field: 'recentLogs', outcome: 'persisted' });
      return {
        recentLogs: [savedLog, ...(Array.isArray(recentLogs) ? recentLogs : [])].slice(0, 7),
        textDerivedSkinLog,
      };
    } catch (err) {
      recordAuroraProfileAutoPatch({ field: 'recentLogs', outcome: 'persist_error' });
      logger?.warn?.(
        { err: err && (err.code || err.message) ? err.code || err.message : String(err) },
        'aurora bff: failed to persist text-derived tracker log',
      );
      return {
        recentLogs,
        textDerivedSkinLog,
      };
    }
  }

  return {
    loadIdentityContext,
    applyProfilePatchFromAction,
    applyPregnancyPolicy,
    applyTextDerivedProfilePatch,
    applyTextDerivedSkinLog,
  };
}

module.exports = {
  createChatProfileRuntime,
};
