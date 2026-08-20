// The PUBLIC read-only MCP tool surface — the auth:none tier an app directory (OpenAI Apps SDK) points at.
// A strict subset of the commerce surface: the four discovery/intelligence read tools, no money, nothing
// user-scoped. Anonymous by construction: the session context handed to the commerce surface is ALWAYS
// empty, so no header, token, or model-supplied field can ever bind a buyer identity on this surface, and
// every tool outside the allowlist is refused as unknown BEFORE dispatch — on this surface the commerce
// tools do not exist (they are absent from tools/list, not "forbidden").
//
// get_offers is deliberately NOT on the v1 surface: cross-merchant offers concentrate reseller-sourced
// listings, which the app-directory sourcing policy excludes (docs/openai_apps_v1_plan.md §1, §5).

import { createCommerceToolSurface, UnknownToolError, commerceToolParamsKey } from "./commerceToolSurface.js";
import { projectPublicReadResult, MAX_SEARCH_RESULTS } from "./publicReadProjection.js";
import {
  filterFirstPartyRows,
  isResellerRow,
  resellerHostSet,
  isFirstPartyOnlyEnabled,
} from "./publicReadSourcing.js";
import { createPublicReadCache } from "./publicReadCache.js";

export const PUBLIC_READ_TOOL_NAMES = Object.freeze([
  "search_catalog",
  "get_product",
  "get_intel",
  "get_alternatives",
]);

// How many rows to ask upstream for on search, regardless of the caller's page_size, so the post-hoc filters
// have something to backfill from. The projector's own hard ceiling — never more than the public tier could
// already return, and the projector slices back to the caller's page_size.
const PUBLIC_READ_SEARCH_OVERFETCH = MAX_SEARCH_RESULTS;

// Ceiling on rows the chain filter may probe per search (see the truncation note at the call site). Twice the
// over-fetch size, so it is a safety valve rather than a limit reached in normal operation.
const PUBLIC_READ_CHAIN_FILTER_MAX_EXAMINED = MAX_SEARCH_RESULTS * 2;

// Absent / 1 / anything non-numeric all mean "first page" — the only page where inflating page_size does not
// move the caller's window. Kept deliberately strict: a page we cannot read as 1 is treated as a deep page.
function isFirstPage(toolArgs) {
  const page = toolArgs == null ? undefined : toolArgs.page;
  return page === undefined || page === null || page === 1;
}

// QUERY-STRING HYGIENE AT THE TIER BOUNDARY.
//
// Measured on prod 2026-08-20 via this surface: `search_catalog {"query":"makeup remover"}` returned 0
// products while `"makeup remover "` and `"MAKEUP REMOVER"` returned 10 — the same ten. Nothing about the
// shopper's intent differs between those three; the divergence was structural. The result cache below keys
// on the tool arguments, so a trailing space or a capital letter bought a DIFFERENT cache entry, and any
// transient zero pinned to one of them was replayed for the rest of the TTL while its neighbours ran the
// real lane.
//
// Two separate normalizations, deliberately not the same one:
//
//   canonicalizeToolArgs — what is sent UPSTREAM. Trims and collapses runs of whitespace. Leading, trailing
//     and doubled spaces carry no shopper meaning, and the downstream lanes are string-sensitive in places
//     (buildSearchProductsV2Body forwards the query untrimmed), so canonicalizing here is what makes
//     whitespace variants take a byte-identical path. Case is PRESERVED: it reaches lanes this tier does not
//     own, and it is not this boundary's business to decide that "CeraVe" and "cerave" are the same token.
//
//   cacheKeyArgs — what the cache is KEYED on. Additionally lowercases the query, so case variants share one
//     entry instead of racing to populate several. Sharing an entry across case is safe precisely because
//     the measurement above shows the lane answers case-insensitively; the divergence was the cache, not the
//     search.
function canonicalizeQueryText(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function canonicalizeToolArgs(toolArgs) {
  if (!toolArgs || typeof toolArgs !== "object" || typeof toolArgs.query !== "string") return toolArgs;
  const query = canonicalizeQueryText(toolArgs.query);
  return query === toolArgs.query ? toolArgs : { ...toolArgs, query };
}

// Fold query case for the KEY ONLY. This is NOT a claim that the lane is case-insensitive — the 2026-08-20
// measurement says the opposite: 4 of 8 zero-result queries were rescued ONLY by Title Case, which is
// exactly a case-sensitivity defect in the lane. Folding here masks that defect at the boundary so one
// shopper's capitalisation cannot decide another's results. The lane-side repair is the category-browse
// text union in src/services/canonicalCatalogSearch.js; once that is measured on prod this fold becomes
// belt-and-braces rather than the load-bearing fix.
//
// Everything else about the key comes from `commerceToolParamsKey`, which derives it from the SAME
// allowlist the executor runs on — see its comment for why keying on the caller's raw object was wrong.
function cacheKeyFor(toolName, toolArgs) {
  const src = toolArgs && typeof toolArgs === "object" ? toolArgs : {};
  const folded = typeof src.query === "string"
    ? { ...src, query: canonicalizeQueryText(src.query).toLowerCase() }
    : src;
  return commerceToolParamsKey(toolName, folded);
}

// DID THE LANE ACTUALLY ANSWER?
//
// WHAT THIS CAN AND CANNOT SEE — read before extending. The live capture in
// test/fixtures/live_search_raw.json is the only ground truth we have for this envelope, and its top-level
// keys are {status, success, products, total, page, page_size, reply, metadata, ...}: `status:"success"`,
// `success:true`, and NO `ok` and NO `error` key at all. So:
//
//   * `status` and `success` are the markers this lane really uses; they are checked first and are what
//     actually fires in production.
//   * `ok` / `error` are kept as defensive arms for the other doors that share this executor, which do use
//     them. `error` is checked for TRUTHINESS, not for presence: `error:""` / `error:false` / `error:{}` are
//     not degradation, and treating them as such silently switched caching off for a whole tool.
//
//   * KNOWN GAP, deliberately not papered over: a recall leg that times out INSIDE a `success:true` envelope
//     is invisible here — the lane reports that shape as an ordinary empty result, and its own degradation
//     marker (`canonical_error`) is nested per-lane under metadata.route_debug.<lane>, too fragile to key
//     on from this tier. Such an empty is therefore still labelled `no_match`. The short empty-page TTL
//     above bounds the damage to ~45s rather than an hour, but the NOTE will still read as a clean
//     negative. Closing this properly needs a top-level degradation marker on the search envelope; until
//     one exists, do not invent a deeper heuristic here — an unvalidated guess about metadata shape is how
//     a confident-sounding wrong answer gets built a second time.
function isDegradedUpstream(raw) {
  if (!raw || typeof raw !== "object") return false;
  if (typeof raw.status === "string" && !["success", "ok"].includes(raw.status.trim().toLowerCase())) return true;
  if (raw.success === false) return true;
  if (raw.ok === false) return true;
  if (raw.error) return true;
  return false;
}

// HOW LONG AN ANSWER MAY BE PINNED — three tiers, not two.
//
// The cache originally had no store predicate at all, so a zero-product page was kept 10 minutes fresh and
// served stale for up to 60. This tier's own post-hoc filters (first-party sourcing, chain-resolvability)
// can empty a page the upstream filled, and a degraded-but-HTTP-200 envelope empties it without the catalog
// having been consulted. Every one of those rendered as "No products matched this search." — a confident
// factual claim an agent relays to the shopper.
//
// The first fix simply refused to store empties. Review measured the cost of that: with 27-33% of live
// queries currently returning nothing, it removes caching from roughly a third of traffic and hands an
// anonymous caller a free recompute of an 8-15s lane on every request, bounded only by a 60 rpm/IP,
// process-local token bucket. Refusal is the right answer for an answer that is WRONG; it is the wrong
// answer for one that is merely EXPENSIVE TO BE WRONG ABOUT. So:
//
//   degraded          -> never stored. The lane did not answer; there is nothing to keep.
//   empty search page -> stored on a SHORT clock (PUBLIC_READ_EMPTY_TTL_MS, default 45s) with NO stale
//                        window. A false negative now decays in under a minute instead of an hour, while a
//                        flood of identical zero-result queries still collapses onto one lane run. The
//                        stale window is deliberately zero: serving a STALE empty is precisely the
//                        confident-false-negative behaviour this whole change exists to end.
//   everything else   -> the normal clock, exactly as before.
function publicReadCachePolicy(computed, { ttlMs, staleMs, emptyTtlMs }) {
  if (!computed || typeof computed !== "object" || computed.cacheable !== true) return null;
  if (computed.emptySearchPage) return { ttlMs: emptyTtlMs, staleMs: emptyTtlMs };
  return { ttlMs, staleMs };
}

// Public PDP base for citable URLs, overridable via env so a domain move needs no code change.
const PUBLIC_PDP_BASE =
  (typeof process !== "undefined" && process.env && process.env.PUBLIC_READ_PDP_BASE) ||
  "https://agent.pivota.cc";

// De-marketed, plain-language descriptions for the public app surface (docs/openai_apps_v1_plan.md §4).
// The commerce descriptions carry attribution/marketing tone ("why it stands out", "per Pivota Insights")
// and, for search, a broad-trigger phrasing the review bar prohibits. The public surface presents accurate,
// narrow descriptions instead; the only attribution that survives is a factual "cite the citation URLs".
const PUBLIC_DESCRIPTIONS = Object.freeze({
  search_catalog:
    "Search Pivota's normalized catalog of beauty and skincare products by query, category, or price " +
    "range. Returns product identity, price, availability, key active ingredients, and a canonical Pivota " +
    "URL for each result. Read-only.",
  get_product:
    "Get detail for one product by its Pivota product_id (the id returned by search_catalog): " +
    "description, ingredient list, images, price, availability, and a canonical Pivota URL. Pass " +
    "include:['decision'] to also attach an evidence-graded decision summary when reviewed intelligence " +
    "exists. Read-only.",
  get_intel:
    "Get Pivota's reviewed intelligence for a product: a plain-language summary, who it suits, and " +
    "evidence-graded claims, each with citation URLs (e.g. PubMed). Cite the provided citation URLs when " +
    "repeating these claims. Returns empty when no reviewed intelligence exists rather than guessing. " +
    "Read-only.",
  get_alternatives:
    "Find reviewed alternatives or related products for a given product, with price comparison, tradeoffs, " +
    "and cited evidence. Cheaper look-alikes ('dupes') are returned only when explicitly requested. " +
    "Read-only.",
});

// Apply the public presentation to a read tool: the de-marketed description, and — for get_product only —
// relax the schema so it resolves by the single public sig id alone (the backend product cache matches by
// product_id when merchant_id is absent; routes/agent_shop_gateway.py _load_product_by_id). Annotations are
// inherited unchanged from the commerce definition (readOnlyHint:true, openWorldHint:false on all four).
function publicPresentation(tool) {
  const next = { ...tool };
  if (PUBLIC_DESCRIPTIONS[tool.name]) next.description = PUBLIC_DESCRIPTIONS[tool.name];
  if (tool.name === "get_product" && tool.inputSchema) {
    next.inputSchema = { ...tool.inputSchema, required: ["product_id"] };
  }
  return next;
}

/**
 * Build the public read surface over an already-composed canonical executor (the SAME shared executor the
 * commerce /mcp door uses — one kernel, never a second).
 * @param {{ execute: (opId:string, params:object, ctx:object)=>Promise<any> }} executor
 * @param {{ log?: object }} [opts]
 * @returns {{ tools: Array<{name,description,inputSchema}>, callTool: Function, isPublicReadTool: Function }}
 */
export function createPublicReadToolSurface(executor, { log, filterChainResolvableRows } = {}) {
  // cache:false — this tier caches the PROJECTED result itself (below). Letting the commerce surface cache
  // underneath as well would put this tier's own documented kill switch (PUBLIC_READ_CACHE_ENABLED=0)
  // behind a second, differently-named one, stack two staleness windows, and hold the fat unprojected
  // payload in memory for no extra hit rate.
  const commerce = createCommerceToolSurface(executor, { log, cache: false });
  const tools = commerce.tools
    .filter((tool) => PUBLIC_READ_TOOL_NAMES.includes(tool.name))
    .map((tool) => publicPresentation({ ...tool }));
  if (tools.length !== PUBLIC_READ_TOOL_NAMES.length) {
    // Fail loud at construction: a missing read tool means the canonical contract changed under us and the
    // public app would silently lose capability.
    throw new Error("public read surface: expected read tools missing from the commerce surface");
  }

  const logger = log && typeof log.info === "function" ? log : null;
  const extraHostsCsv =
    (typeof process !== "undefined" && process.env && process.env.PUBLIC_READ_RESELLER_HOSTS) || "";

  // Projected-result cache (TTL + stale-while-revalidate): the mainline multi-merchant search costs ~8–15s
  // per cold query (sequential recall legs — a search-perf workstream of its own); the public tier serves
  // deterministic, slowly-changing catalog reads, so cached/popular queries answer in <100ms while cold
  // queries keep the honest full cost. Caches ONLY successful projected values (≤ ~25KB each). Disable via
  // PUBLIC_READ_CACHE_ENABLED=0; tune PUBLIC_READ_CACHE_TTL_MS / PUBLIC_READ_CACHE_STALE_MS /
  // PUBLIC_READ_CACHE_MAX.
  const env = (typeof process !== "undefined" && process.env) || {};
  const cacheEnabled = !["0", "false", "off", "no"].includes(String(env.PUBLIC_READ_CACHE_ENABLED ?? "").trim().toLowerCase() || "on");
  const cacheTtlMs = Number(env.PUBLIC_READ_CACHE_TTL_MS) > 0 ? Number(env.PUBLIC_READ_CACHE_TTL_MS) : 10 * 60 * 1000;
  const cacheStaleMs = Number(env.PUBLIC_READ_CACHE_STALE_MS) > 0 ? Number(env.PUBLIC_READ_CACHE_STALE_MS) : 60 * 60 * 1000;
  // Short clock for empty search pages. Long enough to collapse a burst onto one lane run, short enough
  // that a false negative cannot outlive the shopper's session.
  const emptyTtlMs = Number(env.PUBLIC_READ_EMPTY_TTL_MS) > 0 ? Number(env.PUBLIC_READ_EMPTY_TTL_MS) : 45 * 1000;
  const cache = cacheEnabled
    ? createPublicReadCache({
        ttlMs: cacheTtlMs,
        staleMs: cacheStaleMs,
        maxEntries: Number(env.PUBLIC_READ_CACHE_MAX) > 0 ? Number(env.PUBLIC_READ_CACHE_MAX) : 300,
        cachePolicy: (computed) => publicReadCachePolicy(computed, { ttlMs: cacheTtlMs, staleMs: cacheStaleMs, emptyTtlMs }),
        onRevalidateError: (err, key) => {
          if (logger) logger.warn({ err: err?.message || String(err), key }, "public_read cache revalidation failed (stale kept)");
        },
      })
    : null;

  async function callTool(toolName, toolArgs = {}) {
    if (!PUBLIC_READ_TOOL_NAMES.includes(toolName)) {
      throw new UnknownToolError(toolName);
    }
    const args = canonicalizeToolArgs(toolArgs);
    if (!cache) return (await computeTool(toolName, args)).value;
    return (await cache.getOrCompute(cacheKeyFor(toolName, args), () => computeTool(toolName, args))).value;
  }

  async function computeTool(toolName, toolArgs) {
    // Empty verified-session context: read ops are requiresUserRef:false and run anonymously; identity
    // fields in toolArgs are already allowlist-stripped by the commerce surface.
    //
    // OVER-FETCH for search: both post-hoc filters below (sourcing, chain-resolvability) drop rows AFTER the
    // upstream has already trimmed to the requested page size, so filtering alone would shrink the page
    // instead of backfilling it — on prod, "serum" holds 9 dead rows in its top 10 but 11 resolvable ones in
    // its top 20. Asking upstream for the projector's hard ceiling and letting the projector slice back down
    // to the caller's page_size turns those drops into backfill. Bounded by MAX_SEARCH_RESULTS, so this can
    // never ask for more than the public tier was already allowed to return.
    //
    // FIRST PAGE ONLY. `page` is expressed in units of `page_size`, so inflating page_size while leaving
    // `page` alone RELOCATES the caller's window — page 2 of size 10 (rows 11-20) would fetch page 2 of size
    // 20 (rows 21-40) and silently skip ten products. On deeper pages we pass the caller's args through
    // untouched: the window stays correct and the filter may return a short page, which is honest — those
    // rows were unfetchable anyway.
    const upstreamArgs =
      toolName === "search_catalog" && isFirstPage(toolArgs)
        ? { ...(toolArgs ?? {}), page_size: PUBLIC_READ_SEARCH_OVERFETCH }
        : toolArgs;
    let raw = await commerce.callTool(toolName, upstreamArgs, {});

    // Accounting for the empty-page note (see EMPTY_SEARCH_NOTES in publicReadProjection.js). Captured
    // BEFORE this tier's own filters run, because "the upstream matched rows and we removed them all" and
    // "the upstream matched nothing" are different facts and only the second one licenses the sentence
    // "No products matched this search."
    const upstreamMatchedCount =
      toolName === "search_catalog" && raw && Array.isArray(raw.products) ? raw.products.length : 0;
    const upstreamDegraded = isDegradedUpstream(raw);

    // First-party / brand-official sourcing filter (docs/openai_apps_v1_plan.md §5): drop reseller-sourced
    // rows BEFORE projection (the projector strips the destination host the filter needs). ON by default
    // within the public tier; PUBLIC_READ_FIRST_PARTY_ONLY=0 disables. Runs on the raw list-bearing shape.
    if (isFirstPartyOnlyEnabled()) {
      if (toolName === "search_catalog" && raw && Array.isArray(raw.products)) {
        const { kept, droppedCount } = filterFirstPartyRows(raw.products, { extraHostsCsv });
        if (droppedCount > 0) {
          // No silent caps: record what the sourcing policy removed (§5).
          if (logger) logger.info({ tool: toolName, dropped_reseller_rows: droppedCount, kept: kept.length }, "public_read sourcing filter");
          raw = { ...raw, products: kept };
        }
      } else if (toolName === "get_product") {
        // A directly-requested reseller product is not surfaced either (consistent with search).
        const detail = raw && typeof raw === "object" && raw.product && typeof raw.product === "object" ? raw.product : raw;
        if (isResellerRow(detail, resellerHostSet(extraHostsCsv))) {
          if (logger) logger.info({ tool: toolName }, "public_read sourcing filter: reseller product withheld");
          // A withheld reseller product is a deterministic policy verdict, not a lane failure: cacheable.
          return { value: { note: "Product not found." }, cacheable: true };
        }
      }
    }

    // The chain contract: never advertise a product_id that get_product cannot resolve, and never mint a
    // pivota_url that renders a shell. Runs on the raw rows (the projector strips the identity the probe
    // needs) and BEFORE the slice, so survivors backfill the page. Fail-open lives in the injected filter.
    if (toolName === "search_catalog" && typeof filterChainResolvableRows === "function"
        && raw && Array.isArray(raw.products)) {
      // Hard cap on how many rows we probe. The recall pipeline carries a wide candidate pool and only trims
      // to the requested page_size when FPM_ENFORCE_REQUESTED_PAGE_SIZE is on — flip that off and an unauth
      // search would otherwise fan out one resolver probe per pooled row. Rows past the cap are TRUNCATED,
      // never passed through: an unexamined row must never reach the page, or the contract leaks right back
      // in. The cap sits well above the projector's own ceiling, so it does not bind in normal operation.
      const examined = raw.products.slice(0, PUBLIC_READ_CHAIN_FILTER_MAX_EXAMINED);
      const truncated = raw.products.length - examined.length;
      if (truncated > 0 && logger) {
        logger.info({ tool: toolName, truncated_unexamined_rows: truncated }, "public_read chain filter cap");
      }
      const { kept, droppedCount: dropped } = await filterChainResolvableRows(examined);
      const droppedCount = dropped + truncated;
      if (droppedCount > 0) {
        // No silent caps: an id dropped here is a catalog-coverage gap, not a search-quality choice.
        if (logger) logger.info({ tool: toolName, dropped_unresolvable_rows: droppedCount, kept: kept.length }, "public_read chain filter");
        raw = { ...raw, products: kept };
      }
    }

    // Slim the verbose internal result to the public allowlisted shape (docs/openai_apps_v1_plan.md §3):
    // strips diagnostics/telemetry/internal ids/timestamps, caps size. The search limit is threaded so the
    // projector honors the requested page size even though the upstream ignores it.
    const limit =
      toolName === "search_catalog" && toolArgs && typeof toolArgs.page_size === "number"
        ? toolArgs.page_size
        : undefined;
    // Degradation outranks filtering: if the lane never answered, nothing was learned about the catalog and
    // no filter verdict is meaningful. Otherwise, rows that arrived and were removed here are a coverage
    // limit of THIS tier, which the note must say rather than deny the products exist.
    const emptyReason = upstreamDegraded
      ? "upstream_degraded"
      : upstreamMatchedCount > 0
        ? "filtered_out"
        : "no_match";
    const value = projectPublicReadResult(toolName, raw, { base: PUBLIC_PDP_BASE, limit, emptyReason });
    const emptySearchPage =
      toolName === "search_catalog" && Array.isArray(value.products) && value.products.length === 0;
    return { value, cacheable: !upstreamDegraded, emptySearchPage };
  }

  function isPublicReadTool(name) {
    return PUBLIC_READ_TOOL_NAMES.includes(name);
  }

  return { tools, callTool, isPublicReadTool };
}

// ---- MCP tool-result formatting (structuredContent + human summary) ---------------------------------------
// docs/openai_apps_v1_plan.md §6 (v1): return the slim projected object as `structuredContent` (what the
// model/app consumes) ALONGSIDE a short human-readable `content` text block. No custom widget / resources
// in v1 — that's the fast-follow. The projected value is already slim + leak-free (PR-2), so it is safe to
// surface verbatim as structuredContent.

function pluralize(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// Build a concise, honest human summary from the already-projected value (never re-derives from raw).
function summarizePublicReadValue(value, toolName) {
  const v = value && typeof value === "object" ? value : {};
  switch (toolName) {
    case "search_catalog": {
      const products = Array.isArray(v.products) ? v.products : [];
      if (products.length === 0) return v.note || "No products matched this search.";
      const names = products
        .slice(0, 3)
        .map((p) => [p.brand, p.title].filter(Boolean).join(" ").trim())
        .filter(Boolean);
      const lead = `Found ${pluralize(products.length, "product", "products")}`;
      const tail = typeof v.total === "number" && v.total > products.length ? ` of ${v.total}` : "";
      return names.length ? `${lead}${tail}: ${names.join("; ")}.` : `${lead}${tail}.`;
    }
    case "get_product": {
      if (v.note && !v.product_id) return v.note;
      const name = [v.brand, v.title].filter(Boolean).join(" ").trim() || "Product";
      const price = v.price && typeof v.price.amount === "number"
        ? ` — ${v.price.amount}${v.price.currency ? " " + v.price.currency : ""}`
        : "";
      const intel = v.decision ? " (reviewed intelligence available)" : "";
      return `${name}${price}${intel}.`;
    }
    case "get_intel": {
      if (!v.intel) return v.note || "No reviewed intelligence for this product yet.";
      const grade = v.intel.grade ? `evidence grade ${v.intel.grade}` : "reviewed intelligence";
      const claims = Array.isArray(v.intel.claims) ? v.intel.claims.length : 0;
      return claims
        ? `Pivota ${grade} with ${pluralize(claims, "cited claim", "cited claims")}.`
        : `Pivota ${grade}.`;
    }
    case "get_alternatives": {
      const alts = Array.isArray(v.alternatives) ? v.alternatives : [];
      if (alts.length === 0) return v.note || "No reviewed alternatives for this product yet.";
      return `Found ${pluralize(alts.length, "alternative", "alternatives")}.`;
    }
    default:
      return "";
  }
}

/**
 * Format a public read tool's projected value as an MCP tool result: the projected object as
 * `structuredContent` for the app/model, plus a short human-readable text `content` block.
 */
export function formatPublicReadToolResult(value, toolName) {
  const summary = summarizePublicReadValue(value, toolName);
  return {
    content: [{ type: "text", text: summary || JSON.stringify(value) }],
    structuredContent: value,
  };
}
