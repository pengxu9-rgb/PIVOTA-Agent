'use strict';

// Edge-timeout guard for the MCP lanes: the public read tier (POST /mcp on mcp.pivota.cc, POST /public/mcp)
// and the authenticated commerce lane (POST /mcp on non-public hosts) — both wired in src/server.js.
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
// unaffected.
//
// Committing locks the status to 200 and discards out.status FOREVER, so the CALLER owes this module one
// precondition: only construct an enabled heartbeat for a request whose outcome is guaranteed 200. Both
// wiring sites enforce that by arming only for tools/call (isMcpHeartbeatEligibleRequest in server.js) —
// tool errors ride inside the JSON-RPC body, so tools/call always resolves 200, while the adapter's 202 for
// notifications/initialized would be rewritten to 200 + a bare "\n" that no client can parse. Do NOT relax
// that to "the other methods are fast enough": adapter warm-up and identity verification precede the
// dispatch, and on a cold container they can outlive delayMs.
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
    // 6s, not closer to the ~13s deadline: the delay is measured from handler entry, so edge queueing,
    // body upload, and event-loop lag all eat into the margin before the commit byte reaches the edge.
    enabled = true,
    delayMs = 6000,
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

  // If the adapter promise never settles, neither finish() nor fail() runs — the socket closing is then
  // the only signal that can reclaim the interval.
  if (res && typeof res.on === 'function') res.on('close', stop);

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
