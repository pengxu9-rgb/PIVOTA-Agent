/**
 * Type surface for `src/config/platform.js`.
 *
 * The implementation is CommonJS because src/ is CommonJS (396 files use `require`, and
 * package.json declares no `"type": "module"`). This declaration exists so the handful of
 * `.ts` twins in src/ — notably `src/lib/geminiModelFloor.ts` — can import the same single
 * module instead of growing a second copy of the precedence rules that would drift.
 */

export type PlatformEnv = 'production' | 'staging' | 'development' | 'test';
export type PlatformName = 'railway' | 'cloud_run' | 'local';

export interface PlatformEnvResolution {
  env: PlatformEnv;
  /** An env var name, or 'fail_closed', or 'default'. */
  source: string;
  raw: string;
  /** false marks the fail-closed answer: managed platform, no environment named. */
  resolved: boolean;
}

export interface PlatformMetadata {
  platform: PlatformName;
  env: PlatformEnv;
  env_source: string;
  env_resolved: boolean;
  managed: boolean;
  production: boolean;
  service: string | null;
  commit_sha: string | null;
  commit_sha_short: string | null;
  deployment_id: string | null;
  revision: string | null;
  git_branch: string | null;
}

export type EnvLike = Record<string, string | undefined>;

export declare const PLATFORM_ENVS: Readonly<{
  PRODUCTION: 'production';
  STAGING: 'staging';
  DEVELOPMENT: 'development';
  TEST: 'test';
}>;
export declare const PLATFORM_NAMES: Readonly<{
  RAILWAY: 'railway';
  CLOUD_RUN: 'cloud_run';
  LOCAL: 'local';
}>;
export declare const ENV_NAME_SOURCES: readonly string[];
export declare const MANAGED_PLATFORM_MARKERS: readonly string[];

export declare function platformEnv(env?: EnvLike): PlatformEnv;
export declare function platformEnvSource(env?: EnvLike): string;
export declare function resolvePlatformEnv(env?: EnvLike): PlatformEnvResolution;
export declare function isProduction(env?: EnvLike): boolean;
export declare function isStaging(env?: EnvLike): boolean;
export declare function isTestRuntime(env?: EnvLike): boolean;
export declare function isManagedPlatform(env?: EnvLike): boolean;
export declare function platformName(env?: EnvLike): PlatformName;
export declare function serviceName(env?: EnvLike): string | null;
export declare function commitSha(env?: EnvLike): string | null;
/** Test-only: point the baked-commit-sha reader at another file; no argument restores the real one. */
export declare function setBakedCommitShaFileForTests(filePath?: string): void;
export declare function commitShaShort(env?: EnvLike): string | null;
export declare function deploymentId(env?: EnvLike): string | null;
export declare function gitBranch(env?: EnvLike): string | null;
export declare function revisionName(env?: EnvLike): string | null;
export declare function platformMetadata(env?: EnvLike): PlatformMetadata;
export declare function requirePlatformEnv(env?: EnvLike): PlatformMetadata;
export declare function normalizeEnvName(value: unknown): PlatformEnv | null;
export declare function resetPlatformWarnings(): void;
