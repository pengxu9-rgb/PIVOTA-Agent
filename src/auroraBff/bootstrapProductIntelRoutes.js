const {
  mountProductIntelRoutes: mountProductIntelRoutesDefault,
} = require('./routes/productIntelRoutes');

function bootstrapProductIntelRoutes(options = {}) {
  const {
    mountProductIntelRoutes = mountProductIntelRoutesDefault,
    app,
    ...routeDeps
  } = options;

  mountProductIntelRoutes(app, routeDeps);
}

module.exports = {
  bootstrapProductIntelRoutes,
};
