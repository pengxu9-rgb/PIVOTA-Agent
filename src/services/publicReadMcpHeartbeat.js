'use strict';

// Edge-timeout guard for the public MCP read tier (POST /mcp on mcp.pivota.cc, POST /public/mcp).
//
// Measured 2026-08-04 with a probe service behind the same Railway edge: a response whose FIRST BODY BYTE
// arrives later than ~13s after the request is reset at ~16.4s (HTTP/2 RST_STREAM; "empty reply" on
// HTTP/1.1). Response HEADERS alone do not stop the clock — only body bytes do — and a body byte every few
// seconds keeps the stream alive past 70s. Cold multi-merchant search costs 8–23s server-side, so the
// buffered res.json() path loses exactly the partner-facing case: an agent's first uncached query gets a
// dropped connection while the server finishes anyway, caches, and the retry answers in ~1s.
//
// The guard: once compute has run longer than delayMs, COMMIT a 200 + chunked application/json response and
// write a newline heartbeat every intervalMs until the JSON-RPC body is ready, then append the body. Leading
// whitespace is valid JSON, so every body-parsing client (fetch().json(), JSON.parse, Python/Go decoders) is
// unaffected. Committing locks the status to 200 — safe on this surface because every adapter path that can
// still be running after delayMs is a tools/call, and tools/call always resolves status 200 (tool errors
// ride inside the JSON-RPC body; the adapter's non-200 responses are all instant validation paths).
//
// Pure module: timers injected, no env reads — configuration happens at the wiring site.

/**
 * @param {object} res Express-style response.
 * @param {{
 *   enabled?: boolean,
 *   delayMs?: number,
 *   intervalMs?: number,
 *   timers?: { setTimeout:Function, clearTimeout:Function, setInterval:Function, clearInterval:Function },
 * }} opts
 * @returns {{
 *   committed: () => boolean,
 *   finish: (out:{status:number, headers?:object, body?:any}) => boolean,
 *   fail: (errorBody:object) => boolean,
 *   stop: () => void,
 * }} finish/fail return true when the heartbeat already owned the wire and wrote the response — the caller
 *   must then NOT touch `res`; false means nothing was committed and the caller sends its normal buffered
 *   response.
 */
function createMcpResponseHeartbeat(res, opts = {}) {
  const {
    enabled = true,
    delayMs = 8000,
    intervalMs = 5000,
    timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  } = opts;

  if (!enabled) {
    return { committed: () => false, finish: () => false, fail: () => false, stop: () => {} };
  }

  let committed = false;
  let stopped = false;
  let interval = null;

  function canWrite() {
    return Boolean(res) && !res.destroyed && !res.writableEnded;
  }

  function commit() {
    // headersSent guards the race where the caller already started responding through another path.
    if (stopped || committed || !canWrite() || res.headersSent) return;
    committed = true;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.write('\n');
    interval = timers.setInterval(() => {
      if (canWrite()) res.write('\n');
    }, intervalMs);
    if (interval && typeof interval.unref === 'function') interval.unref();
  }

  const delay = timers.setTimeout(commit, delayMs);
  if (delay && typeof delay.unref === 'function') delay.unref();

  function stop() {
    if (stopped) return;
    stopped = true;
    timers.clearTimeout(delay);
    if (interval) timers.clearInterval(interval);
    interval = null;
  }

  function endWith(body) {
    if (canWrite()) res.end(body == null ? '' : JSON.stringify(body));
    return true; // committed: the wire is owned here even if the client is already gone
  }

  return {
    committed: () => committed,
    finish(out) {
      stop();
      if (!committed) return false;
      return endWith(out ? out.body : null);
    },
    fail(errorBody) {
      stop();
      if (!committed) return false;
      return endWith(errorBody);
    },
    stop,
  };
}

module.exports = { createMcpResponseHeartbeat };
