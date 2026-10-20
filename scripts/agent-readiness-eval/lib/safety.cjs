'use strict';

// WHERE THE HARNESS MAY POINT, AND HOW HARD IT MAY PUSH.
//
// Today every production agent tool call mints attribution click rows (/r links) and can trigger live reads
// against merchant stores. A readiness eval aimed at prod would therefore corrupt attribution and hit
// merchants with synthetic traffic. Until a synthetic-traffic designation exists server-side, the only
// targets this harness accepts without ceremony are local development hosts. Everything else needs an
// explicit target kind AND an explicit allow flag, and the known production hosts additionally need the
// synthetic-flag acknowledgement string — which documents a server-side capability that does not exist yet.
//
// The caps below are COMPILED IN. Config can lower them, never raise them.

const HARD_CAPS = Object.freeze({
  maxRps: 20,
  maxConcurrency: 32,
  maxLoadRequests: 5000,
  maxLoadSeconds: 900,
  maxDiscoveryCalls: 20000,
  minTimeoutMs: 1000,
  maxTimeoutMs: 120000,
});

// Hosts that ARE production. Matching is exact or by subdomain suffix. Anything matching is refused unless
// target kind is prod-synthetic and the synthetic flag acknowledgement is given.
const PRODUCTION_HOST_SUFFIXES = Object.freeze([
  'pivota.cc',
  'pivota.ai',
  'pivota.com',
]);

// The acknowledgement a prod-synthetic run must carry, verbatim. It is a statement the operator makes about
// the SERVER: the API key in use is designated synthetic, so its calls mint no counted click rows and
// trigger no live merchant reads. See docs/runbooks/agent_readiness_eval.md "Target options".
const SYNTHETIC_FLAG_ACK = 'server-excludes-this-key-from-attribution-and-live-reads';

// COMPILED-IN: does the server-side synthetic-traffic designation exist yet? It does not (2026-10-20): a
// production tool call mints attribution click rows and can trigger live merchant reads whoever calls it. Until
// a reviewed change ships that designation AND flips this constant, production hosts are refused outright —
// the acknowledgement flag below is not enough on its own, because a string in a public repo is a guard
// against accidents, not a control.
const SYNTHETIC_TRAFFIC_SERVER_SUPPORT = false;

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '').replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function isLocalDevHost(host) {
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  return host.endsWith('.localhost') || host.endsWith('.test');
}

function isProductionHost(host) {
  if (!host) return false;
  return PRODUCTION_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Decide whether a run may proceed against the configured target. Pure.
 * @returns {{ ok: boolean, problems: string[], notes: string[] }}
 */
function checkTarget(config) {
  const problems = [];
  const notes = [];
  const host = hostOf(config.baseUrl);
  // A Host header override can route a local listener to a production vhost's code path; it can also be used
  // to address prod through an IP. Both are judged.
  const hostHeader = config.hostHeader ? String(config.hostHeader).toLowerCase().split(':')[0] : null;
  if (!host) {
    if (config.mode === 'run') problems.push('no target host');
    return { ok: problems.length === 0, problems, notes };
  }
  const local = isLocalDevHost(host);
  const prod = isProductionHost(host) || (!local && hostHeader && isProductionHost(hostHeader));

  if (local) {
    notes.push(`target ${host} is a local development host`);
    if (config.targetKind !== 'local') notes.push(`target kind "${config.targetKind}" on a local host`);
  } else {
    if (!config.allowRemote) {
      problems.push(
        `target ${host} is not a local development host; pass --allow-remote-target (READINESS_EVAL_ALLOW_REMOTE=1) ` +
          'with --target-kind prod-clone|prod-synthetic',
      );
    }
    if (config.targetKind === 'local') {
      problems.push(`target kind "local" but ${host} is not a local development host`);
    }
  }

  if (prod) {
    if (!SYNTHETIC_TRAFFIC_SERVER_SUPPORT) {
      problems.push(
        `${host} is a PRODUCTION host and the server-side synthetic-traffic designation does not exist yet ` +
          '(SYNTHETIC_TRAFFIC_SERVER_SUPPORT=false in scripts/agent-readiness-eval/lib/safety.cjs). Refused.',
      );
    }
    if (config.targetKind !== 'prod-synthetic') {
      problems.push(
        `${host} is a PRODUCTION host. Production tool calls mint attribution click rows and can trigger live ` +
          'merchant reads; only --target-kind prod-synthetic may address it, and only once the server-side ' +
          'synthetic-traffic designation exists.',
      );
    }
    if (config.syntheticFlagAck !== SYNTHETIC_FLAG_ACK) {
      problems.push(
        `production target requires --synthetic-flag-ack ${SYNTHETIC_FLAG_ACK} — a statement that the server ` +
          'excludes this API key from attribution and live merchant reads. That capability does not exist today.',
      );
    }
    if (config.auth === 'none') {
      problems.push('a production target cannot be run anonymously: the synthetic designation is keyed on the caller');
    }
  }
  if (config.targetKind === 'prod-synthetic' && config.syntheticFlagAck !== SYNTHETIC_FLAG_ACK) {
    problems.push(`target kind prod-synthetic requires --synthetic-flag-ack ${SYNTHETIC_FLAG_ACK}`);
  }
  if (config.timeoutMs < HARD_CAPS.minTimeoutMs || config.timeoutMs > HARD_CAPS.maxTimeoutMs) {
    problems.push(`timeout ${config.timeoutMs}ms outside [${HARD_CAPS.minTimeoutMs}, ${HARD_CAPS.maxTimeoutMs}]`);
  }
  if (config.concurrency > HARD_CAPS.maxConcurrency) {
    problems.push(`concurrency ${config.concurrency} exceeds hard cap ${HARD_CAPS.maxConcurrency}`);
  }
  return { ok: problems.length === 0, problems, notes };
}

/** Load-mode settings vs the compiled-in caps. Pure. */
function checkLoad(load) {
  const problems = [];
  if (!load || !load.enabled) return { ok: true, problems };
  if (!(load.rpsStart > 0) || !(load.rpsEnd > 0)) problems.push('load rps must be > 0');
  if (Math.max(load.rpsStart, load.rpsEnd) > HARD_CAPS.maxRps) {
    problems.push(`load rps ${Math.max(load.rpsStart, load.rpsEnd)} exceeds hard cap ${HARD_CAPS.maxRps}`);
  }
  if (load.maxConcurrency > HARD_CAPS.maxConcurrency) {
    problems.push(`load concurrency ${load.maxConcurrency} exceeds hard cap ${HARD_CAPS.maxConcurrency}`);
  }
  if (load.maxRequests > HARD_CAPS.maxLoadRequests) {
    problems.push(`load max requests ${load.maxRequests} exceeds hard cap ${HARD_CAPS.maxLoadRequests}`);
  }
  const seconds = load.rampSeconds + load.holdSeconds;
  if (seconds > HARD_CAPS.maxLoadSeconds) problems.push(`load duration ${seconds}s exceeds hard cap ${HARD_CAPS.maxLoadSeconds}s`);
  if (!(seconds > 0)) problems.push('load duration must be > 0');
  if (!(load.breakerErrorRate > 0 && load.breakerErrorRate <= 1)) problems.push('breaker error rate must be within (0,1]');
  return { ok: problems.length === 0, problems };
}

/**
 * The kill switch: a file whose existence stops the run, a process signal, and the env var at start.
 * `check()` is cheap and is called before every request.
 */
function createKillSwitch({ killFile, env = process.env, fs = require('node:fs'), onSignal = true } = {}) {
  let killedReason = env.READINESS_EVAL_KILL && /^(1|true|yes|on)$/i.test(env.READINESS_EVAL_KILL)
    ? 'READINESS_EVAL_KILL set'
    : null;
  const handlers = [];
  if (onSignal) {
    for (const sig of ['SIGINT', 'SIGTERM']) {
      const h = () => {
        killedReason = killedReason || `received ${sig}`;
      };
      process.once(sig, h);
      handlers.push([sig, h]);
    }
  }
  return {
    check() {
      if (killedReason) return killedReason;
      if (killFile) {
        try {
          if (fs.existsSync(killFile)) killedReason = `kill file present: ${killFile}`;
        } catch {
          // An unreadable path is not a kill.
        }
      }
      return killedReason;
    },
    trip(reason) {
      killedReason = killedReason || reason;
    },
    dispose() {
      for (const [sig, h] of handlers) process.removeListener(sig, h);
    },
  };
}

module.exports = {
  HARD_CAPS,
  PRODUCTION_HOST_SUFFIXES,
  SYNTHETIC_FLAG_ACK,
  SYNTHETIC_TRAFFIC_SERVER_SUPPORT,
  hostOf,
  isLocalDevHost,
  isProductionHost,
  checkTarget,
  checkLoad,
  createKillSwitch,
};
