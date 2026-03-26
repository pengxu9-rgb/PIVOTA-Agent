const {
  mountAuthRoutes: mountAuthRoutesDefault,
} = require('./routes/authRoutes');
const {
  mountSessionBootstrapRoutes: mountSessionBootstrapRoutesDefault,
} = require('./routes/sessionBootstrapRoutes');
const {
  mountProfileRoutes: mountProfileRoutesDefault,
} = require('./routes/profileRoutes');

function bootstrapIdentityRoutes(options = {}) {
  const {
    mountAuthRoutes = mountAuthRoutesDefault,
    mountSessionBootstrapRoutes = mountSessionBootstrapRoutesDefault,
    mountProfileRoutes = mountProfileRoutesDefault,
    app,
    ...routeDeps
  } = options;

  mountAuthRoutes(app, routeDeps);
  mountSessionBootstrapRoutes(app, routeDeps);
  mountProfileRoutes(app, routeDeps);
}

module.exports = {
  bootstrapIdentityRoutes,
};
