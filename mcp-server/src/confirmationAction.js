export class ConfirmationActionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ConfirmationActionError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Host-only confirmation action for MCP/App UI cards.
 *
 * This is intentionally not a generic model-callable tool. The caller must inject
 * `verifyUserAction`, which should validate the trusted UI action envelope
 * (signed component action, CSRF/session binding, nonce, etc.) before a token is
 * minted. The request body may carry only `order_id`; identity always comes from
 * the verified session context.
 */
export function createConfirmationActionHandler({
  commerce,
  authenticate,
  resolveSessionContext,
  verifyUserAction,
} = {}) {
  if (!commerce || typeof commerce.mintConfirmation !== "function") {
    throw new Error("createConfirmationActionHandler requires commerce.mintConfirmation()");
  }
  if (typeof authenticate !== "function") {
    throw new Error("createConfirmationActionHandler requires authenticate()");
  }
  if (typeof verifyUserAction !== "function") {
    throw new Error("createConfirmationActionHandler requires verifyUserAction()");
  }

  async function handle(req) {
    try {
      const authResult = await authenticate(req);
      const actionOk = await verifyUserAction(req, authResult);
      if (actionOk !== true) {
        throw new ConfirmationActionError(
          "CONFIRMATION_ACTION_REQUIRED",
          "A verified user confirmation action is required.",
          403,
        );
      }

      const ctx = typeof resolveSessionContext === "function"
        ? await resolveSessionContext(req, authResult)
        : defaultSessionContext(req, authResult);
      if (!nonEmpty(ctx?.user_ref) || !nonEmpty(ctx?.acp_session_id)) {
        throw new ConfirmationActionError(
          "USER_AUTH_REQUIRED",
          "A verified buyer session is required.",
          401,
        );
      }

      const body = parseBody(req);
      const orderId = nonEmpty(body.order_id) ? body.order_id.trim() : "";
      if (!orderId) {
        throw new ConfirmationActionError(
          "INVALID_ARGUMENTS",
          "order_id is required.",
          400,
        );
      }

      const confirmationToken = await commerce.mintConfirmation(
        { order_id: orderId },
        {
          user_ref: ctx.user_ref.trim(),
          acp_session_id: ctx.acp_session_id.trim(),
          ...(nonEmpty(ctx.agent_id) ? { agent_id: ctx.agent_id.trim() } : {}),
        },
      );

      return {
        status: 200,
        headers: jsonHeaders(),
        body: {
          confirmation_token: confirmationToken,
        },
      };
    } catch (error) {
      return errorResponse(error);
    }
  }

  return { handle };
}

export function mountConfirmationAction(app, handler, { path = "/checkout/confirm" } = {}) {
  if (!app || typeof app.post !== "function") {
    throw new Error("mountConfirmationAction requires an Express-style app");
  }
  if (!handler || typeof handler.handle !== "function") {
    throw new Error("mountConfirmationAction requires a handler");
  }
  app.post(path, async (req, res) => {
    const out = await handler.handle(normalizeHttpRequest(req));
    for (const [key, value] of Object.entries(out.headers ?? {})) {
      res.setHeader(key, value);
    }
    return res.status(out.status).json(out.body);
  });
}

export function normalizeHttpRequest(req) {
  return {
    headers: req?.headers ?? {},
    rawBody: req?.rawBody,
    body: req?.body,
    authInfo: req?.authInfo,
    sessionContext: req?.sessionContext,
  };
}

function defaultSessionContext(req, authResult) {
  const verified = authResult?.sessionContext ?? req?.sessionContext ?? req?.authInfo ?? {};
  const out = {};
  if (nonEmpty(verified.user_ref)) out.user_ref = verified.user_ref.trim();
  if (nonEmpty(verified.acp_session_id)) out.acp_session_id = verified.acp_session_id.trim();
  if (nonEmpty(verified.agent_id)) out.agent_id = verified.agent_id.trim();
  return out;
}

function parseBody(req) {
  if (isPlainObject(req?.body)) return req.body;
  const raw = rawBodyString(req?.rawBody);
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function rawBodyString(rawBody) {
  if (typeof rawBody === "string") return rawBody;
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody).toString("utf8");
  return undefined;
}

function errorResponse(error) {
  if (error instanceof ConfirmationActionError) {
    return {
      status: error.status,
      headers: jsonHeaders(),
      body: {
        error: {
          code: error.code,
          message: error.message,
        },
      },
    };
  }

  return {
    status: 500,
    headers: jsonHeaders(),
    body: {
      error: {
        code: "CONFIRMATION_ACTION_FAILED",
        message: "Unable to mint confirmation for this action.",
      },
    },
  };
}

function jsonHeaders() {
  return { "content-type": "application/json" };
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
