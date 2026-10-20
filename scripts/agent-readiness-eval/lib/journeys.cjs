'use strict';

// Partner journeys: what an integrating agent platform actually does with the API.
//
//   handshake    initialize -> notifications/initialized -> tools/list (and read the schemas, as a client must)
//   discovery    search_catalog for every query in the set
//   follow       for the top results: get_product (the PDP), get_offers, get_alternatives
//   recommend    recommend_products for need-shaped prompts (makeup archetypes)
//   consistency  the same query again -> are the results stable?
//
// THE HARNESS ONLY CALLS READ-ONLY TOOLS. A tool is callable only when tools/list advertises it AND its
// annotations say readOnlyHint:true. Checkout/order tools are never called: the server offers no dry-run /
// never-complete mode for them, so they are listed as skipped with that reason. Links in responses are
// validated syntactically and NEVER fetched (following a /r link writes a click row).

const { toolPayload, readSearch, readProduct, readOffers, readAlternatives, readRecommendations, currencyForMarket } = require('./responses.cjs');
const scorers = require('./scorers.cjs');
const { runJudge } = require('./judge.cjs');
const { HARD_CAPS } = require('./safety.cjs');

const FOLLOW_TOOLS = ['get_product', 'get_offers', 'get_alternatives'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/**
 * Build tool arguments the way a schema-reading client does: keep only properties the tool's inputSchema
 * declares (the gateway refuses undeclared ones), and report what was dropped and which required ones are
 * missing.
 */
function argsForSchema(tool, desired) {
  const schema = tool && tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
  const args = {};
  const dropped = [];
  for (const [k, v] of Object.entries(desired || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (props && !Object.prototype.hasOwnProperty.call(props, k)) {
      dropped.push(k);
      continue;
    }
    args[k] = v;
  }
  const missingRequired = (Array.isArray(schema.required) ? schema.required : []).filter((k) => !(k in args));
  return { args, dropped, missingRequired };
}

/** Which advertised tools the harness may call, and which it refuses to (with the reason). */
function classifyTools(tools) {
  const callable = new Map();
  const skipped = [];
  for (const t of tools || []) {
    if (!t || typeof t.name !== 'string') continue;
    const ro = t.annotations && t.annotations.readOnlyHint === true;
    if (ro) callable.set(t.name, t);
    else {
      skipped.push({
        tool: t.name,
        reason: 'not read-only (readOnlyHint != true); the server offers no dry-run / never-complete mode, so the harness never calls it',
      });
    }
  }
  return { callable, skipped };
}

function compactProduct(p) {
  return {
    id: p.id,
    merchant_id: p.merchant_id,
    title: p.title.slice(0, 160),
    brand: p.brand.slice(0, 80),
    category: p.category.slice(0, 120),
    price: p.price,
    availability: p.availability,
    link: p.link,
    actives: p.actives.slice(0, 5),
    variant_count: p.variants.length,
  };
}

function baseCallFields(rec, payload) {
  return {
    method: rec.method,
    tool: rec.tool || null,
    outcome: rec.outcome,
    http_status: rec.http_status,
    latency_ms: rec.latency_ms,
    ttfb_ms: rec.ttfb_ms,
    body_bytes: rec.body_bytes || null,
    error: rec.error,
    tool_error: Boolean(payload && payload.isError),
    tool_error_code: payload && payload.isError ? payload.errorCode : null,
    tool_error_retriable: payload && payload.isError ? payload.retriable : null,
  };
}

/**
 * Run the configured journeys.
 * @param {{ config, client, querySet, judgeFn?, killSwitch, log?, now? }} deps
 */
async function runJourneys({ config, client, querySet, judgeFn = null, killSwitch, log = () => {} }) {
  const startedAt = new Date().toISOString();
  const rng = mulberry32(config.seed);
  const calls = [];
  const out = {
    started_at: startedAt,
    finished_at: null,
    aborted: null,
    handshake: null,
    tools: null,
    skipped_tools: [],
    discovery: [],
    follow: [],
    recommend: [],
    consistency: [],
    calls,
  };
  let budget = HARD_CAPS.maxDiscoveryCalls;
  let toolsByName = new Map();

  const call = async (toolName, desired, meta) => {
    if (client.halted) {
      out.aborted = out.aborted || client.halted;
      return null;
    }
    const reason = killSwitch && killSwitch.check();
    if (reason) {
      out.aborted = out.aborted || reason;
      return null;
    }
    if (budget <= 0) {
      out.aborted = out.aborted || `call budget exhausted (${HARD_CAPS.maxDiscoveryCalls})`;
      return null;
    }
    const tool = toolsByName.get(toolName);
    const { args, dropped, missingRequired } = argsForSchema(tool, desired);
    if (missingRequired.length) {
      const rec = { phase: meta.phase, tool: toolName, outcome: 'skipped_missing_required', missing_required: missingRequired, ...meta };
      calls.push(rec);
      return { rec, payload: null, args, dropped };
    }
    budget -= 1;
    const raw = await client.callTool(toolName, args);
    const payload = raw.outcome === 'ok' ? toolPayload(raw) : null;
    const rec = { ...meta, ...baseCallFields(raw, payload), dropped_args: dropped.length ? dropped : undefined };
    calls.push(rec);
    return { rec, payload, args, dropped };
  };

  // ---- handshake --------------------------------------------------------------------------------------
  const init = await client.initialize();
  out.handshake = {
    outcome: init.outcome,
    http_status: init.http_status,
    latency_ms: init.latency_ms,
    error: init.error,
    protocol_version: client.negotiatedProtocolVersion,
    server_info: client.serverInfo,
    session_id_issued: Boolean(client.sessionId),
    initialized_notification: init.initialized_notification || null,
  };
  calls.push({ phase: 'handshake', ...baseCallFields(init, null) });
  if (init.outcome !== 'ok') {
    out.aborted = `initialize failed: ${init.outcome}${init.error ? ` (${init.error})` : ''}`;
    out.finished_at = new Date().toISOString();
    return out;
  }
  if (client.halted) {
    out.aborted = client.halted;
    out.finished_at = new Date().toISOString();
    return out;
  }
  const listed = await client.listTools();
  calls.push({ phase: 'handshake', ...baseCallFields(listed, null) });
  if (client.halted) {
    out.aborted = client.halted;
    out.finished_at = new Date().toISOString();
    return out;
  }
  const tools = listed.outcome === 'ok' && listed.rpc && listed.rpc.result && Array.isArray(listed.rpc.result.tools) ? listed.rpc.result.tools : [];
  out.tools = tools.map((t) => ({
    name: t.name,
    read_only: Boolean(t.annotations && t.annotations.readOnlyHint === true),
    required: (t.inputSchema && t.inputSchema.required) || [],
    properties: Object.keys((t.inputSchema && t.inputSchema.properties) || {}),
  }));
  const { callable, skipped } = classifyTools(tools);
  toolsByName = callable;
  out.skipped_tools = skipped;
  if (!callable.has('search_catalog')) {
    out.aborted = 'search_catalog is not advertised as a read-only tool; nothing to evaluate';
    out.finished_at = new Date().toISOString();
    return out;
  }
  for (const name of [...FOLLOW_TOOLS, 'recommend_products']) {
    if (!callable.has(name) && !skipped.some((s) => s.tool === name)) {
      out.skipped_tools.push({ tool: name, reason: 'not advertised on this tier' });
    }
  }

  // ---- discovery --------------------------------------------------------------------------------------
  const queries = selectQueries(querySet.queries, config);
  const journeys = new Set(config.journeys);
  const searchArgs = (q) => ({ query: q.text, market: q.market || undefined, page_size: config.pageSize, ...(q.args || {}) });

  await runPool(queries, config.concurrency, config.pacingMs, async (q) => {
    const meta = { phase: 'discovery', query_id: q.id, class: q.class, lang: q.lang, market: q.market };
    const res = await call('search_catalog', searchArgs(q), meta);
    if (!res) return;
    const entry = { query_id: q.id, class: q.class, lang: q.lang, market: q.market, text: q.text, outcome: res.rec.outcome, tool_error: res.rec.tool_error };
    if (res.payload && !res.payload.isError) {
      const s = readSearch(res.payload);
      res.rec.failed_with_hits = s.failed_with_hits;
      res.rec.result_count = s.products.length;
      entry.result_count = s.products.length;
      entry.total = s.total;
      entry.degraded = s.degraded;
      entry.failed_with_hits = s.failed_with_hits;
      entry.empty_class = s.empty_class;
      entry.products = s.products.slice(0, config.pageSize).map(compactProduct);
      entry._products = s.products; // full normalized rows for follow-through; stripped before writing
      const negative = q.expect && q.expect.negative;
      if (negative) {
        entry.negative = scorers.scoreNegative(negative, s.products, q.expect);
      } else {
        entry.relevance = scorers.scoreRelevance(s.products, q.expect, {
          topK: config.relevanceTopK,
          passThreshold: config.relevanceQueryPassThreshold,
        });
        if (judgeFn) entry.judge = await runJudge(judgeFn, q, s.products, { topK: config.relevanceTopK });
      }
      entry.rows = scorers.scoreRows(s.products, { market: q.market });
      entry.duplicates = scorers.findDuplicates(s.products).length;
      if (q.expect && q.expect.shade) {
        entry.shade = s.products.slice(0, config.relevanceTopK).map((p) => scorers.shadePresence(p));
      }
    } else if (res.payload && res.payload.isError) {
      entry.tool_error_code = res.payload.errorCode;
      if (q.expect && q.expect.negative) entry.negative = scorers.scoreNegative(q.expect.negative, [], q.expect, { toolError: true });
    }
    out.discovery.push(entry);
  });
  log(`discovery: ${out.discovery.length} queries`);

  // ---- follow-through ---------------------------------------------------------------------------------
  if (journeys.has('follow') && !out.aborted) {
    const followable = out.discovery.filter((d) => d.result_count > 0 && !(querySet.byId.get(d.query_id).expect || {}).negative);
    const sampled = followable.filter(() => rng() < config.followSample);
    const tasks = [];
    for (const d of sampled) {
      for (const p of d._products.slice(0, config.followTop)) tasks.push({ d, p, q: querySet.byId.get(d.query_id) });
    }
    await runPool(tasks, config.concurrency, config.pacingMs, async ({ d, p, q }) => {
      const meta = { phase: 'follow', query_id: d.query_id, class: d.class, lang: d.lang, market: d.market, product_id: p.id };
      const entry = { query_id: d.query_id, class: d.class, lang: d.lang, market: d.market, product_id: p.id };
      const idArgs = { merchant_id: p.merchant_id || undefined, product_id: p.id || undefined, market: d.market || undefined };
      if (toolsByName.has('get_product')) {
        const r = await call('get_product', idArgs, { ...meta, tool_step: 'get_product' });
        if (r && r.payload) {
          if (r.payload.isError) entry.product = { tool_error_code: r.payload.errorCode, resolved: false };
          else {
            const pr = readProduct(r.payload);
            entry.product = {
              resolved: pr.found,
              rows: pr.product ? scorers.scoreRows([pr.product], { market: d.market }) : null,
              shade: q.expect && q.expect.shade ? scorers.shadePresence(pr.product || p) : undefined,
              id_matches: pr.product ? !pr.product.id || pr.product.id === p.id : null,
            };
          }
        } else if (r) entry.product = { resolved: false, outcome: r.rec.outcome };
      }
      if (toolsByName.has('get_offers')) {
        const r = await call('get_offers', { ...idArgs, limit: 5 }, { ...meta, tool_step: 'get_offers' });
        if (r && r.payload && !r.payload.isError) {
          const o = readOffers(r.payload);
          const offerRows = o.offers.map((x) => ({ price: x.price, link: x.link }));
          const rows = scorers.scoreRows(offerRows, { market: d.market });
          const reference = o.best_offer || o.offers[0] || null;
          entry.offers = {
            count: o.offers.length,
            empty_class: o.empty_class,
            has_best_offer: Boolean(o.best_offer),
            stock_flag_missing: o.offers.filter((x) => x.in_stock === null).length,
            in_stock: o.offers.filter((x) => x.in_stock === true).length,
            stale: o.offers.filter((x) => x.price_stale).length,
            market_currency_stated: o.market_currency,
            expected_currency: currencyForMarket(d.market),
            rows,
            price_agreement: reference ? scorers.priceAgreement(p.price, reference.price, config.priceAgreementTolerance) : null,
          };
        } else if (r && r.payload && r.payload.isError) entry.offers = { tool_error_code: r.payload.errorCode };
      }
      if (toolsByName.has('get_alternatives')) {
        const r = await call('get_alternatives', { ...idArgs, limit: 5 }, { ...meta, tool_step: 'get_alternatives' });
        if (r && r.payload && !r.payload.isError) {
          const a = readAlternatives(r.payload);
          entry.alternatives = { count: a.items.length, empty_class: a.empty_class, rows: scorers.scoreRows(a.items, { market: d.market }) };
        } else if (r && r.payload && r.payload.isError) entry.alternatives = { tool_error_code: r.payload.errorCode };
      }
      out.follow.push(entry);
    });
    log(`follow-through: ${out.follow.length} products`);
  }

  // ---- recommend --------------------------------------------------------------------------------------
  if (journeys.has('recommend') && toolsByName.has('recommend_products') && !out.aborted) {
    await runPool(querySet.recommend || [], config.concurrency, config.pacingMs, async (n) => {
      const meta = { phase: 'recommend', query_id: n.id, class: 'recommend', lang: n.language === 'CN' ? 'zh-Hans' : 'en', market: null };
      const r = await call(
        'recommend_products',
        { need: n.need, language: n.language, limit: 5, constraints: n.constraints && Object.keys(n.constraints).length ? n.constraints : undefined },
        meta,
      );
      if (!r) return;
      const entry = { query_id: n.id, need: n.need, outcome: r.rec.outcome, tool_error: r.rec.tool_error };
      if (r.payload && !r.payload.isError) {
        const rec = readRecommendations(r.payload);
        r.rec.result_count = rec.items.length;
        entry.result_count = rec.items.length;
        entry.empty_class = rec.empty_class;
        entry.confidence_basis = rec.confidence_basis;
        entry.relevance = scorers.scoreRelevance(rec.items, n.expect, { topK: config.relevanceTopK, passThreshold: config.relevanceQueryPassThreshold });
        entry.rows = scorers.scoreRows(rec.items, {});
        entry.items = rec.items.slice(0, 5).map(compactProduct);
      } else if (r.payload && r.payload.isError) entry.tool_error_code = r.payload.errorCode;
      out.recommend.push(entry);
    });
  }

  // ---- consistency ------------------------------------------------------------------------------------
  if (journeys.has('consistency') && config.consistencySample > 0 && config.consistencyRepeats > 0 && !out.aborted) {
    const pool = out.discovery.filter((d) => d.result_count > 0);
    const picked = shuffle(pool, rng).slice(0, config.consistencySample);
    await runPool(picked, 1, config.pacingMs, async (d) => {
      const q = querySet.byId.get(d.query_id);
      const lists = [(d._products || []).map((p) => p.id || `${p.brand}|${p.title}`)];
      for (let i = 0; i < config.consistencyRepeats; i += 1) {
        const r = await call('search_catalog', searchArgs(q), { phase: 'consistency', query_id: q.id, class: q.class, lang: q.lang, market: q.market });
        if (!r || !r.payload || r.payload.isError) {
          lists.push([]);
          continue;
        }
        lists.push(readSearch(r.payload).products.map((p) => p.id || `${p.brand}|${p.title}`));
      }
      out.consistency.push({ query_id: d.query_id, ...scorers.scoreConsistency(lists, { topK: config.relevanceTopK }) });
    });
  }

  for (const d of out.discovery) delete d._products;
  out.finished_at = new Date().toISOString();
  return out;
}

function shuffle(xs, rng) {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function selectQueries(all, config) {
  let qs = all.slice();
  if (config.classes) qs = qs.filter((q) => config.classes.includes(q.class));
  if (config.langs) qs = qs.filter((q) => config.langs.includes(q.lang));
  if (config.markets) qs = qs.filter((q) => config.markets.includes(q.market === null ? 'none' : q.market));
  if (config.limit > 0) qs = qs.slice(0, config.limit);
  return qs;
}

/** Bounded worker pool with per-worker pacing between starts. Preserves no order (results carry ids). */
async function runPool(items, concurrency, pacingMs, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
      await sleep(pacingMs);
    }
  });
  await Promise.all(workers);
}

/** Load the query set (plus an optional private overlay) and index it. */
function loadQuerySet(file, overlayFile = null) {
  const fs = require('node:fs');
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  const set = { version: base.version, queries: base.queries.slice(), recommend: (base.recommend || []).slice() };
  if (overlayFile) {
    const extra = JSON.parse(fs.readFileSync(overlayFile, 'utf8'));
    for (const q of extra.queries || []) set.queries.push({ lang: 'en', market: null, args: {}, ...q, overlay: true });
    for (const r of extra.recommend || []) set.recommend.push({ ...r, overlay: true });
    set.version = `${set.version}+overlay`;
  }
  const ids = new Set();
  for (const q of set.queries) {
    if (ids.has(q.id)) throw new Error(`duplicate query id ${q.id}`);
    ids.add(q.id);
  }
  set.byId = new Map(set.queries.map((q) => [q.id, q]));
  return set;
}

/** The plan a dry run prints: what WOULD be called, without calling anything. */
function planCalls(config, querySet) {
  const queries = selectQueries(querySet.queries, config);
  const j = new Set(config.journeys);
  const inCatalog = queries.filter((q) => !(q.expect && q.expect.negative)).length;
  const followMax = j.has('follow') ? Math.round(inCatalog * config.followSample) * config.followTop : 0;
  const count = (k) => queries.reduce((m, q) => ((m[k(q)] = (m[k(q)] || 0) + 1), m), {});
  return {
    queries: queries.length,
    by_class: count((q) => q.class),
    by_lang: count((q) => q.lang),
    by_market: count((q) => (q.market === null ? 'none' : q.market)),
    calls_upper_bound: {
      handshake: 2,
      search_catalog: queries.length + (j.has('consistency') ? Math.min(config.consistencySample, queries.length) * config.consistencyRepeats : 0),
      get_product: followMax,
      get_offers: followMax,
      get_alternatives: followMax,
      recommend_products: j.has('recommend') ? (querySet.recommend || []).length : 0,
    },
  };
}

module.exports = { runJourneys, argsForSchema, classifyTools, selectQueries, loadQuerySet, planCalls, runPool, mulberry32 };
