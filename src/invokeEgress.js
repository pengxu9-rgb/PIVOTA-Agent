// The single door every response from `handleInvokeRequest` leaves by.
//
// PRECISELY THAT, and not "every /invoke response" — an earlier version of this comment said
// the latter and it is false. The route has exits that never reach this function at all: the
// strict-invoke handler (server.js:32299) answers 405/401/200/503 directly,
// requireExternalInvokeAuth (:29852) has five 401/403/503 exits, the body-size middleware
// answers 413, and handleAgentProductsSearchViaInvoke (:37083) has a fastpath that returns a
// product payload before delegating here. Those are outside this door. Claiming otherwise
// would make this module read as coverage it does not have, which is worse than the gap.
//
// WHY THIS EXISTS. `handleInvokeRequest` is ~13,000 lines with 96 response exits, and until
// now each one shaped its own body. The anti-leak projection this repo already owns
// (mcp-server/src/publicReadProjection.js, DENYLIST_FIELDS) is applied at exactly ONE door —
// publicReadToolSurface.js — and never at this one. So "what may leave the invoke route" had
// no owner, and a concern with no owner gets re-derived at each call site: a fix pins the
// result where the bug was seen, the test pins that site's output, and the same defect
// resurfaces at the next site. That is the mechanism behind fixing this class of bug
// repeatedly and watching it reappear somewhere else.
//
// `projectInvokeResponse` carries one policy (legacy seed ids on search responses, below) and is
// the identity for every other body. Its value is that there is exactly one place to answer the
// question, and a test that fails if a 97th exit ever bypasses it.
//
// WHY A WRAP RATHER THAN 96 EDITS. Converting every call site to `sendProductsResponse(res, …)`
// carries real regression risk across 13,000 lines and buys a guarantee that lasts only until
// someone writes `res.json` out of habit — which is precisely the failure mode being fixed.
// Wrapping `res.json` at the ingress covers all 96 exits and every exit added later, by
// construction rather than by convention. `res.json` is verified to be the ONLY exit shape in
// the route (no send/end/write/redirect/sendStatus/jsonp, no manual writeHead), and
// tests/invoke_egress_chokepoint.node.test.cjs fails if that stops being true.

const crypto = require('crypto');
const logger = require('./logger');
const { isLoopbackSelfCall } = require('./attribution/callerLogFields');
const {
  dropUnopenableLegacySeedRows,
  isLegacySeedProjectedOp,
  projectLegacySeedRows,
} = require('./services/legacySeedIdServability');

const INSTALLED = Symbol('pivotaInvokeEgressInstalled');
// Set the moment a response is handed to a DEFERRED send (review GD-1). From then on this request has its
// answer, even though `res.headersSent` still reads false until the send happens.
const COMMITTED = Symbol('pivotaInvokeEgressCommitted');

// While a deferred send is being written (and only then), the writes below go through (P3-a).
const DELIVERING = Symbol('pivotaInvokeEgressDelivering');

// On a search response whose legacy seed rows this door asked the database about: the commerce kernel's
// loopback hop reads it and does not ask again for the same page (review GD-2).
//
// P3-c: ONLY on that hop. It is an internal hop marker, so it is set only when the request carries this
// process's own hop token (LEGACY_SEED_PROBE_HOP_HEADER, minted at process start, never configured, logged or
// sent anywhere but this process's own loopback search) over a loopback socket with no X-Forwarded-For (the
// same socket rule as the loopback caller assertion). Every other caller, direct invoke and REST search
// included, never sees it. It is never trusted inbound: the kernel reads it only off its own loopback response.
const LEGACY_SEED_PROBE_HEADER = 'X-Pivota-Legacy-Seed-Probe';
const LEGACY_SEED_PROBE_HOP_HEADER = 'X-Pivota-Legacy-Seed-Probe-Hop';
const LEGACY_SEED_PROBE_HOP_TOKEN = crypto.randomBytes(24).toString('hex');

/** The request headers the kernel's loopback search hop carries (src/server.js invokeCommerceKernelRawUpstream). */
function legacySeedProbeHopHeaders() {
  return { [LEGACY_SEED_PROBE_HOP_HEADER]: LEGACY_SEED_PROBE_HOP_TOKEN };
}

/** Is this request this process's own loopback search hop? Never throws. */
function isLegacySeedProbeHop(req) {
  try {
    const raw = req && req.headers ? req.headers[LEGACY_SEED_PROBE_HOP_HEADER.toLowerCase()] : null;
    if (typeof raw !== 'string' || raw.length !== LEGACY_SEED_PROBE_HOP_TOKEN.length) return false;
    if (!isLoopbackSelfCall(req)) return false;
    return crypto.timingSafeEqual(Buffer.from(raw), Buffer.from(LEGACY_SEED_PROBE_HOP_TOKEN));
  } catch (_) {
    return false;
  }
}

/**
 * Has this response been answered? True once headers are out or the stream has ended, AND while the egress
 * holds a deferred send for it. A guard that asks "may I still send?" must ask this, not `res.headersSent`
 * alone: a search response waiting on its legacy seed probe has no headers out yet, but it IS the response.
 */
function isInvokeResponseCommitted(res) {
  return Boolean(res && (res[COMMITTED] || res.headersSent || res.writableEnded));
}

function warnEgress(fields, message) {
  try {
    logger.warn(fields, message);
  } catch (_) {
    // never let a log line fail a response
  }
}

// The one place to decide what may leave the invoke route.
//
// IDENTITY BY DESIGN, for now. Shrinking the surface is a separate change with a separate
// blast radius: `destination_url` carries Pivota click attribution (the backend stamps it in
// _attach_connected_product_redirects and the UI reads it for the buy link, JSON-LD, and the
// SEO canonical), and `platform`/`source` feed the UI's own external-seed predicate in
// ProductDetailClient.tsx. Removing fields here without settling those consumers would break
// attribution and the PDP. Land the chokepoint first; decide policy behind it second.
//
// ONE POLICY SO FAR, on search responses only (find_products_multi / find_products), for rows with a
// legacy `<slug>:<hex>` seed id under the shared seed seller (src/services/legacySeedIdServability.js,
// FIX_PLAN D-06). The sync projector below makes such a row advertise an id that opens and removes no
// field. The async `finalizeInvokeSearchBody` drops only a row that no detail lane can open, and only once
// the database has said so. Every other body leaves unchanged.
function logLegacySeedProjection(ctx, counts) {
  if (!counts.droppedCount && !counts.rekeyedCount && !counts.linkedCount && !counts.failedOpenCount) return;
  try {
    logger.info(
      {
        op: ctx && ctx.operation,
        door: (ctx && ctx.door) || 'invoke_egress',
        dropped_legacy_seed_rows: counts.droppedCount || 0,
        deduped_legacy_seed_rows: counts.dedupedCount || 0,
        rekeyed_legacy_seed_rows: counts.rekeyedCount || 0,
        linked_legacy_seed_rows: counts.linkedCount || 0,
        legacy_seed_probe_failed_open: counts.failedOpenCount || 0,
        product_ids: (counts.droppedIds || []).slice(0, 10),
      },
      'search: legacy seed rows projected to ids that open',
    );
  } catch (_) {
    // never let a log line fail a response
  }
}

function projectInvokeResponse(body, ctx = {}) {
  if (!isLegacySeedProjectedOp(ctx && ctx.operation)) return body;
  const r = projectLegacySeedRows(body);
  logLegacySeedProjection(ctx, r);
  return r.body;
}

// The async half, for installInvokeEgress's `finalize`: null (send now, nothing to ask) unless the body is a
// search response holding legacy rows to probe; then a promise of the body with only the truly unopenable
// rows removed. `noActiveSeeds(ids)` asks about the page in one call (per-id `noActiveSeed(id)` is still
// accepted) and must THROW when it cannot ask, so a probe failure keeps the rows. The drop's own total
// deadline bounds how long the response waits (legacySeedIdServability, review GD-2).
function finalizeInvokeSearchBody(body, ctx = {}, { noActiveSeeds, noActiveSeed, env = process.env, ...rest } = {}) {
  if (!isLegacySeedProjectedOp(ctx && ctx.operation)) return null;
  if (typeof noActiveSeeds !== 'function' && typeof noActiveSeed !== 'function') return null;
  if (!projectLegacySeedRows(body).probeIds.length) return null;
  return dropUnopenableLegacySeedRows(body, { noActiveSeeds, noActiveSeed, env, ...rest }).then((r) => {
    logLegacySeedProjection(ctx, { droppedCount: r.droppedIds.length, ...r });
    return r.body;
  });
}

// Route every response for this request through `projectInvokeResponse`.
//
// Returns a `sendProductsResponse(body)` for call sites that want to be explicit; existing
// `res.json(...)` and `res.status(n).json(...)` calls are covered without being touched,
// because `res.status()` returns the same `res` whose `json` has been replaced.
// `project` is injectable so a test can OBSERVE the wrap without reaching into the module's
// internals. Replacing the export would not work — the default is bound here, lexically, so a
// swapped export table is a seam the code under test never goes through, and a test built on
// one passes with the defect restored.
//
// `finalize` (optional) runs after `project`. It returns null/undefined to send at once, a body to send
// instead, or a PROMISE of one: the response is then sent when it settles, with the projected body if it
// rejects. Only a finalize that has real work returns a promise (legacy seed rows on a search response), so
// every other response is sent synchronously exactly as before.
//
// THE DEFERRED SEND (review GD-1). While it waits, `res.headersSent` reads false, so code that answers
// meanwhile (a catch block, the error middleware) would send its own body and the deferred send would then
// throw ERR_HTTP_HEADERS_SENT as an unhandled rejection, which kills this process (it installs no handler).
// So, from the moment a response is deferred:
//   - the response is COMMITTED (isInvokeResponseCommitted): a later `res.json` on it is dropped, and the
//     status a later `res.status(n)` wrote is put back, so the client gets the FIRST answer, exactly as it did
//     when every send was synchronous;
//   - P3-a: the same holds for the other public writers: `res.send`, `res.end` and `res.write` (and so
//     `res.redirect`, `res.sendStatus` and Express's default error handler, which all write through them) are
//     dropped too, until the deferred send writes, and the status and headers a later step set are put back to
//     what they were at the commit. Only a writer that goes around the response object (the
//     http.ServerResponse prototype, the raw socket) can still answer first, and then:
//   - the deferred send never sends twice: if anything else wrote to the socket meanwhile, it stands down;
//   - nothing it does can reject: every step is caught.
// P3-a: the response is answered as it stood when it was committed. A later step's headers (a redirect's
// Location, a text answer's Content-Type) are not merged into it.
function snapshotHeaders(res) {
  try {
    return typeof res.getHeaders === 'function' ? { ...res.getHeaders() } : null;
  } catch (_) {
    return null;
  }
}

function restoreHeaders(res, snapshot) {
  if (!snapshot || typeof res.getHeaderNames !== 'function') return;
  for (const name of res.getHeaderNames()) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, name)) res.removeHeader(name);
  }
  for (const [name, value] of Object.entries(snapshot)) res.setHeader(name, value);
}

// P3-a: once committed, the response's other public writers answer nothing until the deferred send writes.
function holdOtherWrites(res, ctx) {
  for (const name of ['send', 'end', 'write']) {
    const original = res[name];
    if (typeof original !== 'function') continue;
    res[name] = function heldWrite(...args) {
      if (res[DELIVERING]) return original.apply(this, args);
      warnEgress(
        { op: ctx && ctx.operation, door: 'invoke_egress', method: name },
        'invoke egress: a write to a response already answered was dropped',
      );
      return name === 'write' ? true : res;
    };
  }
}

function installInvokeEgress(
  res,
  ctx = {},
  { project = projectInvokeResponse, finalize = null, onProjectError = null } = {},
) {
  if (!res || typeof res.json !== 'function') {
    // Nothing to wrap (a test double, a closed socket). Degrade to a no-op rather than
    // throwing: an egress hook must never be able to fail the surface it guards.
    return (body) => body;
  }

  if (!res[INSTALLED]) {
    const originalJson = res.json.bind(res);
    Object.defineProperty(res, INSTALLED, { value: true, enumerable: false });
    res.json = function patchedJson(body) {
      if (res[COMMITTED]) {
        // A deferred send already holds this request's answer (see above). Exactly one response leaves.
        warnEgress(
          { op: ctx && ctx.operation, door: 'invoke_egress' },
          'invoke egress: a second response for a request already answered was dropped',
        );
        return res;
      }
      let projected = body;
      try {
        projected = project(body, ctx);
      } catch (err) {
        // A throwing projector must not turn a good response into a 500: failing open is a
        // leak at worst, failing closed is an outage. But it must not be SILENT either — once
        // real policy lives here, a projector that throws on one body shape would degrade that
        // whole response class to no projection at all, forever, with no signal. So the
        // degradation is announced, and the announcement itself is wrapped, because an
        // observability call must never be able to fail the surface it observes.
        projected = body;
        try {
          if (typeof onProjectError === 'function') onProjectError(err, ctx);
          else if (typeof res.setHeader === 'function' && !res.headersSent) {
            res.setHeader('X-Pivota-Egress-Projection', 'failed');
          }
        } catch (_) {
          // nothing left to do; never rethrow from an egress hook
        }
      }
      if (typeof finalize === 'function') {
        let pending = null;
        try {
          pending = finalize(projected, ctx);
        } catch (_) {
          pending = null;
        }
        if (pending && typeof pending.then === 'function') {
          const sendProjected = projected;
          Object.defineProperty(res, COMMITTED, { value: true, enumerable: false, configurable: true });
          holdOtherWrites(res, ctx);
          const statusAtCommit = res.statusCode;
          const headersAtCommit = snapshotHeaders(res);
          const writeThrough = (body) => {
            res[DELIVERING] = true;
            try {
              return originalJson(body);
            } finally {
              res[DELIVERING] = false;
            }
          };
          const deliver = (finalBody) => {
            if (res.headersSent || res.writableEnded) {
              warnEgress(
                { op: ctx && ctx.operation, door: 'invoke_egress' },
                'invoke egress: the response was written elsewhere while the search was finishing; not sent twice',
              );
              return;
            }
            try {
              res.statusCode = statusAtCommit;
              restoreHeaders(res, headersAtCommit);
              if (ctx && ctx.legacy_seed_probe_hop === true && typeof res.setHeader === 'function') {
                res.setHeader(LEGACY_SEED_PROBE_HEADER, '1');
              }
              writeThrough(finalBody === undefined || finalBody === null ? sendProjected : finalBody);
            } catch (err) {
              warnEgress(
                { op: ctx && ctx.operation, door: 'invoke_egress', err: err && err.message },
                'invoke egress: the deferred search response failed to send',
              );
              if (res.headersSent || res.writableEnded) return;
              try {
                res.statusCode = 500;
                writeThrough({ error: 'INTERNAL_ERROR', message: 'Internal Server Error' });
              } catch (_) {
                // nothing left to do; never reject from an egress hook
              }
            }
          };
          Promise.resolve(pending)
            .then(deliver, () => deliver(sendProjected))
            .catch(() => {});
          return res;
        }
        if (pending !== undefined && pending !== null) projected = pending;
      }
      return originalJson(projected);
    };
  }

  return (body) => res.json(body);
}

module.exports = {
  COMMITTED,
  INSTALLED,
  LEGACY_SEED_PROBE_HEADER,
  LEGACY_SEED_PROBE_HOP_HEADER,
  finalizeInvokeSearchBody,
  installInvokeEgress,
  isInvokeResponseCommitted,
  isLegacySeedProbeHop,
  legacySeedProbeHopHeaders,
  projectInvokeResponse,
};
