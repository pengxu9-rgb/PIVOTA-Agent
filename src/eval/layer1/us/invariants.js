const bannedPatterns = [
  /\bcelebrity\b/i,
  /\bkol\b/i,
  /\blook\s+like\b/i,
  /\bresemble(s|d)?\b/i,
  /\bdoppelg(a|ä)nger\b/i,
  /\btwin\b/i,
  /\bidentical\b/i,
];

function collectStrings(obj) {
  const out = [];
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (cur == null) continue;
    if (typeof cur === 'string') {
      out.push(cur);
      continue;
    }
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }
    if (typeof cur === 'object') {
      for (const v of Object.values(cur)) stack.push(v);
    }
  }
  return out;
}

function assertNoIdentityLanguage(report) {
  const strings = collectStrings({
    reasons: report.reasons,
    adjustments: report.adjustments,
    warnings: report.warnings,
  });
  for (const s of strings) {
    for (const re of bannedPatterns) {
      if (re.test(s)) {
        throw new Error(`Identity language violation: "${s}"`);
      }
    }
  }
}

function assertInvariants(sample, report) {
  if (sample.market !== 'US' || report.market !== 'US') throw new Error('US-only invariant violated');
  if (report.reasons.length !== 3) throw new Error('reasons must be exactly 3');
  if (report.adjustments.length !== 3) throw new Error('adjustments must be exactly 3');
  if (new Set(report.adjustments.map((a) => a.impactArea)).size !== 3) throw new Error('adjustments must cover base/eye/lip');
  assertNoIdentityLanguage(report);
}

module.exports = {
  assertInvariants,
};

