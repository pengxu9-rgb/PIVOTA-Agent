function mapSkillResponseToChatCardsV1(skillResponse) {
  return {
    cards: (skillResponse.cards || []).map((card) => mapCard(card, skillResponse)),
    ops: {
      thread_ops: skillResponse.ops?.thread_ops || [],
      profile_patch: skillResponse.ops?.profile_patch || {},
      routine_patch: skillResponse.ops?.routine_patch || {},
      experiment_events: buildExperimentEvents(skillResponse),
    },
    next_actions: skillResponse.next_actions || [],
  };
}

function mapSkillResponseToStreamEnvelope(skillResponse, thinkingSteps) {
  return {
    cards: (skillResponse.cards || []).map((card) => mapCard(card, skillResponse)),
    ops: {
      thread_ops: skillResponse.ops?.thread_ops || [],
      profile_patch: skillResponse.ops?.profile_patch || {},
      routine_patch: skillResponse.ops?.routine_patch || {},
      experiment_events: buildExperimentEvents(skillResponse),
    },
    next_actions: skillResponse.next_actions || [],
    thinking_steps: thinkingSteps || [],
    meta: {
      skill_id: skillResponse.telemetry?.skill_id || null,
      task_mode: skillResponse.telemetry?.task_mode || null,
      elapsed_ms: skillResponse.telemetry?.elapsed_ms || 0,
      quality_ok: skillResponse.quality?.quality_ok === true,
    },
  };
}

function mapCard(card, skillResponse) {
  if (shouldMapDupeSuggestCard(card, skillResponse)) {
    return mapDupeSuggestCard(card, skillResponse);
  }
  return {
    card_type: card.card_type,
    sections: (card.sections || []).map((section) => ({
      type: section.type || `${card.card_type}_structured`,
      ...section,
    })),
    metadata: card.metadata || {},
  };
}

function shouldMapDupeSuggestCard(card, skillResponse) {
  if (!card || typeof card !== 'object') return false;
  if (String(card.card_type || '').trim().toLowerCase() !== 'product_verdict') return false;
  const sections = Array.isArray(card.sections) ? card.sections : [];
  const structured = sections.find((section) => String(section?.type || '').trim().toLowerCase() === 'product_verdict_structured');
  if (!structured || typeof structured !== 'object') return false;
  const skillId = String(skillResponse?.telemetry?.skill_id || '').trim().toLowerCase();
  if (skillId === 'dupe.suggest') return true;
  return [
    'dupe',
    'cheaper_alternative',
    'premium_alternative',
    'price_unknown_alternative',
    'functional_alternative',
  ].some((key) => Array.isArray(structured[key]));
}

function mapDupeSuggestCard(card, skillResponse) {
  const sections = Array.isArray(card.sections) ? card.sections : [];
  const structured = sections.find((section) => String(section?.type || '').trim().toLowerCase() === 'product_verdict_structured') || {};
  const original = normalizeDupeIdentity(structured.anchor_product || structured.anchorProduct || {});
  const dupes = [
    ...normalizeDupeAlternatives(structured.dupe, 'dupe'),
    ...normalizeDupeAlternatives(structured.cheaper_alternative, 'dupe'),
  ];
  const comparables = [
    ...normalizeDupeAlternatives(structured.premium_alternative, 'premium_alternative'),
    ...normalizeDupeAlternatives(structured.functional_alternative, 'comparable'),
    ...normalizeDupeAlternatives(structured.price_unknown_alternative, 'comparable'),
  ];
  return {
    card_type: 'dupe_suggest',
    sections: [
      {
        type: 'dupe_suggest_structured',
        anchor_product: original,
        dupe_count: dupes.length,
        comparable_count: comparables.length,
        limited_state: structured.limited_state === true,
        limited_state_reason: structured.limited_state_reason || null,
      },
    ],
    metadata: {
      ...(card.metadata || {}),
      original,
      dupes,
      comparables,
      quality: skillResponse?.quality || {},
    },
  };
}

function normalizeDupeAlternatives(values, fallbackKind) {
  if (!Array.isArray(values)) return [];
  return values
    .map((candidate) => normalizeDupeAlternative(candidate, fallbackKind))
    .filter(Boolean);
}

function normalizeDupeAlternative(candidate, fallbackKind) {
  if (!candidate || typeof candidate !== 'object') return null;
  const product = normalizeDupeIdentity(candidate.product || candidate);
  if (!product.name && !product.url && !product.product_id) return null;
  const reasons = uniqueStrings([
    ...toStringList(candidate.reasons),
    ...toStringList(candidate.key_similarities),
  ], 2);
  const tradeoffs = uniqueStrings([
    ...toStringList(candidate.tradeoffs),
    candidate.tradeoff,
    ...toStringList(candidate.key_differences),
    candidate.why_not_the_same_product,
  ], 2);
  const similarity = normalizeSimilarity(candidate.similarity_score ?? candidate.similarity, candidate.confidence);
  const kind = String(candidate.bucket || fallbackKind || '').trim().toLowerCase();
  return {
    kind: kind === 'premium_alternative' || kind === 'premium'
      ? 'premium'
      : (kind === 'dupe' || kind === 'cheaper_alternative' ? 'dupe' : 'comparable'),
    ...(typeof similarity === 'number' ? { similarity } : {}),
    product,
    ...(reasons.length ? { reasons } : {}),
    ...(tradeoffs.length ? { tradeoffs } : {}),
  };
}

function normalizeDupeIdentity(value) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const brand = pickFirstString(row.brand);
  const name = pickFirstString(
    row.name,
    row.display_name,
    row.displayName,
    row.product_name,
    row.productName,
    row.title,
  );
  const url = pickFirstString(row.url, row.product_url, row.productUrl);
  const productId = pickFirstString(row.product_id, row.productId, row.sku_id, row.skuId);
  return {
    ...(brand ? { brand } : {}),
    ...(name ? { name } : {}),
    ...(productId ? { product_id: productId } : {}),
    ...(url ? { url } : {}),
  };
}

function normalizeSimilarity(similarityValue, confidenceValue) {
  const similarity = Number(similarityValue);
  if (Number.isFinite(similarity)) {
    return Math.max(0, Math.min(100, Math.round(similarity)));
  }
  const confidence = Number(confidenceValue);
  if (Number.isFinite(confidence)) {
    return Math.max(0, Math.min(100, Math.round(confidence * 100)));
  }
  return null;
}

function toStringList(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => pickFirstString(value)).filter(Boolean);
}

function uniqueStrings(values, max) {
  const out = [];
  const seen = new Set();
  for (const raw of values || []) {
    const text = pickFirstString(raw);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (typeof max === 'number' && out.length >= max) break;
  }
  return out;
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function buildExperimentEvents(skillResponse) {
  const events = [...(skillResponse.ops?.experiment_events || [])];
  events.push({
    event: 'skill_executed',
    skill_id: skillResponse.telemetry?.skill_id,
    skill_version: skillResponse.telemetry?.skill_version,
    quality_ok: skillResponse.quality?.quality_ok,
    elapsed_ms: skillResponse.telemetry?.elapsed_ms,
    llm_calls: skillResponse.telemetry?.llm_calls,
  });
  return events;
}

module.exports = {
  mapSkillResponseToChatCardsV1,
  mapSkillResponseToStreamEnvelope,
};
