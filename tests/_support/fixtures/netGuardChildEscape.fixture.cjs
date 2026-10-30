'use strict';
// Fixture for tests/net_guard.node.test.cjs (node:test; the runner's glob does not see it). The
// test spawns a node child with an env of its own -- no NODE_OPTIONS -- whose blocked attempt
// fails only the child, and the test ignores the child's exit code. The suite passes; the run must
// not.
const test = require('node:test');
const { spawnSync } = require('node:child_process');

test('ignores a child that tried the network', () => {
  spawnSync(process.execPath, ['-e', "require('node:net').connect(80, '192.0.2.8').on('error', () => {})"], {
    env: { PATH: process.env.PATH },
  });
});
