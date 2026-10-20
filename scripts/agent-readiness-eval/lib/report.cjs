'use strict';

// Metrics, SLO verdicts, and the scorecard (JSON + Markdown + HTML), plus diff against a previous run.

const { latencySummary, availabilitySummary, groupBy, rate, round4 } = require('./stats.cjs');
const { summarizeLoad } = require('./load.cjs');

function sumRows(list) {
  const out = { rows: 0, missing_price: 0, non_positive_price: 0, invalid_currency: 0, currency_market_mismatch: 0, currency_checked: 0, missing_link: 0, link_problems: {} };
  for (const r of list) {
    if (!r) continue;
    for (const k of Object.keys(out)) {
      if (k === 'link_problems') {
        for (const [p, n] of Object.entries(r.link_problems || {})) out.link_problems[p] = (out.link_problems[p] || 0) + n;
      } else out[k] += r[k] || 0;
    }
  }
  out.price_problem_total = out.missing_price + out.non_positive_price + out.invalid_currency;
  return out;
}

function countBy(items, keyFn) {
  const m = {};
  for (const it of items) {
    const k = keyFn(it);
    if (k == null) continue;
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

function searchSlice(entries, calls) {
  const nonNegative = entries.filter((e) => !('negative' in e));
  const answered = nonNegative.filter((e) => typeof e.result_count === 'number');
  const empties = answered.filter((e) => e.result_count === 0);
  const scored = nonNegative.filter((e) => e.relevance);
  const negatives = entries.filter((e) => e.negative);
  return {
    queries: entries.length,
    answered: answered.length,
    zero_result_rate: rate(empties.length, answered.length),
    empty_class: countBy(empties, (e) => e.empty_class || 'unspecified'),
    relevance_pass_rate: rate(scored.filter((e) => e.relevance.query_pass).length, scored.length),
    mean_precision: scored.length ? round4(scored.reduce((a, e) => a + e.relevance.precision, 0) / scored.length) : null,
    unverifiable_rate: scored.length ? round4(scored.reduce((a, e) => a + e.relevance.unverifiable_rate, 0) / scored.length) : null,
    negative_pass_rate: rate(negatives.filter((e) => e.negative.pass).length, negatives.length),
    tool_error_rate: rate(entries.filter((e) => e.tool_error).length, entries.length),
    latency: latencySummary(calls.map((c) => c.latency_ms)),
  };
}

/** Everything the scorecard shows, computed from the raw run result. */
function computeMetrics(run, config) {
  const calls = run.calls.filter((c) => c.phase !== 'handshake' && c.outcome !== 'skipped_missing_required');
  const discoveryCalls = calls.filter((c) => c.phase === 'discovery');
  const d = run.discovery;
  const byTool = {};
  for (const [tool, list] of groupBy(calls, (c) => c.tool)) {
    byTool[tool] = { ...availabilitySummary(list), latency: latencySummary(list.map((c) => c.latency_ms)) };
  }
  const slices = (keyFn) => {
    const out = {};
    const callGroups = groupBy(discoveryCalls, keyFn);
    for (const [k, list] of groupBy(d, keyFn)) out[k] = searchSlice(list, callGroups.get(k) || []);
    return out;
  };

  const nonNegative = d.filter((e) => !('negative' in e));
  const answered = nonNegative.filter((e) => typeof e.result_count === 'number');
  const empties = answered.filter((e) => e.result_count === 0);
  const scored = nonNegative.filter((e) => e.relevance);
  const negatives = d.filter((e) => e.negative);
  const nonEmpty = d.filter((e) => e.result_count > 0);

  const follow = run.follow;
  const prodAttempts = follow.filter((f) => f.product);
  const offers = follow.filter((f) => f.offers && !f.offers.tool_error_code);
  const agreements = offers.map((f) => f.offers.price_agreement).filter((a) => a && a.comparable);
  const alts = follow.filter((f) => f.alternatives && !f.alternatives.tool_error_code);
  const shadeRows = d.filter((e) => Array.isArray(e.shade)).flatMap((e) => e.shade);
  const shadePdp = follow.filter((f) => f.product && f.product.shade).map((f) => f.product.shade);

  const rows = {
    search: sumRows(d.map((e) => e.rows)),
    product: sumRows(prodAttempts.map((f) => f.product.rows)),
    offers: sumRows(offers.map((f) => f.offers.rows)),
    alternatives: sumRows(alts.map((f) => f.alternatives.rows)),
    recommend: sumRows(run.recommend.map((r) => r.rows)),
  };
  // The SLO-bearing totals: what a partner would SHOW a buyer — search rows, the PDP, and offers.
  const gated = sumRows([rows.search, rows.product, rows.offers]);

  const judged = d.filter((e) => e.judge && typeof e.judge.precision === 'number');

  const metrics = {
    run: {
      tier: config.tier,
      target_kind: config.targetKind,
      endpoint_host: safeHost(config.endpoint),
      query_set: run.query_set_version,
      started_at: run.started_at,
      finished_at: run.finished_at,
      aborted: run.aborted,
      handshake: run.handshake,
      skipped_tools: run.skipped_tools,
    },
    availability: availabilitySummary(calls),
    by_tool: byTool,
    search: {
      ...searchSlice(d, discoveryCalls),
      in_catalog_zero_result_rate: rate(empties.length, answered.length),
      failed_with_hits: d.filter((e) => e.failed_with_hits).length,
      degraded: d.filter((e) => e.degraded).length,
      duplicate_query_rate: rate(nonEmpty.filter((e) => e.duplicates > 0).length, nonEmpty.length),
      relevance_failed_checks: mergeCounts(scored.map((e) => e.relevance.failed_checks)),
      shade_presence: countBy(shadeRows, (s) => s),
      judge: judged.length ? { judged_queries: judged.length, mean_precision: round4(judged.reduce((a, e) => a + e.judge.precision, 0) / judged.length) } : null,
    },
    by_class: slices((e) => e.class),
    by_lang: slices((e) => e.lang),
    by_market: slices((e) => e.market),
    follow: {
      products_followed: follow.length,
      chain_resolve_rate: rate(prodAttempts.filter((f) => f.product.resolved).length, prodAttempts.length),
      pdp_id_mismatch: prodAttempts.filter((f) => f.product.id_matches === false).length,
      pdp_shade_presence: countBy(shadePdp, (s) => s),
      offers_nonempty_rate: rate(offers.filter((f) => f.offers.count > 0).length, offers.length),
      offers_best_offer_rate: rate(offers.filter((f) => f.offers.has_best_offer).length, offers.filter((f) => f.offers.count > 0).length),
      offers_stock_flag_missing: offers.reduce((a, f) => a + f.offers.stock_flag_missing, 0),
      offers_empty_class: countBy(offers.filter((f) => f.offers.count === 0), (f) => f.offers.empty_class || 'unspecified'),
      offer_search_price_agreement: rate(agreements.filter((a) => a.agree).length, agreements.length),
      offer_search_price_compared: agreements.length,
      alternatives_nonempty_rate: rate(alts.filter((f) => f.alternatives.count > 0).length, alts.length),
      alternatives_empty_class: countBy(alts.filter((f) => f.alternatives.count === 0), (f) => f.alternatives.empty_class || 'unspecified'),
    },
    recommend: {
      needs: run.recommend.length,
      nonempty_rate: rate(run.recommend.filter((r) => r.result_count > 0).length, run.recommend.filter((r) => typeof r.result_count === 'number').length),
      relevance_pass_rate: rate(run.recommend.filter((r) => r.relevance && r.relevance.query_pass).length, run.recommend.filter((r) => r.relevance).length),
      empty_class: countBy(run.recommend.filter((r) => r.result_count === 0), (r) => r.empty_class || 'unspecified'),
      confidence_basis: countBy(run.recommend, (r) => r.confidence_basis),
    },
    consistency: {
      sampled: run.consistency.length,
      stable_rate: rate(run.consistency.filter((c) => c.stable).length, run.consistency.length),
      same_order_rate: rate(run.consistency.filter((c) => c.same_order).length, run.consistency.length),
    },
    rows,
    rows_gated: gated,
    negative: {
      queries: negatives.length,
      pass_rate: rate(negatives.filter((e) => e.negative.pass).length, negatives.length),
      by_kind: Object.fromEntries([...groupBy(negatives, (e) => e.class)].map(([k, l]) => [k, rate(l.filter((e) => e.negative.pass).length, l.length)])),
    },
    load: run.load ? summarizeLoad(run.load) : null,
  };
  return metrics;
}

function mergeCounts(list) {
  const out = {};
  for (const m of list) for (const [k, v] of Object.entries(m || {})) out[k] = (out[k] || 0) + v;
  return out;
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// SLO table: [key, label, metric getter, comparator]
const SLO_DEFS = [
  ['availability_min', 'Availability (non-429, non-auth calls)', (m) => m.availability.availability, 'min'],
  ['tool_error_rate_max', 'Tool-error rate', (m) => m.availability.tool_error_rate, 'max'],
  ['search_p95_ms_max', 'search_catalog p95 latency (ms)', (m) => m.search.latency.p95, 'max'],
  ['in_catalog_zero_result_rate_max', 'Zero-result rate, in-catalog classes', (m) => m.search.in_catalog_zero_result_rate, 'max'],
  ['relevance_pass_rate_min', 'Relevance pass rate (deterministic rules)', (m) => m.search.relevance_pass_rate, 'min'],
  ['currency_market_mismatch_max', 'Currency != market (rows shown to buyers)', (m) => m.rows_gated.currency_market_mismatch, 'max'],
  ['missing_price_max', 'Missing / non-positive / invalid-currency price', (m) => m.rows_gated.price_problem_total, 'max'],
  ['missing_link_max', 'Missing / malformed link', (m) => m.rows_gated.missing_link, 'max'],
  ['negative_control_pass_rate_min', 'Negative controls handled', (m) => m.negative.pass_rate, 'min'],
  ['duplicate_query_rate_max', 'Pages with duplicate products', (m) => m.search.duplicate_query_rate, 'max'],
  ['consistency_stable_rate_min', 'Repeat-query stability (top-k Jaccard >= 0.8)', (m) => m.consistency.stable_rate, 'min'],
  ['offer_search_price_agreement_min', 'get_offers price agrees with search price', (m) => m.follow.offer_search_price_agreement, 'min'],
  ['chain_resolve_rate_min', 'search id resolves on get_product', (m) => m.follow.chain_resolve_rate, 'min'],
];

function evaluateSlos(metrics, slos) {
  return SLO_DEFS.map(([key, label, get, dir]) => {
    const threshold = slos[key];
    const value = get(metrics);
    let status;
    if (threshold === null || threshold === undefined) status = 'off';
    else if (value === null || value === undefined) status = 'no_data';
    else status = dir === 'min' ? (value >= threshold ? 'pass' : 'fail') : value <= threshold ? 'pass' : 'fail';
    return { key, label, threshold, value, direction: dir, status };
  });
}

// pass ONLY when every SLO that is not switched off was measured and met. A missing measurement is not a pass:
// it is `incomplete` (switch an SLO off explicitly, e.g. the offers SLO on the public tier, to accept that).
function overallVerdict(sloResults, run) {
  if (run.aborted) return 'aborted';
  if (sloResults.some((s) => s.status === 'fail')) return 'fail';
  if (sloResults.some((s) => s.status === 'no_data')) return 'incomplete';
  return 'pass';
}

// ---- diff -------------------------------------------------------------------------------------------------

function diffRuns(prev, cur) {
  const pm = prev.metrics;
  const cm = cur.metrics;
  const headline = SLO_DEFS.map(([key, label, get]) => {
    const a = safeGet(get, pm);
    const b = safeGet(get, cm);
    return { key, label, previous: a, current: b, delta: typeof a === 'number' && typeof b === 'number' ? round4(b - a) : null };
  });
  const prevQ = new Map((prev.discovery || []).map((e) => [e.query_id, e]));
  const changes = { relevance_regressed: [], relevance_improved: [], became_empty: [], became_nonempty: [], became_error: [], recovered: [] };
  for (const e of cur.discovery || []) {
    const p = prevQ.get(e.query_id);
    if (!p) continue;
    if (p.relevance && e.relevance) {
      if (p.relevance.query_pass && !e.relevance.query_pass) changes.relevance_regressed.push(e.query_id);
      if (!p.relevance.query_pass && e.relevance.query_pass) changes.relevance_improved.push(e.query_id);
    }
    if (p.result_count > 0 && e.result_count === 0) changes.became_empty.push(e.query_id);
    if (p.result_count === 0 && e.result_count > 0) changes.became_nonempty.push(e.query_id);
    const pe = p.outcome !== 'ok' || p.tool_error;
    const ce = e.outcome !== 'ok' || e.tool_error;
    if (!pe && ce) changes.became_error.push(e.query_id);
    if (pe && !ce) changes.recovered.push(e.query_id);
  }
  return { previous_started_at: pm.run.started_at, query_set: { previous: pm.run.query_set, current: cm.run.query_set }, headline, changes };
}

function safeGet(fn, m) {
  try {
    return fn(m);
  } catch {
    return null;
  }
}

// ---- rendering --------------------------------------------------------------------------------------------

// kind: 'rate' renders a fraction as a percentage, 'ms' rounds, anything else prints the number as is.
// SLO keys pick their kind from the key name, so a COUNT threshold of 0 or 1 never renders as a percentage.
function kindOfKey(key) {
  if (/_ms_/.test(key)) return 'ms';
  if (/(rate|availability|agreement)/.test(key)) return 'rate';
  return 'count';
}

function fmt(v, kind = 'count') {
  if (v === null || v === undefined) return '—';
  if (typeof v !== 'number') return String(v);
  if (kind === 'ms') return `${Math.round(v)}`;
  if (kind === 'rate') return `${(v * 100).toFixed(1)}%`;
  return String(v);
}

function sliceTable(title, slices) {
  const lines = [`### ${title}`, '', '| slice | queries | zero-result | relevance pass | mean precision | unverifiable | negatives ok | tool err | p50 ms | p95 ms | p99 ms |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const [k, s] of Object.entries(slices).sort()) {
    lines.push(`| ${k} | ${s.queries} | ${fmt(s.zero_result_rate, 'rate')} | ${fmt(s.relevance_pass_rate, 'rate')} | ${fmt(s.mean_precision, 'rate')} | ${fmt(s.unverifiable_rate, 'rate')} | ${fmt(s.negative_pass_rate, 'rate')} | ${fmt(s.tool_error_rate, 'rate')} | ${fmt(s.latency.p50, 'ms')} | ${fmt(s.latency.p95, 'ms')} | ${fmt(s.latency.p99, 'ms')} |`);
  }
  return lines.join('\n');
}

function renderMarkdown(report) {
  const { metrics: m, slos, verdict, diff } = report;
  const L = [];
  L.push(`# Agent API readiness scorecard — ${verdict.toUpperCase()}`);
  L.push('');
  L.push(`- Tier: \`${m.run.tier}\` · target kind: \`${m.run.target_kind}\` · host: \`${m.run.endpoint_host}\` · query set: \`${m.run.query_set}\``);
  L.push(`- Started ${m.run.started_at} · finished ${m.run.finished_at}${m.run.aborted ? ` · **ABORTED: ${m.run.aborted}**` : ''}`);
  if (m.run.handshake) L.push(`- Handshake: ${m.run.handshake.outcome} · protocol ${m.run.handshake.protocol_version || '—'} · server ${m.run.handshake.server_info ? `${m.run.handshake.server_info.name}/${m.run.handshake.server_info.version}` : '—'}`);
  L.push('');
  L.push('## SLOs');
  L.push('');
  L.push('| SLO | threshold | value | status |');
  L.push('|---|---:|---:|---|');
  for (const s of slos) L.push(`| ${s.label} | ${s.direction === 'min' ? '≥' : '≤'} ${fmt(s.threshold, kindOfKey(s.key))} | ${fmt(s.value, kindOfKey(s.key))} | ${s.status.toUpperCase()} |`);
  L.push('');
  L.push('## Availability by tool');
  L.push('');
  L.push('| tool | calls | ok | tool err | failed+hits | 429 | auth | unavailable | availability | p50 ms | p95 ms | p99 ms |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [t, s] of Object.entries(m.by_tool)) {
    L.push(`| ${t} | ${s.calls} | ${s.ok} | ${s.tool_error} | ${s.failed_with_hits} | ${s.rate_limited} | ${s.auth_error} | ${s.unavailable} | ${fmt(s.availability, 'rate')} | ${fmt(s.latency.p50, 'ms')} | ${fmt(s.latency.p95, 'ms')} | ${fmt(s.latency.p99, 'ms')} |`);
  }
  const codes = m.availability.tool_error_codes;
  if (Object.keys(codes).length) L.push('', `Tool error codes: ${Object.entries(codes).map(([k, v]) => `\`${k}\` ×${v}`).join(', ')}`);
  L.push('', `Outcomes: ${Object.entries(m.availability.by_outcome).map(([k, v]) => `${k} ×${v}`).join(', ')}`);
  L.push('');
  L.push('## Search quality');
  L.push('');
  L.push(`- Zero-result (in-catalog classes): ${fmt(m.search.in_catalog_zero_result_rate, 'rate')} — by stated empty class: ${Object.entries(m.search.empty_class).map(([k, v]) => `\`${k}\` ×${v}`).join(', ') || 'none'}`);
  L.push(`- Relevance pass: ${fmt(m.search.relevance_pass_rate, 'rate')} · mean precision@k: ${fmt(m.search.mean_precision, 'rate')} · unverifiable share: ${fmt(m.search.unverifiable_rate, 'rate')}`);
  L.push(`- Failed checks (top-k rows): ${Object.entries(m.search.relevance_failed_checks).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}`);
  L.push(`- "Failed" envelopes that still carried hits: ${m.search.failed_with_hits} · degraded envelopes: ${m.search.degraded}`);
  L.push(`- Pages with duplicates: ${fmt(m.search.duplicate_query_rate, 'rate')}`);
  L.push(`- Shade/variant presence on shade-query rows: ${Object.entries(m.search.shade_presence).map(([k, v]) => `${k} ×${v}`).join(', ') || '—'} · on PDP: ${Object.entries(m.follow.pdp_shade_presence).map(([k, v]) => `${k} ×${v}`).join(', ') || '—'}`);
  L.push(`- Negative controls: ${fmt(m.negative.pass_rate, 'rate')} (${Object.entries(m.negative.by_kind).map(([k, v]) => `${k} ${fmt(v, 'rate')}`).join(', ')})`);
  if (m.search.judge) L.push(`- LLM judge: ${m.search.judge.judged_queries} queries, mean precision ${fmt(m.search.judge.mean_precision, 'rate')}`);
  L.push('');
  L.push('## Row integrity (never fetched; syntax only)');
  L.push('');
  L.push('| source | rows | missing price | ≤0 price | bad currency | currency≠market (of checked) | bad link |');
  L.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const [k, r] of Object.entries(m.rows)) L.push(`| ${k} | ${r.rows} | ${r.missing_price} | ${r.non_positive_price} | ${r.invalid_currency} | ${r.currency_market_mismatch} / ${r.currency_checked} | ${r.missing_link} |`);
  L.push('');
  L.push('## Follow-through');
  L.push('');
  const f = m.follow;
  L.push(`- Products followed: ${f.products_followed} · search→get_product resolves: ${fmt(f.chain_resolve_rate, 'rate')} · PDP id mismatch: ${f.pdp_id_mismatch}`);
  L.push(`- get_offers non-empty: ${fmt(f.offers_nonempty_rate, 'rate')} · best_offer present: ${fmt(f.offers_best_offer_rate, 'rate')} · stock flag missing: ${f.offers_stock_flag_missing} · price agrees with search: ${fmt(f.offer_search_price_agreement, 'rate')} (${f.offer_search_price_compared} compared)`);
  L.push(`- get_offers empty classes: ${Object.entries(f.offers_empty_class).map(([k, v]) => `\`${k}\` ×${v}`).join(', ') || 'none'}`);
  L.push(`- get_alternatives non-empty: ${fmt(f.alternatives_nonempty_rate, 'rate')} · empty classes: ${Object.entries(f.alternatives_empty_class).map(([k, v]) => `\`${k}\` ×${v}`).join(', ') || 'none'}`);
  L.push(`- recommend_products: ${m.recommend.needs} needs · non-empty ${fmt(m.recommend.nonempty_rate, 'rate')} · relevance pass ${fmt(m.recommend.relevance_pass_rate, 'rate')} · empty classes ${Object.entries(m.recommend.empty_class).map(([k, v]) => `\`${k}\` ×${v}`).join(', ') || 'none'}`);
  L.push(`- Consistency: ${m.consistency.sampled} repeated · stable ${fmt(m.consistency.stable_rate, 'rate')} · identical order ${fmt(m.consistency.same_order_rate, 'rate')}`);
  if (m.run.skipped_tools && m.run.skipped_tools.length) {
    L.push('');
    L.push('## Tools not called');
    L.push('');
    for (const s of m.run.skipped_tools) L.push(`- \`${s.tool}\`: ${s.reason}`);
  }
  L.push('');
  L.push(sliceTable('By query class', m.by_class));
  L.push('');
  L.push(sliceTable('By language', m.by_lang));
  L.push('');
  L.push(sliceTable('By market', m.by_market));
  if (m.load) {
    L.push('');
    L.push('## Load');
    L.push('');
    L.push(`- Stopped by: ${m.load.stopped_by} · elapsed ${m.load.elapsed_s}s · sent ${m.load.sent} · client-saturated (dropped) ${m.load.saturated} · p50/p95/p99 ${fmt(m.load.latency.p50, 'ms')}/${fmt(m.load.latency.p95, 'ms')}/${fmt(m.load.latency.p99, 'ms')} ms`);
    L.push('');
    L.push('| caller | calls | ok | 429 | unavailable | tool err | p95 ms |');
    L.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const [k, c] of Object.entries(m.load.per_caller)) L.push(`| ${k} | ${c.calls} | ${c.ok} | ${c.rate_limited} | ${c.unavailable} | ${c.tool_error} | ${fmt(c.latency.p95, 'ms')} |`);
    L.push('');
    L.push('| t (s) | target rps | achieved rps | sent | saturated | unavailable | 429 | p50 ms | p95 ms |');
    L.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const b of m.load.timeline) L.push(`| ${b.t} | ${b.target_rps} | ${b.achieved_rps} | ${b.sent} | ${b.saturated} | ${b.unavailable} | ${b.rate_limited} | ${fmt(b.p50, 'ms')} | ${fmt(b.p95, 'ms')} |`);
  }
  if (diff) {
    L.push('');
    L.push(`## Diff vs run of ${diff.previous_started_at}`);
    L.push('');
    L.push('| metric | previous | current | delta |');
    L.push('|---|---:|---:|---:|');
    for (const h of diff.headline) L.push(`| ${h.label} | ${fmt(h.previous, kindOfKey(h.key))} | ${fmt(h.current, kindOfKey(h.key))} | ${h.delta === null ? '—' : h.delta} |`);
    L.push('');
    for (const [k, ids] of Object.entries(diff.changes)) if (ids.length) L.push(`- ${k.replace(/_/g, ' ')} (${ids.length}): ${ids.slice(0, 40).join(', ')}${ids.length > 40 ? ' …' : ''}`);
  }
  L.push('');
  return L.join('\n');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** A self-contained HTML rendering of the Markdown scorecard (tables + headings + lists; no external assets). */
function renderHtml(markdown, verdict) {
  const lines = markdown.split('\n');
  const html = [];
  let i = 0;
  const inline = (s) => escapeHtml(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.split('|').slice(1, -1).map((c) => c.trim());
      const head = cells(rows[0]);
      html.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
      for (const r of rows.slice(2)) {
        html.push('<tr>' + cells(r).map((c) => `<td class="${/^(PASS|FAIL|NO_DATA|OFF)$/.test(c) ? c.toLowerCase() : ''}">${inline(c)}</td>`).join('') + '</tr>');
      }
      html.push('</tbody></table>');
      continue;
    }
    if (line.startsWith('- ')) {
      html.push('<ul>');
      while (i < lines.length && lines[i].startsWith('- ')) html.push(`<li>${inline(lines[i++].slice(2))}</li>`);
      html.push('</ul>');
      continue;
    }
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (line.trim()) html.push(`<p>${inline(line)}</p>`);
    i += 1;
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent readiness scorecard</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e3e6;--pass:#1f7a3a;--fail:#b3261e;--na:#7a6a1f}
@media (prefers-color-scheme: dark){:root{--bg:#141416;--fg:#ececef;--muted:#a0a0a8;--line:#2c2c31;--pass:#5fd38a;--fail:#ff8a80;--na:#e0c060}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:16px;max-width:1200px}
h1{font-size:22px} h2{font-size:17px;margin-top:28px;border-bottom:1px solid var(--line);padding-bottom:4px} h3{font-size:15px}
table{border-collapse:collapse;margin:8px 0 16px;display:block;overflow-x:auto;max-width:100%}
th,td{border-bottom:1px solid var(--line);padding:4px 10px;text-align:left;white-space:nowrap;font-variant-numeric:tabular-nums}
th{color:var(--muted);font-weight:600} code{font-size:12px}
td.pass{color:var(--pass);font-weight:600} td.fail{color:var(--fail);font-weight:600} td.no_data,td.off{color:var(--na)}
.verdict{display:inline-block;padding:2px 10px;border-radius:4px;border:1px solid currentColor}
</style></head><body>
<p class="verdict">${escapeHtml(verdict.toUpperCase())}</p>
${html.join('\n')}
</body></html>
`;
}

/** Build the full report object (what results.json holds) from a run. */
function buildReport(run, config, previous = null) {
  const metrics = computeMetrics(run, config);
  const slos = evaluateSlos(metrics, config.slos);
  const verdict = overallVerdict(slos, run);
  const report = { schema: 'pivota.agent_readiness_eval/v1', verdict, slos, metrics, discovery: run.discovery, follow: run.follow, recommend: run.recommend, consistency: run.consistency, calls: run.calls };
  if (run.load) report.load_calls = run.load.calls;
  if (previous) report.diff = diffRuns(previous, report);
  return report;
}

module.exports = { computeMetrics, evaluateSlos, overallVerdict, diffRuns, renderMarkdown, renderHtml, buildReport, SLO_DEFS, sumRows };
