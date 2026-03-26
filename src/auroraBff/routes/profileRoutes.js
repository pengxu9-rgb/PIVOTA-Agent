const { createIdentityRoutesRuntime } = require('../identityRoutesRuntime');
const { createProfileSessionRuntime } = require('../profileSessionRuntime');

function ensureFunction(name, value) {
  if (typeof value === 'function') return value;
  throw new Error(`aurora profile routes missing dependency: ${name}`);
}

function ensureSchema(name, value) {
  if (value && typeof value.safeParse === 'function') return value;
  throw new Error(`aurora profile routes missing schema: ${name}`);
}

function mountProfileRoutes(app, deps = {}) {
  const buildRequestContext = ensureFunction('buildRequestContext', deps.buildRequestContext);
  const requireAuroraUid = ensureFunction('requireAuroraUid', deps.requireAuroraUid);
  const buildEnvelope = ensureFunction('buildEnvelope', deps.buildEnvelope);
  const makeAssistantMessage = ensureFunction('makeAssistantMessage', deps.makeAssistantMessage);
  const makeEvent = ensureFunction('makeEvent', deps.makeEvent);
  const resolveIdentity = ensureFunction('resolveIdentity', deps.resolveIdentity);
  const summarizeProfileForContext = ensureFunction('summarizeProfileForContext', deps.summarizeProfileForContext);
  const classifyStorageError = ensureFunction('classifyStorageError', deps.classifyStorageError);
  const UserProfilePatchSchema = ensureSchema('UserProfilePatchSchema', deps.UserProfilePatchSchema);

  const logger = deps && typeof deps.logger === 'object' ? deps.logger : null;
  const isPlainObject = deps && typeof deps.isPlainObject === 'function' ? deps.isPlainObject : (value) => (
    value != null && typeof value === 'object' && !Array.isArray(value)
  );
  const identityRoutesRuntime = createIdentityRoutesRuntime({
    buildEnvelope,
    makeAssistantMessage,
    makeEvent,
    summarizeProfileForContext,
    classifyStorageError,
  });
  const profileSessionRuntime = createProfileSessionRuntime({
    isPlainObject,
    UserProfilePatchSchema,
    resolveIdentity,
    upsertProfileForIdentity: ensureFunction('upsertProfileForIdentity', deps.upsertProfileForIdentity),
    deleteIdentityData: ensureFunction('deleteIdentityData', deps.deleteIdentityData),
    deleteHardCasesForIdentity: ensureFunction('deleteHardCasesForIdentity', deps.deleteHardCasesForIdentity),
    logger,
  });

  app.post('/v1/profile/update', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = profileSessionRuntime.parseProfileUpdateBody(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json(identityRoutesRuntime.buildProfileUpdateBadRequestEnvelope(ctx, parsed.error.format()));
      }

      const { updated } = await profileSessionRuntime.saveProfilePatchForIdentity(req, ctx, parsed.data);

      return res.json(
        identityRoutesRuntime.buildProfileSavedEnvelope(ctx, updated, Object.keys(parsed.data)),
      );
    } catch (err) {
      const failure = identityRoutesRuntime.buildProfileStorageFailureEnvelope(
        ctx,
        err,
        'PROFILE_SAVE_FAILED',
      );
      logger?.warn?.(
        { err: err?.message || String(err), code: failure.code, status: failure.status },
        'profile update failed',
      );
      return res.status(failure.status).json(failure.body);
    }
  });

  app.post('/v1/profile/delete', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const { result } = await profileSessionRuntime.deleteProfileForIdentity(req, ctx);

      return res.json(identityRoutesRuntime.buildProfileDeletedEnvelope(ctx, result));
    } catch (err) {
      const failure = identityRoutesRuntime.buildProfileStorageFailureEnvelope(
        ctx,
        err,
        'PROFILE_DELETE_FAILED',
      );
      logger?.warn?.(
        { err: err?.message || String(err), code: failure.code, status: failure.status },
        'profile delete failed',
      );
      return res.status(failure.status).json(failure.body);
    }
  });
}

module.exports = {
  mountProfileRoutes,
};
