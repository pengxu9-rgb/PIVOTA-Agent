const { createGatewayAdapter } = require('./createGatewayAdapter');

module.exports = createGatewayAdapter('mcp', {
  protocol_family: 'MCP',
});
