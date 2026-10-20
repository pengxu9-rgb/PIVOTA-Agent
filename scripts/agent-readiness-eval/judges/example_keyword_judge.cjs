'use strict';

// TEMPLATE for --judge-module. Deterministic and offline: it scores a product 1 when its title/category share
// a word with the query, else 0. Replace the body with a call to whatever model you use; the input is exactly
// what lib/judge.cjs judgePayload() builds — { query, lang, market, products: [{ title, brand, category,
// actives, price }] } — and nothing else may be sent to a model.
//
//   node scripts/agent-readiness-eval/run.cjs ... --judge-module scripts/agent-readiness-eval/judges/example_keyword_judge.cjs

async function judge({ query, products }) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  return {
    scores: products.map((p) => {
      const hay = `${p.title} ${p.category}`.toLowerCase();
      return words.some((w) => hay.includes(w)) ? 1 : 0;
    }),
  };
}

module.exports = { judge };
