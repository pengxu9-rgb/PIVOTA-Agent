'use strict';
// A `pg` module whose database is DOWN, for `jest.doMock('pg', unreachablePg)`.
//
// Several suites set DATABASE_URL to a made-up host (`postgres://something.test/...`) so that
// code which reaches for its own pool "fails like an outage". It does fail -- after a real DNS
// query for that host has gone out, on every run, and slowly if the resolver is slow. This keeps
// the outage and drops the network: every query and connect rejects at once with the error a
// host that does not resolve produces.
//
// ENOTFOUND by default because that is what those made-up hosts gave the code before: it is one
// of src/db's TRANSIENT_DB_ERROR_CODES, so the retry path the tests used to run still runs (an
// ECONNREFUSED would skip it). Pass another code to model a different outage.

function unreachableError(code = 'ENOTFOUND') {
  const err = new Error(
    code === 'ENOTFOUND' ? 'getaddrinfo ENOTFOUND (test: database unreachable)' : `connect ${code} (test: database unreachable)`,
  );
  err.code = code;
  err.errno = code === 'ENOTFOUND' ? -3008 : -61;
  err.syscall = code === 'ENOTFOUND' ? 'getaddrinfo' : 'connect';
  return err;
}

function unreachablePg({ code = 'ENOTFOUND' } = {}) {
  const actual = jest.requireActual('pg');
  class Client {
    constructor(config) {
      this.config = config;
    }
    connect(cb) {
      if (typeof cb === 'function') return setImmediate(() => cb(unreachableError(code)));
      return Promise.reject(unreachableError(code));
    }
    query(text, params, cb) {
      const done = typeof params === 'function' ? params : cb;
      if (typeof done === 'function') return setImmediate(() => done(unreachableError(code)));
      return Promise.reject(unreachableError(code));
    }
    end(cb) {
      if (typeof cb === 'function') return setImmediate(cb);
      return Promise.resolve();
    }
    on() { return this; }
    once() { return this; }
    removeListener() { return this; }
  }
  class Pool extends Client {
    constructor(config) {
      super(config);
      this.totalCount = 0;
      this.idleCount = 0;
      this.waitingCount = 0;
    }
  }
  return { ...actual, Client, Pool, default: { ...actual, Client, Pool } };
}

module.exports = { unreachablePg, unreachableError };
