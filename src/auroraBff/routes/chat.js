const { SkillRouter } = require('../orchestrator/skill_router');
const LlmGateway = require('../services/llm_gateway');
const { mapSkillResponseToChatCardsV1 } = require('../mappers/card_mapper');

let _router = null;

function getRouter() {
  if (!_router) {
    const llmGateway = new LlmGateway();
    _router = new SkillRouter(llmGateway);
  }
  return _router;
}

/**
 * Thin route handler for /v1/chat.
 * All business logic lives in skills; this handler only does:
 * 1. Parse intent + extract context
 * 2. Delegate to SkillRouter
 * 3. Map SkillResponse -> ChatCards v1 envelope
 */
async function handleChat(req, res) {
  try {
    const router = getRouter();

    const skillRequest = buildSkillRequest(req);
    const skillResponse = await router.route(skillRequest);
    const chatCardsV1 = mapSkillResponseToChatCardsV1(skillResponse);

    res.json(chatCardsV1);
  } catch (err) {
    console.error('[chat] skill execution error:', err);
    res.status(500).json({
      error: 'internal_error',
      message: 'An error occurred processing your request.',
    });
  }
}

function buildSkillRequest(req) {
  const body = req.body || {};
  return {
    skill_id: body.skill_id || null,
    skill_version: body.skill_version || '1.0.0',
    intent: body.intent || body.canonical_intent || null,
    params: {
      ...(body.params || {}),
      entry_source: body.entry_source || body.trigger_source || null,
    },
    context: {
      profile: body.context?.profile || req._userProfile || {},
      recent_logs: body.context?.recent_logs || req._recentLogs || [],
      travel_plan: body.context?.travel_plan || null,
      current_routine: body.context?.current_routine || null,
      inventory: body.context?.inventory || [],
      locale: body.locale || req.headers['accept-language']?.split(',')[0] || 'en',
      safety_flags: body.context?.safety_flags || [],
    },
    thread_state: body.thread_state || req._threadState || {},
  };
}

module.exports = { handleChat };
