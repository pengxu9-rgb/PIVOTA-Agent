'use strict';
// jest setupFilesAfterEnv half of the loopback-only guard (tests/_support/netGuard.cjs).
//
// The guard itself is installed from `setupFiles` and refuses every non-loopback connect and
// DNS query. Refusing is not failing: the code under test usually catches the error and falls
// back, and the test stays green. This file turns a refusal into a red test.
//
// Attribution. A violation is reported by the test that is running when it is checked. Work a
// previous test (or a previous FILE in the same worker) left running -- a fire-and-forget
// probe, an un-awaited fetch -- lands in whatever runs next, so the report says when an
// attempt started before the current test did. Read the stack, not just the test name.

const guard = require('./netGuard.cjs');

const STATE_KEY = Symbol.for('pivota.tests.netGuard');
const net = require('node:net');

let testStartedAt = Date.now();

function setContext() {
  const s = net[STATE_KEY];
  if (!s) return;
  const { testPath, currentTestName } = expect.getState();
  s.testPath = currentTestName ? `${testPath} > ${currentTestName}` : testPath;
}

function failOnViolations(phase) {
  const list = guard.drain();
  if (!list.length) return;
  for (const v of list) {
    if (v.at < testStartedAt) v.target += '  [started BEFORE this test began: leaked from earlier work]';
  }
  throw new Error(`${guard.formatViolations(list)}\n(detected in ${phase})`);
}

beforeAll(() => {
  setContext();
  // Anything recorded before this file's first hook came from an earlier file in this worker.
  failOnViolations('beforeAll: left over from an earlier test file in this jest worker');
});

beforeEach(() => {
  testStartedAt = Date.now();
  setContext();
});

afterEach(() => {
  failOnViolations('afterEach');
  setContext();
});

afterAll(() => {
  failOnViolations('afterAll');
});
