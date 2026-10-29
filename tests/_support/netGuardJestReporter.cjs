'use strict';
// jest reporter half of the loopback-only guard (tests/_support/netGuard.cjs).
//
// The hooks (netGuardJestHooks.cjs) fail a test for the attempts its own file made while the
// file was running. Two kinds escape them:
//   - work a file left running that fires after the file is done: in the next file (whose
//     hooks do not own it), or after the worker's LAST file, when no hook runs again -- the
//     shape of a fire-and-forget credential probe;
//   - attempts in a worker that --workerIdleMemoryLimit recycled, in a worker thread, or in a
//     child process, whose own failure its parent may swallow.
// The guard appends every attempt to NETGUARD_RUN_DIR as it happens and the hooks mark the ones
// they failed on. This reporter creates that dir before any worker starts (workers inherit the
// env), and at the end fails the run on whatever is still unreported, naming the file that
// started it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The run-log reader, not the guard: this runs in jest's parent process, which must not be patched.
const guard = require('./netGuardRunLog.cjs');

class NetGuardJestReporter {
  constructor() {
    this._error = null;
    this._ownDir = false;
    if (!process.env[guard.RUN_DIR_ENV]) {
      process.env[guard.RUN_DIR_ENV] = fs.mkdtempSync(path.join(os.tmpdir(), 'netguard-jest-'));
      this._ownDir = true;
    }
    this._dir = process.env[guard.RUN_DIR_ENV];
  }

  onRunComplete() {
    const list = guard.readRunLog(this._dir);
    this._seen = new Set(list.map((v) => v.id));
    // Under --runInBand the tests ran in THIS process, and a timer a file left behind can still
    // fire after this point: jest waits for the event loop to drain before exiting. Look once
    // more at exit. (jest's own exit handler only ever raises the exit code, never lowers it.)
    process.once('exit', () => this._atExit());
    if (!list.length) return;
    const message = this._message(list);
    process.stderr.write(`\n${message}\n`);
    this._error = new Error(message);
  }

  _atExit() {
    const late = guard.readRunLog(this._dir).filter((v) => !this._seen.has(v.id));
    if (this._ownDir) fs.rmSync(this._dir, { recursive: true, force: true });
    if (!late.length) return;
    process.stderr.write(`\n${this._message(late)}\n`);
    process.exitCode = 1;
  }

  _message(list) {
    return (
      `${guard.formatViolations(list)}\n` +
      '(reported at the end of the run: started by a test file but not caught by its own tests -- ' +
      'it fired after that file finished, or in a child process, worker thread or recycled worker)'
    );
  }

  getLastError() {
    return this._error || undefined;
  }
}

module.exports = NetGuardJestReporter;
