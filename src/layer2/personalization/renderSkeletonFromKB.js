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

function fallbackStepsForArea(area) {
  if (area === 'base') return ['Apply a thin base layer.', 'Spot-correct only where needed.', 'Set only where needed.'];
  if (area === 'eye') return ['Start liner from the outer third.', 'Keep the line thin.', 'Keep the wing short.'];
  return ['Match the reference finish.', 'Stay in a close shade family.', 'Blot lightly to adjust intensity.'];
}

function normalizeMarket(v) {
  const s = String(v || '').trim().toUpperCase();
  if (s === 'US' || s === 'JP') return s;
  return 'US';
}

function renderSkeletonFromKB(inputSkeletons, kb, ctx) {
  const warnings = [];
  let usedFallback = false;
  const market = normalizeMarket(ctx?.market);

  const out = (inputSkeletons || []).map((s) => {
    const doActionIds = Array.isArray(s.doActionIds) ? s.doActionIds : [];
    const variables = defaultVariablesForArea(s.impactArea);
    const doActions = [];
    const techniqueRefs = [];
    const tags = Array.isArray(s.tags) ? [...s.tags] : [];

    for (const id of doActionIds) {
      const card = kb.byId.get(id);
      if (!card) {
        warnings.push(`Missing technique card: ${id} (area=${s.impactArea}).`);
        usedFallback = true;
        continue;
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

      techniqueRefs.push({ id: card.id, area: card.area });
      const renderedSteps = (card.actionTemplate?.steps || [])
        .map((step) => renderTemplateStep(step, variables))
        .filter(Boolean);
      doActions.push(...renderedSteps);

      if (Array.isArray(card.productRoleHints)) {
        for (const hint of card.productRoleHints) tags.push(`role:${String(hint).trim()}`);
      }
    }

    const finalDoActions = uniqueStrings(doActions);
    if (!finalDoActions.length) {
      warnings.push(`No rendered doActions for ${s.impactArea}: using safe fallback steps.`);
      usedFallback = true;
      finalDoActions.push(...fallbackStepsForArea(s.impactArea));
    }

    return {
      ...s,
      doActions: finalDoActions,
      techniqueRefs: techniqueRefs.length ? techniqueRefs : undefined,
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

  return { skeletons: [byArea.base, byArea.eye, byArea.lip], warnings, usedFallback };
}

module.exports = {
  renderSkeletonFromKB,
};
