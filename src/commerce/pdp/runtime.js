const { buildPdpPayload } = require('../../pdpBuilder');
const { recommend: recommendPdpProducts } = require('../../services/RecommendationEngine');

module.exports = {
  buildPdpPayload,
  recommendPdpProducts,
};
