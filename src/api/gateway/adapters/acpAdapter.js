const { createGatewayAdapter } = require('./createGatewayAdapter');

module.exports = createGatewayAdapter('acp', {
  protocol_family: 'ACP',
});
