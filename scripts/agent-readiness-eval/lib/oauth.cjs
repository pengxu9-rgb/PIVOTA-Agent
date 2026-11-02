'use strict';

// THE EVAL CLIENT'S OAUTH TOKEN, for the production synthetic target (safety.cjs, PROD_SYNTHETIC_HOSTS).
//
// Production marks a call synthetic only when its verified access token was issued by our authorization server
// to the eval client listed in the gateway's SYNTHETIC_CALLERS_JSON (docs/runbooks/synthetic_callers.md). That
// server grants authorization_code + refresh_token only, so a person signs in ONCE (`login`, a browser and a
// loopback redirect, PKCE S256); every later run refreshes the token itself (`ensureFreshToken`).
//
// The issuer, its endpoints, the resource and the redirect are COMPILED IN: a typo cannot send the client
// secret or a code anywhere else. The client id and secret come from the environment only (the secret from
// Secret Manager, never a flag, never logged). The token file is written 0600, outside any git checkout.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const OAUTH = Object.freeze({
  issuer: 'https://api.pivota.cc',
  authorizationEndpoint: 'https://api.pivota.cc/oauth/authorize',
  tokenEndpoint: 'https://api.pivota.cc/oauth/token',
  // The audience the commerce door verifies (MCP_OAUTH_RESOURCE).
  resource: 'https://commerce.mcp.pivota.cc/mcp',
  scope: 'pivota.checkout',
  redirectHost: '127.0.0.1',
  redirectPort: 8765,
  redirectPath: '/callback',
});
const REDIRECT_URI = `http://${OAUTH.redirectHost}:${OAUTH.redirectPort}${OAUTH.redirectPath}`;
const DEFAULT_TOKEN_FILE = path.join(os.homedir(), '.pivota-eval', 'oauth-token.json');
// Refresh when less than this is left; a production synthetic run lasts at most 3000 s (safety.cjs).
const MIN_FRESH_SECONDS = 3300;
// A classification check or a canary takes seconds: it needs only this much of the stored token.
const SHORT_JOB_MIN_SECONDS = 300;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A PKCE verifier and its S256 challenge. */
function pkcePair(random = crypto.randomBytes) {
  const verifier = b64url(random(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function clientCredentials(env = process.env) {
  const clientId = String(env.READINESS_EVAL_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(env.READINESS_EVAL_OAUTH_CLIENT_SECRET || '').trim();
  const problems = [];
  if (!/^mcpc_[0-9a-f]{32}$/.test(clientId)) problems.push('READINESS_EVAL_OAUTH_CLIENT_ID must be the eval client id (mcpc_ + 32 hex)');
  if (!clientSecret) problems.push('READINESS_EVAL_OAUTH_CLIENT_SECRET is not set (read it from Secret Manager into the environment)');
  return { clientId, clientSecret, problems };
}

/** The URL a person opens to sign the eval client in. */
function authorizeUrl({ clientId, state, challenge }) {
  const u = new URL(OAUTH.authorizationEndpoint);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: OAUTH.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: OAUTH.resource,
  }).toString();
  return u.toString();
}

async function tokenRequest(form, { clientId, clientSecret, fetchImpl = globalThis.fetch, now = Date.now }) {
  const res = await fetchImpl(OAUTH.tokenEndpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`,
    },
    body: new URLSearchParams({ ...form, resource: OAUTH.resource }).toString(),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || !body || typeof body.access_token !== 'string') {
    // Never echo a token; the server's error code is enough.
    const code = body && typeof body.error === 'string' ? body.error : `http_${res.status}`;
    throw new Error(`token endpoint refused: ${code}`);
  }
  const expiresIn = Number(body.expires_in);
  return {
    issuer: OAUTH.issuer,
    client_id: clientId,
    access_token: body.access_token,
    refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    scope: typeof body.scope === 'string' ? body.scope : null,
    expires_at: Math.floor(now() / 1000) + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600),
  };
}

function exchangeCode({ code, verifier, clientId, clientSecret, fetchImpl, now }) {
  return tokenRequest(
    { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier },
    { clientId, clientSecret, fetchImpl, now },
  );
}

function refreshToken({ refreshToken: token, clientId, clientSecret, fetchImpl, now }) {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: token }, { clientId, clientSecret, fetchImpl, now });
}

function enclosingGitRoot(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

function writeToken(file, token) {
  const dir = path.dirname(path.resolve(file));
  const root = enclosingGitRoot(dir);
  if (root) throw new Error(`refusing to write the eval token inside a git checkout (${root})`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(token)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Delete the stored token. Only a file that reads as an eval token is removed. @returns {boolean} */
function deleteToken(file) {
  if (!fs.existsSync(file)) return false;
  readToken(file);
  fs.unlinkSync(file);
  return true;
}

function readToken(file) {
  const token = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!token || token.issuer !== OAUTH.issuer || typeof token.access_token !== 'string') {
    throw new Error(`${file} is not an eval token for ${OAUTH.issuer}`);
  }
  return token;
}

/**
 * The stored token, refreshed (and stored again) when less than `minSeconds` of it is left.
 * @returns {Promise<{ token: object, refreshed: boolean }>}
 */
async function ensureFreshToken({ file = DEFAULT_TOKEN_FILE, env = process.env, fetchImpl, now = Date.now, minSeconds = MIN_FRESH_SECONDS } = {}) {
  let token;
  try {
    token = readToken(file);
  } catch (err) {
    throw new Error(`no usable eval token at ${file} (${err.message}); sign in first: node scripts/agent-readiness-eval/oauth-login.cjs`);
  }
  if (token.expires_at - Math.floor(now() / 1000) >= minSeconds) return { token, refreshed: false };
  const creds = clientCredentials(env);
  if (creds.problems.length) throw new Error(creds.problems.join('; '));
  if (creds.clientId !== token.client_id) throw new Error('the stored token belongs to another client');
  if (!token.refresh_token) throw new Error('the stored token has no refresh token; sign in again');
  const fresh = await refreshToken({ refreshToken: token.refresh_token, clientId: creds.clientId, clientSecret: creds.clientSecret, fetchImpl, now });
  // A refresh may rotate the refresh token; keep the old one only when none came back.
  const next = { ...fresh, refresh_token: fresh.refresh_token || token.refresh_token };
  writeToken(file, next);
  return { token: next, refreshed: true };
}

/**
 * One loopback callback: resolves with the code once a request names the expected state, then closes.
 * @returns {{ code: Promise<string>, close: () => void }}
 */
function awaitCallback({ state, timeoutMs = 300000, port = OAUTH.redirectPort, host = OAUTH.redirectHost } = {}) {
  let server;
  let timer;
  const code = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://${host}:${port}`);
      if (u.pathname !== OAUTH.redirectPath) {
        res.writeHead(404).end();
        return;
      }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' }).end(ok ? 'Signed in. You can close this tab.' : 'Sign-in failed.');
      if (!ok) {
        reject(new Error(`sign-in callback refused: ${u.searchParams.get('error') || 'state mismatch or no code'}`));
        return;
      }
      resolve(u.searchParams.get('code'));
    });
    server.on('error', reject);
    server.listen(port, host);
    timer = setTimeout(() => reject(new Error('sign-in timed out')), timeoutMs);
  });
  const close = () => {
    clearTimeout(timer);
    if (server) server.close();
  };
  code.then(close, close);
  return { code, close };
}

module.exports = {
  OAUTH,
  REDIRECT_URI,
  DEFAULT_TOKEN_FILE,
  MIN_FRESH_SECONDS,
  SHORT_JOB_MIN_SECONDS,
  pkcePair,
  clientCredentials,
  authorizeUrl,
  exchangeCode,
  refreshToken,
  writeToken,
  readToken,
  deleteToken,
  ensureFreshToken,
  awaitCallback,
};
