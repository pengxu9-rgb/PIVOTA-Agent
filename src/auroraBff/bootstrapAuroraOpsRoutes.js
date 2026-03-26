const {
  registerAuroraOpsRoutes: registerAuroraOpsRoutesDefault,
} = require('./registerOpsRoutes');

function bootstrapAuroraOpsRoutes(options = {}) {
  const {
    registerAuroraOpsRoutes = registerAuroraOpsRoutesDefault,
    app,
    ...routeDeps
  } = options;

  registerAuroraOpsRoutes({
    app,
    ...routeDeps,
  });
}

module.exports = {
  bootstrapAuroraOpsRoutes,
};
