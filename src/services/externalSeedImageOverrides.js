function normalizeUrlKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return `${parsed.hostname.toLowerCase()}${pathname}`;
  } catch {
    const normalized = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    return normalized;
  }
}

function uniqueUrls(values) {
  const out = [];
  for (const value of values || []) {
    const next = String(value || '').trim();
    if (!/^https?:\/\//i.test(next)) continue;
    if (out.includes(next)) continue;
    out.push(next);
  }
  return out;
}

function createOverride(imageUrls, meta = {}) {
  const normalizedImageUrls = uniqueUrls(imageUrls);
  return Object.freeze({
    image_url: normalizedImageUrls[0] || '',
    image_urls: normalizedImageUrls,
    source: 'manual_seed_override',
    note: String(meta.note || '').trim() || 'Manual image override for storefront PDP with missing media',
  });
}

const OVERRIDES = new Map(
  [
    [
      'https://patyka.com/products/echantillons-trio-hydra',
      createOverride(
        [
          'https://cdn.shopify.com/s/files/1/2139/2967/products/SerumHydra_CremeLacteeHYDRA.jpg?v=1645521365',
          'https://cdn.shopify.com/s/files/1/2139/2967/files/SerumHydraBooster-Echantillon.jpg?v=1749734471',
          'https://cdn.shopify.com/s/files/1/2139/2967/files/CremeLacteeHydraApaisante-Packshot.jpg?v=1765799220',
        ],
        {
          note:
            'PATYKA HYDRA sample PDP has no storefront media; reuse related HYDRA sample and travel-size assets',
        },
      ),
    ],
    [
      'https://patyka.com/products/gelee-nettoyante-purifiante-fluide-mat-perfecteur-travel-size',
      createOverride(
        [
          'https://cdn.shopify.com/s/files/1/2139/2967/products/TS-Gelee.jpg?v=1618491865',
          'https://cdn.shopify.com/s/files/1/2139/2967/files/FluideMatifiantAnti-Imperfections-Packshot.jpg?v=1751279676',
        ],
        {
          note:
            'PATYKA PURE travel-size duo PDP has no storefront media; reuse related Gel\u00e9e and Fluide product assets',
        },
      ),
    ],
    [
      'https://patyka.com/products/duo-mousse-nettoyante-detox-boutique-spa',
      createOverride(
        [
          'https://cdn.shopify.com/s/files/1/2139/2967/files/Duo_Mousse_Nettoyante_Detox_-_Packshot.jpg?v=1750422282',
          'https://cdn.shopify.com/s/files/1/2139/2967/files/Mousse_Nettoyante_Detox_-_Beautyshot.jpg?v=1763980849',
          'https://cdn.shopify.com/s/files/1/2139/2967/files/Mousse_Nettoyante_Detox_-_Beautyshot_2093d08a-2bb0-4ffb-b046-1d512bd33196.jpg?v=1750422282',
          'https://cdn.shopify.com/s/files/1/2139/2967/files/Mousse_Nettoyante_Detox_-_Texture.jpg?v=1763980849',
          'https://cdn.shopify.com/s/files/1/2139/2967/files/Clean_-_Beautyshot_-_Collection.jpg?v=1763980849',
        ],
        {
          note:
            'PATYKA boutique-spa duo PDP has no storefront media; reuse the matching Duo Mousse Nettoyante D\u00e9tox asset set',
        },
      ),
    ],
    [
      'https://patyka.com/products/routine-age-specific-intensif-serum-repulpant-fondamental-combleur-rides-instantane-travel-size',
      createOverride(
        [
          'https://cdn.shopify.com/s/files/1/2139/2967/products/SRF.jpg?v=1682006953',
          'https://cdn.shopify.com/s/files/1/2139/2967/files/Combleur_Rides_Instantane_-_Packshot.jpg?v=1766053236',
          'https://cdn.shopify.com/s/files/1/2139/2967/files/CombleurRidesInstantane-Beautyshot.jpg?v=1766053236',
        ],
        {
          note:
            'PATYKA AGE SPECIFIC travel-size duo PDP has no storefront media; reuse related Serum Repulpant and Combleur assets',
        },
      ),
    ],
  ].map(([url, override]) => [normalizeUrlKey(url), override]),
);

function lookupExternalSeedImageOverride(...candidates) {
  for (const candidate of candidates) {
    const match = OVERRIDES.get(normalizeUrlKey(candidate));
    if (match) return match;
  }
  return null;
}

module.exports = {
  normalizeUrlKey,
  lookupExternalSeedImageOverride,
};
