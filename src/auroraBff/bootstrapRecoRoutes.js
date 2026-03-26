const {
  mountRecoDogfoodRoutes: mountRecoDogfoodRoutesDefault,
} = require('./routes/recoDogfoodRoutes');
const {
  mountRecoRecommendationRoutes: mountRecoRecommendationRoutesDefault,
} = require('./routes/recoRecommendationRoutes');

function bootstrapRecoRoutes(options = {}) {
  const {
    mountRecoDogfoodRoutes = mountRecoDogfoodRoutesDefault,
    mountRecoRecommendationRoutes = mountRecoRecommendationRoutesDefault,
    app,
    ...routeDeps
  } = options;

  mountRecoDogfoodRoutes(app, routeDeps);
  mountRecoRecommendationRoutes(app, routeDeps);
}

module.exports = {
  bootstrapRecoRoutes,
};
