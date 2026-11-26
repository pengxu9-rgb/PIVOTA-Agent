'use strict';

/*
 * THE PRODUCT IMAGE (docs/agenpas.md, "The product image"). The backend's internal read names, at the top level, the
 * image of the exact variant bought (`product_image_url`, only when the catalog surely has one; pivota-backend
 * services/payment_orchestration/purchase_product_image). The page never loads it from the store: its CSP allows images
 * from 'self' and data: only, and a direct load would hand the store's CDN the buyer's IP. Instead
 * GET /agenpas/api/p/:id/image (router.js) fetches THAT URL server-side, for THAT purchase only, never a URL from the
 * browser, and answers the bytes; app.js reads them into a data: URL.
 *
 * The fetch: https only, port 443, a host name (never an IP literal), no user info, no redirects, public addresses only
 * (createPublicNetworkFetch pins DNS to public answers), a 3 s timeout, at most 2 MiB, and the bytes must BE a JPEG, PNG
 * or WebP (sniffed; the store's Content-Type is ignored; SVG, HTML and everything else is refused). Answers, refusals
 * included, are cached briefly per URL, so a page that re-polls costs the store nothing more.
 */

const IMAGE_URL_MAX_CHARS = 2048;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 3000;
const IMAGE_CACHE_MS = 5 * 60 * 1000;
const IMAGE_REFUSAL_CACHE_MS = 60 * 1000;
const IMAGE_CACHE_MAX_ENTRIES = 64;
// At most this many store fetches at once, process-wide; one more is refused ("busy"), never queued.
const IMAGE_MAX_IN_FLIGHT = 8;
// The cached images' bytes together stay under this; the oldest settled answers go first.
const IMAGE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * The backend's URL when it is a clean public https URL, else null. Never repairs one: the same rules the backend
 * checks (clean_product_image_url), checked again here, plus no surrounding whitespace at all.
 */
function productImageUrlFor(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > IMAGE_URL_MAX_CHARS || !PRINTABLE_ASCII_RE.test(raw)) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hash || raw.includes('#')) return null;
  const host = u.hostname.replace(/\.$/, '');
  if (!host || !host.includes('.') || host.startsWith('[') || host.includes(':') || IPV4_RE.test(host)) return null;
  // The authority as written must BE the parsed host, optionally with :443. That one rule refuses user info ("a@b"),
  // any other port, and a host `new URL` rewrote: it turns a numeric host ("https://2130706433/") into a dotted quad
  // and decodes escapes, and a host it rewrote is not the one we checked.
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(raw);
  const written = authority ? authority[1].toLowerCase() : '';
  if (written !== u.hostname && written !== `${u.hostname}:443`) return null;
  return raw;
}

/** The image type the bytes ARE (magic numbers), or null: JPEG, PNG and WebP only. */
function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * @param {{ fetchImpl: Function, now?: () => number, timeoutMs?: number, maxInFlight?: number, maxCacheBytes?: number }} deps
 *   fetchImpl: createPublicNetworkFetch() in src/server.js (tests inject a stub). Called as
 *   fetchImpl(url, { method, headers, redirect: 'error', signal }) and resolves a WHATWG Response.
 * @returns {{ get: (url: string) => Promise<{ ok: true, type: string, body: Buffer } | { ok: false, reason: string }> }}
 */
function createProductImageFetcher(deps = {}) {
  const fetchImpl = deps.fetchImpl;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : IMAGE_FETCH_TIMEOUT_MS;
  const maxInFlight = Number.isFinite(deps.maxInFlight) ? deps.maxInFlight : IMAGE_MAX_IN_FLIGHT;
  const maxCacheBytes = Number.isFinite(deps.maxCacheBytes) ? deps.maxCacheBytes : IMAGE_CACHE_MAX_BYTES;
  // url -> { pending, until, bytes, promise }, in insertion order (oldest first). A PENDING entry is never evicted:
  // evicting one would let a second fetch of the same URL start while the first is still running.
  const cache = new Map();
  let inFlight = 0;
  let cachedBytes = 0;

  function drop(url, entry) {
    cache.delete(url);
    cachedBytes -= entry.bytes;
  }

  // Settled entries only, oldest first, until `fits()` holds.
  function evictUntil(fits) {
    for (const [k, v] of cache) {
      if (fits()) return;
      if (!v.pending) drop(k, v);
    }
  }

  async function fetchOnce(url) {
    if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no_fetch' };
    // Our own timer, not AbortSignal.timeout: that one is unref'd (Node 20 lets the loop end before it fires), and
    // this one is cleared as soon as the fetch and its body are done. It bounds the body read too.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('image fetch timed out', 'TimeoutError')), timeoutMs);
    try {
      return await fetchAndSniff(url, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchAndSniff(url, signal) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: IMAGE_TYPES.join(', ') },
        redirect: 'error',
        signal,
      });
    } catch (err) {
      // The error's code only: a message can echo the URL.
      return { ok: false, reason: (err && typeof err.code === 'string' && /^[A-Z_]{1,40}$/.test(err.code) && err.code) || (err && err.name === 'TimeoutError' ? 'timeout' : 'fetch_failed') };
    }
    if (!res || res.status !== 200) return { ok: false, reason: 'status' };
    let body;
    try {
      body = Buffer.from(await res.arrayBuffer());
    } catch {
      return { ok: false, reason: 'body_failed' };
    }
    if (body.length === 0 || body.length > IMAGE_MAX_BYTES) return { ok: false, reason: 'size' };
    const type = sniffImageType(body);
    if (!type) return { ok: false, reason: 'not_an_image' };
    return { ok: true, type, body };
  }

  // ALWAYS settles: anything fetchOnce throws (a Response whose getters throw, say) is a refusal, so the in-flight slot
  // is given back and the entry stops being pending. Without this one bad answer would hold a slot until restart.
  async function settledFetch(url) {
    try {
      return await fetchOnce(url);
    } catch {
      return { ok: false, reason: 'threw' };
    }
  }

  function get(url) {
    const t = now();
    const hit = cache.get(url);
    if (hit && (hit.pending || t < hit.until)) return hit.promise;
    if (inFlight >= maxInFlight) return Promise.resolve({ ok: false, reason: 'busy' });
    // Every expired answer goes first, this URL's own stale one included (its bytes with it).
    for (const [k, v] of cache) if (!v.pending && t >= v.until) drop(k, v);
    evictUntil(() => cache.size < IMAGE_CACHE_MAX_ENTRIES);
    if (cache.size >= IMAGE_CACHE_MAX_ENTRIES) return Promise.resolve({ ok: false, reason: 'busy' });
    const entry = { pending: true, until: 0, bytes: 0, promise: null };
    inFlight += 1;
    entry.promise = settledFetch(url).then((answer) => {
      inFlight -= 1;
      entry.pending = false;
      entry.until = now() + (answer.ok ? IMAGE_CACHE_MS : IMAGE_REFUSAL_CACHE_MS);
      if (answer.ok) {
        entry.bytes = answer.body.length;
        cachedBytes += entry.bytes;
        evictUntil(() => cachedBytes <= maxCacheBytes);
      }
      return answer;
    });
    cache.set(url, entry);
    return entry.promise;
  }

  return { get };
}

module.exports = {
  IMAGE_CACHE_MAX_BYTES,
  IMAGE_CACHE_MAX_ENTRIES,
  IMAGE_MAX_IN_FLIGHT,
  IMAGE_CACHE_MS,
  IMAGE_MAX_BYTES,
  IMAGE_REFUSAL_CACHE_MS,
  IMAGE_TYPES,
  IMAGE_URL_MAX_CHARS,
  createProductImageFetcher,
  productImageUrlFor,
  sniffImageType,
};
