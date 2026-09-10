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
// This module does not change any response. `projectInvokeResponse` is deliberately the
// IDENTITY today. Its entire value in this change is that from here on there is exactly one
// place to answer the question, and a test that fails if a 97th exit ever bypasses it.
//
// WHY A WRAP RATHER THAN 96 EDITS. Converting every call site to `sendProductsResponse(res, …)`
// carries real regression risk across 13,000 lines and buys a guarantee that lasts only until
// someone writes `res.json` out of habit — which is precisely the failure mode being fixed.
// Wrapping `res.json` at the ingress covers all 96 exits and every exit added later, by
// construction rather than by convention. `res.json` is verified to be the ONLY exit shape in
// the route (no send/end/write/redirect/sendStatus/jsonp, no manual writeHead), and
// tests/invoke_egress_chokepoint.node.test.cjs fails if that stops being true.

const INSTALLED = Symbol('pivotaInvokeEgressInstalled');

// The one place to decide what may leave the invoke route.
//
// IDENTITY BY DESIGN, for now. Shrinking the surface is a separate change with a separate
// blast radius: `destination_url` carries Pivota click attribution (the backend stamps it in
// _attach_connected_product_redirects and the UI reads it for the buy link, JSON-LD, and the
// SEO canonical), and `platform`/`source` feed the UI's own external-seed predicate in
// ProductDetailClient.tsx. Removing fields here without settling those consumers would break
// attribution and the PDP. Land the chokepoint first; decide policy behind it second.
function projectInvokeResponse(body, _ctx = {}) {
  return body;
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
function installInvokeEgress(
  res,
  ctx = {},
  { project = projectInvokeResponse, onProjectError = null } = {},
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
      return originalJson(projected);
    };
  }

  return (body) => res.json(body);
}

module.exports = { installInvokeEgress, projectInvokeResponse, INSTALLED };
