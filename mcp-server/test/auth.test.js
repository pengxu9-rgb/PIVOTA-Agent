import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertStateMatches,
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCodeForTokens,
  OAuthError
} from "../auth/oauth.js";
import { createSessionStore } from "../auth/sessionStore.js";
import {
  attachUserRef,
  deriveUserRef
} from "../auth/userRef.js";

function authorizeUrlInput(overrides = {}) {
  return {
    authorizeEndpoint: "https://idp.example.test/oauth/authorize",
    clientId: "client_123",
    redirectUri: "https://mcp.example.test/oauth/callback",
    scope: ["openid", "profile"],
    state: "oauth_state_value",
    nonce: "oidc_nonce_value",
    codeChallenge: "pkce_challenge_value",
    allowedRedirectOrigins: ["https://mcp.example.test"],
    ...overrides
  };
}

test("createPkcePair returns an S256 PKCE challenge for the verifier", () => {
  const { verifier, challenge } = createPkcePair();

  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43,128}$/);

  const expectedChallenge = createHash("sha256")
    .update(verifier, "utf8")
    .digest("base64url");

  assert.equal(challenge, expectedChallenge);
});

test("buildAuthorizeUrl includes required state, nonce, and PKCE parameters", () => {
  const url = new URL(buildAuthorizeUrl(authorizeUrlInput()));

  assert.equal(url.origin, "https://idp.example.test");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client_123");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://mcp.example.test/oauth/callback"
  );
  assert.equal(url.searchParams.get("state"), "oauth_state_value");
  assert.equal(url.searchParams.get("nonce"), "oidc_nonce_value");
  assert.equal(url.searchParams.get("code_challenge"), "pkce_challenge_value");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "openid profile");
});

test("buildAuthorizeUrl requires state and nonce", () => {
  assert.throws(
    () => buildAuthorizeUrl(authorizeUrlInput({ state: undefined })),
    (error) => error instanceof OAuthError && error.message === "state is required."
  );

  assert.throws(
    () => buildAuthorizeUrl(authorizeUrlInput({ nonce: " " })),
    (error) => error instanceof OAuthError && error.message === "nonce is required."
  );
});

test("buildAuthorizeUrl rejects non-HTTPS authorization endpoints and redirect URIs", () => {
  assert.throws(
    () =>
      buildAuthorizeUrl(
        authorizeUrlInput({
          authorizeEndpoint: "http://idp.example.test/oauth/authorize"
        })
      ),
    (error) =>
      error instanceof OAuthError &&
      /authorizeEndpoint must use https/.test(error.message)
  );

  assert.throws(
    () =>
      buildAuthorizeUrl(
        authorizeUrlInput({
          redirectUri: "http://mcp.example.test/oauth/callback",
          allowedRedirectOrigins: ["http://mcp.example.test"]
        })
      ),
    (error) =>
      error instanceof OAuthError && /redirectUri must use https/.test(error.message)
  );
});

test("buildAuthorizeUrl allows localhost http only with allowInsecure", () => {
  assert.throws(
    () =>
      buildAuthorizeUrl(
        authorizeUrlInput({
          authorizeEndpoint: "http://localhost:8787/oauth/authorize",
          redirectUri: "http://localhost:8787/oauth/callback",
          allowedRedirectOrigins: ["http://localhost:8787"]
        })
      ),
    (error) =>
      error instanceof OAuthError &&
      /authorizeEndpoint must use https/.test(error.message)
  );

  const url = new URL(
    buildAuthorizeUrl(
      authorizeUrlInput({
        authorizeEndpoint: "http://localhost:8787/oauth/authorize",
        redirectUri: "http://localhost:8787/oauth/callback",
        allowedRedirectOrigins: ["http://localhost:8787"],
        allowInsecure: true
      })
    )
  );

  assert.equal(url.protocol, "http:");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "http://localhost:8787/oauth/callback"
  );
});

test("buildAuthorizeUrl rejects redirect origins outside the allow-list", () => {
  assert.throws(
    () =>
      buildAuthorizeUrl(
        authorizeUrlInput({
          redirectUri: "https://evil.example.test/oauth/callback"
        })
      ),
    (error) =>
      error instanceof OAuthError &&
      error.message === "redirectUri origin is not allowed."
  );
});

test("assertStateMatches throws on mismatch and passes on match", () => {
  assert.equal(assertStateMatches("expected_state", "expected_state"), true);
  assert.throws(
    () => assertStateMatches("expected_state", "received_state"),
    (error) =>
      error instanceof OAuthError && error.message === "OAuth state mismatch."
  );
});

test("deriveUserRef is stable and rejects missing issuer or subject", () => {
  const claims = {
    iss: "https://idp.example.test",
    sub: "platform-user-123"
  };

  const first = deriveUserRef(claims);
  const second = deriveUserRef({ ...claims });

  assert.equal(first, second);
  assert.match(first, /^usr_[A-Za-z0-9_-]+$/);
  assert.notEqual(
    first,
    deriveUserRef({ iss: claims.iss, sub: "platform-user-456" })
  );

  assert.throws(() => deriveUserRef({ sub: claims.sub }), {
    code: "CLAIMS_MISSING_SUBJECT"
  });
  assert.throws(() => deriveUserRef({ iss: claims.iss }), {
    code: "CLAIMS_MISSING_SUBJECT"
  });
});

test("attachUserRef returns a new canonical envelope without mutating input", () => {
  const envelope = {
    operation: "create_order",
    payload: {
      user_ref: "usr_untrusted_model_value",
      acp_state: {
        opaque: true
      },
      order: {
        quote_id: "quote_123"
      }
    },
    idempotencyKey: "outside-canonical-envelope"
  };

  const attached = attachUserRef(envelope, "usr_trusted_oauth_value");

  assert.deepEqual(attached, {
    operation: "create_order",
    payload: {
      acp_state: {
        opaque: true
      },
      order: {
        quote_id: "quote_123"
      },
      user_ref: "usr_trusted_oauth_value"
    }
  });

  assert.equal(envelope.payload.user_ref, "usr_untrusted_model_value");
  assert.notEqual(attached, envelope);
  assert.notEqual(attached.payload, envelope.payload);
});

test("attachUserRef rejects write operations without a trusted user_ref", () => {
  assert.throws(
    () =>
      attachUserRef(
        {
          operation: "submit_payment",
          payload: {
            payment: {
              order_id: "order_123"
            }
          }
        },
        " "
      ),
    {
      code: "USER_REF_REQUIRED"
    }
  );
});

test("sessionStore.get evicts expired sessions and returns undefined", () => {
  const store = createSessionStore();
  store.put("session_123", {
    user_ref: "usr_123",
    accessToken: "access_token_value",
    refreshToken: "refresh_token_value",
    expiresAt: Date.now() - 1000
  });

  assert.equal(store.get("session_123"), undefined);
  assert.equal(store.delete("session_123"), false);
});

test("exchangeCodeForTokens posts authorization-code exchange with injected fetch", async () => {
  const calls = [];
  const responseBody = {
    access_token: "access_token_value",
    refresh_token: "refresh_token_value",
    token_type: "Bearer",
    expires_in: 3600
  };

  const tokens = await exchangeCodeForTokens({
    tokenEndpoint: "https://idp.example.test/oauth/token",
    clientId: "client_123",
    redirectUri: "https://mcp.example.test/oauth/callback",
    code: "authorization_code_value",
    codeVerifier: "pkce_verifier_value",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(responseBody)
      };
    }
  });

  assert.deepEqual(tokens, responseBody);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://idp.example.test/oauth/token");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(
    calls[0].options.headers["Content-Type"],
    "application/x-www-form-urlencoded"
  );

  const posted = new URLSearchParams(calls[0].options.body);
  assert.equal(posted.get("grant_type"), "authorization_code");
  assert.equal(posted.get("client_id"), "client_123");
  assert.equal(posted.get("redirect_uri"), "https://mcp.example.test/oauth/callback");
  assert.equal(posted.get("code"), "authorization_code_value");
  assert.equal(posted.get("code_verifier"), "pkce_verifier_value");
});
