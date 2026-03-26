const { createChatRouteTurnSetupRuntime } = require('./chatRouteTurnSetupRuntime');
const { createChatRouteRequestShellRuntime } = require('./chatRouteRequestShellRuntime');
const { createChatRouteDeliveryShellRuntime } = require('./chatRouteDeliveryShellRuntime');

function createChatRouteShellRuntimeBundle(deps = {}) {
  const {
    chatProfileRuntime,
    chatTurnSetupRuntime,
    chatDeliveryRuntime,
    getRecoDogfoodSessionId,
    computeAuroraChatRolloutContext,
    pickFirstTrimmed,
    addEmotionalPreambleToAssistantText,
    buildRequestContext,
    AURORA_CHAT_GLOBAL_FLAGS,
    AURORA_CHAT_POLICY_VERSION,
    DEFAULT_AGENT_STATE,
    INTENT_ENUM,
    chatAdvisoryRuntime,
    chatEnvelopeMetaRuntime,
    chatPolicyRuntime,
    buildEnvelope,
    makeAssistantMessage,
    makeEvent,
  } = deps;

  const chatRouteTurnSetupRuntime = createChatRouteTurnSetupRuntime({
    chatProfileRuntime,
    chatTurnSetupRuntime,
    getRecoDogfoodSessionId,
    computeAuroraChatRolloutContext,
    pickFirstTrimmed,
    addEmotionalPreambleToAssistantText,
    AURORA_CHAT_GLOBAL_FLAGS,
    AURORA_CHAT_POLICY_VERSION,
  });
  const chatRouteDeliveryShellRuntime = createChatRouteDeliveryShellRuntime({
    chatDeliveryRuntime,
  });
  const chatRouteRequestShellRuntime = createChatRouteRequestShellRuntime({
    buildRequestContext,
    getRecoDogfoodSessionId,
    computeAuroraChatRolloutContext,
    AURORA_CHAT_GLOBAL_FLAGS,
    AURORA_CHAT_POLICY_VERSION,
    DEFAULT_AGENT_STATE,
    INTENT_ENUM,
    chatAdvisoryRuntime,
    chatEnvelopeMetaRuntime,
    chatPolicyRuntime,
    chatRouteDeliveryShellRuntime,
    buildEnvelope,
    makeAssistantMessage,
    makeEvent,
  });

  return {
    chatRouteTurnSetupRuntime,
    chatRouteDeliveryShellRuntime,
    chatRouteRequestShellRuntime,
  };
}

module.exports = {
  createChatRouteShellRuntimeBundle,
};
