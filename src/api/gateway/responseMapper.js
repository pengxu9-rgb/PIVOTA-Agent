const { shapeGovernedResult } = require('./access/shapeGovernedResult');

function mapGovernedGatewayResponse(result = {}, envelope = {}) {
  return shapeGovernedResult(result, envelope);
}

module.exports = {
  mapGovernedGatewayResponse,
};
