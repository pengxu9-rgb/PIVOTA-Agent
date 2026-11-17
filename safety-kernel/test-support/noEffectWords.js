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
