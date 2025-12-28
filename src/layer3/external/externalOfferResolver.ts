import axios from "axios";
import { ExternalOfferV0Schema, type ExternalOfferV0 } from "../schemas/offerObjectV0";
import { canonicalizeUrl, hostnameMatchesAllowlist, stableOfferIdFromCanonicalUrl, validateHttpUrlOrThrow } from "./urlUtils";
import { query } from "../../db";

type ResolveInput = { url: string; market: "US" | "JP"; locale?: string };

type ResolveErrorCode = "URL_INVALID" | "DOMAIN_NOT_ALLOWED" | "FETCH_FAILED" | "PARSE_FAILED";

export class ExternalOfferError extends Error {
  code: ResolveErrorCode;
  constructor(code: ResolveErrorCode, message?: string) {
    super(message || code);
    this.code = code;
  }
}

const DEFAULT_DISCLOSURE_TEXT =
  "Prices may change. We may earn a commission from qualifying purchases.";

const MAX_BYTES = Number(process.env.EXTERNAL_OFFER_MAX_BYTES || 512 * 1024);
const TIMEOUT_MS = Number(process.env.EXTERNAL_OFFER_FETCH_TIMEOUT_MS || 2500);
const CACHE_TTL_MIN = Number(process.env.EXTERNAL_OFFER_CACHE_TTL_MINUTES || 30);
const MEM_MAX = Number(process.env.EXTERNAL_OFFER_CACHE_MAX || 500);

type CacheEntry = { expiresAt: number; offer: ExternalOfferV0 };
const memoryCache = new Map<string, CacheEntry>();

function cacheKey(market: string, offerId: string) {
  return `${market}:${offerId}`;
}

function getAllowedDomains(market: "US" | "JP"): string[] {
  const env =
    market === "US"
      ? process.env.EXTERNAL_OFFER_ALLOWED_DOMAINS_US
      : process.env.EXTERNAL_OFFER_ALLOWED_DOMAINS_JP;
  return String(env || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function nowIso() {
  return new Date().toISOString();
}

function getCachedMemory(market: "US" | "JP", offerId: string): ExternalOfferV0 | null {
  const key = cacheKey(market, offerId);
  const hit = memoryCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return hit.offer;
}

function setCachedMemory(market: "US" | "JP", offer: ExternalOfferV0) {
  const key = cacheKey(market, offer.offerId);
  memoryCache.set(key, { offer, expiresAt: Date.now() + CACHE_TTL_MIN * 60_000 });
  if (memoryCache.size > MEM_MAX) {
    const first = memoryCache.keys().next().value;
    if (first) memoryCache.delete(first);
  }
}

async function getCachedDb(market: "US" | "JP", offerId: string): Promise<ExternalOfferV0 | null> {
  try {
    const res = await query(
      "SELECT payload_json, updated_at FROM external_offers_cache WHERE market = $1 AND offer_id = $2 LIMIT 1",
      [market, offerId],
    );
    const row = res.rows[0];
    if (!row) return null;
    const updatedAt = new Date(row.updated_at).getTime();
    if (Date.now() - updatedAt > CACHE_TTL_MIN * 60_000) return null;
    return ExternalOfferV0Schema.parse(row.payload_json);
  } catch (err: any) {
    if (err?.code === "NO_DATABASE") return null;
    if (err?.code === "42P01") return null;
    return null;
  }
}

async function setCachedDb(market: "US" | "JP", offer: ExternalOfferV0): Promise<void> {
  try {
    await query(
      `INSERT INTO external_offers_cache (market, offer_id, canonical_url, payload_json, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (market, offer_id)
       DO UPDATE SET canonical_url = EXCLUDED.canonical_url, payload_json = EXCLUDED.payload_json, updated_at = NOW()`,
      [market, offer.offerId, offer.canonicalUrl, offer],
    );
  } catch (err: any) {
    if (err?.code === "NO_DATABASE") return;
    if (err?.code === "42P01") return;
  }
}

function extractMeta(html: string, attr: "property" | "name", key: string): string | null {
  const pattern = new RegExp(
    `<meta[^>]*${attr}=[\"']${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}[\"'][^>]*content=[\"']([^\"']+)[\"'][^>]*>`,
    "i",
  );
  const m = html.match(pattern);
  return m?.[1]?.trim() || null;
}

function extractJsonLdBlocks(html: string): string[] {
  const blocks: string[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = m[1]?.trim();
    if (raw) blocks.push(raw);
  }
  return blocks;
}

function findFirstProductJsonLd(blocks: string[]): any | null {
  for (const raw of blocks) {
    try {
      const parsed = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const obj of candidates) {
        const type = obj?.["@type"];
        const types = Array.isArray(type) ? type : type ? [type] : [];
        if (types.some((t) => String(t).toLowerCase() === "product")) return obj;
        if (obj?.["@graph"] && Array.isArray(obj["@graph"])) {
          const found = obj["@graph"].find((n: any) => {
            const t = n?.["@type"];
            const ts = Array.isArray(t) ? t : t ? [t] : [];
            return ts.some((x) => String(x).toLowerCase() === "product");
          });
          if (found) return found;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

function normalizeAvailability(value: string | undefined): "in_stock" | "out_of_stock" | "unknown" {
  if (!value) return "unknown";
  const v = value.toLowerCase();
  if (v.includes("instock")) return "in_stock";
  if (v.includes("outofstock")) return "out_of_stock";
  return "unknown";
}

function parseExternalOfferFromHtml({
  canonicalUrl,
  market,
  html,
}: {
  canonicalUrl: string;
  market: "US" | "JP";
  html: string;
}): ExternalOfferV0 {
  const ogTitle = extractMeta(html, "property", "og:title") || extractMeta(html, "name", "twitter:title");
  const ogImage = extractMeta(html, "property", "og:image") || extractMeta(html, "name", "twitter:image");
  const ogPriceAmt = extractMeta(html, "property", "product:price:amount") || extractMeta(html, "property", "og:price:amount");
  const ogPriceCur = extractMeta(html, "property", "product:price:currency") || extractMeta(html, "property", "og:price:currency");

  const jsonld = findFirstProductJsonLd(extractJsonLdBlocks(html));
  const jsonldName: string | undefined = jsonld?.name;
  const jsonldImage: string | undefined = Array.isArray(jsonld?.image) ? jsonld.image[0] : jsonld?.image;

  let price: { amount: number; currency: string } | undefined;
  let listPrice: { amount: number; currency: string } | undefined;
  let availability: "in_stock" | "out_of_stock" | "unknown" | undefined;
  let evidenceProvider: "og" | "jsonld" | "manual" = "manual";

  if (jsonld?.offers) {
    const offers = Array.isArray(jsonld.offers) ? jsonld.offers : [jsonld.offers];
    const offer0 = offers.find((o: any) => o?.price || o?.priceSpecification) || offers[0];
    const p = offer0?.price ?? offer0?.priceSpecification?.price;
    const c = offer0?.priceCurrency ?? offer0?.priceSpecification?.priceCurrency;
    const a = offer0?.availability;
    const amount = typeof p === "string" ? Number(p) : typeof p === "number" ? p : null;
    if (amount != null && Number.isFinite(amount) && c) {
      price = { amount, currency: String(c) };
      evidenceProvider = "jsonld";
    }
    availability = normalizeAvailability(typeof a === "string" ? a : undefined);
  }

  if (!price && ogPriceAmt && ogPriceCur) {
    const amount = Number(ogPriceAmt);
    if (Number.isFinite(amount)) {
      price = { amount, currency: String(ogPriceCur) };
      evidenceProvider = "og";
    }
  }

  const domain = new URL(canonicalUrl).hostname;
  const title = (jsonldName || ogTitle || domain).trim();

  const offer: ExternalOfferV0 = {
    offerId: stableOfferIdFromCanonicalUrl(canonicalUrl),
    source: "external",
    market,
    canonicalUrl,
    domain,
    title,
    imageUrl: (jsonldImage || ogImage || undefined) as any,
    price,
    listPrice,
    availability: availability || "unknown",
    lastCheckedAt: nowIso(),
    disclosure: { type: "unknown", text: DEFAULT_DISCLOSURE_TEXT },
    evidence:
      evidenceProvider === "manual"
        ? undefined
        : { provider: evidenceProvider, fetchedAt: nowIso() },
  };

  return ExternalOfferV0Schema.parse(offer);
}

export async function resolveExternalOffer(input: ResolveInput): Promise<ExternalOfferV0> {
  const parsedUrl = validateHttpUrlOrThrow(input.url);
  const canonicalUrl = canonicalizeUrl(parsedUrl);
  const offerId = stableOfferIdFromCanonicalUrl(canonicalUrl);

  const allowed = getAllowedDomains(input.market);
  if (!hostnameMatchesAllowlist(parsedUrl.hostname, allowed)) {
    throw new ExternalOfferError("DOMAIN_NOT_ALLOWED", `Domain not allowed: ${parsedUrl.hostname}`);
  }

  const mem = getCachedMemory(input.market, offerId);
  if (mem) return mem;

  const dbHit = await getCachedDb(input.market, offerId);
  if (dbHit) {
    setCachedMemory(input.market, dbHit);
    return dbHit;
  }

  let res;
  try {
    res = await axios.get(canonicalUrl, {
      timeout: TIMEOUT_MS,
      maxContentLength: MAX_BYTES,
      maxBodyLength: MAX_BYTES,
      responseType: "text",
      headers: {
        "User-Agent": "PivotaAgent/0.1 (+https://pivota.ai)",
        Accept: "text/html,application/xhtml+xml",
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
  } catch (err: any) {
    throw new ExternalOfferError("FETCH_FAILED", err?.message || "Fetch failed");
  }

  const html = typeof res.data === "string" ? res.data : String(res.data || "");
  const offer = parseExternalOfferFromHtml({ canonicalUrl, market: input.market, html });
  setCachedMemory(input.market, offer);
  await setCachedDb(input.market, offer);
  return offer;
}

