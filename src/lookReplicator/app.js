const express = require('express');
const { mountLookReplicatorRoutes } = require('./index');

function createLookReplicatorApp({
  logger = null,
  commerceClient = null,
  jsonLimit = '10mb',
  healthPath = '/healthz',
} = {}) {
  const app = express();
  app.use(express.json({ limit: jsonLimit }));
  app.get(healthPath, (_req, res) => {
    return res.status(200).json({
      ok: true,
      service: 'look_replicator',
    });
  });
  mountLookReplicatorRoutes(app, { logger, commerceClient });
  return app;
}

module.exports = {
  createLookReplicatorApp,
};
