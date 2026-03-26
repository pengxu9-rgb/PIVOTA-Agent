const express = require('express');
const { mountAuroraBffRoutes } = require('./routes');

function createAuroraBffApp({
  logger = null,
  jsonLimit = '10mb',
  healthPath = '/healthz',
} = {}) {
  const app = express();
  app.use(express.json({ limit: jsonLimit }));
  app.get(healthPath, (_req, res) => {
    return res.status(200).json({
      ok: true,
      service: 'aurora_bff',
    });
  });
  mountAuroraBffRoutes(app, { logger });
  return app;
}

module.exports = {
  createAuroraBffApp,
};
