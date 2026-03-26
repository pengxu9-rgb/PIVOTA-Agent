const {
  mountPhotoRoutes: mountPhotoRoutesDefault,
} = require('./routes/photoRoutes');

function bootstrapPhotoRoutes(options = {}) {
  const {
    mountPhotoRoutes = mountPhotoRoutesDefault,
    app,
    ...routeDeps
  } = options;

  mountPhotoRoutes(app, routeDeps);
}

module.exports = {
  bootstrapPhotoRoutes,
};
