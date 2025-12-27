import { z } from "zod";

export const MarketSchema = z.enum(["US", "JP"]);
export type Market = z.infer<typeof MarketSchema>;

export function normalizeMarket(input: unknown, fallback: Market = "US"): Market {
  const s = String(input ?? "").trim().toUpperCase();
  if (s === "US" || s === "JP") return s;
  return fallback;
}

export function parseMarketFromRequest(input: unknown, defaultMarket: Market = "US"): Market {
  const raw = String(input ?? "").trim();
  if (!raw) return defaultMarket;
  const s = raw.toUpperCase();
  if (s === "US" || s === "JP") return s as Market;
  const err = new Error(`Market not supported: ${raw}`);
  // @ts-expect-error - attach code for HTTP handler mapping
  err.code = "MARKET_NOT_SUPPORTED";
  // @ts-expect-error - attach status for HTTP handler mapping
  err.httpStatus = 400;
  throw err;
}

export function isMarketEnabled(market: Market): boolean {
  if (market === "US") return true;
  const enabled = String(process.env.ENABLE_MARKET_JP || "").trim();
  return enabled === "1" || enabled.toLowerCase() === "true";
}

export function requireMarketEnabled(market: Market): void {
  if (isMarketEnabled(market)) return;
  const err = new Error(`Market ${market} is disabled`);
  // @ts-expect-error - attach code for HTTP handler mapping
  err.code = "MARKET_DISABLED";
  // @ts-expect-error - attach status for HTTP handler mapping
  err.httpStatus = 403;
  throw err;
}
