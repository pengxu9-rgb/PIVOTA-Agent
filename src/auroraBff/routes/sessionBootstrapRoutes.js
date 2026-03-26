const { createIdentityRoutesRuntime } = require('../identityRoutesRuntime');
const { createProfileSessionRuntime } = require('../profileSessionRuntime');

function mountSessionBootstrapRoutes(app, deps) {
  const {
    logger,
    buildRequestContext,
    requireAuroraUid,
    buildEnvelope,
    makeAssistantMessage,
    makeEvent,
  } = deps;
  const identityRoutesRuntime = createIdentityRoutesRuntime({
    buildEnvelope,
    makeAssistantMessage,
    makeEvent,
    summarizeProfileForContext: deps.summarizeProfileForContext,
  });
  const profileSessionRuntime = createProfileSessionRuntime({
    resolveIdentity: deps.resolveIdentity,
    getProfileForIdentity: deps.getProfileForIdentity,
    getRecentSkinLogsForIdentity: deps.getRecentSkinLogsForIdentity,
    isCheckinDue: deps.isCheckinDue,
  });

  app.get('/v1/session/bootstrap', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const {
        profile,
        recentLogs,
        dbError,
        isReturning,
        checkinDue,
      } = await profileSessionRuntime.loadIdentityProfileSnapshot(req, ctx);
      return res.json(identityRoutesRuntime.buildSessionBootstrapSuccessEnvelope(ctx, {
        profile,
        recentLogs,
        checkinDue,
        isReturning,
        dbError,
      }));
    } catch (err) {
      const status = err.status || 500;
      logger?.warn?.({ err: err.message, status }, 'session bootstrap failed');
      return res
        .status(status)
        .json(identityRoutesRuntime.buildSessionBootstrapFailureEnvelope(ctx, err));
    }
  });
}

module.exports = {
  mountSessionBootstrapRoutes,
};
