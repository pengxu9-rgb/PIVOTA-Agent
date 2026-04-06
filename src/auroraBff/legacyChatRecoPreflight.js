function createLegacyChatRecoPreflightRuntime(deps = {}) {
  const {
    resolveSafetyGateActionV2,
    mergePendingSafetyAdvisory,
    persistSafetyPromptAskedOnce,
    buildLegacyRecoSafetyGateEnvelope,
    buildSafetyNoticeText,
    profileCompleteness,
    buildPendingClarificationForGate,
    emitPendingClarificationPatch,
    buildDiagnosisChips,
    evaluateSafetyBoundary,
    buildConfidenceNoticeCardPayload,
    maybeBuildLegacyTravelRecoEnvelope,
    recordAuroraSkinFlowMetric,
    recordAuroraRecoEntrySource,
    AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED,
  } = deps;

  async function runLegacyChatRecoPreflight({
    ctx,
    message,
    profile,
    logger,
    canonicalIntent,
    safetyDecision,
    travelRecoHandoff,
    travelSkillsContracts,
    travelRecoContext,
    recoTaskMode,
    recentLogs,
    recoEntrySourceDetail,
    actionId,
    recoRequestMessage,
    includeAlternatives,
    effectiveRecoEntrySourceDetail,
  } = {}) {
    let pendingClarificationPatchOverride = undefined;

    recordAuroraSkinFlowMetric({ stage: 'reco_request', hit: true });
    recordAuroraRecoEntrySource({ source: effectiveRecoEntrySourceDetail });

    const recoSafetyGate = resolveSafetyGateActionV2({
      safety: safetyDecision,
      profileValue: profile,
      conflictIntent: false,
    });
    if (recoSafetyGate.mode === 'inline' && recoSafetyGate.advisory) {
      mergePendingSafetyAdvisory(recoSafetyGate.advisory);
      await persistSafetyPromptAskedOnce(recoSafetyGate.ask_once_fields);
    }
    if (recoSafetyGate.mode === 'block') {
      const safetyText = buildSafetyNoticeText(safetyDecision);
      return {
        envelope: buildLegacyRecoSafetyGateEnvelope({
          ctx,
          assistantText:
            safetyText ||
            (ctx.lang === 'CN'
              ? '当前存在安全风险，先不输出激进推荐。'
              : 'Current safety risk detected, so I will not output aggressive recommendations.'),
          cardId: `safety_${ctx.request_id}`,
          payload: {
            severity: 'block',
            message:
              ctx.lang === 'CN'
                ? '检测到安全风险，已切换保守路径。'
                : 'Safety risk detected; switched to conservative path.',
            details: [
              ...(Array.isArray(safetyDecision.reasons) ? safetyDecision.reasons.slice(0, 3) : []),
              ...(Array.isArray(safetyDecision.safe_alternatives)
                ? safetyDecision.safe_alternatives.slice(0, 3)
                : []),
            ],
            actions: ['safe_alternatives', 'profile_update'],
          },
          eventName: 'safety_gate_block',
          eventData: { intent: canonicalIntent.intent, block_level: safetyDecision.block_level },
          suggestedChips: [
            {
              chip_id: 'chip.start.ingredients',
              label: ctx.lang === 'CN' ? '成分科学（更安全替代）' : 'Ingredient science (safe alternatives)',
              kind: 'quick_reply',
              data: {
                reply_text:
                  ctx.lang === 'CN'
                    ? '我想看更安全替代方案（成分机制）'
                    : 'Show me safer alternatives with ingredient mechanism',
              },
            },
            {
              chip_id: 'chip.start.routine',
              label: ctx.lang === 'CN' ? '先做温和routine' : 'Build gentle routine first',
              kind: 'quick_reply',
              data: {
                reply_text:
                  ctx.lang === 'CN'
                    ? '先给我一套温和修护routine'
                    : 'Build a gentle barrier-first routine for me',
              },
            },
          ],
        }),
        profileScore: null,
        profileMissing: [],
        refinementChips: [],
        pendingClarificationPatchOverride,
      };
    }

    const { score: profileScore, missing: profileMissing } = profileCompleteness(profile);
    const hardRequiredFields = ['skinType', 'sensitivity', 'barrierStatus', 'goals'];
    const hardRequiredMissing = hardRequiredFields.filter((field) =>
      Array.isArray(profileMissing) ? profileMissing.includes(field) : false,
    );
    if (hardRequiredMissing.length > 0 && AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED) {
      const pendingFromGate = buildPendingClarificationForGate({
        language: ctx.lang,
        missing: hardRequiredMissing,
        message,
        wants: 'recommendation',
      });
      if (pendingFromGate) {
        const sessionPatch = {};
        emitPendingClarificationPatch(sessionPatch, pendingFromGate);
        pendingClarificationPatchOverride =
          sessionPatch.pending_clarification || pendingClarificationPatchOverride;
      }
    }

    const refinementMissing = (Array.isArray(profileMissing) ? profileMissing : []).filter(
      (f) => f === 'skinType' || f === 'sensitivity',
    );
    const refinementChips = refinementMissing.length
      ? buildDiagnosisChips(ctx.lang, refinementMissing)
      : [];

    const safety = evaluateSafetyBoundary({
      message,
      profile,
      language: ctx.lang,
    });
    if (safety.block) {
      logger?.info({ kind: 'metric', name: 'aurora.skin.safety_block_rate', value: 1 }, 'metric');
      recordAuroraSkinFlowMetric({ stage: 'reco_safety_block', hit: true });
      return {
        envelope: buildLegacyRecoSafetyGateEnvelope({
          ctx,
          assistantText: safety.assistant_message,
          cardId: `conf_${ctx.request_id}`,
          payload: buildConfidenceNoticeCardPayload({
            language: ctx.lang,
            reason: 'safety_block',
            confidence: { score: 0, level: 'low', rationale: ['medical_boundary'] },
            severity: 'block',
            actions: ['seek_medical_care', 'pause_strong_actives', 'return_after_stabilization'],
            details: safety.notice_bullets,
          }),
          eventName: 'recos_requested',
          eventData: { explicit: true, blocked: true, reason: 'safety_boundary' },
          suggestedChips: [],
        }),
        profileScore,
        profileMissing,
        refinementChips,
        pendingClarificationPatchOverride,
      };
    }

    const travelRecoEnvelope = maybeBuildLegacyTravelRecoEnvelope({
      ctx,
      travelRecoHandoff,
      travelSkillsContracts,
      travelRecoContext,
      profile,
      recoTaskMode,
      recentLogs,
      recoEntrySourceDetail,
      actionId,
      recoRequestMessage,
      includeAlternatives,
      refinementChips,
    });
    if (travelRecoEnvelope) {
      return {
        envelope: travelRecoEnvelope,
        profileScore,
        profileMissing,
        refinementChips,
        pendingClarificationPatchOverride,
      };
    }

    return {
      envelope: null,
      profileScore,
      profileMissing,
      refinementChips,
      pendingClarificationPatchOverride,
    };
  }

  return {
    runLegacyChatRecoPreflight,
  };
}

module.exports = {
  createLegacyChatRecoPreflightRuntime,
};
