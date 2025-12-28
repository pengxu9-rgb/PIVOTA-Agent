import fs from "node:fs";
import path from "node:path";

import type { Market } from "../../markets/market";
import type { ExternalOfferV0 } from "../schemas/offerObjectV0";
import { resolveExternalOffer } from "../external/externalOfferResolver";

export type ExternalLinksIndex = Record<string, string[]>;

export type FeedItemV0 = {
  roleId: string;
  offers: ExternalOfferV0[];
  compareEnabled: boolean;
};

export type FeedV0 = {
  market: Market;
  locale?: string;
  feedItems: FeedItemV0[];
  errors: Array<{ roleId: string; url: string; code: string }>;
};

function loadExternalLinksIndexFromDisk(market: Market): ExternalLinksIndex {
  const legacyFilename =
    market === "JP" ? "externalLinks_jp.json" : "externalLinks_us.json";

  const tryReadJson = (filePath: string): unknown => {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  };

  const coerceIndexFromPool = (raw: unknown): ExternalLinksIndex | null => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

    const maybePool = raw as Record<string, unknown>;
    const byRole = maybePool.byRole;
    if (byRole && typeof byRole === "object" && !Array.isArray(byRole)) {
      const out: ExternalLinksIndex = {};
      for (const roleId of Object.keys(byRole).sort()) {
        const entries = (byRole as Record<string, unknown>)[roleId];
        if (!Array.isArray(entries)) continue;
        const urls = entries
          .map((e) => (e && typeof e === "object" ? (e as any).url : null))
          .filter((u): u is string => typeof u === "string" && u.length > 0);
        if (urls.length) out[roleId] = urls;
      }
      return out;
    }

    const out: ExternalLinksIndex = {};
    for (const key of Object.keys(maybePool)) {
      const v = maybePool[key];
      if (!Array.isArray(v)) continue;
      const urls = v.filter((u): u is string => typeof u === "string");
      if (urls.length) out[key] = urls;
    }
    return Object.keys(out).length ? out : null;
  };

  const poolFilename = `externalLinks_${market}.json`;
  const poolPath = path.join(__dirname, "..", "data", poolFilename);
  const poolParsed = tryReadJson(poolPath);
  const poolIndex = coerceIndexFromPool(poolParsed);
  if (poolIndex) return poolIndex;

  const legacyPath = path.join(__dirname, "..", "data", legacyFilename);
  const legacyParsed = tryReadJson(legacyPath);
  return coerceIndexFromPool(legacyParsed) ?? {};
}

async function mapWithConcurrency<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  mapper: (item: TIn) => Promise<TOut>,
): Promise<TOut[]> {
  const results: TOut[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

export async function composeExternalFirstFeed(params: {
  market: Market;
  locale?: string;
  roleIds: string[];
  maxOffersPerRole?: number;
  linkIndexOverride?: ExternalLinksIndex;
  resolveOffer?: (args: {
    url: string;
    market: Market;
    locale?: string;
  }) => Promise<ExternalOfferV0>;
}): Promise<FeedV0> {
  const {
    market,
    locale,
    roleIds,
    maxOffersPerRole = 2,
    linkIndexOverride,
    resolveOffer = ({ url, market: mkt, locale: loc }) =>
      resolveExternalOffer({ url, market: mkt, locale: loc }),
  } = params;

  const linkIndex = linkIndexOverride ?? loadExternalLinksIndexFromDisk(market);
  const errors: Array<{ roleId: string; url: string; code: string }> = [];

  const uniqueRoleIds = Array.from(new Set(roleIds)).sort();
  const items = await mapWithConcurrency(
    uniqueRoleIds,
    3,
    async (roleId): Promise<FeedItemV0> => {
      const urls = Array.isArray(linkIndex[roleId]) ? linkIndex[roleId] : [];
      const selectedUrls = urls.slice(0, Math.max(0, maxOffersPerRole));

      const offers: ExternalOfferV0[] = [];
      for (const url of selectedUrls) {
        try {
          offers.push(await resolveOffer({ url, market, locale }));
        } catch (error: any) {
          errors.push({
            roleId,
            url,
            code: error?.code || "RESOLVE_FAILED",
          });
        }
      }

      return { roleId, offers, compareEnabled: true };
    },
  );

  return { market, locale, feedItems: items, errors };
}
