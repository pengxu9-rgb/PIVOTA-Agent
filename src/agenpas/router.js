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
 *   POST /agenpas/api/p/:purchaseId/consent        ONLY while AGENPAS_CONSENT_ENABLED is on (off: not ours, and the
 *                                                  host guard refuses it): the buyer accepted the terms and privacy
 *                                                  policy for the current step. Token in `X-Agenpas-Link`; JSON body
 *                                                  {step, offer_id, issued_at} (at most 1 kB); exact Origin, Sec-Fetch-
 *                                                  Site same-origin when sent, Content-Type application/json, or 403 /
 *                                                  415. The
 *                                                  versions recorded come from the gateway's own latest read.
 *   POST /agenpas/api/p/:purchaseId/shipping-address  ONLY while AGENPAS_COLLECT_SHIPPING is on: the buyer's shipping
 *                                                  address and email (JSON, at most 4 KB, token in `X-Agenpas-Link`).
 *                                                  409 consent_required while the step's terms are not accepted;
 *                                                  409 address_not_requested when the gateway's read shows no form;
 *                                                  409 address_not_taken for the backend's other 409s.
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
const { consentToRecord, projectPurchaseView, shippingConsentPending } = require('./view');
const { sanitizeFieldErrors, validateAddress } = require('./shippingAddress');
const { createTokenBucketLimiter } = require('../services/publicReadRateLimit');
const { clientIpFromRequest } = require('../guardrails/gatewayGuardrails');
const { SCENARIOS, createFixtures } = require('./devFixtures');

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
// The address write, per link token: 5 a minute.
const ADDRESS_LIMIT = Object.freeze({ capacity: 5, refillPerSecond: 5 / 60 });
const ADDRESS_BODY_MAX_BYTES = 4096;
const SHIPPING_PATH_RE = /^\/agenpas\/api\/p\/(?:pp|ap|rp)_[0-9a-f]{24}\/shipping-address$/;

function isJsonContentType(req) {
  return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * Read a JSON body of at most ADDRESS_BODY_MAX_BYTES ourselves (ahead of the app's 10 MB parser, which then skips a
 * request marked `_body`). Resolves { ok, body } or { ok: false, status, error }. Never logs or returns the body.
 */
function readSmallJsonBody(req) {
  if (req._body) {
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(req.body === undefined ? null : req.body));
    } catch {
      return Promise.resolve({ ok: false, status: 400, error: 'invalid_json' });
    }
    return Promise.resolve(size > ADDRESS_BODY_MAX_BYTES ? { ok: false, status: 413, error: 'body_too_large' } : { ok: true, body: req.body });
  }
  if (!isJsonContentType(req)) return Promise.resolve({ ok: false, status: 415, error: 'unsupported_media_type' });
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > ADDRESS_BODY_MAX_BYTES) {
    return Promise.resolve({ ok: false, status: 413, error: 'body_too_large' });
  }
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      resolve(answer);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > ADDRESS_BODY_MAX_BYTES) {
        finish({ ok: false, status: 413, error: 'body_too_large' });
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        finish({ ok: false, status: 400, error: 'invalid_json' });
        return;
      }
      req.body = body;
      req._body = true;
      req.agenpasBodyRead = true;
      finish({ ok: true, body });
    });
    req.on('error', () => finish({ ok: false, status: 400, error: 'invalid_body' }));
  });
}
// Per client IP: looser, because many buyers can share one carrier NAT address.
const IP_LIMIT = Object.freeze({ capacity: 30, refillPerSecond: 5 });
const RATE_LIMIT_RETRY_AFTER_SECONDS = 2;
const LOG_SAMPLE_PER_MINUTE = 5;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
// The consent POST: its raw path, its body members and their shapes (view.js accepts the same offer shapes).
const CONSENT_POST_PATH_RE = /^\/agenpas\/api\/p\/(?:pp|ap|rp)_[0-9a-f]{24}\/consent$/;
const CONSENT_BODY_KEYS = Object.freeze(['step', 'offer_id', 'issued_at']);
// `shipping_address`: the A2A address form is consent-gated too (the owner's decision, 11-20; view.js).
const CONSENT_STEPS = new Set(['card_binding', 'approval', 'shipping_address']);
const CONSENT_OFFER_ID_RE = /^[A-Za-z0-9+/=_-]{16,128}$/;
const CONSENT_ISSUED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/;
const CONSENT_BODY_LIMIT_BYTES = 1024;

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
<title>AgenPaz</title>
<link rel="stylesheet" href="/agenpas/assets/app.css">
<script src="/agenpas/assets/app.js" defer></script>
</head>
<body>
<div class="shell">
<header class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">AgenPaz</span><span class="brand-secure">Secure checkout</span></header>
<main id="app" aria-live="polite">
<section class="card"><p class="muted">Loading your purchase…</p></section>
</main>
<noscript><section class="card"><h1>Turn on JavaScript</h1><p>AgenPaz needs JavaScript to show your purchase. Your card details are never entered on this page.</p></section></noscript>
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
<title>AgenPaz</title>
<link rel="stylesheet" href="/agenpas/assets/app.css">
</head>
<body>
<div class="shell">
<header class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">AgenPaz</span><span class="brand-secure">Secure checkout</span></header>
<main><section class="card"><h1>${title}</h1><p>${body}</p></section></main>
</div>
</body>
</html>
`;
}

// Static wording only: nothing from the request is ever interpolated into HTML.
const PAGES = Object.freeze({
  invalid: messageHtml("This link isn't valid", 'Please open the link exactly as the chat gave it to you, or ask the chat for a new one.'),
  unavailable: messageHtml("AgenPaz isn't available right now", 'Please go back to the chat and try again in a little while.'),
});

function firstString(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

/** The request's media type, lower-cased, parameters dropped ('' when none). */
function mediaTypeOf(req) {
  return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
}

/** The consent POST shape: exactly POST, the flag on, exactly the raw consent path (no decoding, no extras). */
function isConsentPost(req, env) {
  if (req.method !== 'POST' || !config.consentEnabled(env)) return false;
  const raw = rawPathOf(req);
  return !UNSAFE_PATH_RE.test(raw) && CONSENT_POST_PATH_RE.test(raw);
}

/** The browser's consent body: exactly {step, offer_id, issued_at}, each well formed; else null. */
function consentBodyOf(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== CONSENT_BODY_KEYS.length || !CONSENT_BODY_KEYS.every((k) => keys.includes(k))) return null;
  const { step, offer_id: offerId, issued_at: issuedAt } = body;
  if (!CONSENT_STEPS.has(step)) return null;
  if (typeof offerId !== 'string' || !CONSENT_OFFER_ID_RE.test(offerId)) return null;
  if (typeof issuedAt !== 'string' || !CONSENT_ISSUED_AT_RE.test(issuedAt)) return null;
  return { step, offer_id: offerId, issued_at: issuedAt };
}

/**
 * @param {{
 *   reader: { read: (claims) => Promise<object> },   the backend reader (purchaseReader.js)
 *   logger?: object,
 *   env?: object,                                     tests only; defaults to process.env, read per request
 *   now?: () => number,                               tests only
 *   consentWriter?: { record: (claims, consent) => Promise<object> },  the backend consent write (purchaseReader.js)
 *   fixtureReader?: { read: Function },               tests only
 *   fixtureConsentWriter?: { record: Function },      tests only
 *   limits?: { token?: object, ip?: object },         tests only: token bucket options
 * }} deps
 */
function createAgenpasRouter(deps = {}) {
  const envOf = () => deps.env || process.env;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const logger = deps.logger && typeof deps.logger.info === 'function' ? deps.logger : null;
  const backendReader = deps.reader;
  const backendConsentWriter = deps.consentWriter;
  const fixtures = createFixtures({ now });
  const fixtureReader = deps.fixtureReader || fixtures.reader;
  const fixtureConsentWriter = deps.fixtureConsentWriter || fixtures.consentWriter;
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
  const addressBuckets = createTokenBucketLimiter({ ...ADDRESS_LIMIT, ...(limits.address || {}), now });
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
  const readKey = (claims, fixture) => `${fixture ? 'fx' : 'be'}|${claims.agentId}|${claims.purchaseId}`;
  // After a recorded consent the next poll must see the backend's new answer (the hosted page), not a cached one.
  function forgetRead(claims, fixture) {
    reads.delete(readKey(claims, fixture));
  }
  function readOnce(reader, claims, fixture) {
    const key = readKey(claims, fixture);
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

  // THE GATE. Off, no public base URL, another host, or not GET/HEAD: not ours, exactly as before. The one exception
  // is the consent POST, and only while AGENPAS_CONSENT_ENABLED is on (isConsentPost).
  router.use((req, res, next) => {
    if (!String(req.path || '').startsWith('/agenpas/')) return next('router');
    const env = envOf();
    if (!config.isEnabled(env)) return next('router');
    const addressPost = req.method === 'POST' && SHIPPING_PATH_RE.test(req.path) && config.collectShipping(env);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !addressPost && !isConsentPost(req, env)) return next('router');
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

  function viewOptions(env, purchaseId, claims) {
    const consentOn = config.consentEnabled(env);
    return {
      purchaseId,
      hostedHosts: config.hostedHosts(env),
      embed: config.embedHostedPages(env),
      now: now(),
      linkExpiresAt: claims.exp,
      linkTtlMinutes: Math.max(1, Math.floor((claims.exp - claims.iat) / 60)),
      collectShipping: config.collectShipping(env),
      // Only while the flag is on: off, the projection is called exactly as before.
      ...(consentOn ? { consentEnabled: true, legalHosts: config.legalHosts(env) } : {}),
    };
  }

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
      const view = projectPurchaseView(answer.purchase, viewOptions(env, purchaseId, verdict.claims));
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

  /*
   * THE ADDRESS WRITE (AGENPAS_COLLECT_SHIPPING; docs/agenpas.md, "Shipping address"). JSON only (415), at most 4 KB
   * (413), the link token in X-Agenpas-Link only (a header no cross-site form can send), 5 a minute per link (429) on
   * top of the IP bucket. The address goes to the backend and nowhere else: no log line, no error message and no
   * refusal carries any of it (field errors are codes).
   */
  router.post('/agenpas/api/p/:purchaseId/shipping-address', async (req, res) => {
    const env = envOf();
    setCommonHeaders(res);
    const purchaseId = req.params.purchaseId;
    if (!ipBuckets.allow(`ip:${digest(clientIpFromRequest(req) || 'unknown')}`)) return tooMany(res, 'address', 'rate_limited_ip');
    if (!PURCHASE_ID_RE.test(purchaseId)) return res.status(404).json({ error: 'link_invalid' });
    if (!req._body && !isJsonContentType(req)) {
      logRefusal({ surface: 'address', reason: 'unsupported_media_type' });
      return res.status(415).json({ error: 'unsupported_media_type' });
    }
    const token = firstString(req.headers[LINK_HEADER]);
    const verdict = verify(token, purchaseId);
    if (!verdict.ok) {
      logRefusal({ surface: 'address', reason: verdict.reason });
      if (verdict.reason === REASON.noSecret) return res.status(503).json({ error: 'unavailable' });
      if (verdict.reason === REASON.expired) return res.status(410).json({ error: 'link_expired', link_ttl_minutes: config.linkTtlMinutes(env) });
      return res.status(404).json({ error: 'link_invalid' });
    }
    if (!addressBuckets.allow(`a:${digest(token)}`)) return tooMany(res, 'address', 'rate_limited_token');
    const parsed = await readSmallJsonBody(req);
    if (!parsed.ok) {
      logRefusal({ surface: 'address', reason: parsed.error });
      return res.status(parsed.status).json({ error: parsed.error });
    }
    const fixture = fixturesFor(req, env);
    const reader = fixture ? fixtureReader : backendReader;
    // A FRESH read (never the 2 s cache: a read cached on this instance before a consent recorded elsewhere must not
    // send the buyer back to the terms), and what it shows decides: the address goes on ONLY when the page would show
    // the form (A2A, the shipping step, its consent satisfied or not gated, not held, not placing).
    forgetRead(verdict.claims, fixture);
    const current = await readOnce(reader, verdict.claims, fixture);
    if (!current || (current.kind !== 'accepted' && current.kind !== 'not_found')) {
      res.setHeader('Retry-After', String(UNAVAILABLE_RETRY_AFTER_SECONDS));
      return res.status(503).json({ error: 'unavailable', retry_after_seconds: UNAVAILABLE_RETRY_AFTER_SECONDS });
    }
    if (current.kind === 'not_found') return res.status(404).json({ error: 'not_found' });
    // The form is consent-gated and the buyer has not accepted yet (the gateway's own read says so): nothing is sent
    // on, and the page goes back to the terms. What the buyer typed stays on their page (app.js).
    if (shippingConsentPending(current.purchase, { purchaseId, now: now(), collectShipping: true })) {
      logRefusal({ surface: 'address', reason: 'consent_required' });
      return res.status(409).json({ error: 'consent_required' });
    }
    const projected = projectPurchaseView(current.purchase, { purchaseId, now: now(), collectShipping: true });
    const request = projected.screen === 'shipping_address' && projected.address_request ? projected.address_request : null;
    if (!request) {
      // No form on the gateway's own read (held, placing or later, the rp_ rail, an unsatisfied shipping block, the
      // address already given): nothing is sent on.
      logRefusal({ surface: 'address', reason: 'not_requested' });
      return res.status(409).json({ error: 'address_not_requested' });
    }
    const checked = validateAddress(parsed.body, { required: request.fields_missing });
    if (!checked.ok) {
      logRefusal({ surface: 'address', reason: 'invalid_address' });
      return res.status(422).json({ error: 'invalid_address', field_errors: checked.field_errors });
    }
    let answer;
    try {
      answer = reader && typeof reader.submitShippingAddress === 'function'
        ? await reader.submitShippingAddress(verdict.claims, checked.value)
        : { kind: 'unavailable', code: 'no_writer' };
    } catch {
      answer = { kind: 'unavailable', code: 'threw' };
    }
    // Whatever happened, the next poll reads afresh.
    forgetRead(verdict.claims, fixture);
    if (answer && answer.kind === 'accepted') {
      const view = projectPurchaseView(answer.purchase, viewOptions(env, purchaseId, verdict.claims));
      log('info', { surface: 'address', outcome: 'accepted', state: view.state, screen: view.screen });
      return res.status(200).json(view);
    }
    if (answer && answer.kind === 'invalid') {
      logRefusal({ surface: 'address', reason: 'backend_invalid' });
      // Codes only, whatever the writer handed back: never a value the buyer typed.
      return res.status(422).json({ error: 'invalid_address', field_errors: sanitizeFieldErrors(answer.field_errors) });
    }
    if (answer && answer.kind === 'consent_required') {
      // The backend's own gate (the consent is not on record there): the same answer as ours above.
      logRefusal({ surface: 'address', reason: 'backend_consent_required' });
      return res.status(409).json({ error: 'consent_required' });
    }
    if (answer && answer.kind === 'not_taken') {
      // Any other 409 from the backend (collection turned off while the page was open, ...): not taken here any more.
      logRefusal({ surface: 'address', reason: 'not_taken' });
      return res.status(409).json({ error: 'address_not_taken' });
    }
    if (answer && answer.kind === 'conflict') {
      logRefusal({ surface: 'address', reason: 'already_set' });
      return res.status(409).json({ error: 'address_already_set' });
    }
    if (answer && answer.kind === 'not_found') return res.status(404).json({ error: 'not_found' });
    log('warn', { surface: 'address', outcome: 'unavailable', reason: (answer && typeof answer.code === 'string' && answer.code) || 'unknown' });
    res.setHeader('Retry-After', String(UNAVAILABLE_RETRY_AFTER_SECONDS));
    return res.status(503).json({ error: 'unavailable', retry_after_seconds: UNAVAILABLE_RETRY_AFTER_SECONDS });
  });

  // THE CONSENT POST (only reached while AGENPAS_CONSENT_ENABLED is on: the gate above). Cross-site defence first, before
  // any token or body work: the exact public Origin, Sec-Fetch-Site same-origin and a JSON content type (a plain HTML
  // form can send none of these, and no CORS preflight is ever answered on this host). Then the link, the buckets,
  // a 1 kB strict JSON body of exactly three members, and the gateway's OWN latest read of the purchase: the step must
  // be the one the page offers now, and the versions recorded are that read's, never the browser's.
  const consentJson = express.json({ limit: CONSENT_BODY_LIMIT_BYTES, strict: true, type: () => true });
  function parseConsentJson(req, res) {
    return new Promise((resolve) => {
      try {
        consentJson(req, res, (err) => resolve(err ? { error: err } : { ok: true }));
      } catch (err) {
        resolve({ error: err });
      }
    });
  }

  router.post('/agenpas/api/p/:purchaseId/consent', async (req, res) => {
    const env = envOf();
    setCommonHeaders(res);
    const purchaseId = req.params.purchaseId;
    const refuse = (status, error, reason) => {
      logRefusal({ surface: 'consent', reason });
      return res.status(status).json({ error });
    };
    if (!ipBuckets.allow(`ip:${digest(clientIpFromRequest(req) || 'unknown')}`)) return tooMany(res, 'consent', 'rate_limited_ip');
    if (!PURCHASE_ID_RE.test(purchaseId)) return refuse(404, 'link_invalid', 'bad_purchase_id');
    if (firstString(req.headers.origin) !== config.publicBaseUrl(env)) return refuse(403, 'forbidden', 'origin');
    // Sec-Fetch-Site refuses only when it is SENT and says anything but same-origin: older browsers (Safari before
    // 16.4, iOS 15) send none, and the exact Origin, the JSON content type, the link header and the refused preflight
    // already stop a cross-site request.
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite !== undefined && firstString(fetchSite) !== 'same-origin') return refuse(403, 'forbidden', 'sec_fetch_site');
    if (mediaTypeOf(req) !== 'application/json') return refuse(415, 'unsupported_media_type', 'content_type');
    const token = firstString(req.headers[LINK_HEADER]);
    const verdict = verify(token, purchaseId);
    if (!verdict.ok) {
      logRefusal({ surface: 'consent', reason: verdict.reason });
      if (verdict.reason === REASON.noSecret) return res.status(503).json({ error: 'unavailable' });
      if (verdict.reason === REASON.expired) {
        return res.status(410).json({ error: 'link_expired', link_ttl_minutes: config.linkTtlMinutes(env) });
      }
      return res.status(404).json({ error: 'link_invalid' });
    }
    if (!tokenBuckets.allow(`t:${digest(token)}`)) return tooMany(res, 'consent', 'rate_limited_token');
    const parsed = await parseConsentJson(req, res);
    if (parsed.error) {
      const tooLarge = parsed.error && (parsed.error.type === 'entity.too.large' || parsed.error.status === 413);
      return refuse(tooLarge ? 413 : 400, tooLarge ? 'payload_too_large' : 'bad_request', tooLarge ? 'body_too_large' : 'body_unparsable');
    }
    // A body some earlier parser already read is held to the same bound.
    if (JSON.stringify(req.body === undefined ? null : req.body).length > CONSENT_BODY_LIMIT_BYTES) {
      return refuse(413, 'payload_too_large', 'body_too_large');
    }
    const consent = consentBodyOf(req.body);
    if (!consent) return refuse(400, 'bad_request', 'body_shape');

    const fixture = fixturesFor(req, env);
    const answer = await readOnce(fixture ? fixtureReader : backendReader, verdict.claims, fixture);
    if (!answer || answer.kind !== 'accepted') {
      if (answer && answer.kind === 'not_found') return refuse(404, 'not_found', 'not_found');
      res.setHeader('Retry-After', String(UNAVAILABLE_RETRY_AFTER_SECONDS));
      logRefusal({ surface: 'consent', reason: 'read_unavailable' });
      return res.status(503).json({ error: 'unavailable', retry_after_seconds: UNAVAILABLE_RETRY_AFTER_SECONDS });
    }
    const toRecord = consentToRecord(answer.purchase, viewOptions(env, purchaseId, verdict.claims));
    if (!toRecord || toRecord.step !== consent.step) return refuse(409, 'consent_stale', 'not_offered');

    const writer = fixture ? fixtureConsentWriter : backendConsentWriter;
    let written;
    try {
      written = writer && typeof writer.record === 'function'
        ? await writer.record(verdict.claims, { ...consent, terms_version: toRecord.terms_version, privacy_version: toRecord.privacy_version })
        : { kind: 'unavailable', code: 'no_writer' };
    } catch {
      written = { kind: 'unavailable', code: 'threw' };
    }
    const kind = written && written.kind;
    if (kind === 'recorded') {
      forgetRead(verdict.claims, fixture);
      log('info', { surface: 'consent', outcome: 'recorded', step: consent.step });
      return res.status(200).json({ recorded: true });
    }
    // The backend's dwell has not passed yet: the page waits and lets the buyer press again (nothing changed).
    if (kind === 'too_soon') return refuse(409, 'consent_too_soon', 'too_soon');
    if (kind === 'stale') return refuse(409, 'consent_stale', 'stale');
    if (kind === 'refused') return refuse(400, 'consent_refused', 'refused');
    log('warn', { surface: 'consent', outcome: 'unavailable', reason: (written && typeof written.code === 'string' && written.code) || 'unknown' });
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
  // Any id of plain characters: a well-formed one is the page, anything else the router's friendly "isn't valid" page.
  /^\/agenpas\/p\/[A-Za-z0-9_-]{1,64}$/,
  /^\/agenpas\/api\/p\/(?:pp|ap|rp)_[0-9a-f]{24}$/,
  /^\/agenpas\/assets\/app\.(?:js|css)$/,
];
const DEV_PATHS = [/^\/agenpas\/dev\/start$/];
const UNSAFE_PATH_RE = /[%\\]|\.\.|\/\/|\/\.(?:\/|$)/;

// The ONE write the AgenPas host admits, only while address collection is on.
const ADMITTED_POST_PATHS = [SHIPPING_PATH_RE];

function admitted(req, env) {
  // The non-GET shapes: the consent POST (only while AGENPAS_CONSENT_ENABLED is on) and the address POST (only while
  // AGENPAS_COLLECT_SHIPPING is on). Everything else that is not GET/HEAD (OPTIONS included: no preflight is ever
  // answered here) is refused.
  if (isConsentPost(req, env)) return true;
  const raw = rawPathOf(req);
  if (UNSAFE_PATH_RE.test(raw)) return false;
  if (req.method === 'POST') return config.collectShipping(env) && ADMITTED_POST_PATHS.some((re) => re.test(raw));
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
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
    async front(req, res, next) {
      const env = envOf();
      if (!isOnAgenpasHost(req, env)) return next();
      if (!admitted(req, env)) return refuse(res, 'front');
      // The consent POST's body is parsed by its own route (strict, at most 1 kB).
      if (req.method !== 'POST' || isConsentPost(req, env)) return next();
      // The admitted write's body is read HERE, capped, before the app's own 10 MB JSON parser can (it skips a body
      // already read). JSON only.
      if (!isJsonContentType(req)) {
        setCommonHeaders(res);
        return res.status(415).json({ error: 'unsupported_media_type' });
      }
      const parsed = await readSmallJsonBody(req);
      if (!parsed.ok) {
        setCommonHeaders(res);
        return res.status(parsed.status).json({ error: parsed.error });
      }
      return next();
    },
    // The app's global JSON parser skips this host: the bodies it admits are parsed here (the consent POST by its own
    // route, strictly and at most 1 kB; the address POST by front() above, at most 4 KB). False while AgenPas is off,
    // so the parser is then exactly as before.
    skipsGlobalBodyParser: (req) => isOnAgenpasHost(req, envOf()),
    back(req, res, next) {
      return isOnAgenpasHost(req, envOf()) ? refuse(res, 'back') : next();
    },
  });
}

module.exports = {
  CONSENT_BODY_LIMIT_BYTES,
  LINK_HEADER,
  contentSecurityPolicy,
  createAgenpasHostGuard,
  createAgenpasRouter,
};
