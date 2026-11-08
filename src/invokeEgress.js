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

const logger = require('./logger');
const {
  dropUnopenableLegacySeedRows,
  isLegacySeedProjectedOp,
  projectLegacySeedRows,
} = require('./services/legacySeedIdServability');

const INSTALLED = Symbol('pivotaInvokeEgressInstalled');
// Set the moment a response is handed to a DEFERRED send (review GD-1). From then on this request has its
// answer, even though `res.headersSent` still reads false until the send happens.
const COMMITTED = Symbol('pivotaInvokeEgressCommitted');

// On a search response whose legacy seed rows this door asked the database about: the commerce kernel's
// loopback hop reads it and does not ask again for the same page (review GD-2).
const LEGACY_SEED_PROBE_HEADER = 'X-Pivota-Legacy-Seed-Probe';

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
//   - the deferred send never sends twice: if anything else wrote to the socket meanwhile, it stands down;
//   - nothing it does can reject: every step is caught.
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
          const statusAtCommit = res.statusCode;
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
              if (typeof res.setHeader === 'function') res.setHeader(LEGACY_SEED_PROBE_HEADER, '1');
              originalJson(finalBody === undefined || finalBody === null ? sendProjected : finalBody);
            } catch (err) {
              warnEgress(
                { op: ctx && ctx.operation, door: 'invoke_egress', err: err && err.message },
                'invoke egress: the deferred search response failed to send',
              );
              if (res.headersSent || res.writableEnded) return;
              try {
                res.statusCode = 500;
                originalJson({ error: 'INTERNAL_ERROR', message: 'Internal Server Error' });
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
  finalizeInvokeSearchBody,
  installInvokeEgress,
  isInvokeResponseCommitted,
  projectInvokeResponse,
};
