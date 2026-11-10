// THE `/mcp` DOOR NAMES EVERY EMPTY get_offers ANSWER (GET_OFFERS_EMPTY_REASON, default off).
//
// A view of the commerce tool surface for the `/mcp` adapter only. Off, it IS the surface: the same object,
// so tools/list and every tools/call answer exactly as before. On, two things change, both for get_offers:
//   - the call runs inside the reason door (src/agentSignals/getOffersEmptyReason.js), so an answer with no
//     offer carries `metadata.reason` (one fixed token) and `metadata.reason_retriable`;
//   - the tool's description says what each reason means and when asking again can help.
// Nothing else is read or rewritten here. The UCP door, the public door and the strict invoke route do not
// go through this view and never open the reason door.
//
// `metadata.reason` is the same field the partner-door view (PARTNER_DOOR_ONE_PRODUCT_ID) fills with
// `no_offer_for_product` when an empty answer has none. That view only fills an EMPTY reason, and this
// vocabulary contains its token, so the two compose in either order.

import emptyReason from "../../src/agentSignals/getOffersEmptyReason.js";

function envValue(name) {
  return (typeof process !== "undefined" && process.env && process.env[name]) || "";
}

// Read once at load, as the surface's own flags are.
export const GET_OFFERS_EMPTY_REASON = /^(1|true|yes|on|enabled)$/i.test(envValue("GET_OFFERS_EMPTY_REASON").trim());

const R = emptyReason.EMPTY_REASONS;

export const GET_OFFERS_EMPTY_REASON_SENTENCES =
  " When no offer is returned, `metadata.reason` says why and `metadata.reason_retriable` says whether the same call may answer differently within minutes." +
  ` \`${R.NEEDS_LIVE_VERIFICATION}\`: we hold an offer for this product, but its stored price and stock are too old to quote and could not be confirmed with the store. Retry only when \`reason_retriable\` is true (the store timed out or answered badly, or our own check failed); when it is false, asking again within minutes will not change this. Either way, do not build a link from the product page.` +
  ` \`${R.NO_SEED}\`: we found no servable seller offer on file for this product in this market. \`${R.NOT_IN_MARKET}\`: an offer exists but not for this buyer market or its currency. \`${R.OUT_OF_STOCK}\`: the store's own answer no longer lists the item. \`${R.NOT_SERVABLE}\`: an offer exists but is withheld (for example its page is gone, or the seller cannot sell it now). \`${R.NO_OFFER}\`: no offer, cause not classified. None of these is worth retrying.` +
  ` \`${R.LOOKUP_UNAVAILABLE}\`: our own lookup failed; retry.` +
  // The reasons get_offers gave before this flag (makeGetOffers' own); they keep their tokens.
  " `variant_not_offered`: offers exist, none for the variant you named. `no_offer_in_market_currency`: offers exist, none priced in the buyer market's currency. `market_not_priced`: we price nothing in the declared market. `offers_source_unavailable`: this door has no offer source. None of these is worth retrying." +
  " A product can have a price on get_product and no offer here: show it as last seen and say no buy link is available now.";

// Every token an empty get_offers answer can carry on this door: this flag's vocabulary and the older reasons.
export const GET_OFFERS_REASON_TOKENS = Object.freeze([
  ...Object.values(R),
  "variant_not_offered",
  "no_offer_in_market_currency",
  "market_not_priced",
  "offers_source_unavailable",
]);

function describe(tool) {
  if (!tool || tool.name !== "get_offers" || typeof tool.description !== "string") return tool;
  return { ...tool, description: `${tool.description}${GET_OFFERS_EMPTY_REASON_SENTENCES}` };
}

/** The surface the `/mcp` adapter serves. `enabled` is injectable for tests; the default is the load-time flag. */
export function getOffersEmptyReasonSurface(surface, { enabled = GET_OFFERS_EMPTY_REASON } = {}) {
  if (!enabled) return surface;
  return {
    get tools() {
      return surface.tools.map(describe);
    },
    isCommerceTool: surface.isCommerceTool,
    callTool(toolName, toolArgs, ...rest) {
      if (toolName !== "get_offers") return surface.callTool(toolName, toolArgs, ...rest);
      return emptyReason.runOnEmptyReasonDoor(() => surface.callTool(toolName, toolArgs, ...rest));
    },
  };
}
