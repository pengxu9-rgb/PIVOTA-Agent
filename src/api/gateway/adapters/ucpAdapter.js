const { createGatewayAdapter } = require('./createGatewayAdapter');

module.exports = createGatewayAdapter('ucp', {
  protocol_family: 'UCP',
  spec_status: 'family_stub',
});
