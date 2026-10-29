'use strict';

// OPTIONAL LLM-judge pass. Off by default; enabled only with --judge-module <path>.
//
// The module is the operator's: it exports `async judge({ query, lang, market, products }) -> { scores }`,
// where `scores[i]` is a relevance number in [0,1] for products[i] (or null when it cannot judge). It may call
// any model it likes — the harness never does.
//
// DATA BOUNDARY: the judge receives the query text and a fixed allowlist of returned product fields, built
// here and nowhere else. No ids, no links, no merchant identifiers, no prices beyond the amount/currency pair,
// no headers, no credentials, no raw response. A judge that needs more must change this allowlist in review.

const JUDGE_PRODUCT_FIELDS = Object.freeze(['title', 'brand', 'category', 'actives', 'price']);

function judgePayload(query, products) {
  return {
    query: String(query.text || ''),
    lang: query.lang || null,
    market: query.market || null,
    products: (products || []).map((p) => ({
      title: String(p.title || '').slice(0, 200),
      brand: String(p.brand || '').slice(0, 120),
      category: String(p.category || '').slice(0, 120),
      actives: (p.actives || []).slice(0, 5).map((a) => String(a).slice(0, 60)),
      price: p.price && p.price.amount > 0 && p.price.currencyValid ? { amount: p.price.amount, currency: p.price.currency } : null,
    })),
  };
}

function loadJudge(modulePath) {
  if (!modulePath) return null;
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const mod = require(require('node:path').resolve(modulePath));
  const fn = typeof mod === 'function' ? mod : mod && typeof mod.judge === 'function' ? mod.judge : null;
  if (!fn) throw new Error(`judge module ${modulePath} must export judge()`);
  return fn;
}

/** Run the judge on one page; never throws (a judge failure is recorded, not fatal). */
async function runJudge(judgeFn, query, products, { topK = 5, passScore = 0.5 } = {}) {
  if (!judgeFn) return null;
  const top = (products || []).slice(0, topK);
  if (top.length === 0) return null;
  try {
    const out = await judgeFn(judgePayload(query, top));
    const scores = Array.isArray(out && out.scores) ? out.scores.slice(0, top.length) : [];
    const valid = scores.filter((s) => typeof s === 'number' && s >= 0 && s <= 1);
    if (valid.length === 0) return { error: 'judge returned no scores' };
    const pass = valid.filter((s) => s >= passScore).length;
    return { judged: valid.length, precision: pass / valid.length, mean: valid.reduce((a, b) => a + b, 0) / valid.length };
  } catch (err) {
    return { error: String((err && err.message) || err).slice(0, 200) };
  }
}

module.exports = { JUDGE_PRODUCT_FIELDS, judgePayload, loadJudge, runJudge };
