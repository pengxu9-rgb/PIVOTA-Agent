/**
 * Aurora BFF entry point.
 *
 * This replaces the monolithic routes.js (~39K lines) with a modular
 * skill-based architecture. The old routes.js remains for legacy fallback
 * during migration (controlled by feature flag).
 *
 * Directory structure:
 *   routes/        - Thin route handlers (<200 lines each)
 *   orchestrator/  - SkillRouter + QualityGateEngine
 *   skills/        - One file per skill (BaseSkill subclass)
 *   mappers/       - DTO / card mapping (SkillResponse -> ChatCards v1)
 *   services/      - LlmGateway, memory_store, etc.
 *   prompts/       - Versioned prompt templates
 *   validators/    - JSON Schema validation
 */

const { handleChat } = require('./routes/chat');

function registerRoutes(app) {
  app.post('/v1/chat', handleChat);
}

module.exports = { registerRoutes };
