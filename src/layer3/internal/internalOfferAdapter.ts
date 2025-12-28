import type { Market } from "../../markets/market";
import type { InternalOfferV0 } from "../schemas/offerObjectV0";

export async function getInternalOffersForRole(_args: {
  market: Market;
  roleId: string;
  locale?: string;
}): Promise<InternalOfferV0[]> {
  return [];
}

