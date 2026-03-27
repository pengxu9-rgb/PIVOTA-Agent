const { createGatewayAdapter } = require('./createGatewayAdapter');

module.exports = createGatewayAdapter('ap2', {
  protocol_family: 'AP2',
  spec_status: 'family_stub',
});
