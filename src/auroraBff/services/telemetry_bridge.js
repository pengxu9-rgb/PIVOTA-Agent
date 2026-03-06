/**
 * Bridge between skill telemetry and Pivota agent_metrics system.
 * Emits skill execution data in the format expected by
 * pivota_infra/services/agent_metrics_collector.py
 */

class TelemetryBridge {
  constructor(config = {}) {
    this._metricsEndpoint = config.metricsEndpoint || '/admin/metrics/skill-execution';
    this._buffer = [];
    this._flushIntervalMs = config.flushIntervalMs || 5000;
    this._maxBufferSize = config.maxBufferSize || 100;
  }

  record(skillResponse) {
    if (!skillResponse?.telemetry) return;

    const entry = {
      timestamp: new Date().toISOString(),
      call_id: skillResponse.telemetry.call_id,
      skill_id: skillResponse.telemetry.skill_id,
      skill_version: skillResponse.telemetry.skill_version,
      task_mode: skillResponse.telemetry.task_mode,
      elapsed_ms: skillResponse.telemetry.elapsed_ms,
      llm_calls: skillResponse.telemetry.llm_calls,
      prompt_hash: skillResponse.telemetry.prompt_hash,
      quality_ok: skillResponse.quality?.quality_ok ?? null,
      preconditions_met: skillResponse.quality?.preconditions_met ?? null,
      issue_count: skillResponse.quality?.issues?.length || 0,
      card_count: skillResponse.cards?.length || 0,
      next_action_count: skillResponse.next_actions?.length || 0,
    };

    this._buffer.push(entry);

    if (this._buffer.length >= this._maxBufferSize) {
      this.flush();
    }
  }

  flush() {
    if (this._buffer.length === 0) return;

    const batch = [...this._buffer];
    this._buffer = [];

    this._emit(batch).catch((err) => {
      console.error('[TelemetryBridge] flush error:', err.message);
      this._buffer.unshift(...batch);
    });
  }

  async _emit(batch) {
    // In production, POST to pivota_infra metrics endpoint:
    // await fetch(this._metricsEndpoint, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ skill_executions: batch }),
    // });
    //
    // For now, log to stdout for development visibility:
    for (const entry of batch) {
      console.log(
        `[skill_metric] ${entry.skill_id} v${entry.skill_version} ` +
        `${entry.elapsed_ms}ms llm=${entry.llm_calls} ` +
        `quality=${entry.quality_ok} issues=${entry.issue_count}`
      );
    }
  }

  getBufferSize() {
    return this._buffer.length;
  }

  getStats() {
    return {
      buffer_size: this._buffer.length,
      flush_interval_ms: this._flushIntervalMs,
      max_buffer_size: this._maxBufferSize,
    };
  }
}

module.exports = TelemetryBridge;
