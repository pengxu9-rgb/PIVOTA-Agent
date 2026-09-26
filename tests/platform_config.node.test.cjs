'use strict';

/**
 * Precedence, fail-closed and metadata contract for `src/config/platform.js`.
 *
 * Every assertion here drives the module through an EXPLICIT env object (or through a
 * mutated `process.env` for the no-import-time-caching cases) rather than inheriting the
 * runner's environment, so the same expectations hold on a laptop, in the jest shard and
 * on a CI runner that happens to export NODE_ENV.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const platform = require('../src/config/platform');

const {
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
} = platform;

/** A bare environment: no platform markers, no environment names. */
const LOCAL = Object.freeze({});

/** Railway production, as prod actually looks: RAILWAY_ENVIRONMENT set, NODE_ENV absent. */
const RAILWAY_PROD = Object.freeze({
  RAILWAY_ENVIRONMENT: 'production',
  RAILWAY_SERVICE_NAME: 'PIVOTA-Agent',
  RAILWAY_DEPLOYMENT_ID: 'dep_abc',
  RAILWAY_GIT_COMMIT_SHA: '0123456789abcdef0123',
  RAILWAY_GIT_BRANCH: 'main',
});

/** Cloud Run production, named the only way Cloud Run can name it. */
const CLOUD_RUN_PROD = Object.freeze({
  K_SERVICE: 'pivota-agent-gateway',
  K_REVISION: 'pivota-agent-gateway-00042-abc',
  K_CONFIGURATION: 'pivota-agent-gateway',
  PIVOTA_ENV: 'production',
  COMMIT_SHA: 'fedcba9876543210fedc',
  PIVOTA_GIT_BRANCH: 'main',
});

/** Cloud Run with NOTHING naming the environment — the misconfigured deploy. */
const CLOUD_RUN_UNNAMED = Object.freeze({
  K_SERVICE: 'pivota-agent-gateway',
  K_REVISION: 'pivota-agent-gateway-00042-abc',
});

function withProcessEnv(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Clear every var the module reads, so a case starts from a known-empty environment. */
const ALL_READ_KEYS = [
  'PIVOTA_ENV', 'PIVOTA_PLATFORM', 'PIVOTA_SERVICE_NAME', 'PIVOTA_COMMIT_SHA',
  'PIVOTA_DEPLOYMENT_ID', 'PIVOTA_GIT_BRANCH',
  'RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_SERVICE_NAME',
  'RAILWAY_DEPLOYMENT_ID', 'RAILWAY_PROJECT_ID', 'RAILWAY_GIT_COMMIT_SHA', 'RAILWAY_GIT_BRANCH',
  'K_SERVICE', 'K_REVISION', 'K_CONFIGURATION',
  'NODE_ENV', 'APP_ENV', 'VERCEL_ENV', 'NODE_TEST_CONTEXT',
  'SERVICE_NAME', 'COMMIT_SHA', 'GIT_COMMIT_SHA', 'SOURCE_VERSION', 'DEPLOYMENT_ID', 'GIT_BRANCH',
];

function withCleanProcessEnv(overrides, fn) {
  const cleared = Object.fromEntries(ALL_READ_KEYS.map((key) => [key, undefined]));
  return withProcessEnv({ ...cleared, ...overrides }, fn);
}

test('normalizeEnvName maps the labels this repo actually uses, and only those', () => {
  assert.equal(normalizeEnvName('production'), 'production');
  assert.equal(normalizeEnvName('  PROD '), 'production');
  assert.equal(normalizeEnvName('staging'), 'staging');
  assert.equal(normalizeEnvName('preview'), 'staging');
  assert.equal(normalizeEnvName('test'), 'test');
  assert.equal(normalizeEnvName('dev'), 'development');
  // Unrecognized is null, NOT development: an unknown label must not be able to buy the
  // permissive answer on a managed platform.
  assert.equal(normalizeEnvName('pr-42'), null);
  assert.equal(normalizeEnvName(''), null);
  assert.equal(normalizeEnvName(undefined), null);
});

test('nothing set resolves to development and never throws', () => {
  assert.equal(platformEnv(LOCAL), 'development');
  assert.equal(platformEnvSource(LOCAL), 'default');
  assert.equal(platformName(LOCAL), 'local');
  assert.equal(isManagedPlatform(LOCAL), false);
  assert.equal(isProduction(LOCAL), false);
  assert.equal(isStaging(LOCAL), false);
  assert.deepEqual(requirePlatformEnv(LOCAL).env, 'development');
});

test('PIVOTA_ENV outranks every platform variable', () => {
  const env = { ...RAILWAY_PROD, PIVOTA_ENV: 'staging' };
  assert.equal(platformEnv(env), 'staging');
  assert.equal(platformEnvSource(env), 'PIVOTA_ENV');
  // isProduction is the UNION, so RAILWAY_ENVIRONMENT=production still wins the guard.
  // This is deliberate: an override must not be able to unlock production-guarded paths.
  assert.equal(isProduction(env), true);
  assert.equal(isStaging(env), false);
});

test('Railway production resolves without NODE_ENV (prod sets no NODE_ENV)', () => {
  assert.equal(platformEnv(RAILWAY_PROD), 'production');
  assert.equal(platformEnvSource(RAILWAY_PROD), 'RAILWAY_ENVIRONMENT');
  assert.equal(platformName(RAILWAY_PROD), 'railway');
  assert.equal(isProduction(RAILWAY_PROD), true);
  assert.equal(isStaging(RAILWAY_PROD), false);
  assert.equal(resolvePlatformEnv(RAILWAY_PROD).resolved, true);
});

test('RAILWAY_ENVIRONMENT_NAME is accepted when RAILWAY_ENVIRONMENT is absent', () => {
  const env = { RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_SERVICE_NAME: 'x' };
  assert.equal(platformEnv(env), 'production');
  assert.equal(platformEnvSource(env), 'RAILWAY_ENVIRONMENT_NAME');
  assert.equal(isProduction(env), true);
});

test('Railway staging is staging, and is not production', () => {
  const env = { RAILWAY_ENVIRONMENT: 'staging', RAILWAY_SERVICE_NAME: 'PIVOTA-Agent' };
  assert.equal(platformEnv(env), 'staging');
  assert.equal(isProduction(env), false);
  assert.equal(isStaging(env), true);
  assert.equal(platformName(env), 'railway');
});

test('Cloud Run + PIVOTA_ENV=production resolves with no RAILWAY_* present', () => {
  assert.equal(platformEnv(CLOUD_RUN_PROD), 'production');
  assert.equal(platformEnvSource(CLOUD_RUN_PROD), 'PIVOTA_ENV');
  assert.equal(platformName(CLOUD_RUN_PROD), 'cloud_run');
  assert.equal(isManagedPlatform(CLOUD_RUN_PROD), true);
  assert.equal(isProduction(CLOUD_RUN_PROD), true);
  assert.equal(resolvePlatformEnv(CLOUD_RUN_PROD).resolved, true);
  // No RAILWAY_* anywhere in this fixture — the whole point of the migration.
  assert.equal(Object.keys(CLOUD_RUN_PROD).some((k) => k.startsWith('RAILWAY_')), false);
});

test('FAIL CLOSED: Cloud Run with no environment name answers production', () => {
  resetPlatformWarnings();
  const resolution = resolvePlatformEnv(CLOUD_RUN_UNNAMED);
  assert.equal(resolution.env, 'production');
  assert.equal(resolution.source, 'fail_closed');
  assert.equal(resolution.resolved, false);
  assert.equal(platformEnv(CLOUD_RUN_UNNAMED), 'production');
  assert.equal(isProduction(CLOUD_RUN_UNNAMED), true);
  assert.equal(isStaging(CLOUD_RUN_UNNAMED), false);
});

test('FAIL CLOSED: an unrecognized environment label on a managed platform is not development', () => {
  resetPlatformWarnings();
  const env = { K_SERVICE: 'gw', RAILWAY_ENVIRONMENT: 'pr-42' };
  const resolution = resolvePlatformEnv(env);
  assert.equal(resolution.env, 'production');
  assert.equal(resolution.resolved, false);
  assert.equal(isProduction(env), true);
});

test('FAIL CLOSED: a Railway box that lost RAILWAY_ENVIRONMENT still answers production', () => {
  resetPlatformWarnings();
  const env = { RAILWAY_SERVICE_NAME: 'PIVOTA-Agent', RAILWAY_DEPLOYMENT_ID: 'dep_x' };
  assert.equal(platformEnv(env), 'production');
  assert.equal(platformEnvSource(env), 'fail_closed');
  assert.equal(platformName(env), 'railway');
  assert.equal(isProduction(env), true);
});

test('requirePlatformEnv throws on an unresolvable managed platform and not otherwise', () => {
  resetPlatformWarnings();
  assert.throws(
    () => requirePlatformEnv(CLOUD_RUN_UNNAMED),
    /PLATFORM_ENV_UNRESOLVED/,
  );
  assert.throws(() => requirePlatformEnv(CLOUD_RUN_UNNAMED), /PIVOTA_ENV/);
  // Resolvable managed platforms and plain local runs return metadata instead.
  assert.equal(requirePlatformEnv(CLOUD_RUN_PROD).env, 'production');
  assert.equal(requirePlatformEnv(RAILWAY_PROD).env, 'production');
  assert.equal(requirePlatformEnv(LOCAL).env, 'development');
});

test('NODE_ENV ranks BELOW the platform vars but still names an environment on its own', () => {
  // Production leaves NODE_ENV unset, so Railway/Cloud Run must win when both exist.
  const conflict = { RAILWAY_ENVIRONMENT: 'staging', NODE_ENV: 'production' };
  assert.equal(platformEnv(conflict), 'staging');
  assert.equal(platformEnvSource(conflict), 'RAILWAY_ENVIRONMENT');
  // ...but the GUARD must still fire, exactly as the pre-shim call sites did
  // (`NODE_ENV === 'production' || RAILWAY_ENVIRONMENT === 'production' || ...`).
  assert.equal(isProduction(conflict), true);
  assert.equal(isStaging(conflict), false);

  assert.equal(platformEnv({ NODE_ENV: 'test' }), 'test');
  assert.equal(platformEnv({ NODE_ENV: 'production' }), 'production');
});

test('the production guard is the union of every signal, not the precedence winner', () => {
  for (const key of ['PIVOTA_ENV', 'RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_NAME', 'NODE_ENV', 'APP_ENV', 'VERCEL_ENV']) {
    assert.equal(isProduction({ [key]: 'production' }), true, `${key}=production must make isProduction() true`);
    assert.equal(isProduction({ [key]: 'prod' }), true, `${key}=prod must make isProduction() true`);
  }
  // And none of the non-production labels may.
  for (const value of ['staging', 'development', 'test', '', 'pr-42']) {
    assert.equal(isProduction({ NODE_ENV: value }), false, `NODE_ENV=${value} must not read as production`);
  }
});

test('isTestRuntime tracks the runner, not the platform', () => {
  assert.equal(isTestRuntime({ NODE_ENV: 'test' }), true);
  assert.equal(isTestRuntime({ NODE_TEST_CONTEXT: 'child-v8' }), true);
  assert.equal(isTestRuntime(RAILWAY_PROD), false);
  assert.equal(isTestRuntime(LOCAL), false);
});

test('platformName honours the PIVOTA_PLATFORM override in both directions', () => {
  assert.equal(platformName({ ...RAILWAY_PROD, PIVOTA_PLATFORM: 'cloud_run' }), 'cloud_run');
  assert.equal(platformName({ ...CLOUD_RUN_PROD, PIVOTA_PLATFORM: 'railway' }), 'railway');
  assert.equal(platformName({ ...RAILWAY_PROD, PIVOTA_PLATFORM: 'local' }), 'local');
});

test('metadata accessors read Railway values and fall back to Cloud Run ones', () => {
  assert.equal(serviceName(RAILWAY_PROD), 'PIVOTA-Agent');
  assert.equal(commitSha(RAILWAY_PROD), '0123456789abcdef0123');
  assert.equal(commitShaShort(RAILWAY_PROD), '0123456789ab');
  assert.equal(deploymentId(RAILWAY_PROD), 'dep_abc');
  assert.equal(gitBranch(RAILWAY_PROD), 'main');
  assert.equal(revisionName(RAILWAY_PROD), null);

  assert.equal(serviceName(CLOUD_RUN_PROD), 'pivota-agent-gateway');
  assert.equal(commitSha(CLOUD_RUN_PROD), 'fedcba9876543210fedc');
  assert.equal(deploymentId(CLOUD_RUN_PROD), 'pivota-agent-gateway-00042-abc');
  assert.equal(revisionName(CLOUD_RUN_PROD), 'pivota-agent-gateway-00042-abc');
  assert.equal(gitBranch(CLOUD_RUN_PROD), 'main');

  // Nothing named: null, never an invented value.
  assert.equal(serviceName(LOCAL), null);
  assert.equal(commitSha(LOCAL), null);
  assert.equal(commitShaShort(LOCAL), null);
  assert.equal(deploymentId(LOCAL), null);
  assert.equal(gitBranch(LOCAL), null);
});

test('accessor precedence keeps the pre-shim chains intact', () => {
  // RAILWAY_* must still beat the generic names the old chains had AFTER it.
  assert.equal(commitSha({ RAILWAY_GIT_COMMIT_SHA: 'rw', GIT_COMMIT_SHA: 'git', SOURCE_VERSION: 'src' }), 'rw');
  assert.equal(commitSha({ GIT_COMMIT_SHA: 'git', SOURCE_VERSION: 'src' }), 'git');
  assert.equal(commitSha({ SOURCE_VERSION: 'src' }), 'src');
  assert.equal(serviceName({ RAILWAY_SERVICE_NAME: 'rw', SERVICE_NAME: 'plain', K_SERVICE: 'kr' }), 'rw');
  assert.equal(serviceName({ SERVICE_NAME: 'plain', K_SERVICE: 'kr' }), 'plain');
  assert.equal(deploymentId({ RAILWAY_DEPLOYMENT_ID: 'rw', DEPLOYMENT_ID: 'plain', K_REVISION: 'rev' }), 'rw');
  assert.equal(deploymentId({ DEPLOYMENT_ID: 'plain', K_REVISION: 'rev' }), 'plain');
  assert.equal(gitBranch({ RAILWAY_GIT_BRANCH: 'rw', GIT_BRANCH: 'plain' }), 'rw');
  // ...and the explicit PIVOTA_* override beats everything.
  assert.equal(commitSha({ PIVOTA_COMMIT_SHA: 'p', RAILWAY_GIT_COMMIT_SHA: 'rw' }), 'p');
  assert.equal(serviceName({ PIVOTA_SERVICE_NAME: 'p', RAILWAY_SERVICE_NAME: 'rw' }), 'p');
  assert.equal(deploymentId({ PIVOTA_DEPLOYMENT_ID: 'p', RAILWAY_DEPLOYMENT_ID: 'rw' }), 'p');
  assert.equal(gitBranch({ PIVOTA_GIT_BRANCH: 'p', RAILWAY_GIT_BRANCH: 'rw' }), 'p');
});

test('blank strings are treated as absent, not as a value', () => {
  const env = { RAILWAY_ENVIRONMENT: '   ', PIVOTA_ENV: '', NODE_ENV: 'production' };
  assert.equal(platformEnv(env), 'production');
  assert.equal(platformEnvSource(env), 'NODE_ENV');
  assert.equal(serviceName({ RAILWAY_SERVICE_NAME: '  ', SERVICE_NAME: 'plain' }), 'plain');
});

test('platformMetadata reports the whole resolution, including a fail-closed answer', () => {
  const meta = platformMetadata(CLOUD_RUN_PROD);
  assert.deepEqual(meta, {
    platform: 'cloud_run',
    env: 'production',
    env_source: 'PIVOTA_ENV',
    env_resolved: true,
    managed: true,
    production: true,
    service: 'pivota-agent-gateway',
    commit_sha: 'fedcba9876543210fedc',
    commit_sha_short: 'fedcba987654',
    deployment_id: 'pivota-agent-gateway-00042-abc',
    revision: 'pivota-agent-gateway-00042-abc',
    git_branch: 'main',
  });

  resetPlatformWarnings();
  const failed = platformMetadata(CLOUD_RUN_UNNAMED);
  assert.equal(failed.env, 'production');
  assert.equal(failed.env_source, 'fail_closed');
  // The distinction a health check needs: "production" vs "production because we could
  // not tell". Collapsing these two would hide a misconfigured revision.
  assert.equal(failed.env_resolved, false);
  assert.equal(failed.managed, true);

  const local = platformMetadata(LOCAL);
  assert.equal(local.platform, 'local');
  assert.equal(local.env, 'development');
  assert.equal(local.managed, false);
  assert.equal(local.production, false);
});

test('env is read at CALL time — no import-time caching', () => {
  withCleanProcessEnv({}, () => {
    assert.equal(platformEnv(), 'development');
    assert.equal(isProduction(), false);

    process.env.RAILWAY_ENVIRONMENT = 'production';
    // Same module instance, no re-require, no jest.resetModules().
    assert.equal(platformEnv(), 'production');
    assert.equal(isProduction(), true);
    assert.equal(platformName(), 'railway');

    delete process.env.RAILWAY_ENVIRONMENT;
    process.env.K_SERVICE = 'gw';
    process.env.PIVOTA_ENV = 'staging';
    assert.equal(platformEnv(), 'staging');
    assert.equal(isStaging(), true);
    assert.equal(isProduction(), false);
    assert.equal(platformName(), 'cloud_run');

    delete process.env.PIVOTA_ENV;
    resetPlatformWarnings();
    assert.equal(platformEnv(), 'production', 'K_SERVICE alone must fail closed');
  });
});


// ---------------------------------------------------------------------------------------
// THE COMMIT BAKED INTO THE IMAGE
//
// `gcloud run deploy --image X` with no env flag INHERITS the previous revision's whole
// environment. On 2026-08-25 that put the `17e7cfa8` image in front of traffic while
// PIVOTA_COMMIT_SHA still said `6aa49526db95`: /health under-reported the deployed commit by
// 7, and gateway-prod-drift.yml — whose only job is comparing that value to main — computed
// "30 commits behind" against a true 23. The alarm validates the reported sha is HEX; it
// cannot see a stamp that is merely WRONG.
//
// The Dockerfile now writes the sha into /app/.image_commit_sha from a build arg, and it
// outranks every env var, so the reported commit is a property of the code rather than a
// claim about it. These drive the reader against a real file — the path is a module constant
// precisely so it cannot be redirected by configuration, so a test hook is the only way in.
// ---------------------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BAKED = 'aaaaaaaabbbbbbbbccccccccdddddddd11112222';
const DECLARED = '6aa49526db95c1d2e3f4a5b6c7d8e9f0a1b2c3d4';

/** Write a stamp file, point the module at it, and undo both afterwards. */
function withBakedSha(contents, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baked-sha-'));
  const file = path.join(dir, '.image_commit_sha');
  if (contents !== null) fs.writeFileSync(file, contents);
  setBakedCommitShaFileForTests(file);
  resetPlatformWarnings();
  try {
    body();
  } finally {
    setBakedCommitShaFileForTests();
    resetPlatformWarnings();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the baked sha outranks every env var, including PIVOTA_COMMIT_SHA', () => {
  withBakedSha(BAKED, () => {
    // THE REGRESSION. `declared` is the stale value a hand deploy left behind; `BAKED` is what
    // the image was actually built from. Reporting `declared` is the whole defect.
    assert.equal(commitSha({ PIVOTA_COMMIT_SHA: DECLARED }), BAKED);
    assert.equal(commitSha({ RAILWAY_GIT_COMMIT_SHA: DECLARED }), BAKED);
    assert.equal(commitSha({ COMMIT_SHA: DECLARED, SOURCE_VERSION: DECLARED }), BAKED);
    assert.equal(commitShaShort({ PIVOTA_COMMIT_SHA: DECLARED }), BAKED.slice(0, 12));
  });
});

test('a disagreement between the image and the env var is logged loudly', () => {
  const seen = [];
  const realError = console.error;
  console.error = (...args) => { seen.push(args.join(' ')); };
  try {
    withBakedSha(BAKED, () => {
      commitSha({ PIVOTA_COMMIT_SHA: DECLARED });
    });
  } finally {
    console.error = realError;
  }
  assert.equal(seen.length, 1, `expected one warning, got ${JSON.stringify(seen)}`);
  // Both shas must be IN the message. A warning that says "they disagree" without naming the
  // two values leaves the operator exactly where the silent version did.
  assert.match(seen[0], /disagrees/);
  assert.match(seen[0], new RegExp(BAKED));
  assert.match(seen[0], new RegExp(DECLARED));
});

test('agreement between the image and the env var is silent', () => {
  const seen = [];
  const realError = console.error;
  console.error = (...args) => { seen.push(args.join(' ')); };
  try {
    withBakedSha(BAKED, () => {
      assert.equal(commitSha({ PIVOTA_COMMIT_SHA: BAKED }), BAKED);
      // No env var at all is the normal state under CONFIG=preserve's sibling paths, and is
      // not a disagreement either.
      assert.equal(commitSha({}), BAKED);
    });
  } finally {
    console.error = realError;
  }
  assert.deepEqual(seen, []);
});

test('an image built without the build arg falls back to the env chain', () => {
  // The Dockerfile defaults COMMIT_SHA to "", so a local `docker build` bakes an EMPTY file.
  // Treating that as a value would report '' — or worse, null — for every local image and
  // shadow a perfectly good env var. Whitespace is the same case: the arg is interpolated.
  for (const empty of ['', '   ', '\n']) {
    withBakedSha(empty, () => {
      assert.equal(commitSha({ PIVOTA_COMMIT_SHA: DECLARED }), DECLARED);
      assert.equal(commitSha({}), null);
    });
  }
});

test('no stamp file at all falls back to the env chain', () => {
  // Local dev, tests, and every image built before this change.
  withBakedSha(null, () => {
    assert.equal(commitSha({ PIVOTA_COMMIT_SHA: DECLARED }), DECLARED);
    assert.equal(commitSha(LOCAL), null);
    assert.equal(commitShaShort(LOCAL), null);
  });
});

test('the stamp is trimmed, so a trailing newline is not part of the sha', () => {
  // `printf '%s'` writes no newline, but a hand-edited or differently-built file might. A sha
  // with a trailing \n string-compares unequal to the same sha everywhere downstream, and
  // gateway-prod-drift.yml resolves it with `git rev-parse` — which would fail on the whole
  // value and report "cannot verify what the gateway runs".
  withBakedSha(`${BAKED}\n`, () => {
    assert.equal(commitSha({}), BAKED);
  });
});

// THE CONTRACT BETWEEN TWO FILES THAT NEVER IMPORT EACH OTHER.
//
// The Dockerfile writes the stamp; src/config/platform.js reads it. Nothing links them but a
// path string, and every assertion above runs against a file the TEST wrote — so all of them
// would stay green with the Dockerfile writing somewhere else, or not writing at all. These
// two run the Dockerfile's own RUN line and read the result back through the real module.

/** The `printf ... > <path>` command and its target, parsed out of the Dockerfile. */
function dockerfileStampStep() {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^ARG COMMIT_SHA=/m, 'the Dockerfile declares no COMMIT_SHA build arg');
  const line = dockerfile.match(/^RUN (printf .*?) *$/m);
  assert.ok(line, 'the Dockerfile has no `RUN printf ...` stamping step');
  const target = line[1].match(/> *(\S+)/);
  assert.ok(target, `no redirect target in: ${line[1]}`);
  return { command: line[1], target: target[1] };
}

test('the Dockerfile writes the stamp to exactly the path this module reads', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'platform.js'), 'utf8');
  const constant = source.match(/const IMAGE_COMMIT_SHA_FILE = '([^']+)';/);
  assert.ok(constant, 'IMAGE_COMMIT_SHA_FILE is no longer a literal this test can read');
  assert.equal(dockerfileStampStep().target, constant[1]);
});

test("the Dockerfile's own RUN line produces a stamp this reader accepts", () => {
  // No docker on the test runner, so run the real command in a temp dir with the redirect
  // pointed there. What this proves is the half a unit test otherwise cannot: that the shell
  // written into the image yields bytes the module turns back into the right sha — no stray
  // newline from `echo`, no quoting that swallows the value.
  const { command, target } = dockerfileStampStep();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baked-sha-docker-'));
  const file = path.join(dir, '.image_commit_sha');
  const asWritten = command.replace(target, JSON.stringify(file));
  try {
    // COMMIT_SHA set: a real Cloud Build, which passes --build-arg COMMIT_SHA=$COMMIT_SHA.
    execFileSync('sh', ['-c', asWritten], { env: { COMMIT_SHA: BAKED } });
    setBakedCommitShaFileForTests(file);
    assert.equal(commitSha({ PIVOTA_COMMIT_SHA: DECLARED }), BAKED);

    // COMMIT_SHA unset: a local `docker build`, where ARG defaults to "". The stamp must come
    // out empty and the env chain must take over, or every local image reports a blank commit.
    execFileSync('sh', ['-c', asWritten], { env: {} });
    setBakedCommitShaFileForTests(file);
    // BLANK, not byte-for-byte empty: `echo` instead of `printf '%s'` leaves a newline the
    // reader trims away, and failing on that would be pinning a spelling rather than the
    // contract. A DEFAULT that is not blank — `${COMMIT_SHA:-unknown}` — is the real hazard,
    // because it stamps every local image with a value that outranks the env chain.
    assert.equal(fs.readFileSync(file, 'utf8').trim(), '', 'an unset build arg must bake a BLANK stamp');
    assert.equal(commitSha({ PIVOTA_COMMIT_SHA: DECLARED }), DECLARED);
  } finally {
    setBakedCommitShaFileForTests();
    resetPlatformWarnings();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
