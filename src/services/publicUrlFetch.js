'use strict';

/**
 * SSRF fence for the aurora BFF's product-URL fetch lane.
 *
 * WHY THIS EXISTS. `src/auroraBff/routes.js` fetched a caller-supplied product URL with a bare
 * `axios.get(productUrl, ...)`: no address check anywhere in the chain, and axios's default
 * `maxRedirects: 5`, so a merchant answering `302 -> http://127.0.0.1:PORT/` WAS followed. The URL arrives
 * from the request body of `POST /v1/product/analyze` (`url`) and `POST /v1/chat`
 * (`anchor_product_url`, typed `z.string().min(1)` — not even `.url()`), behind `requireAuroraUid`, which
 * accepts any non-empty `X-Aurora-UID`. Not blind, either: ingredients/price/rating parsed out of the
 * fetched body are returned to the caller, and the competitor backfill re-fetches after the response.
 *
 * WHY AXIOS AND NOT `ucpBuyerAgentClient.createPublicNetworkFetch`. The fence is shared; the TRANSPORT is
 * not, deliberately. That fetch is `node:https` + a 2 MiB WIRE cap, and swapping this lane onto it would
 * have changed two things that have nothing to do with SSRF (both measured 2026-09-04):
 *
 *   1. `node:https` neither advertises nor decodes gzip. Every page this lane reads is HTML, and the
 *      identity/gzip spread is ~7x (cosrx PDP 1,252,921 -> 171,935 B; ulta search 1,230,000 -> 113,440 B).
 *   2. axios's `maxContentLength` counts DECODED bytes — verified directly: a 100,000-byte body served as
 *      ~100 gzipped bytes is REJECTED at `maxContentLength: 50000`. The lane's cap
 *      (`AURORA_BFF_PRODUCT_URL_INGREDIENT_MAX_BYTES`, default 900,000) is therefore a decoded cap, and it
 *      already rejects real pages today: ulta search, the cosrx PDP and the anua PDP all throw
 *      ERR_BAD_RESPONSE against the UNMODIFIED lane. A 2 MiB wire cap would have SILENTLY ADMITTED those
 *      three, changing which pages parse. A security fix must not quietly move that line.
 *
 * So this module keeps the axios adapter and fences the two things that actually carry the SSRF — the
 * address a socket may reach, and redirect following — by REUSING `ucpBuyerAgentClient`'s primitives
 * (`forbiddenLiteralHost`, `createPublicOnlyLookup`) rather than minting a second fence. There is no
 * second copy of the range table, the bracket-stripping rule, or the mixed-answer DNS rule.
 *
 * WHY REDIRECTS ARE FOLLOWED RATHER THAN REFUSED. Measured over the endpoints this lane provably reaches
 * (the four retail search hosts and DailyMed/INCIDecoder are built by this same code, not just user URLs)
 * plus a real PDP cohort, 6 of 14 redirect on the FIRST request:
 *
 *     incidecoder search  301   walmart search      307
 *     cosrx PDP           301   anua PDP            301 (to a DIFFERENT apex)
 *     skin1004 PDP        301   cerave PDP (http)   301 -> https
 *
 * Refusing hops would break those outright, including the only http:// input measured — which reaches
 * https exactly BY redirecting. So hops are followed, and every hop re-enters this fence: the Location is
 * re-parsed, re-scheme-checked, re-literal-checked, and dialled through the same public-only resolver.
 * The change is not that we stopped following; it is that following can no longer leave the public
 * internet. `maxRedirects: 0` is what makes that possible — axios's own follower would re-dial a
 * `Location: http://127.0.0.1:PORT` through the pinned agent but NEVER re-run the literal check, because
 * an IP literal skips DNS entirely and the resolver fence is the only thing it would have met. Verified:
 * following a redirect to a literal records exactly ONE lookup, for the original hostname.
 *
 * WHY http:// IS STILL ALLOWED. The lane's own contract is `/^https?:\/\//i` and the measured cohort
 * contains a live http PDP. Scheme is not what makes an SSRF: the address is. http and https are dialled
 * through separately pinned agents carrying the SAME resolver, so neither can reach a private address,
 * and every other scheme (file:, ftp:, gopher:, data:) is refused before a request is built.
 */

const nodeHttp = require('node:http');
const nodeHttps = require('node:https');
const {
  forbiddenLiteralHost,
  createPublicOnlyLookup,
} = require('./ucpBuyerAgentClient');

/**
 * Matches what axios followed before this module existed, so a legitimate chain that resolved then still
 * resolves now. Chains of 2-3 are ordinary in this cohort (http -> https -> www -> locale); every hop
 * measured here is 1. Total merchant-facing traffic is unchanged from the previous behaviour, because the
 * caller's strategy loop is what multiplies requests and it is untouched.
 */
const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** A refusal that says WHICH refusal it was, in the same `PIVOTA_` namespace the UCP client uses. The
 *  sink lowercases `err.code` into its attempt telemetry, so these arrive as `pivota_ssrf_*` rather than
 *  collapsing into the generic `network_error` every other failure reports. */
function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * The one address rule, applied identically to the caller's URL and to every redirect Location.
 * Returns a parsed URL or throws a coded error. Nothing here performs I/O: a refusal happens BEFORE a
 * request object exists, which is what the tests assert.
 */
function parsePublicHttpUrl(rawUrl, { field = 'productUrl' } = {}) {
  const text = String(rawUrl == null ? '' : rawUrl).trim();
  if (!text) throw codedError(`${field} is required`, 'PIVOTA_SSRF_INVALID_URL');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw codedError(`${field} must be a valid absolute URL`, 'PIVOTA_SSRF_INVALID_URL');
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw codedError(`${field} must be http or https`, 'PIVOTA_SSRF_SCHEME');
  }
  // Userinfo is refused rather than stripped. It never belongs in a product URL, and a credential in a
  // URL that this lane echoes back into logs and telemetry is worth refusing on its own.
  if (parsed.username || parsed.password) {
    throw codedError(`${field} must not contain userinfo`, 'PIVOTA_SSRF_USERINFO');
  }
  // The literal check from ucpBuyerAgentClient, NOT a re-implementation. It strips brackets before
  // `net.isIP`, which is the subtlety that decides whether `https://[::1]/` is caught at all: WHATWG
  // `URL.hostname` KEEPS the brackets and `net.isIP('[::1]')` is 0. A literal host also skips DNS
  // entirely, so this is the ONLY guard that sees it — the resolver fence below never runs for one.
  if (forbiddenLiteralHost(parsed.hostname)) {
    throw codedError(`${field} must not resolve to a non-public address`, 'PIVOTA_SSRF_LITERAL');
  }
  return parsed;
}

/**
 * Build the pinned transport. Both agents carry the SAME public-only resolver, so the fence does not
 * depend on which scheme a hop lands on.
 *
 * THE AGENT OPTIONS ARE INHERITED, not invented. `server.js` installs keep-alive agents on
 * `axios.defaults` (`keepAlive`, `keepAliveMsecs`, `maxSockets` 128, `maxFreeSockets`, `scheduling`),
 * and pinning a per-request agent REPLACES them. Constructing bare agents here would therefore have
 * silently undone the operator's socket cap — restoring Node's default of `Infinity` on a lane any
 * caller with a non-empty `X-Aurora-UID` can drive, at up to 3 strategies x (1 + hops) connections per
 * request plus the post-response backfill — and dropped connection reuse on a click path budgeted at
 * 1200 ms per fetch, including the supplement lanes that hit the same six hosts over and over. So the
 * configured agent's own options are cloned and only `lookup` is added.
 *
 * Keep-alive is safe to inherit: a pooled socket is reused only for the host:port it was opened to,
 * which the fence already validated, and a rebinding attack needs a NEW connection — which re-resolves
 * through this same lookup.
 */
function createPublicAgents(lookup, { axiosInstance } = {}) {
  const publicOnlyLookup = createPublicOnlyLookup(lookup);
  const defaults = (axiosInstance && axiosInstance.defaults) || {};
  const inherit = (agent) => ((agent && agent.options) ? { ...agent.options } : {});
  return {
    httpAgent: new nodeHttp.Agent({ ...inherit(defaults.httpAgent), lookup: publicOnlyLookup }),
    httpsAgent: new nodeHttps.Agent({ ...inherit(defaults.httpsAgent), lookup: publicOnlyLookup }),
  };
}

/**
 * Drop credential-bearing headers when a hop crosses to a different origin.
 *
 * `follow-redirects` — the follower this module replaced — strips `authorization` and `cookie` on a
 * cross-host redirect. Reusing the caller's headers verbatim on every hop silently gave that behaviour
 * up, so a merchant could harvest them with a single 302 to a host it controls. This lane only sends
 * `Accept` and `User-Agent` today, but the helper is exported and generic, and the header set is the
 * caller's to change.
 */
function headersForHop(headers, initialOrigin, currentOrigin) {
  if (!headers || currentOrigin === initialOrigin) return headers;
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowered = String(key).toLowerCase();
    if (lowered === 'authorization' || lowered === 'cookie' || lowered === 'proxy-authorization') continue;
    out[key] = value;
  }
  return out;
}

/**
 * Wrap an axios instance so a URL it fetches can never leave the public internet.
 *
 * The returned function takes the SAME (url, config) axios.get takes and returns the same response, so
 * the caller's `timeout`, `maxContentLength`, `responseType`, `headers` and `validateStatus` all keep
 * their existing meaning. Only three keys are overridden, and each is load-bearing:
 *   - `httpAgent`/`httpsAgent`: pinned to the public-only resolver.
 *   - `maxRedirects: 0`: axios must not follow, because its follower cannot re-run the literal check.
 *   - `proxy: false`: axios otherwise honours HTTP(S)_PROXY from the environment, which would route the
 *     request through a proxy socket and bypass the agent — and therefore the resolver — entirely.
 */
function createPublicUrlFetch({ axiosInstance, lookup, maxRedirectHops = MAX_REDIRECT_HOPS } = {}) {
  if (!axiosInstance || typeof axiosInstance.get !== 'function') {
    throw new Error('createPublicUrlFetch requires an axios instance');
  }
  // Built on FIRST USE, not at module load. routes.js is required by server.js before server.js
  // installs its keep-alive agents on `axios.defaults`, so cloning them eagerly would inherit nothing.
  let agents = null;
  const getAgents = () => {
    if (!agents) agents = createPublicAgents(lookup, { axiosInstance });
    return agents;
  };

  return async function fetchPublicUrl(url, config = {}) {
    const { httpAgent, httpsAgent } = getAgents();
    // Refuse before a request exists. Throwing here — rather than returning a sentinel — keeps the
    // caller's existing `catch` the single failure path, so a refusal is reported the way a DNS failure
    // or a timeout already was, with a code that distinguishes it.
    let current = parsePublicHttpUrl(url);
    const origin = current.origin;
    /*
     * The caller's config is used, MINUS the keys that would unpick the fence. `transport` is the sharp
     * one: axios consults `config.transport` BEFORE it looks at `maxRedirects`, so a caller passing
     * `follow-redirects`' http module gets redirect-following back with no hop re-validation at all
     * (reproduced: a `302 -> http://127.0.0.1:PORT` was followed and its body returned). `socketPath` is
     * checked before host/port and dials a unix socket outright. `lookup`, the agents and `proxy` are
     * this module's own fence. None of these is set by a caller today; they are removed so the fence does
     * not depend on that staying true.
     */
    const {
      transport: _transport,
      socketPath: _socketPath,
      lookup: _lookup,
      httpAgent: _httpAgent,
      httpsAgent: _httpsAgent,
      proxy: _proxy,
      maxRedirects: _maxRedirects,
      signal: callerSignalRaw,
      ...safeConfig
    } = config;
    // Falls back to AXIOS'S OWN default (2xx), not to "accept everything". Passing
    // `validateStatus: () => true` inward and re-applying only a caller-SUPPLIED predicate silently
    // turned a 503 into a resolved response for any caller that omitted one.
    const callerValidateStatus = typeof config.validateStatus === 'function'
      ? config.validateStatus
      : ((axiosInstance.defaults && typeof axiosInstance.defaults.validateStatus === 'function')
        ? axiosInstance.defaults.validateStatus
        : ((status) => status >= 200 && status < 300));

    /*
     * A WALL-CLOCK DEADLINE, because `maxRedirects: 0` silently removed the only one that worked.
     *
     * axios routes through `follow-redirects` whenever maxRedirects > 0, and that library starts its own
     * timer when the request is created. maxRedirects: 0 drops to the raw node:https path, where axios's
     * `timeout` becomes `req.setTimeout` — a SOCKET timeout that never fires if a socket is never
     * assigned. Measured: against a hostname whose DNS never answers, `axios.get(url, {timeout: 1500})`
     * rejects at 1525 ms with maxRedirects default and NEVER rejects with maxRedirects: 0. An AbortSignal
     * is not socket-bound and does fire during resolution (measured: 1503 ms).
     *
     * The budget spans the WHOLE chain, not each hop: the caller waits for the chain, and a per-hop timer
     * would let a 5-hop redirect spend five times what it was given.
     */
    const timeoutMs = Number(config.timeout);
    const deadline = new AbortController();
    let deadlineExpired = false;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => { deadlineExpired = true; deadline.abort(); }, timeoutMs)
      : null;
    // The caller's own signal still cancels: composed, not replaced.
    const callerSignal = callerSignalRaw;
    if (callerSignal) {
      if (callerSignal.aborted) deadline.abort();
      else callerSignal.addEventListener('abort', () => deadline.abort(), { once: true });
    }
    try {
      return await runHops();
    } catch (error) {
      // Reported as a TIMEOUT, not a cancellation: `buildUrlFetchFailureCode` keys on a code containing
      // 'timeout'/'ecconnaborted' to produce `url_fetch_timeout`, so letting axios's `ERR_CANCELED`
      // through would silently reclassify every timeout on this lane as a generic failure.
      if (deadlineExpired) throw codedError(`timeout of ${timeoutMs}ms exceeded`, 'ECONNABORTED');
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }

    async function runHops() {
    for (let hop = 0; ; hop += 1) {
      // `validateStatus: () => true` internally so a 3xx reaches this loop instead of being thrown by
      // axios before it can be inspected; the caller's own predicate is applied to the FINAL response
      // below, so its contract is unchanged.
      // eslint-disable-next-line no-await-in-loop
      const response = await axiosInstance.get(current.toString(), {
        ...safeConfig,
        headers: headersForHop(safeConfig.headers, origin, current.origin),
        httpAgent,
        httpsAgent,
        proxy: false,
        maxRedirects: 0,
        signal: deadline.signal,
        validateStatus: () => true,
      });

      const status = Number(response && response.status);
      if (REDIRECT_STATUSES.has(status)) {
        if (hop >= maxRedirectHops) {
          // NOT a `PIVOTA_SSRF_*` code. A merchant redirect loop and a merchant 3xx with no Location are
          // ORDINARY upstream misbehaviour, and routes.js maps `pivota_ssrf*` to the
          // `url_forbidden_address` dial that exists to count refused ADDRESSES. Naming these
          // `PIVOTA_SSRF_` would have poisoned that signal with every looping storefront.
          throw codedError('product url exceeded the redirect hop cap', 'PIVOTA_URL_REDIRECT_CAP');
        }
        const location = response.headers && typeof response.headers.get === 'function'
          ? response.headers.get('location')
          : (response.headers || {}).location;
        if (!location) {
          throw codedError('product url redirected without a location', 'PIVOTA_URL_REDIRECT_NO_LOCATION');
        }
        // Resolved against the URL it came FROM (so a relative Location works), then put through the
        // identical rule the caller's URL went through. This is the re-entry that makes following safe.
        // The resolve is inside the coded try so an unparseable Location reports as a refusal like every
        // other guard here, rather than leaking a bare ERR_INVALID_URL into the caller's telemetry.
        let resolved;
        try {
          resolved = new URL(String(location), current.toString()).toString();
        } catch {
          throw codedError('product url redirected to an unparseable location', 'PIVOTA_SSRF_INVALID_URL');
        }
        current = parsePublicHttpUrl(resolved, { field: 'product url redirect location' });
        continue;
      }

      if (callerValidateStatus && !callerValidateStatus(status)) {
        // Shaped like the error axios itself raises for a rejected status, because the sink reads
        // `err.response.status` and `err.code` to build its attempt telemetry.
        const error = codedError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE');
        error.response = response;
        throw error;
      }
      return response;
    }
    }
  };
}

module.exports = {
  createPublicUrlFetch,
  parsePublicHttpUrl,
  createPublicAgents,
  MAX_REDIRECT_HOPS,
};
