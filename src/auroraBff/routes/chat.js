const { SkillRouter } = require('../orchestrator/skill_router');
const LlmGateway = require('../services/llm_gateway');
const { mapSkillResponseToChatCardsV1, mapSkillResponseToStreamEnvelope } = require('../mappers/card_mapper');

let routerSingleton = null;

function toBool(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y' || raw === 'on';
}

function createRouter() {
  const llmGateway = new LlmGateway({
    stubResponses: toBool(process.env.AURORA_CHAT_V2_STUB_RESPONSES),
  });
  return new SkillRouter(llmGateway);
}

function getRouter() {
  if (!routerSingleton) {
    routerSingleton = createRouter();
  }
  return routerSingleton;
}

function __resetRouterForTests() {
  routerSingleton = null;
}

async function handleChat(req, res) {
  try {
    const skillRequest = buildSkillRequest(req);
    const skillResponse = await getRouter().route(skillRequest);
    res.json(mapSkillResponseToChatCardsV1(skillResponse));
  } catch (error) {
    console.error('[chat] skill execution error:', error);
    res.status(500).json({
      error: 'internal_error',
      message: 'An error occurred processing your request.',
    });
  }
}

async function handleChatStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sendEvent = (eventType, payload) => {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const skillRequest = buildSkillRequest(req);
    const thinkingSteps = [];
    let resultSent = false;

    const skillResponse = await getRouter().routeStream(skillRequest, (event) => {
      if (event.type === 'thinking') {
        thinkingSteps.push({ step: event.step, message: event.message });
        sendEvent('thinking', { step: event.step, message: event.message });
        return;
      }
      if (event.type === 'chunk') {
        sendEvent('chunk', { text: event.text });
        return;
      }
      if (event.type === 'result') {
        resultSent = true;
        sendEvent('result', mapSkillResponseToStreamEnvelope(event.data, thinkingSteps));
      }
    });

    if (!resultSent) {
      sendEvent('result', mapSkillResponseToStreamEnvelope(skillResponse, thinkingSteps));
    }
    sendEvent('done', {});
  } catch (error) {
    console.error('[chat/stream] error:', error);
    sendEvent('error', { message: 'An error occurred processing your request.' });
    sendEvent('done', {});
  } finally {
    res.end();
  }
}

function buildSkillRequest(req) {
  const body = req.body || {};
  const userMessage = body.message || body.text || body.params?.user_message || body.params?.message || body.params?.text || null;
  const bodyContext = body.context && typeof body.context === 'object' ? body.context : {};

  return {
    skill_id: body.skill_id || null,
    skill_version: body.skill_version || '1.0.0',
    intent: body.intent || body.canonical_intent || null,
    params: {
      ...(body.params || {}),
      entry_source: body.entry_source || body.trigger_source || body.params?.entry_source || null,
      user_message: userMessage,
      message: userMessage,
      text: userMessage,
    },
    context: {
      profile: bodyContext.profile || req._userProfile || {},
      recent_logs: bodyContext.recent_logs || req._recentLogs || [],
      travel_plan: bodyContext.travel_plan || null,
      current_routine: bodyContext.current_routine || null,
      inventory: bodyContext.inventory || [],
      locale: body.locale || req.headers['accept-language']?.split(',')[0] || 'en',
      safety_flags: bodyContext.safety_flags || [],
    },
    thread_state: body.thread_state || req._threadState || {},
  };
}

module.exports = {
  buildSkillRequest,
  handleChat,
  handleChatStream,
  __resetRouterForTests,
};
