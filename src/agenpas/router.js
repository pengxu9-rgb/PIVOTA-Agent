'use strict';

/*
 * AgenPas routes (docs/agenpas.md). Mounted once in src/server.js; every request re-reads the flags.
 *
 *   GET /agenpas/p/:purchaseId#t=<link token>      the buyer's page (HTML shell; the app is /agenpas/assets/app.js).
 *                                                  The token is in the FRAGMENT, which no browser sends: this route
 *                                                  never sees it, and serves the same shell for any well-formed id.
 *                                                  The page judges the link through the API (410 / 404 screens).
 *   GET /agenpas/api/p/:purchaseId                 JSON for the page: the SAFE projection (view.js). The token comes
 *                                                  ONLY in the `X-Agenpas-Link` header; a `?t=` query is ignored, so
 *                                                  a token never lands in a URL or an access log.
 *   GET /agenpas/assets/app.js | app.css           the page's script and style (same origin: CSP 'self')
 *   GET /agenpas/dev/start?scenario=<name>         LOCAL DEVELOPMENT ONLY (devFixtures.js): mints a fixture link
 *
 * DARK BY DEFAULT. While AGENPAS_ENABLED is off every request is handed straight to `next()`, so an /agenpas path
 * answers exactly what it answered before this module existed (the app's normal not-found). The same happens while
 * AGENPAS_PUBLIC_BASE_URL is unset, on any host other than its host, and for any /agenpas path not listed above.
 *
 * ABUSE VALVES on the API (process-local, like src/services/publicReadRateLimit.js): a token bucket per client IP
 * (checked first) and one per link token, each answering 429 with Retry-After; and a single-flight read with a ~2 s
 * cache per (agent id, purchase id), so any number of pollers of one purchase cost the backend one read per 2 s.
 *
 * LOGS. AgenPas's own lines carry an event, an outcome and a reason code: never the token, a header or a body, and
 * not the purchase id. Refusals are SAMPLED (the first few per reason per minute, then a count). The app's request
 * log (src/server.js) records `req.path`, which DOES contain the purchase id, but no query string and no token.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const config = require('./config');
const { PURCHASE_ID_RE, REASON, mintLinkToken, verifyLinkToken } = require('./linkToken');
const { hostedOrigins } = require('./hostedUrl');
const { projectPurchaseView } = require('./view');
const { createTokenBucketLimiter } = require('../services/publicReadRateLimit');
const { clientIpFromRequest } = require('../guardrails/gatewayGuardrails');
const { SCENARIOS, createFixturePurchaseReader } = require('./devFixtures');

const ASSET_DIR = path.join(__dirname, 'assets');
const ASSETS = Object.freeze({
  'app.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
});
const LINK_HEADER = 'x-agenpas-link';
const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;
const READ_CACHE_MS = 2000;
const READ_CACHE_MAX_KEYS = 5000;
// Per link token: a page polls every 2..15 s, so 2/s with a burst of 10 only ever stops a script.
const TOKEN_LIMIT = Object.freeze({ capacity: 10, refillPerSecond: 2 });
// Per client IP: looser, because many buyers can share one carrier NAT address.
const IP_LIMIT = Object.freeze({ capacity: 30, refillPerSecond: 5 });
const RATE_LIMIT_RETRY_AFTER_SECONDS = 2;
const LOG_SAMPLE_PER_MINUTE = 5;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** The host name of a Host header (no port), lower-cased. */
function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const colon = h.lastIndexOf(':');
  return colon > 0 ? h.slice(0, colon) : h;
}

// NOT a network check: this reads the client-supplied Host header, never the socket. It is one more condition on top
// of the real guards (no managed platform, no production environment, and a loopback AGENPAS_PUBLIC_BASE_URL, which
// is itself accepted only while the fixtures are armed); it only keeps a fixture link from being served under a
// public name by mistake.
function isLoopbackHost(req) {
  return LOOPBACK_HOSTNAMES.has(hostnameOf(req.headers.host));
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function loadAssets() {
  const out = {};
  for (const name of Object.keys(ASSETS)) out[name] = fs.readFileSync(path.join(ASSET_DIR, name));
  return out;
}

function contentSecurityPolicy({ embed, hosts }) {
  const frameSrc = embed && hosts.length > 0 ? hostedOrigins(hosts).join(' ') : "'none'";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    `frame-src ${frameSrc}`,
  ].join('; ');
}

function permissionsPolicy({ embed, hosts }) {
  // A passkey prompt inside a framed hosted page needs the permission delegated to that origin; nothing else does.
  const delegated = embed && hosts.length > 0 ? `(${hostedOrigins(hosts).map((o) => `"${o}"`).join(' ')})` : '()';
  return [
    'camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()',
    `publickey-credentials-get=${delegated}`, `publickey-credentials-create=${delegated}`,
  ].join(', ');
}

function setCommonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  // The link token is in the page URL: no Referer may ever carry it to the hosted page or anywhere else.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

function setPageHeaders(res, env) {
  setCommonHeaders(res);
  const policy = { embed: config.embedHostedPages(env), hosts: config.hostedHosts(env) };
  res.setHeader('Content-Security-Policy', contentSecurityPolicy(policy));
  res.setHeader('Permissions-Policy', permissionsPolicy(policy));
  // `same-origin-allow-popups`: the hosted page we open must not get a handle on this window; ours keeps its
  // handle on the popup (to notice it closing).
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
}

const SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>AgenPas</title>
<link rel="stylesheet" href="/agenpas/assets/app.css">
<script src="/agenpas/assets/app.js" defer></script>
</head>
<body>
<div class="shell">
<header class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">AgenPas</span></header>
<main id="app" aria-live="polite">
<section class="card"><p class="muted">Loading your purchase…</p></section>
</main>
<noscript><section class="card"><h1>Turn on JavaScript</h1><p>AgenPas needs JavaScript to show your purchase. Your card details are never entered on this page.</p></section></noscript>
<footer class="foot">Your card number stays with our payment partner. Pivota never sees it.</footer>
</div>
</body>
</html>
`;

function messageHtml(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>AgenPas</title>
<link rel="stylesheet" href="/agenpas/assets/app.css">
</head>
<body>
<div class="shell">
<header class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">AgenPas</span></header>
<main><section class="card"><h1>${title}</h1><p>${body}</p></section></main>
</div>
</body>
</html>
`;
}

// Static wording only: nothing from the request is ever interpolated into HTML.
const PAGES = Object.freeze({
  invalid: messageHtml("This link isn't valid", 'Please open the link exactly as the chat gave it to you, or ask the chat for a new one.'),
  unavailable: messageHtml("AgenPas isn't available right now", 'Please go back to the chat and try again in a little while.'),
});

function firstString(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

/**
 * @param {{
 *   reader: { read: (claims) => Promise<object> },   the backend reader (purchaseReader.js)
 *   logger?: object,
 *   env?: object,                                     tests only; defaults to process.env, read per request
 *   now?: () => number,                               tests only
 *   fixtureReader?: { read: Function },               tests only
 *   limits?: { token?: object, ip?: object },         tests only: token bucket options
 * }} deps
 */
function createAgenpasRouter(deps = {}) {
  const envOf = () => deps.env || process.env;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const logger = deps.logger && typeof deps.logger.info === 'function' ? deps.logger : null;
  const backendReader = deps.reader;
  const fixtureReader = deps.fixtureReader || createFixturePurchaseReader();
  let assets = null;

  function log(level, fields) {
    if (!logger) return;
    const fn = typeof logger[level] === 'function' ? logger[level] : logger.info;
    try {
      fn.call(logger, { event: 'agenpas', ...fields }, 'agenpas');
    } catch {
      // never changes the answer
    }
  }

  // Fixtures only on a dev machine AND on a loopback Host: a deploy that somehow armed the flag still never serves them.
  function fixturesFor(req, env) {
    return config.devFixturesEnabled(env) && isLoopbackHost(req);
  }

  const limits = deps.limits || {};
  const tokenBuckets = createTokenBucketLimiter({ ...TOKEN_LIMIT, ...(limits.token || {}), now });
  const ipBuckets = createTokenBucketLimiter({ ...IP_LIMIT, ...(limits.ip || {}), now });

  // SAMPLED refusal logs: the first few per reason per minute, then one line carrying how many were not logged.
  const sampled = new Map();
  function logRefusal(fields) {
    const key = `${fields.surface}:${fields.reason}`;
    const t = now();
    let entry = sampled.get(key);
    if (!entry || t - entry.windowStart >= 60_000) {
      if (entry && entry.suppressed > 0) log('info', { ...fields, outcome: 'refused_suppressed', suppressed: entry.suppressed });
      entry = { windowStart: t, logged: 0, suppressed: 0 };
      sampled.set(key, entry);
    }
    if (entry.logged < LOG_SAMPLE_PER_MINUTE) {
      entry.logged += 1;
      log('info', { ...fields, outcome: 'refused' });
    } else {
      entry.suppressed += 1;
    }
  }

  // SINGLE-FLIGHT + SHORT CACHE per (reader, agent id, purchase id). Every answer (unavailable included) is kept
  // for READ_CACHE_MS: during a backend outage pollers wait on one read instead of each sending their own.
  const reads = new Map();
  function readOnce(reader, claims, fixture) {
    const key = `${fixture ? 'fx' : 'be'}|${claims.agentId}|${claims.purchaseId}`;
    const t = now();
    const hit = reads.get(key);
    if (hit && (hit.pending || t - hit.at < READ_CACHE_MS)) return hit.promise;
    if (reads.size >= READ_CACHE_MAX_KEYS) {
      for (const [k, v] of reads) if (!v.pending && t - v.at >= READ_CACHE_MS) reads.delete(k);
      if (reads.size >= READ_CACHE_MAX_KEYS) reads.clear();
    }
    const entry = { pending: true, at: t, promise: null };
    entry.promise = (async () => {
      try {
        return reader && typeof reader.read === 'function' ? await reader.read(claims) : { kind: 'unavailable', code: 'no_reader' };
      } catch {
        return { kind: 'unavailable', code: 'threw' };
      } finally {
        entry.pending = false;
        entry.at = now();
      }
    })();
    reads.set(key, entry);
    return entry.promise;
  }

  function tooMany(res, surface, reason) {
    logRefusal({ surface, reason });
    res.setHeader('Retry-After', String(RATE_LIMIT_RETRY_AFTER_SECONDS));
    return res.status(429).json({ error: 'rate_limited', retry_after_seconds: RATE_LIMIT_RETRY_AFTER_SECONDS });
  }

  const router = express.Router({ caseSensitive: true, strict: false });

  // THE GATE. Off, no public base URL, another host, or not GET/HEAD: not ours, exactly as before.
  router.use((req, res, next) => {
    if (!String(req.path || '').startsWith('/agenpas/')) return next('router');
    const env = envOf();
    if (!config.isEnabled(env)) return next('router');
    if (req.method !== 'GET' && req.method !== 'HEAD') return next('router');
    if (!isAgenpasOrigin(req, env)) return next('router');
    return next();
  });

  function verify(token, purchaseId) {
    const env = envOf();
    const secret = config.linkSecret(env);
    if (!secret) return { ok: false, reason: REASON.noSecret };
    return verifyLinkToken(token, { purchaseId, aud: config.publicBaseUrl(env), secret, now: now() });
  }

  router.get('/agenpas/assets/:name', (req, res, next) => {
    const type = Object.prototype.hasOwnProperty.call(ASSETS, req.params.name) ? ASSETS[req.params.name] : null;
    if (!type) return next('router');
    if (!assets) assets = loadAssets();
    setCommonHeaders(res);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Content-Type', type);
    return res.status(200).send(assets[req.params.name]);
  });

  router.get('/agenpas/p/:purchaseId', (req, res) => {
    setPageHeaders(res, envOf());
    res.type('html');
    const purchaseId = req.params.purchaseId;
    if (!PURCHASE_ID_RE.test(purchaseId)) {
      logRefusal({ surface: 'page', reason: 'bad_purchase_id' });
      return res.status(404).send(PAGES.invalid);
    }
    // No secret: no link can be valid, so say so without loading the app.
    if (!config.linkSecret(envOf())) {
      logRefusal({ surface: 'page', reason: REASON.noSecret });
      return res.status(503).send(PAGES.unavailable);
    }
    return res.status(200).send(SHELL_HTML);
  });

  router.get('/agenpas/api/p/:purchaseId', async (req, res) => {
    const env = envOf();
    setCommonHeaders(res);
    const purchaseId = req.params.purchaseId;
    // The IP bucket first, before any token work: it is the one valve a caller cannot multiply by minting garbage.
    if (!ipBuckets.allow(`ip:${digest(clientIpFromRequest(req) || 'unknown')}`)) return tooMany(res, 'api', 'rate_limited_ip');
    if (!PURCHASE_ID_RE.test(purchaseId)) {
      logRefusal({ surface: 'api', reason: 'bad_purchase_id' });
      return res.status(404).json({ error: 'link_invalid' });
    }
    const token = firstString(req.headers[LINK_HEADER]);
    const verdict = verify(token, purchaseId);
    if (!verdict.ok) {
      logRefusal({ surface: 'api', reason: verdict.reason });
      if (verdict.reason === REASON.noSecret) return res.status(503).json({ error: 'unavailable' });
      if (verdict.reason === REASON.expired) {
        return res.status(410).json({ error: 'link_expired', link_ttl_minutes: config.linkTtlMinutes(env) });
      }
      return res.status(404).json({ error: 'link_invalid' });
    }
    if (!tokenBuckets.allow(`t:${digest(token)}`)) return tooMany(res, 'api', 'rate_limited_token');
    const fixture = fixturesFor(req, env);
    const answer = await readOnce(fixture ? fixtureReader : backendReader, verdict.claims, fixture);
    if (answer && answer.kind === 'accepted') {
      const view = projectPurchaseView(answer.purchase, {
        purchaseId,
        hostedHosts: config.hostedHosts(env),
        embed: config.embedHostedPages(env),
        now: now(),
        linkExpiresAt: verdict.claims.exp,
        linkTtlMinutes: Math.max(1, Math.floor((verdict.claims.exp - verdict.claims.iat) / 60)),
      });
      log('info', { surface: 'api', outcome: 'served', state: view.state, screen: view.screen });
      return res.status(200).json(view);
    }
    if (answer && answer.kind === 'not_found') {
      log('info', { surface: 'api', outcome: 'not_found' });
      return res.status(404).json({ error: 'not_found' });
    }
    log('warn', { surface: 'api', outcome: 'unavailable', reason: (answer && typeof answer.code === 'string' && answer.code) || 'unknown' });
    res.setHeader('Retry-After', String(UNAVAILABLE_RETRY_AFTER_SECONDS));
    return res.status(503).json({ error: 'unavailable', retry_after_seconds: UNAVAILABLE_RETRY_AFTER_SECONDS });
  });

  // LOCAL DEVELOPMENT ONLY: a fresh fixture link. Off a dev machine, with the fixture flag off, or on a Host that is
  // not loopback, this path is not ours, exactly like any other unknown path.
  router.get('/agenpas/dev/start', (req, res, next) => {
    const env = envOf();
    if (!fixturesFor(req, env)) return next('router');
    const secret = config.linkSecret(env);
    const name = firstString(req.query.scenario) || 'happy';
    const scenario = Object.prototype.hasOwnProperty.call(SCENARIOS, name) ? SCENARIOS[name] : null;
    if (!secret || !scenario) return next('router');
    const token = mintLinkToken({
      purchaseId: scenario.id, agentId: 'agent_dev_fixture', userRef: 'usr_dev_fixture', aud: config.publicBaseUrl(env), secret,
      ttlSeconds: config.linkTtlSeconds(env), now: now(),
    });
    setCommonHeaders(res);
    return res.redirect(302, `/agenpas/p/${scenario.id}#t=${token}`);
  });

  return router;
}

/*
 * THE AGENPAS HOST IS EXCLUSIVE. With AgenPas on and AGENPAS_PUBLIC_BASE_URL set, a request whose Host is that
 * origin's host is AgenPas's or nothing: `front` (mounted FIRST in src/server.js, ahead of CORS, the body parser, the
 * internal UI's static files and every route) answers 404 to anything but GET/HEAD under /agenpas/, and `back`
 * (mounted right after the AgenPas router) answers 404 to an /agenpas/ path the router did not serve. So no other
 * gateway page (the internal UI has no CSP) ever shares the origin where the buyer's link token lives
 * (sessionStorage). Off, or on any other host, both call next() and change nothing.
 */
const HOST_REFUSAL_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** The base URL's host name (lower-case, no trailing dot, no port), or null while AgenPas is off / unconfigured. */
function agenpasHostname(env) {
  if (!config.isEnabled(env)) return null;
  const base = config.publicBaseUrl(env);
  return base ? new URL(base).hostname.toLowerCase().replace(/\.$/, '') : null;
}

/** The request's Host, normalised: lower-case host name without a trailing dot, and its port ('' when none). */
function requestHost(req) {
  const raw = String((req && req.headers && req.headers.host) || '').trim().toLowerCase();
  let name = raw;
  let port = '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    name = raw.slice(0, end + 1);
    port = raw.slice(end + 2);
  } else if (raw.lastIndexOf(':') > 0) {
    name = raw.slice(0, raw.lastIndexOf(':'));
    port = raw.slice(raw.lastIndexOf(':') + 1);
  }
  return { name: name.replace(/\.$/, ''), port };
}

/**
 * True when the request is for the AgenPas public host, by HOST NAME: any port and a trailing dot count, so
 * `agenpas.example:8443` and `agenpas.example.` are the AgenPas host too (and get only what it serves). Only the Host
 * header decides; X-Forwarded-Host is never read.
 */
function isOnAgenpasHost(req, env) {
  const hostname = agenpasHostname(env);
  return Boolean(hostname) && requestHost(req).name === hostname;
}

/** The request is EXACTLY the public origin (scheme-default port spelled or not): the one place routes answer. */
function isAgenpasOrigin(req, env) {
  const base = config.publicBaseUrl(env);
  if (!base || !isOnAgenpasHost(req, env)) return false;
  const u = new URL(base);
  const want = u.port || (u.protocol === 'https:' ? '443' : '80');
  const got = requestHost(req).port || (u.protocol === 'https:' ? '443' : '80');
  return got === want;
}

/** The path as it arrived on the request line, before any decoding: absolute-form stripped, no query. */
function rawPathOf(req) {
  let u = String(req.originalUrl || req.url || '');
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(u);
  if (absolute) u = u.slice(absolute[0].length) || '/';
  const cut = u.search(/[?#]/);
  return cut >= 0 ? u.slice(0, cut) : u;
}

// The ONLY paths the AgenPas host admits. Matched on the raw path: an encoded byte, a dot segment, a backslash or a
// double slash is refused outright, so nothing a later decoder (express.static's `send`) could resolve differently
// ever gets past.
const ADMITTED_PATHS = [
  /^\/agenpas\/p\/(?:pp|ap|rp)_[0-9a-f]{24}$/,
  /^\/agenpas\/api\/p\/(?:pp|ap|rp)_[0-9a-f]{24}$/,
  /^\/agenpas\/assets\/app\.(?:js|css)$/,
];
const DEV_PATHS = [/^\/agenpas\/dev\/start$/];
const UNSAFE_PATH_RE = /[%\\]|\.\.|\/\/|\/\.(?:\/|$)/;

function admitted(req, env) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const raw = rawPathOf(req);
  if (UNSAFE_PATH_RE.test(raw)) return false;
  if (ADMITTED_PATHS.some((re) => re.test(raw))) return true;
  return config.devFixturesEnabled(env) && isLoopbackHost(req) && DEV_PATHS.some((re) => re.test(raw));
}

/*
 * THE AGENPAS HOST IS EXCLUSIVE. With AgenPas on and AGENPAS_PUBLIC_BASE_URL set, a request whose Host is that
 * origin's host name (any port, trailing dot or case) is AgenPas's or nothing:
 *   front  mounted FIRST in src/server.js (ahead of CORS, the body parser, the internal UI's static files and every
 *          route): 404 unless the request is a GET/HEAD of exactly one of the AgenPas route shapes (ADMITTED_PATHS,
 *          judged on the raw path; /agenpas/dev/start only with the fixtures armed on a loopback Host).
 *   back   mounted right after the AgenPas router: 404 for an admitted path the router did not serve.
 * Each refusal names its guard (`X-Agenpas-Guard: front|back`). The internal UI's static handler also skips this
 * host (onHost). Off, or on any other host, both call next() and change nothing.
 */
function createAgenpasHostGuard(deps = {}) {
  const envOf = () => deps.env || process.env;
  const refuse = (res, which) => {
    setCommonHeaders(res);
    res.setHeader('Content-Security-Policy', HOST_REFUSAL_CSP);
    res.setHeader('X-Agenpas-Guard', which);
    return res.status(404).type('text/plain').send('Not found');
  };
  return Object.freeze({
    onHost: (req) => isOnAgenpasHost(req, envOf()),
    front(req, res, next) {
      const env = envOf();
      if (!isOnAgenpasHost(req, env)) return next();
      return admitted(req, env) ? next() : refuse(res, 'front');
    },
    back(req, res, next) {
      return isOnAgenpasHost(req, envOf()) ? refuse(res, 'back') : next();
    },
  });
}

module.exports = {
  LINK_HEADER,
  contentSecurityPolicy,
  createAgenpasHostGuard,
  createAgenpasRouter,
};
