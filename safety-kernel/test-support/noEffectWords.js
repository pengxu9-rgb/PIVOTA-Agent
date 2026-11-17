// The shapes of an answer that says a request had no effect: "nothing was done", "nothing was ordered", "no order was
// created", "nothing was charged", "without creating a purchase", and the negated and active forms ("was not charged",
// "wasn't placed", "has not been ordered", "did not go through", "no payment was made", "nothing happened", "sent
// nothing", "never charged"). Broad on purpose: a false match only asks for a flag or a named exemption.
// Kept OUT of test/ so `node --test` does not run it as a test file. Used by safety-kernel/test/noEffectWordsGated.test.js
// and tests/checkout_named_refusal_delisted_door.node.test.cjs.
const VERB = '(?:charged|ordered|placed|created|made|sent|written|done|taken|filed|bought|paid|recorded|submitted|opened)';
export const NO_EFFECT = new RegExp([
  `\\bnothing\\s+(?:was|were|has\\s+been|is|got)\\s+\\w+`,
  `\\bnothing\\s+happened`,
  `\\bno\\s+(?:order|payment|money|charge|purchase|request|refund)s?\\s+(?:was|were|has\\s+been|have\\s+been|is)\\s+${VERB}`,
  `\\bno\\s+(?:order|payment|money|charge|purchase)s?\\s+(?:was|were|has\\s+been)\\s+(?:moved|created|placed|taken|made)`,
  `\\b(?:was|were|has|have|is|are|had)\\s*(?:n['’]t|\\s+not|\\s+never)\\s+(?:been\\s+|yet\\s+)?${VERB}`,
  `\\b(?:did|does)\\s*(?:n['’]t|\\s+not)\\s+(?:go\\s+through|create|place|charge|take\\s+effect|happen|send|file|order|pay)`,
  `\\bnever\\s+(?:been\\s+)?${VERB}`,
  `\\bsent\\s+nothing`,
  `\\bdid\\s+nothing`,
  `\\bwithout\\s+(?:creating|placing|making|charging|filing)\\s+(?:a|an|any)\\s+(?:order|purchase|charge|request)`,
].join('|'), 'i');

// The shapes of an answer that tells the caller to begin the purchase again: "start over", "start the order over",
// "start again", "Starting fresh", "re-quote", "re-order", "a new order / checkout / purchase / quote", "another order".
// Obeyed while an order may exist, any of them can place a second order for one purchase. A match is allowed when its
// own clause (between . ; : ! ?) bounds it: "do not", "never", "only", "unless", "without", "instead of", "rather
// than", "if the buyer" ("start a new checkout only if the buyer wants another order" is true wherever it is said).
export const RESTART = /\b(?:start(?:ing|ed)?\s+(?:(?:the|this|your|a|an)\s+)?(?:(?:order|checkout|purchase)\s+)?(?:over|again|afresh|fresh|anew)|re-?quot(?:e|ing)|re-?order|new\s+(?:order|checkout|purchase|quote)|another\s+(?:order|checkout|purchase))\b/gi;
const BOUNDED = /\b(?:do\s+not|don['’]t|never|only|unless|without|instead\s+of|rather\s+than|if\s+the\s+buyer)\b/i;

/** Every unbounded restart instruction in `text`: [{ words, clause }]. */
export function restartInstructions(text) {
  const out = [];
  for (const m of String(text).matchAll(RESTART)) {
    const before = text.slice(0, m.index);
    const start = Math.max(...['.', ';', ':', '!', '?'].map((d) => before.lastIndexOf(d))) + 1;
    const rest = text.slice(m.index);
    const ends = ['.', ';', ':', '!', '?'].map((d) => rest.indexOf(d)).filter((i) => i >= 0);
    const clause = text.slice(start, m.index + (ends.length ? Math.min(...ends) : rest.length));
    if (!BOUNDED.test(clause)) out.push({ words: m[0], clause: clause.trim() });
  }
  return out;
}
