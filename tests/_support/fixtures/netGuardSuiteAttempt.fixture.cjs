'use strict';
// Fixture for tests/net_guard.node.test.cjs (node:test). The suite's OWN process makes an attempt
// and swallows it: the report must name this file, and not as a child process or worker.
const test = require('node:test');

test('swallows its own blocked connect', async () => {
  await new Promise((resolve) => require('node:net').connect(80, '192.0.2.10').on('error', resolve));
});
