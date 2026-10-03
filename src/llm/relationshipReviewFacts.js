'use strict';

// Prompt assistance only, never admission evidence. Each entry is an unchanged
// string already supplied by this exact product. Metadata and identity cannot
// become factual quotes merely by appearing inside an Insights container.
const METADATA_KEY = /score|relation|recommendation|curated|provenance|(?:^|_)pair(?:_|$)|(?:^|_)(?:ref|id|url|status|confidence|coverage|tier|observed_at|review|title|brand|category|tags|price|currency)(?:_|$)/i;
function factualQuoteSources(product) {
  const out = [];
  const seen = new Set();
  const collect = (value, field) => {
    if (typeof value === 'string') {
      if (value.trim().length < 8 || seen.has(value)) return;
      seen.add(value); out.push({ field, text: value });
    } else if (Array.isArray(value)) {
      value.forEach((child, i) => collect(child, `${field}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (!METADATA_KEY.test(key)) collect(child, `${field}.${key}`);
      }
    }
  };
  for (const field of ['description', 'ingredient_text']) {
    if (typeof product?.[field] === 'string') collect(product[field], field);
  }
  if (Array.isArray(product?.ingredient_evidence)) product.ingredient_evidence.forEach((row, i) => {
    if (typeof row?.ingredient_text === 'string') collect(row.ingredient_text, `ingredient_evidence[${i}].ingredient_text`);
  });
  for (const field of ['routine_fit', 'best_for', 'watchouts', 'why_it_stands_out']) collect(product?.[field], field);
  return out;
}
function factualQuoteTable(productsBySide) {
  return Object.fromEntries(Object.entries(productsBySide).map(([side, product]) => [side, factualQuoteSources(product)]));
}

module.exports = { factualQuoteSources, factualQuoteTable };
