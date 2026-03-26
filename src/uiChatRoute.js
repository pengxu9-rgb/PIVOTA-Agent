const fs = require('fs');
const path = require('path');

const FALLBACK_UI_CHAT_SYSTEM_PROMPT = `
You are the Pivota Shopping Agent.

Core rules:
- Use the \`pivota_shopping_tool\` for any shopping, ordering, payment, order-status, or after-sales task. Do not fabricate product/pricing/order/payment/tracking details.
- Maintain the user’s primary goal across turns; treat follow-ups as refinements unless the user explicitly changes goals.
- If the user message looks like meta instructions or a copied template, do not switch tasks silently: restate the current goal in 1 sentence and ask whether to switch goals or continue refining.
- If the user replies with a tier label (e.g. "A/B/C", "beginner/complete/advanced") or a short constraint, treat it as selecting/refining within the current goal.
- Ask at most 1–2 clarifying questions when needed, then proceed.
- Respond in the same language as the user’s most recent message; if mixed and unclear, ask which language to use.
- Use exactly one language per response; do not mix languages within a single answer.
`.trim();

function loadUiChatSystemPrompt({
  env = process.env,
  logger,
  fsModule = fs,
  pathModule = path,
  today = () => new Date().toISOString().slice(0, 10),
} = {}) {
  const defaultPromptPath = pathModule.join(
    __dirname,
    '..',
    'prompts',
    'shopping_agent_system_prompt_v1_5.txt',
  );
  const promptPath = env.PIVOTA_UI_CHAT_SYSTEM_PROMPT_PATH || defaultPromptPath;

  let systemPrompt;
  try {
    systemPrompt = fsModule.readFileSync(promptPath, 'utf8');
  } catch (err) {
    logger.warn({ err, promptPath }, 'Failed to load system prompt file; using fallback prompt');
    systemPrompt = FALLBACK_UI_CHAT_SYSTEM_PROMPT;
  }

  return String(systemPrompt || '')
    .replace(/now=\d{4}-\d{2}-\d{2}/g, `now=${today()}`)
    .trim();
}

function createUiChatRouteHandler({
  runAgentWithTools,
  logger,
  loadSystemPrompt = loadUiChatSystemPrompt,
} = {}) {
  return async function uiChatRouteHandler(req, res) {
    try {
      const clientMessages = req.body.messages;

      if (!Array.isArray(clientMessages)) {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'Body must have a messages array',
        });
      }

      const systemPrompt = loadSystemPrompt({ logger });
      const messages = [
        { role: 'system', content: systemPrompt },
        ...clientMessages,
      ];
      const assistantMsg = await runAgentWithTools(messages);

      return res.json({
        assistantMessage: assistantMsg,
      });
    } catch (err) {
      logger.error({ err }, 'Error in /ui/chat');
      return res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Failed to run agent',
      });
    }
  };
}

function registerUiChatRoute({
  app,
  runAgentWithTools,
  logger,
  createHandler = createUiChatRouteHandler,
} = {}) {
  app.post(
    '/ui/chat',
    createHandler({
      runAgentWithTools,
      logger,
    }),
  );
}

module.exports = {
  FALLBACK_UI_CHAT_SYSTEM_PROMPT,
  loadUiChatSystemPrompt,
  createUiChatRouteHandler,
  registerUiChatRoute,
};
