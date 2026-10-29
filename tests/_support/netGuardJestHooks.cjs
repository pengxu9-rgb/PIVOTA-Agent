'use strict';
// jest setupFilesAfterEnv half of the loopback-only guard (tests/_support/netGuard.cjs).
//
// The guard itself is installed from `setupFiles` and refuses every non-loopback connect and
// DNS query. Refusing is not failing: the code under test usually catches the error and falls
// back, and the test stays green. This file turns a refusal into a red test.
//
// Attribution. This file runs once per test file, before its tests, and enters that file's
// path into the guard's AsyncLocalStorage. Everything the file starts -- tests, timers,
// sockets, promises -- carries the path, including work still running after the file is done.
// The hooks below fail a test only for attempts THIS file started (or that carry no origin at
// all). An attempt another file started -- a fire-and-forget probe, an un-awaited fetch on a
// timer -- is left alone here: it is already in the run dir, and
// tests/_support/netGuardJestReporter.cjs fails the run naming the file that started it, also
// when it fires after the worker's last file or in a worker that was recycled.

const guard = require('./netGuard.cjs');

const STATE_KEY = Symbol.for('pivota.tests.netGuard');
const net = require('node:net');

const realProcess = require('node:vm').runInThisContext('process');
const thisFile = expect.getState().testPath;

guard.attribution().enterWith({ origin: thisFile });

let testStartedAt = Date.now();

function setContext() {
  const s = net[STATE_KEY];
  if (!s) return;
  const { testPath, currentTestName } = expect.getState();
  s.testPath = currentTestName ? `${testPath} > ${currentTestName}` : testPath;
  // A child process inherits the worker's real env: tell it whose work it is doing.
  realProcess.env[guard.ORIGIN_ENV] = thisFile;
}

// Takes this file's attempts out of the record and leaves other files' to the reporter. With no
// run dir (a jest run that dropped the reporter) nothing would ever report those, so they fail
// here instead, labelled with the file that started them.
function takeOwn() {
  const all = guard.drain();
  const own = [];
  for (const v of all) {
    if (!v.origin || v.origin === thisFile || !realProcess.env[guard.RUN_DIR_ENV]) own.push(v);
  }
  return own;
}

function failOnViolations(phase) {
  const list = takeOwn();
  if (!list.length) return;
  for (const v of list) {
    if (v.at < testStartedAt && (!v.origin || v.origin === thisFile)) {
      v.target += '  [started BEFORE this test began: leaked from an earlier test in this file]';
    }
  }
  guard.markReported(list);
  throw new Error(`${guard.formatViolations(list)}\n(detected in ${phase})`);
}

beforeAll(() => {
  setContext();
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
