import { z } from "zod";
import axios from "axios";

import { LookSpecV0 } from "../layer2/schemas/lookSpecV0";

import { KitPlanV0, KitPlanV0Schema } from "./schemas/kitPlanV0";
import { ProductAttributesV0, ProductAttributesV0Schema, ProductCategorySchema } from "./schemas/productAttributesV0";

import { getCandidates, CandidatesByCategory, RawSkuCandidate } from "./retrieval/getCandidates";
import { normalizeSkuToAttributes } from "./normalize/normalizeSkuToAttributes";
import { rankCandidates } from "./ranking/rankCandidates";
import { buildWhyThis } from "./copy/whyThis";

type Market = "US" | "JP";

const INFRA_API_BASE = (process.env.PIVOTA_API_BASE || "http://localhost:8080").replace(/\/$/, "");
const OUTBOUND_LINKS_TOOL = String(process.env.OUTBOUND_LINKS_TOOL || "look_replicator");
const OUTBOUND_LINKS_ENABLED = process.env.NODE_ENV === "production" || String(process.env.LAYER3_OUTBOUND_LINKS || "") === "1";
const EXTERNAL_OFFERS_ENABLED = process.env.NODE_ENV === "production" || String(process.env.LAYER3_EXTERNAL_OFFERS || "") === "1";

function engineVersionFor(market: Market) {
  const m = String(market || "US").toLowerCase();
  return {
    layer2: `l2-${m}-0.1.0`,
    layer3: `l3-${m}-0.1.0`,
    orchestrator: `orchestrator-${m}-0.1.0`,
  };
}

function makePlaceholder(input: {
  market: Market;
  category: z.infer<typeof ProductCategorySchema>;
  locale: string;
  kind: "best" | "dupe";
  lookSpec: LookSpecV0;
  reason: string;
  purchaseEnabled?: boolean;
}): ProductAttributesV0 {
  const { market, category, locale, kind, lookSpec, reason, purchaseEnabled } = input;
  const area = lookSpec.breakdown[category];
  const whyThis = `No catalog match found (${reason}). Placeholder for ${category} to target ${area.finish} finish and ${area.coverage} coverage.`;
  const versions = engineVersionFor(market);

  return ProductAttributesV0Schema.parse({
    schemaVersion: "v0",
    market,
    locale,
    layer2EngineVersion: versions.layer2 as any,
    layer3EngineVersion: versions.layer3 as any,
    orchestratorVersion: versions.orchestrator as any,
    category,
    skuId: `placeholder_${category}_${kind}`,
    name: `Placeholder ${category} (${kind})`,
    brand: "Unknown",
    price: { currency: market === "JP" ? "JPY" : "USD", amount: 0 },
    priceTier: "unknown",
    imageUrl: undefined,
    productUrl: undefined,
    availability: "unknown",
    availabilityByMarket: market === "US" ? { US: "unknown" } : { JP: "unknown" },
    tags: { finish: [], texture: [], coverage: [], effect: [] },
    undertoneFit: "unknown",
    shadeDescriptor: undefined,
    whyThis,
    evidence: [
      `lookSpec.breakdown.${category}.finish`,
      `lookSpec.breakdown.${category}.coverage`,
      "product.priceTier",
      market === "US" ? "product.availabilityByMarket.US" : "product.availabilityByMarket.JP",
    ],
    ...(purchaseEnabled != null ? { purchaseEnabled } : {}),
  });
}

function toProductAttributes(input: {
  locale: string;
  lookSpec: LookSpecV0;
  normalized: ReturnType<typeof normalizeSkuToAttributes>;
  category: z.infer<typeof ProductCategorySchema>;
  additionalWarnings: string[];
}): ProductAttributesV0 {
  const { normalized, category, locale, lookSpec, additionalWarnings } = input;
  const { whyThis, evidence } = buildWhyThis({ category, candidate: normalized, lookSpec });

  const product = ProductAttributesV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    locale,
    layer2EngineVersion: "l2-us-0.1.0",
    layer3EngineVersion: "l3-us-0.1.0",
    orchestratorVersion: "orchestrator-us-0.1.0",
    category,
    skuId: normalized.skuId,
    name: normalized.name,
    brand: normalized.brand,
    price: normalized.price,
    priceTier: normalized.priceTier,
    imageUrl: normalized.imageUrl,
    productUrl: normalized.productUrl,
    availability: normalized.availability,
    availabilityByMarket: normalized.availabilityByMarket,
    tags: normalized.tags,
    undertoneFit: normalized.undertoneFit,
    shadeDescriptor: normalized.shadeDescriptor,
    whyThis,
    evidence,
  });

  if (additionalWarnings.length) {
    return product;
  }
  return product;
}

function isLikelyBadName(name: string): boolean {
  const n = String(name || "").trim().toLowerCase();
  return !n || n === "default title" || n.startsWith("placeholder ");
}

function deriveUsdTier(amount: number): "budget" | "mid" | "premium" | "unknown" {
  if (!Number.isFinite(amount) || amount <= 0) return "unknown";
  if (amount <= 15) return "budget";
  if (amount <= 35) return "mid";
  return "premium";
}

type LinkResolveResponse = {
  matched: boolean;
  resolved?: {
    destinationUrl: string;
    redirectUrl: string;
    purchaseEnabled: boolean;
    purchaseEnabledOverride?: boolean | null;
    ruleId?: string | null;
  } | null;
};

type ExternalOfferResolveResponse = {
  ok: boolean;
  offer?: {
    title?: string;
    imageUrl?: string;
    price?: { amount: number; currency: string };
    availability?: "in_stock" | "out_of_stock" | "unknown";
  } | null;
};

async function applyOutboundLinkAndExternalOffer(input: {
  market: Market;
  area: z.infer<typeof ProductCategorySchema>;
  kind: "best" | "dupe";
  product: ProductAttributesV0;
}): Promise<void> {
  if (!OUTBOUND_LINKS_ENABLED || !INFRA_API_BASE) return;
  if (!input.product.skuId) return;

  let resolved: LinkResolveResponse["resolved"] | null | undefined;
  try {
    const res = await axios.post<LinkResolveResponse>(
      `${INFRA_API_BASE}/api/links/resolve`,
      {
        market: input.market,
        tool: OUTBOUND_LINKS_TOOL,
        candidates: {
          skuId: input.product.skuId,
          brand: input.product.brand,
          category: input.area,
        },
        context: {
          area: input.area,
          kind: input.kind,
        },
      },
      { timeout: 5000 },
    );
    if (res.data?.matched) {
      resolved = res.data.resolved ?? null;
    }
  } catch {
    resolved = null;
  }

  if (!resolved?.redirectUrl) return;

  input.product.productUrl = resolved.redirectUrl;
  input.product.purchaseEnabled = Boolean(resolved.purchaseEnabled);

  const shouldEnrich =
    EXTERNAL_OFFERS_ENABLED &&
    resolved.destinationUrl &&
    (input.product.purchaseEnabled === false ||
      !input.product.imageUrl ||
      isLikelyBadName(input.product.name) ||
      !input.product.price?.amount);

  if (!shouldEnrich) return;

  try {
    const offerRes = await axios.post<ExternalOfferResolveResponse>(
      `${INFRA_API_BASE}/api/offers/external/resolve`,
      { market: input.market, url: resolved.destinationUrl },
      { timeout: 8000 },
    );
    const offer = offerRes.data?.ok ? offerRes.data.offer : null;
    if (!offer) return;

    if (offer.title && isLikelyBadName(input.product.name)) {
      input.product.name = offer.title;
    }
    if (offer.brand && (!input.product.brand || String(input.product.brand).toLowerCase() === "unknown")) {
      input.product.brand = String(offer.brand);
    }
    if (offer.imageUrl && !input.product.imageUrl) {
      input.product.imageUrl = offer.imageUrl;
    }
    if (offer.price?.currency && typeof offer.price.amount === "number" && offer.price.amount > 0) {
      if (!input.product.price?.amount || input.product.price.amount <= 0) {
        input.product.price = { currency: offer.price.currency, amount: offer.price.amount };
      }
      if (input.market === "US" && offer.price.currency === "USD") {
        input.product.priceTier = deriveUsdTier(offer.price.amount);
      } else {
        input.product.priceTier = "unknown";
      }
    }
    if (offer.availability) {
      input.product.availability = offer.availability;
      input.product.availabilityByMarket = input.market === "US" ? { US: offer.availability } : { JP: offer.availability };
    }
  } catch {
    // best-effort: keep original product data
  }
}

export async function buildKitPlan(input: {
  market: Market;
  locale: string;
  lookSpec: LookSpecV0;
  commerceEnabled?: boolean;
  candidatesByCategory?: CandidatesByCategory;
  limitPerCategory?: number;
  userSignals?: Record<string, unknown> | null;
}): Promise<KitPlanV0> {
  const { market, locale, lookSpec } = input;
  if (market !== "US" && market !== "JP") throw new Error("MARKET_NOT_SUPPORTED");

  const versions = engineVersionFor(market);
  const debugTriggerMatch = String(process.env.LAYER3_TRIGGER_MATCH_DEBUG || "").trim() === "1";

  if (market === "JP") {
    if (input.commerceEnabled !== false) throw new Error("MARKET_NOT_SUPPORTED");

    const kit = {
      base: {
        best: makePlaceholder({ market, category: "base", locale, kind: "best", lookSpec, reason: "COMMERCE_DISABLED", purchaseEnabled: false }),
        dupe: makePlaceholder({ market, category: "base", locale, kind: "dupe", lookSpec, reason: "COMMERCE_DISABLED", purchaseEnabled: false }),
      },
      eye: {
        best: makePlaceholder({ market, category: "eye", locale, kind: "best", lookSpec, reason: "COMMERCE_DISABLED", purchaseEnabled: false }),
        dupe: makePlaceholder({ market, category: "eye", locale, kind: "dupe", lookSpec, reason: "COMMERCE_DISABLED", purchaseEnabled: false }),
      },
      lip: {
        best: makePlaceholder({ market, category: "lip", locale, kind: "best", lookSpec, reason: "COMMERCE_DISABLED", purchaseEnabled: false }),
        dupe: makePlaceholder({ market, category: "lip", locale, kind: "dupe", lookSpec, reason: "COMMERCE_DISABLED", purchaseEnabled: false }),
      },
    };

    return KitPlanV0Schema.parse({
      schemaVersion: "v0",
      market,
      locale,
      layer2EngineVersion: versions.layer2 as any,
      layer3EngineVersion: versions.layer3 as any,
      orchestratorVersion: versions.orchestrator as any,
      kit,
      warnings: ["COMMERCE_DISABLED:JP"],
    });
  }

  const warnings: string[] = [];
  const candidatesByCategory =
    input.candidatesByCategory ??
    (await getCandidates({
      market,
      locale,
      lookSpec,
      limitPerCategory: input.limitPerCategory,
    }));

  function buildArea(
    category: z.infer<typeof ProductCategorySchema>,
    rawCandidates: RawSkuCandidate[],
    opts: { allowPlaceholder: boolean }
  ) {
    if (!rawCandidates.length) {
      if (debugTriggerMatch) warnings.push(`NO_CANDIDATES market=${market} category=${category} candidates=0`);
      if (!opts.allowPlaceholder) return null;
      return {
        best: makePlaceholder({ market, category, locale, kind: "best", lookSpec, reason: "NO_CANDIDATES", purchaseEnabled: false }),
        dupe: makePlaceholder({ market, category, locale, kind: "dupe", lookSpec, reason: "NO_CANDIDATES", purchaseEnabled: false }),
      };
    }

    const normalized = rawCandidates
      .map((sku) =>
        normalizeSkuToAttributes({
          market,
          locale,
          category,
          sku,
        })
      )
      .filter(Boolean);

    const ranked = rankCandidates({ category, lookSpec, candidates: normalized, userSignals: input.userSignals ?? null });
    for (const w of ranked.warnings) {
      if (w === "NO_CANDIDATES") {
        if (debugTriggerMatch) warnings.push(`NO_CANDIDATES market=${market} category=${category} candidates=${normalized.length}`);
      } else {
        warnings.push(`${w}:${category}`);
      }
    }

    const best =
      ranked.best ??
      normalizeSkuToAttributes({
        market,
        locale,
        category,
        sku: rawCandidates[0],
      });
    const dupe =
      ranked.dupe ??
      normalizeSkuToAttributes({
        market,
        locale,
        category,
        sku: rawCandidates[Math.min(1, rawCandidates.length - 1)],
      });

    return {
      best: toProductAttributes({ locale, lookSpec, normalized: best, category, additionalWarnings: ranked.warnings }),
      dupe: toProductAttributes({ locale, lookSpec, normalized: dupe, category, additionalWarnings: ranked.warnings }),
    };
  }

  const kit: KitPlanV0["kit"] = {
    base: buildArea("base", candidatesByCategory.base || [], { allowPlaceholder: true })!,
    eye: buildArea("eye", candidatesByCategory.eye || [], { allowPlaceholder: true })!,
    lip: buildArea("lip", candidatesByCategory.lip || [], { allowPlaceholder: true })!,
  };

  for (const category of ["prep", "contour", "brow", "blush"] as const) {
    const slot = buildArea(category, candidatesByCategory[category] || [], { allowPlaceholder: false });
    if (slot) (kit as any)[category] = slot;
  }

  // Best-effort enrichment:
  // - Apply outbound link rules (external-only + redirect tracking) via infra.
  // - If external-only, optionally fetch external metadata (title/image/price) from cached OG/JSON-LD snapshots.
  try {
    const tasks: Array<Promise<void>> = [];
    for (const area of Object.keys(kit) as Array<z.infer<typeof ProductCategorySchema>>) {
      const slot = (kit as any)[area];
      if (!slot?.best || !slot?.dupe) continue;
      tasks.push(applyOutboundLinkAndExternalOffer({ market, area, kind: "best", product: slot.best }));
      tasks.push(applyOutboundLinkAndExternalOffer({ market, area, kind: "dupe", product: slot.dupe }));
    }
    await Promise.all(tasks);
  } catch {
    // ignore
  }

  return KitPlanV0Schema.parse({
    schemaVersion: "v0",
    market,
    locale,
    layer2EngineVersion: versions.layer2 as any,
    layer3EngineVersion: versions.layer3 as any,
    orchestratorVersion: versions.orchestrator as any,
    kit,
    ...(warnings.length ? { warnings } : {}),
  });
}
