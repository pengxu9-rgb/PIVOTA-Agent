'use strict';

// Shared failure formatter for the relationship-graph routine scripts.
//
// The failing step's exit code and captured stderr are the ONLY record of WHY a
// run died: the summary JSON lives under an ephemeral /tmp out-dir that is
// destroyed with the container, and the ledger row stores a status, not the
// stderr. Printing just `err.message` (as these scripts used to) left Railway
// logs with "failed at step: <id>" and nothing else — four daily cron failures
// between 2026-08-04 and 2026-08-10 were undiagnosable after the fact for
// exactly this reason. Console output is the durable artifact here, so the
// failure has to describe itself.
//
// This lives in its own module because all three layers of the routine need it
// (cron wrapper -> sync routine -> routine job) and the sync routine already
// requires the routine job for its confirm token; importing the formatter from
// the sync routine would close that cycle.

const DEFAULT_TAIL_CHARS = 12000;

function tailOutput(value, max = DEFAULT_TAIL_CHARS) {
  const text = String(value || '');
  return text.length <= max ? text : text.slice(text.length - max);
}

function formatRoutineFailure(err, { stderrChars = 4000, stdoutChars = 1500 } = {}) {
  if (!err) return 'unknown failure (no error object)';
  const summary = err.summary;
  if (!summary) return err.stack ? err.stack : String(err);

  const lines = [err.message];
  const outDir = summary.summary_path || summary.out_dir;
  if (outDir) lines.push(`summary: ${outDir}`);

  const steps = Array.isArray(summary.steps) ? summary.steps : [];
  // Prefer the step the routine named; fall back to the last failed record so a
  // future failure path that forgets to set failed_step still reports something.
  const failed = steps.find((s) => s && s.id === summary.failed_step)
    || [...steps].reverse().find((s) => s && s.status === 'failed');

  if (failed) {
    const detail = [`exit_code=${failed.exit_code}`];
    if (failed.signal) detail.push(`signal=${failed.signal}`);
    if (failed.timed_out) detail.push(`timed_out=true timeout_ms=${failed.timeout_ms}`);
    if (failed.started_at) detail.push(`started_at=${failed.started_at}`);
    if (failed.completed_at) detail.push(`completed_at=${failed.completed_at}`);
    lines.push(`failed step: ${failed.id} (${detail.join(' ')})`);
    if (failed.command) {
      lines.push(`command: ${failed.command} ${(failed.args || []).join(' ')}`);
    }
    const stderr = tailOutput(failed.stderr_tail, stderrChars).trim();
    lines.push(stderr ? `stderr tail:\n${stderr}` : 'stderr tail: <empty>');
    const stdout = tailOutput(failed.stdout_tail, stdoutChars).trim();
    if (stdout) lines.push(`stdout tail:\n${stdout}`);
  } else {
    lines.push(`failed step: ${summary.failed_step || '<unknown>'} (no step record captured)`);
  }

  // Optional steps (renewal) never abort the run, so their failures are only
  // ever visible here — and a renewal that silently stopped working is itself
  // the kind of thing these logs exist to catch.
  if (Array.isArray(summary.warnings) && summary.warnings.length) {
    lines.push(`warnings: ${summary.warnings.join('; ')}`);
  }
  if (err.ledger_error) {
    lines.push(`ledger error: ${err.ledger_error.message || err.ledger_error}`);
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_TAIL_CHARS,
  formatRoutineFailure,
};
