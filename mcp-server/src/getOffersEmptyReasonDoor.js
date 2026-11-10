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
  ` \`${R.NEEDS_LIVE_VERIFICATION}\`: we hold an offer for this product, but its stored price and stock are too old to quote and the store could not confirm them just now. Retry only when \`reason_retriable\` is true (the store timed out or answered badly); when it is false the store cannot be asked for this item, so do not retry and do not build a link from the product page.` +
  ` \`${R.NO_SEED}\`: no seller offer is on file for this product id. \`${R.NOT_IN_MARKET}\`: an offer exists but not for this buyer market. \`${R.OUT_OF_STOCK}\`: the store's own answer no longer lists the item. \`${R.NOT_SERVABLE}\`: an offer exists but is withheld (for example its page is gone). \`${R.NO_OFFER}\`: no offer, cause not classified. None of these is worth retrying.` +
  ` \`${R.LOOKUP_UNAVAILABLE}\`: our own lookup failed; retry.` +
  " A product can have a price on get_product and no offer here: show it as last seen and say no buy link is available now.";

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
