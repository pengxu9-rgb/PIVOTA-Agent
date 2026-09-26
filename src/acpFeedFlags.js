'use strict';

// ACP door flag semantics, extracted so the feed/checkout DECOUPLING is unit-
// testable without booting the server. The security-relevant invariant lives
// here: publishing the read-only feed must never mount a money-path endpoint.

function _truthy(value) {
  return ['1', 'true', 'on', 'yes'].includes(String(value || '').trim().toLowerCase());
}

// OpenAI ACP REST checkout doors (the 5 session endpoints). Fail-closed.
function isAcpRestEnabled(env = process.env) {
  return _truthy(env.AGENT_CHECKOUT_ACP_REST_ENABLED);
}

// The read-only product FEED door (GET /acp/feed) ONLY. Decoupled so the
// discovery surface can be published without the checkout endpoints. The
// full-checkout flag IMPLIES the feed (a checkout integrator gets discovery too).
function isAcpFeedEnabled(env = process.env) {
  return isAcpRestEnabled(env) || _truthy(env.AGENT_CHECKOUT_ACP_FEED_ENABLED);
}

// Serve GET /acp/feed WITHOUT an HMAC signature (catalog is public data; a
// frontier discovery surface must be crawlable without a shared secret). Only
// ever relaxes the feed — checkout endpoints stay signature-gated regardless.
function isAcpPublicFeedEnabled(env = process.env) {
  return _truthy(env.ACP_PUBLIC_FEED);
}

// Is a given ACP route mounted, for this env? Feed uses the feed flag; every
// other handler requires the full checkout flag. `strict` must also be on.
function isAcpRouteEnabled(handlerName, env = process.env, { strict } = {}) {
  const strictOn = strict === undefined ? _truthy(env.AGENT_CHECKOUT_STRICT) : Boolean(strict);
  if (!strictOn) return false;
  return handlerName === 'productFeed' ? isAcpFeedEnabled(env) : isAcpRestEnabled(env);
}

module.exports = {
  isAcpRestEnabled,
  isAcpFeedEnabled,
  isAcpPublicFeedEnabled,
  isAcpRouteEnabled,
};
