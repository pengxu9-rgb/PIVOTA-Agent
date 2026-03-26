const fs = require('fs');
const path = require('path');
const { callPivotaToolViaGateway: callPivotaToolViaGatewayBase } = require('./uiGatewayClient');
const { createRunAgentWithTools } = require('./uiChatAgent');
const { registerUiChatRoute } = require('./uiChatRoute');
const { createGetUiChatLlmClient } = require('./uiChatLlmClient');

function loadUiChatToolSchema({
  fsModule = fs,
  pathModule = path,
  schemaPath = pathModule.join(__dirname, '..', 'docs', 'tool-schema.json'),
} = {}) {
  const raw = JSON.parse(fsModule.readFileSync(schemaPath, 'utf8'));
  return {
    name: raw.name,
    description: raw.description,
    parameters: raw.parameters,
  };
}

function registerUiChatRuntime({
  app,
  logger,
  axiosClient,
  gatewayUrl,
  maxTaskPollAttempts,
  taskPollIntervalMs,
  timeoutMs = 15_000,
  maxAgentStepsPerTurn,
  maxToolCallsPerTurn,
  maxTotalRuntimeMs,
  maxToolLoopDuplicates,
  maxContextMessages,
  maxToolContentChars,
  loadToolSchema = loadUiChatToolSchema,
  createRunAgentWithToolsImpl = createRunAgentWithTools,
  registerUiChatRouteImpl = registerUiChatRoute,
  createGetUiChatLlmClientImpl = createGetUiChatLlmClient,
  callPivotaToolViaGatewayImpl = callPivotaToolViaGatewayBase,
} = {}) {
  const uiChatToolSchema = loadToolSchema();
  const getUiChatLlmClient = createGetUiChatLlmClientImpl({ logger });

  async function callPivotaToolViaGateway(args) {
    return callPivotaToolViaGatewayImpl({
      args,
      gatewayUrl,
      axiosClient,
      logger,
      maxTaskPollAttempts,
      taskPollIntervalMs,
      timeoutMs,
    });
  }

  const runAgentWithTools = createRunAgentWithToolsImpl({
    getUiChatLlmClient,
    uiChatToolSchema,
    callPivotaToolViaGateway,
    logger,
    maxAgentStepsPerTurn,
    maxToolCallsPerTurn,
    maxTotalRuntimeMs,
    maxToolLoopDuplicates,
    maxContextMessages,
    maxToolContentChars,
  });

  registerUiChatRouteImpl({
    app,
    runAgentWithTools,
    logger,
  });

  return {
    uiChatToolSchema,
    getUiChatLlmClient,
    callPivotaToolViaGateway,
    runAgentWithTools,
  };
}

module.exports = {
  loadUiChatToolSchema,
  registerUiChatRuntime,
};
