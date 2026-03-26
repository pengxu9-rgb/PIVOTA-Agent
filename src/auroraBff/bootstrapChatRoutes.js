const {
  mountChatRoutes: mountChatRoutesDefault,
} = require('./routes/chatRoutes');

function bootstrapChatRoutes(options = {}) {
  const {
    mountChatRoutes = mountChatRoutesDefault,
    app,
    ...routeDeps
  } = options;

  mountChatRoutes(app, routeDeps);
}

module.exports = {
  bootstrapChatRoutes,
};
