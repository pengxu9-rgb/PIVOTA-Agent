const fs = require("node:fs");
const path = require("node:path");

const { resolveExternalOffer } = require("../external/externalOfferResolver");

function loadExternalLinksIndexFromDisk(market) {
  const legacyFilename = market === "JP" ? "externalLinks_jp.json" : "externalLinks_us.json";

  const tryReadJson = (filePath) => {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  };

  const coerceIndexFromPool = (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

    // New pool format: { byRole: { [ROLE:...]: [{ url, ... }] } }
    if (raw.byRole && typeof raw.byRole === "object" && !Array.isArray(raw.byRole)) {
      const out = {};
      for (const roleId of Object.keys(raw.byRole).sort()) {
        const entries = raw.byRole[roleId];
        if (!Array.isArray(entries)) continue;
        const urls = entries
          .map((e) => (e && typeof e === "object" ? e.url : null))
          .filter((u) => typeof u === "string" && u.length > 0);
        if (urls.length) out[roleId] = urls;
      }
      return out;
    }

    // Legacy format: { [ROLE:...]: string[] }
    const out = {};
    for (const key of Object.keys(raw)) {
      const v = raw[key];
      if (!Array.isArray(v)) continue;
      const urls = v.filter((u) => typeof u === "string");
      if (urls.length) out[key] = urls;
    }
    return Object.keys(out).length ? out : null;
  };

  const poolFilename = `externalLinks_${market}.json`;
  const poolPath = path.join(__dirname, "..", "data", poolFilename);
  const poolIndex = coerceIndexFromPool(tryReadJson(poolPath));
  if (poolIndex) return poolIndex;

  const legacyPath = path.join(__dirname, "..", "data", legacyFilename);
  return coerceIndexFromPool(tryReadJson(legacyPath)) ?? {};
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
