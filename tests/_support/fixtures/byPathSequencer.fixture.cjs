'use strict';
// jest testSequencer for tests/net_guard.node.test.cjs: runs files in path order, so a fixture
// pair runs in a known order.
const Sequencer = require('@jest/test-sequencer').default;

module.exports = class ByPathSequencer extends Sequencer {
  sort(tests) {
    return [...tests].sort((a, b) => a.path.localeCompare(b.path));
  }
};
