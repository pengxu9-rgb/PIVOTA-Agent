'use strict';
// A `pg` module whose database is DOWN, for `jest.doMock('pg', unreachablePg)`.
//
// Several suites set DATABASE_URL to a made-up host (`postgres://something.test/...`) so that
// code which reaches for its own pool "fails like an outage". It does fail -- after a real DNS
// query for that host has gone out, on every run, and slowly if the resolver is slow. This keeps
// the outage and drops the network: every query and connect rejects at once with a connection-
// refused error, which is the shape pg itself produces for a database that is not there.

function refused() {
  const err = new Error('connect ECONNREFUSED (test: database unreachable)');
  err.code = 'ECONNREFUSED';
  err.errno = -61;
  err.syscall = 'connect';
  return err;
}

function unreachablePg() {
  const actual = jest.requireActual('pg');
  class Client {
    constructor(config) {
      this.config = config;
    }
    connect(cb) {
      if (typeof cb === 'function') return setImmediate(() => cb(refused()));
      return Promise.reject(refused());
    }
    query(text, params, cb) {
      const done = typeof params === 'function' ? params : cb;
      if (typeof done === 'function') return setImmediate(() => done(refused()));
      return Promise.reject(refused());
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

module.exports = { unreachablePg, refused };
