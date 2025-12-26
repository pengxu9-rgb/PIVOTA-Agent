function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mean(values) {
  const nums = values.map(safeNumber).filter((n) => n != null);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function rate(n, d) {
  const denom = Number(d || 0);
  if (denom <= 0) return 0;
  return Number(n || 0) / denom;
}

function uniqByKey(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function keyForTechnique(t) {
  return `${t.area}:${t.id}`;
}

function keyForRule(r) {
  return `${r.area}:${r.ruleId}`;
}

function techniqueMetrics(samples) {
  const byId = new Map();

  for (const s of samples) {
    const rating = typeof s.signals?.rating === 'number' ? s.signals.rating : null;
    const used = uniqByKey(s.usedTechniques || [], keyForTechnique);
    for (const t of used) {
      const id = String(t.id || '');
      if (!id) continue;
      const key = keyForTechnique(t);
      const m =
        byId.get(key) ||
        {
          id,
          area: t.area,
          usage_count: 0,
          low_confidence_count: 0,
          fallback_association_count: 0,
          rating_values: [],
          shared_count: 0,
          add_to_cart_count: 0,
          checkout_started_count: 0,
          checkout_success_count: 0,
        };

      m.usage_count += 1;
      if (s.qualityFlags?.anyAdjustmentLowConfidence) m.low_confidence_count += 1;
      if (s.qualityFlags?.anyFallbackUsed) m.fallback_association_count += 1;
      if (rating != null) m.rating_values.push(rating);
      if (s.signals?.shared) m.shared_count += 1;
      if (s.signals?.addToCart) m.add_to_cart_count += 1;
      if (s.signals?.checkoutStarted) m.checkout_started_count += 1;
      if (s.signals?.checkoutSuccess) m.checkout_success_count += 1;

      byId.set(key, m);
    }
  }

  const list = Array.from(byId.values()).map((m) => {
    const rating_mean = mean(m.rating_values);
    return {
      id: m.id,
      area: m.area,
      usage_count: m.usage_count,
      low_confidence_rate: rate(m.low_confidence_count, m.usage_count),
      fallback_association_rate: rate(m.fallback_association_count, m.usage_count),
      rating_mean,
      shared_rate: rate(m.shared_count, m.usage_count),
      add_to_cart_rate: rate(m.add_to_cart_count, m.usage_count),
      checkout_success_rate: rate(m.checkout_success_count, m.usage_count),
      checkout_start_rate: rate(m.checkout_started_count, m.usage_count),
    };
  });

  return list.sort((a, b) => b.usage_count - a.usage_count || a.id.localeCompare(b.id));
}

function ruleMetrics(samples) {
  const byKey = new Map();
  for (const s of samples) {
    const rating = typeof s.signals?.rating === 'number' ? s.signals.rating : null;
    const used = uniqByKey(s.usedRules || [], keyForRule);
    for (const r of used) {
      const ruleId = String(r.ruleId || '');
      if (!ruleId) continue;
      const key = keyForRule(r);
      const m =
        byKey.get(key) ||
        {
          ruleId,
          area: r.area,
          usage_count: 0,
          low_confidence_count: 0,
          fallback_association_count: 0,
          rating_values: [],
          shared_count: 0,
          add_to_cart_count: 0,
          checkout_started_count: 0,
          checkout_success_count: 0,
        };

      m.usage_count += 1;
      if (s.qualityFlags?.anyAdjustmentLowConfidence) m.low_confidence_count += 1;
      if (s.qualityFlags?.anyFallbackUsed) m.fallback_association_count += 1;
      if (rating != null) m.rating_values.push(rating);
      if (s.signals?.shared) m.shared_count += 1;
      if (s.signals?.addToCart) m.add_to_cart_count += 1;
      if (s.signals?.checkoutStarted) m.checkout_started_count += 1;
      if (s.signals?.checkoutSuccess) m.checkout_success_count += 1;

      byKey.set(key, m);
    }
  }

  const list = Array.from(byKey.values()).map((m) => {
    const rating_mean = mean(m.rating_values);
    return {
      ruleId: m.ruleId,
      area: m.area,
      usage_count: m.usage_count,
      low_confidence_rate: rate(m.low_confidence_count, m.usage_count),
      fallback_association_rate: rate(m.fallback_association_count, m.usage_count),
      rating_mean,
      shared_rate: rate(m.shared_count, m.usage_count),
      add_to_cart_rate: rate(m.add_to_cart_count, m.usage_count),
      checkout_success_rate: rate(m.checkout_success_count, m.usage_count),
    };
  });

  return list.sort((a, b) => b.usage_count - a.usage_count || a.ruleId.localeCompare(b.ruleId));
}

function clusterKey(fingerprint) {
  const fp = fingerprint || {};
  const key = {
    faceShape: fp.faceShape || 'unknown',
    eyeType: fp.eyeType || 'unknown',
    lipType: fp.lipType || 'unknown',
    baseFinish: fp.baseFinish || 'unknown',
    lipFinish: fp.lipFinish || 'unknown',
    vibeTags: Array.isArray(fp.vibeTags) ? [...fp.vibeTags].sort().slice(0, 6) : [],
  };
  return JSON.stringify(key);
}

function painScoreForSample(sample) {
  const rating = typeof sample.signals?.rating === 'number' ? sample.signals.rating : null;
  const lowRating = rating != null && rating <= 2;
  const anyIssueTags = Array.isArray(sample.signals?.issueTags) && sample.signals.issueTags.length > 0;
  const anyFallback = Boolean(sample.qualityFlags?.anyFallbackUsed);
  return lowRating || anyIssueTags || anyFallback;
}

function gapClusters(samples) {
  const clusters = new Map();

  for (const s of samples) {
    if (!painScoreForSample(s)) continue;
    const key = clusterKey(s.contextFingerprint);

    const rating = typeof s.signals?.rating === 'number' ? s.signals.rating : null;
    const c =
      clusters.get(key) ||
      {
        key,
        count: 0,
        rating_values: [],
        fallback_count: 0,
        lookspec_low_conf_count: 0,
        low_adj_conf_count: 0,
        issue_tag_counts: { base: 0, eye: 0, lip: 0, other: 0 },
        technique_counts: new Map(),
        rule_counts: new Map(),
        jobIds: [],
      };

    c.count += 1;
    if (rating != null) c.rating_values.push(rating);
    if (s.qualityFlags?.anyFallbackUsed) c.fallback_count += 1;
    if (s.qualityFlags?.lookSpecLowConfidence) c.lookspec_low_conf_count += 1;
    if (s.qualityFlags?.anyAdjustmentLowConfidence) c.low_adj_conf_count += 1;
    if (Array.isArray(s.signals?.issueTags)) {
      for (const t of s.signals.issueTags) {
        if (c.issue_tag_counts[t] != null) c.issue_tag_counts[t] += 1;
      }
    }

    for (const t of s.usedTechniques || []) {
      const id = String(t.id || '');
      if (!id) continue;
      const k = `${t.area}:${id}`;
      c.technique_counts.set(k, (c.technique_counts.get(k) || 0) + 1);
    }
    for (const r of s.usedRules || []) {
      const id = String(r.ruleId || '');
      if (!id) continue;
      const k = `${r.area}:${id}`;
      c.rule_counts.set(k, (c.rule_counts.get(k) || 0) + 1);
    }

    c.jobIds.push(s.jobId);
    clusters.set(key, c);
  }

  function topK(map, k) {
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .slice(0, k)
      .map(([id, count]) => ({ id, count }));
  }

  return Array.from(clusters.values())
    .map((c) => ({
      key: c.key,
      count: c.count,
      rating_mean: mean(c.rating_values),
      fallback_rate: rate(c.fallback_count, c.count),
      lookSpecLowConfidence_rate: rate(c.lookspec_low_conf_count, c.count),
      anyAdjustmentLowConfidence_rate: rate(c.low_adj_conf_count, c.count),
      issue_tag_counts: c.issue_tag_counts,
      dominant_techniques: topK(c.technique_counts, 6),
      dominant_rules: topK(c.rule_counts, 6),
      jobIds: c.jobIds.slice(0, 50),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function priorityCandidates(clusters, samples) {
  const sampleById = new Map(samples.map((s) => [s.jobId, s]));

  const candidates = clusters.map((c) => {
    const count = c.count;
    const avgRating = typeof c.rating_mean === 'number' ? c.rating_mean : 3;
    const ratingNorm = Math.max(0, Math.min(1, avgRating / 5));
    const fallbackRate = c.fallback_rate || 0;

    let checkoutStarted = 0;
    let checkoutSuccess = 0;
    for (const jobId of c.jobIds || []) {
      const s = sampleById.get(jobId);
      if (!s) continue;
      if (s.signals?.checkoutStarted) checkoutStarted += 1;
      if (s.signals?.checkoutSuccess) checkoutSuccess += 1;
    }
    const checkoutDrop =
      checkoutStarted > 0 ? Math.max(0, (checkoutStarted - checkoutSuccess) / checkoutStarted) : 0;

    const volumeWeight = Math.log1p(count);
    const priority = volumeWeight * (1 - ratingNorm) + 1.25 * fallbackRate + 0.75 * checkoutDrop;

    return {
      key: c.key,
      count,
      avgRating,
      fallbackRate,
      checkoutDrop,
      priority,
      dominant_techniques: c.dominant_techniques || [],
      dominant_rules: c.dominant_rules || [],
      issue_tag_counts: c.issue_tag_counts,
      jobIds: c.jobIds || [],
    };
  });

  return candidates.sort((a, b) => b.priority - a.priority || b.count - a.count).slice(0, 20);
}

module.exports = {
  techniqueMetrics,
  ruleMetrics,
  gapClusters,
  priorityCandidates,
};

