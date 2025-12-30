function uniqueStrings(items) {
  return Array.from(new Set((items || []).map((s) => String(s || '').trim()).filter(Boolean)));
}

function renderTemplateStep(step, variables) {
  return String(step || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name) => variables[name] ?? '');
}

function defaultVariablesForArea(area) {
  if (area === 'eye') return { linerAngleHint: 'angle slightly more horizontal' };
  return {};
}

function isZhLocale(locale) {
  const s = String(locale || '').trim().toLowerCase().replace(/_/g, '-');
  return s === 'zh' || s.startsWith('zh-');
}

function fallbackStepsForArea(area, locale) {
  const zh = isZhLocale(locale);
  if (zh) {
    if (area === 'base') return ['薄涂底妆。', '仅在需要处点涂遮瑕。', '只在需要区域轻扫定妆。'];
    if (area === 'eye') return ['眼线从外眼角后三分之一开始。', '线条保持细。', '拉长不要过长。'];
    if (area === 'lip') return ['对齐参考的唇部质感。', '保持在相近的色系。', '轻轻按压调整浓淡。'];
    if (area === 'prep') return ['妆前清洁与保湿。', '干燥处重点补水。', '需要持妆时再使用妆前乳。'];
    if (area === 'contour') return ['修容保持轻薄柔和。', '充分晕染。', '避免生硬边界。'];
    if (area === 'brow') return ['轻描眉形。', '用毛流感笔触填充。', '刷开让边缘更自然。'];
    if (area === 'blush') return ['少量多次上腮红。', '边缘晕开。', '逐步叠加。'];
    return ['动作保持轻薄可晕染。', '充分晕染。', '整体更自然。'];
  }

  if (area === 'base') return ['Apply a thin base layer.', 'Spot-correct only where needed.', 'Set only where needed.'];
  if (area === 'eye') return ['Start liner from the outer third.', 'Keep the line thin.', 'Keep the wing short.'];
  if (area === 'lip') return ['Match the reference finish.', 'Stay in a close shade family.', 'Blot lightly to adjust intensity.'];
  if (area === 'prep') return ['Prep skin.', 'Moisturize as needed.', 'Use primer only if it helps longevity.'];
  if (area === 'contour') return ['Keep contour soft and light.', 'Blend thoroughly.', 'Avoid harsh lines.'];
  if (area === 'brow') return ['Map brow shape lightly.', 'Fill with hair-like strokes.', 'Brush through for softness.'];
  if (area === 'blush') return ['Apply a soft diffuse blush.', 'Blend edges.', 'Build gradually.'];
  return ['Use light, blendable steps.', 'Blend thoroughly.', 'Keep it subtle.'];
}

function normalizeMarket(v) {
  const s = String(v || '').trim().toUpperCase();
  if (s === 'US' || s === 'JP') return s;
  return 'US';
}

const { buildRoleNormalizer } = require('../dicts/roles');
const { resolveTechniqueCardForLanguage } = require('../kb/resolveTechniqueCardForLanguage');
const { selectBestTechniqueId } = require('../kb/triggerMatchSelection');

function parseEnvBool(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return null;
}

function renderSkeletonFromKB(inputSkeletons, kb, ctx) {
  const warnings = [];
  let usedFallback = false;
  const market = normalizeMarket(ctx?.market);
  const zh = isZhLocale(ctx?.locale);
  const roleNormalizer = buildRoleNormalizer();
  const triggerMatchingEnabled =
    parseEnvBool(process.env.LAYER2_ENABLE_TRIGGER_MATCHING) === true || ctx?.enableTriggerMatching === true;
  const triggerMatchDebug = parseEnvBool(process.env.LAYER2_TRIGGER_MATCH_DEBUG) === true;

  const out = (inputSkeletons || []).map((s) => {
    const doActionIds = Array.isArray(s.doActionIds) ? s.doActionIds : [];
    const selection = s.doActionSelection || 'sequence';
    const selectedActionIds =
      selection === 'choose_one'
        ? (() => {
            if (!doActionIds.length) return [];
            if (!triggerMatchingEnabled || doActionIds.length === 1) return [doActionIds[0]];

            const candidateCards = [];
            const missingIds = [];
            for (const id of doActionIds) {
              const card = kb?.byId?.get(String(id));
              if (!card) {
                missingIds.push(String(id));
                continue;
              }
              if (String(card.market) !== market) continue;
              if (card.area !== s.impactArea) continue;
              candidateCards.push(card);
            }

            const { selectedId, ranked } = selectBestTechniqueId({
              ctx,
              cards: candidateCards,
              fallbackId: doActionIds[0],
            });

            if (triggerMatchDebug) {
              const rankedPreview = ranked.slice(0, 5).map((r) => `${r.id}:${r.score}`).join(',');
              warnings.push(
                `[trigger_match] area=${s.impactArea} ruleId=${String(s.ruleId)} selected=${selectedId || '(empty)'} matched=${rankedPreview || '(none)'} missingCandidates=${missingIds.length}`,
              );
            }

            return selectedId ? [selectedId] : [doActionIds[0]];
          })()
        : doActionIds;
    const variables = defaultVariablesForArea(s.impactArea);
    const doActions = [];
    const techniqueRefs = [];
    const techniqueCards = [];
    const tags = Array.isArray(s.tags) ? [...s.tags] : [];
    const rationaleFacts = [];

    for (const id of selectedActionIds) {
      const resolved = resolveTechniqueCardForLanguage({
        id,
        kb,
        locale: ctx?.locale,
        acceptLanguage: ctx?.acceptLanguage,
        appLanguage: ctx?.appLanguage,
        userLanguage: ctx?.userLanguage,
      });
      const card = resolved.card;
      if (!card) {
        warnings.push(
          `Missing technique card: ${id} (area=${s.impactArea}). Tried: ${(resolved.triedIds || []).join(', ')}`
        );
        usedFallback = true;
        continue;
      }
      if (resolved.usedFallbackLanguage) {
        warnings.push(`Technique language fallback for ${id}: missing zh, used en (${card.id}).`);
      }
      if (String(card.market) !== market) {
        warnings.push(`Technique card ${id} market mismatch (expected ${market}, got ${card.market}).`);
        usedFallback = true;
        continue;
      }
      if (card.area !== s.impactArea) {
        warnings.push(`Technique card ${id} area mismatch (expected ${s.impactArea}, got ${card.area}).`);
        usedFallback = true;
        continue;
      }

      // Preserve resolved technique id for downstream contracts/telemetry.
      techniqueRefs.push({ id: card.id, area: card.area });
      const renderedSteps = (card.actionTemplate?.steps || [])
        .map((step) => renderTemplateStep(step, variables))
        .filter(Boolean);
      doActions.push(...renderedSteps);
      techniqueCards.push({
        id: String(id || '').trim() || card.id,
        resolvedId: card.id,
        title: String(card.actionTemplate?.title || '').trim() || undefined,
        steps: renderedSteps,
        rationale: Array.isArray(card.rationaleTemplate) ? card.rationaleTemplate.map((x) => String(x || '').trim()).filter(Boolean) : [],
      });

      if (zh && resolved.inferredLanguage === 'zh' && !resolved.usedFallbackLanguage) {
        const rationale = Array.isArray(card.rationaleTemplate) ? card.rationaleTemplate : [];
        for (const line of rationale) {
          const t = String(line || '').trim();
          if (t) rationaleFacts.push(t);
        }
      }

      if (Array.isArray(card.productRoleHints)) {
        for (const hint of card.productRoleHints) {
          const normalized = roleNormalizer.normalizeRoleHint(hint);
          if (normalized) tags.push(`role:${normalized}`);
        }
      }
    }

    const finalDoActions = uniqueStrings(doActions);
    if (!finalDoActions.length) {
      warnings.push(`No rendered doActions for ${s.impactArea}: using safe fallback steps.`);
      usedFallback = true;
      finalDoActions.push(...fallbackStepsForArea(s.impactArea, ctx?.locale));
    }

    return {
      ...s,
      selectedDoActionIds: selectedActionIds,
      ...(zh && rationaleFacts.length
        ? {
            // For zh UI, prefer Chinese rationales from the resolved technique cards so downstream
            // renderers can stay localized even when rule facts are English-only.
            becauseFacts: uniqueStrings(rationaleFacts),
            whyMechanism: uniqueStrings(rationaleFacts),
          }
        : {}),
      doActions: finalDoActions,
      techniqueRefs: techniqueRefs.length ? techniqueRefs : undefined,
      techniqueCards: techniqueCards.length ? techniqueCards : undefined,
      tags: uniqueStrings(tags).length ? uniqueStrings(tags) : undefined,
    };
  });

  const byArea = {
    base: out.find((s) => s.impactArea === 'base'),
    eye: out.find((s) => s.impactArea === 'eye'),
    lip: out.find((s) => s.impactArea === 'lip'),
  };
  if (!byArea.base || !byArea.eye || !byArea.lip) {
    throw new Error('renderSkeletonFromKB requires one skeleton per impactArea.');
  }

  return { skeletons: [byArea.base, byArea.eye, byArea.lip], allSkeletons: out, warnings, usedFallback };
}

module.exports = {
  renderSkeletonFromKB,
};
