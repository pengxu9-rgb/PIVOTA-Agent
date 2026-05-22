#!/usr/bin/env node
/**
 * Extract Seoul beauty-service providers and service listings from a reviewed
 * Gangnam seed list.
 *
 * Dry-run by default. `--write` inserts service_providers and service_listings
 * in one explicit transaction.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

const { closePool, query } = require('../src/db');
const { createProviderFromEnv } = require('../src/llm/provider');

let cheerio = null;
try {
  // TODO(claude): The handoff says cheerio is already installed, but this
  // checkout's package.json does not declare it. Use it when present and keep
  // a local fallback so extractor review is not blocked by dependency drift.
  // eslint-disable-next-line global-require
  cheerio = require('cheerio');
} catch {
  cheerio = null;
}

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(v) {
  return String(v || '').trim();
}

const TAXONOMY_KEYS = Object.freeze([
  'nails',
  'gel-nails',
  'nail-art',
  'lashes',
  'facial',
  'chemical-peel',
  'dermatology-clinic',
  'skin-care',
  'massage',
  'body-care',
  'hair-cut',
  'hair-color',
  'hair-perm',
  'hair-treatment',
  'scalp-care',
  'makeup',
  'bridal-makeup',
  'waxing',
  'eyebrow-tattoo',
]);
const TAXONOMY_SET = new Set(TAXONOMY_KEYS);

const REPORT_PATH = path.resolve(process.cwd(), 'tmp/service_provider_extraction_report.json');
const CONDENSED_TEXT_LIMIT = 16 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  'AppleWebKit/537.36 (KHTML, like Gecko)',
  'Chrome/124.0.0.0 Safari/537.36',
].join(' ');

const HoursWindowSchema = z.object({
  open: z.string().regex(/^\d{2}:\d{2}$/),
  close: z.string().regex(/^\d{2}:\d{2}$/),
});
const HoursDaySchema = z.union([
  z.array(HoursWindowSchema),
  z.object({ closed: z.literal(true) }),
]);
const HoursSchema = z.object({
  mon: HoursDaySchema.optional(),
  tue: HoursDaySchema.optional(),
  wed: HoursDaySchema.optional(),
  thu: HoursDaySchema.optional(),
  fri: HoursDaySchema.optional(),
  sat: HoursDaySchema.optional(),
  sun: HoursDaySchema.optional(),
});

const PhotoSchema = z.object({
  url: z.string().url(),
  alt_kr: z.string().max(200).optional().nullable(),
  alt_en: z.string().max(200).optional().nullable(),
});

const TouristMetaSchema = z.object({
  nearest_station: z.string().max(120).optional().nullable(),
  walk_in_accepted: z.enum(['true', 'false', 'unknown']).default('unknown'),
  accepts_card: z.enum(['true', 'false', 'unknown']).default('unknown'),
  tipping_norm: z.enum(['not-expected', 'rounded-up', 'expected', 'unknown']).default('not-expected'),
});

const ProviderSchema = z.object({
  name_kr: z.string().max(200).nullable(),
  name_en: z.string().max(200).nullable(),
  address_kr: z.string().max(400).nullable(),
  address_en: z.string().max(400).nullable(),
  geo_lat: z.number().min(-90).max(90).nullable(),
  geo_lng: z.number().min(-180).max(180).nullable(),
  phone: z.string().max(40).nullable(),
  email: z.string().email().max(120).nullable(),
  timezone: z.string().default('Asia/Seoul'),
  hours: HoursSchema.default({}),
  photos: z.array(PhotoSchema).max(6).default([]),
  rating: z.number().min(0).max(5).nullable().default(null),
  rating_count: z.number().int().min(0).nullable().default(null),
  english_friendly_signal: z.enum(['explicit', 'inferred', 'unknown']).default('unknown'),
  english_friendly_evidence: z.string().max(400).nullable().default(null),
  tourist_metadata: TouristMetaSchema.default({}),
  extraction_confidence: z.enum(['high', 'medium', 'low']).default('medium'),
});

const ListingSchema = z.object({
  service_type: z.string().max(60),
  title_kr: z.string().max(200).nullable(),
  title_en: z.string().max(200),
  description_kr: z.string().max(1000).nullable(),
  description_en: z.string().max(1000).nullable(),
  price_won: z.number().int().min(0).nullable(),
  duration_minutes: z.number().int().min(0).max(720).nullable(),
  requires_consult: z.boolean().default(false),
  instructions_en: z.string().max(1000).nullable(),
  instructions_kr: z.string().max(1000).nullable(),
});

const LlmResponseSchema = z.object({
  provider: ProviderSchema,
  listings: z.array(ListingSchema).max(40),
});

const EXTRACTION_INSTRUCTIONS = `You extract structured service provider data from Korean/English beauty-service webpages for a Seoul K-beauty tourism pilot.

Audience and output:
- The pilot serves US travelers, so English fields are primary.
- Preserve Korean source text when present.
- title_en is required for every listing and must be idiomatic English, not romanization. Example: "프리미엄 페이셜" -> "Premium Facial", not "Pre-mi-eom Pei-syeol".
- Return one JSON object only: { "provider": {...}, "listings": [...] }.

No fabrication:
- Use only evidence in the supplied HTML text/meta plus the seed-list context.
- name_kr/name_en from the seed are trusted hints; preserve them unless the page clearly contradicts them.
- geo_lat/geo_lng only when the HTML explicitly contains coordinates in JSON-LD/schema.org/map embed text. Otherwise null.
- phone and email only when shown publicly in the HTML. Otherwise null.
- rating and rating_count only when shown in the HTML. Otherwise null.
- photos must be absolute URLs present in meta/page evidence. Omit relative or guessed URLs.
- Do not invent menu items. If no service/menu items are present, return listings: [].

Hours:
- Use Asia/Seoul unless the page states otherwise.
- Hours use 24-hour HH:MM, e.g. { "mon": [{ "open": "10:00", "close": "20:00" }] }.
- Use { "closed": true } only for clearly stated closed days. Omit unknown days.

Prices:
- KRW only. price_won is an integer in won with no cents division.
- "₩50,000" -> 50000.
- "₩120,000~" or "120,000원부터" -> 120000, using the floor/start price.
- "consultation only", "상담 후", or no visible price -> null.

Consultation:
- requires_consult must be true for dermatology clinic procedures, chemical peels, aesthetic injections, and any "상담 후", "consultation required", or "by appointment only after consultation" signal.

Tourist metadata:
- tipping_norm defaults to "not-expected" for Korea. Set another value only with explicit evidence.
- walk_in_accepted and accepts_card must be "true", "false", or "unknown".
- nearest_station should be a concise station name only when stated or clearly present in the page text.

Taxonomy:
- service_type must be exactly one primary key from this allow-list:
${TAXONOMY_KEYS.map((k) => `  - ${k}`).join('\n')}
- Seed taxonomy_keys are hints only. Listings may use other allowed keys when the page supports them.
- Map each menu item to one primary service_type.`;

function trimTo(value, max) {
  const s = asString(value);
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeWhitespace(value) {
  return asString(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, num) => String.fromCodePoint(parseInt(num, 10)));
}

function normalizeSourceExternalId(value) {
  try {
    const url = new URL(asString(value));
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    if (url.pathname !== '/') {
      url.pathname = url.pathname.replace(/\/+$/, '');
    } else {
      url.pathname = '';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return asString(value);
  }
}

function resolveMaybeUrl(value, baseUrl) {
  const s = asString(value);
  if (!s) return '';
  try {
    return new URL(s, baseUrl).toString();
  } catch {
    return s;
  }
}

function displayPath(filePath) {
  const rel = path.relative(process.cwd(), filePath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return filePath;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function fetchUrl(seedUrl) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is unavailable; use Node 18+');
  }

  let currentUrl = seedUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        return { ok: false, finalUrl: currentUrl, reason: `HTTP ${response.status} redirect without Location` };
      }
      if (redirects >= MAX_REDIRECTS) {
        return { ok: false, finalUrl: currentUrl, reason: `too many redirects (>${MAX_REDIRECTS})` };
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      return { ok: false, finalUrl: currentUrl, reason: `HTTP ${response.status}` };
    }

    const body = await response.text();
    return { ok: true, finalUrl: response.url || currentUrl, body };
  }

  return { ok: false, finalUrl: currentUrl, reason: `too many redirects (>${MAX_REDIRECTS})` };
}

function looksLikeInstagramLoginWall(html) {
  const s = String(html || '');
  if (/<title[^>]*>\s*Login\b/i.test(s)) return true;
  return !/<meta\b(?=[^>]*(?:property|name)\s*=\s*["']og:description["'])(?=[^>]*content\s*=)[^>]*>/i.test(s);
}

function dedupeMeta(meta) {
  const seen = new Set();
  const out = [];
  for (const item of meta) {
    const key = asString(item.key);
    const content = asString(item.content);
    if (!key || !content) continue;
    const sig = `${key}\u0000${content}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ key, content });
  }
  return out;
}

function normalizeMetaContent(key, content, baseUrl) {
  const normalizedKey = asString(key).toLowerCase();
  const value = decodeHtmlEntities(content);
  if (normalizedKey.includes('image') || normalizedKey.includes('url')) {
    return resolveMaybeUrl(value, baseUrl);
  }
  return normalizeWhitespace(value);
}

function collectCheerioText(node, out) {
  if (!node) return;
  if (node.type === 'text') {
    const text = normalizeWhitespace(node.data || '');
    if (text) out.push(text);
    return;
  }
  if (node.type !== 'tag' && node.type !== 'root') return;

  const tag = String(node.name || '').toLowerCase();
  const blockTags = new Set([
    'address',
    'article',
    'aside',
    'blockquote',
    'br',
    'dd',
    'div',
    'dl',
    'dt',
    'figcaption',
    'figure',
    'footer',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hr',
    'li',
    'main',
    'nav',
    'ol',
    'p',
    'pre',
    'section',
    'table',
    'tbody',
    'td',
    'th',
    'tr',
    'ul',
  ]);

  if (tag === 'br' || tag === 'hr') {
    out.push('\n');
    return;
  }
  if (tag === 'li') out.push('\n- ');
  else if (blockTags.has(tag)) out.push('\n');

  for (const child of node.children || []) collectCheerioText(child, out);

  if (blockTags.has(tag)) out.push('\n');
}

function pickCheerioTextRoot($) {
  for (const selector of ['main', 'article', 'body']) {
    const nodes = $(selector);
    if (!nodes.length) continue;
    const text = normalizeWhitespace(nodes.text());
    if (text) return nodes;
  }
  return $.root();
}

function condenseWithCheerio(html, baseUrl) {
  const $ = cheerio.load(html || '', { decodeEntities: true });
  $('script, style, noscript, svg').remove();
  $('*').contents().each((_idx, node) => {
    if (node.type === 'comment') $(node).remove();
  });

  const title = normalizeWhitespace($('title').first().text());
  const meta = [];
  $('meta').each((_idx, el) => {
    const key = asString($(el).attr('name') || $(el).attr('property'));
    const content = asString($(el).attr('content'));
    if (!key || !content) return;
    meta.push({
      key,
      content: trimTo(normalizeMetaContent(key, content, baseUrl), 1000),
    });
  });

  const out = [];
  pickCheerioTextRoot($).each((_idx, el) => collectCheerioText(el, out));
  const text = normalizeWhitespace(out.join(' '));
  return { title, meta: dedupeMeta(meta), text };
}

function stripHtmlScaffolding(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
}

function extractTagText(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(html);
  return m ? normalizeWhitespace(decodeHtmlEntities(m[1].replace(/<[^>]+>/g, ' '))) : '';
}

function extractMetaFallback(html, baseUrl) {
  const meta = [];
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const keyMatch = /\b(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag);
    const contentMatch = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!keyMatch || !contentMatch) continue;
    const key = asString(decodeHtmlEntities(keyMatch[1]));
    const content = trimTo(normalizeMetaContent(key, contentMatch[1], baseUrl), 1000);
    if (key && content) meta.push({ key, content });
  }
  return dedupeMeta(meta);
}

function extractFragmentsByTag(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const fragments = [];
  let m;
  while ((m = re.exec(html)) !== null) fragments.push(m[1]);
  return fragments;
}

function htmlFragmentToText(fragment) {
  const withBreaks = String(fragment || '')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|td|th|tr|ul)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return normalizeWhitespace(decodeHtmlEntities(withBreaks));
}

function condenseWithFallback(html, baseUrl) {
  const cleaned = stripHtmlScaffolding(html);
  const title = extractTagText(cleaned, 'title');
  const meta = extractMetaFallback(cleaned, baseUrl);

  let fragments = extractFragmentsByTag(cleaned, 'main');
  if (!fragments.length) fragments = extractFragmentsByTag(cleaned, 'article');
  if (!fragments.length) fragments = extractFragmentsByTag(cleaned, 'body');
  if (!fragments.length) fragments = [cleaned];

  const text = normalizeWhitespace(fragments.map(htmlFragmentToText).join('\n\n'));
  return { title, meta, text };
}

function condenseHtml(html, baseUrl) {
  const extracted = cheerio ? condenseWithCheerio(html, baseUrl) : condenseWithFallback(html, baseUrl);
  const metaLines = extracted.meta.map((m) => `- ${m.key}: ${m.content}`);
  const condensed = [
    `URL: ${baseUrl}`,
    extracted.title ? `Title: ${extracted.title}` : 'Title: ',
    metaLines.length ? ['Meta tags:', ...metaLines].join('\n') : 'Meta tags: none found',
    'Visible text:',
    extracted.text || '(no visible text extracted)',
  ].join('\n');

  return {
    ...extracted,
    condensed: condensed.slice(0, CONDENSED_TEXT_LIMIT),
  };
}

function schemaIssuesFromError(err) {
  const issues = err?.cause?.issues || err?.issues || err?.cause?.errors || [];
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => ({
    path: Array.isArray(issue.path) ? issue.path.join('.') : asString(issue.path),
    code: asString(issue.code),
    message: asString(issue.message),
  }));
}

async function callLlm(provider, { seed, finalUrl, condensed }) {
  const seedContext = {
    name_kr: seed.name_kr ?? null,
    name_en: seed.name_en ?? null,
    url: seed.url,
    url_kind: seed.url_kind,
    district: seed.district,
    taxonomy_keys: Array.isArray(seed.taxonomy_keys) ? seed.taxonomy_keys : [],
    english_friendly_signal: seed.english_friendly_signal,
    english_friendly_evidence: seed.english_friendly_evidence,
    confidence: seed.confidence,
  };
  const prompt = [
    EXTRACTION_INSTRUCTIONS,
    '',
    'Seed-list context:',
    JSON.stringify(seedContext, null, 2),
    '',
    `Fetched final URL: ${finalUrl}`,
    '',
    'Condensed HTML evidence:',
    condensed,
  ].join('\n');

  try {
    const result = await provider.analyzeTextToJson({ prompt, schema: LlmResponseSchema });
    return { ok: true, data: result };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      issues: schemaIssuesFromError(err),
    };
  }
}

function applySeedFallbacks(seed, provider) {
  const next = {
    ...provider,
    name_kr: provider.name_kr || seed.name_kr || null,
    name_en: provider.name_en || seed.name_en || null,
  };

  const seedSignal = asString(seed.english_friendly_signal);
  if (
    next.english_friendly_signal === 'unknown' &&
    ['explicit', 'inferred', 'unknown'].includes(seedSignal)
  ) {
    next.english_friendly_signal = seedSignal;
  }
  if (!next.english_friendly_evidence && seed.english_friendly_evidence) {
    next.english_friendly_evidence = trimTo(seed.english_friendly_evidence, 400);
  }

  return ProviderSchema.safeParse(next);
}

function baseResult(seed, seedIndex) {
  return {
    seed_index: seedIndex,
    seed_name_en: seed.name_en ?? null,
    seed_url: seed.url,
    status: 'fetch_failed',
    status_detail: '',
    provider: null,
    listings: [],
    taxonomy_unknown_keys: [],
  };
}

async function processEntry({ seed, seedIndex, provider }) {
  const base = baseResult(seed, seedIndex);
  let fetched;
  try {
    fetched = await fetchUrl(seed.url);
  } catch (err) {
    return {
      ...base,
      status: 'fetch_failed',
      status_detail: err?.name === 'AbortError' ? `fetch timed out after ${FETCH_TIMEOUT_MS}ms` : (err?.message || String(err)),
    };
  }

  if (!fetched.ok) {
    return {
      ...base,
      status: 'fetch_failed',
      status_detail: fetched.reason,
      final_url: fetched.finalUrl || seed.url,
    };
  }

  if (seed.url_kind === 'instagram' && looksLikeInstagramLoginWall(fetched.body)) {
    return {
      ...base,
      status: 'instagram_login_wall',
      status_detail: 'Instagram public HTML appears to be a login wall or lacks og:description',
      final_url: fetched.finalUrl,
    };
  }

  const condensed = condenseHtml(fetched.body, fetched.finalUrl);
  const llmResult = await callLlm(provider, {
    seed,
    finalUrl: fetched.finalUrl,
    condensed: condensed.condensed,
  });
  if (!llmResult.ok) {
    return {
      ...base,
      status: 'schema_validation_failed',
      status_detail: llmResult.error,
      schema_issues: llmResult.issues,
      final_url: fetched.finalUrl,
    };
  }

  const providerResult = applySeedFallbacks(seed, llmResult.data.provider);
  if (!providerResult.success) {
    return {
      ...base,
      status: 'schema_validation_failed',
      status_detail: 'provider failed validation after applying seed fallbacks',
      schema_issues: schemaIssuesFromError(providerResult.error),
      final_url: fetched.finalUrl,
    };
  }

  const taxonomyUnknown = new Set();
  const listings = llmResult.data.listings.map((listing) => {
    if (TAXONOMY_SET.has(listing.service_type)) return listing;
    taxonomyUnknown.add(listing.service_type);
    return { ...listing, taxonomy_unknown: true };
  });

  if (!listings.length) {
    return {
      ...base,
      status: 'no_listings_extracted',
      status_detail: 'LLM returned zero service listings from the page evidence',
      provider: providerResult.data,
      listings: [],
      taxonomy_unknown_keys: [],
      final_url: fetched.finalUrl,
    };
  }

  return {
    ...base,
    status: 'ok',
    status_detail: taxonomyUnknown.size
      ? `extracted ${listings.length} listings; unknown taxonomy keys: ${Array.from(taxonomyUnknown).join(', ')}`
      : `extracted ${listings.length} listings`,
    provider: providerResult.data,
    listings,
    taxonomy_unknown_keys: Array.from(taxonomyUnknown),
    final_url: fetched.finalUrl,
  };
}

function selectJobs(entries, { limit, onlyConfidence }) {
  const jobs = [];
  for (let idx = 0; idx < entries.length; idx += 1) {
    const entry = entries[idx];
    if (onlyConfidence && asString(entry.confidence).toLowerCase() !== onlyConfidence) continue;
    jobs.push({ seed: entry, seedIndex: idx });
  }
  if (Number.isFinite(limit) && limit > 0) return jobs.slice(0, Math.min(limit, jobs.length));
  return jobs;
}

function buildReport({ inputPathForReport, inputEntries, processed, skipped, results }) {
  return {
    generated_at: new Date().toISOString(),
    input_path: inputPathForReport,
    input_entries: inputEntries,
    processed,
    skipped,
    results,
  };
}

function buildCategories(seed, result) {
  const categories = new Set();
  for (const key of Array.isArray(seed.taxonomy_keys) ? seed.taxonomy_keys : []) {
    if (key) categories.add(key);
  }
  for (const listing of result.listings || []) {
    if (listing.service_type) categories.add(listing.service_type);
  }
  return Array.from(categories);
}

function buildProviderMetadata(seed, result) {
  const provider = result.provider || {};
  return {
    extraction_source: 'llm_service_provider_extraction_v1',
    seed: {
      name_kr: seed.name_kr ?? null,
      name_en: seed.name_en ?? null,
      url: seed.url,
      url_kind: seed.url_kind,
      district: seed.district,
      taxonomy_keys: Array.isArray(seed.taxonomy_keys) ? seed.taxonomy_keys : [],
      confidence: seed.confidence,
      english_friendly_signal: seed.english_friendly_signal,
      english_friendly_evidence: seed.english_friendly_evidence,
      tourist_relevance_note: seed.tourist_relevance_note,
      research_source: seed.research_source,
      research_source_url: seed.research_source_url,
    },
    final_url: result.final_url || null,
    name_kr: provider.name_kr ?? null,
    name_en: provider.name_en ?? null,
    address_kr: provider.address_kr ?? null,
    address_en: provider.address_en ?? null,
    english_friendly_signal: provider.english_friendly_signal ?? 'unknown',
    english_friendly_evidence: provider.english_friendly_evidence ?? null,
    tourist_metadata: provider.tourist_metadata || {},
    extraction_confidence: provider.extraction_confidence || 'medium',
    taxonomy_unknown_keys: result.taxonomy_unknown_keys || [],
  };
}

function buildListingMetadata(seed, result, listing) {
  return {
    extraction_source: 'llm_service_provider_extraction_v1',
    seed_url: seed.url,
    final_url: result.final_url || null,
    title_kr: listing.title_kr ?? null,
    title_en: listing.title_en,
    description_kr: listing.description_kr ?? null,
    description_en: listing.description_en ?? null,
    instructions_kr: listing.instructions_kr ?? null,
    price_won: listing.price_won ?? null,
    taxonomy_unknown: Boolean(listing.taxonomy_unknown),
  };
}

async function findWriteConflicts(jobs) {
  const conflicts = [];
  const seen = new Set();
  for (const job of jobs) {
    const sourceExternalId = normalizeSourceExternalId(job.seed.url);
    if (!sourceExternalId || seen.has(sourceExternalId)) continue;
    seen.add(sourceExternalId);
    const res = await query(
      `SELECT 1
         FROM service_providers
        WHERE source = 'scrape'
          AND source_external_id = $1
        LIMIT 1`,
      [sourceExternalId],
    );
    if ((res.rows || []).length) conflicts.push(sourceExternalId);
  }
  return conflicts;
}

function buildWriteConflictError(conflicts) {
  return new Error(
    [
      'Refusing --write because service_providers rows already exist for source=scrape and source_external_id:',
      ...conflicts.map((u) => `- ${u}`),
      'Re-run with --allow-update to replace matching rows.',
    ].join('\n'),
  );
}

async function writeResults({ results, entries, jobs, allowUpdate }) {
  const okResults = results.filter((r) => r.status === 'ok');
  const conflicts = await findWriteConflicts(jobs);
  if (conflicts.length && !allowUpdate) {
    throw buildWriteConflictError(conflicts);
  }
  if (!okResults.length) return { providers_written: 0, listings_written: 0 };

  let providersWritten = 0;
  let listingsWritten = 0;

  await query('BEGIN');
  try {
    if (allowUpdate) {
      const sourceIds = Array.from(new Set(okResults.map((r) => normalizeSourceExternalId(r.seed_url)).filter(Boolean)));
      for (const sourceExternalId of sourceIds) {
        await query(
          `DELETE FROM service_providers
            WHERE source = 'scrape'
              AND source_external_id = $1`,
          [sourceExternalId],
        );
      }
    }

    for (const result of okResults) {
      const seed = entries[result.seed_index] || {};
      const provider = result.provider;
      const providerId = crypto.randomUUID();
      const sourceExternalId = normalizeSourceExternalId(result.seed_url);
      const providerName = trimTo(
        provider.name_en || provider.name_kr || seed.name_en || seed.name_kr || sourceExternalId,
        200,
      );
      const displayName = trimTo(provider.name_en || provider.name_kr || providerName, 200);

      await query(
        `INSERT INTO service_providers (
           provider_id,
           source,
           source_external_id,
           name,
           display_name,
           website_url,
           email,
           phone,
           address_line1,
           city,
           region,
           country_code,
           geo_lat,
           geo_lng,
           timezone,
           categories,
           hours,
           photos,
           rating,
           rating_count,
           status,
           metadata
         ) VALUES (
           $1, 'scrape', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           $12, $13, $14, $15::text[], $16::jsonb, $17::jsonb, $18, $19,
           'candidate', $20::jsonb
         )`,
        [
          providerId,
          sourceExternalId,
          providerName,
          displayName || null,
          result.final_url || result.seed_url,
          provider.email || null,
          provider.phone || null,
          provider.address_en || provider.address_kr || null,
          'Seoul',
          'Gangnam-gu',
          'KR',
          provider.geo_lat,
          provider.geo_lng,
          provider.timezone || 'Asia/Seoul',
          buildCategories(seed, result),
          JSON.stringify(provider.hours || {}),
          JSON.stringify(provider.photos || []),
          provider.rating,
          provider.rating_count,
          JSON.stringify(buildProviderMetadata(seed, result)),
        ],
      );
      providersWritten += 1;

      for (const listing of result.listings) {
        const listingId = crypto.randomUUID();
        await query(
          `INSERT INTO service_listings (
             listing_id,
             provider_id,
             service_type,
             title,
             description,
             price_cents,
             currency,
             duration_minutes,
             requires_consult,
             instructions,
             status,
             metadata
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'KRW', $7, $8, $9, 'active', $10::jsonb
           )`,
          [
            listingId,
            providerId,
            listing.service_type,
            listing.title_en,
            listing.description_en || listing.description_kr || null,
            listing.price_won,
            listing.duration_minutes,
            listing.requires_consult,
            listing.instructions_en || null,
            JSON.stringify(buildListingMetadata(seed, result, listing)),
          ],
        );
        listingsWritten += 1;
      }
    }

    await query('COMMIT');
  } catch (err) {
    await query('ROLLBACK');
    throw err;
  }

  return { providers_written: providersWritten, listings_written: listingsWritten };
}

async function main() {
  const inputArg = asString(argValue('input', 'tmp/gangnam_seed_list.json'));
  const inputPath = path.resolve(process.cwd(), inputArg);
  const limit = Number(argValue('limit', '0')) || 0;
  const onlyConfidence = asString(argValue('only-confidence')).toLowerCase();
  const write = hasFlag('write');
  const allowUpdate = hasFlag('allow-update');

  if (onlyConfidence && !['high', 'medium', 'low'].includes(onlyConfidence)) {
    throw new Error('--only-confidence must be one of: high, medium, low');
  }

  const seedDoc = readJsonFile(inputPath);
  const entries = Array.isArray(seedDoc.entries) ? seedDoc.entries : [];
  const jobs = selectJobs(entries, { limit, onlyConfidence });

  if (write && !allowUpdate) {
    const conflicts = await findWriteConflicts(jobs);
    if (conflicts.length) throw buildWriteConflictError(conflicts);
  }

  let provider = null;
  if (jobs.length) {
    provider = createProviderFromEnv('generic');
    if (typeof provider?.analyzeTextToJson !== 'function') {
      throw new Error('LLM provider does not expose analyzeTextToJson');
    }
  }

  const results = [];
  let processed = 0;
  for (const job of jobs) {
    const result = await processEntry({ seed: job.seed, seedIndex: job.seedIndex, provider });
    results.push(result);
    processed += 1;
    process.stderr.write(
      `[${processed}/${jobs.length}] ${job.seed.name_en || job.seed.name_kr || job.seed.url} -> ${result.status}\n`,
    );
  }

  results.sort((a, b) => a.seed_index - b.seed_index);
  const skipped = entries.length - jobs.length;
  const report = buildReport({
    inputPathForReport: inputArg,
    inputEntries: entries.length,
    processed: results.length,
    skipped,
    results,
  });

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  if (write) {
    await writeResults({ results, entries, jobs, allowUpdate });
  }

  const listingCount = results.reduce((sum, r) => sum + (Array.isArray(r.listings) ? r.listings.length : 0), 0);
  process.stdout.write(
    `WROTE: ${displayPath(REPORT_PATH)} (processed=${results.length}, skipped=${skipped}, listings=${listingCount})\n`,
  );
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(
        `${JSON.stringify({ ok: false, error: err?.message || String(err), stack: err?.stack }, null, 2)}\n`,
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
    });
}
