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
//
// The dir is always this run's own, never one inherited from the environment: a row some
// earlier run left there would fail a clean run. Under --watch the same dir serves every run,
// and each run reports only the rows no earlier run reported.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The run-log reader, not the guard: this runs in jest's parent process, which must not be patched.
const guard = require('./netGuardRunLog.cjs');

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'];

class NetGuardJestReporter {
  constructor() {
    this._error = null;
    this._seen = new Set();
    this._dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netguard-jest-'));
    process.env[guard.RUN_DIR_ENV] = this._dir;
    // Under --runInBand the tests run in THIS process, and a timer a file left behind can still
    // fire after onRunComplete: jest waits for the event loop to drain before exiting. Look once
    // more at exit. (jest's own exit handler only ever raises the exit code, never lowers it.)
    process.once('exit', () => this._atExit());
    // A run stopped by Ctrl-C or a TERM never gets to 'exit'. Remove the dir then, and die of
    // the signal as before -- unless something else (jest's --watch) has its own handler.
    const onSignal = (signal) => {
      for (const s of STOP_SIGNALS) process.removeListener(s, onSignal);
      fs.rmSync(this._dir, { recursive: true, force: true });
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    for (const s of STOP_SIGNALS) process.on(s, onSignal);
  }

  // Rows not reported by an earlier run (--watch) or an earlier look at this one.
  _fresh() {
    const list = guard.readRunLog(this._dir).filter((v) => !this._seen.has(v.id));
    for (const v of list) this._seen.add(v.id);
    return list;
  }

  onRunStart() {
    this._error = null;
  }

  onRunComplete() {
    const list = this._fresh();
    if (!list.length) return;
    const message = this._message(list);
    process.stderr.write(`\n${message}\n`);
    this._error = new Error(message);
  }

  _atExit() {
    const late = this._fresh();
    fs.rmSync(this._dir, { recursive: true, force: true });
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
