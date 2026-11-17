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
 * answers exactly what it answered before this module existed (the app's normal not-found). The same happens on a
 * host other than AGENPAS_PUBLIC_BASE_URL's when that is set, and for any /agenpas path not listed above.
 *
 * NO BUYER DATA IN LOGS. Lines carry an event, an outcome and a reason code: never the token, the purchase id, a
 * header or a body. Express's own request log records `req.path`, which has no query string.
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const config = require('./config');
const { PURCHASE_ID_RE, REASON, mintLinkToken, verifyLinkToken } = require('./linkToken');
const { hostedOrigins } = require('./hostedUrl');
const { projectPurchaseView } = require('./view');
const { SCENARIOS, createFixturePurchaseReader } = require('./devFixtures');

const ASSET_DIR = path.join(__dirname, 'assets');
const ASSETS = Object.freeze({
  'app.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
});
const LINK_HEADER = 'x-agenpas-link';
const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

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

  function readerFor(env) {
    return config.devFixturesEnabled(env) ? fixtureReader : backendReader;
  }

  const router = express.Router({ caseSensitive: true, strict: false });

  // THE GATE. Off, on another host, or not GET/HEAD: not ours, exactly as before.
  router.use((req, res, next) => {
    if (!String(req.path || '').startsWith('/agenpas/')) return next('router');
    const env = envOf();
    if (!config.isEnabled(env)) return next('router');
    if (req.method !== 'GET' && req.method !== 'HEAD') return next('router');
    const base = config.publicBaseUrl(env);
    if (base) {
      const want = new URL(base).host.toLowerCase();
      const got = String(req.headers.host || '').toLowerCase();
      if (got !== want) return next('router');
    }
    return next();
  });

  function verify(req, token, purchaseId) {
    const env = envOf();
    const secret = config.linkSecret(env);
    if (!secret) return { ok: false, reason: REASON.noSecret };
    return verifyLinkToken(token, { purchaseId, secret, now: now() });
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
      log('info', { surface: 'page', outcome: 'refused', reason: 'bad_purchase_id' });
      return res.status(404).send(PAGES.invalid);
    }
    // No secret: no link can be valid, so say so without loading the app.
    if (!config.linkSecret(envOf())) {
      log('info', { surface: 'page', outcome: 'refused', reason: REASON.noSecret });
      return res.status(503).send(PAGES.unavailable);
    }
    return res.status(200).send(SHELL_HTML);
  });

  router.get('/agenpas/api/p/:purchaseId', async (req, res) => {
    const env = envOf();
    setCommonHeaders(res);
    const purchaseId = req.params.purchaseId;
    if (!PURCHASE_ID_RE.test(purchaseId)) return res.status(404).json({ error: 'link_invalid' });
    const token = firstString(req.headers[LINK_HEADER]);
    const verdict = verify(req, token, purchaseId);
    if (!verdict.ok) {
      log('info', { surface: 'api', outcome: 'refused', reason: verdict.reason });
      if (verdict.reason === REASON.noSecret) return res.status(503).json({ error: 'unavailable' });
      if (verdict.reason === REASON.expired) return res.status(410).json({ error: 'link_expired' });
      return res.status(404).json({ error: 'link_invalid' });
    }
    const reader = readerFor(env);
    let answer;
    try {
      answer = reader && typeof reader.read === 'function' ? await reader.read(verdict.claims) : { kind: 'unavailable', code: 'no_reader' };
    } catch {
      answer = { kind: 'unavailable', code: 'threw' };
    }
    if (answer && answer.kind === 'accepted') {
      const view = projectPurchaseView(answer.purchase, {
        purchaseId,
        hostedHosts: config.hostedHosts(env),
        embed: config.embedHostedPages(env),
        now: now(),
        linkExpiresAt: verdict.claims.exp,
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

  // LOCAL DEVELOPMENT ONLY: a fresh fixture link. Off a dev machine (or with the fixture flag off) this path is
  // not ours, exactly like any other unknown path.
  router.get('/agenpas/dev/start', (req, res, next) => {
    const env = envOf();
    if (!config.devFixturesEnabled(env)) return next('router');
    const secret = config.linkSecret(env);
    const name = firstString(req.query.scenario) || 'happy';
    const scenario = Object.prototype.hasOwnProperty.call(SCENARIOS, name) ? SCENARIOS[name] : null;
    if (!secret || !scenario) return next('router');
    const token = mintLinkToken({
      purchaseId: scenario.id, agentId: 'agent_dev_fixture', userRef: 'usr_dev_fixture', secret,
      ttlSeconds: config.linkTtlSeconds(env), now: now(),
    });
    setCommonHeaders(res);
    return res.redirect(302, `/agenpas/p/${scenario.id}#t=${token}`);
  });

  return router;
}

module.exports = {
  LINK_HEADER,
  contentSecurityPolicy,
  createAgenpasRouter,
};
