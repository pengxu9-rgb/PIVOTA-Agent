'use strict';

// Phase 1 deterministic router rule for the `find_products` chat intent.
//
// The prod intent classifier is an LLM (buildIntentClassifierStructuredPrompt);
// teaching it a new `find_products` intent that cleanly separates from
// `recommend_products` needs prompt work + an eval set (Phase 2). Until then, this
// HIGH-PRECISION rule routes only UNAMBIGUOUS product-search phrasings
// ("show me acropass products", "shop cerave", "buy X") straight to the grounded
// find_products_multi lane. Anything fuzzy returns null and falls through to the
// existing LLM classifier unchanged — we prefer a false negative (goes to reco, as
// today) over a false positive (steals a recommendation query).

// Explicit shopping verbs that open a product-search phrasing.
const SHOP_VERB_RE = /\b(shop|browse|buy|purchase)\b/i;
// "show/find me <X> products" and "products from/by <X>" templates.
const SHOW_PRODUCTS_RE = /\b(show|find|give)\s+(?:me\s+)?(.+?)\s+products?\b/i;
const PRODUCTS_FROM_RE = /\bproducts?\s+(?:from|by)\s+(.+)/i;
const WHERE_BUY_RE = /\bwhere\s+can\s+i\s+(?:buy|get|find|purchase)\s+(.+)/i;
const DIRECT_SHOW_RE = /^(?:show|find|give)\s+(?:me\s+)?(.+)$/i;

// Recommendation / evaluation signals — if present, this is NOT a plain product
// search; let the LLM classifier handle it (reco / evaluate / routine).
const RECO_SIGNAL_RE = /\b(recommend|routine|good\s+for|best\s+for|suitable|suited|for\s+(?:my|dry|oily|combination|sensitive|acne|aging|mature)\b|which\s+should|should\s+i\s+use|is\s+.+\s+good|compare|dupe|alternative|vs\.?\b|versus)\b/i;

// The chat box is also a search box. A short noun phrase such as "ordinary",
// "knight unicorn" or "only blush" has no explicit shopping verb, but sending
// it to general chat makes an existing catalog item unreachable. Keep this
// fallback deliberately syntactic and small: greetings, questions, skin
// concerns and sentence-like input still go to the classifier.
const BARE_CHAT_RE = /^(?:hi|hello|hey|thanks|thank\s+you|ok(?:ay)?|yes|no|help|good\s+(?:morning|afternoon|evening|night)|who\s+are\s+you|how\s+are\s+you)$/i;
const BARE_QUESTION_START_RE = /^(?:what|why|how|when|where|who|can|could|would|should|do|does|did|is|are|am|tell|explain)\b/i;
const BARE_CONCERN_ONLY_RE = /^(?:dry|oily|combination|sensitive|dehydrated|acne[- ]prone|aging|mature)\s+skin$|^(?:acne|redness|wrinkles?|pores?|pigmentation)$/i;

function detectBareCatalogPhrase(message) {
  const value = clean(message);
  if (!value || BARE_CHAT_RE.test(value) || BARE_QUESTION_START_RE.test(value) || BARE_CONCERN_ONLY_RE.test(value)) {
    return null;
  }
  if (/[?!。？！]/.test(value)) return null;
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length < 1 || tokens.length > 6) return null;
  if (!tokens.every((token) => /^[\p{L}\p{N}&+%'’.$€£¥-]+$/u.test(token))) return null;
  return { query: value, match_type: 'bare' };
}

function clean(s) {
  return String(s || '')
    .replace(/[?!.]+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Return { query } if the message is an unambiguous product-search phrasing,
 * else null. `query` is a keyword string suitable for find_products_multi
 * (the backend does brand detection + text match, so a light phrase is fine).
 */
function detectExplicitProductSearch(userMessage) {
  const msg = clean(userMessage);
  if (!msg) return null;
  const lower = msg.toLowerCase();

  // Guard: reco/evaluate/compare phrasings are not plain searches.
  if (RECO_SIGNAL_RE.test(lower)) return null;

  // "show me <X> products" / "find me <X> products"
  let m = msg.match(SHOW_PRODUCTS_RE);
  if (m && clean(m[2])) return { query: clean(m[2]), match_type: 'explicit' };

  // "products from <X>" / "products by <X>"
  m = msg.match(PRODUCTS_FROM_RE);
  if (m && clean(m[1])) return { query: clean(m[1]), match_type: 'explicit' };

  // "where can i buy <X>"
  m = msg.match(WHERE_BUY_RE);
  if (m && clean(m[1])) return { query: clean(m[1]), match_type: 'explicit' };

  // "show me niacinamide under $10" is just as explicit as the older
  // "show me X products" template. The recommendation guard above keeps
  // profile-aware requests out of this lane.
  m = msg.match(DIRECT_SHOW_RE);
  if (m && detectBareCatalogPhrase(m[1])) return { query: clean(m[1]), match_type: 'explicit' };

  // "shop <X>" / "browse <X>" / "buy <X>" — strip the leading verb (+ "for").
  if (SHOP_VERB_RE.test(lower)) {
    const stripped = clean(
      msg.replace(/^\s*(shop|browse|buy|purchase)\s+(?:for\s+|me\s+|some\s+)?/i, ''),
    );
    // Require a CONCRETE brand/product token. An indefinite article or generic
    // filler ("buy a moisturizer for winter", "buy something") reads as
    // open-ended category shopping — better served by profile-aware reco, so let
    // it fall through. "the" is intentionally NOT guarded ("shop the ordinary" is
    // a real brand). Keep it short (brand/keyword, not a sentence).
    const generic = /^(a|an|some|any|something|anything|stuff|things?)\b/i.test(stripped);
    if (stripped && !generic && stripped.split(/\s+/).length <= 6) {
      return { query: stripped, match_type: 'explicit' };
    }
    return null;
  }

  return detectBareCatalogPhrase(msg);
}

/**
 * Decide catalog ownership from the current typed turn only.
 *
 * Public chat has two entry points (the v1 compatibility mainline and the v2
 * router). Keeping request-shape extraction here prevents those entry points
 * from drifting on messages that also resemble ingredient/reco requests.
 * Historical `messages` and action reply text are intentionally excluded: they
 * describe earlier/generated turns and must not steal a new explicit action.
 */
function getCatalogSearchOwnership(body) {
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const currentTypedMessage = [
    payload.message,
    payload.user_message,
    payload.query,
    payload.text,
  ].find((value) => typeof value === 'string' && value.trim());
  return currentTypedMessage ? detectExplicitProductSearch(currentTypedMessage) : null;
}

function isCatalogSearchOwnedChatRequest(body) {
  return Boolean(getCatalogSearchOwnership(body));
}

module.exports = {
  detectExplicitProductSearch,
  getCatalogSearchOwnership,
  isCatalogSearchOwnedChatRequest,
};
