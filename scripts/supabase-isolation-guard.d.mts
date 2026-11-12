// Type declarations for the fail-closed Supabase isolation guard so its pure helpers can be unit tested
// from TypeScript. The runtime implementation lives in supabase-isolation-guard.mjs.

export declare const SHARED_PROJECT_ID: string;
export declare const SHARED_DB_CONTAINER: string;
export declare const ISOLATED_PROJECT_PATTERN: RegExp;

export declare function liveSharedContainers(dockerExec?: (args: string[]) => string): string[];

export declare function failClosedLegacyRunner(
  runner: string,
  options?: { replacement?: string },
): never;

export declare function assertIsolatedSupabaseArgs(
  args: string[],
  context: { repoRoot: string },
): void;

export declare function assertNotSharedProject(projectId: string): void;

export declare function assertLoopbackDbHost(host: string, label?: string): void;

export declare function sanitizedChildEnv(
  overrides?: Record<string, string | undefined>,
  base?: Record<string, string | undefined>,
): Record<string, string>;
