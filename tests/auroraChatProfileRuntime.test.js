const { UserProfilePatchSchema } = require('../src/auroraBff/schemas');
const { createChatProfileRuntime } = require('../src/auroraBff/chatProfileRuntime');

function buildRuntime(overrides = {}) {
  return createChatProfileRuntime({
    logger: { warn: jest.fn(), info: jest.fn() },
    isPlainObject: (value) => value != null && typeof value === 'object' && !Array.isArray(value),
    resolveIdentity: jest.fn(async () => ({
      auroraUid: 'uid_chat_profile_1',
      userId: 'user_chat_profile_1',
    })),
    getProfileForIdentity: jest.fn(async () => ({
      skinType: 'oily',
    })),
    getRecentSkinLogsForIdentity: jest.fn(async () => [{ id: 'log_1' }]),
    getChatContextForIdentity: jest.fn(async () => ({ last_intent: 'reco_products' })),
    recordProfileContextMissing: jest.fn(),
    extractProfilePatchFromSession: jest.fn(() => null),
    parseProfilePatchFromAction: jest.fn(() => null),
    UserProfilePatchSchema,
    upsertProfileForIdentity: jest.fn(async (_identity, patch) => ({
      ...patch,
      saved: true,
    })),
    derivePregnancyPolicyPatch: jest.fn(() => null),
    utcTodayIsoDate: jest.fn(() => '2026-03-23'),
    makeEvent: jest.fn((_ctx, eventName, data) => ({ event_name: eventName, data })),
    extractProfilePatchFromFreeText: jest.fn(() => null),
    recordAuroraProfileAutoPatch: jest.fn(),
    shouldPersistProfilePatch: jest.fn(() => true),
    extractTrackerLogFromFreeText: jest.fn(() => null),
    upsertSkinLogForIdentity: jest.fn(async (_identity, log) => ({
      ...log,
      saved: true,
    })),
    ...overrides,
  });
}

describe('createChatProfileRuntime', () => {
  test('loadIdentityContext falls back to profile.chatContext when storage context load fails', async () => {
    const recordProfileContextMissing = jest.fn();
    const getProfileForIdentity = jest.fn(async () => ({
      skinType: 'oily',
      chatContext: { last_intent: 'profile_update' },
    }));
    const getRecentSkinLogsForIdentity = jest.fn(async () => [{ id: 'log_1' }]);
    const getChatContextForIdentity = jest.fn(async () => {
      throw new Error('db down');
    });
    const runtime = buildRuntime({
      recordProfileContextMissing,
      getProfileForIdentity,
      getRecentSkinLogsForIdentity,
      getChatContextForIdentity,
    });

    const result = await runtime.loadIdentityContext({
      req: {},
      ctx: { request_id: 'req_1' },
      session: {},
    });

    expect(result.identity).toEqual({
      auroraUid: 'uid_chat_profile_1',
      userId: 'user_chat_profile_1',
    });
    expect(result.profile).toEqual(
      expect.objectContaining({
        skinType: 'oily',
        chatContext: { last_intent: 'profile_update' },
      }),
    );
    expect(result.chatContext).toEqual({ last_intent: 'profile_update' });
    expect(result.storageContextLoadFailed).toBe(true);
    expect(recordProfileContextMissing).toHaveBeenCalledWith({ side: 'backend' });
    expect(recordProfileContextMissing).toHaveBeenCalledWith({ side: 'frontend' });
  });

  test('applyProfilePatchFromAction validates and persists action patch', async () => {
    const parseProfilePatchFromAction = jest.fn(() => ({ budgetTier: 'mid' }));
    const upsertProfileForIdentity = jest.fn(async (_identity, patch) => ({
      ...patch,
      persisted: true,
    }));
    const runtime = buildRuntime({
      parseProfilePatchFromAction,
      upsertProfileForIdentity,
    });

    const result = await runtime.applyProfilePatchFromAction({
      identity: { auroraUid: 'uid_chat_profile_1', userId: 'user_chat_profile_1' },
      normalizedActionPayload: { action_id: 'chip.budget.mid' },
      profile: { skinType: 'oily' },
    });

    expect(result.appliedProfilePatch).toEqual({ budgetTier: 'mid' });
    expect(result.profile).toEqual({ budgetTier: 'mid', persisted: true });
    expect(upsertProfileForIdentity).toHaveBeenCalledWith(
      { auroraUid: 'uid_chat_profile_1', userId: 'user_chat_profile_1' },
      { budgetTier: 'mid' },
    );
  });

  test('applyPregnancyPolicy emits events and persists patch', async () => {
    const derivePregnancyPolicyPatch = jest.fn(() => ({
      patch: { pregnancy_status: 'not_pregnant' },
      events: [{ event_name: 'pregnancy_status_auto_reset', data: { from: 'pregnant' } }],
    }));
    const makeEvent = jest.fn((_ctx, eventName, data) => ({ event_name: eventName, data }));
    const runtime = buildRuntime({
      derivePregnancyPolicyPatch,
      makeEvent,
    });

    const result = await runtime.applyPregnancyPolicy({
      ctx: { request_id: 'req_pregnancy_1' },
      identity: { auroraUid: 'uid_chat_profile_1', userId: 'user_chat_profile_1' },
      profile: { pregnancy_status: 'pregnant' },
      message: 'I already delivered',
      appliedProfilePatch: { skinType: 'dry' },
    });

    expect(result.appliedProfilePatch).toEqual({
      skinType: 'dry',
      pregnancy_status: 'not_pregnant',
    });
    expect(result.pendingPregnancyPolicyEvents).toEqual([
      { event_name: 'pregnancy_status_auto_reset', data: { from: 'pregnant' } },
    ]);
    expect(result.profile).toEqual({
      pregnancy_status: 'not_pregnant',
      saved: true,
    });
  });

  test('applyTextDerivedProfilePatch merges travel plan and records outcomes', async () => {
    const recordAuroraProfileAutoPatch = jest.fn();
    const extractProfilePatchFromFreeText = jest.fn(() => ({
      skinType: 'combination',
      travel_plan: { end_date: '2030-01-05' },
    }));
    const runtime = buildRuntime({
      recordAuroraProfileAutoPatch,
      extractProfilePatchFromFreeText,
    });

    const result = await runtime.applyTextDerivedProfilePatch({
      ctx: { request_id: 'req_text_patch_1' },
      identity: { auroraUid: 'uid_chat_profile_1', userId: 'user_chat_profile_1' },
      profile: {
        travel_plan: {
          destination: 'Tokyo',
          start_date: '2030-01-01',
        },
      },
      message: 'Traveling next week and my skin is combo',
      canonicalIntent: { intent: 'travel_planning', entities: { destination: 'Tokyo' } },
      appliedProfilePatch: { budgetTier: 'mid' },
    });

    expect(result.textDerivedProfilePatch).toEqual({
      skinType: 'combination',
      travel_plan: {
        destination: 'Tokyo',
        start_date: '2030-01-01',
        end_date: '2030-01-05',
      },
    });
    expect(result.appliedProfilePatch).toEqual({
      budgetTier: 'mid',
      skinType: 'combination',
      travel_plan: {
        destination: 'Tokyo',
        start_date: '2030-01-01',
        end_date: '2030-01-05',
      },
    });
    expect(recordAuroraProfileAutoPatch).toHaveBeenCalledWith({ field: 'skinType', outcome: 'applied' });
    expect(recordAuroraProfileAutoPatch).toHaveBeenCalledWith({ field: 'skinType', outcome: 'persisted' });
  });

  test('applyTextDerivedSkinLog persists log and prepends it to recent logs', async () => {
    const recordAuroraProfileAutoPatch = jest.fn();
    const extractTrackerLogFromFreeText = jest.fn(() => ({ redness: 2 }));
    const upsertSkinLogForIdentity = jest.fn(async () => ({ id: 'log_saved_1', redness: 2 }));
    const runtime = buildRuntime({
      recordAuroraProfileAutoPatch,
      extractTrackerLogFromFreeText,
      upsertSkinLogForIdentity,
    });

    const result = await runtime.applyTextDerivedSkinLog({
      identity: { auroraUid: 'uid_chat_profile_1', userId: 'user_chat_profile_1' },
      recentLogs: [{ id: 'log_old_1' }],
      message: 'My skin is red today',
    });

    expect(result.textDerivedSkinLog).toEqual({ redness: 2 });
    expect(result.recentLogs).toEqual([
      { id: 'log_saved_1', redness: 2 },
      { id: 'log_old_1' },
    ]);
    expect(recordAuroraProfileAutoPatch).toHaveBeenCalledWith({
      field: 'recentLogs',
      outcome: 'persisted',
    });
  });
});
