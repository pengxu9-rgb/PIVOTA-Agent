'use strict';

// Playground starts a server with listen(port) and no address argument.
// Scope that listener to loopback for this disposable fixture.
const { Server } = require('node:net');
const listen = Server.prototype.listen;

Server.prototype.listen = function listenOnLoopback(port, ...options) {
  if (typeof port === 'number' && typeof options[0] !== 'string') {
    return listen.call(this, port, '127.0.0.1', ...options);
  }
  return listen.call(this, port, ...options);
};
