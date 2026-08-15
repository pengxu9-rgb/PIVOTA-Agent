'use strict';

/**
 * Pull the REAL reason out of a fetch failure, as flat log fields.
 *
 * undici collapses every network-layer failure into the same opaque `TypeError: fetch failed` and puts the
 * actual reason on `.cause`. Measured on node 20 and 24:
 *
 *   refused redirect  message "fetch failed"  cause "unexpected redirect"          code undefined
 *   dead host         message "fetch failed"  cause "getaddrinfo ENOTFOUND <host>" code ENOTFOUND
 *   refused connect   message "fetch failed"  cause "connect ECONNREFUSED ..."     code ECONNREFUSED
 *
 * So logging `err.message` alone renders those three IDENTICAL. That matters wherever we deliberately
 * refuse a redirected UCP profile (UCP 2026-04-08 requires it): a merchant that serves its profile only
 * behind a 301 reads exactly like DNS death, and one of those is a misconfiguration someone can go fix.
 *
 * Shared by the two UCP lanes that fetch a profile — the warm-handoff service and the order-webhook
 * receiver — because both learned the same two non-obvious branches below the hard way, and two copies
 * would drift. Deliberately dependency-free: the receiver is import-light on purpose (its suite runs in
 * a CI job with no `npm ci`), so this module must never grow a require.
 *
 * Takes the cause's MESSAGE as a string, never the cause object: a real fetch cause's own ENUMERABLE keys
 * are errno/code/syscall/hostname, so spreading it drags request detail into the record. (Note the trap:
 * the stack does NOT leak that way — `Error.prototype.stack` is non-enumerable — so a test that injects a
 * stack and asserts its absence proves nothing. Assert an allowlist on the emitted key set.)
 *
 * One level only: nested `cause.cause` chains are not walked (none of the measured shapes nest).
 *
 * Deliberately does NOT parse the message into a reason code. Those strings are undici's internals, not a
 * contract, and a classifier built on them rots silently across a node bump — failing closed-looking, back
 * to the very indistinguishability this exists to remove.
 *
 * @param {unknown} err  the caught error (any shape; never assumed to be an Error)
 * @returns {{cause?: string, cause_code?: string}} flat fields to spread into a log record, or `{}`
 */
function fetchCauseDetail(err) {
  // Guarded because callers spread this INTO a log call, i.e. it is evaluated as an argument, before any
  // try/catch the logging helper itself applies. A throwing getter here would escape the catch block the
  // call site sits in rather than merely costing a log line.
  try {
    const cause = err && err.cause;
    if (!cause) return {};
    let message = typeof cause === 'string'
      ? cause
      : (typeof cause.message === 'string' ? cause.message : undefined);
    // Dual-stack hosts fail as an AggregateError with an EMPTY message: the per-family reasons live in
    // `.errors` ("connect ECONNREFUSED ::1:443" / "...127.0.0.1:443"). Without this the record would carry
    // cause_code and no cause at all, on exactly the brands most likely to be behind a CDN.
    if (!message && Array.isArray(cause.errors) && cause.errors.length) {
      const first = cause.errors[0];
      if (first && typeof first.message === 'string') message = first.message;
    }
    // A non-string code is dropped rather than published: the only numeric one in these lanes is
    // DOMException.code === 20 on an abort, a legacy constant that means nothing in a log.
    const code = typeof cause.code === 'string' ? cause.code : undefined;
    const out = {};
    // Bounded: a pathological cause must not be able to bloat a log line.
    if (message) out.cause = message.slice(0, 200);
    if (code) out.cause_code = code;
    return out;
  } catch {
    return {};
  }
}

module.exports = { fetchCauseDetail };
