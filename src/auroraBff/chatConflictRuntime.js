function createChatConflictRuntime(options = {}) {
  const {
    looksLikeCompatibilityOrConflictQuestion = () => false,
    buildLocalCompatibilitySimulationInput = () => null,
    simulateConflicts = () => ({ safe: true, conflicts: [], summary: '' }),
    buildHeatmapStepsFromRoutine = () => [],
    buildConflictHeatmapV1 = () => ({ schema_version: 'aurora.ui.conflict_heatmap.v1' }),
    buildRouteAwareAssistantText = () => '',
    addEmotionalPreambleToAssistantText = (text) => text,
    stateChangeAllowed = () => false,
    CONFLICT_HEATMAP_V1_ENABLED = false,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat conflict runtime missing dependency: ${name}`);
  }

  async function maybeBuildConflictEnvelope(args = {}) {
    const {
      ctx = {},
      message = '',
      profile = null,
      nextStateOverride = null,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    } = args;

    const looksLikeCompatibilityOrConflictQuestionFn = requireFunction(
      'looksLikeCompatibilityOrConflictQuestion',
      looksLikeCompatibilityOrConflictQuestion,
    );
    const buildLocalCompatibilitySimulationInputFn = requireFunction(
      'buildLocalCompatibilitySimulationInput',
      buildLocalCompatibilitySimulationInput,
    );
    const simulateConflictsFn = requireFunction('simulateConflicts', simulateConflicts);
    const buildHeatmapStepsFromRoutineFn = requireFunction(
      'buildHeatmapStepsFromRoutine',
      buildHeatmapStepsFromRoutine,
    );
    const buildConflictHeatmapV1Fn = requireFunction('buildConflictHeatmapV1', buildConflictHeatmapV1);
    const buildRouteAwareAssistantTextFn = requireFunction('buildRouteAwareAssistantText', buildRouteAwareAssistantText);
    const addEmotionalPreambleToAssistantTextFn = requireFunction(
      'addEmotionalPreambleToAssistantText',
      addEmotionalPreambleToAssistantText,
    );
    const stateChangeAllowedFn = requireFunction('stateChangeAllowed', stateChangeAllowed);
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction('makeChatAssistantMessage', makeChatAssistantMessage);
    const makeEventFn = requireFunction('makeEvent', makeEvent);

    if (
      !looksLikeCompatibilityOrConflictQuestionFn(message) ||
      !(
        ctx.trigger_source === 'text' ||
        ctx.trigger_source === 'text_explicit' ||
        ctx.trigger_source === 'chip' ||
        ctx.trigger_source === 'action'
      )
    ) {
      return { handled: false, envelope: null };
    }

    const simInput = buildLocalCompatibilitySimulationInputFn({ message });
    if (!simInput) {
      return {
        handled: true,
        envelope: buildEnvelopeFn(ctx, {
          assistant_message: makeChatAssistantMessageFn(
            ctx.lang === 'CN'
              ? '我没能从这句话里稳定识别出两个可比较的步骤。请用“产品A + 产品B 同晚可以吗？”这种格式再发一次。'
              : 'I could not reliably parse two comparable steps from this message. Please retry in this format: "Can I use Product A + Product B in the same night?"',
          ),
          suggested_chips: [],
          cards: [
            {
              card_id: `conflict_parse_${ctx.request_id}`,
              type: 'confidence_notice',
              payload: {
                reason: 'conflict_input_parse_failed',
                non_blocking: true,
                severity: 'warn',
                message:
                  ctx.lang === 'CN'
                    ? '冲突模拟输入解析失败，已返回诊断提示。'
                    : 'Conflict simulation input parse failed; returning a diagnostic hint.',
                details: ['conflict_input_parse_failed'],
                actions: ['rephrase_conflict_query'],
              },
            },
          ],
          session_patch:
            nextStateOverride && stateChangeAllowedFn(ctx.trigger_source) ? { next_state: nextStateOverride } : {},
          events: [makeEventFn(ctx, 'conflict_input_parse_failed', { trigger_source: ctx.trigger_source })],
        }),
      };
    }

    const { routine, testProduct } = simInput;
    const sim = simulateConflictsFn({ routine, testProduct, language: ctx.lang });
    const simPayload = { safe: sim.safe, conflicts: sim.conflicts, summary: sim.summary };
    const heatmapSteps = buildHeatmapStepsFromRoutineFn(routine, { testProduct });
    const heatmapPayload = CONFLICT_HEATMAP_V1_ENABLED
      ? buildConflictHeatmapV1Fn({ routineSimulation: simPayload, routineSteps: heatmapSteps })
      : { schema_version: 'aurora.ui.conflict_heatmap.v1' };

    const routeText =
      buildRouteAwareAssistantTextFn({
        route: 'conflict',
        payload: simPayload,
        language: ctx.lang,
        profile,
      }) ||
      (ctx.lang === 'CN'
        ? sim.safe
          ? '未发现明显冲突（见下方冲突热力图）。如果出现刺痛/爆皮，优先降频并加强保湿。'
          : '检测到可能的叠加风险（见下方冲突热力图）。更稳妥：错开晚用/隔天用，并从低频开始。'
        : sim.safe
          ? 'No major conflicts detected (see the heatmap below). If you feel irritation, reduce frequency and moisturize.'
          : 'Potential conflict detected (see the heatmap below). Safer: alternate nights and start low frequency.');
    const msgText = addEmotionalPreambleToAssistantTextFn(routeText, {
      language: ctx.lang,
      profile,
      seed: ctx.request_id,
    });

    const events = [
      makeEventFn(ctx, 'simulate_conflict', { safe: sim.safe, conflicts: sim.conflicts.length, source: 'local_chat' }),
    ];
    if (CONFLICT_HEATMAP_V1_ENABLED) {
      events.push(
        makeEventFn(ctx, 'aurora_conflict_heatmap_impression', {
          schema_version: heatmapPayload.schema_version,
          state: heatmapPayload.state,
          num_steps: Array.isArray(heatmapPayload.axes?.rows?.items) ? heatmapPayload.axes.rows.items.length : 0,
          num_cells_nonzero: Array.isArray(heatmapPayload.cells?.items) ? heatmapPayload.cells.items.length : 0,
          num_unmapped_conflicts: Array.isArray(heatmapPayload.unmapped_conflicts)
            ? heatmapPayload.unmapped_conflicts.length
            : 0,
          max_severity: Math.max(
            0,
            ...((Array.isArray(heatmapPayload.cells?.items) ? heatmapPayload.cells.items : []).map(
              (cell) => Number(cell?.severity) || 0,
            )),
            ...((Array.isArray(heatmapPayload.unmapped_conflicts) ? heatmapPayload.unmapped_conflicts : []).map(
              (conflict) => Number(conflict?.severity) || 0,
            )),
          ),
          routine_simulation_safe: Boolean(simPayload.safe),
          routine_conflict_count: Array.isArray(simPayload.conflicts) ? simPayload.conflicts.length : 0,
          trigger_source: ctx.trigger_source,
        }),
      );
    }

    return {
      handled: true,
      envelope: buildEnvelopeFn(ctx, {
        assistant_message: makeChatAssistantMessageFn(msgText, 'markdown'),
        suggested_chips: [],
        cards: [
          { card_id: `sim_${ctx.request_id}`, type: 'routine_simulation', payload: simPayload },
          { card_id: `heatmap_${ctx.request_id}`, type: 'conflict_heatmap', payload: heatmapPayload },
        ],
        session_patch:
          nextStateOverride && stateChangeAllowedFn(ctx.trigger_source) ? { next_state: nextStateOverride } : {},
        events,
      }),
    };
  }

  return {
    maybeBuildConflictEnvelope,
  };
}

module.exports = {
  createChatConflictRuntime,
};
