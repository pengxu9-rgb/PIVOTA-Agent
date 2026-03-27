const { createGatewayAdapter } = require('./createGatewayAdapter');

module.exports = createGatewayAdapter('direct_api', {
  protocol_family: 'DIRECT_API',
});
