const fs = require("node:fs");
const path = require("node:path");

const { resolveExternalOffer } = require("../external/externalOfferResolver");

function loadExternalLinksIndexFromDisk(market) {
  const filename = market === "JP" ? "externalLinks_jp.json" : "externalLinks_us.json";
  const filePath = path.join(__dirname, "..", "data", filename);
  if (!fs.existsSync(filePath)) return {};
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object") return {};
  return parsed;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

async function composeExternalFirstFeed(params) {
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
  const errors = [];

  const uniqueRoleIds = Array.from(new Set(roleIds)).sort();
  const items = await mapWithConcurrency(uniqueRoleIds, 3, async (roleId) => {
    const urls = Array.isArray(linkIndex[roleId]) ? linkIndex[roleId] : [];
    const selectedUrls = urls.slice(0, Math.max(0, maxOffersPerRole));

    const offers = [];
    for (const url of selectedUrls) {
      try {
        offers.push(await resolveOffer({ url, market, locale }));
      } catch (error) {
        errors.push({
          roleId,
          url,
          code: (error && error.code) || "RESOLVE_FAILED",
        });
      }
    }

    return { roleId, offers, compareEnabled: true };
  });

  return { market, locale, feedItems: items, errors };
}

module.exports = {
  composeExternalFirstFeed,
};

