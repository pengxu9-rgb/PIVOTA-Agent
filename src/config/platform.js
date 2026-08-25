'use strict';

/**
 * Platform abstraction for deployment-environment detection.
 *
 * WHY THIS EXISTS
 * ---------------
 * Production does NOT set `NODE_ENV`. For several safety-relevant paths the REAL
 * production guard has been `RAILWAY_ENVIRONMENT === 'production'` — the mock/fixture
 * refusals in `auroraDecisionClient` and `auroraBff/routes`, and the forced-rollout-variant
 * header refusal in `auroraBff/rollout`. Those reads are platform-specific: on Google
 * Cloud Run (the late-September target, us-west1) `RAILWAY_*` is unset, so every one of
 * those guards would silently evaluate to "not production" and turn OFF in production.
 *
 * This module is the ONE place that knows which PaaS we are on. Call sites ask questions
 * ("am I in production?", "what is the commit sha?") instead of naming a vendor's env var,
 * so the Railway -> Cloud Run move becomes a config change rather than a code sweep.
 *
 * TWO DIFFERENT QUESTIONS, TWO DIFFERENT ANSWERS
 * ----------------------------------------------
 * `platformEnv()` resolves ONE label by strict precedence. It is for logs, health payloads
 * and anything that reports which environment this is.
 *
 * `isProduction()` is a GUARD, and guards must fail toward "yes, production". It is the
 * UNION of every production signal, not the precedence winner. That union is not a
 * widening for its own sake — it is exactly what the call sites did before this module:
 * `NODE_ENV === 'production' || RAILWAY_ENVIRONMENT === 'production' || VERCEL_ENV === 'production'`.
 * A strict-precedence `isProduction()` would REGRESS them: a Railway staging box that also
 * sets `NODE_ENV=production` (a common Node perf setting) is production-like TODAY, and
 * precedence alone would answer "staging" and unlock the mock upstreams there.
 *
 * FAIL CLOSED
 * -----------
 * On a managed platform (Cloud Run's `K_SERVICE`, or any `RAILWAY_*`) with no resolvable
 * environment name, `platformEnv()` answers "production" and logs loudly. A misconfigured
 * deploy therefore gets the STRICTEST behavior, never the loosest. `requirePlatformEnv()`
 * turns that same condition into a boot-time throw so the deploy dies instead of serving
 * traffic with unknown guard state. Locally and under tests (nothing set) the answer is
 * "development" and nothing throws.
 *
 * ENV IS READ AT CALL TIME. Nothing here is captured at import time, so a test that
 * mutates `process.env` between calls sees the change without `jest.resetModules()`.
 * Every accessor also takes an optional `env` object for call sites that already inject one.
 */

/** The four environment labels the rest of the codebase is allowed to see. */
const PLATFORM_ENVS = Object.freeze({
  PRODUCTION: 'production',
  STAGING: 'staging',
  DEVELOPMENT: 'development',
  TEST: 'test',
});

/** The three platforms this service is known to run on. */
const PLATFORM_NAMES = Object.freeze({
  RAILWAY: 'railway',
  CLOUD_RUN: 'cloud_run',
  LOCAL: 'local',
});

/**
 * Environment-name sources, in precedence order, for `platformEnv()`.
 *
 * `PIVOTA_ENV` leads deliberately: it is the vendor-neutral override, and it is the ONLY
 * way a Cloud Run revision can name its environment (Cloud Run injects `K_SERVICE` /
 * `K_REVISION` / `K_CONFIGURATION` but nothing that says "production").
 *
 * `NODE_ENV` sits BELOW the Railway vars, not above: production leaves `NODE_ENV` unset,
 * so treating it as authoritative is how this class of bug got here in the first place.
 */
const ENV_NAME_SOURCES = Object.freeze([
  'PIVOTA_ENV',
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_ENVIRONMENT_NAME',
  'NODE_ENV',
  'APP_ENV',
  'VERCEL_ENV',
]);

/**
 * Vars whose value being "production" makes `isProduction()` true regardless of precedence.
 * This is the fail-safe union described above; keep it a SUPERSET of `ENV_NAME_SOURCES`
 * that name an environment, never a subset.
 */
const PRODUCTION_SIGNAL_SOURCES = ENV_NAME_SOURCES;

/** Presence of any of these means "a managed platform booted this process". */
const MANAGED_PLATFORM_MARKERS = Object.freeze([
  // Cloud Run.
  'K_SERVICE',
  'K_REVISION',
  'K_CONFIGURATION',
  // Railway.
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_SERVICE_NAME',
  'RAILWAY_DEPLOYMENT_ID',
  'RAILWAY_PROJECT_ID',
  'RAILWAY_GIT_COMMIT_SHA',
]);

const RAILWAY_MARKERS = Object.freeze(
  MANAGED_PLATFORM_MARKERS.filter((key) => key.startsWith('RAILWAY_')),
);
const CLOUD_RUN_MARKERS = Object.freeze(
  MANAGED_PLATFORM_MARKERS.filter((key) => key.startsWith('K_')),
);

function readEnv(env) {
  return env && typeof env === 'object' ? env : process.env;
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function token(value) {
  return trimmed(value).toLowerCase();
}

function firstNonEmpty(env, keys) {
  for (const key of keys) {
    const value = trimmed(env[key]);
    if (value) return { value, source: key };
  }
  return { value: '', source: null };
}

function hasAny(env, keys) {
  return keys.some((key) => trimmed(env[key]) !== '');
}

/**
 * Map a raw environment string onto one of the four labels.
 *
 * Returns null for a value this module does not recognize, so an unknown label is treated
 * as "unresolved" (and therefore fail-closed on a managed platform) rather than being
 * quietly bucketed as development.
 */
function normalizeEnvName(value) {
  const t = token(value);
  if (!t) return null;
  if (t === 'production' || t === 'prod') return PLATFORM_ENVS.PRODUCTION;
  if (t === 'staging' || t === 'stage' || t === 'preview') return PLATFORM_ENVS.STAGING;
  if (t === 'test' || t === 'testing') return PLATFORM_ENVS.TEST;
  if (t === 'development' || t === 'dev' || t === 'local') return PLATFORM_ENVS.DEVELOPMENT;
  return null;
}

function isProductionToken(value) {
  return normalizeEnvName(value) === PLATFORM_ENVS.PRODUCTION;
}

const warnedMessages = new Set();

function warnOnce(message, details) {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  try {
    // console, not the pino logger: this module must stay dependency-free so it can be
    // required from anywhere (including the logger's own consumers) without a cycle.
    console.error(`[platform] ${message}`, details ? JSON.stringify(details) : '');
  } catch {
    // Logging must never be the reason a guard fails to evaluate.
  }
}

/** Test-only: forget which fail-closed warnings have already been emitted. */
function resetPlatformWarnings() {
  warnedMessages.clear();
}

/**
 * THE COMMIT STAMPED INTO THE IMAGE, or null outside a stamped image.
 *
 * Written by the root `Dockerfile` from the `COMMIT_SHA` build arg that
 * `infra/gcp/cloudbuild.gateway.yaml` passes. It exists because the deploy-time env var
 * alone was not enough: `gcloud run deploy --image X` with no env flag INHERITS the
 * previous revision's environment, so on 2026-08-25 a revision ran the `17e7cfa8` image
 * while `PIVOTA_COMMIT_SHA` still said `6aa49526db95`. /health under-reported the deployed
 * commit by 7, and `gateway-prod-drift.yml` — whose entire job is comparing that value to
 * main — computed "30 commits behind" against a true 23. A stale stamp that happens to
 * MATCH main would be worse still: the alarm goes green over undeployed code.
 *
 * A FILE, NOT AN ENV. `--set-env-vars` / `--update-env-vars` can override an image `ENV`,
 * so that guarantee would last only until someone set the name. Nothing in a Cloud Run
 * deploy can rewrite a file inside the image, so this value cannot disagree with the code
 * it ships beside. The path is a module constant for the same reason: an env-overridable
 * path would hand back the redirection this is meant to remove.
 *
 * Read once and cached. This module documents that env is read at CALL time and nothing is
 * captured at import; the file is the one exception, and it is a safe one — the file cannot
 * change without the process being replaced along with it. Tests use
 * `setBakedCommitShaFileForTests`.
 */
const IMAGE_COMMIT_SHA_FILE = '/app/.image_commit_sha';
const UNREAD = Symbol('unread');
let imageCommitShaFile = IMAGE_COMMIT_SHA_FILE;
let bakedCommitShaCache = UNREAD;

function bakedCommitSha() {
  if (bakedCommitShaCache === UNREAD) {
    try {
      // Required lazily so the module stays loadable in any runtime that lacks `node:fs`
      // (and so requiring it can never be the reason a guard fails to evaluate).
      bakedCommitShaCache = trimmed(require('node:fs').readFileSync(imageCommitShaFile, 'utf8')) || null;
    } catch {
      // Not running from a stamped image — local dev, tests, or an image built without the
      // build arg (the Dockerfile defaults it to empty). The env chain covers those.
      bakedCommitShaCache = null;
    }
  }
  return bakedCommitShaCache;
}

/**
 * Test-only: point the baked-sha reader at another file and forget the cached read.
 * Call with no argument to restore the real image path.
 */
function setBakedCommitShaFileForTests(filePath) {
  imageCommitShaFile = filePath === undefined ? IMAGE_COMMIT_SHA_FILE : filePath;
  bakedCommitShaCache = UNREAD;
}

/** True when a managed PaaS (Railway or Cloud Run) started this process. */
function isManagedPlatform(env) {
  return hasAny(readEnv(env), MANAGED_PLATFORM_MARKERS);
}

/**
 * Which PaaS is running this process: "railway" | "cloud_run" | "local".
 *
 * `PIVOTA_PLATFORM` overrides, so a migration can be rehearsed from either side.
 */
function platformName(env) {
  const e = readEnv(env);
  const override = token(e.PIVOTA_PLATFORM);
  if (override === PLATFORM_NAMES.RAILWAY) return PLATFORM_NAMES.RAILWAY;
  if (override === PLATFORM_NAMES.CLOUD_RUN || override === 'cloudrun' || override === 'gcp') {
    return PLATFORM_NAMES.CLOUD_RUN;
  }
  if (override === PLATFORM_NAMES.LOCAL) return PLATFORM_NAMES.LOCAL;
  if (hasAny(e, RAILWAY_MARKERS)) return PLATFORM_NAMES.RAILWAY;
  if (hasAny(e, CLOUD_RUN_MARKERS)) return PLATFORM_NAMES.CLOUD_RUN;
  return PLATFORM_NAMES.LOCAL;
}

/**
 * Resolve the environment label plus WHERE it came from.
 *
 * `resolved: false` marks the fail-closed answer — a managed platform that named no
 * environment. Callers that report state (health, logs) should surface that, because
 * "production because we could not tell" is a different fact from "production".
 */
function resolvePlatformEnv(env) {
  const e = readEnv(env);
  for (const key of ENV_NAME_SOURCES) {
    const raw = trimmed(e[key]);
    if (!raw) continue;
    const normalized = normalizeEnvName(raw);
    if (normalized) return { env: normalized, source: key, raw, resolved: true };
    // A non-empty but unrecognized value (e.g. RAILWAY_ENVIRONMENT="pr-42") must not be
    // silently dropped: keep scanning, and if nothing else resolves, fail closed below.
  }

  if (isManagedPlatform(e)) {
    warnOnce(
      'unresolved environment on a managed platform; failing closed to production. '
        + 'Set PIVOTA_ENV explicitly (Cloud Run injects no environment name).',
      {
        platform: platformName(e),
        k_service: trimmed(e.K_SERVICE) || null,
        railway_environment: trimmed(e.RAILWAY_ENVIRONMENT) || null,
      },
    );
    return { env: PLATFORM_ENVS.PRODUCTION, source: 'fail_closed', raw: '', resolved: false };
  }

  return { env: PLATFORM_ENVS.DEVELOPMENT, source: 'default', raw: '', resolved: true };
}

/** The environment label: "production" | "staging" | "development" | "test". */
function platformEnv(env) {
  return resolvePlatformEnv(env).env;
}

/** Where `platformEnv()` got its answer — an env var name, "fail_closed", or "default". */
function platformEnvSource(env) {
  return resolvePlatformEnv(env).source;
}

/**
 * THE production guard. True if the resolved label is production OR any environment
 * signal names production. See the module header for why this is a union and not a
 * precedence lookup — collapsing it would turn several guards OFF on staging.
 */
function isProduction(env) {
  const e = readEnv(env);
  if (resolvePlatformEnv(e).env === PLATFORM_ENVS.PRODUCTION) return true;
  return PRODUCTION_SIGNAL_SOURCES.some((key) => isProductionToken(e[key]));
}

/** True only when this is staging and nothing claims production. */
function isStaging(env) {
  const e = readEnv(env);
  if (isProduction(e)) return false;
  return resolvePlatformEnv(e).env === PLATFORM_ENVS.STAGING;
}

/** True when this process is a test runner (jest/node:test), independent of platform. */
function isTestRuntime(env) {
  const e = readEnv(env);
  if (token(e.NODE_ENV) === 'test') return true;
  return trimmed(e.NODE_TEST_CONTEXT) !== '';
}

/**
 * Service name. Explicit override, then Railway, then the repo's own `SERVICE_NAME`,
 * then Cloud Run's `K_SERVICE`. Returns null when nothing names it — the caller owns
 * the default string, so no default is invented here.
 */
function serviceName(env) {
  const e = readEnv(env);
  return firstNonEmpty(e, [
    'PIVOTA_SERVICE_NAME',
    'RAILWAY_SERVICE_NAME',
    'SERVICE_NAME',
    'K_SERVICE',
  ]).value || null;
}

/**
 * Deployed commit sha, or null.
 *
 * THE BAKED SHA OUTRANKS EVERY ENV VAR, deliberately. Every name below is set by whoever
 * deploys, so a deploy that forgets one reports the PREVIOUS commit while running the new
 * code — see `bakedCommitSha` for the revision this actually happened to. The stamped file
 * ships inside the image and cannot disagree with the code beside it.
 *
 * Cloud Run injects NO commit sha, so `COMMIT_SHA` / `SOURCE_VERSION` (the names Cloud
 * Build and buildpacks conventionally set, and what our deploy step should inject) are
 * part of the chain. Order preserves the pre-existing `src/server.js` chain exactly;
 * the new names are appended around it, never in front of `RAILWAY_GIT_COMMIT_SHA`.
 */
function commitSha(env) {
  const e = readEnv(env);
  const declared = firstNonEmpty(e, [
    'PIVOTA_COMMIT_SHA',
    'RAILWAY_GIT_COMMIT_SHA',
    'COMMIT_SHA',
    'GIT_COMMIT_SHA',
    'SOURCE_VERSION',
  ]).value || null;
  const baked = bakedCommitSha();
  // Loose check on purpose: `bakedCommitSha` normalises an empty stamp to null, and this
  // treats '' the same way, so the two cannot drift into disagreeing about what "no stamp"
  // is. Tightening this to `baked === null` would make the normalisation load-bearing and
  // silently reintroduce an empty-file image reporting '' as its commit.
  if (!baked) return declared;
  // A disagreement is not cosmetic: it means something deployed this image without setting
  // the stamp, so the env var is a leftover from the PREVIOUS revision. Reporting the baked
  // value keeps /health honest; saying so out loud is what makes the broken deploy path
  // findable, because a correct-looking /health is exactly why the last one went unnoticed
  // for eleven weeks. Use `infra/gcp/deploy_gateway.sh`, which always sets both from one
  // variable, rather than a hand `gcloud run deploy`.
  if (declared && declared !== baked) {
    warnOnce('deployed commit sha disagrees with the sha baked into this image - reporting the baked one', {
      baked,
      declared,
    });
  }
  return baked;
}

/** First 12 chars of `commitSha()`, or null. The repo's existing short-sha width. */
function commitShaShort(env) {
  const sha = commitSha(env);
  return sha ? sha.slice(0, 12) : null;
}

/**
 * Deployment identity, or null. On Cloud Run the revision name (`K_REVISION`) is the
 * closest equivalent of a Railway deployment id: it changes on every deploy.
 */
function deploymentId(env) {
  const e = readEnv(env);
  return firstNonEmpty(e, [
    'PIVOTA_DEPLOYMENT_ID',
    'RAILWAY_DEPLOYMENT_ID',
    'DEPLOYMENT_ID',
    'K_REVISION',
  ]).value || null;
}

/** Deployed git branch, or null. Cloud Run injects none; set `PIVOTA_GIT_BRANCH` at deploy. */
function gitBranch(env) {
  const e = readEnv(env);
  return firstNonEmpty(e, ['PIVOTA_GIT_BRANCH', 'RAILWAY_GIT_BRANCH', 'GIT_BRANCH']).value || null;
}

/** Cloud Run revision name, or null. Exposed for health payloads; null off Cloud Run. */
function revisionName(env) {
  const e = readEnv(env);
  return firstNonEmpty(e, ['K_REVISION']).value || null;
}

/** One flat object for logs, `/health` and debug bundles. Safe to serialize. */
function platformMetadata(env) {
  const e = readEnv(env);
  const resolution = resolvePlatformEnv(e);
  return {
    platform: platformName(e),
    env: resolution.env,
    env_source: resolution.source,
    env_resolved: resolution.resolved,
    managed: isManagedPlatform(e),
    production: isProduction(e),
    service: serviceName(e),
    commit_sha: commitSha(e),
    commit_sha_short: commitShaShort(e),
    deployment_id: deploymentId(e),
    revision: revisionName(e),
    git_branch: gitBranch(e),
  };
}

/**
 * Startup assertion. Throws when a managed platform gave us no resolvable environment.
 *
 * Call this from the server's start path (NOT module scope — hundreds of tests require
 * `src/server.js`). On Railway today `RAILWAY_ENVIRONMENT` resolves and this is a no-op;
 * on a Cloud Run revision deployed without `PIVOTA_ENV` this kills the boot, which is the
 * point: an unnamed environment means every production guard is running on a fail-closed
 * guess, and that state should never take traffic silently.
 */
function requirePlatformEnv(env) {
  const e = readEnv(env);
  const resolution = resolvePlatformEnv(e);
  if (resolution.resolved) return platformMetadata(e);
  throw new Error(
    'PLATFORM_ENV_UNRESOLVED: running on a managed platform '
      + `(${platformName(e)}) with no resolvable environment name. `
      + 'Set PIVOTA_ENV=production|staging|development (Cloud Run injects no environment name). '
      + `Checked, in order: ${ENV_NAME_SOURCES.join(', ')}.`,
  );
}

module.exports = {
  PLATFORM_ENVS,
  PLATFORM_NAMES,
  ENV_NAME_SOURCES,
  MANAGED_PLATFORM_MARKERS,
  platformEnv,
  platformEnvSource,
  resolvePlatformEnv,
  isProduction,
  isStaging,
  isTestRuntime,
  isManagedPlatform,
  platformName,
  serviceName,
  commitSha,
  commitShaShort,
  deploymentId,
  gitBranch,
  revisionName,
  platformMetadata,
  requirePlatformEnv,
  normalizeEnvName,
  resetPlatformWarnings,
  setBakedCommitShaFileForTests,
};
