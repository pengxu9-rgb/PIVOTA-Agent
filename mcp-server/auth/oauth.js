import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export class OAuthError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = "OAuthError";
    if (status !== undefined) {
      this.status = status;
    }
  }
}

export function createPkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier, "utf8")
    .digest("base64url");

  return { verifier, challenge };
}

export function buildAuthorizeUrl({
  authorizeEndpoint,
  clientId,
  redirectUri,
  scope,
  state,
  nonce,
  codeChallenge,
  allowedRedirectOrigins,
  allowInsecure = false
}) {
  assertNonEmptyString(authorizeEndpoint, "authorizeEndpoint");
  assertNonEmptyString(clientId, "clientId");
  assertNonEmptyString(redirectUri, "redirectUri");
  assertNonEmptyString(state, "state");
  assertNonEmptyString(nonce, "nonce");
  assertNonEmptyString(codeChallenge, "codeChallenge");

  const url = parseUrl(authorizeEndpoint, "authorizeEndpoint");
  const redirectUrl = parseUrl(redirectUri, "redirectUri");
  assertSecureUrl(url, "authorizeEndpoint", allowInsecure);
  assertSecureUrl(redirectUrl, "redirectUri", allowInsecure);
  assertAllowedRedirectOrigin(
    redirectUrl,
    allowedRedirectOrigins,
    allowInsecure
  );

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);

  const normalizedScope = normalizeScope(scope);
  if (normalizedScope) {
    url.searchParams.set("scope", normalizedScope);
  }

  return url.toString();
}

export async function exchangeCodeForTokens({
  tokenEndpoint,
  clientId,
  redirectUri,
  code,
  codeVerifier,
  fetchImpl = globalThis.fetch
}) {
  assertNonEmptyString(tokenEndpoint, "tokenEndpoint");
  assertNonEmptyString(clientId, "clientId");
  assertNonEmptyString(redirectUri, "redirectUri");
  assertNonEmptyString(code, "code");
  assertNonEmptyString(codeVerifier, "codeVerifier");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: codeVerifier
  });

  return postTokenRequest({
    tokenEndpoint,
    body,
    fetchImpl
  });
}

export function assertStateMatches(expectedState, receivedState) {
  assertNonEmptyString(expectedState, "expectedState");
  assertNonEmptyString(receivedState, "receivedState");

  const expected = Buffer.from(expectedState, "utf8");
  const received = Buffer.from(receivedState, "utf8");
  const matches =
    expected.length === received.length && timingSafeEqual(expected, received);

  if (!matches) {
    throw new OAuthError("OAuth state mismatch.");
  }

  return true;
}

export async function refreshTokens({
  tokenEndpoint,
  clientId,
  refreshToken,
  fetchImpl = globalThis.fetch
}) {
  assertNonEmptyString(tokenEndpoint, "tokenEndpoint");
  assertNonEmptyString(clientId, "clientId");
  assertNonEmptyString(refreshToken, "refreshToken");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken
  });

  return postTokenRequest({
    tokenEndpoint,
    body,
    fetchImpl
  });
}

async function postTokenRequest({ tokenEndpoint, body, fetchImpl }) {
  if (typeof fetchImpl !== "function") {
    throw new OAuthError(
      "No fetch implementation is available. Node 18+ is required."
    );
  }

  let response;
  try {
    response = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });
  } catch (error) {
    throw new OAuthError("OAuth token request failed.", { cause: error });
  }

  const responseBody = await readJsonBody(response);
  const ok =
    response?.ok ??
    (typeof response?.status === "number" &&
      response.status >= 200 &&
      response.status < 300);

  if (!ok) {
    throw new OAuthError(
      `OAuth token endpoint failed with HTTP ${response?.status ?? "unknown"}.`,
      { status: response?.status }
    );
  }

  return responseBody;
}

async function readJsonBody(response) {
  if (typeof response?.text === "function") {
    const text = await response.text();
    if (!text) {
      return {};
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new OAuthError("OAuth token endpoint returned invalid JSON.", {
        cause: error
      });
    }
  }

  if (typeof response?.json === "function") {
    try {
      return (await response.json()) ?? {};
    } catch (error) {
      throw new OAuthError("OAuth token endpoint returned invalid JSON.", {
        cause: error
      });
    }
  }

  return {};
}

function normalizeScope(scope) {
  if (scope === undefined || scope === null) {
    return "";
  }

  if (Array.isArray(scope)) {
    return scope.map((item) => {
      assertNonEmptyString(item, "scope");
      return item;
    }).join(" ");
  }

  assertNonEmptyString(scope, "scope");
  return scope;
}

function parseUrl(value, fieldName) {
  try {
    return new URL(value);
  } catch (error) {
    throw new OAuthError(`${fieldName} must be a valid URL.`, {
      cause: error
    });
  }
}

function assertSecureUrl(url, fieldName, allowInsecure) {
  if (url.protocol === "https:") {
    return;
  }

  if (
    allowInsecure === true &&
    url.protocol === "http:" &&
    isLocalhost(url.hostname)
  ) {
    return;
  }

  throw new OAuthError(
    `${fieldName} must use https:. Localhost http is allowed only with allowInsecure for development.`
  );
}

function assertAllowedRedirectOrigin(
  redirectUrl,
  allowedRedirectOrigins,
  allowInsecure
) {
  if (
    !Array.isArray(allowedRedirectOrigins) ||
    allowedRedirectOrigins.length === 0
  ) {
    throw new OAuthError("allowedRedirectOrigins must be a non-empty array.");
  }

  const allowedOrigins = new Set(
    allowedRedirectOrigins.map((origin, index) =>
      normalizeAllowedOrigin(origin, index, allowInsecure)
    )
  );

  if (!allowedOrigins.has(redirectUrl.origin)) {
    throw new OAuthError("redirectUri origin is not allowed.");
  }
}

function normalizeAllowedOrigin(origin, index, allowInsecure) {
  assertNonEmptyString(origin, `allowedRedirectOrigins[${index}]`);
  const url = parseUrl(origin, `allowedRedirectOrigins[${index}]`);
  assertSecureUrl(url, `allowedRedirectOrigins[${index}]`, allowInsecure);
  return url.origin;
}

function isLocalhost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OAuthError(`${fieldName} is required.`);
  }
}
