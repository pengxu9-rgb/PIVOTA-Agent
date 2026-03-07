const { handleChat, handleChatStream } = require('./routes/chat');

function registerRoutes(app, options = {}) {
  const includeV1Chat = options.includeV1Chat !== false;
  const includeV1Stream = options.includeV1Stream === true || options.includeV1Stream == null;
  const includeV2 = options.includeV2 === true || options.includeV2 == null;

  if (includeV1Chat) {
    app.post('/v1/chat', handleChat);
  }
  if (includeV1Stream) {
    app.post('/v1/chat/stream', handleChatStream);
  }
  if (includeV2) {
    app.post('/v2/chat', handleChat);
    app.post('/v2/chat/stream', handleChatStream);
  }
}

module.exports = { registerRoutes };
