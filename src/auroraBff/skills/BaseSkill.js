const crypto = require('crypto');

function uuidv4() {
  return crypto.randomUUID();
}

class BaseSkill {
  constructor(skillId, version = '1.0.0') {
    this._skillId = skillId;
    this._version = version;
  }

  get skillId() {
    return this._skillId;
  }

  get version() {
    return this._version;
  }

  /**
   * Override in subclass. Return { met: boolean, failures: [] }.
   */
  async checkPreconditions(_request) {
    return { met: true, failures: [] };
  }

  /**
   * Override in subclass. Core skill logic. Must return partial response
   * with cards, ops, and next_actions.
   */
  async execute(_request, _llmGateway) {
    throw new Error(`${this._skillId}: execute() not implemented`);
  }

  /**
   * Override in subclass for skill-specific output validation.
   * Return { quality_ok, issues[] }.
   */
  async validateOutput(response, _request) {
    const issues = [];

    if (!response.next_actions || response.next_actions.length === 0) {
      issues.push({
        code: 'MISSING_NEXT_ACTIONS',
        message: 'next_actions must be non-empty',
        severity: 'error',
      });
    }

    return {
      quality_ok: issues.filter((i) => i.severity === 'error').length === 0,
      issues,
    };
  }

  /**
   * Full execution pipeline: preconditions -> execute -> validate -> wrap.
   */
  async run(request, llmGateway) {
    const startMs = Date.now();
    const callId = uuidv4();

    const precondResult = await this.checkPreconditions(request);
    if (!precondResult.met) {
      return this._buildEmptyState(callId, startMs, precondResult.failures);
    }

    const rawResponse = await this.execute(request, llmGateway);

    const validation = await this.validateOutput(rawResponse, request);

    return {
      cards: rawResponse.cards || [],
      ops: rawResponse.ops || {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {},
        experiment_events: [],
      },
      quality: {
        schema_valid: true,
        quality_ok: validation.quality_ok,
        issues: validation.issues,
        preconditions_met: true,
        precondition_failures: [],
      },
      telemetry: {
        call_id: callId,
        skill_id: this._skillId,
        skill_version: this._version,
        prompt_hash: rawResponse._promptHash || null,
        task_mode: rawResponse._taskMode || this._skillId.split('.')[0],
        elapsed_ms: Date.now() - startMs,
        llm_calls: rawResponse._llmCalls || 0,
      },
      next_actions: rawResponse.next_actions || [
        { action_type: 'show_chip', label: { en: 'Start over', zh: '重新开始' } },
      ],
    };
  }

  _buildEmptyState(callId, startMs, failures) {
    const firstFailure = failures[0] || {};
    const nextActions = [];

    if (firstFailure.on_fail_target) {
      nextActions.push({
        action_type: 'navigate_skill',
        target_skill_id: firstFailure.on_fail_target,
        label: {
          en: firstFailure.on_fail_message_en || 'Continue',
          zh: firstFailure.on_fail_message_zh || '继续',
        },
      });
    } else {
      nextActions.push({
        action_type: 'request_input',
        label: {
          en: firstFailure.on_fail_message_en || 'Please provide more information.',
          zh: firstFailure.on_fail_message_zh || '请提供更多信息。',
        },
      });
    }

    return {
      cards: [
        {
          card_type: 'empty_state',
          sections: [
            {
              type: 'empty_state_message',
              message_en: firstFailure.reason || 'Precondition not met',
              message_zh: firstFailure.on_fail_message_zh || '前置条件未满足',
            },
          ],
        },
      ],
      ops: {
        thread_ops: [],
        profile_patch: {},
        routine_patch: {},
        experiment_events: [],
      },
      quality: {
        schema_valid: true,
        quality_ok: false,
        issues: [],
        preconditions_met: false,
        precondition_failures: failures,
      },
      telemetry: {
        call_id: callId,
        skill_id: this._skillId,
        skill_version: this._version,
        prompt_hash: null,
        task_mode: this._skillId.split('.')[0],
        elapsed_ms: Date.now() - startMs,
        llm_calls: 0,
      },
      next_actions: nextActions,
    };
  }
}

module.exports = BaseSkill;
