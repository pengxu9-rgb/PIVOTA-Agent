const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
 
function isValidIsoDateKey(dateKey) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''));
}
 
function normalizeMarket(v) {
  const s = String(v || '').trim().toUpperCase();
  return s === 'JP' ? 'JP' : 'US';
}
 
function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
 
function safeString(v) {
  const s = String(v ?? '').trim();
  return s ? s : null;
}
 
function normalizeArea(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return 'unknown';
  return s;
}
 
function parseExplorationBucket(v) {
  if (v === 0 || v === '0') return 0;
  if (v === 1 || v === '1') return 1;
  return null;
}
 
function extractExperimentBlock(properties) {
  const exp = properties?.experiment;
  if (exp && typeof exp === 'object' && !Array.isArray(exp)) return exp;
  return null;
}
 
function extractCandidateImpressions(properties) {
  // Some clients send a single combined list, while others send `defaultCandidates` + `moreCandidates`.
  // Prefer a combined list when present; otherwise combine defaults + more.
  const candidateListKeys = ['candidateImpressions', 'candidates'];
  for (const key of candidateListKeys) {
    const list = properties?.[key];
    if (!Array.isArray(list) || list.length === 0) continue;
    return list
      .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
      .map((row) => ({
        candidateId: safeString(row.candidateId || row.id),
        impressionId: safeString(row.impressionId),
        rank: toNumber(row.rank),
        isDefault: Boolean(row.isDefault),
        area: normalizeArea(row.area),
        score: toNumber(row.score),
        gatingStatus: safeString(row.gating?.status || row.gatingStatus),
      }));
  }
 
  const defaults = Array.isArray(properties?.defaultCandidates) ? properties.defaultCandidates : [];
  const more = Array.isArray(properties?.moreCandidates) ? properties.moreCandidates : [];
  const combined = [...defaults, ...more].filter((row) => row && typeof row === 'object' && !Array.isArray(row));
  if (combined.length === 0) return [];
  return combined.map((row) => ({
    candidateId: safeString(row.candidateId || row.id),
    impressionId: safeString(row.impressionId),
    rank: toNumber(row.rank),
    isDefault: Boolean(row.isDefault),
    area: normalizeArea(row.area),
    score: toNumber(row.score),
    gatingStatus: safeString(row.gating?.status || row.gatingStatus),
  }));
}
 
function newUuidish() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch {
    // ignore
  }
  return crypto.randomBytes(16).toString('hex');
}
 
function createAuditAccumulator({ date, market }) {
  return {
    date,
    market: normalizeMarket(market),
    warnings: [],
    input: {
      eventsJsonlPath: null,
      outcomesFromDb: false,
      mvpEventsFromDb: false,
      mvpEventsFromFile: false,
    },
    counts: {
      eventsTotal: 0,
      eventsMissingExposureId: 0,
      lr_adjustments_exposed: 0,
      lr_more_opened: 0,
      lr_candidate_clicked: 0,
      lr_steps_viewed: 0,
      lr_kit_clicked: 0,
      lr_checkout_started: 0,
      lr_share_clicked: 0,
    },
    integrity: {
      missingExposureId: 0,
      missingImpressionId: 0,
      missingExperiment: 0,
      missingVariantIdOrBucket: 0,
      defaultMoreRankSwapViolations: 0,
    },
    moreAvailability: {
      exposuresWithMoreGte1: 0,
      exposuresWithMoreGte2: 0,
    },
    exploration: {
      bucket0: 0,
      bucket1: 0,
      explorationRateSum: 0,
      explorationRateN: 0,
    },
    areaDistribution: {
      defaults: Object.create(null),
      more: Object.create(null),
    },
    funnel: {
      exposed: new Set(),
      moreOpened: new Set(),
      candidateClicked: new Set(),
      stepsViewed: new Set(),
      kitClicked: new Set(),
      checkoutStarted: new Set(),
      shareClicked: new Set(),
      missingExposureIdEvents: 0,
    },
    outcomeStats: null,
    mvpEventStats: null,
  };
}
 
function bumpAreaCount(mapObj, area, by = 1) {
  const key = normalizeArea(area);
  mapObj[key] = (mapObj[key] || 0) + by;
}
 
function consumeLookReplicatorEvent(acc, row) {
  acc.counts.eventsTotal += 1;
  const eventName = String(row?.event || '');
  const properties = row?.properties && typeof row.properties === 'object' ? row.properties : {};
 
  const rowMarket = normalizeMarket(properties.market || properties.Market);
  if (rowMarket !== acc.market) return;
 
  const exposureId = safeString(properties.exposureId);
  if (!exposureId) {
    acc.counts.eventsMissingExposureId += 1;
    acc.funnel.missingExposureIdEvents += 1;
  }
 
  if (eventName in acc.counts) acc.counts[eventName] += 1;
 
  if (eventName === 'lr_adjustments_exposed') {
    acc.funnel.exposed.add(exposureId || `missing:${acc.funnel.missingExposureIdEvents}`);
 
    if (!exposureId) acc.integrity.missingExposureId += 1;
 
    const candidates = extractCandidateImpressions(properties);
    if (!candidates || candidates.length === 0) {
      acc.integrity.missingImpressionId += 1;
    } else {
      const anyMissing = candidates.some((c) => !c.impressionId || !c.candidateId);
      if (anyMissing) acc.integrity.missingImpressionId += 1;
 
      let moreCount = 0;
      for (const c of candidates) {
        if (c.isDefault) bumpAreaCount(acc.areaDistribution.defaults, c.area);
        else {
          bumpAreaCount(acc.areaDistribution.more, c.area);
          moreCount += 1;
        }
      }
      if (moreCount >= 1) acc.moreAvailability.exposuresWithMoreGte1 += 1;
      if (moreCount >= 2) acc.moreAvailability.exposuresWithMoreGte2 += 1;
 
      // Rank sanity: defaults must stay in ranks 1..3, more must stay outside.
      const violates = candidates.some((c) => {
        if (c.rank == null) return false;
        if (c.isDefault) return c.rank > 3;
        return c.rank <= 3;
      });
      if (violates) acc.integrity.defaultMoreRankSwapViolations += 1;
    }
 
    const exp = extractExperimentBlock(properties);
    const variantId = safeString(exp?.variantId) || safeString(properties.variantId);
    const bucket = parseExplorationBucket(exp?.explorationBucket ?? properties.explorationBucket);
    if (!variantId || bucket == null) acc.integrity.missingVariantIdOrBucket += 1;
    if (properties.missingExperiment === true) acc.integrity.missingExperiment += 1;
 
    if (bucket === 0) acc.exploration.bucket0 += 1;
    if (bucket === 1) acc.exploration.bucket1 += 1;
    const rate = toNumber(exp?.explorationRate ?? properties.explorationRate);
    if (rate != null) {
      acc.exploration.explorationRateSum += rate;
      acc.exploration.explorationRateN += 1;
    }
  } else if (eventName === 'lr_more_opened') {
    if (exposureId) acc.funnel.moreOpened.add(exposureId);
  } else if (eventName === 'lr_candidate_clicked') {
    if (exposureId) acc.funnel.candidateClicked.add(exposureId);
  } else if (eventName === 'lr_steps_viewed') {
    if (exposureId) acc.funnel.stepsViewed.add(exposureId);
  } else if (eventName === 'lr_kit_clicked') {
    if (exposureId) acc.funnel.kitClicked.add(exposureId);
  } else if (eventName === 'lr_checkout_started') {
    if (exposureId) acc.funnel.checkoutStarted.add(exposureId);
  } else if (eventName === 'lr_share_clicked') {
    if (exposureId) acc.funnel.shareClicked.add(exposureId);
  }
}
 
function finalizeAudit(acc) {
  const exposedCount = acc.counts.lr_adjustments_exposed;
  const denom = exposedCount || 1;
  const bucketTotal = acc.exploration.bucket0 + acc.exploration.bucket1;
  const explorationObservedRate = bucketTotal ? acc.exploration.bucket1 / bucketTotal : null;
  const explorationConfiguredRate =
    acc.exploration.explorationRateN > 0 ? acc.exploration.explorationRateSum / acc.exploration.explorationRateN : null;
 
  const funnelExposed = acc.funnel.exposed.size;
  const funnelStages = {
    exposed: funnelExposed,
    moreOpened: acc.funnel.moreOpened.size,
    candidateClicked: acc.funnel.candidateClicked.size,
    stepsViewed: acc.funnel.stepsViewed.size,
    kitClicked: acc.funnel.kitClicked.size,
    checkoutStarted: acc.funnel.checkoutStarted.size,
    shareClicked: acc.funnel.shareClicked.size,
  };
 
  function rate(n, d) {
    if (!d) return null;
    return n / d;
  }
 
  return {
    schemaVersion: 'v0',
    date: acc.date,
    market: acc.market,
    input: acc.input,
    warnings: acc.warnings,
    metrics: {
      eventIntegrity: {
        lr_adjustments_exposed: exposedCount,
        missingExposureIdRate: acc.integrity.missingExposureId / denom,
        missingImpressionIdRate: acc.integrity.missingImpressionId / denom,
        missingVariantIdOrBucketRate: acc.integrity.missingVariantIdOrBucket / denom,
        missingExperimentFlagRate: acc.integrity.missingExperiment / denom,
      },
      moreAvailability: {
        exposuresWithMoreGte1Rate: acc.moreAvailability.exposuresWithMoreGte1 / denom,
        exposuresWithMoreGte2Rate: acc.moreAvailability.exposuresWithMoreGte2 / denom,
      },
      areaDistribution: acc.areaDistribution,
      explorationSanity: {
        observedBucket1Rate: explorationObservedRate,
        avgExplorationRateFromEvents: explorationConfiguredRate,
        defaultMoreRankSwapViolationRate: acc.integrity.defaultMoreRankSwapViolations / denom,
      },
      funnel: {
        counts: funnelStages,
        rates: {
          exposed_to_moreOpened: rate(funnelStages.moreOpened, funnelStages.exposed),
          moreOpened_to_candidateClicked: rate(funnelStages.candidateClicked, funnelStages.moreOpened),
          candidateClicked_to_stepsViewed: rate(funnelStages.stepsViewed, funnelStages.candidateClicked),
          stepsViewed_to_kitClicked: rate(funnelStages.kitClicked, funnelStages.stepsViewed),
          kitClicked_to_checkoutStarted: rate(funnelStages.checkoutStarted, funnelStages.kitClicked),
          exposed_to_shareClicked: rate(funnelStages.shareClicked, funnelStages.exposed),
        },
      },
      outcomes: acc.outcomeStats,
      mvpEvents: acc.mvpEventStats,
    },
    debug: {
      runId: newUuidish(),
      generatedAt: new Date().toISOString(),
    },
  };
}
 
function formatPct(value, decimals = 1) {
  if (value == null) return 'n/a';
  const pct = value * 100;
  return `${pct.toFixed(decimals)}%`;
}
 
function renderMarkdown(report) {
  const m = report.metrics;
  const e = m.eventIntegrity;
  const more = m.moreAvailability;
  const expl = m.explorationSanity;
  const funnel = m.funnel;
 
  const lines = [];
  lines.push(`# Layer2 Audit (${report.market}) — ${report.date}`);
  lines.push('');
  lines.push(`Generated at: \`${report.debug.generatedAt}\``);
  lines.push('');
  lines.push('## Inputs');
  lines.push(`- Events JSONL: \`${report.input.eventsJsonlPath || 'not found'}\``);
  lines.push(`- Outcomes DB: \`${report.input.outcomesFromDb ? 'yes' : 'no'}\``);
  lines.push(`- MVP events DB: \`${report.input.mvpEventsFromDb ? 'yes' : 'no'}\``);
  lines.push(`- MVP events file: \`${report.input.mvpEventsFromFile ? 'yes' : 'no'}\``);
  if (Array.isArray(report.warnings) && report.warnings.length) {
    lines.push('');
    lines.push('## Warnings');
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
 
  lines.push('');
  lines.push('## Event Integrity');
  lines.push(`- \`lr_adjustments_exposed\`: ${e.lr_adjustments_exposed}`);
  lines.push(`- Missing \`exposureId\`: ${formatPct(e.missingExposureIdRate)}`);
  lines.push(`- Missing \`impressionId\`: ${formatPct(e.missingImpressionIdRate)}`);
  lines.push(`- Missing \`variantId\`/\`explorationBucket\`: ${formatPct(e.missingVariantIdOrBucketRate)}`);
  lines.push(`- \`missingExperiment\` flagged: ${formatPct(e.missingExperimentFlagRate)}`);
 
  lines.push('');
  lines.push('## More Availability');
  lines.push(`- Exposures with ≥1 more candidate: ${formatPct(more.exposuresWithMoreGte1Rate)}`);
  lines.push(`- Exposures with ≥2 more candidates: ${formatPct(more.exposuresWithMoreGte2Rate)}`);
 
  lines.push('');
  lines.push('## Area Distribution (candidates)');
  lines.push('');
  lines.push('**Defaults**');
  for (const [area, n] of Object.entries(m.areaDistribution.defaults || {}).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${area}: ${n}`);
  }
  lines.push('');
  lines.push('**More**');
  for (const [area, n] of Object.entries(m.areaDistribution.more || {}).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${area}: ${n}`);
  }
 
  lines.push('');
  lines.push('## Exploration Sanity');
  lines.push(`- Observed bucket==1 rate: ${formatPct(expl.observedBucket1Rate, 2)}`);
  lines.push(`- Avg explorationRate (from events): ${expl.avgExplorationRateFromEvents == null ? 'n/a' : expl.avgExplorationRateFromEvents.toFixed(3)}`);
  lines.push(`- Default/More rank swap violations: ${formatPct(expl.defaultMoreRankSwapViolationRate)}`);
 
  lines.push('');
  lines.push('## Funnel (exposureId keyed)');
  lines.push('');
  lines.push('| Stage | Count | Rate |');
  lines.push('|---|---:|---:|');
  lines.push(`| exposed | ${funnel.counts.exposed} | ${formatPct(1)} |`);
  lines.push(`| more_opened | ${funnel.counts.moreOpened} | ${formatPct(funnel.rates.exposed_to_moreOpened)} |`);
  lines.push(`| candidate_clicked | ${funnel.counts.candidateClicked} | ${formatPct(funnel.rates.moreOpened_to_candidateClicked)} |`);
  lines.push(`| steps_viewed | ${funnel.counts.stepsViewed} | ${formatPct(funnel.rates.candidateClicked_to_stepsViewed)} |`);
  lines.push(`| kit_clicked | ${funnel.counts.kitClicked} | ${formatPct(funnel.rates.stepsViewed_to_kitClicked)} |`);
  lines.push(`| checkout_started | ${funnel.counts.checkoutStarted} | ${formatPct(funnel.rates.kitClicked_to_checkoutStarted)} |`);
  lines.push(`| share_clicked | ${funnel.counts.shareClicked} | ${formatPct(funnel.rates.exposed_to_shareClicked)} |`);
 
  if (m.outcomes) {
    lines.push('');
    lines.push('## Outcomes (DB)');
    lines.push(`- Rows: ${m.outcomes.rows}`);
    lines.push(`- Avg rating: ${m.outcomes.avgRating == null ? 'n/a' : m.outcomes.avgRating.toFixed(2)}`);
  }
 
  if (m.mvpEvents) {
    lines.push('');
    lines.push('## MVP Events');
    lines.push(`- Rows: ${m.mvpEvents.rows}`);
    if (m.mvpEvents.byType && Object.keys(m.mvpEvents.byType).length) {
      lines.push('');
      lines.push('**Top event types**');
      for (const [t, n] of Object.entries(m.mvpEvents.byType).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
        lines.push(`- ${t}: ${n}`);
      }
    }
  }
 
  lines.push('');
  return `${lines.join('\n')}\n`;
}
 
async function streamJsonlFile(filePath, onRow) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const raw = String(line || '').trim();
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    await onRow(parsed);
  }
}
 
function resolveLookReplicatorEventsPath({ date, dir }) {
  if (!isValidIsoDateKey(date)) return null;
  if (!dir) return null;
  const absDir = path.resolve(dir);
  const filePath = path.join(absDir, `look-replicator-${date}.jsonl`);
  return fs.existsSync(filePath) ? filePath : null;
}
 
module.exports = {
  createAuditAccumulator,
  consumeLookReplicatorEvent,
  finalizeAudit,
  renderMarkdown,
  streamJsonlFile,
  resolveLookReplicatorEventsPath,
  normalizeMarket,
  isValidIsoDateKey,
};
